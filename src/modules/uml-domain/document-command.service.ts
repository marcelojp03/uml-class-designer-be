import { BadRequestException, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Prisma, ProjectRole } from '@prisma/client';
import { AccessTokenVerifierService } from '../auth/access-token-verifier.service';
import { PrismaService } from '../database/prisma.service';
import { CanonicalModelValidator, UML_SCHEMA_VERSION } from './canonical-model.validator';
import { CollaborationLockStore } from './collaboration-lock.store';
import type {
  CanonicalUmlModel,
  CollaborationErrorCode,
  CollaborationIdentity,
  DocumentCommandPayload,
  UmlCommand,
} from './collaboration.types';
import { UmlCommandExecutionError, UmlCommandExecutor } from './uml-command.executor';

const COLLABORATION_ROLES = [ProjectRole.OWNER, ProjectRole.EDITOR];

export interface AuthorizedDocument {
  id: string;
  projectId: string;
  revision: number;
  canonicalModel: CanonicalUmlModel;
}

export interface DocumentBroadcastAuthorization {
  documentExists: boolean;
  activeSessionKeys: Set<string>;
  authorizedUserIds: Set<string>;
}

interface ExistingOperation {
  actorId: string;
  commandFingerprint: string;
  resultingRevision: number;
  committedAt: Date;
  broadcastedAt: Date | null;
}

export interface ProcessedDocumentCommand {
  operationId: string;
  documentId: string;
  baseRevision: number;
  revision: number;
  committedAt: string;
  command: UmlCommand;
  idempotent: boolean;
  requiresBroadcast: boolean;
  activeElementIds: string[];
}

export class CollaborationOperationError extends Error {
  constructor(
    readonly code: CollaborationErrorCode,
    readonly currentRevision?: number,
  ) {
    super('The collaboration operation could not be completed.');
    this.name = 'CollaborationOperationError';
  }
}

@Injectable()
export class DocumentCommandService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accessTokenVerifier: AccessTokenVerifierService,
    private readonly canonicalValidator: CanonicalModelValidator,
    private readonly commandExecutor: UmlCommandExecutor,
    private readonly lockStore: CollaborationLockStore,
  ) {}

  async getAuthorizedDocument(
    documentId: string,
    userId: string,
  ): Promise<AuthorizedDocument | null> {
    const document = await this.prisma.umlDocument.findFirst({
      where: {
        id: documentId,
        project: {
          members: { some: { userId, role: { in: COLLABORATION_ROLES } } },
        },
      },
      select: { id: true, projectId: true, revision: true, canonicalModel: true },
    });
    return document ? this.toAuthorizedDocument(document) : null;
  }

  async getCurrentDocument(documentId: string): Promise<AuthorizedDocument | null> {
    const document = await this.prisma.umlDocument.findUnique({
      where: { id: documentId },
      select: { id: true, projectId: true, revision: true, canonicalModel: true },
    });
    return document ? this.toAuthorizedDocument(document) : null;
  }

  async getBroadcastAuthorization(
    documentId: string,
    identities: CollaborationIdentity[],
  ): Promise<DocumentBroadcastAuthorization> {
    if (identities.length === 0) {
      return { documentExists: false, activeSessionKeys: new Set(), authorizedUserIds: new Set() };
    }
    const uniqueUserIds = [...new Set(identities.map((identity) => identity.userId))];
    const [sessions, document] = await Promise.all([
      this.prisma.authSession.findMany({
        where: {
          revokedAt: null,
          expiresAt: { gt: new Date() },
          OR: identities.map((identity) => ({
            id: identity.sessionId,
            userId: identity.userId,
          })),
        },
        select: { id: true, userId: true },
      }),
      this.prisma.umlDocument.findUnique({
        where: { id: documentId },
        select: {
          project: {
            select: {
              members: {
                where: {
                  userId: { in: uniqueUserIds },
                  role: { in: COLLABORATION_ROLES },
                },
                select: { userId: true },
              },
            },
          },
        },
      }),
    ]);
    return {
      documentExists: document !== null,
      activeSessionKeys: new Set(
        sessions.map((session) => this.sessionKey(session.userId, session.id)),
      ),
      authorizedUserIds: new Set(document?.project.members.map((member) => member.userId) ?? []),
    };
  }

  async process(
    identity: CollaborationIdentity,
    input: DocumentCommandPayload,
  ): Promise<ProcessedDocumentCommand> {
    const fingerprint = this.commandFingerprint(input.baseRevision, input.command);
    try {
      return await this.prisma.$transaction((transaction) =>
        this.processInTransaction(transaction, identity, input, fingerprint),
      );
    } catch (error: unknown) {
      if (this.isKnownUniqueConstraint(error)) {
        const duplicate = await this.findExistingForActor(identity, input, fingerprint);
        if (duplicate) {
          return duplicate;
        }
      }
      throw error;
    }
  }

  private async processInTransaction(
    transaction: Prisma.TransactionClient,
    identity: CollaborationIdentity,
    input: DocumentCommandPayload,
    fingerprint: string,
  ): Promise<ProcessedDocumentCommand> {
    const document = await this.lockCommandAuthorization(transaction, identity, input.documentId);

    const existing = await transaction.documentOperation.findUnique({
      where: {
        documentId_operationId: {
          documentId: input.documentId,
          operationId: input.operationId,
        },
      },
      select: {
        actorId: true,
        commandFingerprint: true,
        resultingRevision: true,
        committedAt: true,
        broadcastedAt: true,
      },
    });
    if (existing) {
      return this.resolveExisting(existing, identity, input, fingerprint);
    }

    if (document.revision !== input.baseRevision) {
      throw new CollaborationOperationError('REVISION_CONFLICT', document.revision);
    }

    const currentModel = this.toCanonicalModel(document.canonicalModel);
    let affectedElementIds: Set<string>;
    let nextModel: CanonicalUmlModel;
    try {
      affectedElementIds = this.commandExecutor.affectedElementIds(currentModel, input.command);
      if (
        this.lockStore.hasLockByAnotherUser(input.documentId, affectedElementIds, identity.userId)
      ) {
        throw new CollaborationOperationError('ELEMENT_LOCKED');
      }
      nextModel = this.commandExecutor.execute(currentModel, input.command);
    } catch (error: unknown) {
      if (error instanceof CollaborationOperationError) {
        throw error;
      }
      throw new CollaborationOperationError('INVALID_COMMAND');
    }

    const committedAt = new Date();
    let canonicalModel: Prisma.InputJsonObject;
    try {
      canonicalModel = this.canonicalValidator.validateAndNormalize(
        nextModel as unknown as Record<string, unknown>,
        input.baseRevision + 1,
        committedAt,
        { projectId: document.projectId, documentId: input.documentId },
      ) as Prisma.InputJsonObject;
    } catch (error: unknown) {
      if (error instanceof BadRequestException || error instanceof UmlCommandExecutionError) {
        throw new CollaborationOperationError('INVALID_MODEL');
      }
      throw error;
    }

    const updated = await transaction.umlDocument.updateMany({
      where: {
        id: input.documentId,
        revision: input.baseRevision,
        project: {
          members: {
            some: { userId: identity.userId, role: { in: COLLABORATION_ROLES } },
          },
        },
      },
      data: {
        canonicalModel,
        schemaVersion: UML_SCHEMA_VERSION,
        revision: { increment: 1 },
        updatedById: identity.userId,
      },
    });
    if (updated.count !== 1) {
      const duplicate = await transaction.documentOperation.findUnique({
        where: {
          documentId_operationId: {
            documentId: input.documentId,
            operationId: input.operationId,
          },
        },
        select: {
          actorId: true,
          commandFingerprint: true,
          resultingRevision: true,
          committedAt: true,
          broadcastedAt: true,
        },
      });
      if (duplicate) {
        return this.resolveExisting(duplicate, identity, input, fingerprint);
      }
      const current = await transaction.umlDocument.findFirst({
        where: {
          id: input.documentId,
          project: { members: { some: { userId: identity.userId } } },
        },
        select: { revision: true },
      });
      if (!current) {
        throw new CollaborationOperationError('NOT_FOUND');
      }
      throw new CollaborationOperationError('REVISION_CONFLICT', current.revision);
    }

    await transaction.documentRevision.create({
      data: {
        documentId: input.documentId,
        revision: input.baseRevision + 1,
        canonicalModel,
        schemaVersion: UML_SCHEMA_VERSION,
        authorId: identity.userId,
      },
    });
    await transaction.documentOperation.create({
      data: {
        operationId: input.operationId,
        documentId: input.documentId,
        actorId: identity.userId,
        baseRevision: input.baseRevision,
        resultingRevision: input.baseRevision + 1,
        command: input.command as unknown as Prisma.InputJsonObject,
        commandFingerprint: fingerprint,
        committedAt,
      },
    });

    return {
      operationId: input.operationId,
      documentId: input.documentId,
      baseRevision: input.baseRevision,
      revision: input.baseRevision + 1,
      committedAt: committedAt.toISOString(),
      command: input.command,
      idempotent: false,
      requiresBroadcast: true,
      activeElementIds: nextModel.diagram.elements.map((element) => element.id),
    };
  }

  private async lockCommandAuthorization(
    transaction: Prisma.TransactionClient,
    identity: CollaborationIdentity,
    documentId: string,
  ): Promise<{
    id: string;
    projectId: string;
    revision: number;
    canonicalModel: Prisma.JsonValue;
  }> {
    if (
      !(await this.accessTokenVerifier.lockActiveSession(
        transaction,
        identity.userId,
        identity.sessionId,
      ))
    ) {
      throw new CollaborationOperationError('SESSION_REVOKED');
    }

    const candidate = await transaction.umlDocument.findUnique({
      where: { id: documentId },
      select: { projectId: true },
    });
    if (!candidate) {
      throw new CollaborationOperationError('NOT_FOUND');
    }

    const projects = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id"
      FROM "Project"
      WHERE "id" = CAST(${candidate.projectId} AS UUID)
      FOR KEY SHARE
    `);
    if (projects.length !== 1) {
      throw new CollaborationOperationError('NOT_FOUND');
    }

    const memberships = await transaction.$queryRaw<Array<{ role: ProjectRole }>>(Prisma.sql`
      SELECT "role"
      FROM "ProjectMember"
      WHERE "projectId" = CAST(${candidate.projectId} AS UUID)
        AND "userId" = CAST(${identity.userId} AS UUID)
      FOR UPDATE
    `);
    if (memberships.length !== 1 || !COLLABORATION_ROLES.includes(memberships[0]!.role)) {
      throw new CollaborationOperationError('NOT_FOUND');
    }

    const document = await transaction.umlDocument.findFirst({
      where: { id: documentId, projectId: candidate.projectId },
      select: { id: true, projectId: true, revision: true, canonicalModel: true },
    });
    if (!document) {
      throw new CollaborationOperationError('NOT_FOUND');
    }
    return document;
  }

  private async findExistingForActor(
    identity: CollaborationIdentity,
    input: DocumentCommandPayload,
    fingerprint: string,
  ): Promise<ProcessedDocumentCommand | null> {
    if (!(await this.accessTokenVerifier.isSessionActive(identity.userId, identity.sessionId))) {
      throw new CollaborationOperationError('SESSION_REVOKED');
    }
    const operation = await this.prisma.documentOperation.findFirst({
      where: {
        documentId: input.documentId,
        operationId: input.operationId,
        document: {
          project: {
            members: {
              some: { userId: identity.userId, role: { in: COLLABORATION_ROLES } },
            },
          },
        },
      },
      select: {
        actorId: true,
        commandFingerprint: true,
        resultingRevision: true,
        committedAt: true,
        broadcastedAt: true,
      },
    });
    return operation ? this.resolveExisting(operation, identity, input, fingerprint) : null;
  }

  private resolveExisting(
    operation: ExistingOperation,
    identity: CollaborationIdentity,
    input: DocumentCommandPayload,
    fingerprint: string,
  ): ProcessedDocumentCommand {
    if (operation.actorId !== identity.userId || operation.commandFingerprint !== fingerprint) {
      throw new CollaborationOperationError('OPERATION_ID_REUSED');
    }
    return {
      operationId: input.operationId,
      documentId: input.documentId,
      baseRevision: input.baseRevision,
      revision: operation.resultingRevision,
      committedAt: operation.committedAt.toISOString(),
      command: input.command,
      idempotent: true,
      requiresBroadcast: operation.broadcastedAt === null,
      activeElementIds: [],
    };
  }

  async markBroadcastDelivered(documentId: string, operationId: string): Promise<void> {
    await this.prisma.documentOperation.updateMany({
      where: { documentId, operationId, broadcastedAt: null },
      data: { broadcastedAt: new Date() },
    });
  }

  async listDocumentsAwaitingDelivery(limit: number): Promise<string[]> {
    const operations = await this.prisma.documentOperation.findMany({
      where: { broadcastedAt: null },
      select: { documentId: true },
      orderBy: [{ committedAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });
    return [...new Set(operations.map((operation) => operation.documentId))];
  }

  async hasPendingBroadcasts(documentId: string): Promise<boolean> {
    const operation = await this.prisma.documentOperation.findFirst({
      where: { documentId, broadcastedAt: null },
      select: { id: true },
    });
    return operation !== null;
  }

  async markPendingBroadcastsDelivered(documentId: string): Promise<void> {
    await this.prisma.documentOperation.updateMany({
      where: { documentId, broadcastedAt: null },
      data: { broadcastedAt: new Date() },
    });
  }

  private toAuthorizedDocument(document: {
    id: string;
    projectId: string;
    revision: number;
    canonicalModel: Prisma.JsonValue;
  }): AuthorizedDocument {
    return {
      id: document.id,
      projectId: document.projectId,
      revision: document.revision,
      canonicalModel: this.toCanonicalModel(document.canonicalModel),
    };
  }

  private toCanonicalModel(value: Prisma.JsonValue): CanonicalUmlModel {
    return structuredClone(value) as unknown as CanonicalUmlModel;
  }

  private commandFingerprint(baseRevision: number, command: UmlCommand): string {
    return createHash('sha256')
      .update(this.stableJson({ baseRevision, command }), 'utf8')
      .digest('hex');
  }

  private sessionKey(userId: string, sessionId: string): string {
    return `${userId}:${sessionId}`;
  }

  private stableJson(value: unknown): string {
    if (value === null || typeof value === 'boolean' || typeof value === 'number') {
      return JSON.stringify(value);
    }
    if (typeof value === 'string') {
      return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
      return `[${value.map((item) => this.stableJson(item)).join(',')}]`;
    }
    if (typeof value === 'object') {
      const record = value as Record<string, unknown>;
      return `{${Object.keys(record)
        .toSorted()
        .map((key) => `${JSON.stringify(key)}:${this.stableJson(record[key])}`)
        .join(',')}}`;
    }
    throw new CollaborationOperationError('INVALID_COMMAND');
  }

  private isKnownUniqueConstraint(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
  }
}
