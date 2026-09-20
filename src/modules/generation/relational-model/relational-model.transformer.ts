import {
  CanonicalModelValidationError,
  validateCanonicalModel,
} from '../../uml-domain/canonical-model.validation';
import type {
  CanonicalUmlModel,
  UmlAttribute,
  UmlClass,
  UmlClassifier,
  UmlRelationship,
  UmlRelationshipEnd,
  UmlTypeReference,
} from '../../uml-domain/collaboration.types';
import {
  assertRelationalModelContract,
  RelationalModelContractError,
} from './relational-model.validator';
import type {
  RelationalColumn,
  RelationalDiagnostic,
  RelationalForeignKey,
  RelationalModel,
  RelationalOnDelete,
  RelationalPrimaryKey,
  RelationalTable,
  RelationalTraceability,
  RelationalUniqueConstraint,
} from './relational-model.types';
import {
  RELATIONAL_MODEL_SCHEMA_VERSION,
  UML_SOURCE_SCHEMA_VERSION,
} from './relational-model.types';

interface ScalarType {
  javaType: string;
  postgresType: string;
}

interface MultiplicityBounds {
  lower: bigint;
  upper: bigint | null;
}

const JAVA_RESERVED_WORDS = new Set([
  'abstract',
  'assert',
  'boolean',
  'break',
  'byte',
  'case',
  'catch',
  'char',
  'class',
  'const',
  'continue',
  'default',
  'do',
  'double',
  'else',
  'enum',
  'extends',
  'final',
  'finally',
  'float',
  'for',
  'goto',
  'if',
  'implements',
  'import',
  'instanceof',
  'int',
  'interface',
  'long',
  'native',
  'new',
  'package',
  'private',
  'protected',
  'public',
  'return',
  'short',
  'static',
  'strictfp',
  'super',
  'switch',
  'synchronized',
  'this',
  'throw',
  'throws',
  'transient',
  'try',
  'void',
  'volatile',
  'while',
  'true',
  'false',
  'null',
]);

const POSTGRES_RESERVED_WORDS = new Set([
  'all',
  'analyse',
  'and',
  'any',
  'array',
  'as',
  'asc',
  'authorization',
  'between',
  'binary',
  'both',
  'case',
  'cast',
  'check',
  'class',
  'collate',
  'column',
  'constraint',
  'create',
  'current_catalog',
  'current_date',
  'current_role',
  'current_schema',
  'current_time',
  'current_timestamp',
  'current_user',
  'default',
  'deferrable',
  'desc',
  'distinct',
  'do',
  'else',
  'end',
  'except',
  'false',
  'fetch',
  'for',
  'foreign',
  'from',
  'grant',
  'group',
  'having',
  'in',
  'initially',
  'intersect',
  'into',
  'is',
  'isnull',
  'join',
  'leading',
  'limit',
  'localtime',
  'localtimestamp',
  'new',
  'not',
  'null',
  'offset',
  'old',
  'on',
  'only',
  'or',
  'order',
  'placing',
  'primary',
  'references',
  'returning',
  'select',
  'session_user',
  'some',
  'symmetric',
  'table',
  'then',
  'to',
  'trailing',
  'true',
  'union',
  'unique',
  'user',
  'using',
  'variadic',
  'verbose',
  'when',
  'where',
  'window',
  'with',
]);

export class RelationalModelGenerationError extends Error {
  constructor(readonly diagnostics: RelationalDiagnostic[]) {
    super('Relational model generation failed.');
    this.name = 'RelationalModelGenerationError';
  }
}

export function generateRelationalModel(input: unknown): RelationalModel {
  let canonical: CanonicalUmlModel;
  try {
    canonical = validateCanonicalModel(input);
  } catch (error) {
    if (error instanceof CanonicalModelValidationError) {
      throw new RelationalModelGenerationError(
        error.validationErrors.map((issue) => ({
          severity: 'ERROR',
          code:
            issue.keyword === 'semantic'
              ? 'CANONICAL_SEMANTIC_INVALID'
              : 'CANONICAL_SCHEMA_INVALID',
          message: issue.message,
          path: issue.path,
        })),
      );
    }
    throw error;
  }

  const state = new BuildState(canonical);
  try {
    buildEntityTables(state);
    buildAssociationClassTables(state);
    buildClassifierAttributes(state);
    buildRelationships(state);
    const model = state.toModel();
    assertRelationalModelContract(model);
    return model;
  } catch (error) {
    if (error instanceof RelationalModelGenerationError) {
      throw error;
    }
    if (error instanceof RelationalModelContractError) {
      throw new RelationalModelGenerationError(
        error.validationErrors.map((issue) => ({
          severity: 'ERROR',
          code: 'RELATIONAL_CONTRACT_INVALID',
          message: issue.message,
          path: issue.path,
        })),
      );
    }
    throw error;
  }
}

export const transformCanonicalModel = generateRelationalModel;

export function serializeRelationalModel(model: RelationalModel): string {
  assertRelationalModelContract(model);
  return `${JSON.stringify(sortJsonKeys(model))}\n`;
}

class BuildState {
  readonly classifiers = new Map<string, UmlClassifier>();
  readonly classifierTables = new Map<string, RelationalTable>();
  readonly tables = new Map<string, RelationalTable>();
  readonly tableNameOwners = new Map<string, string>();
  readonly javaEntityNameOwners = new Map<string, string>();
  readonly diagnostics: RelationalDiagnostic[] = [];

  constructor(readonly canonical: CanonicalUmlModel) {
    for (const element of canonical.diagram.elements) {
      this.classifiers.set(element.id, element);
    }
  }

  addTable(table: RelationalTable): RelationalTable {
    if (this.tables.has(table.id)) {
      this.fail({
        severity: 'ERROR',
        code: 'ARTIFACT_ID_COLLISION',
        message: `Generated table artifact ${table.id} is duplicated.`,
        sourceIds: table.source.sourceIds,
      });
    }
    const existingOwner = this.tableNameOwners.get(table.physicalName);
    if (existingOwner && existingOwner !== table.id) {
      const resolvedPhysicalName = appendStableHash(table.physicalName, table.id);
      if (this.tableNameOwners.has(resolvedPhysicalName)) {
        this.fail({
          severity: 'ERROR',
          code: 'PHYSICAL_TABLE_NAME_COLLISION',
          message: `Classes map to the same physical table name ${table.physicalName}.`,
          path: table.source.sourcePaths[0],
          sourceIds: [...table.source.sourceIds, existingOwner],
        });
      }
      const existingTable = this.tables.get(existingOwner);
      this.warning(
        'PHYSICAL_TABLE_NAME_COLLISION_RESOLVED',
        `Physical table name ${table.physicalName} was disambiguated with a stable hash.`,
        table.source.sourcePaths[0]!,
        [...table.source.sourceIds, ...(existingTable?.source.sourceIds ?? [])],
      );
      table = {
        ...table,
        physicalName: resolvedPhysicalName,
        primaryKey: {
          ...table.primaryKey,
          physicalName: constraintName(`pk_${resolvedPhysicalName}`),
        },
      };
    }
    const existingJavaOwner = this.javaEntityNameOwners.get(table.javaEntityName);
    if (existingJavaOwner && existingJavaOwner !== table.id) {
      const resolvedJavaEntityName = appendStableJavaNameHash(table.javaEntityName, table.id);
      if (this.javaEntityNameOwners.has(resolvedJavaEntityName)) {
        this.fail({
          severity: 'ERROR',
          code: 'JAVA_ENTITY_NAME_COLLISION',
          message: `Classes map to the same Java entity name ${table.javaEntityName}.`,
          path: table.source.sourcePaths[0],
          sourceIds: [...table.source.sourceIds, existingJavaOwner],
        });
      }
      const existingJavaTable = this.tables.get(existingJavaOwner);
      this.warning(
        'JAVA_ENTITY_NAME_COLLISION_RESOLVED',
        `Java entity name ${table.javaEntityName} was disambiguated with a stable hash.`,
        table.source.sourcePaths[0]!,
        [...table.source.sourceIds, ...(existingJavaTable?.source.sourceIds ?? [])],
      );
      table = {
        ...table,
        javaEntityName: resolvedJavaEntityName,
      };
    }
    this.tables.set(table.id, table);
    this.tableNameOwners.set(table.physicalName, table.id);
    this.javaEntityNameOwners.set(table.javaEntityName, table.id);
    if (table.sourceClassifierId) {
      this.classifierTables.set(table.sourceClassifierId, table);
    }
    return table;
  }

  addColumn(table: RelationalTable, column: RelationalColumn): RelationalColumn {
    if (table.columns.some((candidate) => candidate.id === column.id)) {
      const resolvedId = artifactId(
        `${column.id}_${shortStableHash(column.source.sourceIds.join('|'))}`,
      );
      if (table.columns.some((candidate) => candidate.id === resolvedId)) {
        this.fail({
          severity: 'ERROR',
          code: 'ARTIFACT_ID_COLLISION',
          message: `Generated column artifact ${column.id} is duplicated.`,
          path: column.source.sourcePaths[0],
          sourceIds: column.source.sourceIds,
        });
      }
      this.warning(
        'ARTIFACT_ID_COLLISION_RESOLVED',
        `Generated column artifact ${column.id} was disambiguated with a stable hash.`,
        column.source.sourcePaths[0]!,
        column.source.sourceIds,
      );
      column = { ...column, id: resolvedId };
    }
    const existing = table.columns.find(
      (candidate) => candidate.physicalName === column.physicalName,
    );
    if (existing) {
      const resolvedPhysicalName = appendStableHash(column.physicalName, column.id);
      if (table.columns.some((candidate) => candidate.physicalName === resolvedPhysicalName)) {
        this.fail({
          severity: 'ERROR',
          code: 'PHYSICAL_COLUMN_NAME_COLLISION',
          message: `Multiple artifacts map to ${table.physicalName}.${column.physicalName}.`,
          path: column.source.sourcePaths[0]!,
          sourceIds: [...column.source.sourceIds, ...existing.source.sourceIds],
        });
      }
      this.warning(
        'PHYSICAL_COLUMN_NAME_COLLISION_RESOLVED',
        `Physical column name ${column.physicalName} was disambiguated with a stable hash.`,
        column.source.sourcePaths[0]!,
        [...column.source.sourceIds, ...existing.source.sourceIds],
      );
      column = { ...column, physicalName: resolvedPhysicalName };
    }
    const existingJavaColumn = table.columns.find(
      (candidate) => candidate.javaPropertyName === column.javaPropertyName,
    );
    if (existingJavaColumn) {
      const resolvedJavaPropertyName = appendStableJavaNameHash(column.javaPropertyName, column.id);
      if (
        table.columns.some((candidate) => candidate.javaPropertyName === resolvedJavaPropertyName)
      ) {
        this.fail({
          severity: 'ERROR',
          code: 'JAVA_PROPERTY_NAME_COLLISION',
          message: `Multiple columns map to ${table.physicalName}.${column.javaPropertyName}.`,
          path: column.source.sourcePaths[0]!,
          sourceIds: [...column.source.sourceIds, ...existingJavaColumn.source.sourceIds],
        });
      }
      this.warning(
        'JAVA_PROPERTY_NAME_COLLISION_RESOLVED',
        `Java property name ${column.javaPropertyName} was disambiguated with a stable hash.`,
        column.source.sourcePaths[0]!,
        [...column.source.sourceIds, ...existingJavaColumn.source.sourceIds],
      );
      column = { ...column, javaPropertyName: resolvedJavaPropertyName };
    }
    table.columns.push(column);
    return column;
  }

  addForeignKey(table: RelationalTable, foreignKey: RelationalForeignKey): void {
    const duplicateName = table.foreignKeys.some(
      (candidate) => candidate.physicalName === foreignKey.physicalName,
    );
    if (duplicateName || table.primaryKey.physicalName === foreignKey.physicalName) {
      this.fail({
        severity: 'ERROR',
        code: 'PHYSICAL_CONSTRAINT_NAME_COLLISION',
        message: `Multiple constraints map to ${table.physicalName}.${foreignKey.physicalName}.`,
        path: foreignKey.source.sourcePaths[0],
        sourceIds: foreignKey.source.sourceIds,
      });
    }
    table.foreignKeys.push(foreignKey);
  }

  addUniqueConstraint(table: RelationalTable, uniqueConstraint: RelationalUniqueConstraint): void {
    const duplicateName = table.uniqueConstraints.some(
      (candidate) => candidate.physicalName === uniqueConstraint.physicalName,
    );
    if (
      duplicateName ||
      table.primaryKey.physicalName === uniqueConstraint.physicalName ||
      table.foreignKeys.some(
        (candidate) => candidate.physicalName === uniqueConstraint.physicalName,
      )
    ) {
      this.fail({
        severity: 'ERROR',
        code: 'PHYSICAL_CONSTRAINT_NAME_COLLISION',
        message: `Multiple constraints map to ${table.physicalName}.${uniqueConstraint.physicalName}.`,
        path: uniqueConstraint.source.sourcePaths[0],
        sourceIds: uniqueConstraint.source.sourceIds,
      });
    }
    table.uniqueConstraints.push(uniqueConstraint);
  }

  tableForClassifier(classifierId: string, sourceIds: string[], path: string): RelationalTable {
    const table = this.classifierTables.get(classifierId);
    if (!table) {
      this.fail({
        severity: 'ERROR',
        code: 'UNMAPPED_CLASSIFIER',
        message: `Classifier ${classifierId} has no relational table.`,
        path,
        sourceIds,
      });
    }
    return table;
  }

  classifierPath(classifierId: string): string {
    return `/diagram/elements/${classifierId}`;
  }

  attributePath(classifierId: string, attributeId: string): string {
    return `${this.classifierPath(classifierId)}/attributes/${attributeId}`;
  }

  relationshipPath(relationshipId: string): string {
    return `/diagram/relationships/${relationshipId}`;
  }

  relationshipEndPath(relationshipId: string, side: 'source' | 'target'): string {
    return `${this.relationshipPath(relationshipId)}/${side}`;
  }

  relationshipEndpointPath(relationship: UmlRelationship, end: UmlRelationshipEnd): string {
    return `${this.relationshipPath(relationship.id)}/ends/${end.elementId}/${toPhysicalName(
      end.role || 'unnamed',
    )}/${end.multiplicity}/${end.navigable ? 'navigable' : 'not-navigable'}`;
  }

  info(code: string, message: string, path: string, sourceIds: string[]): void {
    this.diagnostics.push({
      severity: 'INFO',
      code,
      message,
      path,
      sourceIds: uniqueSorted(sourceIds),
    });
  }

  warning(code: string, message: string, path: string, sourceIds: string[]): void {
    this.diagnostics.push({
      severity: 'WARNING',
      code,
      message,
      path,
      sourceIds: uniqueSorted(sourceIds),
    });
  }

  fail(diagnostic: RelationalDiagnostic): never {
    this.diagnostics.push({
      ...diagnostic,
      sourceIds: diagnostic.sourceIds ? uniqueSorted(diagnostic.sourceIds) : undefined,
    });
    throw new RelationalModelGenerationError(this.diagnostics.slice());
  }

  toModel(): RelationalModel {
    return {
      schemaVersion: RELATIONAL_MODEL_SCHEMA_VERSION,
      sourceSchemaVersion: UML_SOURCE_SCHEMA_VERSION,
      project: {
        id: this.canonical.project.id,
        name: this.canonical.project.name,
      },
      conventions: {
        naming: 'snake_case',
        identifierMaxLength: 63,
        inheritanceStrategy: 'JOINED',
        identifierStrategy: 'attribute-id-or-synthetic-uuid',
      },
      tables: [...this.tables.values()]
        .toSorted((left, right) => left.id.localeCompare(right.id))
        .map(normalizeTable),
      diagnostics: this.diagnostics.toSorted(compareDiagnostics),
    };
  }
}

function buildEntityTables(state: BuildState): void {
  const associationClassIds = new Set(
    state.canonical.diagram.relationships
      .map((relationship) => relationship.associationClassId)
      .filter((id): id is string => id !== undefined),
  );

  for (const classifier of sortedClassifiers(state.canonical.diagram.elements)) {
    if (classifier.kind === 'interface') {
      state.info(
        'INTERFACE_NOT_PERSISTED',
        `Interface ${classifier.name} is not materialized as a table in 6A.1.`,
        state.classifierPath(classifier.id),
        [classifier.id],
      );
      continue;
    }
    if (associationClassIds.has(classifier.id)) {
      continue;
    }
    const tableId = artifactId(`table_${classifier.id}`);
    const physicalName = toPhysicalName(classifier.name);
    const namedIdAttribute = classifier.attributes.find(
      (attribute) => !attribute.isStatic && attribute.name.trim().toLowerCase() === 'id',
    );
    const idAttribute =
      namedIdAttribute && isCompatibleIdentifierAttribute(namedIdAttribute)
        ? namedIdAttribute
        : undefined;
    if (namedIdAttribute && !idAttribute) {
      state.warning(
        'INCOMPATIBLE_IDENTIFIER_ATTRIBUTE',
        `Attribute ${classifier.name}.${namedIdAttribute.name} is not a scalar identifier; a synthetic UUID is used.`,
        state.attributePath(classifier.id, namedIdAttribute.id),
        [classifier.id, namedIdAttribute.id],
      );
    }
    const idColumn = idAttribute
      ? createAttributeColumn(state, classifier, idAttribute, tableId, true)
      : createSyntheticIdColumn(state, classifier, tableId);
    const source = trace(
      [classifier.id],
      [state.classifierPath(classifier.id)],
      'classifier.entity-table',
    );
    const table: RelationalTable = {
      id: tableId,
      logicalName: classifier.name,
      physicalName,
      javaEntityName: toJavaTypeName(classifier.name),
      kind: 'entity',
      isAbstract: classifier.isAbstract,
      sourceClassifierId: classifier.id,
      columns: [idColumn],
      primaryKey: primaryKeyForTable(tableId, physicalName, idColumn.id, source),
      foreignKeys: [],
      uniqueConstraints: [],
      inheritance: {
        strategy: 'JOINED',
        role: 'root',
        source: trace(
          [classifier.id],
          [state.classifierPath(classifier.id)],
          'inheritance.joined-root',
        ),
      },
      source,
    };
    state.addTable(table);
    if (classifier.isAbstract) {
      state.warning(
        'ABSTRACT_ENTITY_TABLE',
        `Abstract class ${classifier.name} still receives a JOINED root table.`,
        state.classifierPath(classifier.id),
        [classifier.id],
      );
    }
    if (classifier.operations.length > 0) {
      state.info(
        'OPERATIONS_NOT_PERSISTED',
        `Operations of ${classifier.name} are not persistence artifacts in 6A.1.`,
        state.classifierPath(classifier.id),
        [classifier.id],
      );
    }
  }
}

function buildAssociationClassTables(state: BuildState): void {
  for (const relationship of sortedRelationships(state.canonical.diagram.relationships)) {
    if (!relationship.associationClassId) {
      continue;
    }
    const associationClass = state.classifiers.get(relationship.associationClassId);
    if (!associationClass || associationClass.kind !== 'class') {
      state.fail({
        severity: 'ERROR',
        code: 'ASSOCIATION_CLASS_NOT_FOUND',
        message: `Association class ${relationship.associationClassId} is not a persistable class.`,
        path: state.relationshipPath(relationship.id),
        sourceIds: [relationship.id, relationship.associationClassId],
      });
    }
    buildAssociationClassTable(state, relationship, associationClass);
  }
}

function buildAssociationClassTable(
  state: BuildState,
  relationship: UmlRelationship,
  associationClass: UmlClass,
): void {
  const sourceTable = state.tableForClassifier(
    relationship.source.elementId,
    [relationship.id, relationship.source.elementId],
    state.relationshipEndPath(relationship.id, 'source'),
  );
  const targetTable = state.tableForClassifier(
    relationship.target.elementId,
    [relationship.id, relationship.target.elementId],
    state.relationshipEndPath(relationship.id, 'target'),
  );
  const tableId = artifactId(`table_${associationClass.id}`);
  const physicalName = toPhysicalName(associationClass.name);
  const namedIdAttribute = associationClass.attributes.find(
    (attribute) => !attribute.isStatic && attribute.name.trim().toLowerCase() === 'id',
  );
  if (namedIdAttribute && !isCompatibleIdentifierAttribute(namedIdAttribute)) {
    state.fail({
      severity: 'ERROR',
      code: 'INCOMPATIBLE_ASSOCIATION_CLASS_IDENTIFIER',
      message: `Association class ${associationClass.name} has an id attribute that cannot be used as a scalar primary key.`,
      path: state.attributePath(associationClass.id, namedIdAttribute.id),
      sourceIds: [associationClass.id, namedIdAttribute.id, relationship.id],
    });
  }
  const explicitIdAttribute = namedIdAttribute;
  const explicitIdColumn = explicitIdAttribute
    ? createAttributeColumn(state, associationClass, explicitIdAttribute, tableId, true)
    : undefined;
  const associationSource = trace(
    [associationClass.id, relationship.id],
    [state.classifierPath(associationClass.id), state.relationshipPath(relationship.id)],
    'association-class.table',
  );
  const endpoints = [
    { table: sourceTable, end: relationship.source },
    { table: targetTable, end: relationship.target },
  ].toSorted((left, right) =>
    relationshipEndpointKey(left).localeCompare(relationshipEndpointKey(right)),
  );
  const firstColumn = createRelationshipColumn(
    state,
    tableId,
    endpoints[0]!.table,
    endpoints[0]!.end,
    endpoints[0]!.end,
    relationship,
    explicitIdColumn === undefined,
    'association-class.endpoint-key',
  );
  const secondColumn = createRelationshipColumn(
    state,
    tableId,
    endpoints[1]!.table,
    endpoints[1]!.end,
    endpoints[1]!.end,
    relationship,
    explicitIdColumn === undefined,
    'association-class.endpoint-key',
  );
  const table: RelationalTable = {
    id: tableId,
    logicalName: associationClass.name,
    physicalName,
    javaEntityName: toJavaTypeName(associationClass.name),
    kind: 'association-class',
    isAbstract: associationClass.isAbstract,
    sourceClassifierId: associationClass.id,
    sourceRelationshipId: relationship.id,
    columns: [],
    primaryKey: primaryKeyForTable(
      tableId,
      physicalName,
      explicitIdColumn?.id ?? firstColumn.id,
      explicitIdColumn?.source ?? associationSource,
      explicitIdColumn ? [] : [secondColumn.id],
    ),
    foreignKeys: [],
    uniqueConstraints: [],
    source: associationSource,
  };
  const storedFirstColumn = state.addColumn(table, firstColumn);
  const storedSecondColumn = state.addColumn(table, secondColumn);
  const storedIdColumn = explicitIdColumn ? state.addColumn(table, explicitIdColumn) : undefined;
  table.primaryKey = primaryKeyForTable(
    tableId,
    physicalName,
    storedIdColumn?.id ?? storedFirstColumn.id,
    storedIdColumn?.source ?? associationSource,
    storedIdColumn ? [] : [storedSecondColumn.id],
  );
  const storedTable = state.addTable(table);
  addForeignKeyForRelationship(
    state,
    storedTable,
    storedFirstColumn,
    endpoints[0]!.table,
    relationship,
    'association-class.endpoint-fk',
    'NO_ACTION',
  );
  addForeignKeyForRelationship(
    state,
    storedTable,
    storedSecondColumn,
    endpoints[1]!.table,
    relationship,
    'association-class.endpoint-fk',
    'NO_ACTION',
  );
  if (explicitIdColumn) {
    state.addUniqueConstraint(storedTable, {
      id: artifactId(`unique_${storedTable.id}_endpoints`),
      physicalName: constraintName(`uk_${storedTable.physicalName}_endpoints`),
      columnIds: [storedFirstColumn.id, storedSecondColumn.id],
      source: trace(
        [
          relationship.id,
          associationClass.id,
          endpoints[0]!.end.elementId,
          endpoints[1]!.end.elementId,
        ],
        [
          state.relationshipPath(relationship.id),
          state.relationshipEndpointPath(relationship, endpoints[0]!.end),
          state.relationshipEndpointPath(relationship, endpoints[1]!.end),
        ],
        'association-class.endpoint-unique',
      ),
    });
  }
  for (const attribute of sortedAttributes(associationClass.attributes)) {
    addAttributeToTable(state, storedTable, associationClass, attribute);
  }
  state.info(
    'ASSOCIATION_CLASS_TABLE',
    explicitIdColumn
      ? `Association class ${associationClass.name} uses its explicit id and a unique endpoint pair.`
      : `Association class ${associationClass.name} is represented as a composite-key table.`,
    state.relationshipPath(relationship.id),
    [relationship.id, associationClass.id],
  );
}

function buildClassifierAttributes(state: BuildState): void {
  for (const classifier of sortedClassifiers(state.canonical.diagram.elements)) {
    if (classifier.kind !== 'class') {
      continue;
    }
    const table = state.classifierTables.get(classifier.id);
    if (!table || table.kind !== 'entity') {
      continue;
    }
    for (const attribute of sortedAttributes(classifier.attributes)) {
      addAttributeToTable(state, table, classifier, attribute);
    }
  }
}

function addAttributeToTable(
  state: BuildState,
  table: RelationalTable,
  classifier: UmlClass,
  attribute: UmlAttribute,
): void {
  const path = state.attributePath(classifier.id, attribute.id);
  if (attribute.isStatic) {
    state.info(
      'STATIC_ATTRIBUTE_IGNORED',
      `Static attribute ${attribute.name} is not persisted.`,
      path,
      [classifier.id, attribute.id],
    );
    return;
  }
  if (
    attribute.name.trim().toLowerCase() === 'id' &&
    table.primaryKey.source.sourceIds.includes(attribute.id)
  ) {
    return;
  }
  if (attribute.type.collection) {
    createCollectionTable(state, table, classifier, attribute);
    return;
  }
  if (attribute.type.elementId) {
    const target = state.classifiers.get(attribute.type.elementId);
    if (!target || target.kind !== 'class') {
      state.warning(
        'INTERFACE_ATTRIBUTE_REFERENCE',
        `Attribute ${attribute.name} references a non-persisted classifier and is ignored.`,
        path,
        [classifier.id, attribute.id, attribute.type.elementId],
      );
      return;
    }
    const targetTable = state.tableForClassifier(
      attribute.type.elementId,
      [classifier.id, attribute.id],
      path,
    );
    addReferenceColumn(
      state,
      table,
      targetTable,
      attribute.name,
      attribute.type.name,
      attribute.type.nullable ?? false,
      false,
      [classifier.id, attribute.id, target.id],
      [path, state.classifierPath(target.id)],
      'attribute.class-reference',
      'NO_ACTION',
    );
    return;
  }
  const column = createAttributeColumn(state, classifier, attribute, table.id, false);
  state.addColumn(table, column);
}

function createCollectionTable(
  state: BuildState,
  ownerTable: RelationalTable,
  classifier: UmlClass,
  attribute: UmlAttribute,
): void {
  const tableId = artifactId(`table_collection_${classifier.id}_${attribute.id}`);
  const physicalName = toPhysicalName(`${ownerTable.physicalName}_${attribute.name}`);
  const collectionSource = trace(
    [classifier.id, attribute.id],
    [state.attributePath(classifier.id, attribute.id)],
    'attribute.collection-table',
  );
  const ownerId = requireSinglePrimaryKey(
    state,
    ownerTable,
    state.attributePath(classifier.id, attribute.id),
    [classifier.id, attribute.id],
  );
  const ownerColumn: RelationalColumn = {
    id: artifactId(`column_${tableId}_owner_id`),
    logicalName: `${classifier.name}Id`,
    physicalName: 'owner_id',
    javaPropertyName: 'ownerId',
    javaType: ownerId.javaType,
    postgresType: ownerId.postgresType,
    umlType: classifier.name,
    nullable: false,
    primaryKey: true,
    source: collectionSource,
  };
  let valueColumn: RelationalColumn;
  let targetTable: RelationalTable | undefined;
  if (attribute.type.elementId) {
    targetTable = state.tableForClassifier(
      attribute.type.elementId,
      [classifier.id, attribute.id, attribute.type.elementId],
      state.attributePath(classifier.id, attribute.id),
    );
    const targetId = requireSinglePrimaryKey(
      state,
      targetTable,
      state.attributePath(classifier.id, attribute.id),
      [classifier.id, attribute.id, attribute.type.elementId],
    );
    valueColumn = {
      id: artifactId(`column_${tableId}_value_id`),
      logicalName: attribute.name,
      physicalName: 'value_id',
      javaPropertyName: toJavaPropertyName(attribute.name),
      javaType: targetTable.javaEntityName,
      postgresType: targetId.postgresType,
      umlType: attribute.type.name,
      nullable: false,
      primaryKey: true,
      source: trace(
        [classifier.id, attribute.id, attribute.type.elementId],
        [
          state.attributePath(classifier.id, attribute.id),
          state.classifierPath(attribute.type.elementId),
        ],
        'attribute.collection-class-reference',
      ),
    };
  } else {
    const scalar = scalarType(
      state,
      attribute.type,
      state.attributePath(classifier.id, attribute.id),
      [classifier.id, attribute.id],
    );
    valueColumn = {
      id: artifactId(`column_${tableId}_value`),
      logicalName: attribute.name,
      physicalName: 'value',
      javaPropertyName: 'value',
      javaType: scalar.javaType,
      postgresType: scalar.postgresType,
      umlType: attribute.type.name,
      nullable: false,
      primaryKey: true,
      source: collectionSource,
    };
  }
  const table: RelationalTable = {
    id: tableId,
    logicalName: boundedLogicalName(`${classifier.name}.${attribute.name}`),
    physicalName,
    javaEntityName: toJavaTypeName(`${classifier.name}${attribute.name}`),
    kind: 'collection',
    columns: [],
    primaryKey: primaryKeyForTable(tableId, physicalName, ownerColumn.id, collectionSource, [
      valueColumn.id,
    ]),
    foreignKeys: [],
    uniqueConstraints: [],
    source: collectionSource,
  };
  const storedOwnerColumn = state.addColumn(table, ownerColumn);
  const storedValueColumn = state.addColumn(table, valueColumn);
  table.primaryKey = primaryKeyForTable(
    tableId,
    physicalName,
    storedOwnerColumn.id,
    collectionSource,
    [storedValueColumn.id],
  );
  const storedTable = state.addTable(table);
  state.addForeignKey(storedTable, {
    id: artifactId(`fk_${tableId}_owner`),
    physicalName: constraintName(`fk_${physicalName}_owner`),
    columnIds: [storedOwnerColumn.id],
    referencedTableId: ownerTable.id,
    referencedColumnIds: [ownerId.id],
    onDelete: 'CASCADE',
    source: collectionSource,
  });
  if (targetTable && attribute.type.elementId) {
    state.addForeignKey(storedTable, {
      id: artifactId(`fk_${tableId}_value`),
      physicalName: constraintName(`fk_${physicalName}_value`),
      columnIds: [storedValueColumn.id],
      referencedTableId: targetTable.id,
      referencedColumnIds: [
        requireSinglePrimaryKey(
          state,
          targetTable,
          state.attributePath(classifier.id, attribute.id),
          [classifier.id, attribute.id, attribute.type.elementId],
        ).id,
      ],
      onDelete: 'NO_ACTION',
      source: trace(
        [classifier.id, attribute.id, attribute.type.elementId],
        [
          state.attributePath(classifier.id, attribute.id),
          state.classifierPath(attribute.type.elementId),
        ],
        'attribute.collection-class-reference-fk',
      ),
    });
  }
  state.info(
    'COLLECTION_TABLE_CREATED',
    `Collection attribute ${classifier.name}.${attribute.name} is represented by ${physicalName}.`,
    state.attributePath(classifier.id, attribute.id),
    [classifier.id, attribute.id],
  );
}

function buildRelationships(state: BuildState): void {
  for (const relationship of sortedGeneralizations(state.canonical.diagram.relationships)) {
    buildGeneralization(state, relationship);
  }
  for (const relationship of sortedRelationships(state.canonical.diagram.relationships)) {
    if (relationship.kind === 'generalization') {
      continue;
    }
    switch (relationship.kind) {
      case 'association':
      case 'aggregation':
      case 'composition':
        if (relationship.associationClassId) {
          continue;
        }
        buildAssociation(state, relationship);
        break;
      case 'realization':
        state.info(
          'REALIZATION_NOT_PERSISTED',
          'Interface realization is not a relational persistence artifact.',
          state.relationshipPath(relationship.id),
          [relationship.id, relationship.source.elementId, relationship.target.elementId],
        );
        break;
      case 'dependency':
        state.info(
          'DEPENDENCY_NOT_PERSISTED',
          'Dependency is not a relational persistence artifact.',
          state.relationshipPath(relationship.id),
          [relationship.id, relationship.source.elementId, relationship.target.elementId],
        );
        break;
    }
  }
}

function sortedGeneralizations(relationships: UmlRelationship[]): UmlRelationship[] {
  const generalizations = relationships.filter(
    (relationship) => relationship.kind === 'generalization',
  );
  const byChild = new Map<string, UmlRelationship[]>();
  for (const relationship of generalizations) {
    const parents = byChild.get(relationship.source.elementId) ?? [];
    parents.push(relationship);
    byChild.set(relationship.source.elementId, parents);
  }
  const depthCache = new Map<string, number>();
  const depth = (classifierId: string, visiting = new Set<string>()): number => {
    const cached = depthCache.get(classifierId);
    if (cached !== undefined) {
      return cached;
    }
    if (visiting.has(classifierId)) {
      return 0;
    }
    const nextVisiting = new Set(visiting).add(classifierId);
    const parentRelationships = byChild.get(classifierId) ?? [];
    const result =
      parentRelationships.length === 0
        ? 0
        : Math.max(
            ...parentRelationships.map((relationship) =>
              depth(relationship.target.elementId, nextVisiting),
            ),
          ) + 1;
    depthCache.set(classifierId, result);
    return result;
  };

  return generalizations.toSorted(
    (left, right) =>
      depth(left.target.elementId) - depth(right.target.elementId) ||
      left.id.localeCompare(right.id),
  );
}

function buildGeneralization(state: BuildState, relationship: UmlRelationship): void {
  const source = state.classifiers.get(relationship.source.elementId);
  const target = state.classifiers.get(relationship.target.elementId);
  if (!source || !target || source.kind !== 'class' || target.kind !== 'class') {
    state.info(
      'INTERFACE_INHERITANCE_NOT_PERSISTED',
      'Interface inheritance is not materialized as a JOINED table hierarchy.',
      state.relationshipPath(relationship.id),
      [relationship.id, relationship.source.elementId, relationship.target.elementId],
    );
    return;
  }
  const childTable = state.tableForClassifier(
    source.id,
    [relationship.id, source.id],
    state.relationshipPath(relationship.id),
  );
  const parentTable = state.tableForClassifier(
    target.id,
    [relationship.id, target.id],
    state.relationshipPath(relationship.id),
  );
  if (childTable.inheritance?.role === 'subclass') {
    state.fail({
      severity: 'ERROR',
      code: 'MULTIPLE_INHERITANCE_PARENTS',
      message: `Class ${source.name} has more than one JOINED parent.`,
      path: state.relationshipPath(relationship.id),
      sourceIds: [relationship.id, source.id, target.id],
    });
  }
  const childId = requireSinglePrimaryKey(
    state,
    childTable,
    state.relationshipPath(relationship.id),
    [relationship.id, source.id, target.id],
  );
  const parentId = requireSinglePrimaryKey(
    state,
    parentTable,
    state.relationshipPath(relationship.id),
    [relationship.id, source.id, target.id],
  );
  const childHasExplicitIdentifier = childId.generated === undefined;
  const parentHasExplicitIdentifier = parentId.generated === undefined;
  if (
    childHasExplicitIdentifier &&
    parentHasExplicitIdentifier &&
    (childId.javaType !== parentId.javaType || childId.postgresType !== parentId.postgresType)
  ) {
    state.fail({
      severity: 'ERROR',
      code: 'JOINED_IDENTIFIER_TYPE_MISMATCH',
      message: `JOINED subclass ${source.name} must reuse the identifier type of ${target.name}.`,
      path: state.relationshipPath(relationship.id),
      sourceIds: [relationship.id, source.id, target.id],
    });
  }
  const { generated: _generated, defaultValue: _defaultValue, ...childIdentifier } = childId;
  const joinedChildId: RelationalColumn = {
    ...childIdentifier,
    javaType: parentId.javaType,
    postgresType: parentId.postgresType,
    umlType: parentId.umlType,
    nullable: false,
    source: trace(
      [relationship.id, source.id, target.id, ...childId.source.sourceIds],
      [state.relationshipPath(relationship.id), ...childId.source.sourcePaths],
      'identifier.joined-parent',
    ),
  };
  childTable.columns = childTable.columns.map((column) =>
    column.id === childId.id ? joinedChildId : column,
  );
  state.info(
    'JOINED_IDENTIFIER_REUSED',
    `JOINED subclass ${source.name} reuses the primary-key type of ${target.name}.`,
    state.relationshipPath(relationship.id),
    [relationship.id, source.id, target.id],
  );
  childTable.inheritance = {
    strategy: 'JOINED',
    role: 'subclass',
    parentTableId: parentTable.id,
    parentColumnIds: [parentId.id],
    source: trace(
      [relationship.id, source.id, target.id],
      [state.relationshipPath(relationship.id)],
      'inheritance.joined-subclass',
    ),
  };
  state.addForeignKey(childTable, {
    id: artifactId(`fk_${childTable.id}_joined_parent`),
    physicalName: constraintName(`fk_${childTable.physicalName}_${parentTable.physicalName}`),
    columnIds: [childId.id],
    referencedTableId: parentTable.id,
    referencedColumnIds: [parentId.id],
    onDelete: 'CASCADE',
    source: trace(
      [relationship.id, source.id, target.id],
      [state.relationshipPath(relationship.id)],
      'inheritance.joined-primary-key-fk',
    ),
  });
}

function buildAssociation(state: BuildState, relationship: UmlRelationship): void {
  const source = state.classifiers.get(relationship.source.elementId);
  const target = state.classifiers.get(relationship.target.elementId);
  if (!source || !target || source.kind !== 'class' || target.kind !== 'class') {
    state.warning(
      'INTERFACE_ASSOCIATION_NOT_PERSISTED',
      'Associations involving interfaces are not materialized in 6A.1.',
      state.relationshipPath(relationship.id),
      [relationship.id, relationship.source.elementId, relationship.target.elementId],
    );
    return;
  }
  const sourceTable = state.tableForClassifier(
    source.id,
    [relationship.id, source.id],
    state.relationshipPath(relationship.id),
  );
  const targetTable = state.tableForClassifier(
    target.id,
    [relationship.id, target.id],
    state.relationshipPath(relationship.id),
  );
  reportMultiplicityPolicy(state, relationship);
  if (relationship.kind === 'composition') {
    buildComposition(state, relationship, sourceTable, targetTable);
    return;
  }
  const sourceMany = isMany(relationship.source.multiplicity);
  const targetMany = isMany(relationship.target.multiplicity);
  if (sourceMany && targetMany) {
    createJoinTable(state, relationship, sourceTable, targetTable);
    return;
  }
  if (!sourceMany && !targetMany) {
    const owner = chooseOneToOneOwner(relationship, sourceTable, targetTable);
    if (owner.usedStableTieBreak) {
      state.warning(
        'ONE_TO_ONE_OWNER_TIE_BREAK',
        'Both 1:1 endpoints are equally navigable; the endpoint with the stable classifier ID owns the FK.',
        state.relationshipPath(relationship.id),
        [relationship.id, relationship.source.elementId, relationship.target.elementId],
      );
    }
    const referenced = owner.endpoint === 'source' ? targetTable : sourceTable;
    const referencedEnd = owner.endpoint === 'source' ? relationship.target : relationship.source;
    const ownerEnd = owner.endpoint === 'source' ? relationship.source : relationship.target;
    const referenceName = referenceLogicalName(
      owner.table,
      referencedEnd.role || referenced.logicalName,
      relationship,
    );
    addReferenceColumn(
      state,
      owner.table,
      referenced,
      referenceName,
      referenced.logicalName,
      lowerBound(referencedEnd.multiplicity) === 0n,
      true,
      [relationship.id, ownerEnd.elementId, referencedEnd.elementId],
      [
        state.relationshipPath(relationship.id),
        state.relationshipEndpointPath(relationship, ownerEnd),
        state.relationshipEndpointPath(relationship, referencedEnd),
      ],
      `relationship.${relationship.kind}.one-to-one`,
      'NO_ACTION',
      relationship,
    );
    return;
  }
  const ownerIsTarget = !sourceMany && targetMany;
  const ownerTable = ownerIsTarget ? targetTable : sourceTable;
  const referencedTable = ownerIsTarget ? sourceTable : targetTable;
  const ownerEnd = ownerIsTarget ? relationship.target : relationship.source;
  const referencedEnd = ownerIsTarget ? relationship.source : relationship.target;
  const referenceName = referenceLogicalName(
    ownerTable,
    referencedEnd.role || referencedTable.logicalName,
    relationship,
  );
  addReferenceColumn(
    state,
    ownerTable,
    referencedTable,
    referenceName,
    referencedTable.logicalName,
    lowerBound(referencedEnd.multiplicity) === 0n,
    false,
    [relationship.id, ownerEnd.elementId, referencedEnd.elementId],
    [
      state.relationshipPath(relationship.id),
      state.relationshipEndpointPath(relationship, ownerEnd),
      state.relationshipEndpointPath(relationship, referencedEnd),
    ],
    `relationship.${relationship.kind}.foreign-key`,
    'NO_ACTION',
    relationship,
  );
}

function buildComposition(
  state: BuildState,
  relationship: UmlRelationship,
  ownerTable: RelationalTable,
  partTable: RelationalTable,
): void {
  const ownerMultiplicity = parseMultiplicity(relationship.source.multiplicity);
  if (ownerMultiplicity.upper === null || ownerMultiplicity.upper > 1n) {
    state.fail({
      severity: 'ERROR',
      code: 'COMPOSITION_MULTIPLE_OWNERS_UNSUPPORTED',
      message:
        'Composition requires source to be the owner and each part to have at most one owner.',
      path: state.relationshipEndPath(relationship.id, 'source'),
      sourceIds: [relationship.id, relationship.source.elementId, relationship.target.elementId],
    });
  }
  const partMultiplicity = parseMultiplicity(relationship.target.multiplicity);
  const referenceName = referenceLogicalName(
    partTable,
    relationship.source.role || ownerTable.logicalName,
    relationship,
  );
  addReferenceColumn(
    state,
    partTable,
    ownerTable,
    referenceName,
    ownerTable.logicalName,
    ownerMultiplicity.lower === 0n,
    partMultiplicity.upper !== null && partMultiplicity.upper <= 1n,
    [relationship.id, relationship.source.elementId, relationship.target.elementId],
    [
      state.relationshipPath(relationship.id),
      state.relationshipEndpointPath(relationship, relationship.source),
      state.relationshipEndpointPath(relationship, relationship.target),
    ],
    'relationship.composition.owner-to-part',
    'CASCADE',
    relationship,
  );
}

function createJoinTable(
  state: BuildState,
  relationship: UmlRelationship,
  sourceTable: RelationalTable,
  targetTable: RelationalTable,
): void {
  const tableId = artifactId(`table_relation_${relationship.id}`);
  const endpoints = [
    { table: sourceTable, end: relationship.source },
    { table: targetTable, end: relationship.target },
  ].toSorted((left, right) =>
    relationshipEndpointKey(left).localeCompare(relationshipEndpointKey(right)),
  );
  const firstEndpoint = endpoints[0]!;
  const secondEndpoint = endpoints[1]!;
  const firstLogicalName = joinEndpointLogicalName(endpoints, firstEndpoint, 0);
  const secondLogicalName = joinEndpointLogicalName(endpoints, secondEndpoint, 1);
  const firstColumn = createRelationshipColumn(
    state,
    tableId,
    firstEndpoint.table,
    firstEndpoint.end,
    firstEndpoint.end,
    relationship,
    true,
    'join.endpoint-key',
    firstLogicalName,
  );
  const secondColumn = createRelationshipColumn(
    state,
    tableId,
    secondEndpoint.table,
    secondEndpoint.end,
    secondEndpoint.end,
    relationship,
    true,
    'join.endpoint-key',
    secondLogicalName,
  );
  const physicalName = joinTablePhysicalName(state, relationship, sourceTable, targetTable);
  const source = trace(
    [relationship.id, relationship.source.elementId, relationship.target.elementId],
    [
      state.relationshipPath(relationship.id),
      state.relationshipEndpointPath(relationship, relationship.source),
      state.relationshipEndpointPath(relationship, relationship.target),
    ],
    'relationship.many-to-many-join-table',
  );
  const table: RelationalTable = {
    id: tableId,
    logicalName: boundedLogicalName(
      relationship.name ||
        [firstEndpoint.table.logicalName, secondEndpoint.table.logicalName].toSorted().join('_'),
    ),
    physicalName,
    javaEntityName: toJavaTypeName(
      `${firstEndpoint.table.javaEntityName}${secondEndpoint.table.javaEntityName}Join`,
    ),
    kind: 'join',
    sourceRelationshipId: relationship.id,
    columns: [],
    primaryKey: primaryKeyForTable(tableId, physicalName, firstColumn.id, source, [
      secondColumn.id,
    ]),
    foreignKeys: [],
    uniqueConstraints: [],
    source,
  };
  const storedFirstColumn = state.addColumn(table, firstColumn);
  const storedSecondColumn = state.addColumn(table, secondColumn);
  table.primaryKey = primaryKeyForTable(tableId, physicalName, storedFirstColumn.id, source, [
    storedSecondColumn.id,
  ]);
  const storedTable = state.addTable(table);
  addForeignKeyForRelationship(
    state,
    storedTable,
    storedFirstColumn,
    firstEndpoint.table,
    relationship,
    'join.endpoint-fk',
    'NO_ACTION',
  );
  addForeignKeyForRelationship(
    state,
    storedTable,
    storedSecondColumn,
    secondEndpoint.table,
    relationship,
    'join.endpoint-fk',
    'NO_ACTION',
  );
}

function relationshipEndpointKey(endpoint: {
  table: RelationalTable;
  end: UmlRelationshipEnd;
}): string {
  return [
    endpoint.table.id,
    endpoint.end.elementId,
    endpoint.end.role,
    endpoint.end.multiplicity,
    endpoint.end.navigable,
  ]
    .map(String)
    .join('|');
}

function canonicalRelationshipMultiplicities(relationship: UmlRelationship): {
  sourceMultiplicity: string;
  targetMultiplicity: string;
} {
  const endpoints = [relationship.source, relationship.target].toSorted((left, right) =>
    relationshipEndKey(left).localeCompare(relationshipEndKey(right)),
  );
  return {
    sourceMultiplicity: endpoints[0]!.multiplicity,
    targetMultiplicity: endpoints[1]!.multiplicity,
  };
}

function relationshipEndKey(end: UmlRelationshipEnd): string {
  return [end.elementId, end.role, end.multiplicity, end.navigable].map(String).join('|');
}

function joinEndpointLogicalName(
  endpoints: Array<{ table: RelationalTable; end: UmlRelationshipEnd }>,
  endpoint: { table: RelationalTable; end: UmlRelationshipEnd },
  index: number,
): string {
  const logicalName = endpoint.end.role || endpoint.table.logicalName;
  const physicalName = referenceColumnPhysicalName(logicalName);
  const duplicateCount = endpoints.filter(
    (candidate) =>
      referenceColumnPhysicalName(candidate.end.role || candidate.table.logicalName) ===
      physicalName,
  ).length;
  if (duplicateCount === 1) {
    return logicalName;
  }
  const endpointDiscriminator = [
    endpoint.end.elementId,
    endpoint.end.role || 'endpoint',
    endpoint.end.multiplicity,
  ].join('_');
  return `${logicalName}_${endpointDiscriminator}_${index}`;
}

function joinTablePhysicalName(
  state: BuildState,
  relationship: UmlRelationship,
  sourceTable: RelationalTable,
  targetTable: RelationalTable,
): string {
  const endpointNames = [sourceTable.physicalName, targetTable.physicalName].toSorted();
  const base =
    sourceTable.id === targetTable.id
      ? `${endpointNames[0]}_${[
          relationship.source.role || 'source',
          relationship.target.role || 'target',
        ]
          .map(toPhysicalName)
          .toSorted()
          .join('_')}`
      : endpointNames.join('_');
  const parallel = state.canonical.diagram.relationships.filter(
    (candidate) =>
      isJoinRelationship(candidate) &&
      candidate.kind === relationship.kind &&
      relationshipTablePairKey(candidate) === relationshipTablePairKey(relationship),
  );
  if (parallel.length <= 1) {
    return toPhysicalName(base);
  }
  const discriminator = relationship.name?.trim() || relationship.id;
  const repeatedDiscriminator =
    parallel.filter((candidate) => (candidate.name?.trim() || candidate.id) === discriminator)
      .length > 1;
  return toPhysicalName(
    `${base}_${discriminator}${repeatedDiscriminator ? `_${relationship.id}` : ''}`,
  );
}

function isJoinRelationship(relationship: UmlRelationship): boolean {
  return (
    !relationship.associationClassId &&
    (relationship.kind === 'association' || relationship.kind === 'aggregation') &&
    isMany(relationship.source.multiplicity) &&
    isMany(relationship.target.multiplicity)
  );
}

function relationshipTablePairKey(relationship: UmlRelationship): string {
  return [relationship.source.elementId, relationship.target.elementId].toSorted().join('|');
}

function createRelationshipColumn(
  state: BuildState,
  tableId: string,
  referencedTable: RelationalTable,
  ownerEnd: UmlRelationshipEnd,
  referencedEnd: UmlRelationshipEnd,
  relationship: UmlRelationship,
  primaryKey: boolean,
  rule: string,
  logicalNameOverride?: string,
): RelationalColumn {
  const referencedId = requireSinglePrimaryKey(
    state,
    referencedTable,
    state.relationshipPath(relationship.id),
    [relationship.id, ownerEnd.elementId, referencedEnd.elementId],
  );
  const logicalName = logicalNameOverride || ownerEnd.role || referencedTable.logicalName;
  const columnName = referenceColumnPhysicalName(logicalName);
  return {
    id: artifactId(`column_${tableId}_${columnName}`),
    logicalName,
    physicalName: columnName,
    javaPropertyName: `${toJavaPropertyName(logicalName)}Id`,
    javaType: referencedId.javaType,
    postgresType: referencedId.postgresType,
    umlType: state.classifiers.get(referencedEnd.elementId)?.name || referencedTable.logicalName,
    nullable: false,
    primaryKey,
    source: trace(
      [relationship.id, ownerEnd.elementId, referencedEnd.elementId],
      [
        state.relationshipPath(relationship.id),
        state.relationshipEndpointPath(relationship, ownerEnd),
      ],
      rule,
    ),
  };
}

function addReferenceColumn(
  state: BuildState,
  ownerTable: RelationalTable,
  referencedTable: RelationalTable,
  logicalName: string,
  umlType: string,
  nullable: boolean,
  unique: boolean,
  sourceIds: string[],
  sourcePaths: string[],
  rule: string,
  onDelete: RelationalOnDelete,
  relationship?: UmlRelationship,
): RelationalColumn {
  const referencedId = requireSinglePrimaryKey(state, referencedTable, sourcePaths[0]!, sourceIds);
  const columnPhysicalName = referenceColumnPhysicalName(logicalName);
  const column: RelationalColumn = {
    id: artifactId(`column_${ownerTable.id}_${columnPhysicalName}`),
    logicalName,
    physicalName: columnPhysicalName,
    javaPropertyName: toJavaPropertyName(logicalName),
    javaType: referencedTable.javaEntityName,
    postgresType: referencedId.postgresType,
    umlType,
    nullable,
    primaryKey: false,
    source: trace(sourceIds, sourcePaths, rule),
  };
  const storedColumn = state.addColumn(ownerTable, column);
  const multiplicities = relationship
    ? canonicalRelationshipMultiplicities(relationship)
    : undefined;
  state.addForeignKey(ownerTable, {
    id: artifactId(`fk_${ownerTable.id}_${storedColumn.id}`),
    physicalName: constraintName(`fk_${ownerTable.physicalName}_${storedColumn.physicalName}`),
    columnIds: [storedColumn.id],
    referencedTableId: referencedTable.id,
    referencedColumnIds: [referencedId.id],
    ...(multiplicities
      ? {
          sourceMultiplicity: multiplicities.sourceMultiplicity,
          targetMultiplicity: multiplicities.targetMultiplicity,
        }
      : {}),
    onDelete,
    source: trace(sourceIds, sourcePaths, `${rule}.foreign-key`),
  });
  if (unique) {
    state.addUniqueConstraint(ownerTable, {
      id: artifactId(`unique_${ownerTable.id}_${storedColumn.id}`),
      physicalName: constraintName(`uk_${ownerTable.physicalName}_${storedColumn.physicalName}`),
      columnIds: [storedColumn.id],
      source: trace(sourceIds, sourcePaths, `${rule}.unique`),
    });
  }
  return storedColumn;
}

function referenceLogicalName(
  ownerTable: RelationalTable,
  logicalName: string,
  relationship: UmlRelationship,
): string {
  if (
    !ownerTable.columns.some(
      (column) => column.physicalName === referenceColumnPhysicalName(logicalName),
    )
  ) {
    return logicalName;
  }
  const discriminator = relationship.name?.trim() || relationship.id;
  const named = `${logicalName}_${discriminator}`;
  if (
    !ownerTable.columns.some((column) => column.physicalName === referenceColumnPhysicalName(named))
  ) {
    return named;
  }
  return `${logicalName}_${relationship.id}`;
}

function referenceColumnPhysicalName(logicalName: string): string {
  const base = `${toPhysicalName(logicalName).replace(/_+$/g, '')}_id`;
  return truncateIdentifier(base, `${logicalName}_id`);
}

function addForeignKeyForRelationship(
  state: BuildState,
  table: RelationalTable,
  column: RelationalColumn,
  referencedTable: RelationalTable,
  relationship: UmlRelationship,
  rule: string,
  onDelete: RelationalOnDelete,
): void {
  const source = trace(
    [relationship.id, relationship.source.elementId, relationship.target.elementId],
    [state.relationshipPath(relationship.id)],
    rule,
  );
  const multiplicities = canonicalRelationshipMultiplicities(relationship);
  state.addForeignKey(table, {
    id: artifactId(`fk_${table.id}_${toPhysicalName(column.logicalName)}`),
    physicalName: constraintName(`fk_${table.physicalName}_${column.physicalName}`),
    columnIds: [column.id],
    referencedTableId: referencedTable.id,
    referencedColumnIds: [
      requireSinglePrimaryKey(
        state,
        referencedTable,
        state.relationshipPath(relationship.id),
        source.sourceIds,
      ).id,
    ],
    sourceMultiplicity: multiplicities.sourceMultiplicity,
    targetMultiplicity: multiplicities.targetMultiplicity,
    onDelete,
    source,
  });
}

function primaryKeyColumn(table: RelationalTable): RelationalColumn {
  const column = table.columns.find((candidate) => candidate.id === table.primaryKey.columnIds[0]);
  if (!column) {
    throw new Error(`Table ${table.id} has no primary key column.`);
  }
  return column;
}

function requireSinglePrimaryKey(
  state: BuildState,
  table: RelationalTable,
  path: string,
  sourceIds: string[],
): RelationalColumn {
  if (table.primaryKey.columnIds.length !== 1) {
    state.fail({
      severity: 'ERROR',
      code: 'COMPOSITE_PRIMARY_KEY_REFERENCE_UNSUPPORTED',
      message: `Table ${table.physicalName} has a composite primary key and cannot be referenced by a single relational column.`,
      path,
      sourceIds,
    });
  }
  return primaryKeyColumn(table);
}

function primaryKeyForTable(
  tableId: string,
  physicalName: string,
  firstColumnId: string,
  source: RelationalTraceability,
  additionalColumnIds: string[] = [],
): RelationalPrimaryKey {
  return {
    id: artifactId(`pk_${tableId}`),
    physicalName: constraintName(`pk_${physicalName}`),
    columnIds: [firstColumnId, ...additionalColumnIds],
    source,
  };
}

function createSyntheticIdColumn(
  state: BuildState,
  classifier: UmlClass,
  tableId: string,
): RelationalColumn {
  state.info(
    'SYNTHETIC_IDENTIFIER',
    `Class ${classifier.name} has no id attribute; a generated UUID identifier is used.`,
    state.classifierPath(classifier.id),
    [classifier.id],
  );
  return {
    id: artifactId(`column_${tableId}_id`),
    logicalName: 'id',
    physicalName: 'id',
    javaPropertyName: 'id',
    javaType: 'UUID',
    postgresType: 'uuid',
    umlType: 'UUID',
    nullable: false,
    primaryKey: true,
    generated: 'UUID',
    defaultValue: 'gen_random_uuid()',
    source: trace(
      [classifier.id],
      [state.classifierPath(classifier.id)],
      'identifier.synthetic-uuid',
    ),
  };
}

function isCompatibleIdentifierAttribute(attribute: UmlAttribute): boolean {
  return !attribute.type.collection && !attribute.type.elementId;
}

function createAttributeColumn(
  state: BuildState,
  classifier: UmlClass,
  attribute: UmlAttribute,
  tableId: string,
  primaryKey: boolean,
): RelationalColumn {
  if (attribute.type.elementId) {
    state.fail({
      severity: 'ERROR',
      code: 'IDENTIFIER_REFERENCE_UNSUPPORTED',
      message: `Identifier attribute ${classifier.name}.${attribute.name} cannot reference another classifier.`,
      path: state.attributePath(classifier.id, attribute.id),
      sourceIds: [classifier.id, attribute.id, attribute.type.elementId],
    });
  }
  const scalar = scalarType(
    state,
    attribute.type,
    state.attributePath(classifier.id, attribute.id),
    [classifier.id, attribute.id],
  );
  const source = trace(
    [classifier.id, attribute.id],
    [state.attributePath(classifier.id, attribute.id)],
    primaryKey ? 'identifier.explicit-id-attribute' : 'attribute.scalar-column',
  );
  const column: RelationalColumn = {
    id: artifactId(`column_${tableId}_${toPhysicalName(attribute.name)}`),
    logicalName: attribute.name,
    physicalName: toPhysicalName(attribute.name),
    javaPropertyName: toJavaPropertyName(attribute.name),
    javaType: scalar.javaType,
    postgresType: scalar.postgresType,
    umlType: attribute.type.name,
    nullable: primaryKey ? false : (attribute.type.nullable ?? false),
    primaryKey,
    source,
  };
  if (attribute.defaultValue !== undefined) {
    column.defaultValue = attribute.defaultValue;
  }
  return column;
}

function scalarType(
  state: BuildState,
  type: UmlTypeReference,
  path: string,
  sourceIds: string[],
): ScalarType {
  const key = type.name.trim().split('.').at(-1)!.replaceAll(' ', '').toLowerCase();
  const mapping: Record<string, ScalarType> = {
    string: { javaType: 'String', postgresType: 'varchar(255)' },
    text: { javaType: 'String', postgresType: 'text' },
    varchar: { javaType: 'String', postgresType: 'varchar(255)' },
    char: { javaType: 'Character', postgresType: 'char' },
    character: { javaType: 'Character', postgresType: 'char' },
    boolean: { javaType: 'Boolean', postgresType: 'boolean' },
    bool: { javaType: 'Boolean', postgresType: 'boolean' },
    byte: { javaType: 'Byte', postgresType: 'smallint' },
    short: { javaType: 'Short', postgresType: 'smallint' },
    integer: { javaType: 'Integer', postgresType: 'integer' },
    int: { javaType: 'Integer', postgresType: 'integer' },
    int32: { javaType: 'Integer', postgresType: 'integer' },
    long: { javaType: 'Long', postgresType: 'bigint' },
    int64: { javaType: 'Long', postgresType: 'bigint' },
    float: { javaType: 'Float', postgresType: 'real' },
    double: { javaType: 'Double', postgresType: 'double precision' },
    decimal: { javaType: 'BigDecimal', postgresType: 'numeric(19,2)' },
    bigdecimal: { javaType: 'BigDecimal', postgresType: 'numeric(19,2)' },
    numeric: { javaType: 'BigDecimal', postgresType: 'numeric(19,2)' },
    biginteger: { javaType: 'BigInteger', postgresType: 'numeric(38,0)' },
    localdate: { javaType: 'LocalDate', postgresType: 'date' },
    date: { javaType: 'LocalDate', postgresType: 'date' },
    localdatetime: { javaType: 'LocalDateTime', postgresType: 'timestamp(3)' },
    datetime: { javaType: 'Instant', postgresType: 'timestamptz(3)' },
    instant: { javaType: 'Instant', postgresType: 'timestamptz(3)' },
    timestamp: { javaType: 'Instant', postgresType: 'timestamptz(3)' },
    uuid: { javaType: 'UUID', postgresType: 'uuid' },
    bytes: { javaType: 'byte[]', postgresType: 'bytea' },
    bytea: { javaType: 'byte[]', postgresType: 'bytea' },
    json: { javaType: 'JsonNode', postgresType: 'jsonb' },
    jsonnode: { javaType: 'JsonNode', postgresType: 'jsonb' },
  };
  const result = mapping[key];
  if (!result) {
    state.fail({
      severity: 'ERROR',
      code: 'UNSUPPORTED_UML_TYPE',
      message: `UML type ${type.name} has no deterministic relational mapping.`,
      path,
      sourceIds,
    });
  }
  return result;
}

function chooseOneToOneOwner(
  relationship: UmlRelationship,
  sourceTable: RelationalTable,
  targetTable: RelationalTable,
): { endpoint: 'source' | 'target'; table: RelationalTable; usedStableTieBreak: boolean } {
  if (relationship.source.navigable !== relationship.target.navigable) {
    return relationship.source.navigable
      ? { endpoint: 'target', table: targetTable, usedStableTieBreak: false }
      : { endpoint: 'source', table: sourceTable, usedStableTieBreak: false };
  }
  return sourceTable.id.localeCompare(targetTable.id) <= 0
    ? { endpoint: 'source', table: sourceTable, usedStableTieBreak: true }
    : { endpoint: 'target', table: targetTable, usedStableTieBreak: true };
}

function lowerBound(value: string): bigint {
  return parseMultiplicity(value).lower;
}

function reportMultiplicityPolicy(state: BuildState, relationship: UmlRelationship): void {
  const bounds = [relationship.source.multiplicity, relationship.target.multiplicity].map(
    parseMultiplicity,
  );
  if (bounds.some((bound) => bound.upper === 0n)) {
    state.fail({
      severity: 'ERROR',
      code: 'ZERO_MULTIPLICITY_UNSUPPORTED',
      message: 'A relationship end with upper multiplicity 0 has no relational representation.',
      path: state.relationshipPath(relationship.id),
      sourceIds: [relationship.id, relationship.source.elementId, relationship.target.elementId],
    });
  }
  if (bounds.some((bound) => bound.lower > 1n || (bound.upper !== null && bound.upper > 1n))) {
    state.warning(
      'MULTIPLICITY_RANGE_NOT_ENFORCED',
      'Finite UML multiplicity bounds above one are preserved on foreign keys but are not enforced by this relational contract.',
      state.relationshipPath(relationship.id),
      [relationship.id, relationship.source.elementId, relationship.target.elementId],
    );
  }
}

function isMany(value: string): boolean {
  const bounds = parseMultiplicity(value);
  return bounds.upper === null || bounds.upper > 1n;
}

function parseMultiplicity(value: string): MultiplicityBounds {
  if (value === '*') {
    return { lower: 0n, upper: null };
  }
  if (!value.includes('..')) {
    const exact = BigInt(value);
    return { lower: exact, upper: exact };
  }
  const [lower, upper] = value.split('..');
  return {
    lower: BigInt(lower!),
    upper: upper === '*' ? null : BigInt(upper!),
  };
}

function trace(sourceIds: string[], sourcePaths: string[], rule: string): RelationalTraceability {
  return {
    sourceIds: uniqueSorted(sourceIds),
    sourcePaths: uniqueSorted(sourcePaths),
    rule,
  };
}

function sortedClassifiers(classifiers: UmlClassifier[]): UmlClassifier[] {
  return classifiers.toSorted((left, right) => left.id.localeCompare(right.id));
}

function sortedAttributes(attributes: UmlAttribute[]): UmlAttribute[] {
  return attributes.toSorted((left, right) => left.id.localeCompare(right.id));
}

function sortedRelationships(relationships: UmlRelationship[]): UmlRelationship[] {
  return relationships.toSorted((left, right) => left.id.localeCompare(right.id));
}

function normalizeTable(table: RelationalTable): RelationalTable {
  return {
    ...table,
    columns: table.columns.toSorted((left, right) => {
      if (left.primaryKey !== right.primaryKey) {
        return left.primaryKey ? -1 : 1;
      }
      return left.id.localeCompare(right.id);
    }),
    foreignKeys: table.foreignKeys.toSorted((left, right) => left.id.localeCompare(right.id)),
    uniqueConstraints: table.uniqueConstraints.toSorted((left, right) =>
      left.id.localeCompare(right.id),
    ),
  };
}

function compareDiagnostics(left: RelationalDiagnostic, right: RelationalDiagnostic): number {
  const severity = { ERROR: 0, WARNING: 1, INFO: 2 } as const;
  return (
    severity[left.severity] - severity[right.severity] ||
    left.code.localeCompare(right.code) ||
    (left.path ?? '').localeCompare(right.path ?? '') ||
    (left.message ?? '').localeCompare(right.message ?? '')
  );
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].toSorted((left, right) => left.localeCompare(right));
}

function toPhysicalName(value: string): string {
  const ascii = value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  const snake = ascii
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
  const normalized = snake || 'unnamed';
  const identifier = /^[a-z]/.test(normalized) ? normalized : `n_${normalized}`;
  return truncateIdentifier(
    POSTGRES_RESERVED_WORDS.has(identifier) ? `${identifier}_` : identifier,
  );
}

function toJavaPropertyName(value: string): string {
  const parts = toPhysicalName(value).split('_').filter(Boolean);
  const first = parts.shift() ?? 'value';
  const result = first + parts.map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join('');
  const safeResult = JAVA_RESERVED_WORDS.has(result) ? `${result}Value` : result;
  return /^[A-Za-z_$]/.test(safeResult) ? safeResult : `value${safeResult}`;
}

function toJavaTypeName(value: string): string {
  const result = toPhysicalName(value)
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
  return /^[A-Z]/.test(result) ? result : `Type${result}`;
}

function constraintName(value: string): string {
  return toPhysicalName(value);
}

function boundedLogicalName(value: string): string {
  const maxLength = 240;
  if (value.length <= maxLength) {
    return value;
  }
  const suffix = `_${shortStableHash(value)}`;
  return `${value.slice(0, maxLength - suffix.length)}${suffix}`;
}

function artifactId(value: string): string {
  const maxLength = 160;
  if (value.length <= maxLength) {
    return value;
  }
  const hash = shortStableHash(value);
  return `${value.slice(0, maxLength - hash.length - 1)}_${hash}`;
}

function truncateIdentifier(value: string, hashInput = value): string {
  if (value.length <= 63) {
    return value;
  }
  const hash = fnv1a(hashInput).toString(16).padStart(8, '0');
  return `${value.slice(0, 54)}_${hash}`;
}

function appendStableHash(value: string, discriminator: string): string {
  return truncateIdentifier(`${value}_${shortStableHash(discriminator)}`);
}

function appendStableJavaNameHash(value: string, discriminator: string): string {
  const suffix = `_${shortStableHash(discriminator)}`;
  const maxLength = 160;
  return `${value.slice(0, maxLength - suffix.length)}${suffix}`;
}

function shortStableHash(value: string): string {
  return fnv1a(value).toString(16).padStart(8, '0');
}

function fnv1a(value: string): number {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function sortJsonKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonKeys);
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .toSorted()
        .map((key) => [key, sortJsonKeys(record[key])]),
    );
  }
  return value;
}
