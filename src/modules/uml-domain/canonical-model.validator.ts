import { BadRequestException, Injectable } from '@nestjs/common';
import {
  CanonicalModelValidationError,
  validateCanonicalModel,
} from './canonical-model.validation';
import type { CanonicalUmlModel } from './collaboration.types';

export { UML_SCHEMA_VERSION } from './canonical-model.validation';

export interface PersistenceIdentity {
  projectId: string;
  documentId: string;
}

@Injectable()
export class CanonicalModelValidator {
  validateAndNormalize(
    value: Record<string, unknown>,
    persistedRevision: number,
    updatedAt: Date,
    identity?: PersistenceIdentity,
  ): Record<string, unknown> {
    let normalized: CanonicalUmlModel;
    try {
      normalized = validateCanonicalModel(value);
    } catch (error) {
      if (error instanceof CanonicalModelValidationError) {
        throw new BadRequestException({
          message: error.message,
          validationErrors: error.validationErrors,
        });
      }
      throw error;
    }

    if (identity) {
      const remapped = structuredClone(normalized);
      remapped.project.id = this.toCanonicalPersistenceId('project', identity.projectId);
      remapped.diagram.id = this.toCanonicalPersistenceId('diagram', identity.documentId);
      try {
        normalized = validateCanonicalModel(remapped);
      } catch (error) {
        if (error instanceof CanonicalModelValidationError) {
          throw new BadRequestException({
            message: error.message,
            validationErrors: error.validationErrors,
          });
        }
        throw error;
      }
    }
    const metadata = normalized.metadata as Record<string, unknown>;
    metadata.revision = persistedRevision;
    metadata.updatedAt = updatedAt.toISOString();
    return normalized as unknown as Record<string, unknown>;
  }

  private toCanonicalPersistenceId(prefix: 'project' | 'diagram', id: string): string {
    return `${prefix}_${id.toLowerCase().replaceAll('-', '')}`;
  }
}
