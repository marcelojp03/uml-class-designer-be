import { Injectable } from '@nestjs/common';
import type {
  CanonicalUmlModel,
  UmlClassifier,
  UmlCommand,
  UmlRelationship,
  UmlTypeReference,
} from './collaboration.types';

export class UmlCommandExecutionError extends Error {
  constructor() {
    super('The UML command cannot be applied to the current document.');
    this.name = 'UmlCommandExecutionError';
  }
}

const clone = <Value>(value: Value): Value => structuredClone(value);

@Injectable()
export class UmlCommandExecutor {
  execute(document: CanonicalUmlModel, command: UmlCommand): CanonicalUmlModel {
    const before = JSON.stringify(document.diagram);
    const next = clone(document);
    this.mutate(next, command);
    if (before === JSON.stringify(next.diagram)) {
      throw new UmlCommandExecutionError();
    }
    return next;
  }

  affectedElementIds(document: CanonicalUmlModel, command: UmlCommand): Set<string> {
    switch (command.type) {
      case 'classifier.create':
      case 'classifier.duplicate':
        return new Set([command.classifier.id]);
      case 'classifier.update': {
        const classifier = this.findClassifier(document, command.elementId);
        const affected = new Set([command.elementId]);
        if (classifier.name !== command.classifier.name) {
          for (const candidate of document.diagram.elements) {
            if (this.referencesClassifier(candidate, command.elementId)) {
              affected.add(candidate.id);
            }
          }
        }
        return affected;
      }
      case 'classifier.delete':
      case 'diagram.clear':
        return new Set(document.diagram.elements.map((element) => element.id));
      case 'classifier.move':
        return new Set([command.elementId]);
      case 'attribute.add':
      case 'attribute.update':
      case 'attribute.delete':
      case 'operation.add':
      case 'operation.update':
      case 'operation.delete':
        return new Set([command.classifierId]);
      case 'relationship.create':
        return this.relationshipElementIds(command.relationship);
      case 'relationship.update': {
        const existing = this.findRelationship(document, command.relationshipId);
        return this.relationshipElementIds(existing, command.relationship);
      }
      case 'relationship.delete': {
        const relationship = this.findRelationship(document, command.relationshipId);
        return relationship.associationClassId
          ? new Set(document.diagram.elements.map((element) => element.id))
          : this.relationshipElementIds(relationship);
      }
      case 'association-class.create': {
        const relationship = this.findRelationship(document, command.relationshipId);
        return new Set([
          relationship.source.elementId,
          relationship.target.elementId,
          command.classifier.id,
        ]);
      }
    }
  }

  private mutate(document: CanonicalUmlModel, command: UmlCommand): void {
    switch (command.type) {
      case 'classifier.create':
        this.assertMissingClassifier(document, command.classifier.id);
        this.assertPosition(command.position.elementId, command.classifier.id);
        document.diagram.elements.push(clone(command.classifier));
        document.diagram.visual.positions.push(clone(command.position));
        return;
      case 'classifier.update': {
        const index = this.classifierIndex(document, command.elementId);
        if (command.classifier.id !== command.elementId) {
          throw new UmlCommandExecutionError();
        }
        const previousName = document.diagram.elements[index]!.name;
        document.diagram.elements[index] = clone(command.classifier);
        if (previousName !== command.classifier.name) {
          this.syncTypeReferenceNames(document, command.elementId, command.classifier.name);
        }
        return;
      }
      case 'classifier.move': {
        this.findClassifier(document, command.elementId);
        const position = document.diagram.visual.positions.find(
          (item) => item.elementId === command.elementId,
        );
        if (!position) {
          throw new UmlCommandExecutionError();
        }
        position.x = command.position.x;
        position.y = command.position.y;
        return;
      }
      case 'classifier.delete':
        this.findClassifier(document, command.elementId);
        this.removeClassifiersAndReferences(document, new Set([command.elementId]));
        return;
      case 'classifier.duplicate':
        this.findClassifier(document, command.sourceElementId);
        this.assertMissingClassifier(document, command.classifier.id);
        this.assertPosition(command.position.elementId, command.classifier.id);
        document.diagram.elements.push(clone(command.classifier));
        document.diagram.visual.positions.push(clone(command.position));
        return;
      case 'attribute.add':
        this.findClassifier(document, command.classifierId).attributes.push(
          clone(command.attribute),
        );
        return;
      case 'attribute.update': {
        const classifier = this.findClassifier(document, command.classifierId);
        const index = classifier.attributes.findIndex(
          (attribute) => attribute.id === command.attributeId,
        );
        if (index < 0 || command.attribute.id !== command.attributeId) {
          throw new UmlCommandExecutionError();
        }
        classifier.attributes[index] = clone(command.attribute);
        return;
      }
      case 'attribute.delete': {
        const classifier = this.findClassifier(document, command.classifierId);
        const index = classifier.attributes.findIndex(
          (attribute) => attribute.id === command.attributeId,
        );
        if (index < 0) {
          throw new UmlCommandExecutionError();
        }
        classifier.attributes.splice(index, 1);
        return;
      }
      case 'operation.add':
        this.findClassifier(document, command.classifierId).operations.push(
          clone(command.operation),
        );
        return;
      case 'operation.update': {
        const classifier = this.findClassifier(document, command.classifierId);
        const index = classifier.operations.findIndex(
          (operation) => operation.id === command.operationId,
        );
        if (index < 0 || command.operation.id !== command.operationId) {
          throw new UmlCommandExecutionError();
        }
        classifier.operations[index] = clone(command.operation);
        return;
      }
      case 'operation.delete': {
        const classifier = this.findClassifier(document, command.classifierId);
        const index = classifier.operations.findIndex(
          (operation) => operation.id === command.operationId,
        );
        if (index < 0) {
          throw new UmlCommandExecutionError();
        }
        classifier.operations.splice(index, 1);
        return;
      }
      case 'relationship.create':
        if (document.diagram.relationships.some((item) => item.id === command.relationship.id)) {
          throw new UmlCommandExecutionError();
        }
        document.diagram.relationships.push(clone(command.relationship));
        return;
      case 'relationship.update': {
        const index = this.relationshipIndex(document, command.relationshipId);
        if (command.relationship.id !== command.relationshipId) {
          throw new UmlCommandExecutionError();
        }
        document.diagram.relationships[index] = clone(command.relationship);
        return;
      }
      case 'relationship.delete':
        this.deleteRelationshipAggregate(document, command.relationshipId);
        return;
      case 'association-class.create': {
        const index = this.relationshipIndex(document, command.relationshipId);
        const relationship = document.diagram.relationships[index]!;
        if (
          relationship.kind !== 'association' ||
          relationship.associationClassId ||
          !this.isManyMultiplicity(relationship.source.multiplicity) ||
          !this.isManyMultiplicity(relationship.target.multiplicity)
        ) {
          throw new UmlCommandExecutionError();
        }
        this.assertMissingClassifier(document, command.classifier.id);
        this.assertPosition(command.position.elementId, command.classifier.id);
        document.diagram.elements.push(clone(command.classifier));
        document.diagram.visual.positions.push(clone(command.position));
        document.diagram.relationships[index] = {
          ...relationship,
          associationClassId: command.classifier.id,
        };
        return;
      }
      case 'diagram.clear':
        document.diagram.elements = [];
        document.diagram.relationships = [];
        document.diagram.visual.positions = [];
    }
  }

  private classifierIndex(document: CanonicalUmlModel, elementId: string): number {
    const index = document.diagram.elements.findIndex((element) => element.id === elementId);
    if (index < 0) {
      throw new UmlCommandExecutionError();
    }
    return index;
  }

  private relationshipIndex(document: CanonicalUmlModel, relationshipId: string): number {
    const index = document.diagram.relationships.findIndex((item) => item.id === relationshipId);
    if (index < 0) {
      throw new UmlCommandExecutionError();
    }
    return index;
  }

  private findClassifier(document: CanonicalUmlModel, elementId: string): UmlClassifier {
    return document.diagram.elements[this.classifierIndex(document, elementId)]!;
  }

  private findRelationship(document: CanonicalUmlModel, relationshipId: string): UmlRelationship {
    return document.diagram.relationships[this.relationshipIndex(document, relationshipId)]!;
  }

  private assertMissingClassifier(document: CanonicalUmlModel, elementId: string): void {
    if (document.diagram.elements.some((element) => element.id === elementId)) {
      throw new UmlCommandExecutionError();
    }
  }

  private assertPosition(positionElementId: string, classifierId: string): void {
    if (positionElementId !== classifierId) {
      throw new UmlCommandExecutionError();
    }
  }

  private syncTypeReferenceNames(
    document: CanonicalUmlModel,
    elementId: string,
    name: string,
  ): void {
    for (const classifier of document.diagram.elements) {
      for (const attribute of classifier.attributes) {
        this.syncTypeName(attribute.type, elementId, name);
      }
      for (const operation of classifier.operations) {
        this.syncTypeName(operation.returnType, elementId, name);
        for (const parameter of operation.parameters) {
          this.syncTypeName(parameter.type, elementId, name);
        }
      }
    }
  }

  private referencesClassifier(classifier: UmlClassifier, elementId: string): boolean {
    return (
      classifier.attributes.some((attribute) => attribute.type.elementId === elementId) ||
      classifier.operations.some(
        (operation) =>
          operation.returnType.elementId === elementId ||
          operation.parameters.some((parameter) => parameter.type.elementId === elementId),
      )
    );
  }

  private syncTypeName(reference: UmlTypeReference, elementId: string, name: string): void {
    if (reference.elementId === elementId) {
      reference.name = name;
    }
  }

  private removeClassifiersAndReferences(
    document: CanonicalUmlModel,
    initialIds: Set<string>,
  ): void {
    const deletedIds = new Set(initialIds);
    const deletedRelationshipIds = new Set<string>();
    let changed = true;

    while (changed) {
      changed = false;
      for (const relationship of document.diagram.relationships) {
        if (
          deletedRelationshipIds.has(relationship.id) ||
          (!deletedIds.has(relationship.source.elementId) &&
            !deletedIds.has(relationship.target.elementId))
        ) {
          continue;
        }
        deletedRelationshipIds.add(relationship.id);
        if (relationship.associationClassId && !deletedIds.has(relationship.associationClassId)) {
          deletedIds.add(relationship.associationClassId);
        }
        changed = true;
      }
    }

    document.diagram.elements = document.diagram.elements.filter(
      (item) => !deletedIds.has(item.id),
    );
    document.diagram.visual.positions = document.diagram.visual.positions.filter(
      (item) => !deletedIds.has(item.elementId),
    );
    document.diagram.relationships = document.diagram.relationships
      .filter((item) => !deletedRelationshipIds.has(item.id))
      .map((relationship) => {
        if (!relationship.associationClassId || !deletedIds.has(relationship.associationClassId)) {
          return relationship;
        }
        const { associationClassId: _associationClassId, ...withoutAssociationClass } =
          relationship;
        return withoutAssociationClass;
      });

    for (const classifier of document.diagram.elements) {
      for (const attribute of classifier.attributes) {
        this.removeTypeReference(attribute.type, deletedIds);
      }
      for (const operation of classifier.operations) {
        this.removeTypeReference(operation.returnType, deletedIds);
        for (const parameter of operation.parameters) {
          this.removeTypeReference(parameter.type, deletedIds);
        }
      }
    }
  }

  private deleteRelationshipAggregate(document: CanonicalUmlModel, relationshipId: string): void {
    const index = this.relationshipIndex(document, relationshipId);
    const relationship = document.diagram.relationships[index]!;
    document.diagram.relationships.splice(index, 1);
    if (relationship.associationClassId) {
      this.removeClassifiersAndReferences(document, new Set([relationship.associationClassId]));
    }
  }

  private removeTypeReference(reference: UmlTypeReference, deletedIds: Set<string>): void {
    if (reference.elementId && deletedIds.has(reference.elementId)) {
      delete reference.elementId;
    }
  }

  private relationshipElementIds(...relationships: UmlRelationship[]): Set<string> {
    const ids = new Set<string>();
    for (const relationship of relationships) {
      ids.add(relationship.source.elementId);
      ids.add(relationship.target.elementId);
      if (relationship.associationClassId) {
        ids.add(relationship.associationClassId);
      }
    }
    return ids;
  }

  private isManyMultiplicity(value: string): boolean {
    return (
      value === '*' ||
      value.endsWith('..*') ||
      (/^\d+$/.test(value) && BigInt(value) > 1n) ||
      (/^\d+\.\.\d+$/.test(value) && BigInt(value.split('..')[1]!) > 1n)
    );
  }
}
