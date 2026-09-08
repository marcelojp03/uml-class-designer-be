import { Injectable } from '@nestjs/common';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AnySchema, ValidateFunction } from 'ajv';
import type {
  DocumentCommandPayload,
  DocumentJoinPayload,
  DocumentLeavePayload,
  ElementLockLeasePayload,
  ElementLockPayload,
  PresenceUpdatePayload,
} from './collaboration.types';

export class CollaborationPayloadError extends Error {
  constructor() {
    super('The collaboration payload is invalid.');
    this.name = 'CollaborationPayloadError';
  }
}

type PayloadName =
  | 'documentJoin'
  | 'documentLeave'
  | 'documentCommand'
  | 'presenceUpdate'
  | 'lockAcquire'
  | 'lockRenew'
  | 'lockRelease';

type CollaborationPayloadByName = {
  documentJoin: DocumentJoinPayload;
  documentLeave: DocumentLeavePayload;
  documentCommand: DocumentCommandPayload;
  presenceUpdate: PresenceUpdatePayload;
  lockAcquire: ElementLockPayload;
  lockRenew: ElementLockLeasePayload;
  lockRelease: ElementLockLeasePayload;
};

@Injectable()
export class CollaborationContractValidator {
  private readonly validators: Record<PayloadName, ValidateFunction>;

  constructor() {
    const canonicalSchema = this.readSchema('contracts/uml-model.schema.json');
    const collaborationSchema = this.readSchema('contracts/collaboration-protocol.schema.json');
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    ajv.addSchema(canonicalSchema);
    ajv.addSchema(collaborationSchema);

    this.validators = {
      documentJoin: ajv.getSchema(`${collaborationSchema.$id}#/$defs/documentJoin`),
      documentLeave: ajv.getSchema(`${collaborationSchema.$id}#/$defs/documentLeave`),
      documentCommand: ajv.getSchema(`${collaborationSchema.$id}#/$defs/documentCommand`),
      presenceUpdate: ajv.getSchema(`${collaborationSchema.$id}#/$defs/presenceUpdate`),
      lockAcquire: ajv.getSchema(`${collaborationSchema.$id}#/$defs/lockAcquire`),
      lockRenew: ajv.getSchema(`${collaborationSchema.$id}#/$defs/lockRenew`),
      lockRelease: ajv.getSchema(`${collaborationSchema.$id}#/$defs/lockRelease`),
    } as Record<PayloadName, ValidateFunction>;
  }

  validate<Name extends PayloadName>(
    name: Name,
    payload: unknown,
  ): CollaborationPayloadByName[Name] {
    const validator = this.validators[name];
    if (!validator(payload)) {
      throw new CollaborationPayloadError();
    }
    return structuredClone(payload) as CollaborationPayloadByName[Name];
  }

  private readSchema(relativePath: string): AnySchema & { $id: string } {
    return JSON.parse(readFileSync(resolve(process.cwd(), relativePath), 'utf8')) as AnySchema & {
      $id: string;
    };
  }
}
