import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import type { AnySchema } from 'ajv';
import { randomUUID } from 'node:crypto';

function loadJson(relativePath: string): unknown {
  return JSON.parse(readFileSync(resolve(process.cwd(), relativePath), 'utf8')) as unknown;
}

function commandPayload() {
  return {
    operationId: randomUUID(),
    documentId: randomUUID(),
    baseRevision: 0,
    command: {
      type: 'classifier.move',
      timestamp: '2026-09-08T12:00:00.000Z',
      elementId: 'person',
      position: { x: 120, y: 240 },
    },
  };
}

describe('collaboration protocol contract', () => {
  const canonicalSchema = loadJson('contracts/uml-model.schema.json') as AnySchema;
  const collaborationSchema = loadJson(
    'contracts/collaboration-protocol.schema.json',
  ) as AnySchema & {
    $id: string;
  };
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  ajv.addSchema(canonicalSchema);
  ajv.addSchema(collaborationSchema);
  const validateCommand = ajv.getSchema(`${collaborationSchema.$id}#/$defs/documentCommand`)!;
  const validateOperationEvent = ajv.getSchema(
    `${collaborationSchema.$id}#/$defs/documentOperationEvent`,
  )!;
  const validateResyncRequired = ajv.getSchema(`${collaborationSchema.$id}#/$defs/resyncRequired`)!;

  it('accepts an incremental, version-compatible command payload', () => {
    expect(validateCommand(commandPayload())).toBe(true);
    expect(validateCommand.errors).toBeNull();
  });

  it('defines typed outbound command and resynchronization events', () => {
    const command = commandPayload();
    expect(
      validateOperationEvent({
        operationId: command.operationId,
        documentId: command.documentId,
        actorId: randomUUID(),
        baseRevision: 0,
        revision: 1,
        command: command.command,
        committedAt: '2026-09-08T12:00:00.000Z',
      }),
    ).toBe(true);
    expect(
      validateResyncRequired({
        documentId: command.documentId,
        revision: 1,
        resyncRequired: true,
      }),
    ).toBe(true);
  });

  it('rejects malformed operation identifiers, unknown commands, and arbitrary payload properties', () => {
    const malformedOperationId = commandPayload() as Record<string, unknown>;
    malformedOperationId.operationId = 'not-a-uuid';
    expect(validateCommand(malformedOperationId)).toBe(false);

    const unknownCommand = commandPayload() as {
      command: Record<string, unknown>;
    };
    unknownCommand.command.type = 'model.replace';
    expect(validateCommand(unknownCommand)).toBe(false);

    const arbitraryProperty = commandPayload() as Record<string, unknown>;
    arbitraryProperty.untrustedModel = { nodes: [], edges: [] };
    expect(validateCommand(arbitraryProperty)).toBe(false);
  });

  it('keeps the transport contract independent from React Flow snapshots and JSON Patch', () => {
    const schemaText = readFileSync(
      resolve(process.cwd(), 'contracts/collaboration-protocol.schema.json'),
      'utf8',
    );

    expect(schemaText).not.toMatch(/react.?flow|@xyflow|json.?patch|"nodes"|"edges"/i);
  });
});
