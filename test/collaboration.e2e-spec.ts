import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { io, type Socket } from 'socket.io-client';
import request = require('supertest');
import { createConfiguredApp } from '../src/bootstrap';
import { PrismaService } from '../src/modules/database/prisma.service';

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
) as Record<string, unknown>;
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
    process.env.COLLABORATION_COMMAND_LIMIT = '2';
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

  it('removes an idle member before delivering the next room broadcast', async () => {
    const { projectId, documentId } = await createDocument(owner, true);
    const ownerSocket = await connect(owner.accessToken);
    const editorSocket = await connect(editor.accessToken);
    await emitAck<JoinAck>(ownerSocket, 'document:join', { documentId });
    await emitAck<JoinAck>(editorSocket, 'document:join', { documentId });

    await api()
      .delete(`/projects/${projectId}/members/${editor.id}`)
      .set(bearer(owner))
      .expect(204);
    const accessRevoked = waitForEvent<FailureAck & { documentId: string }>(
      editorSocket,
      'document:access-revoked',
    );
    const noPresence = waitForNoEvent(editorSocket, 'presence:changed');
    await expect(
      emitAck<{ ok: true }>(ownerSocket, 'presence:update', {
        documentId,
        selection: ['person'],
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(accessRevoked).resolves.toMatchObject({
      ok: false,
      code: 'FORBIDDEN',
      documentId,
    });
    await expect(noPresence).resolves.toBeUndefined();
    await expect(
      emitAck<FailureAck>(
        editorSocket,
        'document:command',
        moveCommand(documentId, 0, 'person', 510, 90),
      ),
    ).resolves.toMatchObject({ ok: false, code: 'NOT_FOUND' });
  });

  it('enforces locks, publishes presence, and cleans state when a socket disconnects', async () => {
    const { documentId } = await createDocument(owner, true);
    const ownerSocket = await connect(owner.accessToken);
    await emitAck<JoinAck>(ownerSocket, 'document:join', { documentId });

    const joinedPresence = waitForEvent<PresenceChanged>(ownerSocket, 'presence:changed');
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

    await prisma.authSession.updateMany({
      where: { userId: revoked.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    const revokedEvent = waitForEvent<FailureAck>(socket, 'session:revoked');
    const disconnected = waitForEvent<string>(socket, 'disconnect');
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
});
