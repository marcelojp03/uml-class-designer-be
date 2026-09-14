import { Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import {
  Ack,
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { SkipThrottle } from '@nestjs/throttler';
import { isUUID } from 'class-validator';
import type { Server, Socket } from 'socket.io';
import { ConfigService } from '@nestjs/config';
import type { AppConfiguration } from '../../config/app.config';
import { AccessTokenVerifierService } from '../auth/access-token-verifier.service';
import {
  ProjectCollaborationEventBus,
  type ProjectCollaborationChange,
} from '../projects/project-collaboration-event-bus.service';
import {
  CollaborationContractValidator,
  CollaborationPayloadError,
} from './collaboration-contract.validator';
import { CollaborationLockStore } from './collaboration-lock.store';
import { CollaborationPresenceStore } from './collaboration-presence.store';
import { CollaborationRateLimiterService } from './collaboration-rate-limiter.service';
import type {
  CollaborationErrorCode,
  CollaborationFailure,
  CollaborationIdentity,
} from './collaboration.types';
import {
  CollaborationOperationError,
  DocumentCommandService,
  type AuthorizedDocument,
} from './document-command.service';
import {
  DocumentCollaborationEventBus,
  type DocumentCollaborationChange,
} from './document-collaboration-event-bus.service';
import {
  DocumentMutationQueueOverloadedError,
  DocumentMutationQueueService,
} from './document-mutation-queue.service';
import {
  handshakeVerificationTimeoutMs,
  markHandshakeVerificationStarted,
  releaseHandshakeReservation,
} from './configured-socket-io.adapter';

interface CollaborationSocketData {
  identity?: CollaborationIdentity;
  joinedDocumentIds?: Set<string>;
  joinedDocumentProjects?: Map<string, string>;
  pendingJoinDocumentIds?: Set<string>;
  joinTail?: Promise<void>;
  accessTokenExpiryTimer?: NodeJS.Timeout;
  reservedSessionId?: string;
}

type CollaborationSocket = Socket & { data: CollaborationSocketData };
type AckCallback = ((response: unknown) => void) | undefined;
type ResyncDocumentChange = Extract<DocumentCollaborationChange, { type: 'resync-required' }>;

interface PendingMemberEviction {
  key: string;
  userId: string;
  revocation: symbol;
}

interface PendingMemberRevocation {
  key: string;
  documentIds: Set<string>;
}

@SkipThrottle()
@WebSocketGateway()
export class CollaborationGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleInit, OnModuleDestroy
{
  @WebSocketServer()
  private server!: Server;

  private readonly logger = new Logger(CollaborationGateway.name);
  private removePresenceListener?: () => void;
  private removeLockListener?: () => void;
  private removeDocumentChangeListener?: () => void;
  private removeSessionRevocationListener?: () => void;
  private removeProjectAccessListener?: () => void;
  private readonly revokedProjectMemberKeys = new Map<string, symbol>();
  private readonly deletedDocumentIds = new Set<string>();
  private readonly pendingResyncChanges = new Map<string, ResyncDocumentChange>();
  private readonly pendingMemberEvictionsByDocument = new Map<
    string,
    Map<string, PendingMemberEviction>
  >();
  private readonly pendingMemberRevocationDocuments = new Map<symbol, PendingMemberRevocation>();
  private readonly scheduledCriticalDocumentIds = new Set<string>();
  private readonly criticalRetryTimers = new Map<string, NodeJS.Timeout>();
  private readonly pendingDeliveryRecoveryDocumentIds = new Set<string>();
  private readonly connectedSocketIds = new Set<string>();
  private readonly socketIdsBySession = new Map<string, Set<string>>();
  private operationRecoveryTimer?: NodeJS.Timeout;
  private operationRecoveryInFlight = false;

  constructor(
    private readonly configService: ConfigService,
    private readonly accessTokenVerifier: AccessTokenVerifierService,
    private readonly contractValidator: CollaborationContractValidator,
    private readonly documentCommands: DocumentCommandService,
    private readonly presenceStore: CollaborationPresenceStore,
    private readonly lockStore: CollaborationLockStore,
    private readonly rateLimiter: CollaborationRateLimiterService,
    private readonly documentQueue: DocumentMutationQueueService,
    private readonly collaborationEvents: DocumentCollaborationEventBus,
    private readonly projectCollaborationEvents: ProjectCollaborationEventBus,
  ) {}

  afterInit(server: Server): void {
    server.use(async (socket, next) => {
      const client = socket as CollaborationSocket;
      const token = socket.handshake.auth?.token;
      if (typeof token !== 'string') {
        this.rejectHandshake(client, next, 'Authentication is required.');
        return;
      }
      let transportClosed = false;
      client.conn.once('close', () => {
        transportClosed = true;
        this.releaseSocketReservation(client);
      });
      let reservedSessionId: string | undefined;
      try {
        markHandshakeVerificationStarted(client.request);
        const principal = await this.accessTokenVerifier.verify(token, {
          timeoutMs: handshakeVerificationTimeoutMs(
            client.request,
            this.config().handshakeTimeoutMs,
          ),
        });
        if (transportClosed) {
          next(new Error('Authentication is required.'));
          return;
        }
        if (!this.reserveSocket(client.id, principal.sessionId)) {
          this.rejectHandshake(client, next, 'Connection limit reached.');
          return;
        }
        reservedSessionId = principal.sessionId;
        client.data.reservedSessionId = principal.sessionId;
        client.data.identity = {
          userId: principal.id,
          sessionId: principal.sessionId,
          accessTokenExpiresAt: principal.accessTokenExpiresAt,
        };
        client.data.joinedDocumentIds = new Set<string>();
        client.data.joinedDocumentProjects = new Map<string, string>();
        const expirationDelayMs = Math.max(1, principal.accessTokenExpiresAt * 1_000 - Date.now());
        const expiryTimer = setTimeout(() => {
          this.disconnectExpiredToken(client);
        }, expirationDelayMs);
        expiryTimer.unref();
        client.data.accessTokenExpiryTimer = expiryTimer;
        next();
      } catch {
        if (reservedSessionId) {
          this.releaseSocketReservation(socket as CollaborationSocket);
        }
        this.rejectHandshake(client, next, 'Authentication is required.');
      } finally {
        releaseHandshakeReservation(socket.request);
      }
    });
  }

  handleConnection(client: CollaborationSocket): void {
    if (!client.data.identity) {
      client.disconnect(true);
    }
  }

  handleDisconnect(client: CollaborationSocket): void {
    this.releaseSocketReservation(client);
    if (client.data.accessTokenExpiryTimer) {
      clearTimeout(client.data.accessTokenExpiryTimer);
      client.data.accessTokenExpiryTimer = undefined;
    }
    this.presenceStore.leaveBySocket(client.id);
    this.lockStore.releaseBySocket(client.id);
    this.rateLimiter.releaseSocket(client.id);
    client.data.joinedDocumentIds?.clear();
    client.data.joinedDocumentProjects?.clear();
    client.data.pendingJoinDocumentIds?.clear();
    client.data.joinTail = undefined;
  }

  onModuleInit(): void {
    this.removePresenceListener = this.presenceStore.onChanged((change) => {
      this.scheduleAuthorizedBroadcast(change.documentId, 'presence:changed', change);
    });
    this.removeLockListener = this.lockStore.onChanged((change) => {
      this.scheduleAuthorizedBroadcast(change.documentId, 'lock:changed', change);
    });
    this.removeDocumentChangeListener = this.collaborationEvents.onChanged((change) => {
      this.handleExternalDocumentChange(change);
    });
    this.removeSessionRevocationListener = this.accessTokenVerifier.onSessionRevoked(
      (sessionId) => {
        for (const client of this.connectedClients()) {
          if (client.data.identity?.sessionId === sessionId) {
            this.disconnectRevoked(client);
          }
        }
      },
    );
    this.removeProjectAccessListener = this.projectCollaborationEvents.onChanged((change) => {
      this.handleProjectCollaborationChange(change);
    });
    this.startOperationRecovery();
  }

  onModuleDestroy(): void {
    this.removePresenceListener?.();
    this.removeLockListener?.();
    this.removeDocumentChangeListener?.();
    this.removeSessionRevocationListener?.();
    this.removeProjectAccessListener?.();
    if (this.operationRecoveryTimer) {
      clearInterval(this.operationRecoveryTimer);
      this.operationRecoveryTimer = undefined;
    }
    this.revokedProjectMemberKeys.clear();
    this.deletedDocumentIds.clear();
    this.pendingResyncChanges.clear();
    this.pendingMemberEvictionsByDocument.clear();
    this.pendingMemberRevocationDocuments.clear();
    this.scheduledCriticalDocumentIds.clear();
    for (const timer of this.criticalRetryTimers.values()) {
      clearTimeout(timer);
    }
    this.criticalRetryTimers.clear();
    this.pendingDeliveryRecoveryDocumentIds.clear();
    this.connectedSocketIds.clear();
    this.socketIdsBySession.clear();
  }

  @SubscribeMessage('document:join')
  async joinDocument(
    @ConnectedSocket() client: CollaborationSocket,
    @MessageBody() payload: unknown,
    @Ack() ack: AckCallback,
  ): Promise<void> {
    if (!ack) {
      return;
    }
    let pendingDocumentId: string | undefined;
    try {
      await this.assertActiveSession(client);
      if (!this.allowControlEvent(client)) {
        this.reply(ack, this.failure('RATE_LIMITED'));
        return;
      }
      const input = this.contractValidator.validate('documentJoin', payload);
      pendingDocumentId = input.documentId;
      this.pendingJoinDocumentIds(client).add(input.documentId);
      await this.runSocketJoin(client, () =>
        this.documentQueue.run(input.documentId, async () => {
          if (!this.isJoinActive(client, input.documentId)) {
            throw new CollaborationOperationError('NOT_JOINED');
          }
          const document = await this.getAuthorizedDocumentOrThrow(client, input.documentId);
          const joinedDocumentIds = this.joinedDocumentIds(client);
          if (!this.isJoinActive(client, input.documentId)) {
            throw new CollaborationOperationError('NOT_JOINED');
          }
          const config = this.config();
          if (
            !joinedDocumentIds.has(input.documentId) &&
            joinedDocumentIds.size >= config.maxDocumentsPerSocket
          ) {
            throw new CollaborationOperationError('RATE_LIMITED');
          }

          const identity = this.identity(client);
          await client.join(this.documentRoom(input.documentId));
          if (!this.isJoinActive(client, input.documentId)) {
            await client.leave(this.documentRoom(input.documentId));
            throw new CollaborationOperationError('NOT_JOINED');
          }
          const participants = this.presenceStore.join({
            documentId: input.documentId,
            userId: identity.userId,
            socketId: client.id,
            maxParticipants: config.maxParticipantsPerDocument,
          });
          if (!participants) {
            await client.leave(this.documentRoom(input.documentId));
            throw new CollaborationOperationError('RATE_LIMITED');
          }
          if (!this.isJoinActive(client, input.documentId)) {
            this.presenceStore.leave(input.documentId, client.id);
            await client.leave(this.documentRoom(input.documentId));
            throw new CollaborationOperationError('NOT_JOINED');
          }
          joinedDocumentIds.add(input.documentId);
          this.joinedDocumentProjects(client).set(input.documentId, document.projectId);
          this.pendingJoinDocumentIds(client).delete(input.documentId);
          try {
            await this.assertActiveSession(client);
            if (!this.isJoinActive(client, input.documentId)) {
              throw new CollaborationOperationError('NOT_JOINED');
            }
            this.assertCurrentProjectAccess(document.projectId, identity.userId);
          } catch (error: unknown) {
            await this.removeDocumentState(client, input.documentId);
            throw error;
          }
          const resyncRequired =
            input.knownRevision !== undefined && input.knownRevision !== document.revision;
          this.reply(ack, {
            ok: true,
            documentId: input.documentId,
            revision: document.revision,
            ...(input.knownRevision === undefined || resyncRequired
              ? { canonicalModel: document.canonicalModel }
              : {}),
            resyncRequired,
            participants,
            locks: this.lockStore.list(input.documentId),
          });
        }),
      );
    } catch (error: unknown) {
      if (pendingDocumentId) {
        this.pendingJoinDocumentIds(client).delete(pendingDocumentId);
      }
      this.reply(ack, this.toFailure(error));
      this.disconnectForAuthenticationFailure(client, error);
    }
  }

  @SubscribeMessage('document:leave')
  async leaveDocument(
    @ConnectedSocket() client: CollaborationSocket,
    @MessageBody() payload: unknown,
    @Ack() ack: AckCallback,
  ): Promise<void> {
    if (!ack) {
      return;
    }
    try {
      if (!this.allowControlEvent(client)) {
        this.reply(ack, this.failure('RATE_LIMITED'));
        return;
      }
      const input = this.contractValidator.validate('documentLeave', payload);
      if (!(await this.requireActiveSession(client, ack))) {
        return;
      }
      const joined = this.joinedDocumentIds(client).has(input.documentId);
      const pending = this.pendingJoinDocumentIds(client).delete(input.documentId);
      if (!joined && !pending) {
        this.reply(ack, this.failure('NOT_JOINED'));
        return;
      }
      if (joined) {
        await this.removeDocumentState(client, input.documentId);
      }
      this.reply(ack, { ok: true, documentId: input.documentId });
    } catch (error: unknown) {
      this.reply(ack, this.toFailure(error));
    }
  }

  @SubscribeMessage('document:command')
  async executeCommand(
    @ConnectedSocket() client: CollaborationSocket,
    @MessageBody() payload: unknown,
    @Ack() ack: AckCallback,
  ): Promise<void> {
    if (!ack) {
      return;
    }
    try {
      await this.assertActiveSession(client);
      if (
        !this.rateLimiter.allowCommand(
          client.id,
          this.config().commandLimit,
          this.config().commandWindowMs,
        )
      ) {
        this.reply(ack, this.failure('RATE_LIMITED', this.operationIdFromPayload(payload)));
        return;
      }
      const input = this.contractValidator.validate('documentCommand', payload);
      const response = await this.documentQueue.run(input.documentId, async () => {
        await this.getAuthorizedDocumentOrThrow(client, input.documentId);
        if (!this.joinedDocumentIds(client).has(input.documentId)) {
          throw new CollaborationOperationError('NOT_JOINED');
        }

        const identity = this.identity(client);
        const committed = await this.documentCommands.process(identity, input);
        this.presenceStore.touch(input.documentId, client.id);
        if (committed.requiresBroadcast) {
          const currentDocument = await this.documentCommands.getCurrentDocument(input.documentId);
          if (currentDocument) {
            this.lockStore.reconcileDocumentElements(
              input.documentId,
              new Set(currentDocument.canonicalModel.diagram.elements.map((element) => element.id)),
            );
            if (currentDocument.revision === committed.revision) {
              await this.broadcastToAuthorizedRoom(
                input.documentId,
                'document:operation',
                {
                  operationId: committed.operationId,
                  documentId: committed.documentId,
                  actorId: identity.userId,
                  baseRevision: committed.baseRevision,
                  revision: committed.revision,
                  command: committed.command,
                  committedAt: committed.committedAt,
                },
                client.id,
              );
            } else {
              await this.broadcastToAuthorizedRoom(input.documentId, 'document:resync-required', {
                documentId: input.documentId,
                revision: currentDocument.revision,
                resyncRequired: true,
              });
            }
            await this.documentCommands.markBroadcastDelivered(
              input.documentId,
              committed.operationId,
            );
          }
        }
        return {
          ok: true,
          operationId: committed.operationId,
          documentId: committed.documentId,
          revision: committed.revision,
          committedAt: committed.committedAt,
        };
      });
      this.reply(ack, response);
    } catch (error: unknown) {
      const operationId = this.operationIdFromPayload(payload);
      this.reply(ack, this.toFailure(error, operationId));
      this.disconnectForAuthenticationFailure(client, error);
    }
  }

  @SubscribeMessage('presence:update')
  async updatePresence(
    @ConnectedSocket() client: CollaborationSocket,
    @MessageBody() payload: unknown,
    @Ack() ack: AckCallback,
  ): Promise<void> {
    if (!ack) {
      return;
    }
    try {
      await this.assertActiveSession(client);
      if (!this.allowControlEvent(client)) {
        this.reply(ack, this.failure('RATE_LIMITED'));
        return;
      }
      const input = this.contractValidator.validate('presenceUpdate', payload);
      if (!(await this.requireAuthorizedDocument(client, input.documentId, ack))) {
        return;
      }
      if (!this.joinedDocumentIds(client).has(input.documentId)) {
        this.reply(ack, this.failure('NOT_JOINED'));
        return;
      }
      const participants = this.presenceStore.update(
        input.documentId,
        client.id,
        { selection: input.selection, cursor: input.cursor },
        this.config().presenceMinIntervalMs,
      );
      if (participants === 'RATE_LIMITED') {
        this.reply(ack, this.failure('RATE_LIMITED'));
        return;
      }
      if (!participants) {
        this.reply(ack, this.failure('NOT_JOINED'));
        return;
      }
      this.reply(ack, { ok: true, documentId: input.documentId, participants });
    } catch (error: unknown) {
      this.reply(ack, this.toFailure(error));
    }
  }

  @SubscribeMessage('lock:acquire')
  async acquireLock(
    @ConnectedSocket() client: CollaborationSocket,
    @MessageBody() payload: unknown,
    @Ack() ack: AckCallback,
  ): Promise<void> {
    if (!ack) {
      return;
    }
    try {
      await this.assertActiveSession(client);
      if (!this.allowControlEvent(client)) {
        this.reply(ack, this.failure('RATE_LIMITED'));
        return;
      }
      const input = this.contractValidator.validate('lockAcquire', payload);
      const result = await this.documentQueue.run(input.documentId, async () => {
        const document = await this.getAuthorizedDocumentOrThrow(client, input.documentId);
        if (!this.joinedDocumentIds(client).has(input.documentId)) {
          throw new CollaborationOperationError('NOT_JOINED');
        }
        if (!this.hasElement(document, input.elementId)) {
          throw new CollaborationOperationError('INVALID_COMMAND');
        }
        const identity = this.identity(client);
        return this.lockStore.acquire({
          documentId: input.documentId,
          elementId: input.elementId,
          userId: identity.userId,
          socketId: client.id,
          ttlSeconds: this.config().lockTtlSeconds,
        });
      });
      if (!result) {
        this.reply(ack, this.failure('ELEMENT_LOCKED'));
        return;
      }
      this.presenceStore.touch(input.documentId, client.id);
      this.reply(ack, { ok: true, lock: result.lock, locks: result.locks });
    } catch (error: unknown) {
      this.reply(ack, this.toFailure(error));
      this.disconnectForAuthenticationFailure(client, error);
    }
  }

  @SubscribeMessage('lock:renew')
  async renewLock(
    @ConnectedSocket() client: CollaborationSocket,
    @MessageBody() payload: unknown,
    @Ack() ack: AckCallback,
  ): Promise<void> {
    if (!ack) {
      return;
    }
    await this.updateLockLease(client, payload, ack, 'lockRenew', 'renew');
  }

  @SubscribeMessage('lock:release')
  async releaseLock(
    @ConnectedSocket() client: CollaborationSocket,
    @MessageBody() payload: unknown,
    @Ack() ack: AckCallback,
  ): Promise<void> {
    if (!ack) {
      return;
    }
    await this.updateLockLease(client, payload, ack, 'lockRelease', 'release');
  }

  private async updateLockLease(
    client: CollaborationSocket,
    payload: unknown,
    ack: AckCallback,
    schema: 'lockRenew' | 'lockRelease',
    action: 'renew' | 'release',
  ): Promise<void> {
    try {
      await this.assertActiveSession(client);
      if (!this.allowControlEvent(client)) {
        this.reply(ack, this.failure('RATE_LIMITED'));
        return;
      }
      const input = this.contractValidator.validate(schema, payload);
      if (action === 'renew') {
        const result = await this.documentQueue.run(input.documentId, async () => {
          const document = await this.getAuthorizedDocumentOrThrow(client, input.documentId);
          if (!this.joinedDocumentIds(client).has(input.documentId)) {
            throw new CollaborationOperationError('NOT_JOINED');
          }
          if (!this.hasElement(document, input.elementId)) {
            throw new CollaborationOperationError('INVALID_COMMAND');
          }
          const identity = this.identity(client);
          return this.lockStore.renew({
            ...input,
            userId: identity.userId,
            socketId: client.id,
            ttlSeconds: this.config().lockTtlSeconds,
          });
        });
        if (!result) {
          this.reply(ack, this.failure('FORBIDDEN'));
          return;
        }
        this.reply(ack, { ok: true, lock: result.lock, locks: result.locks });
        return;
      }
      const released = await this.documentQueue.run(input.documentId, async () => {
        const document = await this.getAuthorizedDocumentOrThrow(client, input.documentId);
        if (!this.joinedDocumentIds(client).has(input.documentId)) {
          throw new CollaborationOperationError('NOT_JOINED');
        }
        if (!this.hasElement(document, input.elementId)) {
          throw new CollaborationOperationError('INVALID_COMMAND');
        }
        const identity = this.identity(client);
        return this.lockStore.release({
          ...input,
          userId: identity.userId,
          socketId: client.id,
        });
      });
      if (!released) {
        this.reply(ack, this.failure('FORBIDDEN'));
        return;
      }
      this.reply(ack, {
        ok: true,
        documentId: input.documentId,
        locks: this.lockStore.list(input.documentId),
      });
    } catch (error: unknown) {
      this.reply(ack, this.toFailure(error));
      this.disconnectForAuthenticationFailure(client, error);
    }
  }

  private scheduleAuthorizedBroadcast(documentId: string, event: string, payload: unknown): void {
    void this.documentQueue
      .run(documentId, () => {
        const currentPayload =
          event === 'presence:changed'
            ? { documentId, participants: this.presenceStore.list(documentId) }
            : event === 'lock:changed'
              ? { documentId, locks: this.lockStore.list(documentId) }
              : payload;
        return this.broadcastToAuthorizedRoom(documentId, event, currentPayload);
      })
      .catch((error: unknown) => {
        if (error instanceof DocumentMutationQueueOverloadedError) {
          return;
        }
        this.logger.error('Realtime collaboration broadcast authorization failed.');
      });
  }

  private handleExternalDocumentChange(change: DocumentCollaborationChange): void {
    if (change.type === 'deleted') {
      this.deletedDocumentIds.add(change.documentId);
      this.pendingResyncChanges.delete(change.documentId);
      this.scheduleCriticalDocumentWork(change.documentId);
      return;
    }
    if (this.deletedDocumentIds.has(change.documentId)) {
      return;
    }
    this.pendingResyncChanges.set(change.documentId, change);
    this.scheduleCriticalDocumentWork(change.documentId);
  }

  private handleProjectCollaborationChange(change: ProjectCollaborationChange): void {
    if (change.type === 'member-granted') {
      const key = this.projectMemberKey(change.projectId, change.userId);
      const revocation = this.revokedProjectMemberKeys.get(key);
      if (revocation) {
        this.pendingMemberRevocationDocuments.delete(revocation);
      }
      this.revokedProjectMemberKeys.delete(key);
      return;
    }
    if (change.type === 'member-removed') {
      const key = this.projectMemberKey(change.projectId, change.userId);
      const previousRevocation = this.revokedProjectMemberKeys.get(key);
      if (previousRevocation) {
        this.pendingMemberRevocationDocuments.delete(previousRevocation);
      }
      const revocation = Symbol(key);
      this.revokedProjectMemberKeys.set(key, revocation);
      const documentIds = new Set(change.documentIds);
      if (documentIds.size === 0) {
        this.revokedProjectMemberKeys.delete(key);
        return;
      }
      this.pendingMemberRevocationDocuments.set(revocation, { key, documentIds });
      for (const documentId of documentIds) {
        const evictions = this.pendingMemberEvictionsByDocument.get(documentId) ?? new Map();
        evictions.set(key, { key, userId: change.userId, revocation });
        this.pendingMemberEvictionsByDocument.set(documentId, evictions);
        this.scheduleCriticalDocumentWork(documentId);
      }
      return;
    }
    for (const documentId of change.documentIds) {
      this.deletedDocumentIds.add(documentId);
      this.pendingResyncChanges.delete(documentId);
      this.scheduleCriticalDocumentWork(documentId);
    }
  }

  private scheduleCriticalDocumentWork(documentId: string): void {
    if (
      this.scheduledCriticalDocumentIds.has(documentId) ||
      this.criticalRetryTimers.has(documentId)
    ) {
      return;
    }
    this.scheduledCriticalDocumentIds.add(documentId);
    let failed = false;
    void this.documentQueue
      .runCritical(documentId, () => this.processCriticalDocumentWork(documentId))
      .catch(() => {
        failed = true;
        this.logger.error('Critical collaboration synchronization failed.');
      })
      .finally(() => {
        this.scheduledCriticalDocumentIds.delete(documentId);
        if (!this.hasCriticalDocumentWork(documentId)) {
          return;
        }
        if (failed) {
          this.scheduleCriticalDocumentRetry(documentId);
          return;
        }
        this.scheduleCriticalDocumentWork(documentId);
      });
  }

  private async processCriticalDocumentWork(documentId: string): Promise<void> {
    const evictions = this.pendingMemberEvictionsByDocument.get(documentId);
    this.pendingMemberEvictionsByDocument.delete(documentId);

    if (this.deletedDocumentIds.has(documentId)) {
      await this.evictDeletedDocument(documentId);
      this.completeMemberEvictions(documentId, evictions);
      this.pendingDeliveryRecoveryDocumentIds.delete(documentId);
      return;
    }

    if (evictions) {
      const removals = [...evictions.values()].flatMap((eviction) =>
        this.roomClients(documentId)
          .filter((client) => client.data.identity?.userId === eviction.userId)
          .filter((client) => !this.hasCurrentProjectAccess(client, documentId))
          .map((client) => this.revokeDocumentAccess(client, documentId)),
      );
      const results = await Promise.allSettled(removals);
      if (results.some((result) => result.status === 'rejected')) {
        this.logger.error('Realtime collaboration membership eviction failed.');
      }
      this.completeMemberEvictions(documentId, evictions);
    }

    if (this.deletedDocumentIds.has(documentId)) {
      await this.evictDeletedDocument(documentId);
      this.pendingDeliveryRecoveryDocumentIds.delete(documentId);
      return;
    }

    const recoveryRequested = this.pendingDeliveryRecoveryDocumentIds.has(documentId);
    const pendingBroadcasts =
      recoveryRequested && (await this.documentCommands.hasPendingBroadcasts(documentId));
    if (recoveryRequested && !pendingBroadcasts) {
      this.pendingDeliveryRecoveryDocumentIds.delete(documentId);
    }

    const change = this.pendingResyncChanges.get(documentId);
    const currentDocument = pendingBroadcasts
      ? await this.documentCommands.getCurrentDocument(documentId)
      : null;
    if (pendingBroadcasts && !currentDocument) {
      await this.documentCommands.markPendingBroadcastsDelivered(documentId);
      this.pendingDeliveryRecoveryDocumentIds.delete(documentId);
      return;
    }
    if (!change && !currentDocument) {
      return;
    }

    const activeElementIds = currentDocument
      ? currentDocument.canonicalModel.diagram.elements.map((element) => element.id)
      : change!.activeElementIds;
    this.lockStore.reconcileDocumentElements(documentId, new Set(activeElementIds));
    await this.broadcastToAuthorizedRoom(documentId, 'document:resync-required', {
      documentId,
      revision: currentDocument?.revision ?? change!.revision,
      resyncRequired: true,
    });
    if (this.pendingResyncChanges.get(documentId) === change) {
      this.pendingResyncChanges.delete(documentId);
    }
    if (pendingBroadcasts) {
      await this.documentCommands.markPendingBroadcastsDelivered(documentId);
      this.pendingDeliveryRecoveryDocumentIds.delete(documentId);
    }
  }

  private completeMemberEvictions(
    documentId: string,
    evictions: Map<string, PendingMemberEviction> | undefined,
  ): void {
    if (!evictions) {
      return;
    }
    for (const eviction of evictions.values()) {
      const pending = this.pendingMemberRevocationDocuments.get(eviction.revocation);
      if (!pending) {
        continue;
      }
      pending.documentIds.delete(documentId);
      if (pending.documentIds.size !== 0) {
        continue;
      }
      this.pendingMemberRevocationDocuments.delete(eviction.revocation);
      if (this.revokedProjectMemberKeys.get(pending.key) === eviction.revocation) {
        this.revokedProjectMemberKeys.delete(pending.key);
      }
    }
  }

  private hasCriticalDocumentWork(documentId: string): boolean {
    return (
      this.deletedDocumentIds.has(documentId) ||
      this.pendingMemberEvictionsByDocument.has(documentId) ||
      this.pendingResyncChanges.has(documentId) ||
      this.pendingDeliveryRecoveryDocumentIds.has(documentId)
    );
  }

  private scheduleCriticalDocumentRetry(documentId: string): void {
    if (this.criticalRetryTimers.has(documentId)) {
      return;
    }
    const timer = setTimeout(() => {
      this.criticalRetryTimers.delete(documentId);
      if (this.hasCriticalDocumentWork(documentId)) {
        this.scheduleCriticalDocumentWork(documentId);
      }
    }, 1_000);
    timer.unref();
    this.criticalRetryTimers.set(documentId, timer);
  }

  private startOperationRecovery(): void {
    if (this.operationRecoveryTimer) {
      return;
    }
    this.operationRecoveryTimer = setInterval(() => {
      void this.recoverUndeliveredOperations();
    }, this.config().operationRecoveryIntervalMs);
    this.operationRecoveryTimer.unref();
    void this.recoverUndeliveredOperations();
  }

  private async recoverUndeliveredOperations(): Promise<void> {
    if (this.operationRecoveryInFlight) {
      return;
    }
    this.operationRecoveryInFlight = true;
    try {
      const documentIds = await this.documentCommands.listDocumentsAwaitingDelivery(
        this.config().operationRecoveryBatchSize,
      );
      for (const documentId of documentIds) {
        this.pendingDeliveryRecoveryDocumentIds.add(documentId);
        this.scheduleCriticalDocumentWork(documentId);
      }
    } catch {
      this.logger.error('Undelivered collaboration operation recovery failed.');
    } finally {
      this.operationRecoveryInFlight = false;
    }
  }

  private async evictDeletedDocument(documentId: string): Promise<void> {
    try {
      await Promise.all(
        this.roomClients(documentId).map(async (client) => {
          client.emit('document:deleted', { documentId });
          try {
            await this.removeDocumentState(client, documentId);
          } catch {
            this.logger.error('Realtime collaboration document cleanup failed.');
          }
        }),
      );
      this.lockStore.reconcileDocumentElements(documentId, new Set());
    } finally {
      this.deletedDocumentIds.delete(documentId);
    }
  }

  private async broadcastToAuthorizedRoom(
    documentId: string,
    event: string,
    payload: unknown,
    excludedSocketId?: string,
  ): Promise<void> {
    if (this.deletedDocumentIds.has(documentId)) {
      return;
    }
    const recipients = this.roomClients(documentId);
    const identities = recipients.flatMap((client) => {
      const identity = client.data.identity;
      if (!identity) {
        client.disconnect(true);
        return [];
      }
      if (!this.hasActiveAccessToken(identity)) {
        this.disconnectExpiredToken(client);
        return [];
      }
      if (!this.hasCurrentProjectAccess(client, documentId)) {
        void this.revokeDocumentAccess(client, documentId);
        return [];
      }
      return [identity];
    });
    const authorization = await this.documentCommands.getBroadcastAuthorization(
      documentId,
      identities,
    );
    const removals: Promise<void>[] = [];
    for (const client of recipients) {
      if (client.id === excludedSocketId || !client.rooms.has(this.documentRoom(documentId))) {
        continue;
      }
      const identity = client.data.identity;
      if (!identity) {
        client.disconnect(true);
        continue;
      }
      if (!this.hasActiveAccessToken(identity)) {
        this.disconnectExpiredToken(client);
        continue;
      }
      if (!this.hasCurrentProjectAccess(client, documentId)) {
        removals.push(this.revokeDocumentAccess(client, documentId));
        continue;
      }
      if (!authorization.activeSessionKeys.has(this.sessionKey(identity))) {
        this.disconnectRevoked(client);
        continue;
      }
      if (!authorization.documentExists || !authorization.authorizedUserIds.has(identity.userId)) {
        removals.push(this.revokeDocumentAccess(client, documentId));
        continue;
      }
      if (this.deletedDocumentIds.has(documentId)) {
        continue;
      }
      client.emit(event, payload);
    }
    await Promise.all(removals);
  }

  private roomClients(documentId: string): CollaborationSocket[] {
    if (!this.server) {
      return [];
    }
    const socketIds = this.server.sockets.adapter.rooms.get(this.documentRoom(documentId));
    if (!socketIds) {
      return [];
    }
    const clients: CollaborationSocket[] = [];
    for (const socketId of socketIds) {
      const client = this.server.sockets.sockets.get(socketId) as CollaborationSocket | undefined;
      if (client) {
        clients.push(client);
      }
    }
    return clients;
  }

  private connectedClients(): CollaborationSocket[] {
    if (!this.server) {
      return [];
    }
    return [...this.server.sockets.sockets.values()] as CollaborationSocket[];
  }

  private async revokeDocumentAccess(
    client: CollaborationSocket,
    documentId: string,
  ): Promise<void> {
    client.emit('document:access-revoked', {
      documentId,
      ...this.failure('FORBIDDEN'),
    });
    await this.removeDocumentState(client, documentId);
  }

  private async removeDocumentState(
    client: CollaborationSocket,
    documentId: string,
  ): Promise<void> {
    await client.leave(this.documentRoom(documentId));
    this.joinedDocumentIds(client).delete(documentId);
    this.joinedDocumentProjects(client).delete(documentId);
    this.pendingJoinDocumentIds(client).delete(documentId);
    this.presenceStore.leave(documentId, client.id);
    this.lockStore.releaseBySocketInDocument(client.id, documentId);
  }

  private async requireAuthorizedDocument(
    client: CollaborationSocket,
    documentId: string,
    ack: AckCallback,
  ): Promise<AuthorizedDocument | null> {
    try {
      return await this.getAuthorizedDocumentOrThrow(client, documentId);
    } catch (error: unknown) {
      this.reply(ack, this.toFailure(error));
      this.disconnectForAuthenticationFailure(client, error);
      return null;
    }
  }

  private async getAuthorizedDocumentOrThrow(
    client: CollaborationSocket,
    documentId: string,
  ): Promise<AuthorizedDocument> {
    await this.assertActiveSession(client);
    const document = await this.documentCommands.getAuthorizedDocument(
      documentId,
      this.identity(client).userId,
    );
    if (!document) {
      throw new CollaborationOperationError('NOT_FOUND');
    }
    this.assertCurrentProjectAccess(document.projectId, this.identity(client).userId);
    return document;
  }

  private async requireActiveSession(
    client: CollaborationSocket,
    ack: AckCallback,
  ): Promise<boolean> {
    try {
      await this.assertActiveSession(client);
      return true;
    } catch (error: unknown) {
      this.reply(ack, this.toFailure(error));
      this.disconnectForAuthenticationFailure(client, error);
      return false;
    }
  }

  private async assertActiveSession(client: CollaborationSocket): Promise<void> {
    const identity = this.identity(client);
    if (!this.hasActiveAccessToken(identity)) {
      throw new CollaborationOperationError('UNAUTHENTICATED');
    }
    if (!(await this.accessTokenVerifier.isSessionActive(identity.userId, identity.sessionId))) {
      throw new CollaborationOperationError('SESSION_REVOKED');
    }
  }

  private disconnectForAuthenticationFailure(client: CollaborationSocket, error: unknown): void {
    if (!(error instanceof CollaborationOperationError)) {
      return;
    }
    if (error.code === 'SESSION_REVOKED') {
      this.disconnectRevoked(client);
      return;
    }
    if (error.code === 'UNAUTHENTICATED') {
      this.disconnectExpiredToken(client);
    }
  }

  private disconnectRevoked(client: CollaborationSocket): void {
    client.emit('session:revoked', this.failure('SESSION_REVOKED'));
    queueMicrotask(() => client.disconnect(true));
  }

  private disconnectExpiredToken(client: CollaborationSocket): void {
    queueMicrotask(() => client.disconnect(true));
  }

  private identity(client: CollaborationSocket): CollaborationIdentity {
    const identity = client.data.identity;
    if (!identity) {
      throw new CollaborationOperationError('UNAUTHENTICATED');
    }
    return identity;
  }

  private rejectHandshake(
    client: CollaborationSocket,
    next: (error?: Error) => void,
    message: string,
  ): void {
    releaseHandshakeReservation(client.request);
    next(new Error(message));
    // Allow CONNECT_ERROR to flush before force-closing a polling transport.
    const closeTimer = setTimeout(() => {
      client.conn.close(true);
    }, 100);
    closeTimer.unref();
  }

  private reserveSocket(socketId: string, sessionId: string): boolean {
    const config = this.config();
    if (this.connectedSocketIds.size >= config.maxConnectedSockets) {
      return false;
    }
    const sessionSocketIds = this.socketIdsBySession.get(sessionId) ?? new Set<string>();
    if (sessionSocketIds.size >= config.maxSocketsPerSession) {
      return false;
    }
    sessionSocketIds.add(socketId);
    this.connectedSocketIds.add(socketId);
    this.socketIdsBySession.set(sessionId, sessionSocketIds);
    return true;
  }

  private releaseSocketReservation(client: CollaborationSocket): void {
    const sessionId = client.data.reservedSessionId;
    if (!sessionId) {
      return;
    }
    this.connectedSocketIds.delete(client.id);
    const sessionSocketIds = this.socketIdsBySession.get(sessionId);
    sessionSocketIds?.delete(client.id);
    if (sessionSocketIds?.size === 0) {
      this.socketIdsBySession.delete(sessionId);
    }
    client.data.reservedSessionId = undefined;
  }

  private joinedDocumentIds(client: CollaborationSocket): Set<string> {
    client.data.joinedDocumentIds ??= new Set<string>();
    return client.data.joinedDocumentIds;
  }

  private joinedDocumentProjects(client: CollaborationSocket): Map<string, string> {
    client.data.joinedDocumentProjects ??= new Map<string, string>();
    return client.data.joinedDocumentProjects;
  }

  private pendingJoinDocumentIds(client: CollaborationSocket): Set<string> {
    client.data.pendingJoinDocumentIds ??= new Set<string>();
    return client.data.pendingJoinDocumentIds;
  }

  private async runSocketJoin<Result>(
    client: CollaborationSocket,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    const previous = client.data.joinTail ?? Promise.resolve();
    let release: (() => void) | undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => current);
    client.data.joinTail = tail;
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release?.();
      if (client.data.joinTail === tail) {
        client.data.joinTail = undefined;
      }
    }
  }

  private isJoinActive(client: CollaborationSocket, documentId: string): boolean {
    return (
      client.connected &&
      (this.pendingJoinDocumentIds(client).has(documentId) ||
        this.joinedDocumentIds(client).has(documentId))
    );
  }

  private hasCurrentProjectAccess(client: CollaborationSocket, documentId: string): boolean {
    const identity = client.data.identity;
    const projectId = this.joinedDocumentProjects(client).get(documentId);
    return (
      !identity || !projectId || this.hasCurrentProjectAccessForUser(projectId, identity.userId)
    );
  }

  private assertCurrentProjectAccess(projectId: string, userId: string): void {
    if (!this.hasCurrentProjectAccessForUser(projectId, userId)) {
      throw new CollaborationOperationError('NOT_FOUND');
    }
  }

  private hasCurrentProjectAccessForUser(projectId: string, userId: string): boolean {
    return !this.revokedProjectMemberKeys.has(this.projectMemberKey(projectId, userId));
  }

  private hasActiveAccessToken(identity: CollaborationIdentity): boolean {
    return identity.accessTokenExpiresAt > Math.floor(Date.now() / 1000);
  }

  private projectMemberKey(projectId: string, userId: string): string {
    return `${projectId}:${userId}`;
  }

  private hasElement(document: AuthorizedDocument, elementId: string): boolean {
    return document.canonicalModel.diagram.elements.some((element) => element.id === elementId);
  }

  private config(): AppConfiguration['collaboration'] {
    return this.configService.getOrThrow<AppConfiguration>('app').collaboration;
  }

  private allowControlEvent(client: CollaborationSocket): boolean {
    const config = this.config();
    return this.rateLimiter.allowControlEvent(
      client.id,
      config.controlEventLimit,
      config.controlEventWindowMs,
    );
  }

  private documentRoom(documentId: string): string {
    return `document:${documentId}`;
  }

  private sessionKey(identity: CollaborationIdentity): string {
    return `${identity.userId}:${identity.sessionId}`;
  }

  private operationIdFromPayload(payload: unknown): string | undefined {
    if (!payload || typeof payload !== 'object') {
      return undefined;
    }
    const operationId = (payload as Record<string, unknown>).operationId;
    return typeof operationId === 'string' && isUUID(operationId, '4') ? operationId : undefined;
  }

  private reply(ack: AckCallback, payload: unknown): void {
    ack?.(payload);
  }

  private failure(
    code: CollaborationErrorCode,
    operationId?: string,
    currentRevision?: number,
  ): CollaborationFailure {
    const messages: Record<CollaborationErrorCode, string> = {
      UNAUTHENTICATED: 'Authentication is required.',
      SESSION_REVOKED: 'The session is no longer active.',
      FORBIDDEN: 'The operation is not permitted.',
      NOT_FOUND: 'Document not found.',
      NOT_JOINED: 'Join the document before using this event.',
      INVALID_COMMAND: 'The collaboration payload or command is invalid.',
      INVALID_MODEL: 'The command would produce an invalid UML model.',
      REVISION_CONFLICT: 'Document revision conflict.',
      ELEMENT_LOCKED: 'An affected element is locked by another participant.',
      OPERATION_ID_REUSED: 'The operation identifier cannot be reused.',
      RATE_LIMITED: 'Too many collaboration requests.',
      INTERNAL_ERROR: 'The operation could not be completed.',
    };
    return {
      ok: false,
      ...(operationId ? { operationId } : {}),
      code,
      message: messages[code],
      ...(currentRevision === undefined ? {} : { currentRevision, resyncRequired: true }),
    };
  }

  private toFailure(error: unknown, operationId?: string): CollaborationFailure {
    if (error instanceof CollaborationOperationError) {
      return this.failure(error.code, operationId, error.currentRevision);
    }
    if (error instanceof CollaborationPayloadError) {
      return this.failure('INVALID_COMMAND', operationId);
    }
    if (error instanceof DocumentMutationQueueOverloadedError) {
      return this.failure('RATE_LIMITED', operationId);
    }
    this.logger.error('Realtime collaboration handler failed.');
    return this.failure('INTERNAL_ERROR', operationId);
  }
}
