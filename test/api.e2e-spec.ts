import type { INestApplication } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ProjectRole } from '@prisma/client';
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
  tokenType: string;
  expiresIn: number;
  user: { id: string; email: string; displayName: string };
}

function loadFixture(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(resolve(process.cwd(), `contracts/fixtures/${name}`), 'utf8'),
  ) as Record<string, unknown>;
}

function cloneModel(model: Record<string, unknown>, diagramName: string): Record<string, unknown> {
  const clone = structuredClone(model);
  (clone.diagram as Record<string, unknown>).name = diagramName;
  return clone;
}

const bearer = (context: AuthContext) => ({ Authorization: `Bearer ${context.accessToken}` });
const authIntent = { 'X-Auth-Intent': '1' };
let testClientAddress = 10;
const nextClientAddress = () => `198.51.100.${testClientAddress++}`;

function extractSetCookies(response: request.Response): string[] {
  const rawHeader = response.headers['set-cookie'] as unknown;
  if (Array.isArray(rawHeader)) {
    return rawHeader.filter((value): value is string => typeof value === 'string');
  }
  return typeof rawHeader === 'string' ? [rawHeader] : [];
}

function extractRefreshCookie(response: request.Response): string {
  const cookie = extractSetCookies(response).find((value) => value.startsWith('uml_refresh_test='));
  if (!cookie) {
    throw new Error('Expected refresh cookie was not returned.');
  }
  return cookie.split(';', 1)[0] as string;
}

function binaryResponseParser(
  response: request.Response,
  callback: (error: Error | null, body: Buffer) => void,
): void {
  const chunks: Buffer[] = [];
  const stream = response as unknown as NodeJS.ReadableStream;
  stream.on('data', (chunk: Buffer | string) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
  stream.on('error', (error: Error) => callback(error, Buffer.alloc(0)));
  stream.on('end', () => callback(null, Buffer.concat(chunks)));
}

describe('Authentication, projects and UML persistence (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let owner: AuthContext;
  let editor: AuthContext;
  let outsider: AuthContext;
  const validModel = loadFixture('valid-uml-model.json');
  const invalidModel = loadFixture('invalid-uml-model.json');

  const api = () => request(app.getHttpServer());

  async function register(
    email: string,
    displayName: string,
    password = 'correct horse battery staple',
  ): Promise<AuthContext> {
    const response = await api()
      .post('/auth/register')
      .set(authIntent)
      .set('X-Forwarded-For', nextClientAddress())
      .send({ email, displayName, password })
      .expect(201);
    const body = response.body as AuthBody;
    return {
      id: body.user.id,
      email: body.user.email,
      accessToken: body.accessToken,
      refreshCookie: extractRefreshCookie(response),
    };
  }

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    const configured = await createConfiguredApp();
    app = configured.app;
    await app.init();
    prisma = app.get(PrismaService);
    await prisma.project.deleteMany();
    await prisma.authSession.deleteMany();
    await prisma.user.deleteMany();

    owner = await register('owner@example.com', 'Owner');
    editor = await register('editor@example.com', 'Editor');
    outsider = await register('outsider@example.com', 'Outsider');
  });

  afterAll(async () => {
    await prisma.project.deleteMany();
    await prisma.authSession.deleteMany();
    await prisma.user.deleteMany();
    await app.close();
  });

  describe('authentication lifecycle', () => {
    it('registers with normalized email, hashes the password, and returns no secret fields', async () => {
      const response = await api()
        .post('/auth/register')
        .set(authIntent)
        .set('X-Forwarded-For', nextClientAddress())
        .send({
          email: '  Mixed.Case@Example.com ',
          displayName: '  Mixed Case  ',
          password: 'a sufficiently long password',
        })
        .expect(201);
      const body = response.body as AuthBody;

      expect(body.user).toMatchObject({
        email: 'mixed.case@example.com',
        displayName: 'Mixed Case',
      });
      expect(body.tokenType).toBe('Bearer');
      expect(body.accessToken).toEqual(expect.any(String));
      expect(JSON.stringify(body)).not.toMatch(/passwordHash|tokenHash|refreshToken/i);

      const setCookie = extractSetCookies(response)[0] as string;
      expect(setCookie).toContain('HttpOnly');
      expect(setCookie).toContain('SameSite=Strict');
      expect(setCookie).toContain('Path=/auth');
      expect(setCookie).not.toContain('Secure');

      const stored = await prisma.user.findUniqueOrThrow({
        where: { email: 'mixed.case@example.com' },
        select: { passwordHash: true },
      });
      expect(stored.passwordHash).toMatch(/^\$argon2id\$/);
      expect(stored.passwordHash).not.toContain('a sufficiently long password');
    });

    it('rejects a duplicate email without exposing stored data', async () => {
      const response = await api()
        .post('/auth/register')
        .set(authIntent)
        .set('X-Forwarded-For', nextClientAddress())
        .send({
          email: 'OWNER@example.com',
          displayName: 'Duplicate',
          password: 'another sufficiently long password',
        })
        .expect(409);

      expect(response.body).toMatchObject({
        message: 'Unable to create account with the provided credentials.',
      });
      expect(JSON.stringify(response.body)).not.toMatch(/passwordHash|tokenHash/i);
    });

    it('uses the same login error for wrong passwords and unknown emails', async () => {
      const wrongPassword = await api()
        .post('/auth/login')
        .set(authIntent)
        .send({ email: owner.email, password: 'wrong password' })
        .expect(401);
      const unknownEmail = await api()
        .post('/auth/login')
        .set(authIntent)
        .send({ email: 'missing@example.com', password: 'wrong password' })
        .expect(401);

      expect(wrongPassword.body).toEqual(unknownEmail.body);
      expect(wrongPassword.body).toMatchObject({ message: 'Invalid email or password.' });
    });

    it('logs in and resolves the authenticated user without hashes', async () => {
      const login = await api()
        .post('/auth/login')
        .set(authIntent)
        .send({ email: ' OWNER@EXAMPLE.COM ', password: 'correct horse battery staple' })
        .expect(200);
      const body = login.body as AuthBody;

      expect(body.user).toMatchObject({ id: owner.id, email: owner.email });
      const me = await api()
        .get('/auth/me')
        .set('Authorization', `Bearer ${body.accessToken}`)
        .expect(200);
      expect(me.body).toEqual(body.user);
      expect(JSON.stringify(me.body)).not.toMatch(/session|hash|token|password/i);
    });

    it('rotates refresh tokens atomically and rejects replay', async () => {
      const context = await register('rotation@example.com', 'Rotation');
      const oldSession = await prisma.authSession.findFirstOrThrow({
        where: { userId: context.id },
        select: { id: true, tokenHash: true },
      });

      const rotated = await api()
        .post('/auth/refresh')
        .set('Cookie', context.refreshCookie)
        .set(authIntent)
        .expect(200);
      const nextCookie = extractRefreshCookie(rotated);
      const currentSession = await prisma.authSession.findUniqueOrThrow({
        where: { id: oldSession.id },
        select: { tokenHash: true },
      });
      expect(currentSession.tokenHash).toMatch(/^[0-9a-f]{64}$/);
      expect(currentSession.tokenHash).not.toBe(oldSession.tokenHash);

      await api()
        .post('/auth/refresh')
        .set('Cookie', context.refreshCookie)
        .set(authIntent)
        .expect(401);

      const accessToken = (rotated.body as AuthBody).accessToken;
      const replayedSession = await prisma.authSession.findUniqueOrThrow({
        where: { id: oldSession.id },
        select: { revokedAt: true },
      });
      expect(replayedSession.revokedAt).toBeInstanceOf(Date);
      await api().get('/auth/me').set('Authorization', `Bearer ${accessToken}`).expect(401);
      await api().post('/auth/refresh').set('Cookie', nextCookie).set(authIntent).expect(401);
    });

    it('keeps versioned refresh replay detection bounded across repeated rotations', async () => {
      const context = await register('bounded.rotation@example.com', 'Bounded Rotation');
      const staleCookie = context.refreshCookie;
      const sessionId = staleCookie.split('=', 2)[1]!.split('.', 1)[0]!;
      let currentCookie = staleCookie;

      for (let rotation = 0; rotation < 3; rotation += 1) {
        const response = await api()
          .post('/auth/refresh')
          .set('Cookie', currentCookie)
          .set(authIntent)
          .expect(200);
        currentCookie = extractRefreshCookie(response);
      }

      expect(await prisma.consumedRefreshToken.count({ where: { sessionId } })).toBe(0);
      await api().post('/auth/refresh').set('Cookie', staleCookie).set(authIntent).expect(401);
      expect(
        await prisma.authSession.findUniqueOrThrow({
          where: { id: sessionId },
          select: { revokedAt: true },
        }),
      ).toEqual({ revokedAt: expect.any(Date) });
    });

    it('rejects tampered versioned refresh tokens without revoking the active session', async () => {
      const context = await register('tampered.rotation@example.com', 'Tampered Rotation');
      const [cookieName, refreshToken] = context.refreshCookie.split('=', 2);
      const [sessionId, sequence, signature] = refreshToken!.split('.');
      const replacement = signature!.endsWith('A') ? 'B' : 'A';
      const tamperedCookie = `${cookieName}=${sessionId}.${sequence}.${signature!.slice(0, -1)}${replacement}`;

      await api().post('/auth/refresh').set('Cookie', tamperedCookie).set(authIntent).expect(401);
      await api().get('/auth/me').set(bearer(context)).expect(200);
      expect(
        await prisma.authSession.findUniqueOrThrow({
          where: { id: sessionId },
          select: { revokedAt: true },
        }),
      ).toEqual({ revokedAt: null });
    });

    it('rotates legacy refresh tokens once before retiring their consumed-token history', async () => {
      const context = await register('legacy.rotation@example.com', 'Legacy Rotation');
      const sessionId = randomUUID();
      const legacyToken = `${sessionId}.${randomBytes(32).toString('base64url')}`;
      await prisma.authSession.create({
        data: {
          id: sessionId,
          userId: context.id,
          tokenHash: createHash('sha256').update(legacyToken, 'utf8').digest('hex'),
          expiresAt: new Date(Date.now() + 60_000),
        },
      });

      const response = await api()
        .post('/auth/refresh')
        .set('Cookie', `uml_refresh_test=${legacyToken}`)
        .set(authIntent)
        .expect(200);
      expect(extractRefreshCookie(response).split('=', 2)[1]!.split('.')).toHaveLength(3);
      expect(await prisma.consumedRefreshToken.count({ where: { sessionId } })).toBe(1);
      await api()
        .post('/auth/refresh')
        .set('Cookie', `uml_refresh_test=${legacyToken}`)
        .set(authIntent)
        .expect(401);
      expect(await prisma.consumedRefreshToken.count({ where: { sessionId } })).toBe(0);
    });

    it('handles concurrent refresh reuse without a server error and revokes the session', async () => {
      const context = await register('concurrent.rotation@example.com', 'Concurrent Rotation');
      const responses = await Promise.all([
        api().post('/auth/refresh').set('Cookie', context.refreshCookie).set(authIntent),
        api().post('/auth/refresh').set('Cookie', context.refreshCookie).set(authIntent),
      ]);

      expect(responses.map((response) => response.status).toSorted()).toEqual([200, 401]);
      const successfulResponse = responses.find((response) => response.status === 200);
      expect(successfulResponse).toBeDefined();
      const session = await prisma.authSession.findFirstOrThrow({
        where: { userId: context.id },
        select: { revokedAt: true },
      });
      expect(session.revokedAt).toBeInstanceOf(Date);

      const body = successfulResponse!.body as AuthBody;
      await api().get('/auth/me').set('Authorization', `Bearer ${body.accessToken}`).expect(401);
      await api()
        .post('/auth/refresh')
        .set('Cookie', extractRefreshCookie(successfulResponse!))
        .set(authIntent)
        .expect(401);
    });

    it('revokes the live access and refresh tokens on logout', async () => {
      const context = await register('logout@example.com', 'Logout');
      await api()
        .post('/auth/logout')
        .set('Cookie', context.refreshCookie)
        .set(authIntent)
        .expect(204);
      await api().get('/auth/me').set(bearer(context)).expect(401);
      await api()
        .post('/auth/refresh')
        .set('Cookie', context.refreshCookie)
        .set(authIntent)
        .expect(401);
    });

    it('revokes a session when logout races a prior versioned refresh token', async () => {
      const context = await register('stale.logout@example.com', 'Stale Logout');
      const rotated = await api()
        .post('/auth/refresh')
        .set('Cookie', context.refreshCookie)
        .set(authIntent)
        .expect(200);
      const nextCookie = extractRefreshCookie(rotated);

      await api()
        .post('/auth/logout')
        .set('Cookie', context.refreshCookie)
        .set(authIntent)
        .expect(204);
      await api()
        .get('/auth/me')
        .set('Authorization', `Bearer ${(rotated.body as AuthBody).accessToken}`)
        .expect(401);
      await api().post('/auth/refresh').set('Cookie', nextCookie).set(authIntent).expect(401);
    });

    it('rejects expired refresh sessions', async () => {
      const context = await register('expired@example.com', 'Expired');
      const session = await prisma.authSession.findFirstOrThrow({
        where: { userId: context.id },
        select: { id: true, createdAt: true },
      });
      await prisma.authSession.update({
        where: { id: session.id },
        data: { expiresAt: new Date(session.createdAt.getTime() + 1) },
      });

      await api()
        .post('/auth/refresh')
        .set('Cookie', context.refreshCookie)
        .set(authIntent)
        .expect(401);
    });

    it('rejects malformed refresh session UUIDs without reaching Prisma', async () => {
      const invalidUuid = 'a'.repeat(36);
      const validLengthSecret = 'b'.repeat(43);
      await api()
        .post('/auth/refresh')
        .set('Cookie', `uml_refresh_test=${invalidUuid}.${validLengthSecret}`)
        .set(authIntent)
        .expect(401);
    });

    it('requires explicit auth intent, JSON bodies, and an allowed origin', async () => {
      await api()
        .post('/auth/register')
        .send({
          email: 'csrf-register@example.com',
          displayName: 'CSRF',
          password: 'a sufficiently long password',
        })
        .expect(403);
      await api()
        .post('/auth/login')
        .send({ email: owner.email, password: 'correct horse battery staple' })
        .expect(403);
      await api()
        .post('/auth/login')
        .set(authIntent)
        .type('form')
        .send({ email: owner.email, password: 'correct horse battery staple' })
        .expect(400);
      await api().post('/auth/refresh').set('Cookie', owner.refreshCookie).expect(403);
      await api()
        .post('/auth/refresh')
        .set('Cookie', owner.refreshCookie)
        .set(authIntent)
        .set('Origin', 'https://attacker.example')
        .expect(403);
    });
  });

  describe('project and member authorization', () => {
    let projectId: string;

    beforeAll(async () => {
      const project = await api()
        .post('/projects')
        .set(bearer(owner))
        .send({ name: 'Commerce', description: 'Authorized project' })
        .expect(201);
      projectId = project.body.id as string;
      await api()
        .post(`/projects/${projectId}/members`)
        .set(bearer(owner))
        .send({ userId: editor.id, email: editor.email })
        .expect(201);
    });

    it('creates the project and its sole OWNER in one transaction', async () => {
      const project = await prisma.project.findUniqueOrThrow({
        where: { id: projectId },
        select: { ownerId: true },
      });
      const memberships = await prisma.projectMember.findMany({ where: { projectId } });
      expect(project.ownerId).toBe(owner.id);
      expect(memberships).toHaveLength(2);
      expect(memberships.filter((member) => member.role === 'OWNER')).toEqual([
        expect.objectContaining({ userId: owner.id }),
      ]);
    });

    it('lists only projects where the actor is a member', async () => {
      const ownerProjects = await api().get('/projects').set(bearer(owner)).expect(200);
      const outsiderProjects = await api().get('/projects').set(bearer(outsider)).expect(200);

      expect(ownerProjects.body).toEqual([
        expect.objectContaining({ id: projectId, role: 'OWNER' }),
      ]);
      expect(outsiderProjects.body).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ id: projectId })]),
      );
    });

    it('returns 404 instead of exposing a project to a non-member', async () => {
      await api().get(`/projects/${projectId}`).set(bearer(outsider)).expect(404);
    });

    it('allows OWNER to manage EDITOR membership and handles duplicates', async () => {
      const members = await api()
        .get(`/projects/${projectId}/members`)
        .set(bearer(owner))
        .expect(200);
      expect(members.body).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ userId: owner.id, role: 'OWNER' }),
          expect.objectContaining({ userId: editor.id, role: 'EDITOR' }),
        ]),
      );

      await api()
        .post(`/projects/${projectId}/members`)
        .set(bearer(owner))
        .send({ userId: editor.id, email: editor.email })
        .expect(409);

      await api()
        .post(`/projects/${projectId}/members`)
        .set(bearer(owner))
        .send({ userId: outsider.id, email: editor.email })
        .expect(404);

      await api()
        .post(`/projects/${projectId}/members`)
        .set(bearer(owner))
        .send({ userId: outsider.id, email: outsider.email, role: ProjectRole.OWNER })
        .expect(400);

      await api()
        .post(`/projects/${projectId}/members`)
        .set(bearer(owner))
        .send({ userId: outsider.id, email: outsider.email, role: null })
        .expect(400);
    });

    it('prevents EDITOR from administering members or the project', async () => {
      await api().get(`/projects/${projectId}/members`).set(bearer(editor)).expect(403);
      await api()
        .patch(`/projects/${projectId}`)
        .set(bearer(editor))
        .send({ name: 'Unauthorized rename' })
        .expect(403);
      await api().delete(`/projects/${projectId}`).set(bearer(editor)).expect(403);
    });

    it('rejects null for required project names instead of returning 500', async () => {
      await api()
        .patch(`/projects/${projectId}`)
        .set(bearer(owner))
        .send({ name: null })
        .expect(400);
    });

    it('prevents removing the OWNER and enforces one OWNER in PostgreSQL', async () => {
      await api()
        .delete(`/projects/${projectId}/members/${owner.id}`)
        .set(bearer(owner))
        .expect(403);

      await expect(
        prisma.projectMember.create({
          data: { projectId, userId: outsider.id, role: 'OWNER' },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });

      await expect(
        prisma.projectMember.delete({
          where: { projectId_userId: { projectId, userId: owner.id } },
        }),
      ).rejects.toBeDefined();
      await expect(
        prisma.projectMember.update({
          where: { projectId_userId: { projectId, userId: owner.id } },
          data: { role: 'EDITOR' },
        }),
      ).rejects.toBeDefined();
      expect(
        await prisma.projectMember.findUnique({
          where: { projectId_userId: { projectId, userId: owner.id } },
        }),
      ).toMatchObject({ role: 'OWNER' });

      const destinationProjectId = randomUUID();
      await expect(
        prisma.$transaction(async (transaction) => {
          await transaction.project.create({
            data: {
              id: destinationProjectId,
              name: 'Owner move destination',
              ownerId: owner.id,
            },
          });
          await transaction.projectMember.update({
            where: { projectId_userId: { projectId, userId: owner.id } },
            data: { projectId: destinationProjectId },
          });
        }),
      ).rejects.toBeDefined();
      expect(await prisma.project.findUnique({ where: { id: destinationProjectId } })).toBeNull();
      expect(
        await prisma.projectMember.findUnique({
          where: { projectId_userId: { projectId, userId: owner.id } },
        }),
      ).toMatchObject({ role: 'OWNER' });
    });

    it('lets OWNER add and remove a registered EDITOR', async () => {
      const temporary = await register('temporary.editor@example.com', 'Temporary Editor');
      await api()
        .post(`/projects/${projectId}/members`)
        .set(bearer(owner))
        .send({ userId: temporary.id, email: temporary.email })
        .expect(201);
      await api()
        .delete(`/projects/${projectId}/members/${temporary.id}`)
        .set(bearer(owner))
        .expect(204);
      await api().get(`/projects/${projectId}`).set(bearer(temporary)).expect(404);
    });

    describe('UML document persistence', () => {
      let documentId: string;
      let otherProjectId: string;
      let otherDocumentId: string;

      beforeAll(async () => {
        const document = await api()
          .post(`/projects/${projectId}/documents`)
          .set(bearer(owner))
          .send({ name: 'Domain model', canonicalModel: validModel })
          .expect(201);
        documentId = document.body.id as string;

        const otherProject = await api()
          .post('/projects')
          .set(bearer(outsider))
          .send({ name: 'Private outsider project' })
          .expect(201);
        otherProjectId = otherProject.body.id as string;
        const otherDocument = await api()
          .post(`/projects/${otherProjectId}/documents`)
          .set(bearer(outsider))
          .send({ name: 'Private model', canonicalModel: validModel })
          .expect(201);
        otherDocumentId = otherDocument.body.id as string;
      });

      it('stores only a validated canonical model and creates revision zero', async () => {
        const response = await api()
          .get(`/projects/${projectId}/documents/${documentId}`)
          .set(bearer(editor))
          .expect(200);

        expect(response.body).toMatchObject({
          id: documentId,
          projectId,
          schemaVersion: '0.1.0',
          revision: 0,
          createdById: owner.id,
          updatedById: owner.id,
          canonicalModel: {
            schemaVersion: '0.1.0',
            project: { id: `project_${projectId.replaceAll('-', '')}` },
            diagram: { id: `diagram_${documentId.replaceAll('-', '')}` },
            metadata: { revision: 0 },
          },
        });
        expect(JSON.stringify(response.body.canonicalModel)).not.toMatch(/"nodes"|"edges"/i);
        expect(await prisma.documentRevision.count({ where: { documentId, revision: 0 } })).toBe(1);
      });

      it('rejects invalid canonical JSON and duplicate document names', async () => {
        await api()
          .post(`/projects/${projectId}/documents`)
          .set(bearer(editor))
          .send({ name: 'Invalid model', canonicalModel: invalidModel })
          .expect(400);
        await api()
          .post(`/projects/${projectId}/documents`)
          .set(bearer(editor))
          .send({ name: 'Domain model', canonicalModel: validModel })
          .expect(409);
      });

      it('rejects a structurally valid graph with dangling semantic references', async () => {
        const danglingModel = structuredClone(validModel);
        const diagram = danglingModel.diagram as {
          relationships: Array<{ target: { elementId: string } }>;
        };
        diagram.relationships[0]!.target.elementId = 'missing_classifier';

        await api()
          .post(`/projects/${projectId}/documents`)
          .set(bearer(editor))
          .send({ name: 'Dangling model', canonicalModel: danglingModel })
          .expect(400);
      });

      it('rejects null names and documents both update conflict variants', async () => {
        await api()
          .put(`/projects/${projectId}/documents/${documentId}`)
          .set(bearer(editor))
          .send({
            name: null,
            expectedRevision: 0,
            canonicalModel: validModel,
          })
          .expect(400);

        await api()
          .post(`/projects/${projectId}/documents`)
          .set(bearer(owner))
          .send({ name: 'Reserved document name', canonicalModel: validModel })
          .expect(201);
        const duplicateName = await api()
          .put(`/projects/${projectId}/documents/${documentId}`)
          .set(bearer(editor))
          .send({
            name: 'Reserved document name',
            expectedRevision: 0,
            canonicalModel: validModel,
          })
          .expect(409);
        expect(duplicateName.body).toMatchObject({ statusCode: 409, error: 'Conflict' });
      });

      it('prevents cross-project and non-member document access', async () => {
        await api()
          .get(`/projects/${projectId}/documents/${otherDocumentId}`)
          .set(bearer(owner))
          .expect(404);
        await api()
          .get(`/projects/${projectId}/documents/${documentId}`)
          .set(bearer(outsider))
          .expect(404);
      });

      it('updates with the expected revision and increments exactly once', async () => {
        const response = await api()
          .put(`/projects/${projectId.toUpperCase()}/documents/${documentId.toUpperCase()}`)
          .set(bearer(editor))
          .send({
            expectedRevision: 0,
            canonicalModel: cloneModel(validModel, 'Updated by editor'),
          })
          .expect(200);

        expect(response.body).toMatchObject({
          revision: 1,
          updatedById: editor.id,
          canonicalModel: {
            project: { id: `project_${projectId.replaceAll('-', '')}` },
            diagram: { id: `diagram_${documentId.replaceAll('-', '')}` },
            metadata: { revision: 1 },
          },
        });
        expect(await prisma.documentRevision.count({ where: { documentId } })).toBe(2);
      });

      it('allows only one of two competing updates for the same revision', async () => {
        const attempts = await Promise.all([
          api()
            .put(`/projects/${projectId}/documents/${documentId}`)
            .set(bearer(owner))
            .send({
              expectedRevision: 1,
              canonicalModel: cloneModel(validModel, 'Competing update A'),
            }),
          api()
            .put(`/projects/${projectId}/documents/${documentId}`)
            .set(bearer(editor))
            .send({
              expectedRevision: 1,
              canonicalModel: cloneModel(validModel, 'Competing update B'),
            }),
        ]);

        expect(attempts.map((response) => response.status).toSorted()).toEqual([200, 409]);
        const conflict = attempts.find((response) => response.status === 409);
        expect(conflict?.body).toMatchObject({
          message: 'Document revision conflict.',
          currentRevision: 2,
        });

        const persisted = await api()
          .get(`/projects/${projectId}/documents/${documentId}`)
          .set(bearer(owner))
          .expect(200);
        expect(persisted.body.revision).toBe(2);
        const revisions = await prisma.documentRevision.findMany({
          where: { documentId },
          select: { revision: true, canonicalModel: true },
          orderBy: { revision: 'asc' },
        });
        expect(revisions).toHaveLength(3);
        expect(revisions.map((revision) => revision.revision)).toEqual([0, 1, 2]);
        for (const revision of revisions) {
          expect(revision.canonicalModel).toMatchObject({
            project: { id: `project_${projectId.replaceAll('-', '')}` },
            diagram: { id: `diagram_${documentId.replaceAll('-', '')}` },
            metadata: { revision: revision.revision },
          });
        }
      });

      it('exports the persisted snapshot deterministically without mutating it', async () => {
        const before = await prisma.umlDocument.findUniqueOrThrow({
          where: { id: documentId },
          select: { canonicalModel: true, revision: true, updatedAt: true },
        });
        const exportPath = `/projects/${projectId}/documents/${documentId}/exports/spring-boot`;
        const first = await api()
          .post(exportPath)
          .set(bearer(owner))
          .send({ expectedRevision: before.revision })
          .buffer(true)
          .parse(binaryResponseParser)
          .expect(200);
        const second = await api()
          .post(exportPath)
          .set(bearer(owner))
          .send({ expectedRevision: before.revision })
          .buffer(true)
          .parse(binaryResponseParser)
          .expect(200);

        expect(first.headers['content-type']).toMatch(/^application\/zip/);
        expect(first.headers['content-disposition']).toMatch(
          /attachment; filename="[a-z0-9.-]+-spring-boot-r\d+\.zip"/,
        );
        expect(first.headers['cache-control']).toBe('private, no-store');
        expect(first.headers['x-content-type-options']).toBe('nosniff');
        expect(first.headers['x-document-revision']).toBe(String(before.revision));
        expect(first.headers['x-generator-version']).toBeDefined();
        expect(Buffer.isBuffer(first.body)).toBe(true);
        expect(first.headers['content-length']).toBe(String(first.body.byteLength));
        expect(first.body.equals(second.body as Buffer)).toBe(true);
        expect(first.body.includes(Buffer.from('generation-manifest.json'))).toBe(true);
        expect(first.body.includes(Buffer.from('openapi/generated-api.openapi.json'))).toBe(true);
        expect(
          first.body.includes(Buffer.from('postman/generated-api.postman_collection.json')),
        ).toBe(true);
        expect(await prisma.umlDocument.findUnique({ where: { id: documentId } })).toMatchObject(
          before,
        );
      });

      it('requires current revision, exporter membership, and project-scoped documents', async () => {
        const persisted = await prisma.umlDocument.findUniqueOrThrow({
          where: { id: documentId },
          select: { revision: true },
        });
        const exportPath = `/projects/${projectId}/documents/${documentId}/exports/spring-boot`;
        const stale = await api()
          .post(exportPath)
          .set(bearer(owner))
          .send({ expectedRevision: persisted.revision - 1 })
          .expect(409);
        expect(stale.headers['content-type']).toMatch(/^application\/json/);
        expect(stale.body).toMatchObject({
          message: 'Document revision conflict.',
          currentRevision: persisted.revision,
        });

        const editorExport = await api()
          .post(exportPath)
          .set(bearer(editor))
          .send({ expectedRevision: persisted.revision })
          .buffer(true)
          .parse(binaryResponseParser)
          .expect(200);
        expect(editorExport.body.subarray(0, 2).toString('utf8')).toBe('PK');

        await api()
          .post(exportPath)
          .set(bearer(outsider))
          .send({ expectedRevision: persisted.revision })
          .expect(404);

        await api()
          .post(`/projects/${otherProjectId}/documents/${documentId}/exports/spring-boot`)
          .set(bearer(outsider))
          .send({ expectedRevision: persisted.revision })
          .expect(404);
      });

      it('rejects revoked sessions and corrupted persisted snapshots without a ZIP', async () => {
        const revokedExporter = await register('revoked.export@example.com', 'Revoked Exporter');
        await api()
          .post(`/projects/${projectId}/members`)
          .set(bearer(owner))
          .send({
            userId: revokedExporter.id,
            email: revokedExporter.email,
            role: ProjectRole.EDITOR,
          })
          .expect(201);
        await api()
          .post('/auth/logout')
          .set('Cookie', revokedExporter.refreshCookie)
          .set(authIntent)
          .expect(204);
        await api()
          .post(`/projects/${projectId}/documents/${documentId}/exports/spring-boot`)
          .set(bearer(revokedExporter))
          .send({ expectedRevision: 2 })
          .expect(401);

        const corrupted = await api()
          .post(`/projects/${projectId}/documents`)
          .set(bearer(owner))
          .send({ name: 'Corrupted persisted snapshot', canonicalModel: validModel })
          .expect(201);
        const corruptedId = corrupted.body.id as string;
        await prisma.umlDocument.update({
          where: { id: corruptedId },
          data: { canonicalModel: { unexpected: true } as never },
        });
        const invalidSnapshot = await api()
          .post(`/projects/${projectId}/documents/${corruptedId}/exports/spring-boot`)
          .set(bearer(owner))
          .send({ expectedRevision: 0 })
          .expect(400);
        expect(invalidSnapshot.headers['content-type']).not.toMatch(/^application\/zip/);
      });

      it('rejects export payloads that attempt to supply untrusted generation input', async () => {
        const persisted = await prisma.umlDocument.findUniqueOrThrow({
          where: { id: documentId },
          select: { revision: true },
        });
        await api()
          .post(`/projects/${projectId}/documents/${documentId}/exports/spring-boot`)
          .set(bearer(owner))
          .send({
            expectedRevision: persisted.revision,
            canonicalModel: validModel,
            options: { artifactId: '../escape' },
          })
          .expect(400);
      });

      it('defines deletion as an OWNER-or-EDITOR document permission', async () => {
        const disposable = await api()
          .post(`/projects/${projectId}/documents`)
          .set(bearer(owner))
          .send({ name: 'Disposable', canonicalModel: validModel })
          .expect(201);
        const disposableId = disposable.body.id as string;

        await api()
          .delete(`/projects/${projectId}/documents/${disposableId}`)
          .set(bearer(editor))
          .expect(204);
        expect(await prisma.umlDocument.findUnique({ where: { id: disposableId } })).toBeNull();
        expect(await prisma.documentRevision.count({ where: { documentId: disposableId } })).toBe(
          0,
        );
        await api()
          .post(`/projects/${projectId}/documents/${disposableId}/exports/spring-boot`)
          .set(bearer(editor))
          .send({ expectedRevision: 0 })
          .expect(404);
      });

      it('deletes a project, memberships, documents and revisions atomically', async () => {
        const cascadeProject = await api()
          .post('/projects')
          .set(bearer(owner))
          .send({ name: 'Cascade test' })
          .expect(201);
        const cascadeProjectId = cascadeProject.body.id as string;
        const cascadeDocument = await api()
          .post(`/projects/${cascadeProjectId}/documents`)
          .set(bearer(owner))
          .send({ name: 'Cascade document', canonicalModel: validModel })
          .expect(201);
        const cascadeDocumentId = cascadeDocument.body.id as string;

        await api().delete(`/projects/${cascadeProjectId}`).set(bearer(owner)).expect(204);
        expect(await prisma.project.findUnique({ where: { id: cascadeProjectId } })).toBeNull();
        expect(await prisma.projectMember.count({ where: { projectId: cascadeProjectId } })).toBe(
          0,
        );
        expect(await prisma.umlDocument.count({ where: { projectId: cascadeProjectId } })).toBe(0);
        expect(
          await prisma.documentRevision.count({ where: { documentId: cascadeDocumentId } }),
        ).toBe(0);
      });
    });
  });
});
