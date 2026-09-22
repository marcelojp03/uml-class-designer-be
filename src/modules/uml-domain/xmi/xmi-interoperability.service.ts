import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { AccessTokenVerifierService } from '../../auth/access-token-verifier.service';
import type { AuthenticatedPrincipal } from '../../auth/auth.types';
import { CanonicalModelValidator } from '../canonical-model.validator';
import type { CanonicalUmlModel } from '../collaboration.types';
import type { DocumentResponseDto } from '../dto/document-response.dto';
import { DocumentsService } from '../documents.service';
import {
  XMI_ACCEPTED_CONTENT_TYPES,
  XMI_CONTENT_TYPE,
  XMI_LIMITS,
  XMI_PROFILE_VERSION,
} from './xmi.constants';
import { exportCanonicalModelToXmi, importXmiToCanonical, xmiSha256 } from './xmi.adapter';
import { XmiInteroperabilityError, throwXmiHttpError } from './xmi.error';
import type { XmiCanonicalSeed } from './xmi.adapter';
import type { XmiExportResult, XmiImportPreview, XmiImportResult } from './xmi.types';

export interface UploadedXmiFile {
  buffer?: Buffer;
  mimetype?: string;
}

@Injectable()
export class XmiInteroperabilityService {
  constructor(
    private readonly documentsService: DocumentsService,
    private readonly canonicalValidator: CanonicalModelValidator,
    private readonly accessTokenVerifier: AccessTokenVerifierService,
  ) {}

  async preview(
    projectId: string,
    documentId: string,
    user: AuthenticatedPrincipal,
    file: UploadedXmiFile | undefined,
  ): Promise<XmiImportPreview> {
    try {
      await this.assertActiveSession(user);
      const document = await this.documentsService.get(projectId, documentId, user.id);
      const bytes = this.readFile(file);
      const imported = this.importForDocument(bytes, document);
      this.validateImportedModel(imported, document);
      await this.assertActiveSession(user);

      return {
        diagnostics: imported.diagnostics,
        currentRevision: document.revision,
        profile: imported.profile,
        sha256: xmiSha256(bytes),
        summary: imported.summary,
      };
    } catch (error) {
      throwXmiHttpError(error);
    }
  }

  async apply(
    projectId: string,
    documentId: string,
    user: AuthenticatedPrincipal,
    expectedRevision: number,
    expectedSha256: string,
    acknowledgeWarnings: boolean,
    file: UploadedXmiFile | undefined,
  ): Promise<DocumentResponseDto> {
    try {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
        throw new XmiInteroperabilityError(
          'XMI_INVALID_REQUEST',
          'expectedRevision debe ser un entero no negativo.',
        );
      }
      if (!/^[a-f0-9]{64}$/u.test(expectedSha256)) {
        throw new XmiInteroperabilityError(
          'XMI_INVALID_HASH',
          'El hash XMI no tiene formato SHA-256.',
        );
      }
      await this.assertActiveSession(user);
      const document = await this.documentsService.get(projectId, documentId, user.id);
      if (document.revision !== expectedRevision) {
        throw new ConflictException({
          currentRevision: document.revision,
          message: 'Document revision conflict.',
        });
      }
      const bytes = this.readFile(file);
      const actualSha256 = xmiSha256(bytes);
      if (
        !timingSafeEqual(Buffer.from(actualSha256, 'utf8'), Buffer.from(expectedSha256, 'utf8'))
      ) {
        throw new XmiInteroperabilityError(
          'XMI_INVALID_HASH',
          'El archivo XMI no coincide con el hash solicitado.',
        );
      }
      const imported = this.importForDocument(bytes, document);
      const canonicalModel = this.validateImportedModel(imported, document);
      this.assertApplicableImport(imported, acknowledgeWarnings);
      await this.assertActiveSession(user);

      return await this.documentsService.update(projectId, documentId, user.id, user.sessionId, {
        canonicalModel,
        expectedRevision,
      });
    } catch (error) {
      throwXmiHttpError(error);
    }
  }

  async exportDocument(
    projectId: string,
    documentId: string,
    user: AuthenticatedPrincipal,
    expectedRevision: number,
  ): Promise<XmiExportResult> {
    try {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
        throw new BadRequestException({
          code: 'EXPECTED_REVISION_INVALID',
          message: 'expectedRevision must be a non-negative integer.',
        });
      }
      return await this.documentsService.withAuthorizedDocumentSnapshot(
        projectId,
        documentId,
        user.id,
        user.sessionId,
        (document) => {
          if (document.revision !== expectedRevision) {
            throw new ConflictException({
              currentRevision: document.revision,
              message: 'Document revision conflict.',
            });
          }

          this.assertSnapshotSize(document.canonicalModel);
          const canonicalModel = this.canonicalValidator.validateAndNormalize(
            document.canonicalModel,
            document.revision,
            document.updatedAt,
            { documentId, projectId },
          ) as unknown as CanonicalUmlModel;
          const bytes = exportCanonicalModelToXmi(canonicalModel);

          return {
            bytes,
            documentRevision: document.revision,
            fileName: `${safeFileStem(document.name)}-r${document.revision}.xmi`,
            profileVersion: XMI_PROFILE_VERSION,
            sha256: xmiSha256(bytes),
          };
        },
      );
    } catch (error) {
      throwXmiHttpError(error);
    }
  }

  private readFile(file: UploadedXmiFile | undefined): Buffer {
    const bytes = file?.buffer;
    if (!bytes || !Buffer.isBuffer(bytes)) {
      throw new XmiInteroperabilityError('XMI_INVALID_REQUEST', 'Debe adjuntar un archivo XMI.');
    }
    if (bytes.byteLength > XMI_LIMITS.maxBytes) {
      throw new XmiInteroperabilityError(
        'XMI_LIMIT_EXCEEDED',
        `El archivo XMI supera el límite de ${XMI_LIMITS.maxBytes} bytes.`,
        413,
      );
    }

    const mediaType = file?.mimetype?.split(';', 1)[0]?.trim().toLocaleLowerCase('en');
    if (
      mediaType &&
      mediaType !== 'application/octet-stream' &&
      !XMI_ACCEPTED_CONTENT_TYPES.includes(mediaType as (typeof XMI_ACCEPTED_CONTENT_TYPES)[number])
    ) {
      throw new XmiInteroperabilityError(
        'XMI_INVALID_CONTENT_TYPE',
        `El archivo debe usar ${XMI_CONTENT_TYPE}, application/xml o text/xml.`,
        415,
      );
    }
    return bytes;
  }

  private importForDocument(bytes: Buffer, document: DocumentResponseDto): XmiImportResult {
    const persistedModel = this.persistedCanonicalModel(document);
    return importXmiToCanonical(bytes, {
      createdAt: persistedModel.metadata.createdAt,
      diagramId: persistedModel.diagram.id,
      diagramName: persistedModel.diagram.name,
      projectId: persistedModel.project.id,
      projectName: persistedModel.project.name,
      revision: document.revision,
      updatedAt: persistedModel.metadata.updatedAt,
    } satisfies XmiCanonicalSeed);
  }

  private validateImportedModel(
    imported: XmiImportResult,
    document: DocumentResponseDto,
  ): Record<string, unknown> {
    return this.canonicalValidator.validateAndNormalize(
      imported.model as unknown as Record<string, unknown>,
      document.revision,
      document.updatedAt,
      { documentId: document.id, projectId: document.projectId },
    );
  }

  private assertApplicableImport(imported: XmiImportResult, acknowledgeWarnings: boolean): void {
    const lossyDiagnostic = imported.diagnostics[0];
    if (lossyDiagnostic && !acknowledgeWarnings) {
      throw new XmiInteroperabilityError(
        'XMI_UNACKNOWLEDGED_WARNINGS',
        `El XMI contiene semántica no representable (${lossyDiagnostic.code}); confirma acknowledgeWarnings para importar solo el subconjunto válido.`,
      );
    }
  }

  private persistedCanonicalModel(document: DocumentResponseDto): CanonicalUmlModel {
    return this.canonicalValidator.validateAndNormalize(
      document.canonicalModel,
      document.revision,
      document.updatedAt,
      { documentId: document.id, projectId: document.projectId },
    ) as unknown as CanonicalUmlModel;
  }

  private assertSnapshotSize(snapshot: unknown): void {
    const serialized = JSON.stringify(snapshot);
    if (typeof serialized !== 'string') {
      throw new XmiInteroperabilityError(
        'XMI_MALFORMED',
        'El snapshot UML persistido no puede serializarse como JSON.',
      );
    }
    if (Buffer.byteLength(serialized, 'utf8') > XMI_LIMITS.maxBytes) {
      throw new XmiInteroperabilityError(
        'XMI_LIMIT_EXCEEDED',
        `El snapshot UML supera el límite de ${XMI_LIMITS.maxBytes} bytes para exportación XMI.`,
        413,
      );
    }
  }

  private async assertActiveSession(user: AuthenticatedPrincipal): Promise<void> {
    if (!(await this.accessTokenVerifier.isSessionActive(user.id, user.sessionId))) {
      throw new UnauthorizedException('Authentication is required.');
    }
  }
}

function safeFileStem(value: string): string {
  const safe = value
    .toLocaleLowerCase('en')
    .replace(/[^a-z0-9.-]/giu, '-')
    .replaceAll('..', '-')
    .replace(/-+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  return safe || 'uml-diagram';
}
