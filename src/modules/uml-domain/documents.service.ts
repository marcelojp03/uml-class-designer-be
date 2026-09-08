import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma, ProjectRole } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { CanonicalModelValidator, UML_SCHEMA_VERSION } from './canonical-model.validator';
import { DocumentCollaborationEventBus } from './document-collaboration-event-bus.service';
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
        const project = await transaction.project.findFirst({
          where: {
            id: projectId,
            members: {
              some: { userId, role: { in: [ProjectRole.OWNER, ProjectRole.EDITOR] } },
            },
          },
          select: { id: true },
        });
        if (!project) {
          throw new NotFoundException('Project not found.');
        }

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
      const document = await this.prisma.$transaction(async (transaction) => {
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
    } catch (error: unknown) {
      if (this.isUniqueConstraintError(error)) {
        throw new ConflictException('A document with that name already exists in this project.');
      }
      throw error;
    }
  }

  async delete(projectId: string, documentId: string, userId: string): Promise<void> {
    const deleted = await this.prisma.umlDocument.deleteMany({
      where: {
        id: documentId,
        projectId,
        project: {
          members: { some: { userId, role: { in: [ProjectRole.OWNER, ProjectRole.EDITOR] } } },
        },
      },
    });
    if (deleted.count !== 1) {
      throw new NotFoundException('Document not found.');
    }
    this.collaborationEvents.publish({ type: 'deleted', documentId });
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
}
