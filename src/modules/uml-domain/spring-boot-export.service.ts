import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  NotFoundException,
  RequestTimeoutException,
} from '@nestjs/common';
import { Prisma, ProjectRole } from '@prisma/client';
import {
  createDeterministicSpringBootArchive,
  generateSpringBootExportArtifacts,
  SPRING_BOOT_EXPORT_LIMITS,
  SPRING_BOOT_EXPORT_VERSION,
  SpringBootExportArtifactError,
  SpringBootExportLimitError,
} from '../generation/spring-boot-export';
import {
  RelationalModelGenerationError,
  generateRelationalModel,
} from '../generation/relational-model';
import {
  generateSpringBootProject,
  SpringBootProjectGenerationError,
} from '../generation/spring-boot';
import { PrismaService } from '../database/prisma.service';
import { CanonicalModelValidator } from './canonical-model.validator';
import type { SpringBootExportOptionsDto } from './dto/spring-boot-export.dto';
import { SpringBootExportQuotaService } from './spring-boot-export-quota.service';

const EXPORT_DOCUMENT_SELECT = {
  id: true,
  projectId: true,
  canonicalModel: true,
  revision: true,
  updatedAt: true,
} satisfies Prisma.UmlDocumentSelect;

@Injectable()
export class SpringBootExportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly canonicalValidator: CanonicalModelValidator,
    private readonly quota: SpringBootExportQuotaService,
  ) {}

  async exportDocument(
    projectId: string,
    documentId: string,
    actorId: string,
    expectedRevision: number,
    options: SpringBootExportOptionsDto | undefined,
  ): Promise<{
    bytes: Buffer;
    fileName: string;
    documentRevision: number;
    generatorVersion: string;
  }> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new BadRequestException({
        code: 'EXPECTED_REVISION_INVALID',
        message: 'expectedRevision must be a non-negative integer.',
      });
    }

    const release = this.quota.acquire(actorId);
    try {
      const document = await this.prisma.umlDocument.findFirst({
        where: {
          id: documentId,
          projectId,
          project: {
            members: {
              some: { userId: actorId, role: { in: [ProjectRole.OWNER, ProjectRole.EDITOR] } },
            },
          },
        },
        select: EXPORT_DOCUMENT_SELECT,
      });
      if (!document) {
        throw new NotFoundException('Document not found.');
      }
      if (document.revision !== expectedRevision) {
        throw new ConflictException({
          message: 'Document revision conflict.',
          currentRevision: document.revision,
        });
      }

      const snapshotBytes = Buffer.byteLength(JSON.stringify(document.canonicalModel), 'utf8');
      if (snapshotBytes > SPRING_BOOT_EXPORT_LIMITS.maxSnapshotBytes) {
        throw new SpringBootExportLimitError(
          'SNAPSHOT_BYTES_EXCEEDED',
          `Persisted UML snapshot exceeds ${SPRING_BOOT_EXPORT_LIMITS.maxSnapshotBytes} bytes.`,
        );
      }

      const startedAt = performance.now();
      assertCanonicalExportPreflight(document.canonicalModel);
      this.assertGenerationDuration(startedAt);
      const canonicalModel = this.canonicalValidator.validateAndNormalize(
        document.canonicalModel as Record<string, unknown>,
        document.revision,
        document.updatedAt,
        { projectId, documentId },
      );
      this.assertGenerationDuration(startedAt);
      const relationalModel = generateRelationalModel(canonicalModel);
      this.assertGenerationDuration(startedAt);
      if (relationalModel.tables.length > SPRING_BOOT_EXPORT_LIMITS.maxClasses) {
        throw new SpringBootExportLimitError(
          'CLASS_LIMIT_EXCEEDED',
          `Relational model exceeds ${SPRING_BOOT_EXPORT_LIMITS.maxClasses} tables.`,
        );
      }
      const relationshipCount = relationalModel.tables.reduce(
        (count, table) => count + table.foreignKeys.length,
        0,
      );
      if (relationshipCount > SPRING_BOOT_EXPORT_LIMITS.maxRelationships) {
        throw new SpringBootExportLimitError(
          'RELATIONSHIP_LIMIT_EXCEEDED',
          `Relational model exceeds ${SPRING_BOOT_EXPORT_LIMITS.maxRelationships} relationships.`,
        );
      }

      const project = generateSpringBootProject(relationalModel, options);
      this.assertGenerationDuration(startedAt);
      const artifacts = generateSpringBootExportArtifacts(relationalModel, {
        documentRevision: document.revision,
        project,
      });
      this.assertGenerationDuration(startedAt);
      const bytes = await createDeterministicSpringBootArchive([
        ...project.files,
        ...artifacts.files,
      ]);
      this.assertGenerationDuration(startedAt);

      return {
        bytes,
        documentRevision: document.revision,
        fileName: `${safeFileStem(project.metadata.artifactId)}-spring-boot-r${document.revision}.zip`,
        generatorVersion: SPRING_BOOT_EXPORT_VERSION,
      };
    } catch (error: unknown) {
      throwSpringBootExportError(error);
    } finally {
      release();
    }
  }

  private assertGenerationDuration(startedAt: number): void {
    if (performance.now() - startedAt > SPRING_BOOT_EXPORT_LIMITS.maxGenerationMs) {
      throw new RequestTimeoutException({
        code: 'EXPORT_GENERATION_TIMEOUT',
        message: `Spring Boot export exceeded ${SPRING_BOOT_EXPORT_LIMITS.maxGenerationMs} ms.`,
      });
    }
  }
}

export function throwSpringBootExportError(error: unknown): never {
  if (error instanceof HttpException) throw error;
  if (error instanceof SpringBootExportLimitError && error.code === 'ARCHIVE_TIMEOUT') {
    throw new RequestTimeoutException({ code: error.code, message: error.message });
  }
  if (error instanceof SpringBootExportLimitError) {
    throw new BadRequestException({ code: error.code, message: error.message });
  }
  if (error instanceof RelationalModelGenerationError) {
    throw new BadRequestException({
      code: 'RELATIONAL_MODEL_INVALID',
      message: error.message,
      issues: error.diagnostics,
    });
  }
  if (error instanceof SpringBootProjectGenerationError) {
    throw new BadRequestException({
      code: 'SPRING_BOOT_GENERATION_INVALID',
      message: error.message,
      issues: error.issues,
    });
  }
  if (error instanceof SpringBootExportArtifactError) {
    throw new BadRequestException({ code: error.code, message: error.message });
  }
  throw error;
}

function safeFileStem(value: string): string {
  const safe = value.replace(/[^a-z0-9.-]/giu, '-').replaceAll('..', '-');
  return safe || 'generated-app';
}

function assertCanonicalExportPreflight(snapshot: unknown): void {
  if (!isRecord(snapshot) || !isRecord(snapshot.diagram)) return;
  assertCanonicalArrayLimit(
    snapshot.diagram.elements,
    SPRING_BOOT_EXPORT_LIMITS.maxClasses,
    'CLASS_LIMIT_EXCEEDED',
    'Persisted UML snapshot exceeds the configured classifier limit.',
  );
  assertCanonicalArrayLimit(
    snapshot.diagram.relationships,
    SPRING_BOOT_EXPORT_LIMITS.maxRelationships,
    'RELATIONSHIP_LIMIT_EXCEEDED',
    'Persisted UML snapshot exceeds the configured relationship limit.',
  );
}

function assertCanonicalArrayLimit(
  value: unknown,
  limit: number,
  code: 'CLASS_LIMIT_EXCEEDED' | 'RELATIONSHIP_LIMIT_EXCEEDED',
  message: string,
): void {
  if (Array.isArray(value) && value.length > limit) {
    throw new SpringBootExportLimitError(code, message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
