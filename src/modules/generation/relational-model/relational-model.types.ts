export const RELATIONAL_MODEL_SCHEMA_VERSION = '0.1.0' as const;
export const UML_SOURCE_SCHEMA_VERSION = '0.1.0' as const;

export type RelationalDiagnosticSeverity = 'ERROR' | 'WARNING' | 'INFO';

export type RelationalTableKind = 'entity' | 'join' | 'association-class' | 'collection';

export type RelationalOnDelete = 'NO_ACTION' | 'CASCADE' | 'SET_NULL';

export interface RelationalDiagnostic {
  severity: RelationalDiagnosticSeverity;
  code: string;
  message: string;
  path?: string;
  sourceIds?: string[];
}

export interface RelationalTraceability {
  sourceIds: string[];
  sourcePaths: string[];
  rule: string;
}

export interface RelationalColumn {
  id: string;
  logicalName: string;
  physicalName: string;
  javaPropertyName: string;
  javaType: string;
  postgresType: string;
  umlType: string;
  nullable: boolean;
  primaryKey: boolean;
  generated?: 'UUID';
  defaultValue?: string;
  source: RelationalTraceability;
}

export interface RelationalPrimaryKey {
  id: string;
  physicalName: string;
  columnIds: string[];
  source: RelationalTraceability;
}

export interface RelationalUniqueConstraint {
  id: string;
  physicalName: string;
  columnIds: string[];
  source: RelationalTraceability;
}

export interface RelationalForeignKey {
  id: string;
  physicalName: string;
  columnIds: string[];
  referencedTableId: string;
  referencedColumnIds: string[];
  sourceMultiplicity?: string;
  targetMultiplicity?: string;
  onDelete: RelationalOnDelete;
  source: RelationalTraceability;
}

export interface RelationalInheritance {
  strategy: 'JOINED';
  role: 'root' | 'subclass';
  parentTableId?: string;
  parentColumnIds?: string[];
  source: RelationalTraceability;
}

export interface RelationalTable {
  id: string;
  logicalName: string;
  physicalName: string;
  javaEntityName: string;
  kind: RelationalTableKind;
  isAbstract?: boolean;
  sourceClassifierId?: string;
  sourceRelationshipId?: string;
  columns: RelationalColumn[];
  primaryKey: RelationalPrimaryKey;
  foreignKeys: RelationalForeignKey[];
  uniqueConstraints: RelationalUniqueConstraint[];
  inheritance?: RelationalInheritance;
  source: RelationalTraceability;
}

export interface RelationalModel {
  schemaVersion: typeof RELATIONAL_MODEL_SCHEMA_VERSION;
  sourceSchemaVersion: typeof UML_SOURCE_SCHEMA_VERSION;
  project: {
    id: string;
    name: string;
  };
  conventions: {
    naming: 'snake_case';
    identifierMaxLength: 63;
    inheritanceStrategy: 'JOINED';
    identifierStrategy: 'attribute-id-or-synthetic-uuid';
  };
  tables: RelationalTable[];
  diagnostics: RelationalDiagnostic[];
}
