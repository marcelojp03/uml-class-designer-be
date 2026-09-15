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

  it('defines document:operation without ok and rejects missing or extra properties', () => {
    const command = commandPayload();
    const operationEvent = {
      operationId: command.operationId,
      documentId: command.documentId,
      actorId: randomUUID(),
      baseRevision: 0,
      revision: 1,
      command: command.command,
      committedAt: '2026-09-08T12:00:00.000Z',
    };
    expect(validateOperationEvent(operationEvent)).toBe(true);

    const withoutActor = { ...operationEvent } as Record<string, unknown>;
    delete withoutActor.actorId;
    expect(validateOperationEvent(withoutActor)).toBe(false);

    expect(validateOperationEvent({ ...operationEvent, ok: true })).toBe(false);
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

  it('keeps protocol 1.0.0: additive ACK defs without wire changes', () => {
    // Las definiciones documentLeaveAck, presenceUpdateAck, lockLeaseAck y
    // lockReleaseAck solo formalizan respuestas que el gateway ya emitía; ningún
    // payload del cable cambia, por eso la versión mayor/menor se conserva.
    expect(collaborationSchema.$id.endsWith('/1.0.0')).toBe(true);
    const defs = (collaborationSchema as unknown as { $defs?: Record<string, unknown> }).$defs;
    for (const name of [
      'documentLeaveAck',
      'presenceUpdateAck',
      'lockLeaseAck',
      'lockReleaseAck',
    ]) {
      expect(defs?.[name]).toBeDefined();
    }
  });

  it('defines leave, presence and lock ACKs with exact required keys', () => {
    const validate = (name: string) => {
      const validator = ajv.getSchema(`${collaborationSchema.$id}#/$defs/${name}`);
      if (!validator) throw new Error(`El contrato no define $defs/${name}.`);
      return validator;
    };
    const documentId = randomUUID();
    const participant = {
      userId: randomUUID(),
      socketId: 'socket-1',
      joinedAt: '2026-09-08T12:00:00.000Z',
      lastSeen: '2026-09-08T12:00:00.000Z',
    };
    const lock = {
      documentId,
      elementId: 'person',
      userId: participant.userId,
      socketId: participant.socketId,
      leaseId: randomUUID(),
      expiresAt: '2026-09-08T12:00:00.000Z',
    };
    const leaveAck = { ok: true, documentId };
    expect(validate('documentLeaveAck')(leaveAck)).toBe(true);
    const presenceAck = { ok: true, documentId, participants: [participant] };
    expect(validate('presenceUpdateAck')(presenceAck)).toBe(true);
    const leaseAck = { ok: true, lock, locks: [lock] };
    expect(validate('lockLeaseAck')(leaseAck)).toBe(true);
    const releaseAck = { ok: true, documentId, locks: [lock] };
    expect(validate('lockReleaseAck')(releaseAck)).toBe(true);

    for (const [name, valid] of [
      ['documentLeaveAck', leaveAck],
      ['presenceUpdateAck', presenceAck],
      ['lockLeaseAck', leaseAck],
      ['lockReleaseAck', releaseAck],
    ] as const) {
      const validator = validate(name);
      expect(validator({ ...valid, intruso: true })).toBe(false);
      const missing = { ...valid } as Record<string, unknown>;
      delete missing[Object.keys(valid)[1]!];
      expect(validator(missing)).toBe(false);
      expect(validator({ ...valid, ok: false })).toBe(false);
    }
  });

  it('documents Failure as the wire alternative for every new ACK', () => {
    const validateFailure = ajv.getSchema(`${collaborationSchema.$id}#/$defs/failure`)!;
    // Respuesta de error real del gateway ante leave sin join previo.
    expect(validateFailure({ ok: false, code: 'NOT_JOINED', message: 'x' })).toBe(true);
  });

  it('keeps the transport contract independent from React Flow snapshots and JSON Patch', () => {
    const schemaText = readFileSync(
      resolve(process.cwd(), 'contracts/collaboration-protocol.schema.json'),
      'utf8',
    );

    expect(schemaText).not.toMatch(/react.?flow|@xyflow|json.?patch|"nodes"|"edges"/i);
  });
});
