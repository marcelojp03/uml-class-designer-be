import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { io, type Socket } from 'socket.io-client';
import request = require('supertest');
import { createConfiguredApp } from '../src/bootstrap';
import type { AppConfiguration } from '../src/config/app.config';
import { PrismaService } from '../src/modules/database/prisma.service';
import { CollaborationGateway } from '../src/modules/uml-domain/collaboration.gateway';
import { CollaborationPresenceStore } from '../src/modules/uml-domain/collaboration-presence.store';
import { DocumentMutationQueueService } from '../src/modules/uml-domain/document-mutation-queue.service';
import type { CanonicalUmlModel } from '../src/modules/uml-domain/collaboration.types';

interface AuthContext {
  id: string;
  email: string;
  accessToken: string;
  refreshCookie: string;
}

interface AuthBody {
  accessToken: string;
  user: { id: string; email: string };
}

interface FailureAck {
  ok: false;
  code: string;
  currentRevision?: number;
}

interface CommandAck {
  ok: true;
  operationId: string;
  documentId: string;
  revision: number;
}

interface JoinAck {
  ok: true;
  documentId: string;
  revision: number;
  canonicalModel?: Record<string, unknown>;
  resyncRequired: boolean;
  participants: Array<{ userId: string; socketId: string }>;
  locks: Array<{ elementId: string }>;
}

interface LockAck {
  ok: true;
  lock: { elementId: string; leaseId: string };
  locks: Array<{ elementId: string }>;
}

interface PresenceChanged {
  documentId: string;
  participants: Array<{ userId: string; socketId: string }>;
}

interface LockChanged {
  documentId: string;
  locks: Array<{ elementId: string; userId: string }>;
}

interface ResyncRequired {
  documentId: string;
  revision: number;
  resyncRequired: boolean;
}

const authIntent = { 'X-Auth-Intent': '1' };
const validModel = JSON.parse(
  readFileSync(resolve(process.cwd(), 'contracts/fixtures/valid-uml-model.json'), 'utf8'),
) as CanonicalUmlModel;
const allowedSocketOrigin = 'http://localhost:5173';
let testClientAddress = 160;

function nextClientAddress(): string {
  return `198.51.100.${testClientAddress++}`;
}

function refreshCookie(response: request.Response): string {
  const header = response.headers['set-cookie'];
  const cookies = Array.isArray(header) ? header : header ? [header] : [];
  const refresh = cookies.find((value) => value.startsWith('uml_refresh_test='));
  if (!refresh) {
    throw new Error('Expected refresh cookie was not returned.');
  }
  return refresh.split(';', 1)[0]!;
}

function tokenSessionId(token: string): string {
  const encodedPayload = token.split('.')[1];
  if (!encodedPayload) {
    throw new Error('Expected an access token payload.');
  }
  const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as {
    sid?: string;
  };
  if (!payload.sid) {
    throw new Error('Expected an access token session identifier.');
  }
  return payload.sid;
}

function bearer(context: AuthContext): { Authorization: string } {
  return { Authorization: `Bearer ${context.accessToken}` };
}

function moveCommand(
  documentId: string,
  baseRevision: number,
  elementId: string,
  x: number,
  y: number,
) {
  return {
    operationId: randomUUID(),
    documentId,
    baseRevision,
    command: {
      type: 'classifier.move',
      timestamp: '2026-09-08T12:00:00.000Z',
      elementId,
      position: { x, y },
    },
  };
}

function renameClassifierCommand(
  documentId: string,
  baseRevision: number,
  elementId: string,
  name: string,
) {
  const classifier = validModel.diagram.elements.find((element) => element.id === elementId);
  if (!classifier) {
    throw new Error(`Expected classifier ${elementId}.`);
  }
  return {
    operationId: randomUUID(),
    documentId,
    baseRevision,
    command: {
      type: 'classifier.update' as const,
      timestamp: '2026-09-08T12:00:00.000Z',
      elementId,
      classifier: { ...structuredClone(classifier), name },
    },
  };
}

function associationClassRelationshipCommand(documentId: string, baseRevision: number) {
  return {
    operationId: randomUUID(),
    documentId,
    baseRevision,
    command: {
      type: 'relationship.create' as const,
      timestamp: '2026-09-08T12:00:00.000Z',
      relationship: {
        id: `rel_${randomUUID().replaceAll('-', '')}`,
        kind: 'association' as const,
        name: 'usesOrderLine',
        source: {
          elementId: 'customer',
          role: 'customer',
          multiplicity: '0..*',
          navigable: true,
        },
        target: {
          elementId: 'order',
          role: 'order',
          multiplicity: '0..*',
          navigable: true,
        },
        associationClassId: 'order_line',
      },
    },
  };
}

function waitForEvent<Payload>(socket: Socket, event: string): Promise<Payload> {
  return new Promise((resolveEvent, rejectEvent) => {
    const timeout = setTimeout(() => {
      socket.off(event, handler);
      rejectEvent(new Error(`Timed out waiting for ${event}.`));
    }, 5_000);
    const handler = (payload: Payload) => {
      clearTimeout(timeout);
      resolveEvent(payload);
    };
    socket.once(event, handler);
  });
}

function waitForMatchingEvent<Payload>(
  socket: Socket,
  event: string,
  matches: (payload: Payload) => boolean,
): Promise<Payload> {
  return new Promise((resolveEvent, rejectEvent) => {
    const timeout = setTimeout(() => {
      socket.off(event, handler);
      rejectEvent(new Error(`Timed out waiting for a matching ${event} event.`));
    }, 5_000);
    const handler = (payload: Payload) => {
      if (!matches(payload)) {
        return;
      }
      clearTimeout(timeout);
      socket.off(event, handler);
      resolveEvent(payload);
    };
    socket.on(event, handler);
  });
}

function waitForNoEvent(socket: Socket, event: string): Promise<void> {
  return new Promise((resolveEvent, rejectEvent) => {
    const timeout = setTimeout(() => {
      socket.off(event, handler);
      resolveEvent();
    }, 500);
    const handler = () => {
      clearTimeout(timeout);
      rejectEvent(new Error(`Unexpected ${event} event.`));
    };
    socket.once(event, handler);
  });
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolveDeferred!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolveDeferred = resolvePromise;
  });
  return { promise, resolve: resolveDeferred };
}

async function waitForCondition(condition: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }
    await new Promise<void>((continuePolling) => setTimeout(continuePolling, 10));
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

function emitAck<Payload>(socket: Socket, event: string, payload: unknown): Promise<Payload> {
  return new Promise((resolveAck, rejectAck) => {
    socket.timeout(5_000).emit(event, payload, (error: Error | null, response: Payload) => {
      if (error) {
        rejectAck(error);
        return;
      }
      resolveAck(response);
    });
  });
}

describe('authenticated realtime collaboration (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let apiBaseUrl: string;
  let owner: AuthContext;
  let editor: AuthContext;
  let outsider: AuthContext;
  let previousCommandLimit: string | undefined;
  let previousMaxDocumentsPerSocket: string | undefined;
  let previousMaxSocketsPerSession: string | undefined;
  let previousHandshakeLimit: string | undefined;
  let previousHandshakeGlobalLimit: string | undefined;
  let previousOperationRecoveryInterval: string | undefined;
  const sockets: Socket[] = [];

  const api = () => request(app.getHttpServer());
  async function register(email: string, displayName: string): Promise<AuthContext> {
    const response = await api()
      .post('/auth/register')
      .set(authIntent)
      .set('X-Forwarded-For', nextClientAddress())
      .send({ email, displayName, password: 'correct horse battery staple' })
      .expect(201);
    const body = response.body as AuthBody;
    return {
      id: body.user.id,
      email: body.user.email,
      accessToken: body.accessToken,
      refreshCookie: refreshCookie(response),
    };
  }

  async function connect(token: string, origin = allowedSocketOrigin): Promise<Socket> {
    return new Promise((resolveConnection, rejectConnection) => {
      const socket = io(apiBaseUrl, {
        auth: { token },
        transports: ['websocket'],
        reconnection: false,
        timeout: 5_000,
        extraHeaders: { Origin: origin },
      });
      socket.once('connect', () => {
        sockets.push(socket);
        resolveConnection(socket);
      });
      socket.once('connect_error', (error) => {
        socket.disconnect();
        rejectConnection(error);
      });
    });
  }

  async function connectionError(options: {
    auth?: Record<string, unknown>;
    query?: Record<string, string>;
    extraHeaders?: Record<string, string>;
  }) {
    return new Promise<Error>((resolveError, rejectConnection) => {
      const socket = io(apiBaseUrl, {
        ...options,
        ...(options.extraHeaders === undefined
          ? { extraHeaders: { Origin: allowedSocketOrigin } }
          : {}),
        transports: ['websocket'],
        reconnection: false,
        timeout: 5_000,
      });
      socket.once('connect', () => {
        socket.disconnect();
        rejectConnection(new Error('The unauthenticated socket connected.'));
      });
      socket.once('connect_error', (error) => {
        socket.disconnect();
        resolveError(error);
      });
    });
  }

  async function createDocument(context: AuthContext, includeEditor = false) {
    const project = await api()
      .post('/projects')
      .set(bearer(context))
      .send({ name: `Realtime ${randomUUID()}` })
      .expect(201);
    const projectId = project.body.id as string;
    if (includeEditor) {
      await api()
        .post(`/projects/${projectId}/members`)
        .set(bearer(context))
        .send({ userId: editor.id, email: editor.email })
        .expect(201);
    }
    const document = await api()
      .post(`/projects/${projectId}/documents`)
      .set(bearer(context))
      .send({ name: `Diagram ${randomUUID()}`, canonicalModel: structuredClone(validModel) })
      .expect(201);
    return { projectId, documentId: document.body.id as string };
  }

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    previousCommandLimit = process.env.COLLABORATION_COMMAND_LIMIT;
    previousMaxDocumentsPerSocket = process.env.COLLABORATION_MAX_DOCUMENTS_PER_SOCKET;
    previousMaxSocketsPerSession = process.env.COLLABORATION_MAX_SOCKETS_PER_SESSION;
    previousHandshakeLimit = process.env.COLLABORATION_HANDSHAKE_LIMIT;
    previousHandshakeGlobalLimit = process.env.COLLABORATION_HANDSHAKE_GLOBAL_LIMIT;
    previousOperationRecoveryInterval = process.env.COLLABORATION_OPERATION_RECOVERY_INTERVAL_MS;
    process.env.COLLABORATION_COMMAND_LIMIT = '2';
    process.env.COLLABORATION_MAX_DOCUMENTS_PER_SOCKET = '1';
    process.env.COLLABORATION_MAX_SOCKETS_PER_SESSION = '2';
    process.env.COLLABORATION_HANDSHAKE_LIMIT = '1000';
    process.env.COLLABORATION_HANDSHAKE_GLOBAL_LIMIT = '1000';
    process.env.COLLABORATION_OPERATION_RECOVERY_INTERVAL_MS = '250';
    const configured = await createConfiguredApp();
    app = configured.app;
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address();
    if (!address || typeof address === 'string') {
      throw new Error('The test HTTP server did not expose a TCP address.');
    }
    apiBaseUrl = `http://127.0.0.1:${address.port}`;
    prisma = app.get(PrismaService);
    await prisma.project.deleteMany();
    await prisma.authSession.deleteMany();
    await prisma.user.deleteMany();
    owner = await register('collaboration.owner@example.com', 'Collaboration Owner');
    editor = await register('collaboration.editor@example.com', 'Collaboration Editor');
    outsider = await register('collaboration.outsider@example.com', 'Collaboration Outsider');
  });

  afterEach(() => {
    for (const socket of sockets.splice(0)) {
      socket.removeAllListeners();
      socket.disconnect();
    }
  });

  afterAll(async () => {
    await prisma.project.deleteMany();
    await prisma.authSession.deleteMany();
    await prisma.user.deleteMany();
    await app.close();
    if (previousCommandLimit === undefined) {
      delete process.env.COLLABORATION_COMMAND_LIMIT;
    } else {
      process.env.COLLABORATION_COMMAND_LIMIT = previousCommandLimit;
    }
    if (previousMaxDocumentsPerSocket === undefined) {
      delete process.env.COLLABORATION_MAX_DOCUMENTS_PER_SOCKET;
    } else {
      process.env.COLLABORATION_MAX_DOCUMENTS_PER_SOCKET = previousMaxDocumentsPerSocket;
    }
    if (previousMaxSocketsPerSession === undefined) {
      delete process.env.COLLABORATION_MAX_SOCKETS_PER_SESSION;
    } else {
      process.env.COLLABORATION_MAX_SOCKETS_PER_SESSION = previousMaxSocketsPerSession;
    }
    if (previousHandshakeLimit === undefined) {
      delete process.env.COLLABORATION_HANDSHAKE_LIMIT;
    } else {
      process.env.COLLABORATION_HANDSHAKE_LIMIT = previousHandshakeLimit;
    }
    if (previousHandshakeGlobalLimit === undefined) {
      delete process.env.COLLABORATION_HANDSHAKE_GLOBAL_LIMIT;
    } else {
      process.env.COLLABORATION_HANDSHAKE_GLOBAL_LIMIT = previousHandshakeGlobalLimit;
    }
    if (previousOperationRecoveryInterval === undefined) {
      delete process.env.COLLABORATION_OPERATION_RECOVERY_INTERVAL_MS;
    } else {
      process.env.COLLABORATION_OPERATION_RECOVERY_INTERVAL_MS = previousOperationRecoveryInterval;
    }
  });

  it('rejects anonymous, malformed, and query-string-only authentication handshakes', async () => {
    await expect(connectionError({ auth: {} })).resolves.toMatchObject({
      message: 'Authentication is required.',
    });
    await expect(connectionError({ auth: { token: 'not-a-jwt' } })).resolves.toMatchObject({
      message: 'Authentication is required.',
    });
    await expect(connectionError({ query: { token: owner.accessToken } })).resolves.toMatchObject({
      message: 'Authentication is required.',
    });
    await expect(
      connectionError({
        auth: { token: owner.accessToken },
        extraHeaders: { Origin: 'https://attacker.example' },
      }),
    ).resolves.toBeInstanceOf(Error);
    await expect(
      connectionError({ auth: { token: owner.accessToken }, extraHeaders: {} }),
    ).resolves.toBeInstanceOf(Error);
    const allowedOriginSocket = await connect(owner.accessToken);
    expect(allowedOriginSocket.connected).toBe(true);
  });

  it('limits idle connections from one active session', async () => {
    await connect(owner.accessToken);
    await connect(owner.accessToken);
    await expect(connectionError({ auth: { token: owner.accessToken } })).resolves.toMatchObject({
      message: 'Connection limit reached.',
    });
  });

  it('authorizes document joins, returns snapshots only when required, and blocks commands before joining', async () => {
    const { documentId } = await createDocument(owner, true);
    const ownerSocket = await connect(owner.accessToken);
    const outsiderSocket = await connect(outsider.accessToken);

    const beforeJoin = await emitAck<FailureAck>(
      ownerSocket,
      'document:command',
      moveCommand(documentId, 0, 'person', 500, 60),
    );
    expect(beforeJoin).toMatchObject({ ok: false, code: 'NOT_JOINED' });

    const outsiderJoin = await emitAck<FailureAck>(outsiderSocket, 'document:join', { documentId });
    expect(outsiderJoin).toMatchObject({ ok: false, code: 'NOT_FOUND' });

    const initialJoin = await emitAck<JoinAck>(ownerSocket, 'document:join', { documentId });
    expect(initialJoin).toMatchObject({
      ok: true,
      revision: 0,
      resyncRequired: false,
      canonicalModel: expect.objectContaining({ schemaVersion: '0.1.0' }),
    });
    expect(initialJoin.participants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ userId: owner.id, socketId: ownerSocket.id }),
      ]),
    );

    const currentJoin = await emitAck<JoinAck>(ownerSocket, 'document:join', {
      documentId,
      knownRevision: 0,
    });
    expect(currentJoin).toMatchObject({ ok: true, revision: 0, resyncRequired: false });
    expect(currentJoin.canonicalModel).toBeUndefined();
  });

  it('cancels a queued join when the client leaves before it can commit', async () => {
    const { documentId } = await createDocument(owner);
    const ownerSocket = await connect(owner.accessToken);
    const queue = app.get(DocumentMutationQueueService);
    const entered = deferred();
    const release = deferred();
    const blocker = queue.run(documentId, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;

    const gateway = app.get(CollaborationGateway) as unknown as {
      server: {
        sockets: { sockets: Map<string, { data: { pendingJoinDocumentIds?: Set<string> } }> };
      };
    };
    const joining = emitAck<JoinAck | FailureAck>(ownerSocket, 'document:join', { documentId });
    await waitForCondition(
      () =>
        gateway.server.sockets.sockets
          .get(ownerSocket.id!)
          ?.data.pendingJoinDocumentIds?.has(documentId) === true,
      'the queued document join',
    );
    await expect(
      emitAck<{ ok: true }>(ownerSocket, 'document:leave', { documentId }),
    ).resolves.toEqual({ ok: true, documentId });

    release.resolve();
    await blocker;
    await expect(joining).resolves.toMatchObject({ ok: false, code: 'NOT_JOINED' });
    expect(app.get(CollaborationPresenceStore).list(documentId)).toEqual([]);
  });

  it('serializes concurrent joins to enforce the per-socket document limit', async () => {
    const first = await createDocument(owner);
    const second = await createDocument(owner);
    const ownerSocket = await connect(owner.accessToken);

    const results = await Promise.all([
      emitAck<JoinAck | FailureAck>(ownerSocket, 'document:join', { documentId: first.documentId }),
      emitAck<JoinAck | FailureAck>(ownerSocket, 'document:join', {
        documentId: second.documentId,
      }),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      expect.objectContaining({ code: 'RATE_LIMITED' }),
    ]);
    expect(
      app
        .get(CollaborationPresenceStore)
        .list(first.documentId)
        .concat(app.get(CollaborationPresenceStore).list(second.documentId)),
    ).toHaveLength(1);
  });

  it('charges malformed commands to the per-socket command limit before schema validation', async () => {
    const { documentId } = await createDocument(owner);
    const ownerSocket = await connect(owner.accessToken);
    await emitAck<JoinAck>(ownerSocket, 'document:join', { documentId });

    const malformedPayload = () => ({
      operationId: randomUUID(),
      documentId,
      baseRevision: 0,
      command: { type: 'model.replace', timestamp: '2026-09-08T12:00:00.000Z' },
    });
    await expect(
      emitAck<FailureAck>(ownerSocket, 'document:command', malformedPayload()),
    ).resolves.toMatchObject({ ok: false, code: 'INVALID_COMMAND' });
    await expect(
      emitAck<FailureAck>(ownerSocket, 'document:command', malformedPayload()),
    ).resolves.toMatchObject({ ok: false, code: 'INVALID_COMMAND' });
    await expect(
      emitAck<FailureAck>(ownerSocket, 'document:command', malformedPayload()),
    ).resolves.toMatchObject({ ok: false, code: 'RATE_LIMITED' });
    expect(await prisma.umlDocument.findUniqueOrThrow({ where: { id: documentId } })).toMatchObject(
      {
        revision: 0,
      },
    );
  });

  it('rejects a delayed REST write after concurrent session revocation', async () => {
    const writer = await register(`writer.${randomUUID()}@example.com`, 'Delayed REST Writer');
    const project = await api()
      .post('/projects')
      .set(bearer(writer))
      .send({ name: `Session race ${randomUUID()}` })
      .expect(201);
    const sessionId = tokenSessionId(writer.accessToken);
    const lockAcquired = deferred();
    const releaseRevocation = deferred();
    const revocation = prisma.$transaction(async (transaction) => {
      await transaction.authSession.update({
        where: { id: sessionId },
        data: { revokedAt: new Date() },
      });
      lockAcquired.resolve();
      await releaseRevocation.promise;
    });
    await lockAcquired.promise;

    const createDocumentRequest = api()
      .post(`/projects/${project.body.id as string}/documents`)
      .set(bearer(writer))
      .send({ name: `Blocked ${randomUUID()}`, canonicalModel: structuredClone(validModel) })
      .then((response) => response);
    await Promise.resolve();
    releaseRevocation.resolve();
    await revocation;
    expect((await createDocumentRequest).status).toBe(401);
    expect(
      await prisma.umlDocument.count({ where: { projectId: project.body.id as string } }),
    ).toBe(0);
  });

  it('broadcasts only committed commands and treats exact retries as idempotent', async () => {
    const { documentId } = await createDocument(owner, true);
    const ownerSocket = await connect(owner.accessToken);
    const editorSocket = await connect(editor.accessToken);
    await emitAck<JoinAck>(ownerSocket, 'document:join', { documentId });
    await emitAck<JoinAck>(editorSocket, 'document:join', { documentId });

    const input = moveCommand(documentId, 0, 'person', 512, 72);
    const broadcast = waitForEvent<{
      operationId: string;
      revision: number;
      actorId: string;
      command: { type: string };
    }>(editorSocket, 'document:operation');
    const accepted = await emitAck<CommandAck>(ownerSocket, 'document:command', input);
    expect(accepted).toMatchObject({ ok: true, operationId: input.operationId, revision: 1 });
    await expect(broadcast).resolves.toMatchObject({
      operationId: input.operationId,
      revision: 1,
      actorId: owner.id,
      command: { type: 'classifier.move' },
    });

    const noDuplicateBroadcast = waitForNoEvent(editorSocket, 'document:operation');
    const retried = await emitAck<CommandAck>(ownerSocket, 'document:command', input);
    expect(retried).toMatchObject({ ok: true, operationId: input.operationId, revision: 1 });
    await expect(noDuplicateBroadcast).resolves.toBeUndefined();

    const persisted = await prisma.umlDocument.findUniqueOrThrow({
      where: { id: documentId },
      select: { revision: true, canonicalModel: true },
    });
    expect(persisted.revision).toBe(1);
    expect(
      (
        persisted.canonicalModel as {
          diagram: { visual: { positions: Array<{ elementId: string; x: number; y: number }> } };
        }
      ).diagram.visual.positions,
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ elementId: 'person', x: 512, y: 72 })]),
    );
    expect(await prisma.documentRevision.count({ where: { documentId } })).toBe(2);
    expect(await prisma.documentOperation.count({ where: { documentId } })).toBe(1);
    expect(
      await prisma.documentOperation.findUniqueOrThrow({
        where: { documentId_operationId: { documentId, operationId: input.operationId } },
        select: { broadcastedAt: true },
      }),
    ).toMatchObject({ broadcastedAt: expect.any(Date) });
  });

  it('recovers an undelivered committed operation with an authorized resync', async () => {
    const { documentId } = await createDocument(owner, true);
    const editorSocket = await connect(editor.accessToken);
    await emitAck<JoinAck>(editorSocket, 'document:join', { documentId });

    const resync = waitForMatchingEvent<ResyncRequired>(
      editorSocket,
      'document:resync-required',
      (payload) => payload.documentId === documentId,
    );
    const operationId = randomUUID();
    await prisma.documentOperation.create({
      data: {
        operationId,
        documentId,
        actorId: owner.id,
        baseRevision: 0,
        resultingRevision: 1,
        command: {
          type: 'classifier.move',
          timestamp: '2026-09-08T12:00:00.000Z',
          elementId: 'person',
          position: { x: 300, y: 80 },
        },
        commandFingerprint: '0'.repeat(64),
        committedAt: new Date(),
      },
    });

    await expect(resync).resolves.toEqual({ documentId, revision: 0, resyncRequired: true });
    await app.get(DocumentMutationQueueService).run(documentId, () => undefined);
    await expect(
      prisma.documentOperation.findUniqueOrThrow({
        where: { documentId_operationId: { documentId, operationId } },
        select: { broadcastedAt: true },
      }),
    ).resolves.toEqual({ broadcastedAt: expect.any(Date) });
  });

  it('serializes competing revisions and returns a recoverable conflict to one client', async () => {
    const { documentId } = await createDocument(owner, true);
    const ownerSocket = await connect(owner.accessToken);
    const editorSocket = await connect(editor.accessToken);
    await emitAck<JoinAck>(ownerSocket, 'document:join', { documentId });
    await emitAck<JoinAck>(editorSocket, 'document:join', { documentId });

    const [first, second] = await Promise.all([
      emitAck<CommandAck | FailureAck>(
        ownerSocket,
        'document:command',
        moveCommand(documentId, 0, 'person', 300, 80),
      ),
      emitAck<CommandAck | FailureAck>(
        editorSocket,
        'document:command',
        moveCommand(documentId, 0, 'customer', 160, 320),
      ),
    ]);

    const results = [first, second];
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      expect.objectContaining({ code: 'REVISION_CONFLICT', currentRevision: 1 }),
    ]);
    expect(await prisma.umlDocument.findUniqueOrThrow({ where: { id: documentId } })).toMatchObject(
      {
        revision: 1,
      },
    );
    expect(await prisma.documentOperation.count({ where: { documentId } })).toBe(1);
  });

  it('signals REST replacements and evicts joined sockets after an authorized deletion', async () => {
    const { projectId, documentId } = await createDocument(owner, true);
    const ownerSocket = await connect(owner.accessToken);
    const editorSocket = await connect(editor.accessToken);
    await emitAck<JoinAck>(ownerSocket, 'document:join', { documentId });
    await emitAck<JoinAck>(editorSocket, 'document:join', { documentId });

    const resync = waitForEvent<ResyncRequired>(editorSocket, 'document:resync-required');
    const replacement = structuredClone(validModel);
    (replacement.diagram as Record<string, unknown>).name = 'Replaced through REST';
    await api()
      .put(`/projects/${projectId}/documents/${documentId}`)
      .set(bearer(owner))
      .send({ expectedRevision: 0, canonicalModel: replacement })
      .expect(200);
    await expect(resync).resolves.toEqual({ documentId, revision: 1, resyncRequired: true });
    expect(await prisma.documentOperation.count({ where: { documentId } })).toBe(0);

    const deleted = waitForEvent<{ documentId: string }>(editorSocket, 'document:deleted');
    await api()
      .delete(`/projects/${projectId}/documents/${documentId}`)
      .set(bearer(owner))
      .expect(204);
    await expect(deleted).resolves.toEqual({ documentId });
    await expect(
      emitAck<FailureAck>(
        editorSocket,
        'document:command',
        moveCommand(documentId, 1, 'person', 333, 88),
      ),
    ).resolves.toMatchObject({ ok: false, code: 'NOT_FOUND' });
  });

  it('rejects REST replacements that would overwrite another participant lock', async () => {
    const { projectId, documentId } = await createDocument(owner, true);
    const ownerSocket = await connect(owner.accessToken);
    const editorSocket = await connect(editor.accessToken);
    await emitAck<JoinAck>(ownerSocket, 'document:join', { documentId });
    await emitAck<JoinAck>(editorSocket, 'document:join', { documentId });
    await emitAck<LockAck>(ownerSocket, 'lock:acquire', { documentId, elementId: 'person' });

    await api()
      .put(`/projects/${projectId}/documents/${documentId}`)
      .set(bearer(editor))
      .send({ expectedRevision: 0, canonicalModel: structuredClone(validModel) })
      .expect(409);
    expect(await prisma.umlDocument.findUniqueOrThrow({ where: { id: documentId } })).toMatchObject(
      {
        revision: 0,
      },
    );
  });

  it('evicts joined sockets when an authorized project deletion cascades to documents', async () => {
    const { projectId, documentId } = await createDocument(owner, true);
    const ownerSocket = await connect(owner.accessToken);
    const editorSocket = await connect(editor.accessToken);
    await emitAck<JoinAck>(ownerSocket, 'document:join', { documentId });
    await emitAck<JoinAck>(editorSocket, 'document:join', { documentId });

    const deleted = waitForEvent<{ documentId: string }>(editorSocket, 'document:deleted');
    await api().delete(`/projects/${projectId}`).set(bearer(owner)).expect(204);
    await expect(deleted).resolves.toEqual({ documentId });
    await expect(
      emitAck<FailureAck>(
        editorSocket,
        'document:command',
        moveCommand(documentId, 0, 'person', 333, 88),
      ),
    ).resolves.toMatchObject({ ok: false, code: 'NOT_FOUND' });
  });

  it('delivers a project deletion while the per-document standard capacity is occupied', async () => {
    const { projectId, documentId } = await createDocument(owner, true);
    const ownerSocket = await connect(owner.accessToken);
    const editorSocket = await connect(editor.accessToken);
    await emitAck<JoinAck>(ownerSocket, 'document:join', { documentId });
    await emitAck<JoinAck>(editorSocket, 'document:join', { documentId });

    const queue = app.get(DocumentMutationQueueService);
    await queue.run(documentId, () => undefined);
    const queueInternals = queue as unknown as {
      maxPendingMutationsPerDocument(): number;
    };
    const capacity = jest
      .spyOn(queueInternals, 'maxPendingMutationsPerDocument')
      .mockReturnValue(2);
    const entered = deferred();
    const release = deferred();
    const blocker = queue.run(documentId, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;

    const deleted = waitForEvent<{ documentId: string }>(editorSocket, 'document:deleted');
    try {
      await api().delete(`/projects/${projectId}`).set(bearer(owner)).expect(204);
      release.resolve();
      await blocker;
      await expect(deleted).resolves.toEqual({ documentId });
    } finally {
      release.resolve();
      capacity.mockRestore();
    }
  });

  it('removes an idle member before delivering the next room broadcast', async () => {
    const { projectId, documentId } = await createDocument(owner, true);
    const ownerSocket = await connect(owner.accessToken);
    const editorSocket = await connect(editor.accessToken);
    await emitAck<JoinAck>(ownerSocket, 'document:join', { documentId });
    await emitAck<JoinAck>(editorSocket, 'document:join', { documentId });

    const accessRevoked = waitForEvent<FailureAck & { documentId: string }>(
      editorSocket,
      'document:access-revoked',
    );
    await api()
      .delete(`/projects/${projectId}/members/${editor.id}`)
      .set(bearer(owner))
      .expect(204);
    await expect(accessRevoked).resolves.toMatchObject({
      ok: false,
      code: 'FORBIDDEN',
      documentId,
    });
    const noPresence = waitForNoEvent(editorSocket, 'presence:changed');
    await expect(
      emitAck<{ ok: true }>(ownerSocket, 'presence:update', {
        documentId,
        selection: ['person'],
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(noPresence).resolves.toBeUndefined();
    await expect(
      emitAck<FailureAck>(
        editorSocket,
        'document:command',
        moveCommand(documentId, 0, 'person', 510, 90),
      ),
    ).resolves.toMatchObject({ ok: false, code: 'NOT_FOUND' });
  });

  it('releases member and deleted-document fences after their eviction work completes', async () => {
    const gateway = app.get(CollaborationGateway) as unknown as {
      revokedProjectMemberKeys: Map<string, symbol>;
      deletedDocumentIds: Set<string>;
    };
    const queue = app.get(DocumentMutationQueueService);
    const first = await createDocument(owner, true);
    const firstEditorSocket = await connect(editor.accessToken);
    await emitAck<JoinAck>(firstEditorSocket, 'document:join', { documentId: first.documentId });

    const accessRevoked = waitForEvent<FailureAck & { documentId: string }>(
      firstEditorSocket,
      'document:access-revoked',
    );
    await api()
      .delete(`/projects/${first.projectId}/members/${editor.id}`)
      .set(bearer(owner))
      .expect(204);
    await expect(accessRevoked).resolves.toMatchObject({ documentId: first.documentId });
    await queue.run(first.documentId, () => undefined);
    await Promise.resolve();
    expect(gateway.revokedProjectMemberKeys.has(`${first.projectId}:${editor.id}`)).toBe(false);

    const second = await createDocument(owner, true);
    const secondEditorSocket = await connect(editor.accessToken);
    await emitAck<JoinAck>(secondEditorSocket, 'document:join', { documentId: second.documentId });
    const deleted = waitForEvent<{ documentId: string }>(secondEditorSocket, 'document:deleted');
    await api()
      .delete(`/projects/${second.projectId}/documents/${second.documentId}`)
      .set(bearer(owner))
      .expect(204);
    await expect(deleted).resolves.toEqual({ documentId: second.documentId });
    await queue.run(second.documentId, () => undefined);
    expect(gateway.deletedDocumentIds.has(second.documentId)).toBe(false);
  });

  it('enforces locks, publishes presence, and cleans state when a socket disconnects', async () => {
    const { documentId } = await createDocument(owner, true);
    const ownerSocket = await connect(owner.accessToken);
    await emitAck<JoinAck>(ownerSocket, 'document:join', { documentId });

    const joinedPresence = waitForMatchingEvent<PresenceChanged>(
      ownerSocket,
      'presence:changed',
      (change) => change.participants.some((participant) => participant.userId === editor.id),
    );
    const editorSocket = await connect(editor.accessToken);
    await emitAck<JoinAck>(editorSocket, 'document:join', { documentId });
    await expect(joinedPresence).resolves.toMatchObject({
      documentId,
      participants: expect.arrayContaining([
        expect.objectContaining({ userId: owner.id }),
        expect.objectContaining({ userId: editor.id }),
      ]),
    });

    const lockChanged = waitForEvent<LockChanged>(ownerSocket, 'lock:changed');
    const lock = await emitAck<LockAck>(ownerSocket, 'lock:acquire', {
      documentId,
      elementId: 'person',
    });
    expect(lock).toMatchObject({ ok: true, lock: { elementId: 'person' } });
    await expect(lockChanged).resolves.toMatchObject({
      documentId,
      locks: [expect.objectContaining({ elementId: 'person', userId: owner.id })],
    });

    await expect(
      emitAck<FailureAck>(editorSocket, 'lock:acquire', { documentId, elementId: 'person' }),
    ).resolves.toMatchObject({ ok: false, code: 'ELEMENT_LOCKED' });
    await expect(
      emitAck<FailureAck>(
        editorSocket,
        'document:command',
        moveCommand(documentId, 0, 'person', 640, 96),
      ),
    ).resolves.toMatchObject({ ok: false, code: 'ELEMENT_LOCKED' });
    await expect(
      emitAck<FailureAck>(editorSocket, 'lock:release', {
        documentId,
        elementId: 'person',
        leaseId: lock.lock.leaseId,
      }),
    ).resolves.toMatchObject({ ok: false, code: 'FORBIDDEN' });

    const renewed = await emitAck<LockAck>(ownerSocket, 'lock:renew', {
      documentId,
      elementId: 'person',
      leaseId: lock.lock.leaseId,
    });
    expect(renewed).toMatchObject({ ok: true, lock: { elementId: 'person' } });
    await emitAck<{ ok: true }>(ownerSocket, 'lock:release', {
      documentId,
      elementId: 'person',
      leaseId: lock.lock.leaseId,
    });
    await expect(
      emitAck<LockAck>(editorSocket, 'lock:acquire', { documentId, elementId: 'person' }),
    ).resolves.toMatchObject({ ok: true, lock: { elementId: 'person' } });

    const leftPresence = waitForEvent<PresenceChanged>(ownerSocket, 'presence:changed');
    editorSocket.disconnect();
    await expect(leftPresence).resolves.toMatchObject({
      documentId,
      participants: [expect.objectContaining({ userId: owner.id })],
    });
  });

  it('blocks renames that would update type references in another participant lock', async () => {
    const { documentId } = await createDocument(owner, true);
    const ownerSocket = await connect(owner.accessToken);
    const editorSocket = await connect(editor.accessToken);
    await emitAck<JoinAck>(ownerSocket, 'document:join', { documentId });
    await emitAck<JoinAck>(editorSocket, 'document:join', { documentId });
    await emitAck<LockAck>(ownerSocket, 'lock:acquire', { documentId, elementId: 'customer' });

    await expect(
      emitAck<FailureAck>(
        editorSocket,
        'document:command',
        renameClassifierCommand(documentId, 0, 'order', 'PurchaseOrder'),
      ),
    ).resolves.toMatchObject({ ok: false, code: 'ELEMENT_LOCKED' });
    expect(await prisma.umlDocument.findUniqueOrThrow({ where: { id: documentId } })).toMatchObject(
      {
        revision: 0,
      },
    );
  });

  it('blocks relationship creation that would attach another participant locked association class', async () => {
    const { documentId } = await createDocument(owner, true);
    const ownerSocket = await connect(owner.accessToken);
    const editorSocket = await connect(editor.accessToken);
    await emitAck<JoinAck>(ownerSocket, 'document:join', { documentId });
    await emitAck<JoinAck>(editorSocket, 'document:join', { documentId });
    await emitAck<LockAck>(ownerSocket, 'lock:acquire', { documentId, elementId: 'order_line' });

    await expect(
      emitAck<FailureAck>(
        editorSocket,
        'document:command',
        associationClassRelationshipCommand(documentId, 0),
      ),
    ).resolves.toMatchObject({ ok: false, code: 'ELEMENT_LOCKED' });
    expect(await prisma.umlDocument.findUniqueOrThrow({ where: { id: documentId } })).toMatchObject(
      {
        revision: 0,
      },
    );
  });

  it('rejects invalid commands without mutation and disconnects an idle revoked socket before broadcast', async () => {
    const revoked = await register(`revoked.${randomUUID()}@example.com`, 'Revoked Collaborator');
    const { documentId } = await createDocument(revoked, true);
    const socket = await connect(revoked.accessToken);
    const editorSocket = await connect(editor.accessToken);
    await emitAck<JoinAck>(socket, 'document:join', { documentId });
    await emitAck<JoinAck>(editorSocket, 'document:join', { documentId });

    const invalid = await emitAck<FailureAck>(socket, 'document:command', {
      operationId: randomUUID(),
      documentId,
      baseRevision: 0,
      command: { type: 'model.replace', timestamp: '2026-09-08T12:00:00.000Z' },
    });
    expect(invalid).toMatchObject({ ok: false, code: 'INVALID_COMMAND' });
    expect(await prisma.umlDocument.findUniqueOrThrow({ where: { id: documentId } })).toMatchObject(
      {
        revision: 0,
      },
    );

    const revokedEvent = waitForEvent<FailureAck>(socket, 'session:revoked');
    const disconnected = waitForEvent<string>(socket, 'disconnect');
    await api()
      .post('/auth/logout')
      .set(authIntent)
      .set('Cookie', revoked.refreshCookie)
      .expect(204);
    const noOperation = waitForNoEvent(socket, 'document:operation');
    await expect(
      emitAck<CommandAck>(
        editorSocket,
        'document:command',
        moveCommand(documentId, 0, 'person', 740, 112),
      ),
    ).resolves.toMatchObject({ ok: true, revision: 1 });
    await expect(revokedEvent).resolves.toMatchObject({ ok: false, code: 'SESSION_REVOKED' });
    await expect(disconnected).resolves.toEqual(expect.any(String));
    await expect(noOperation).resolves.toBeUndefined();
  });

  it('disconnects an idle socket when its access token expires before a broadcast', async () => {
    const { documentId } = await createDocument(owner, true);
    const configuration = app.get(ConfigService).getOrThrow<AppConfiguration>('app');
    const shortLivedToken = await app.get(JwtService).signAsync(
      { sub: owner.id, sid: tokenSessionId(owner.accessToken), typ: 'access' },
      {
        secret: configuration.auth.jwtSecret,
        algorithm: 'HS256',
        issuer: configuration.auth.jwtIssuer,
        audience: configuration.auth.jwtAudience,
        expiresIn: 2,
      },
    );
    const expiredSocket = await connect(shortLivedToken);
    const editorSocket = await connect(editor.accessToken);
    await emitAck<JoinAck>(expiredSocket, 'document:join', { documentId });
    await emitAck<JoinAck>(editorSocket, 'document:join', { documentId });

    const disconnected = waitForEvent<string>(expiredSocket, 'disconnect');
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 2_500));
    await expect(disconnected).resolves.toEqual(expect.any(String));
    const noOperation = waitForNoEvent(expiredSocket, 'document:operation');
    await expect(
      emitAck<CommandAck>(
        editorSocket,
        'document:command',
        moveCommand(documentId, 0, 'person', 810, 120),
      ),
    ).resolves.toMatchObject({ ok: true, revision: 1 });
    await expect(noOperation).resolves.toBeUndefined();
  });

  it('rejects an already expired access token during handshake', async () => {
    const configuration = app.get(ConfigService).getOrThrow<AppConfiguration>('app');
    const expiredToken = await app.get(JwtService).signAsync(
      { sub: owner.id, sid: tokenSessionId(owner.accessToken), typ: 'access' },
      {
        secret: configuration.auth.jwtSecret,
        algorithm: 'HS256',
        issuer: configuration.auth.jwtIssuer,
        audience: configuration.auth.jwtAudience,
        expiresIn: 1,
      },
    );
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000));
    await expect(connectionError({ auth: { token: expiredToken } })).resolves.toMatchObject({
      message: 'Authentication is required.',
    });
  });

  it('rejects handshake when the session was revoked by logout', async () => {
    const context = await register(
      `revoked-handshake.${randomUUID()}@example.com`,
      'Revoked Handshake',
    );
    const staleToken = context.accessToken;
    await api()
      .post('/auth/logout')
      .set(authIntent)
      .set('Cookie', context.refreshCookie)
      .expect(204);
    await expect(connectionError({ auth: { token: staleToken } })).resolves.toMatchObject({
      message: 'Authentication is required.',
    });
  });

  it('rejects operationId reuse with different payload', async () => {
    const { documentId } = await createDocument(owner, true);
    const ownerSocket = await connect(owner.accessToken);
    const editorSocket = await connect(editor.accessToken);
    await emitAck<JoinAck>(ownerSocket, 'document:join', { documentId });
    await emitAck<JoinAck>(editorSocket, 'document:join', { documentId });

    const operationId = randomUUID();
    const first = moveCommand(documentId, 0, 'person', 512, 72);
    (first as { operationId: string }).operationId = operationId;
    const accepted = await emitAck<CommandAck>(ownerSocket, 'document:command', first);
    expect(accepted).toMatchObject({ ok: true, operationId, revision: 1 });

    const conflicting = moveCommand(documentId, 0, 'person', 640, 96);
    (conflicting as { operationId: string }).operationId = operationId;
    await expect(
      emitAck<FailureAck>(ownerSocket, 'document:command', conflicting),
    ).resolves.toMatchObject({ ok: false, code: 'OPERATION_ID_REUSED', operationId });
    expect(await prisma.umlDocument.findUniqueOrThrow({ where: { id: documentId } })).toMatchObject(
      { revision: 1 },
    );
    expect(await prisma.documentOperation.count({ where: { documentId } })).toBe(1);
  });

  it('counts two tabs of the same user separately', async () => {
    const { documentId } = await createDocument(owner, true);
    const firstTab = await connect(owner.accessToken);
    const secondTab = await connect(owner.accessToken);
    await emitAck<JoinAck>(firstTab, 'document:join', { documentId });
    const secondJoin = await emitAck<JoinAck>(secondTab, 'document:join', { documentId });
    expect(secondJoin.participants.filter((p) => p.userId === owner.id)).toHaveLength(2);
    expect(new Set(secondJoin.participants.map((p) => p.socketId)).size).toBe(2);
  });

  it('releases element locks when the holder disconnects', async () => {
    const { documentId } = await createDocument(owner, true);
    const ownerSocket = await connect(owner.accessToken);
    const editorSocket = await connect(editor.accessToken);
    await emitAck<JoinAck>(ownerSocket, 'document:join', { documentId });
    await emitAck<JoinAck>(editorSocket, 'document:join', { documentId });
    const lock = await emitAck<LockAck>(ownerSocket, 'lock:acquire', {
      documentId,
      elementId: 'person',
    });
    expect(lock).toMatchObject({ ok: true });
    ownerSocket.disconnect();
    await waitForCondition(
      () =>
        app.get(CollaborationPresenceStore).list(documentId).length === 1 &&
        app.get(CollaborationPresenceStore).list(documentId)[0]!.userId === editor.id,
      'presence cleanup after disconnect',
    );
    await expect(
      emitAck<LockAck>(editorSocket, 'lock:acquire', { documentId, elementId: 'person' }),
    ).resolves.toMatchObject({ ok: true, lock: { elementId: 'person' } });
  });

  it('demands resync when rejoining with a stale revision', async () => {
    const { documentId } = await createDocument(owner, true);
    const ownerSocket = await connect(owner.accessToken);
    await emitAck<JoinAck>(ownerSocket, 'document:join', { documentId });
    const accepted = await emitAck<CommandAck>(
      ownerSocket,
      'document:command',
      moveCommand(documentId, 0, 'person', 512, 72),
    );
    expect(accepted).toMatchObject({ ok: true, revision: 1 });
    ownerSocket.disconnect();
    const rejoined = await connect(owner.accessToken);
    const staleJoin = await emitAck<JoinAck>(rejoined, 'document:join', {
      documentId,
      knownRevision: 0,
    });
    expect(staleJoin).toMatchObject({
      ok: true,
      revision: 1,
      resyncRequired: true,
      canonicalModel: expect.objectContaining({ schemaVersion: '0.1.0' }),
    });
  });
});
