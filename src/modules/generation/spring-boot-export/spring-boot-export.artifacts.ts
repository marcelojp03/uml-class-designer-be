import { createHash } from 'node:crypto';
import type {
  RelationalColumn,
  RelationalForeignKey,
  RelationalModel,
  RelationalTable,
} from '../relational-model';
import { serializeRelationalModel } from '../relational-model';
import type { GeneratedFile, GeneratedSpringProject } from '../spring-boot';
import {
  SPRING_BOOT_EXPORT_VERSION,
  SpringBootExportArtifactError,
  type GeneratedSpringBootExportArtifacts,
} from './spring-boot-export.types';

const OPENAPI_PATH = 'openapi/generated-api.openapi.json';
const POSTMAN_PATH = 'postman/generated-api.postman_collection.json';
const MANIFEST_PATH = 'generation-manifest.json';

interface OwnedColumn {
  owner: RelationalTable;
  column: RelationalColumn;
}

interface IdentifierDescriptor {
  columns: OwnedColumn[];
  composite: boolean;
  generated: boolean;
}

interface ForeignKeyDescriptor {
  owner: RelationalTable;
  foreignKey: RelationalForeignKey;
  localColumns: OwnedColumn[];
  referencedTable: RelationalTable;
  referencedColumns: OwnedColumn[];
}

interface ResourceDescriptor {
  id: string;
  table: RelationalTable;
  route: string;
  identifier: IdentifierDescriptor;
  fields: OwnedColumn[];
  foreignKeys: ForeignKeyDescriptor[];
  dependencies: string[];
  variablePrefix: string;
}

interface ResourceAction {
  resource: ResourceDescriptor;
  operation: 'create' | 'list' | 'get' | 'update' | 'delete';
}

export function generateSpringBootExportArtifacts(
  relationalModel: RelationalModel,
  input: { documentRevision: number; project: GeneratedSpringProject },
): GeneratedSpringBootExportArtifacts {
  if (!Number.isSafeInteger(input.documentRevision) || input.documentRevision < 0) {
    throw new SpringBootExportArtifactError(
      'DOCUMENT_REVISION_INVALID',
      'Document revision must be a non-negative integer.',
    );
  }

  const tableById = new Map(relationalModel.tables.map((table) => [table.id, table]));
  const resources = buildResourceDescriptors(relationalModel, tableById);
  const openApiDocument = buildOpenApiDocument(input.project, resources, tableById);
  assertGeneratedOpenApiDocument(openApiDocument, resources);
  const postmanCollection = buildPostmanCollection(input.project, resources, tableById);
  assertGeneratedPostmanCollection(postmanCollection, resources);

  const openApi = generatedJsonFile(OPENAPI_PATH, openApiDocument);
  const postmanCollectionFile = generatedJsonFile(POSTMAN_PATH, postmanCollection);
  const checksummedFiles = [...input.project.files, openApi, postmanCollectionFile].toSorted(
    compareFiles,
  );
  const manifest = generatedJsonFile(MANIFEST_PATH, {
    applicationName: input.project.metadata.applicationName,
    artifactId: input.project.metadata.artifactId,
    documentRevision: input.documentRevision,
    generatorVersion: SPRING_BOOT_EXPORT_VERSION,
    groupId: input.project.metadata.groupId,
    openapiPath: OPENAPI_PATH,
    packageName: input.project.metadata.packageName,
    postmanCollectionPath: POSTMAN_PATH,
    relationalModelSha256: sha256(serializeRelationalModel(relationalModel)),
    relationalModelVersion: relationalModel.schemaVersion,
    sha256: Object.fromEntries(checksummedFiles.map((file) => [file.path, file.sha256])),
    springBootGeneratorVersion: input.project.generatorVersion,
  });
  const files = [openApi, postmanCollectionFile, manifest].toSorted(compareFiles);
  assertArtifactFiles(files);

  return { openApi, postmanCollection: postmanCollectionFile, manifest, files };
}

export function assertGeneratedOpenApiDocument(
  value: unknown,
  resources: readonly ResourceDescriptor[] = [],
): asserts value is Record<string, unknown> {
  if (
    !isRecord(value) ||
    value.openapi !== '3.1.0' ||
    !isRecord(value.info) ||
    !isRecord(value.paths)
  ) {
    throw new SpringBootExportArtifactError(
      'OPENAPI_INVALID',
      'Generated OpenAPI must be a valid static OpenAPI 3.1 document.',
    );
  }
  const paths = value.paths;
  const actualPaths = Object.keys(paths).toSorted();
  const expectedPaths = resources.flatMap((resource) => [
    `/api/${resource.route}`,
    `/api/${resource.route}/{id}`,
  ]);
  if (
    resources.length > 0 &&
    JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths.toSorted())
  ) {
    throw new SpringBootExportArtifactError(
      'OPENAPI_PATHS_INVALID',
      'Generated OpenAPI paths do not match generated Spring controllers.',
    );
  }
  for (const resource of resources) {
    const collection = paths[`/api/${resource.route}`];
    const item = paths[`/api/${resource.route}/{id}`];
    if (
      !isRecord(collection) ||
      !isRecord(item) ||
      !isRecord(collection.get) ||
      !isRecord(collection.post) ||
      !isRecord(item.get) ||
      !isRecord(item.put) ||
      !isRecord(item.delete)
    ) {
      throw new SpringBootExportArtifactError(
        'OPENAPI_OPERATIONS_INVALID',
        `Generated OpenAPI CRUD operations are incomplete for ${resource.table.javaEntityName}.`,
      );
    }
  }
}

export function assertGeneratedPostmanCollection(
  value: unknown,
  resources: readonly ResourceDescriptor[] = [],
): asserts value is Record<string, unknown> {
  if (
    !isRecord(value) ||
    !isRecord(value.info) ||
    value.info.schema !== postmanSchemaUrl() ||
    !Array.isArray(value.variable) ||
    !Array.isArray(value.item)
  ) {
    throw new SpringBootExportArtifactError(
      'POSTMAN_INVALID',
      'Generated Postman collection must use collection format v2.1.',
    );
  }
  const baseUrl = value.variable.find(
    (candidate): candidate is Record<string, unknown> =>
      isRecord(candidate) && candidate.key === 'baseUrl',
  );
  if (!baseUrl || typeof baseUrl.value !== 'string') {
    throw new SpringBootExportArtifactError(
      'POSTMAN_BASE_URL_MISSING',
      'Generated Postman collection must define a baseUrl variable.',
    );
  }
  if (resources.length > 0 && value.item.length !== resources.length) {
    throw new SpringBootExportArtifactError(
      'POSTMAN_RESOURCE_FOLDERS_INVALID',
      'Generated Postman collection must include one folder per exposed resource.',
    );
  }
  for (const resource of resources) {
    const folder = value.item.find(
      (candidate): candidate is Record<string, unknown> =>
        isRecord(candidate) && candidate.name === resource.table.javaEntityName,
    );
    if (!folder || !Array.isArray(folder.item) || folder.item.length !== 5) {
      throw new SpringBootExportArtifactError(
        'POSTMAN_CRUD_INVALID',
        `Generated Postman CRUD requests are incomplete for ${resource.table.javaEntityName}.`,
      );
    }
  }
}

function buildResourceDescriptors(
  model: RelationalModel,
  tableById: ReadonlyMap<string, RelationalTable>,
): ResourceDescriptor[] {
  const rawResources = model.tables
    .toSorted(compareTables)
    .filter((table) => table.isAbstract !== true)
    .map((table, index) => ({
      id: table.id,
      table,
      route: table.physicalName.replaceAll('_', '-'),
      identifier: identifierDescriptor(table, tableById),
      fields: entityFields(table, tableById),
      foreignKeys: foreignKeyDescriptors(table, tableById),
      dependencies: [],
      variablePrefix: `generated_${String(index + 1).padStart(3, '0')}_${table.physicalName}`,
    }));

  return rawResources.map((resource) => ({
    ...resource,
    dependencies: resource.foreignKeys
      .map((reference) => targetResourceFor(reference, rawResources, tableById).id)
      .filter((targetId) => targetId !== resource.id)
      .filter((targetId, index, values) => values.indexOf(targetId) === index)
      .toSorted(),
  }));
}

function buildOpenApiDocument(
  project: GeneratedSpringProject,
  resources: readonly ResourceDescriptor[],
  tableById: ReadonlyMap<string, RelationalTable>,
): Record<string, unknown> {
  const paths: Record<string, unknown> = {};
  const schemas: Record<string, unknown> = {
    ApiError: {
      additionalProperties: false,
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
        status: { maximum: 599, minimum: 100, type: 'integer' },
      },
      required: ['status', 'code', 'message'],
      type: 'object',
    },
  };

  for (const resource of resources) {
    schemas[`${resource.table.javaEntityName}Request`] = resourceSchema(resource, tableById, false);
    schemas[`${resource.table.javaEntityName}Response`] = resourceSchema(resource, tableById, true);
    schemas[`${resource.table.javaEntityName}Id`] = identifierSchema(
      resource.identifier,
      tableById,
      false,
    );

    const collectionPath = `/api/${resource.route}`;
    const itemPath = `${collectionPath}/{id}`;
    paths[collectionPath] = {
      get: openApiOperation(resource, 'list'),
      post: openApiOperation(resource, 'create'),
    };
    paths[itemPath] = {
      delete: openApiOperation(resource, 'delete'),
      get: openApiOperation(resource, 'get'),
      put: openApiOperation(resource, 'update'),
    };
  }

  return {
    components: { schemas },
    info: {
      description:
        'Static contract for the deterministic Spring Boot project generated by UML Class Designer.',
      title: `${project.metadata.artifactId} generated API`,
      version: project.generatorVersion,
    },
    openapi: '3.1.0',
    paths,
  };
}

function openApiOperation(
  resource: ResourceDescriptor,
  operationName: ResourceAction['operation'],
): Record<string, unknown> {
  const entityName = resource.table.javaEntityName;
  const responseReference = { $ref: `#/components/schemas/${entityName}Response` };
  const errorReference = { $ref: '#/components/schemas/ApiError' };
  const errors = {
    '400': errorResponse('Invalid identifier or request body.', errorReference),
    '404': errorResponse('Resource or referenced relationship was not found.', errorReference),
    '409': errorResponse('A database constraint prevented the requested change.', errorReference),
  };
  const idParameter = {
    description: resource.identifier.composite
      ? `Comma-separated identifier values in this order: ${resource.identifier.columns.map(({ column }) => column.javaPropertyName).join(', ')}.`
      : 'Resource identifier.',
    in: 'path',
    name: 'id',
    required: true,
    schema: { type: 'string' },
  };

  if (operationName === 'list') {
    return {
      operationId: `list${entityName}`,
      responses: {
        '200': {
          content: { 'application/json': { schema: { items: responseReference, type: 'array' } } },
          description: 'Resources returned successfully.',
        },
      },
      summary: `List ${entityName} resources.`,
      tags: [entityName],
    };
  }
  if (operationName === 'get') {
    return {
      operationId: `get${entityName}`,
      parameters: [idParameter],
      responses: {
        '200': jsonResponse('Resource returned successfully.', responseReference),
        ...errors,
      },
      summary: `Get one ${entityName} resource.`,
      tags: [entityName],
    };
  }
  if (operationName === 'delete') {
    return {
      operationId: `delete${entityName}`,
      parameters: [idParameter],
      responses: { '204': { description: 'Resource deleted successfully.' }, ...errors },
      summary: `Delete one ${entityName} resource.`,
      tags: [entityName],
    };
  }
  return {
    operationId: `${operationName}${entityName}`,
    ...(operationName === 'update' ? { parameters: [idParameter] } : {}),
    requestBody: {
      content: {
        'application/json': { schema: { $ref: `#/components/schemas/${entityName}Request` } },
      },
      required: true,
    },
    responses: {
      ...(operationName === 'create'
        ? { '201': jsonResponse('Resource created successfully.', responseReference) }
        : { '200': jsonResponse('Resource updated successfully.', responseReference) }),
      ...errors,
    },
    summary: `${operationName === 'create' ? 'Create' : 'Update'} one ${entityName} resource.`,
    tags: [entityName],
  };
}

function resourceSchema(
  resource: ResourceDescriptor,
  tableById: ReadonlyMap<string, RelationalTable>,
  response: boolean,
): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    id: identifierSchema(
      resource.identifier,
      tableById,
      !response && resource.identifier.generated,
    ),
  };
  const required = response || !resource.identifier.generated ? ['id'] : [];
  for (const field of resource.fields) {
    properties[field.column.javaPropertyName] = columnSchema(field, tableById);
    if (response || (!field.column.nullable && field.column.defaultValue === undefined)) {
      required.push(field.column.javaPropertyName);
    }
  }
  return {
    additionalProperties: false,
    properties,
    ...(required.length > 0 ? { required } : {}),
    type: 'object',
  };
}

function identifierSchema(
  identifier: IdentifierDescriptor,
  tableById: ReadonlyMap<string, RelationalTable>,
  generatedRequestId: boolean,
): Record<string, unknown> {
  if (!identifier.composite) {
    const schema = columnSchema(identifier.columns[0]!, tableById);
    return generatedRequestId
      ? { ...schema, description: 'Optional client value; the database generates this UUID.' }
      : schema;
  }
  return {
    additionalProperties: false,
    properties: Object.fromEntries(
      identifier.columns.map((owned) => [
        owned.column.javaPropertyName,
        columnSchema(owned, tableById),
      ]),
    ),
    required: identifier.columns.map(({ column }) => column.javaPropertyName),
    type: 'object',
  };
}

function columnSchema(
  owned: OwnedColumn,
  tableById: ReadonlyMap<string, RelationalTable>,
): Record<string, unknown> {
  const javaType = scalarJavaType(owned.owner, owned.column, tableById);
  const schema = scalarSchema(javaType);
  const foreignKeys = owned.owner.foreignKeys
    .filter(
      (foreignKey) =>
        foreignKey.columnIds.includes(owned.column.id) &&
        !isJoinedInheritanceForeignKey(owned.owner, foreignKey),
    )
    .toSorted(compareForeignKeys);
  const relationshipExtension =
    foreignKeys.length === 1
      ? { 'x-foreign-key': foreignKeyExtension(foreignKeys[0]!, tableById) }
      : foreignKeys.length > 1
        ? {
            'x-foreign-keys': foreignKeys.map((foreignKey) =>
              foreignKeyExtension(foreignKey, tableById),
            ),
          }
        : {};
  const extensions = {
    'x-java-type': javaType,
    'x-postgres-type': owned.column.postgresType,
    ...relationshipExtension,
  };
  if (!owned.column.nullable) return { ...schema, ...extensions };
  return { anyOf: [schema, { type: 'null' }], ...extensions };
}

function foreignKeyExtension(
  foreignKey: RelationalForeignKey,
  tableById: ReadonlyMap<string, RelationalTable>,
): Record<string, unknown> {
  return {
    onDelete: foreignKey.onDelete,
    referencedTable: tableById.get(foreignKey.referencedTableId)?.physicalName,
  };
}

function scalarSchema(javaType: string): Record<string, unknown> {
  switch (javaType) {
    case 'UUID':
      return { format: 'uuid', type: 'string' };
    case 'LocalDate':
      return { format: 'date', type: 'string' };
    case 'Instant':
    case 'LocalDateTime':
      return { format: 'date-time', type: 'string' };
    case 'byte[]':
      return { format: 'byte', type: 'string' };
    case 'Character':
      return { maxLength: 1, minLength: 1, type: 'string' };
    case 'Boolean':
      return { type: 'boolean' };
    case 'Byte':
    case 'Short':
    case 'Integer':
      return { format: 'int32', type: 'integer' };
    case 'Long':
      return { format: 'int64', type: 'integer' };
    case 'BigInteger':
      return { type: 'integer' };
    case 'Float':
      return { format: 'float', type: 'number' };
    case 'Double':
      return { format: 'double', type: 'number' };
    case 'BigDecimal':
      return { type: 'number' };
    case 'JsonNode':
      return {};
    default:
      return { type: 'string' };
  }
}

function buildPostmanCollection(
  project: GeneratedSpringProject,
  resources: readonly ResourceDescriptor[],
  tableById: ReadonlyMap<string, RelationalTable>,
): Record<string, unknown> {
  const orderedResources = dependencyOrder(resources);
  const actions = [
    ...orderedResources.map((resource) => ({ resource, operation: 'create' as const })),
    ...orderedResources.map((resource) => ({ resource, operation: 'list' as const })),
    ...orderedResources.map((resource) => ({ resource, operation: 'get' as const })),
    ...orderedResources.map((resource) => ({ resource, operation: 'update' as const })),
    ...orderedResources
      .toReversed()
      .map((resource) => ({ resource, operation: 'delete' as const })),
  ];
  const nextAction = new Map<string, string | undefined>(
    actions.map((action, index) => [
      actionKey(action),
      actions[index + 1] ? actionName(actions[index + 1]!) : undefined,
    ]),
  );
  const captures = captureColumnsByResource(resources, tableById);
  const cycles = dependencyCycles(resources);

  return {
    info: {
      description: [
        `Deterministic CRUD collection for ${project.metadata.artifactId}.`,
        'Run with Newman after setting the baseUrl collection variable.',
        cycles.length === 0
          ? 'Dependencies run parent to child and cleanup runs child to parent.'
          : `Cycles detected: ${cycles.join(', ')}. Nullable cycle references are created as null and set during update; fully required cycles need a model change because PostgreSQL cannot create the initial rows safely.`,
      ].join('\n\n'),
      name: `${project.metadata.artifactId} generated API`,
      schema: postmanSchemaUrl(),
    },
    item: orderedResources.map((resource) => ({
      description: `CRUD requests for ${resource.table.javaEntityName}.`,
      item: (['create', 'list', 'get', 'update', 'delete'] as const).map((operation) =>
        postmanRequest(
          resource,
          operation,
          resources,
          tableById,
          captures.get(resource.id) ?? [],
          nextAction.get(actionKey({ resource, operation })),
        ),
      ),
      name: resource.table.javaEntityName,
    })),
    variable: [
      {
        key: 'baseUrl',
        type: 'string',
        value: 'http://127.0.0.1:8080',
      },
    ],
  };
}

function postmanRequest(
  resource: ResourceDescriptor,
  operation: ResourceAction['operation'],
  resources: readonly ResourceDescriptor[],
  tableById: ReadonlyMap<string, RelationalTable>,
  captures: readonly OwnedColumn[],
  next: string | undefined,
): Record<string, unknown> {
  const path = `{{baseUrl}}/api/${resource.route}`;
  const url =
    operation === 'get' || operation === 'update' || operation === 'delete'
      ? `${path}/${identifierPath(resource)}`
      : path;
  const method =
    operation === 'create'
      ? 'POST'
      : operation === 'update'
        ? 'PUT'
        : operation === 'delete'
          ? 'DELETE'
          : 'GET';
  const expectedStatus = operation === 'create' ? 201 : operation === 'delete' ? 204 : 200;
  const request: Record<string, unknown> = {
    method,
    url,
  };
  if (operation === 'create' || operation === 'update') {
    request.header = [{ key: 'Content-Type', type: 'text', value: 'application/json' }];
    request.body = {
      mode: 'raw',
      options: { raw: { language: 'json' } },
      raw: `${JSON.stringify(requestPayload(resource, operation, resources, tableById), null, 2)}\n`,
    };
  }
  return {
    event: [
      {
        listen: 'test',
        script: {
          exec: postmanTestScript(resource, operation, expectedStatus, captures, next),
          type: 'text/javascript',
        },
      },
    ],
    name: actionName({ resource, operation }),
    request,
  };
}

function postmanTestScript(
  resource: ResourceDescriptor,
  operation: ResourceAction['operation'],
  expectedStatus: number,
  captures: readonly OwnedColumn[],
  next: string | undefined,
): string[] {
  const lines = [
    `pm.test(${JSON.stringify(`${operation} returns ${expectedStatus}`)}, function () {`,
    `  pm.response.to.have.status(${expectedStatus});`,
    '});',
  ];
  if (operation === 'create' || operation === 'update') {
    lines.push('const response = pm.response.json();');
    for (const column of captures) {
      lines.push(
        `pm.collectionVariables.set(${JSON.stringify(columnVariable(resource, column))}, String(${responsePath(resource, column)}));`,
      );
    }
  }
  lines.push(`pm.execution.setNextRequest(${next ? JSON.stringify(next) : 'null'});`);
  return lines;
}

function requestPayload(
  resource: ResourceDescriptor,
  operation: 'create' | 'update',
  resources: readonly ResourceDescriptor[],
  tableById: ReadonlyMap<string, RelationalTable>,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (!resource.identifier.generated) {
    payload.id = resource.identifier.composite
      ? Object.fromEntries(
          resource.identifier.columns.map((column) => [
            column.column.javaPropertyName,
            valueForColumn(resource, column, operation, resources, tableById),
          ]),
        )
      : valueForColumn(resource, resource.identifier.columns[0]!, operation, resources, tableById);
  }
  for (const field of resource.fields) {
    payload[field.column.javaPropertyName] = valueForColumn(
      resource,
      field,
      operation,
      resources,
      tableById,
    );
  }
  return payload;
}

function valueForColumn(
  resource: ResourceDescriptor,
  owned: OwnedColumn,
  operation: 'create' | 'update',
  resources: readonly ResourceDescriptor[],
  tableById: ReadonlyMap<string, RelationalTable>,
): unknown {
  if (operation === 'update' && isIdentifierColumn(resource, owned)) {
    return `{{${columnVariable(resource, owned)}}}`;
  }

  const reference = referenceForColumn(resource, owned);
  if (reference) {
    const target = targetResourceFor(reference, resources, tableById);
    if (
      operation === 'create' &&
      isCyclicReference(resource, target, resources) &&
      reference.localColumns.every(({ column }) => column.nullable)
    ) {
      return null;
    }
    const referenceIndex = reference.localColumns.findIndex(
      (candidate) =>
        candidate.owner.id === owned.owner.id && candidate.column.id === owned.column.id,
    );
    const referenced = reference.referencedColumns[referenceIndex];
    if (!referenced) {
      throw new SpringBootExportArtifactError(
        'FOREIGN_KEY_COLUMN_MISSING',
        `Foreign key ${reference.foreignKey.id} cannot resolve ${owned.column.id}.`,
      );
    }
    return `{{${columnVariable(target, referenced)}}}`;
  }

  if (owned.column.nullable) return null;
  return exampleValue(
    scalarJavaType(owned.owner, owned.column, tableById),
    resource,
    owned.column,
    operation,
  );
}

function exampleValue(
  javaType: string,
  resource: ResourceDescriptor,
  column: RelationalColumn,
  operation: 'create' | 'update',
): unknown {
  const ordinal = Number(resource.variablePrefix.slice(10, 13));
  const suffix = operation === 'update' ? 'updated' : 'created';
  switch (javaType) {
    case 'Boolean':
      return operation === 'update';
    case 'Byte':
    case 'Short':
    case 'Integer':
    case 'Long':
    case 'BigInteger':
      return ordinal * 100 + column.javaPropertyName.length;
    case 'Float':
    case 'Double':
    case 'BigDecimal':
      return ordinal + column.javaPropertyName.length / 100;
    case 'UUID':
      return `00000000-0000-4000-8000-${String(ordinal * 100 + column.javaPropertyName.length).padStart(12, '0')}`;
    case 'LocalDate':
      return '2026-01-02';
    case 'Instant':
      return '2026-01-02T03:04:05Z';
    case 'LocalDateTime':
      return '2026-01-02T03:04:05';
    case 'byte[]':
      return 'Z2VuZXJhdGVk';
    case 'JsonNode':
      return { source: 'generated' };
    case 'Character':
      return 'G';
    default:
      return `${resource.table.physicalName}-${column.javaPropertyName}-${suffix}`;
  }
}

function captureColumnsByResource(
  resources: readonly ResourceDescriptor[],
  tableById: ReadonlyMap<string, RelationalTable>,
): Map<string, OwnedColumn[]> {
  const captured = new Map<string, Map<string, OwnedColumn>>();
  for (const resource of resources) {
    captured.set(
      resource.id,
      new Map(resource.identifier.columns.map((column) => [ownedColumnKey(column), column])),
    );
  }
  for (const resource of resources) {
    for (const reference of resource.foreignKeys) {
      const target = targetResourceFor(reference, resources, tableById);
      const targetColumns = captured.get(target.id);
      if (!targetColumns) {
        throw new SpringBootExportArtifactError(
          'FOREIGN_KEY_TARGET_MISSING',
          `Foreign key ${reference.foreignKey.id} target is not exposed.`,
        );
      }
      for (const column of reference.referencedColumns) {
        targetColumns.set(ownedColumnKey(column), column);
      }
    }
  }
  return new Map(
    [...captured.entries()].map(([resourceId, columns]) => [
      resourceId,
      [...columns.values()].toSorted(compareOwnedColumns),
    ]),
  );
}

function dependencyOrder(resources: readonly ResourceDescriptor[]): ResourceDescriptor[] {
  const resourceById = new Map(resources.map((resource) => [resource.id, resource]));
  const unresolved = new Map(
    resources.map((resource) => [
      resource.id,
      new Set(resource.dependencies.filter((dependency) => resourceById.has(dependency))),
    ]),
  );
  const ordered: ResourceDescriptor[] = [];
  while (unresolved.size > 0) {
    const ready = [...unresolved.entries()]
      .filter(([, dependencies]) => dependencies.size === 0)
      .map(([id]) => resourceById.get(id)!)
      .toSorted(compareResources);
    if (ready.length === 0) {
      ordered.push(
        ...[...unresolved.keys()].map((id) => resourceById.get(id)!).toSorted(compareResources),
      );
      break;
    }
    for (const resource of ready) {
      ordered.push(resource);
      unresolved.delete(resource.id);
      for (const dependencies of unresolved.values()) dependencies.delete(resource.id);
    }
  }
  return ordered;
}

function dependencyCycles(resources: readonly ResourceDescriptor[]): string[] {
  const resourceById = new Map(resources.map((resource) => [resource.id, resource]));
  return resources
    .filter((resource) =>
      resource.dependencies.some((dependency) => pathExists(dependency, resource.id, resourceById)),
    )
    .map((resource) => resource.table.javaEntityName)
    .toSorted();
}

function isCyclicReference(
  resource: ResourceDescriptor,
  target: ResourceDescriptor,
  resources: readonly ResourceDescriptor[],
): boolean {
  return pathExists(
    target.id,
    resource.id,
    new Map(resources.map((candidate) => [candidate.id, candidate])),
  );
}

function pathExists(
  startId: string,
  targetId: string,
  resourceById: ReadonlyMap<string, ResourceDescriptor>,
  seen = new Set<string>(),
): boolean {
  if (startId === targetId) return true;
  if (seen.has(startId)) return false;
  seen.add(startId);
  const resource = resourceById.get(startId);
  return (
    resource?.dependencies.some((dependency) =>
      pathExists(dependency, targetId, resourceById, seen),
    ) ?? false
  );
}

function identifierPath(resource: ResourceDescriptor): string {
  return resource.identifier.columns
    .map((column) => `{{${columnVariable(resource, column)}}}`)
    .join(',');
}

function columnVariable(resource: ResourceDescriptor, column: OwnedColumn): string {
  if (isIdentifierColumn(resource, column)) {
    return resource.identifier.composite
      ? `${resource.variablePrefix}_${column.column.javaPropertyName}`
      : `${resource.variablePrefix}_id`;
  }
  return `${resource.variablePrefix}_${column.column.javaPropertyName}`;
}

function responsePath(resource: ResourceDescriptor, column: OwnedColumn): string {
  if (!isIdentifierColumn(resource, column)) {
    return `response.${column.column.javaPropertyName}`;
  }
  return resource.identifier.composite
    ? `response.id.${column.column.javaPropertyName}`
    : 'response.id';
}

function isIdentifierColumn(resource: ResourceDescriptor, column: OwnedColumn): boolean {
  return resource.identifier.columns.some(
    (candidate) =>
      candidate.owner.id === column.owner.id && candidate.column.id === column.column.id,
  );
}

function actionName(action: ResourceAction): string {
  return `${action.resource.table.javaEntityName} / ${action.operation}`;
}

function actionKey(action: ResourceAction): string {
  return `${action.resource.id}:${action.operation}`;
}

function identifierDescriptor(
  table: RelationalTable,
  tableById: ReadonlyMap<string, RelationalTable>,
): IdentifierDescriptor {
  const root = rootTable(table, tableById);
  const columns = root.primaryKey.columnIds.map((id) => ({
    owner: root,
    column: columnById(root, id),
  }));
  if (columns.length === 0) {
    throw new SpringBootExportArtifactError(
      'PRIMARY_KEY_MISSING',
      `Table ${table.id} has no primary key.`,
    );
  }
  return {
    columns,
    composite: columns.length > 1,
    generated: columns.length === 1 && columns[0]!.column.generated === 'UUID',
  };
}

function entityFields(
  table: RelationalTable,
  tableById: ReadonlyMap<string, RelationalTable>,
): OwnedColumn[] {
  const identifier = identifierDescriptor(table, tableById);
  const identifierIds = new Set(identifier.columns.map(ownedColumnKey));
  return hierarchyTables(table, tableById).flatMap((owner) =>
    entityDirectColumns(owner)
      .map((column) => ({ owner, column }))
      .filter((column) => !identifierIds.has(ownedColumnKey(column))),
  );
}

function foreignKeyDescriptors(
  table: RelationalTable,
  tableById: ReadonlyMap<string, RelationalTable>,
): ForeignKeyDescriptor[] {
  return hierarchyTables(table, tableById).flatMap((owner) =>
    owner.foreignKeys
      .toSorted(compareForeignKeys)
      .filter((foreignKey) => !isJoinedInheritanceForeignKey(owner, foreignKey))
      .map((foreignKey) => {
        const referencedTable = tableById.get(foreignKey.referencedTableId);
        if (!referencedTable) {
          throw new SpringBootExportArtifactError(
            'FOREIGN_KEY_TARGET_MISSING',
            `Foreign key ${foreignKey.id} references a missing table.`,
          );
        }
        if (foreignKey.columnIds.length !== foreignKey.referencedColumnIds.length) {
          throw new SpringBootExportArtifactError(
            'FOREIGN_KEY_COLUMNS_INVALID',
            `Foreign key ${foreignKey.id} has a mismatched column count.`,
          );
        }
        return {
          owner,
          foreignKey,
          localColumns: foreignKey.columnIds.map((columnId) => ({
            owner,
            column: columnById(owner, columnId),
          })),
          referencedTable,
          referencedColumns: foreignKey.referencedColumnIds.map((columnId) => ({
            owner: referencedTable,
            column: columnById(referencedTable, columnId),
          })),
        };
      }),
  );
}

function targetResourceFor(
  reference: ForeignKeyDescriptor,
  resources: readonly ResourceDescriptor[],
  tableById: ReadonlyMap<string, RelationalTable>,
): ResourceDescriptor {
  const direct = resources.find((resource) => resource.table.id === reference.referencedTable.id);
  if (direct) return direct;
  const concreteDescendant = resources
    .filter((resource) => rootTable(resource.table, tableById).id === reference.referencedTable.id)
    .toSorted(compareResources)[0];
  if (concreteDescendant) return concreteDescendant;
  throw new SpringBootExportArtifactError(
    'FOREIGN_KEY_TARGET_UNEXPOSED',
    `Foreign key ${reference.foreignKey.id} references an abstract table without an exposed descendant.`,
  );
}

function referenceForColumn(
  resource: ResourceDescriptor,
  column: OwnedColumn,
): ForeignKeyDescriptor | undefined {
  return resource.foreignKeys.find((reference) =>
    reference.localColumns.some(
      (candidate) =>
        candidate.owner.id === column.owner.id && candidate.column.id === column.column.id,
    ),
  );
}

function hierarchyTables(
  table: RelationalTable,
  tableById: ReadonlyMap<string, RelationalTable>,
): RelationalTable[] {
  const result: RelationalTable[] = [];
  const seen = new Set<string>();
  let current: RelationalTable | undefined = table;
  while (current) {
    if (seen.has(current.id)) {
      throw new SpringBootExportArtifactError(
        'INHERITANCE_CYCLE',
        'Generated inheritance contains a cycle.',
      );
    }
    seen.add(current.id);
    result.unshift(current);
    const parentId: string | undefined =
      current.inheritance?.role === 'subclass' ? current.inheritance.parentTableId : undefined;
    current = parentId ? tableById.get(parentId) : undefined;
    if (parentId && !current) {
      throw new SpringBootExportArtifactError(
        'INHERITANCE_PARENT_MISSING',
        'Generated inheritance parent is missing.',
      );
    }
  }
  return result;
}

function rootTable(
  table: RelationalTable,
  tableById: ReadonlyMap<string, RelationalTable>,
): RelationalTable {
  return hierarchyTables(table, tableById)[0]!;
}

function entityDirectColumns(table: RelationalTable): RelationalColumn[] {
  const inheritedPrimaryKeys =
    table.inheritance?.role === 'subclass'
      ? new Set(table.primaryKey.columnIds)
      : new Set<string>();
  return table.columns
    .filter((column) => !inheritedPrimaryKeys.has(column.id))
    .toSorted(compareColumns);
}

function isJoinedInheritanceForeignKey(
  table: RelationalTable,
  foreignKey: RelationalForeignKey,
): boolean {
  return (
    table.inheritance?.role === 'subclass' &&
    foreignKey.referencedTableId === table.inheritance.parentTableId &&
    foreignKey.onDelete === 'CASCADE' &&
    sameIds(foreignKey.columnIds, table.primaryKey.columnIds) &&
    sameIds(foreignKey.referencedColumnIds, table.inheritance.parentColumnIds ?? [])
  );
}

function columnById(table: RelationalTable, id: string): RelationalColumn {
  const column = table.columns.find((candidate) => candidate.id === id);
  if (!column) {
    throw new SpringBootExportArtifactError(
      'COLUMN_MISSING',
      `Column ${id} is missing from table ${table.id}.`,
    );
  }
  return column;
}

function scalarJavaType(
  table: RelationalTable,
  column: RelationalColumn,
  tableById: ReadonlyMap<string, RelationalTable>,
  seen = new Set<string>(),
): string {
  const key = `${table.id}:${column.id}`;
  if (seen.has(key)) return column.javaType;
  const nestedSeen = new Set(seen).add(key);
  const types = table.foreignKeys
    .filter((foreignKey) => foreignKey.columnIds.includes(column.id))
    .toSorted(compareForeignKeys)
    .map((foreignKey) => {
      const target = tableById.get(foreignKey.referencedTableId);
      const index = foreignKey.columnIds.indexOf(column.id);
      const targetColumnId = foreignKey.referencedColumnIds[index];
      if (!target || !targetColumnId) {
        throw new SpringBootExportArtifactError(
          'FOREIGN_KEY_TARGET_MISSING',
          `Foreign key ${foreignKey.id} cannot resolve its target column.`,
        );
      }
      return scalarJavaType(target, columnById(target, targetColumnId), tableById, nestedSeen);
    });
  const distinct = [...new Set(types)];
  if (distinct.length > 1) {
    throw new SpringBootExportArtifactError(
      'FOREIGN_KEY_TYPE_CONFLICT',
      `Foreign key column ${column.id} resolves to conflicting Java types.`,
    );
  }
  return distinct[0] ?? column.javaType;
}

function generatedJsonFile(path: string, value: unknown): GeneratedFile {
  const content = `${JSON.stringify(sortJson(value), null, 2)}\n`;
  return { path, content, byteLength: Buffer.byteLength(content, 'utf8'), sha256: sha256(content) };
}

function assertArtifactFiles(files: readonly GeneratedFile[]): void {
  let previousPath = '';
  const paths = new Set<string>();
  for (const file of files) {
    if (
      paths.has(file.path) ||
      previousPath > file.path ||
      file.content.includes('\r') ||
      !file.content.endsWith('\n')
    ) {
      throw new SpringBootExportArtifactError(
        'ARTIFACT_FILES_INVALID',
        'Generated artifact files are invalid.',
      );
    }
    paths.add(file.path);
    previousPath = file.path;
    if (
      file.byteLength !== Buffer.byteLength(file.content, 'utf8') ||
      file.sha256 !== sha256(file.content)
    ) {
      throw new SpringBootExportArtifactError(
        'ARTIFACT_HASH_INVALID',
        'Generated artifact file checksum is invalid.',
      );
    }
  }
}

function jsonResponse(
  description: string,
  schema: Record<string, unknown>,
): Record<string, unknown> {
  return { content: { 'application/json': { schema } }, description };
}

function errorResponse(
  description: string,
  schema: Record<string, unknown>,
): Record<string, unknown> {
  return jsonResponse(description, schema);
}

function postmanSchemaUrl(): string {
  return 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .toSorted()
      .map((key) => [key, sortJson(value[key])]),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function ownedColumnKey(value: OwnedColumn): string {
  return `${value.owner.id}:${value.column.id}`;
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function compareFiles(left: GeneratedFile, right: GeneratedFile): number {
  return compareStrings(left.path, right.path);
}

function compareResources(left: ResourceDescriptor, right: ResourceDescriptor): number {
  return compareStrings(left.id, right.id);
}

function compareTables(left: RelationalTable, right: RelationalTable): number {
  return compareStrings(left.id, right.id);
}

function compareColumns(left: RelationalColumn, right: RelationalColumn): number {
  if (left.primaryKey !== right.primaryKey) return left.primaryKey ? -1 : 1;
  return compareStrings(left.id, right.id);
}

function compareOwnedColumns(left: OwnedColumn, right: OwnedColumn): number {
  return compareStrings(ownedColumnKey(left), ownedColumnKey(right));
}

function compareForeignKeys(left: RelationalForeignKey, right: RelationalForeignKey): number {
  return compareStrings(left.id, right.id);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
