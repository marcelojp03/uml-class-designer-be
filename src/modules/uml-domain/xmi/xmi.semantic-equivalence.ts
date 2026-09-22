import type { CanonicalUmlModel, UmlTypeReference } from '../collaboration.types';

interface SemanticTypeReference {
  collection: boolean;
  element?: string;
  name: string;
  nullable: boolean;
}

function semanticMultiplicity(value: string): string {
  return value === '*' ? '0..*' : value;
}

function projectType(
  reference: UmlTypeReference,
  namesById: ReadonlyMap<string, string>,
): SemanticTypeReference {
  return {
    collection: reference.collection ?? false,
    ...(reference.elementId
      ? { element: namesById.get(reference.elementId) ?? reference.elementId }
      : {}),
    name: reference.name,
    nullable: reference.nullable ?? false,
  };
}

export function semanticProjection(model: CanonicalUmlModel): Record<string, unknown> {
  const namesById = new Map(model.diagram.elements.map((element) => [element.id, element.name]));
  const elements = model.diagram.elements
    .map((element) => ({
      attributes: element.attributes
        .map((attribute) => ({
          defaultValue: attribute.defaultValue ?? null,
          isReadOnly: attribute.isReadOnly,
          isStatic: attribute.isStatic,
          name: attribute.name,
          type: projectType(attribute.type, namesById),
          visibility: attribute.visibility,
        }))
        .toSorted((left, right) => left.name.localeCompare(right.name, 'en')),
      isAbstract: element.kind === 'class' ? element.isAbstract : false,
      kind: element.kind,
      name: element.name,
      operations: element.operations
        .map((operation) => ({
          isAbstract: operation.isAbstract,
          isStatic: operation.isStatic,
          name: operation.name,
          parameters: operation.parameters.map((parameter) => ({
            defaultValue: parameter.defaultValue ?? null,
            name: parameter.name,
            type: projectType(parameter.type, namesById),
          })),
          returnType: projectType(operation.returnType, namesById),
          visibility: operation.visibility,
        }))
        .toSorted((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right), 'en')),
    }))
    .toSorted((left, right) => left.name.localeCompare(right.name, 'en'));
  const relationships = model.diagram.relationships
    .map((relationship) => ({
      associationClass: relationship.associationClassId
        ? (namesById.get(relationship.associationClassId) ?? relationship.associationClassId)
        : null,
      kind: relationship.kind,
      name: relationship.name ?? null,
      source: {
        element: namesById.get(relationship.source.elementId) ?? relationship.source.elementId,
        multiplicity: semanticMultiplicity(relationship.source.multiplicity),
        navigable: relationship.source.navigable,
        role: relationship.source.role,
      },
      target: {
        element: namesById.get(relationship.target.elementId) ?? relationship.target.elementId,
        multiplicity: semanticMultiplicity(relationship.target.multiplicity),
        navigable: relationship.target.navigable,
        role: relationship.target.role,
      },
    }))
    .toSorted((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right), 'en'));

  return {
    diagram: { elements, name: model.diagram.name, relationships },
    project: { name: model.project.name },
    schemaVersion: model.schemaVersion,
  };
}

export function semanticFingerprint(model: CanonicalUmlModel): string {
  return JSON.stringify(semanticProjection(model));
}

export function areSemanticallyEquivalent(
  left: CanonicalUmlModel,
  right: CanonicalUmlModel,
): boolean {
  return semanticFingerprint(left) === semanticFingerprint(right);
}
