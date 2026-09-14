export interface CollaborationIdentity {
  userId: string;
  sessionId: string;
  accessTokenExpiresAt: number;
}

export interface UmlTypeReference {
  name: string;
  elementId?: string;
  collection?: boolean;
  nullable?: boolean;
}

export interface UmlParameter {
  id: string;
  name: string;
  type: UmlTypeReference;
  defaultValue?: string;
}

export interface UmlAttribute {
  id: string;
  name: string;
  visibility: 'public' | 'protected' | 'private' | 'package';
  type: UmlTypeReference;
  isStatic: boolean;
  isReadOnly: boolean;
  defaultValue?: string;
}

export interface UmlOperation {
  id: string;
  name: string;
  visibility: 'public' | 'protected' | 'private' | 'package';
  parameters: UmlParameter[];
  returnType: UmlTypeReference;
  isAbstract: boolean;
  isStatic: boolean;
}

interface UmlClassifierBase {
  id: string;
  name: string;
  stereotypes?: string[];
  attributes: UmlAttribute[];
  operations: UmlOperation[];
}

export interface UmlClass extends UmlClassifierBase {
  kind: 'class';
  isAbstract: boolean;
}

export interface UmlInterface extends UmlClassifierBase {
  kind: 'interface';
}

export type UmlClassifier = UmlClass | UmlInterface;

export interface UmlPosition {
  elementId: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
}

export interface UmlRelationshipEnd {
  elementId: string;
  role: string;
  multiplicity: string;
  navigable: boolean;
}

export interface UmlRelationship {
  id: string;
  kind:
    | 'association'
    | 'aggregation'
    | 'composition'
    | 'generalization'
    | 'realization'
    | 'dependency';
  name?: string;
  source: UmlRelationshipEnd;
  target: UmlRelationshipEnd;
  associationClassId?: string;
}

export interface CanonicalUmlModel {
  schemaVersion: '0.1.0';
  project: { id: string; name: string; description?: string };
  diagram: {
    id: string;
    name: string;
    elements: UmlClassifier[];
    relationships: UmlRelationship[];
    visual: { positions: UmlPosition[] };
  };
  metadata: { createdAt: string; updatedAt: string; revision: number; tags?: string[] };
}

interface UmlCommandBase {
  timestamp: string;
}

export type UmlCommand =
  | (UmlCommandBase & {
      type: 'classifier.create';
      classifier: UmlClassifier;
      position: UmlPosition;
    })
  | (UmlCommandBase & {
      type: 'classifier.update';
      elementId: string;
      classifier: UmlClassifier;
    })
  | (UmlCommandBase & {
      type: 'classifier.move';
      elementId: string;
      position: { x: number; y: number };
    })
  | (UmlCommandBase & { type: 'classifier.delete'; elementId: string })
  | (UmlCommandBase & {
      type: 'classifier.duplicate';
      sourceElementId: string;
      classifier: UmlClassifier;
      position: UmlPosition;
    })
  | (UmlCommandBase & { type: 'attribute.add'; classifierId: string; attribute: UmlAttribute })
  | (UmlCommandBase & {
      type: 'attribute.update';
      classifierId: string;
      attributeId: string;
      attribute: UmlAttribute;
    })
  | (UmlCommandBase & { type: 'attribute.delete'; classifierId: string; attributeId: string })
  | (UmlCommandBase & { type: 'operation.add'; classifierId: string; operation: UmlOperation })
  | (UmlCommandBase & {
      type: 'operation.update';
      classifierId: string;
      operationId: string;
      operation: UmlOperation;
    })
  | (UmlCommandBase & { type: 'operation.delete'; classifierId: string; operationId: string })
  | (UmlCommandBase & { type: 'relationship.create'; relationship: UmlRelationship })
  | (UmlCommandBase & {
      type: 'relationship.update';
      relationshipId: string;
      relationship: UmlRelationship;
    })
  | (UmlCommandBase & { type: 'relationship.delete'; relationshipId: string })
  | (UmlCommandBase & {
      type: 'association-class.create';
      relationshipId: string;
      classifier: UmlClass;
      position: UmlPosition;
    })
  | (UmlCommandBase & { type: 'diagram.clear' });

export interface DocumentJoinPayload {
  documentId: string;
  knownRevision?: number;
}

export interface DocumentLeavePayload {
  documentId: string;
}

export interface DocumentCommandPayload {
  operationId: string;
  documentId: string;
  baseRevision: number;
  command: UmlCommand;
}

export interface PresenceUpdatePayload {
  documentId: string;
  selection?: string[];
  cursor?: { x: number; y: number };
}

export interface ElementLockPayload {
  documentId: string;
  elementId: string;
}

export interface ElementLockLeasePayload extends ElementLockPayload {
  leaseId: string;
}

export interface CollaborationParticipant {
  userId: string;
  socketId: string;
  joinedAt: string;
  lastSeen: string;
  selection?: string[];
  cursor?: { x: number; y: number };
}

export interface ElementLock {
  documentId: string;
  elementId: string;
  userId: string;
  socketId: string;
  leaseId: string;
  expiresAt: string;
}

export type CollaborationErrorCode =
  | 'UNAUTHENTICATED'
  | 'SESSION_REVOKED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'NOT_JOINED'
  | 'INVALID_COMMAND'
  | 'INVALID_MODEL'
  | 'REVISION_CONFLICT'
  | 'ELEMENT_LOCKED'
  | 'OPERATION_ID_REUSED'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR';

export interface CollaborationFailure {
  ok: false;
  operationId?: string;
  code: CollaborationErrorCode;
  message: string;
  currentRevision?: number;
  resyncRequired?: boolean;
}

export interface CommandAcceptedAck {
  ok: true;
  operationId: string;
  documentId: string;
  revision: number;
  committedAt: string;
}

export interface DocumentOperationEvent extends CommandAcceptedAck {
  actorId: string;
  baseRevision: number;
  command: UmlCommand;
}
