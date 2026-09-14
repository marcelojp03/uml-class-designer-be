import {
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma, ProjectRole } from '@prisma/client';
import { AccessTokenVerifierService } from '../auth/access-token-verifier.service';
import { PrismaService } from '../database/prisma.service';
import { CanonicalModelValidator, UML_SCHEMA_VERSION } from './canonical-model.validator';
import { DocumentCollaborationEventBus } from './document-collaboration-event-bus.service';
import {
  DocumentMutationQueueOverloadedError,
  DocumentMutationQueueService,
} from './document-mutation-queue.service';
import { CollaborationLockStore } from './collaboration-lock.store';
import type { CreateDocumentDto, UpdateDocumentDto } from './dto/document.dto';
import type { DocumentResponseDto, DocumentSummaryResponseDto } from './dto/document-response.dto';

const DOCUMENT_SELECT = {
  id: true,
  projectId: true,
  name: true,
  canonicalModel: true,
  schemaVersion: true,
  revision: true,
  createdById: true,
  updatedById: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.UmlDocumentSelect;

type SelectedDocument = Prisma.UmlDocumentGetPayload<{ select: typeof DOCUMENT_SELECT }>;

@Injectable()
export class DocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly canonicalValidator: CanonicalModelValidator,
    private readonly collaborationEvents: DocumentCollaborationEventBus,
    private readonly documentQueue: DocumentMutationQueueService,
    private readonly lockStore: CollaborationLockStore,
    private readonly accessTokenVerifier: AccessTokenVerifierService,
  ) {}

  async list(projectId: string, userId: string): Promise<DocumentSummaryResponseDto[]> {
    const documents = await this.prisma.umlDocument.findMany({
      where: { projectId, project: { members: { some: { userId } } } },
      select: {
        id: true,
        projectId: true,
        name: true,
        schemaVersion: true,
        revision: true,
        createdById: true,
        updatedById: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { updatedAt: 'desc' },
    });
    return documents;
  }

  async create(
    projectId: string,
    userId: string,
    sessionId: string,
    input: CreateDocumentDto,
  ): Promise<DocumentResponseDto> {
    const now = new Date();
    const documentId = randomUUID();
    const canonicalModel = this.canonicalValidator.validateAndNormalize(
      input.canonicalModel,
      0,
      now,
      { projectId, documentId },
    ) as Prisma.InputJsonObject;

    try {
      const document = await this.prisma.$transaction(async (transaction) => {
        await this.lockMutationSession(transaction, userId, sessionId);
        await this.lockCollaboratorMembership(transaction, projectId, userId);

        return transaction.umlDocument.create({
          data: {
            id: documentId,
            projectId,
            name: input.name,
            canonicalModel,
            schemaVersion: UML_SCHEMA_VERSION,
            revision: 0,
            createdById: userId,
            updatedById: userId,
            revisions: {
              create: {
                revision: 0,
                canonicalModel,
                schemaVersion: UML_SCHEMA_VERSION,
                authorId: userId,
              },
            },
          },
          select: DOCUMENT_SELECT,
        });
      });
      return this.toResponse(document);
    } catch (error: unknown) {
      if (this.isUniqueConstraintError(error)) {
        throw new ConflictException('A document with that name already exists in this project.');
      }
      throw error;
    }
  }

  async get(projectId: string, documentId: string, userId: string): Promise<DocumentResponseDto> {
    const document = await this.prisma.umlDocument.findFirst({
      where: { id: documentId, projectId, project: { members: { some: { userId } } } },
      select: DOCUMENT_SELECT,
    });
    if (!document) {
      throw new NotFoundException('Document not found.');
    }
    return this.toResponse(document);
  }

  async update(
    projectId: string,
    documentId: string,
    userId: string,
    sessionId: string,
    input: UpdateDocumentDto,
  ): Promise<DocumentResponseDto> {
    const nextRevision = input.expectedRevision + 1;
    const canonicalModel = this.canonicalValidator.validateAndNormalize(
      input.canonicalModel,
      nextRevision,
      new Date(),
      { projectId, documentId },
    ) as Prisma.InputJsonObject;

    try {
      return await this.documentQueue.run(documentId, async () => {
        const document = await this.prisma.$transaction(async (transaction) => {
          await this.lockMutationSession(transaction, userId, sessionId);
          await this.lockCollaboratorMembership(transaction, projectId, userId);
          const currentDocument = await transaction.umlDocument.findFirst({
            where: { id: documentId, projectId },
            select: { revision: true, canonicalModel: true },
          });
          if (!currentDocument) {
            throw new NotFoundException('Document not found.');
          }
          if (currentDocument.revision !== input.expectedRevision) {
            throw new ConflictException({
              message: 'Document revision conflict.',
              currentRevision: currentDocument.revision,
            });
          }
          if (
            this.lockStore.hasLockByAnotherUser(
              documentId,
              new Set(
                this.activeElementIds(currentDocument.canonicalModel as Record<string, unknown>),
              ),
              userId,
            )
          ) {
            throw new ConflictException('A locked element prevents replacing this document.');
          }
          const updated = await transaction.umlDocument.updateMany({
            where: {
              id: documentId,
              projectId,
              revision: input.expectedRevision,
              project: {
                members: {
                  some: { userId, role: { in: [ProjectRole.OWNER, ProjectRole.EDITOR] } },
                },
              },
            },
            data: {
              ...(input.name === undefined ? {} : { name: input.name }),
              canonicalModel,
              schemaVersion: UML_SCHEMA_VERSION,
              revision: { increment: 1 },
              updatedById: userId,
            },
          });

          if (updated.count !== 1) {
            const current = await transaction.umlDocument.findFirst({
              where: { id: documentId, projectId, project: { members: { some: { userId } } } },
              select: { revision: true },
            });
            if (!current) {
              throw new NotFoundException('Document not found.');
            }
            throw new ConflictException({
              message: 'Document revision conflict.',
              currentRevision: current.revision,
            });
          }

          const persisted = await transaction.umlDocument.findUniqueOrThrow({
            where: { id: documentId },
            select: DOCUMENT_SELECT,
          });
          await transaction.documentRevision.create({
            data: {
              documentId,
              revision: persisted.revision,
              canonicalModel,
              schemaVersion: UML_SCHEMA_VERSION,
              authorId: userId,
            },
          });
          return persisted;
        });
        const response = this.toResponse(document);
        this.collaborationEvents.publish({
          type: 'resync-required',
          documentId,
          revision: response.revision,
          activeElementIds: this.activeElementIds(response.canonicalModel),
        });
        return response;
      });
    } catch (error: unknown) {
      if (error instanceof DocumentMutationQueueOverloadedError) {
        throw new HttpException('Document collaboration is busy.', HttpStatus.TOO_MANY_REQUESTS);
      }
      if (this.isUniqueConstraintError(error)) {
        throw new ConflictException('A document with that name already exists in this project.');
      }
      throw error;
    }
  }

  async delete(
    projectId: string,
    documentId: string,
    userId: string,
    sessionId: string,
  ): Promise<void> {
    try {
      await this.documentQueue.run(documentId, async () => {
        const deleted = await this.prisma.$transaction(async (transaction) => {
          await this.lockMutationSession(transaction, userId, sessionId);
          await this.lockCollaboratorMembership(transaction, projectId, userId);
          return transaction.umlDocument.deleteMany({
            where: {
              id: documentId,
              projectId,
              project: {
                members: {
                  some: { userId, role: { in: [ProjectRole.OWNER, ProjectRole.EDITOR] } },
                },
              },
            },
          });
        });
        if (deleted.count !== 1) {
          throw new NotFoundException('Document not found.');
        }
        this.collaborationEvents.publish({ type: 'deleted', documentId });
      });
    } catch (error: unknown) {
      if (error instanceof DocumentMutationQueueOverloadedError) {
        throw new HttpException('Document collaboration is busy.', HttpStatus.TOO_MANY_REQUESTS);
      }
      throw error;
    }
  }

  private toResponse(document: SelectedDocument): DocumentResponseDto {
    return {
      ...document,
      canonicalModel: document.canonicalModel as Record<string, unknown>,
    };
  }

  private isUniqueConstraintError(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
  }

  private activeElementIds(canonicalModel: Record<string, unknown>): string[] {
    const diagram = canonicalModel.diagram as { elements: Array<{ id: string }> };
    return diagram.elements.map((element) => element.id);
  }

  private async lockMutationSession(
    transaction: Prisma.TransactionClient,
    userId: string,
    sessionId: string,
  ): Promise<void> {
    if (!(await this.accessTokenVerifier.lockActiveSession(transaction, userId, sessionId))) {
      throw new UnauthorizedException('Authentication is required.');
    }
  }

  private async lockCollaboratorMembership(
    transaction: Prisma.TransactionClient,
    projectId: string,
    userId: string,
  ): Promise<void> {
    const projects = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id"
      FROM "Project"
      WHERE "id" = CAST(${projectId} AS UUID)
      FOR KEY SHARE
    `);
    if (projects.length !== 1) {
      throw new NotFoundException('Project not found.');
    }
    const memberships = await transaction.$queryRaw<Array<{ userId: string }>>(Prisma.sql`
      SELECT "userId"
      FROM "ProjectMember"
      WHERE "projectId" = CAST(${projectId} AS UUID)
        AND "userId" = CAST(${userId} AS UUID)
      FOR UPDATE
    `);
    if (memberships.length !== 1) {
      throw new NotFoundException('Project not found.');
    }
  }
}
