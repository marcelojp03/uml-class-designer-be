import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import type { AnySchema, ErrorObject, ValidateFunction } from 'ajv';
import canonicalSchema = require('../../../contracts/uml-model.schema.json');
import type {
  CanonicalUmlModel,
  UmlClassifier,
  UmlRelationship,
  UmlTypeReference,
} from './collaboration.types';

export const UML_SCHEMA_VERSION = '0.1.0';

export interface CanonicalValidationIssue {
  path: string;
  keyword: string;
  message: string;
}

export class CanonicalModelValidationError extends Error {
  constructor(
    message: string,
    readonly validationErrors: CanonicalValidationIssue[],
  ) {
    super(message);
    this.name = 'CanonicalModelValidationError';
  }
}

const canonicalSchemaValidator: ValidateFunction = createSchemaValidator();

export function validateCanonicalModel(value: unknown): CanonicalUmlModel {
  if (!canonicalSchemaValidator(value)) {
    throw new CanonicalModelValidationError(
      `canonicalModel must conform to UML schema ${UML_SCHEMA_VERSION}.`,
      (canonicalSchemaValidator.errors ?? []).map(toSafeValidationError),
    );
  }

  const normalized = structuredClone(value) as CanonicalUmlModel;
  assertCanonicalSemanticIntegrity(normalized);
  return normalized;
}

export function assertCanonicalSemanticIntegrity(document: CanonicalUmlModel): void {
  const ids = new Set<string>();
  const registerId = (id: string, path: string) => {
    if (ids.has(id)) {
      throwSemanticError(path, `duplicates the identifier ${id}.`);
    }
    ids.add(id);
  };
  const assertUniqueNames = (values: string[], path: string) => {
    const names = new Set<string>();
    for (const value of values) {
      const normalizedName = value.trim().toLocaleLowerCase('es');
      if (names.has(normalizedName)) {
        throwSemanticError(path, `contains the duplicate name ${value}.`);
      }
      names.add(normalizedName);
    }
  };
  const assertNonBlankName = (value: string, path: string) => {
    if (value.trim().length === 0) {
      throwSemanticError(path, 'must not be blank.');
    }
  };

  registerId(document.project.id, '/project/id');
  registerId(document.diagram.id, '/diagram/id');
  assertNonBlankName(document.project.name, '/project/name');
  assertNonBlankName(document.diagram.name, '/diagram/name');

  const elements = new Map<string, UmlClassifier>();
  for (const [elementIndex, element] of document.diagram.elements.entries()) {
    registerId(element.id, `/diagram/elements/${elementIndex}/id`);
    assertNonBlankName(element.name, `/diagram/elements/${elementIndex}/name`);
    elements.set(element.id, element);
    assertUniqueNames(
      element.attributes.map((attribute) => attribute.name),
      `/diagram/elements/${elementIndex}/attributes`,
    );
    for (const [attributeIndex, attribute] of element.attributes.entries()) {
      registerId(attribute.id, `/diagram/elements/${elementIndex}/attributes/${attributeIndex}/id`);
      assertNonBlankName(
        attribute.name,
        `/diagram/elements/${elementIndex}/attributes/${attributeIndex}/name`,
      );
    }
    for (const [operationIndex, operation] of element.operations.entries()) {
      registerId(operation.id, `/diagram/elements/${elementIndex}/operations/${operationIndex}/id`);
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

  const assertTypeReference = (reference: UmlTypeReference, path: string) => {
    assertNonBlankName(reference.name, `${path}/name`);
    if (!reference.elementId) {
      return;
    }
    const referencedElement = elements.get(reference.elementId);
    if (!referencedElement) {
      throwSemanticError(path, 'references a classifier that does not exist.');
    }
    if (referencedElement.name !== reference.name) {
      throwSemanticError(
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
      throwSemanticError(
        `/diagram/visual/positions/${positionIndex}/elementId`,
        'references a classifier that does not exist.',
      );
    }
    if (positionedElements.has(position.elementId)) {
      throwSemanticError(
        `/diagram/visual/positions/${positionIndex}/elementId`,
        'duplicates the position of a classifier.',
      );
    }
    positionedElements.add(position.elementId);
  }
  for (const element of elements.values()) {
    if (!positionedElements.has(element.id)) {
      throwSemanticError('/diagram/visual/positions', `has no position for ${element.id}.`);
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
      throwSemanticError(path, 'must connect classifiers that exist.');
    }
    if (
      source.id === target.id &&
      relationship.kind !== 'association' &&
      relationship.kind !== 'dependency'
    ) {
      throwSemanticError(path, `${relationship.kind} cannot be self-referential.`);
    }
    if (
      relationship.kind === 'realization' &&
      (source.kind !== 'class' || target.kind !== 'interface')
    ) {
      throwSemanticError(path, 'realization must connect a class to an interface.');
    }
    if (relationship.kind === 'generalization' && source.kind !== target.kind) {
      throwSemanticError(path, 'generalization must connect classifiers of the same kind.');
    }
    assertMultiplicityRange(relationship.source.multiplicity, `${path}/source/multiplicity`);
    assertMultiplicityRange(relationship.target.multiplicity, `${path}/target/multiplicity`);

    const signature = relationshipSignature(relationship);
    const reverseSignature =
      relationship.kind === 'association' ? relationshipSignature(relationship, true) : null;
    if (
      relationshipSignatures.has(signature) ||
      (reverseSignature !== null && relationshipSignatures.has(reverseSignature))
    ) {
      throwSemanticError(path, 'duplicates an existing semantic relationship.');
    }
    relationshipSignatures.add(signature);

    if (!relationship.associationClassId) {
      continue;
    }
    const associationClass = elements.get(relationship.associationClassId);
    if (relationship.kind !== 'association' || associationClass?.kind !== 'class') {
      throwSemanticError(path, 'must reference a class from an association.');
    }
    if (
      !isManyMultiplicity(relationship.source.multiplicity) ||
      !isManyMultiplicity(relationship.target.multiplicity)
    ) {
      throwSemanticError(path, 'association classes require many-to-many multiplicities.');
    }
    if (associationClass.id === source.id || associationClass.id === target.id) {
      throwSemanticError(path, 'association class cannot also be an association endpoint.');
    }
    if (associationClasses.has(associationClass.id)) {
      throwSemanticError(path, 'association class is already assigned to another relationship.');
    }
    associationClasses.add(associationClass.id);
  }

  assertAcyclic(document.diagram.relationships, 'generalization');
  assertAcyclic(document.diagram.relationships, 'composition');
}

function createSchemaValidator(): ValidateFunction {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  return ajv.compile(canonicalSchema as AnySchema);
}

function assertMultiplicityRange(value: string, path: string): void {
  const [lower, upper] = value.split('..');
  if (upper !== undefined && upper !== '*' && BigInt(lower!) > BigInt(upper)) {
    throwSemanticError(path, 'has a lower bound greater than its upper bound.');
  }
}

function assertAcyclic(
  relationships: UmlRelationship[],
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
      throwSemanticError('/diagram/relationships', `${kind} relationships cannot form a cycle.`);
    }
  }
}

function relationshipSignature(relationship: UmlRelationship, reversed = false): string {
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

function isManyMultiplicity(value: string): boolean {
  return (
    value === '*' ||
    value.endsWith('..*') ||
    (/^\d+$/.test(value) && BigInt(value) > 1n) ||
    (/^\d+\.\.\d+$/.test(value) && BigInt(value.split('..')[1]!) > 1n)
  );
}

function throwSemanticError(path: string, message: string): never {
  throw new CanonicalModelValidationError(
    `canonicalModel must satisfy UML semantic integrity ${UML_SCHEMA_VERSION}.`,
    [{ path, keyword: 'semantic', message }],
  );
}

function toSafeValidationError(error: ErrorObject): CanonicalValidationIssue {
  return {
    path: error.instancePath || '/',
    keyword: error.keyword,
    message: error.message ?? 'is invalid',
  };
}
