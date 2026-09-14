import { BadRequestException, Injectable } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import type { AnySchema, ErrorObject, ValidateFunction } from 'ajv';

export const UML_SCHEMA_VERSION = '0.1.0';

interface CanonicalTypeReference {
  name: string;
  elementId?: string;
}

interface CanonicalElement {
  id: string;
  kind: 'class' | 'interface';
  name: string;
  attributes: Array<{ id: string; name: string; type: CanonicalTypeReference }>;
  operations: Array<{
    id: string;
    name: string;
    returnType: CanonicalTypeReference;
    parameters: Array<{ id: string; name: string; type: CanonicalTypeReference }>;
  }>;
}

interface CanonicalRelationshipEnd {
  elementId: string;
  role: string;
  multiplicity: string;
  navigable: boolean;
}

interface CanonicalRelationship {
  id: string;
  kind:
    | 'association'
    | 'aggregation'
    | 'composition'
    | 'generalization'
    | 'realization'
    | 'dependency';
  name?: string;
  source: CanonicalRelationshipEnd;
  target: CanonicalRelationshipEnd;
  associationClassId?: string;
}

interface CanonicalDocument {
  project: { id: string; name: string };
  diagram: {
    id: string;
    name: string;
    elements: CanonicalElement[];
    relationships: CanonicalRelationship[];
    visual: { positions: Array<{ elementId: string }> };
  };
  metadata: Record<string, unknown>;
}

export interface PersistenceIdentity {
  projectId: string;
  documentId: string;
}

@Injectable()
export class CanonicalModelValidator {
  private readonly validate: ValidateFunction;

  constructor() {
    const schema = JSON.parse(
      readFileSync(resolve(process.cwd(), 'contracts/uml-model.schema.json'), 'utf8'),
    ) as AnySchema;
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    this.validate = ajv.compile(schema);
  }

  validateAndNormalize(
    value: Record<string, unknown>,
    persistedRevision: number,
    updatedAt: Date,
    identity?: PersistenceIdentity,
  ): Record<string, unknown> {
    if (!this.validate(value)) {
      throw new BadRequestException({
        message: `canonicalModel must conform to UML schema ${UML_SCHEMA_VERSION}.`,
        validationErrors: (this.validate.errors ?? []).map((error) =>
          this.toSafeValidationError(error),
        ),
      });
    }

    const normalized = structuredClone(value);
    if (identity) {
      const document = normalized as unknown as CanonicalDocument;
      document.project.id = this.toCanonicalPersistenceId('project', identity.projectId);
      document.diagram.id = this.toCanonicalPersistenceId('diagram', identity.documentId);
    }
    this.assertSemanticIntegrity(normalized as unknown as CanonicalDocument);
    const metadata = normalized.metadata as Record<string, unknown>;
    metadata.revision = persistedRevision;
    metadata.updatedAt = updatedAt.toISOString();
    return normalized;
  }

  private assertSemanticIntegrity(document: CanonicalDocument): void {
    const ids = new Set<string>();
    const registerId = (id: string, path: string) => {
      if (ids.has(id)) {
        this.throwSemanticError(path, `duplicates the identifier ${id}.`);
      }
      ids.add(id);
    };
    const assertUniqueNames = (values: string[], path: string) => {
      const names = new Set<string>();
      for (const value of values) {
        const normalizedName = value.trim().toLocaleLowerCase('es');
        if (names.has(normalizedName)) {
          this.throwSemanticError(path, `contains the duplicate name ${value}.`);
        }
        names.add(normalizedName);
      }
    };
    const assertNonBlankName = (value: string, path: string) => {
      if (value.trim().length === 0) {
        this.throwSemanticError(path, 'must not be blank.');
      }
    };

    registerId(document.project.id, '/project/id');
    registerId(document.diagram.id, '/diagram/id');
    assertNonBlankName(document.project.name, '/project/name');
    assertNonBlankName(document.diagram.name, '/diagram/name');

    const elements = new Map<string, CanonicalElement>();
    for (const [elementIndex, element] of document.diagram.elements.entries()) {
      registerId(element.id, `/diagram/elements/${elementIndex}/id`);
      assertNonBlankName(element.name, `/diagram/elements/${elementIndex}/name`);
      elements.set(element.id, element);
      assertUniqueNames(
        element.attributes.map((attribute) => attribute.name),
        `/diagram/elements/${elementIndex}/attributes`,
      );
      for (const [attributeIndex, attribute] of element.attributes.entries()) {
        registerId(
          attribute.id,
          `/diagram/elements/${elementIndex}/attributes/${attributeIndex}/id`,
        );
        assertNonBlankName(
          attribute.name,
          `/diagram/elements/${elementIndex}/attributes/${attributeIndex}/name`,
        );
      }
      for (const [operationIndex, operation] of element.operations.entries()) {
        registerId(
          operation.id,
          `/diagram/elements/${elementIndex}/operations/${operationIndex}/id`,
        );
        assertNonBlankName(
          operation.name,
          `/diagram/elements/${elementIndex}/operations/${operationIndex}/name`,
        );
        assertUniqueNames(
          operation.parameters.map((parameter) => parameter.name),
          `/diagram/elements/${elementIndex}/operations/${operationIndex}/parameters`,
        );
        for (const [parameterIndex, parameter] of operation.parameters.entries()) {
          registerId(
            parameter.id,
            `/diagram/elements/${elementIndex}/operations/${operationIndex}/parameters/${parameterIndex}/id`,
          );
          assertNonBlankName(
            parameter.name,
            `/diagram/elements/${elementIndex}/operations/${operationIndex}/parameters/${parameterIndex}/name`,
          );
        }
      }
    }
    assertUniqueNames(
      document.diagram.elements.map((element) => element.name),
      '/diagram/elements',
    );

    const assertTypeReference = (reference: CanonicalTypeReference, path: string) => {
      assertNonBlankName(reference.name, `${path}/name`);
      if (!reference.elementId) {
        return;
      }
      const referencedElement = elements.get(reference.elementId);
      if (!referencedElement) {
        this.throwSemanticError(path, 'references a classifier that does not exist.');
      }
      if (referencedElement.name !== reference.name) {
        this.throwSemanticError(
          path,
          `must use the referenced classifier name ${referencedElement.name}.`,
        );
      }
    };
    for (const [elementIndex, element] of document.diagram.elements.entries()) {
      for (const [attributeIndex, attribute] of element.attributes.entries()) {
        assertTypeReference(
          attribute.type,
          `/diagram/elements/${elementIndex}/attributes/${attributeIndex}/type`,
        );
      }
      for (const [operationIndex, operation] of element.operations.entries()) {
        assertTypeReference(
          operation.returnType,
          `/diagram/elements/${elementIndex}/operations/${operationIndex}/returnType`,
        );
        for (const [parameterIndex, parameter] of operation.parameters.entries()) {
          assertTypeReference(
            parameter.type,
            `/diagram/elements/${elementIndex}/operations/${operationIndex}/parameters/${parameterIndex}/type`,
          );
        }
      }
    }

    const positionedElements = new Set<string>();
    for (const [positionIndex, position] of document.diagram.visual.positions.entries()) {
      if (!elements.has(position.elementId)) {
        this.throwSemanticError(
          `/diagram/visual/positions/${positionIndex}/elementId`,
          'references a classifier that does not exist.',
        );
      }
      if (positionedElements.has(position.elementId)) {
        this.throwSemanticError(
          `/diagram/visual/positions/${positionIndex}/elementId`,
          'duplicates the position of a classifier.',
        );
      }
      positionedElements.add(position.elementId);
    }
    for (const element of elements.values()) {
      if (!positionedElements.has(element.id)) {
        this.throwSemanticError('/diagram/visual/positions', `has no position for ${element.id}.`);
      }
    }

    const relationshipSignatures = new Set<string>();
    const associationClasses = new Set<string>();
    for (const [relationshipIndex, relationship] of document.diagram.relationships.entries()) {
      const path = `/diagram/relationships/${relationshipIndex}`;
      registerId(relationship.id, `${path}/id`);
      const source = elements.get(relationship.source.elementId);
      const target = elements.get(relationship.target.elementId);
      if (!source || !target) {
        this.throwSemanticError(path, 'must connect classifiers that exist.');
      }
      if (
        source.id === target.id &&
        relationship.kind !== 'association' &&
        relationship.kind !== 'dependency'
      ) {
        this.throwSemanticError(path, `${relationship.kind} cannot be self-referential.`);
      }
      if (
        relationship.kind === 'realization' &&
        (source.kind !== 'class' || target.kind !== 'interface')
      ) {
        this.throwSemanticError(path, 'realization must connect a class to an interface.');
      }
      if (relationship.kind === 'generalization' && source.kind !== target.kind) {
        this.throwSemanticError(path, 'generalization must connect classifiers of the same kind.');
      }
      this.assertMultiplicityRange(relationship.source.multiplicity, `${path}/source/multiplicity`);
      this.assertMultiplicityRange(relationship.target.multiplicity, `${path}/target/multiplicity`);

      const signature = this.relationshipSignature(relationship);
      const reverseSignature =
        relationship.kind === 'association' ? this.relationshipSignature(relationship, true) : null;
      if (
        relationshipSignatures.has(signature) ||
        (reverseSignature !== null && relationshipSignatures.has(reverseSignature))
      ) {
        this.throwSemanticError(path, 'duplicates an existing semantic relationship.');
      }
      relationshipSignatures.add(signature);

      if (!relationship.associationClassId) {
        continue;
      }
      const associationClass = elements.get(relationship.associationClassId);
      if (relationship.kind !== 'association' || associationClass?.kind !== 'class') {
        this.throwSemanticError(path, 'must reference a class from an association.');
      }
      if (
        !this.isManyMultiplicity(relationship.source.multiplicity) ||
        !this.isManyMultiplicity(relationship.target.multiplicity)
      ) {
        this.throwSemanticError(path, 'association classes require many-to-many multiplicities.');
      }
      if (associationClass.id === source.id || associationClass.id === target.id) {
        this.throwSemanticError(path, 'association class cannot also be an association endpoint.');
      }
      if (associationClasses.has(associationClass.id)) {
        this.throwSemanticError(
          path,
          'association class is already assigned to another relationship.',
        );
      }
      associationClasses.add(associationClass.id);
    }

    this.assertAcyclic(document.diagram.relationships, 'generalization');
    this.assertAcyclic(document.diagram.relationships, 'composition');
  }

  private assertMultiplicityRange(value: string, path: string): void {
    const [lower, upper] = value.split('..');
    if (upper !== undefined && upper !== '*' && BigInt(lower!) > BigInt(upper)) {
      this.throwSemanticError(path, 'has a lower bound greater than its upper bound.');
    }
  }

  private assertAcyclic(
    relationships: CanonicalRelationship[],
    kind: 'composition' | 'generalization',
  ): void {
    const adjacency = new Map<string, string[]>();
    for (const relationship of relationships) {
      if (relationship.kind !== kind) {
        continue;
      }
      const targets = adjacency.get(relationship.source.elementId) ?? [];
      targets.push(relationship.target.elementId);
      adjacency.set(relationship.source.elementId, targets);
    }

    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (id: string): boolean => {
      if (visiting.has(id)) {
        return true;
      }
      if (visited.has(id)) {
        return false;
      }
      visiting.add(id);
      for (const target of adjacency.get(id) ?? []) {
        if (visit(target)) {
          return true;
        }
      }
      visiting.delete(id);
      visited.add(id);
      return false;
    };

    for (const id of adjacency.keys()) {
      if (visit(id)) {
        this.throwSemanticError(
          '/diagram/relationships',
          `${kind} relationships cannot form a cycle.`,
        );
      }
    }
  }

  private relationshipSignature(relationship: CanonicalRelationship, reversed = false): string {
    const source = reversed ? relationship.target : relationship.source;
    const target = reversed ? relationship.source : relationship.target;
    return JSON.stringify([
      relationship.kind,
      relationship.name ?? null,
      source.elementId,
      source.role,
      source.multiplicity,
      source.navigable,
      target.elementId,
      target.role,
      target.multiplicity,
      target.navigable,
      relationship.associationClassId ?? null,
    ]);
  }

  private isManyMultiplicity(value: string): boolean {
    return (
      value === '*' ||
      value.endsWith('..*') ||
      (/^\d+$/.test(value) && BigInt(value) > 1n) ||
      (/^\d+\.\.\d+$/.test(value) && BigInt(value.split('..')[1]!) > 1n)
    );
  }

  private toCanonicalPersistenceId(prefix: 'project' | 'diagram', id: string): string {
    return `${prefix}_${id.toLowerCase().replaceAll('-', '')}`;
  }

  private throwSemanticError(path: string, message: string): never {
    throw new BadRequestException({
      message: `canonicalModel must satisfy UML semantic integrity ${UML_SCHEMA_VERSION}.`,
      validationErrors: [{ path, keyword: 'semantic', message }],
    });
  }

  private toSafeValidationError(error: ErrorObject): {
    path: string;
    keyword: string;
    message: string;
  } {
    return {
      path: error.instancePath || '/',
      keyword: error.keyword,
      message: error.message ?? 'is invalid',
    };
  }
}
