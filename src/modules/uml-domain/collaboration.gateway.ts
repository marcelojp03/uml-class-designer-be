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
import { DocumentMutationQueueService } from './document-mutation-queue.service';

interface CollaborationSocketData {
  identity?: CollaborationIdentity;
  joinedDocumentIds?: Set<string>;
}

type CollaborationSocket = Socket & { data: CollaborationSocketData };
type AckCallback = ((response: unknown) => void) | undefined;

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
  ) {}

  afterInit(server: Server): void {
    server.use(async (socket, next) => {
      const token = socket.handshake.auth?.token;
      if (typeof token !== 'string') {
        next(new Error('Authentication is required.'));
        return;
      }
      try {
        const principal = await this.accessTokenVerifier.verify(token);
        (socket as CollaborationSocket).data.identity = {
          userId: principal.id,
          sessionId: principal.sessionId,
        };
        (socket as CollaborationSocket).data.joinedDocumentIds = new Set<string>();
        next();
      } catch {
        next(new Error('Authentication is required.'));
      }
    });
  }

  handleConnection(client: CollaborationSocket): void {
    if (!client.data.identity) {
      client.disconnect(true);
    }
  }

  handleDisconnect(client: CollaborationSocket): void {
    this.presenceStore.leaveBySocket(client.id);
    this.lockStore.releaseBySocket(client.id);
    this.rateLimiter.releaseSocket(client.id);
    client.data.joinedDocumentIds?.clear();
  }

  onModuleInit(): void {
    this.removePresenceListener = this.presenceStore.onChanged((change) => {
      this.scheduleAuthorizedBroadcast(change.documentId, 'presence:changed', change);
    });
    this.removeLockListener = this.lockStore.onChanged((change) => {
      this.scheduleAuthorizedBroadcast(change.documentId, 'lock:changed', change);
    });
    this.removeDocumentChangeListener = this.collaborationEvents.onChanged((change) => {
      void this.handleExternalDocumentChange(change).catch(() => {
        this.logger.error('External document collaboration synchronization failed.');
      });
    });
  }

  onModuleDestroy(): void {
    this.removePresenceListener?.();
    this.removeLockListener?.();
    this.removeDocumentChangeListener?.();
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
    try {
      const input = this.contractValidator.validate('documentJoin', payload);
      const document = await this.requireAuthorizedDocument(client, input.documentId, ack);
      if (!document) {
        return;
      }
      const joinedDocumentIds = this.joinedDocumentIds(client);
      const config = this.config();
      if (
        !joinedDocumentIds.has(input.documentId) &&
        joinedDocumentIds.size >= config.maxDocumentsPerSocket
      ) {
        this.reply(ack, this.failure('RATE_LIMITED'));
        return;
      }

      const identity = this.identity(client);
      const participants = this.presenceStore.join({
        documentId: input.documentId,
        userId: identity.userId,
        socketId: client.id,
        maxParticipants: config.maxParticipantsPerDocument,
      });
      if (!participants) {
        this.reply(ack, this.failure('RATE_LIMITED'));
        return;
      }

      await client.join(this.documentRoom(input.documentId));
      joinedDocumentIds.add(input.documentId);
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
    } catch (error: unknown) {
      this.reply(ack, this.toFailure(error));
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
      const input = this.contractValidator.validate('documentLeave', payload);
      if (!(await this.requireActiveSession(client, ack))) {
        return;
      }
      if (!this.joinedDocumentIds(client).has(input.documentId)) {
        this.reply(ack, this.failure('NOT_JOINED'));
        return;
      }
      await client.leave(this.documentRoom(input.documentId));
      this.joinedDocumentIds(client).delete(input.documentId);
      this.presenceStore.leave(input.documentId, client.id);
      this.lockStore.releaseBySocketInDocument(client.id, input.documentId);
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
      if (!(await this.requireAuthorizedDocument(client, input.documentId, ack))) {
        return;
      }
      if (!this.joinedDocumentIds(client).has(input.documentId)) {
        this.reply(ack, this.failure('NOT_JOINED', input.operationId));
        return;
      }

      const committed = await this.documentCommands.process(this.identity(client), input);
      this.presenceStore.touch(input.documentId, client.id);
      if (!committed.idempotent) {
        this.lockStore.reconcileDocumentElements(
          input.documentId,
          new Set(committed.activeElementIds),
        );
        await this.broadcastToAuthorizedRoom(
          input.documentId,
          'document:operation',
          {
            operationId: committed.operationId,
            documentId: committed.documentId,
            actorId: this.identity(client).userId,
            baseRevision: committed.baseRevision,
            revision: committed.revision,
            command: committed.command,
            committedAt: committed.committedAt,
          },
          client.id,
        );
      }
      this.reply(ack, {
        ok: true,
        operationId: committed.operationId,
        documentId: committed.documentId,
        revision: committed.revision,
        committedAt: committed.committedAt,
      });
    } catch (error: unknown) {
      const operationId = this.operationIdFromPayload(payload);
      this.reply(ack, this.toFailure(error, operationId));
      if (error instanceof CollaborationOperationError && error.code === 'SESSION_REVOKED') {
        this.disconnectRevoked(client);
      }
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
      const input = this.contractValidator.validate('lockAcquire', payload);
      const document = await this.requireAuthorizedDocument(client, input.documentId, ack);
      if (!document) {
        return;
      }
      if (!this.joinedDocumentIds(client).has(input.documentId)) {
        this.reply(ack, this.failure('NOT_JOINED'));
        return;
      }
      if (!this.hasElement(document, input.elementId)) {
        this.reply(ack, this.failure('INVALID_COMMAND'));
        return;
      }
      const identity = this.identity(client);
      const result = await this.documentQueue.run(input.documentId, () =>
        this.lockStore.acquire({
          documentId: input.documentId,
          elementId: input.elementId,
          userId: identity.userId,
          socketId: client.id,
          ttlSeconds: this.config().lockTtlSeconds,
        }),
      );
      if (!result) {
        this.reply(ack, this.failure('ELEMENT_LOCKED'));
        return;
      }
      this.presenceStore.touch(input.documentId, client.id);
      this.reply(ack, { ok: true, lock: result.lock, locks: result.locks });
    } catch (error: unknown) {
      this.reply(ack, this.toFailure(error));
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
      const input = this.contractValidator.validate(schema, payload);
      const document = await this.requireAuthorizedDocument(client, input.documentId, ack);
      if (!document) {
        return;
      }
      if (!this.joinedDocumentIds(client).has(input.documentId)) {
        this.reply(ack, this.failure('NOT_JOINED'));
        return;
      }
      if (!this.hasElement(document, input.elementId)) {
        this.reply(ack, this.failure('INVALID_COMMAND'));
        return;
      }
      const identity = this.identity(client);
      if (action === 'renew') {
        const result = await this.documentQueue.run(input.documentId, () =>
          this.lockStore.renew({
            ...input,
            userId: identity.userId,
            socketId: client.id,
            ttlSeconds: this.config().lockTtlSeconds,
          }),
        );
        if (!result) {
          this.reply(ack, this.failure('FORBIDDEN'));
          return;
        }
        this.reply(ack, { ok: true, lock: result.lock, locks: result.locks });
        return;
      }
      const released = await this.documentQueue.run(input.documentId, () =>
        this.lockStore.release({
          ...input,
          userId: identity.userId,
          socketId: client.id,
        }),
      );
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
    }
  }

  private scheduleAuthorizedBroadcast(documentId: string, event: string, payload: unknown): void {
    void this.broadcastToAuthorizedRoom(documentId, event, payload).catch(() => {
      this.logger.error('Realtime collaboration broadcast authorization failed.');
    });
  }

  private async handleExternalDocumentChange(change: DocumentCollaborationChange): Promise<void> {
    if (change.type === 'deleted') {
      await this.evictDeletedDocument(change.documentId);
      return;
    }
    this.lockStore.reconcileDocumentElements(change.documentId, new Set(change.activeElementIds));
    await this.broadcastToAuthorizedRoom(change.documentId, 'document:resync-required', {
      documentId: change.documentId,
      revision: change.revision,
      resyncRequired: true,
    });
  }

  private async evictDeletedDocument(documentId: string): Promise<void> {
    await Promise.all(
      this.roomClients(documentId).map(async (client) => {
        client.emit('document:deleted', { documentId });
        await this.removeDocumentState(client, documentId);
      }),
    );
    this.lockStore.reconcileDocumentElements(documentId, new Set());
  }

  private async broadcastToAuthorizedRoom(
    documentId: string,
    event: string,
    payload: unknown,
    excludedSocketId?: string,
  ): Promise<void> {
    const recipients = this.roomClients(documentId);
    const identities = recipients.flatMap((client) =>
      client.data.identity ? [client.data.identity] : [],
    );
    const authorization = await this.documentCommands.getBroadcastAuthorization(
      documentId,
      identities,
    );

    await Promise.all(
      recipients.map(async (client) => {
        if (client.id === excludedSocketId) {
          return;
        }
        const identity = client.data.identity;
        if (!identity) {
          client.disconnect(true);
          return;
        }
        if (!authorization.activeSessionKeys.has(this.sessionKey(identity))) {
          this.disconnectRevoked(client);
          return;
        }
        if (
          !authorization.documentExists ||
          !authorization.authorizedUserIds.has(identity.userId)
        ) {
          await this.revokeDocumentAccess(client, documentId);
          return;
        }
        client.emit(event, payload);
      }),
    );
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
    this.presenceStore.leave(documentId, client.id);
    this.lockStore.releaseBySocketInDocument(client.id, documentId);
  }

  private async requireAuthorizedDocument(
    client: CollaborationSocket,
    documentId: string,
    ack: AckCallback,
  ): Promise<AuthorizedDocument | null> {
    if (!(await this.requireActiveSession(client, ack))) {
      return null;
    }
    const document = await this.documentCommands.getAuthorizedDocument(
      documentId,
      this.identity(client).userId,
    );
    if (!document) {
      this.reply(ack, this.failure('NOT_FOUND'));
      return null;
    }
    return document;
  }

  private async requireActiveSession(
    client: CollaborationSocket,
    ack: AckCallback,
  ): Promise<boolean> {
    const identity = client.data.identity;
    if (!identity) {
      this.reply(ack, this.failure('UNAUTHENTICATED'));
      client.disconnect(true);
      return false;
    }
    if (await this.accessTokenVerifier.isSessionActive(identity.userId, identity.sessionId)) {
      return true;
    }
    this.reply(ack, this.failure('SESSION_REVOKED'));
    this.disconnectRevoked(client);
    return false;
  }

  private disconnectRevoked(client: CollaborationSocket): void {
    client.emit('session:revoked', this.failure('SESSION_REVOKED'));
    queueMicrotask(() => client.disconnect(true));
  }

  private identity(client: CollaborationSocket): CollaborationIdentity {
    const identity = client.data.identity;
    if (!identity) {
      throw new CollaborationOperationError('UNAUTHENTICATED');
    }
    return identity;
  }

  private joinedDocumentIds(client: CollaborationSocket): Set<string> {
    client.data.joinedDocumentIds ??= new Set<string>();
    return client.data.joinedDocumentIds;
  }

  private hasElement(document: AuthorizedDocument, elementId: string): boolean {
    return document.canonicalModel.diagram.elements.some((element) => element.id === elementId);
  }

  private config(): AppConfiguration['collaboration'] {
    return this.configService.getOrThrow<AppConfiguration>('app').collaboration;
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
    this.logger.error('Realtime collaboration handler failed.');
    return this.failure('INTERNAL_ERROR', operationId);
  }
}
