import { BadRequestException } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CanonicalModelValidator } from './canonical-model.validator';

function loadFixture(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(resolve(process.cwd(), `contracts/fixtures/${name}`), 'utf8'),
  ) as Record<string, unknown>;
}

describe('CanonicalModelValidator', () => {
  const validator = new CanonicalModelValidator();

  it('accepts the canonical contract and normalizes server-owned revision metadata', () => {
    const updatedAt = new Date('2026-09-05T20:00:00.000Z');
    const result = validator.validateAndNormalize(
      loadFixture('valid-uml-model.json'),
      4,
      updatedAt,
    );

    expect(result).toMatchObject({
      schemaVersion: '0.1.0',
      metadata: { revision: 4, updatedAt: updatedAt.toISOString() },
    });
  });

  it('rejects invalid UML before persistence', () => {
    expect(() =>
      validator.validateAndNormalize(loadFixture('invalid-uml-model.json'), 0, new Date()),
    ).toThrow(BadRequestException);
  });

  it('rejects dangling graph references that JSON Schema cannot express', () => {
    const model = loadFixture('valid-uml-model.json');
    const diagram = model.diagram as {
      relationships: Array<{ target: { elementId: string } }>;
    };
    diagram.relationships[0]!.target.elementId = 'missing_classifier';

    expect(() => validator.validateAndNormalize(model, 0, new Date())).toThrow(BadRequestException);
  });

  it('rejects duplicate IDs and missing visual positions', () => {
    const duplicateId = loadFixture('valid-uml-model.json');
    const duplicateDiagram = duplicateId.diagram as {
      elements: Array<{ id: string }>;
    };
    duplicateDiagram.elements[1]!.id = duplicateDiagram.elements[0]!.id;
    expect(() => validator.validateAndNormalize(duplicateId, 0, new Date())).toThrow(
      BadRequestException,
    );

    const missingPosition = loadFixture('valid-uml-model.json');
    const visual = (missingPosition.diagram as { visual: { positions: unknown[] } }).visual;
    visual.positions.pop();
    expect(() => validator.validateAndNormalize(missingPosition, 0, new Date())).toThrow(
      BadRequestException,
    );
  });

  it('rejects semantically duplicate relationships with differently ordered endpoint keys', () => {
    const model = loadFixture('valid-uml-model.json');
    const diagram = model.diagram as {
      relationships: Array<{
        id: string;
        kind: string;
        name?: string;
        source: { elementId: string; role: string; multiplicity: string; navigable: boolean };
        target: { elementId: string; role: string; multiplicity: string; navigable: boolean };
      }>;
    };
    const original = diagram.relationships.find((relationship) => relationship.id === 'rel_orders');
    if (!original) {
      throw new Error('Expected the orders relationship fixture.');
    }
    diagram.relationships.push({
      id: 'rel_orders_reordered',
      kind: original.kind,
      name: original.name,
      source: {
        navigable: original.source.navigable,
        multiplicity: original.source.multiplicity,
        role: original.source.role,
        elementId: original.source.elementId,
      },
      target: {
        navigable: original.target.navigable,
        multiplicity: original.target.multiplicity,
        role: original.target.role,
        elementId: original.target.elementId,
      },
    });

    expect(() => validator.validateAndNormalize(model, 0, new Date())).toThrow(BadRequestException);
  });

  it('normalizes canonical resource IDs from persistence UUIDs', () => {
    const result = validator.validateAndNormalize(
      loadFixture('valid-uml-model.json'),
      0,
      new Date(),
      {
        projectId: '326F6B92-B38B-4F30-B1DD-D389D6D9BE38',
        documentId: 'CA816A96-D1B7-49B7-BFA6-B9A616D93D5C',
      },
    );

    expect(result).toMatchObject({
      project: { id: 'project_326f6b92b38b4f30b1ddd389d6d9be38' },
      diagram: { id: 'diagram_ca816a96d1b749b7bfa6b9a616d93d5c' },
    });
  });

  it('rejects persistence IDs that collide with canonical classifier IDs', () => {
    const model = loadFixture('valid-uml-model.json');
    const renamed = JSON.parse(
      JSON.stringify(model).replaceAll('"person"', '"project_collision"'),
    ) as Record<string, unknown>;

    expect(() =>
      validator.validateAndNormalize(renamed, 0, new Date(), {
        projectId: 'collision',
        documentId: 'document',
      }),
    ).toThrow(BadRequestException);
  });

  it('rejects whitespace-only semantic names', () => {
    const model = loadFixture('valid-uml-model.json');
    const diagram = model.diagram as { elements: Array<{ name: string }> };
    diagram.elements[0]!.name = '   ';

    expect(() => validator.validateAndNormalize(model, 0, new Date())).toThrow(BadRequestException);
  });
});
