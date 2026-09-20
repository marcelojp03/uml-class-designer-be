import { createHash } from 'node:crypto';
import type {
  RelationalColumn,
  RelationalForeignKey,
  RelationalModel,
  RelationalTable,
} from '../relational-model';
import { assertRelationalModelContract, RelationalModelContractError } from '../relational-model';
import {
  FLYWAY_VERSION,
  JAVA_VERSION,
  SPRING_BOOT_GENERATOR_VERSION,
  SPRING_BOOT_VERSION,
} from './spring-boot.types';
import { assertGeneratedSpringProjectContract } from './spring-boot-project.validator';
import type {
  GeneratedFile,
  GeneratedSpringProject,
  SpringBootGeneratorOptions,
} from './spring-boot.types';

export interface SpringBootGenerationIssue {
  code: string;
  message: string;
  path?: string;
}

export class SpringBootProjectGenerationError extends Error {
  constructor(readonly issues: SpringBootGenerationIssue[]) {
    super('Spring Boot project generation failed.');
    this.name = 'SpringBootProjectGenerationError';
  }
}

interface NormalizedOptions {
  packageName: string;
  groupId: string;
  artifactId: string;
  applicationName: string;
}

interface GenerationContext {
  model: RelationalModel;
  options: NormalizedOptions;
  tables: RelationalTable[];
  tableById: Map<string, RelationalTable>;
  packagePath: string;
}

interface ColumnBinding {
  table: RelationalTable;
  column: RelationalColumn;
  javaType: string;
}

interface IdentifierDescriptor {
  type: string;
  composite: boolean;
  generated: boolean;
  columns: RelationalColumn[];
}

const JAVA_SCALAR_IMPORTS: Record<string, string> = {
  BigDecimal: 'java.math.BigDecimal',
  BigInteger: 'java.math.BigInteger',
  Instant: 'java.time.Instant',
  LocalDate: 'java.time.LocalDate',
  LocalDateTime: 'java.time.LocalDateTime',
  UUID: 'java.util.UUID',
};

const SUPPORTED_JAVA_TYPES = new Set([
  'String',
  'Character',
  'Boolean',
  'Byte',
  'Short',
  'Integer',
  'Long',
  'Float',
  'Double',
  'BigDecimal',
  'BigInteger',
  'LocalDate',
  'LocalDateTime',
  'Instant',
  'UUID',
  'byte[]',
  'JsonNode',
]);

const SUPPORTED_POSTGRES_TYPES = new Set([
  'varchar(255)',
  'text',
  'char',
  'boolean',
  'smallint',
  'integer',
  'bigint',
  'real',
  'double precision',
  'numeric(19,2)',
  'numeric(38,0)',
  'date',
  'timestamp(3)',
  'timestamptz(3)',
  'uuid',
  'bytea',
  'jsonb',
]);

const FALLBACK_JAVA_TYPES_BY_POSTGRES_TYPE: Readonly<Record<string, string>> = {
  'varchar(255)': 'String',
  text: 'String',
  char: 'String',
  boolean: 'Boolean',
  smallint: 'Short',
  integer: 'Integer',
  bigint: 'Long',
  real: 'Float',
  'double precision': 'Double',
  'numeric(19,2)': 'BigDecimal',
  'numeric(38,0)': 'BigInteger',
  date: 'LocalDate',
  'timestamp(3)': 'LocalDateTime',
  'timestamptz(3)': 'Instant',
  uuid: 'UUID',
  bytea: 'byte[]',
  jsonb: 'JsonNode',
};

const JAVA_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const PACKAGE_IDENTIFIER = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)*$/;
const ARTIFACT_IDENTIFIER = /^[a-z][a-z0-9.-]{0,99}$/;
const SQL_IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/;

const POSTGRES_RESERVED_KEYWORDS = new Set([
  'all',
  'analyse',
  'analyze',
  'and',
  'any',
  'array',
  'as',
  'asc',
  'asymmetric',
  'authorization',
  'binary',
  'both',
  'case',
  'cast',
  'check',
  'collate',
  'collation',
  'column',
  'concurrently',
  'constraint',
  'create',
  'cross',
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
  'freeze',
  'from',
  'full',
  'grant',
  'group',
  'having',
  'ilike',
  'in',
  'initially',
  'inner',
  'intersect',
  'into',
  'is',
  'isnull',
  'join',
  'lateral',
  'leading',
  'left',
  'like',
  'limit',
  'localtime',
  'localtimestamp',
  'natural',
  'not',
  'notnull',
  'null',
  'offset',
  'on',
  'only',
  'or',
  'order',
  'outer',
  'overlaps',
  'placing',
  'primary',
  'references',
  'returning',
  'right',
  'select',
  'session_user',
  'similar',
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

const JAVA_KEYWORDS = new Set([
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
  'exports',
  'module',
  'non-sealed',
  'open',
  'opens',
  'permits',
  'provides',
  'record',
  'requires',
  'sealed',
  'to',
  'transitive',
  'uses',
  'var',
  'with',
  'yield',
]);

const RESERVED_GENERATED_TYPE_NAMES = new Set([
  ...[...SUPPORTED_JAVA_TYPES].filter((type) => type !== 'byte[]'),
  'Access',
  'AccessType',
  'Arrays',
  'Base64',
  'Column',
  'Class',
  'Component',
  'EmbeddedId',
  'Embeddable',
  'Entity',
  'FetchType',
  'ForeignKey',
  'GeneratedValue',
  'GenerationType',
  'HttpStatus',
  'Id',
  'Inheritance',
  'InheritanceType',
  'InvalidIdentifierException',
  'JdbcTypeCode',
  'JoinColumn',
  'JoinColumns',
  'JpaRepository',
  'List',
  'ManyToOne',
  'NotNull',
  'Object',
  'OneToOne',
  'Optional',
  'PrimaryKeyJoinColumn',
  'PrimaryKeyJoinColumns',
  'ProblemDetail',
  'ResourceNotFoundException',
  'RestController',
  'RuntimeException',
  'Serializable',
  'Service',
  'SpringApplication',
  'SpringBootApplication',
  'SqlTypes',
  'Table',
  'Transactional',
  'UniqueConstraint',
]);

const NUMERIC_POSTGRES_TYPES = new Set([
  'smallint',
  'integer',
  'bigint',
  'real',
  'double precision',
  'numeric(19,2)',
  'numeric(38,0)',
]);

const TEXT_POSTGRES_TYPES = new Set(['varchar(255)', 'text', 'char']);

const WINDOWS_RESERVED_PATH_COMPONENTS = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
]);

const INTEGER_DEFAULT_RANGES = new Map<string, readonly [bigint, bigint]>([
  ['smallint', [-32768n, 32767n]],
  ['integer', [-2147483648n, 2147483647n]],
  ['bigint', [-9223372036854775808n, 9223372036854775807n]],
]);

const JAVA_INTEGER_DEFAULT_RANGES = new Map<string, readonly [bigint, bigint]>([
  ['Byte', [-128n, 127n]],
  ['Short', [-32768n, 32767n]],
  ['Integer', [-2147483648n, 2147483647n]],
  ['Long', [-9223372036854775808n, 9223372036854775807n]],
]);

const POSTGRES_REAL_MAX = 3.4028234663852886e38;

export function generateSpringBootProject(
  relationalModel: RelationalModel,
  options: SpringBootGeneratorOptions = {},
): GeneratedSpringProject {
  try {
    assertRelationalModelContract(relationalModel);
  } catch (error) {
    if (error instanceof RelationalModelContractError) {
      throw new SpringBootProjectGenerationError(
        error.validationErrors.map((issue) => ({
          code: 'RELATIONAL_MODEL_INVALID',
          message: issue.message,
          path: issue.path,
        })),
      );
    }
    throw error;
  }

  const normalizedOptions = normalizeOptions(relationalModel, options);
  const tables = relationalModel.tables.toSorted(compareTables);
  const context: GenerationContext = {
    model: relationalModel,
    options: normalizedOptions,
    tables,
    tableById: new Map(tables.map((table) => [table.id, table])),
    packagePath: normalizedOptions.packageName.replaceAll('.', '/'),
  };
  validateHierarchy(context);
  validateGeneratedUuidIdentifiers(context);
  validateGeneratedJavaNames(context);

  const rawFiles: Array<{ path: string; content: string }> = [
    { path: 'pom.xml', content: renderPom(context) },
    {
      path: `src/main/java/${context.packagePath}/${context.options.applicationName}.java`,
      content: renderApplication(context),
    },
    { path: 'src/main/resources/application.yml', content: renderApplicationYaml(context) },
    {
      path: 'src/main/resources/db/migration/V1__initial_schema.sql',
      content: renderMigration(context),
    },
    { path: 'README.md', content: renderReadme(context) },
    { path: '.gitignore', content: renderGitignore() },
    {
      path: `src/main/java/${context.packagePath}/shared/exception/ResourceNotFoundException.java`,
      content: renderResourceNotFoundException(context),
    },
    {
      path: `src/main/java/${context.packagePath}/shared/exception/InvalidIdentifierException.java`,
      content: renderInvalidIdentifierException(context),
    },
    {
      path: `src/main/java/${context.packagePath}/shared/exception/ApiError.java`,
      content: renderApiError(context),
    },
    {
      path: `src/main/java/${context.packagePath}/shared/exception/ApiExceptionHandler.java`,
      content: renderApiExceptionHandler(context),
    },
  ];

  for (const table of tables) {
    const root = rootTable(context, table);
    if (root.id === table.id && root.primaryKey.columnIds.length > 1) {
      rawFiles.push({
        path: entityPath(context, `${root.javaEntityName}Id`),
        content: renderIdentifierClass(context, root),
      });
    }
    rawFiles.push({
      path: entityPath(context, table.javaEntityName),
      content: renderEntity(context, table),
    });
  }

  for (const table of tables) {
    rawFiles.push({
      path: repositoryPath(context, table),
      content: renderRepository(context, table),
    });
  }

  for (const table of tables.filter((candidate) => candidate.isAbstract !== true)) {
    rawFiles.push(
      { path: dtoPath(context, table), content: renderDto(context, table) },
      { path: mapperPath(context, table), content: renderMapper(context, table) },
      { path: servicePath(context, table), content: renderService(context, table) },
      { path: controllerPath(context, table), content: renderController(context, table) },
    );
  }

  const files = rawFiles.toSorted((left, right) => compareStrings(left.path, right.path));
  const generatedFiles = files.map((file) => createGeneratedFile(file.path, file.content));
  assertUniqueFilePaths(generatedFiles);

  const project: GeneratedSpringProject = {
    generatorVersion: SPRING_BOOT_GENERATOR_VERSION,
    sourceSchemaVersion: relationalModel.sourceSchemaVersion,
    metadata: {
      relationalSchemaVersion: relationalModel.schemaVersion,
      projectId: relationalModel.project.id,
      projectName: relationalModel.project.name,
      groupId: normalizedOptions.groupId,
      artifactId: normalizedOptions.artifactId,
      packageName: normalizedOptions.packageName,
      applicationName: normalizedOptions.applicationName,
      versions: {
        java: JAVA_VERSION,
        springBoot: SPRING_BOOT_VERSION,
        springDataJpa: 'managed-by-spring-boot',
        flyway: FLYWAY_VERSION,
        mavenCompilerPlugin: 'managed-by-spring-boot-parent',
      },
    },
    files: generatedFiles,
    diagnostics: relationalModel.diagnostics
      .map((diagnostic) => ({
        ...diagnostic,
        ...(diagnostic.sourceIds ? { sourceIds: diagnostic.sourceIds.toSorted() } : {}),
      }))
      .toSorted(compareDiagnostics),
  };
  assertGeneratedSpringProjectContract(project);
  return project;
}

function normalizeOptions(
  model: RelationalModel,
  options: SpringBootGeneratorOptions,
): NormalizedOptions {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw generationError('OPTIONS_INVALID', 'Generator options must be an object.');
  }
  const artifactId = options.artifactId ?? defaultArtifactId(model.project.name);
  const packageName = options.packageName ?? `com.generated.${packageSegment(model.project.name)}`;
  const groupId = options.groupId ?? packageName;
  const applicationName = options.applicationName ?? `${toTypeName(artifactId)}Application`;

  if (!PACKAGE_IDENTIFIER.test(packageName)) {
    throw generationError('PACKAGE_NAME_INVALID', `Invalid Java package name: ${packageName}.`);
  }
  if (!PACKAGE_IDENTIFIER.test(groupId)) {
    throw generationError('GROUP_ID_INVALID', `Invalid Maven groupId: ${groupId}.`);
  }
  if (!ARTIFACT_IDENTIFIER.test(artifactId)) {
    throw generationError('ARTIFACT_ID_INVALID', `Invalid Maven artifactId: ${artifactId}.`);
  }
  if (!JAVA_IDENTIFIER.test(applicationName) || !/^[A-Z]/.test(applicationName)) {
    throw generationError(
      'APPLICATION_NAME_INVALID',
      `Invalid Java application name: ${applicationName}.`,
    );
  }

  validateJavaIdentifier(applicationName, '/options/applicationName');
  if (RESERVED_GENERATED_TYPE_NAMES.has(applicationName)) {
    throw generationError(
      'APPLICATION_NAME_RESERVED',
      `Application name ${applicationName} collides with a generated Java type.`,
      '/options/applicationName',
    );
  }
  for (const segment of packageName.split('.')) {
    validateJavaIdentifier(segment, '/options/packageName');
  }

  return { packageName, groupId, artifactId, applicationName };
}

function validateHierarchy(context: GenerationContext): void {
  for (const table of context.tables) {
    const seen = new Set<string>();
    let current: RelationalTable | undefined = table;
    while (current?.inheritance?.role === 'subclass') {
      if (seen.has(current.id)) {
        throw generationError(
          'INHERITANCE_CYCLE',
          `Inheritance cycle detected at table ${current.id}.`,
          `/tables/${table.id}/inheritance`,
        );
      }
      seen.add(current.id);
      const parentId: string | undefined = current.inheritance.parentTableId;
      current = parentId === undefined ? undefined : context.tableById.get(parentId);
      if (!current) {
        throw generationError(
          'INHERITANCE_PARENT_MISSING',
          `Inheritance parent is missing for table ${table.id}.`,
          `/tables/${table.id}/inheritance/parentTableId`,
        );
      }
    }
  }
}

function validateGeneratedJavaNames(context: GenerationContext): void {
  const entityNames = new Set<string>();
  const identifierClassNames = new Set<string>();

  for (const table of context.tables) {
    validateJavaIdentifier(table.javaEntityName, `/tables/${table.id}/javaEntityName`);
    if (RESERVED_GENERATED_TYPE_NAMES.has(table.javaEntityName)) {
      throw generationError(
        'JAVA_TYPE_NAME_RESERVED',
        `Entity name ${table.javaEntityName} collides with a generated Java type.`,
        `/tables/${table.id}/javaEntityName`,
      );
    }
    if (entityNames.has(table.javaEntityName)) {
      throw generationError(
        'JAVA_TYPE_NAME_COLLISION',
        `Entity name ${table.javaEntityName} is duplicated.`,
        `/tables/${table.id}/javaEntityName`,
      );
    }
    entityNames.add(table.javaEntityName);
    if (table.inheritance?.role !== 'subclass' && table.primaryKey.columnIds.length > 1) {
      identifierClassNames.add(`${table.javaEntityName}Id`);
    }
    for (const column of table.columns) {
      validateJavaIdentifier(column.javaPropertyName, `/tables/${table.id}/columns/${column.id}`);
    }
  }

  for (const table of context.tables) {
    if (identifierClassNames.has(table.javaEntityName)) {
      throw generationError(
        'JAVA_TYPE_NAME_COLLISION',
        `Entity name ${table.javaEntityName} collides with a generated identifier class.`,
        `/tables/${table.id}/javaEntityName`,
      );
    }
  }
  validateGeneratedAccessorNames(context);
}

function validateGeneratedUuidIdentifiers(context: GenerationContext): void {
  for (const table of context.tables) {
    const root = rootTable(context, table);
    for (const column of table.columns.filter((candidate) => candidate.generated === 'UUID')) {
      if (
        root.id !== table.id ||
        !column.primaryKey ||
        root.primaryKey.columnIds.length !== 1 ||
        root.primaryKey.columnIds[0] !== column.id ||
        column.javaType !== 'UUID' ||
        column.postgresType !== 'uuid'
      ) {
        throw generationError(
          'UUID_GENERATION_INVALID',
          `UUID generation requires a single UUID primary key on ${table.javaEntityName}.`,
          `/tables/${table.id}/columns/${column.id}`,
        );
      }
    }
  }
}

function validateGeneratedAccessorNames(context: GenerationContext): void {
  for (const table of context.tables) {
    const accessors = new Map<string, string>();
    const register = (name: string, path: string) => {
      const accessor = toAccessorName(name);
      if (accessor === 'Class') {
        throw generationError(
          'JAVA_ACCESSOR_RESERVED',
          'Java accessor getClass is inherited as a final Object method.',
          path,
        );
      }
      const previous = accessors.get(accessor);
      if (previous) {
        throw generationError(
          'JAVA_ACCESSOR_COLLISION',
          `Java accessor ${accessor} collides between ${previous} and ${path}.`,
          path,
        );
      }
      accessors.set(accessor, path);
    };
    const root = rootTable(context, table);
    const identifierColumns = primaryKeyColumns(root);
    if (identifierColumns.length > 1) {
      register('id', `/tables/${root.id}/primaryKey`);
    } else {
      const identifier = identifierColumns[0];
      if (identifier) {
        register(identifier.javaPropertyName, `/tables/${root.id}/columns/${identifier.id}`);
      }
    }
    for (const owner of entityHierarchyTables(context, table)) {
      for (const column of entityDirectColumns(context, owner)) {
        if (owner.id === root.id && column.primaryKey) continue;
        register(column.javaPropertyName, `/tables/${owner.id}/columns/${column.id}`);
      }
      const associationNames = new Set(
        entityHierarchyColumns(context, owner).map((column) => column.javaPropertyName),
      );
      for (const association of associationDescriptors(context, owner, associationNames)) {
        register(
          association.fieldName,
          `/tables/${owner.id}/foreignKeys/${association.foreignKey.id}`,
        );
      }
    }
  }

  for (const table of context.tables.filter(
    (candidate) => candidate.inheritance?.role !== 'subclass',
  )) {
    const primaryKeyColumnsForTable = primaryKeyColumns(table);
    if (primaryKeyColumnsForTable.length < 2) continue;
    const accessors = new Set<string>();
    for (const column of primaryKeyColumnsForTable) {
      const accessor = toAccessorName(column.javaPropertyName);
      if (accessor === 'Class') {
        throw generationError(
          'JAVA_ACCESSOR_RESERVED',
          'Java accessor getClass is inherited as a final Object method.',
          `/tables/${table.id}/primaryKey`,
        );
      }
      if (accessors.has(accessor)) {
        throw generationError(
          'JAVA_ACCESSOR_COLLISION',
          `Identifier class ${table.javaEntityName}Id has duplicate accessor ${accessor}.`,
          `/tables/${table.id}/primaryKey`,
        );
      }
      accessors.add(accessor);
    }
  }
}

function validateJavaIdentifier(value: string, path: string): void {
  if (value === '_' || !JAVA_IDENTIFIER.test(value) || JAVA_KEYWORDS.has(value)) {
    throw generationError('JAVA_IDENTIFIER_INVALID', `Invalid Java identifier: ${value}.`, path);
  }
}

function renderPom(context: GenerationContext): string {
  const { artifactId, groupId, packageName } = context.options;
  return lines([
    '<project xmlns="http://maven.apache.org/POM/4.0.0"',
    '         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
    '         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">',
    '  <modelVersion>4.0.0</modelVersion>',
    '  <parent>',
    '    <groupId>org.springframework.boot</groupId>',
    '    <artifactId>spring-boot-starter-parent</artifactId>',
    `    <version>${SPRING_BOOT_VERSION}</version>`,
    '    <relativePath/>',
    '  </parent>',
    `  <groupId>${xmlEscape(groupId)}</groupId>`,
    `  <artifactId>${xmlEscape(artifactId)}</artifactId>`,
    '  <version>0.1.0-SNAPSHOT</version>',
    `  <name>${xmlEscape(artifactId)}</name>`,
    `  <description>Generated Spring Boot project for ${xmlEscape(packageName)}.</description>`,
    '  <properties>',
    `    <java.version>${JAVA_VERSION}</java.version>`,
    `    <maven.compiler.release>${JAVA_VERSION}</maven.compiler.release>`,
    '    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>',
    '  </properties>',
    '  <dependencies>',
    dependency('org.springframework.boot', 'spring-boot-starter-webmvc'),
    dependency('org.springframework.boot', 'spring-boot-starter-data-jpa'),
    dependency('org.springframework.boot', 'spring-boot-starter-validation'),
    dependency('org.springframework.boot', 'spring-boot-starter-flyway'),
    dependency('org.flywaydb', 'flyway-database-postgresql'),
    dependency('org.postgresql', 'postgresql', 'runtime'),
    '  </dependencies>',
    '  <build>',
    '    <plugins>',
    '      <plugin>',
    '        <groupId>org.springframework.boot</groupId>',
    '        <artifactId>spring-boot-maven-plugin</artifactId>',
    '      </plugin>',
    '    </plugins>',
    '  </build>',
    '</project>',
  ]);
}

function dependency(groupId: string, artifactId: string, scope?: string): string {
  return lines([
    '    <dependency>',
    `      <groupId>${groupId}</groupId>`,
    `      <artifactId>${artifactId}</artifactId>`,
    ...(scope ? [`      <scope>${scope}</scope>`] : []),
    '    </dependency>',
  ]);
}

function renderApplication(context: GenerationContext): string {
  return lines([
    `package ${context.options.packageName};`,
    '',
    'import org.springframework.boot.SpringApplication;',
    'import org.springframework.boot.autoconfigure.SpringBootApplication;',
    '',
    '@SpringBootApplication',
    `public class ${context.options.applicationName} {`,
    `  private ${context.options.applicationName}() {`,
    '  }',
    '',
    '  public static void main(String[] args) {',
    `    SpringApplication.run(${context.options.applicationName}.class, args);`,
    '  }',
    '}',
  ]);
}

function renderApplicationYaml(context: GenerationContext): string {
  return lines([
    'spring:',
    `  application:`,
    `    name: ${context.options.artifactId}`,
    '  datasource:',
    '    url: ${DB_URL:jdbc:postgresql://localhost:5432/app}',
    '    username: ${DB_USERNAME:app}',
    '    password: ${DB_PASSWORD}',
    '  jpa:',
    '    open-in-view: false',
    '    hibernate:',
    '      ddl-auto: validate',
    '    properties:',
    '      hibernate:',
    '        format_sql: false',
    '        globally_quoted_identifiers: true',
    '        globally_quoted_identifiers_skip_column_definitions: true',
    '  flyway:',
    '    enabled: true',
    '    locations: classpath:db/migration',
    'server:',
    '  port: ${SERVER_PORT:8080}',
  ]);
}

function renderGitignore(): string {
  return lines(['target/', '.idea/', '*.iml', '.vscode/', '.DS_Store']);
}

function renderReadme(context: GenerationContext): string {
  const concreteTables = context.tables.filter((table) => table.isAbstract !== true);
  const hasUuidFallback = context.tables.some((table) =>
    table.columns.some(
      (column) => column.defaultValue?.trim().toLowerCase() === 'gen_random_uuid()',
    ),
  );
  const tableLines = context.tables.map(
    (table) =>
      `- ${table.javaEntityName} -> ${table.physicalName}${table.isAbstract ? ' (abstract)' : ''}`,
  );
  const endpointLines = concreteTables.map(
    (table) => `- \`/api/${routeName(table)}\` (${table.javaEntityName})`,
  );
  return lines([
    `# ${context.options.artifactId}`,
    '',
    'Generated by UML Class Designer 6A.2.',
    '',
    `- Spring Boot: ${SPRING_BOOT_VERSION}`,
    `- Java: ${JAVA_VERSION}`,
    `- Flyway: ${FLYWAY_VERSION} (managed by Spring Boot)`,
    '- Persistence: Jakarta Persistence / Spring Data JPA',
    '- Database: PostgreSQL',
    '',
    '## Run',
    '',
    'Set `DB_PASSWORD` and optionally `DB_URL`, `DB_USERNAME` and `SERVER_PORT`, then run:',
    '',
    '```text',
    'mvn spring-boot:run',
    '```',
    '',
    'Migrations are under `src/main/resources/db/migration`. Hibernate validation is enabled and does not create or update the schema.',
    ...(hasUuidFallback
      ? [
          '',
          'UUID primary keys use `GenerationType.UUID` in JPA. `gen_random_uuid()` remains a PostgreSQL fallback only for direct SQL inserts.',
        ]
      : []),
    '',
    '## Generated Tables',
    '',
    ...tableLines,
    '',
    '## REST Resources',
    '',
    ...endpointLines,
    '',
    'Composite identifiers use comma-separated values in primary-key path segments, in the order defined by the relational model.',
  ]);
}

function renderIdentifierClass(context: GenerationContext, table: RelationalTable): string {
  const imports = new Set<string>([
    'jakarta.persistence.Column',
    'jakarta.persistence.Embeddable',
    'jakarta.validation.constraints.NotNull',
    'java.io.Serializable',
    'java.util.Arrays',
  ]);
  const columns = primaryKeyColumns(table);
  for (const column of columns) {
    addJavaTypeImport(imports, scalarJavaType(context, table, column));
  }
  const className = `${table.javaEntityName}Id`;
  const body = [
    `package ${entityPackage(context)};`,
    '',
    ...sortedImports(imports),
    '',
    '@Embeddable',
    `public class ${className} implements Serializable {`,
    '  private static final long serialVersionUID = 1L;',
    '',
    '  public ' + className + '() {',
    '  }',
    '',
  ];
  for (const column of columns) {
    const type = scalarJavaType(context, table, column);
    body.push(
      '  @NotNull',
      `  @Column(name = "${column.physicalName}", nullable = false, columnDefinition = "${safePostgresType(column.postgresType)}")`,
      `  private ${type} ${column.javaPropertyName};`,
      '',
      `  public ${type} get${toAccessorName(column.javaPropertyName)}() {`,
      `    return ${column.javaPropertyName};`,
      '  }',
      '',
      `  public void set${toAccessorName(column.javaPropertyName)}(${type} ${column.javaPropertyName}) {`,
      `    this.${column.javaPropertyName} = ${column.javaPropertyName};`,
      '  }',
      '',
    );
  }
  body.push(
    '  @Override',
    '  public boolean equals(Object other) {',
    '    if (this == other) {',
    '      return true;',
    '    }',
    `    if (!(other instanceof ${className} that)) {`,
    '      return false;',
    '    }',
    `    return Arrays.deepEquals(new Object[] {${columns.map((column) => column.javaPropertyName).join(', ')}}, new Object[] {${columns.map((column) => `that.${column.javaPropertyName}`).join(', ')}});`,
    '  }',
    '',
    '  @Override',
    '  public int hashCode() {',
    `    return Arrays.deepHashCode(new Object[] {${columns.map((column) => column.javaPropertyName).join(', ')}});`,
    '  }',
    '}',
  );
  return lines(body);
}

function renderEntity(context: GenerationContext, table: RelationalTable): string {
  const imports = new Set<string>([
    'jakarta.persistence.Access',
    'jakarta.persistence.AccessType',
    'jakarta.persistence.Column',
    'jakarta.persistence.Entity',
    'jakarta.persistence.FetchType',
    'jakarta.persistence.ForeignKey',
    'jakarta.persistence.GeneratedValue',
    'jakarta.persistence.GenerationType',
    'jakarta.persistence.Id',
    'jakarta.persistence.Inheritance',
    'jakarta.persistence.InheritanceType',
    'jakarta.persistence.JoinColumn',
    'jakarta.persistence.JoinColumns',
    'jakarta.persistence.ManyToOne',
    'jakarta.persistence.OneToOne',
    'jakarta.persistence.PrimaryKeyJoinColumn',
    'jakarta.persistence.PrimaryKeyJoinColumns',
    'jakarta.persistence.Table',
    'jakarta.persistence.UniqueConstraint',
    'jakarta.validation.constraints.NotNull',
  ]);
  const root = rootTable(context, table);
  const usesDatabaseDefaults = entityHierarchyColumns(context, table).some(
    (column) => column.defaultValue !== undefined,
  );
  if (usesDatabaseDefaults) {
    imports.add('org.hibernate.annotations.DynamicInsert');
  }
  const directColumns = entityDirectColumns(context, table);
  const bindings = directColumns.map((column) => ({
    table,
    column,
    javaType: scalarJavaType(context, table, column),
  }));
  const propertyNames = new Set<string>();
  for (const binding of bindings) {
    if (propertyNames.has(binding.column.javaPropertyName)) {
      throw generationError(
        'ENTITY_PROPERTY_COLLISION',
        `Entity ${table.javaEntityName} has duplicate property ${binding.column.javaPropertyName}.`,
        `/tables/${table.id}/columns`,
      );
    }
    propertyNames.add(binding.column.javaPropertyName);
    addJavaTypeImport(imports, binding.javaType);
    if (binding.javaType === 'JsonNode') {
      imports.add('tools.jackson.databind.JsonNode');
      imports.add('org.hibernate.annotations.JdbcTypeCode');
      imports.add('org.hibernate.type.SqlTypes');
    }
  }
  const identifier = identifierDescriptor(context, table);
  if (identifier.composite) {
    imports.add(`${entityPackage(context)}.${root.javaEntityName}Id`);
  } else {
    addJavaTypeImport(imports, identifier.type);
  }
  const associationPropertyNames = new Set(
    entityHierarchyColumns(context, table).map((column) => column.javaPropertyName),
  );
  const associations = associationDescriptors(context, table, associationPropertyNames);
  for (const association of associations) {
    if (association.target.id !== table.id) {
      imports.add(`${entityPackage(context)}.${association.target.javaEntityName}`);
    }
  }

  const annotations = [
    '@Entity',
    '@Access(AccessType.FIELD)',
    ...(usesDatabaseDefaults ? ['@DynamicInsert'] : []),
    renderTableAnnotation(table),
    ...(table.inheritance?.role === 'root'
      ? ['@Inheritance(strategy = InheritanceType.JOINED)']
      : []),
    ...renderPrimaryKeyJoinAnnotations(context, table),
  ];
  const declaration = [
    'public',
    table.isAbstract === true ? 'abstract' : '',
    'class',
    table.javaEntityName,
    table.inheritance?.role === 'subclass'
      ? `extends ${rootParent(context, table).javaEntityName}`
      : '',
  ]
    .filter(Boolean)
    .join(' ');
  const body = [
    `package ${entityPackage(context)};`,
    '',
    ...sortedImports(imports),
    '',
    ...annotations,
    `${declaration} {`,
    `  public ${table.javaEntityName}() {`,
    '  }',
    '',
  ];

  if (table.inheritance?.role !== 'subclass') {
    if (identifier.composite) {
      body.push('  @jakarta.persistence.EmbeddedId', `  private ${root.javaEntityName}Id id;`, '');
    } else {
      const idColumn = identifier.columns[0]!;
      const idBinding = bindings.find((binding) => binding.column.id === idColumn.id);
      const idType = idBinding?.javaType ?? scalarJavaType(context, table, idColumn);
      body.push(
        '  @Id',
        `  @Column(name = "${idColumn.physicalName}", nullable = false, columnDefinition = "${safePostgresType(idColumn.postgresType)}")`,
        ...(identifier.generated ? ['  @GeneratedValue(strategy = GenerationType.UUID)'] : []),
        `  private ${idType} ${idColumn.javaPropertyName};`,
        '',
      );
    }
  }

  for (const binding of bindings) {
    if (binding.column.primaryKey && table.inheritance?.role !== 'subclass') {
      if (identifier.composite || binding.column.id === identifier.columns[0]?.id) {
        continue;
      }
    }
    body.push(...renderScalarField(binding));
  }
  for (const association of associations) {
    body.push(...renderAssociationField(association));
  }

  if (table.inheritance?.role !== 'subclass') {
    if (identifier.composite) {
      body.push(
        `  public ${root.javaEntityName}Id getId() {`,
        '    return id;',
        '  }',
        '',
        `  public void setId(${root.javaEntityName}Id id) {`,
        '    this.id = id;',
        '  }',
        '',
      );
    } else {
      const idColumn = identifier.columns[0]!;
      const idType = scalarJavaType(context, table, idColumn);
      body.push(
        `  public ${idType} get${toAccessorName(idColumn.javaPropertyName)}() {`,
        `    return ${idColumn.javaPropertyName};`,
        '  }',
        '',
        `  public void set${toAccessorName(idColumn.javaPropertyName)}(${idType} ${idColumn.javaPropertyName}) {`,
        `    this.${idColumn.javaPropertyName} = ${idColumn.javaPropertyName};`,
        '  }',
        '',
      );
    }
  }
  for (const binding of bindings) {
    if (binding.column.primaryKey) {
      continue;
    }
    body.push(...renderScalarAccessors(binding));
  }
  for (const association of associations) {
    body.push(...renderAssociationAccessors(association));
  }
  body.push('}');
  return lines(body);
}

function renderScalarField(binding: ColumnBinding): string[] {
  const column = binding.column;
  const annotations: string[] = [];
  if (!column.nullable && column.defaultValue === undefined) {
    annotations.push('  @NotNull');
  }
  if (binding.javaType === 'JsonNode') {
    annotations.push('  @JdbcTypeCode(SqlTypes.JSON)');
  }
  annotations.push(
    `  @Column(name = "${column.physicalName}", nullable = ${column.nullable}, columnDefinition = "${safePostgresType(column.postgresType)}")`,
    `  private ${binding.javaType} ${column.javaPropertyName};`,
    '',
  );
  return annotations;
}

function renderScalarAccessors(binding: ColumnBinding): string[] {
  const { column, javaType } = binding;
  return [
    `  public ${javaType} get${toAccessorName(column.javaPropertyName)}() {`,
    `    return ${column.javaPropertyName};`,
    '  }',
    '',
    `  public void set${toAccessorName(column.javaPropertyName)}(${javaType} ${column.javaPropertyName}) {`,
    `    this.${column.javaPropertyName} = ${column.javaPropertyName};`,
    '  }',
    '',
  ];
}

interface AssociationDescriptor {
  foreignKey: RelationalForeignKey;
  owner: RelationalTable;
  target: RelationalTable;
  joins: Array<{ local: RelationalColumn; referenced: RelationalColumn }>;
  fieldName: string;
  oneToOne: boolean;
  optional: boolean;
}

interface RepositoryLookupKey {
  columns: RelationalColumn[];
}

function associationDescriptors(
  context: GenerationContext,
  table: RelationalTable,
  usedNames: Set<string>,
): AssociationDescriptor[] {
  const inheritanceForeignKey = joinedInheritanceForeignKey(table);
  return table.foreignKeys
    .toSorted((left, right) => compareStrings(left.id, right.id))
    .filter((foreignKey) => foreignKey.id !== inheritanceForeignKey?.id)
    .map((foreignKey) => {
      const target = context.tableById.get(foreignKey.referencedTableId);
      if (!target) {
        throw generationError(
          'FOREIGN_KEY_TARGET_MISSING',
          `Foreign key ${foreignKey.id} references a missing table.`,
          `/tables/${table.id}/foreignKeys`,
        );
      }
      const joins = foreignKey.columnIds.map((columnId, index) => {
        const local = table.columns.find((column) => column.id === columnId);
        const referenced = target.columns.find(
          (column) => column.id === foreignKey.referencedColumnIds[index],
        );
        if (!local || !referenced) {
          throw generationError(
            'FOREIGN_KEY_COLUMN_MISSING',
            `Foreign key ${foreignKey.id} has an unresolved column mapping.`,
            `/tables/${table.id}/foreignKeys`,
          );
        }
        return { local, referenced };
      });
      const baseName = associationBaseName(joins[0]!.local, target);
      const fieldName = uniqueJavaName(baseName, usedNames);
      usedNames.add(fieldName);
      return {
        foreignKey,
        owner: table,
        target,
        joins,
        fieldName,
        oneToOne: hasUniqueConstraint(table, foreignKey.columnIds),
        optional: joins.some(({ local }) => local.nullable),
      };
    });
}

function referenceDescriptors(
  context: GenerationContext,
  table: RelationalTable,
): AssociationDescriptor[] {
  const references = entityHierarchyTables(context, table).flatMap((owner) =>
    associationDescriptors(
      context,
      owner,
      new Set(entityHierarchyColumns(context, owner).map((column) => column.javaPropertyName)),
    ),
  );
  return references
    .filter(
      (reference, index) =>
        references.findIndex(
          (candidate) =>
            candidate.owner.id === reference.owner.id &&
            candidate.foreignKey.id === reference.foreignKey.id,
        ) === index,
    )
    .toSorted(
      (left, right) =>
        compareStrings(left.owner.id, right.owner.id) ||
        compareStrings(left.foreignKey.id, right.foreignKey.id),
    );
}

function repositoryLookupKeys(
  context: GenerationContext,
  target: RelationalTable,
): RepositoryLookupKey[] {
  const keys = new Map<string, RepositoryLookupKey>();
  for (const owner of context.tables) {
    for (const reference of referenceDescriptors(context, owner)) {
      if (reference.target.id !== target.id || referenceUsesPrimaryKey(context, reference)) {
        continue;
      }
      const columns = reference.joins.map(({ referenced }) => referenced);
      keys.set(columns.map((column) => column.id).join('|'), { columns });
    }
  }
  return [...keys.values()].toSorted((left, right) =>
    compareStrings(
      left.columns.map((column) => column.id).join('|'),
      right.columns.map((column) => column.id).join('|'),
    ),
  );
}

function referenceUsesPrimaryKey(
  context: GenerationContext,
  reference: AssociationDescriptor,
): boolean {
  const root = rootTable(context, reference.target);
  return (
    sameIds(reference.foreignKey.referencedColumnIds, reference.target.primaryKey.columnIds) ||
    sameIds(reference.foreignKey.referencedColumnIds, root.primaryKey.columnIds)
  );
}

function repositoryLookupMethodName(columns: RelationalColumn[]): string {
  return `findBy${columns.map((column) => toAccessorName(column.javaPropertyName)).join('And')}`;
}

function referenceRepositoryFieldName(target: RelationalTable): string {
  return `${decapitalize(target.javaEntityName)}ReferenceRepository`;
}

function renderAssociationField(association: AssociationDescriptor): string[] {
  const annotation = association.oneToOne ? '@OneToOne' : '@ManyToOne';
  const linesForField = [
    `  ${annotation}(fetch = FetchType.LAZY, optional = ${association.optional})`,
  ];
  if (association.joins.length === 1) {
    const join = association.joins[0]!;
    linesForField.push(
      `  @JoinColumn(name = "${join.local.physicalName}", referencedColumnName = "${join.referenced.physicalName}", insertable = false, updatable = false, foreignKey = @ForeignKey(name = "${association.foreignKey.physicalName}"))`,
    );
  } else {
    linesForField.push(
      '  @JoinColumns({',
      ...association.joins.map(
        ({ local, referenced }, index) =>
          `    @JoinColumn(name = "${local.physicalName}", referencedColumnName = "${referenced.physicalName}", insertable = false, updatable = false)${index === association.joins.length - 1 ? '' : ','}`,
      ),
      '  })',
    );
  }
  linesForField.push(
    `  private ${association.target.javaEntityName} ${association.fieldName};`,
    '',
  );
  return linesForField;
}

function renderAssociationAccessors(association: AssociationDescriptor): string[] {
  const type = association.target.javaEntityName;
  const name = toAccessorName(association.fieldName);
  return [
    `  public ${type} get${name}() {`,
    `    return ${association.fieldName};`,
    '  }',
    '',
    `  public void set${name}(${type} ${association.fieldName}) {`,
    `    this.${association.fieldName} = ${association.fieldName};`,
    '  }',
    '',
  ];
}

function renderRepository(context: GenerationContext, table: RelationalTable): string {
  const imports = new Set<string>([
    `${entityPackage(context)}.${table.javaEntityName}`,
    'org.springframework.data.jpa.repository.JpaRepository',
  ]);
  const identifier = identifierDescriptor(context, table);
  if (identifier.composite) {
    imports.add(`${entityPackage(context)}.${rootTable(context, table).javaEntityName}Id`);
  } else {
    addJavaTypeImport(imports, identifier.type);
  }
  const lookupKeys = repositoryLookupKeys(context, table);
  if (lookupKeys.length > 0) {
    imports.add('java.util.Optional');
    for (const key of lookupKeys) {
      for (const column of key.columns) {
        addJavaTypeImport(imports, scalarJavaType(context, table, column));
      }
    }
  }
  return lines([
    `package ${repositoryPackage(context)};`,
    '',
    ...sortedImports(imports),
    '',
    `public interface ${table.javaEntityName}Repository extends JpaRepository<${table.javaEntityName}, ${identifier.type}> {`,
    ...lookupKeys.flatMap((key) => [
      '',
      `  Optional<${table.javaEntityName}> ${repositoryLookupMethodName(key.columns)}(${key.columns.map((column) => `${scalarJavaType(context, table, column)} ${column.javaPropertyName}`).join(', ')});`,
    ]),
    '}',
  ]);
}

function renderDto(context: GenerationContext, table: RelationalTable): string {
  const imports = new Set<string>(['jakarta.validation.constraints.NotNull']);
  const identifier = identifierDescriptor(context, table);
  if (identifier.composite) {
    imports.add(`${entityPackage(context)}.${rootTable(context, table).javaEntityName}Id`);
    imports.add('jakarta.validation.Valid');
  } else {
    addJavaTypeImport(imports, identifier.type);
  }
  const bindings = entityBindings(context, table);
  for (const binding of bindings) {
    addJavaTypeImport(imports, binding.javaType);
    if (binding.javaType === 'JsonNode') {
      imports.add('tools.jackson.databind.JsonNode');
    }
  }
  const body = [
    `package ${dtoPackage(context)};`,
    '',
    ...sortedImports(imports),
    '',
    `public class ${table.javaEntityName}Dto {`,
    '',
    ...renderDtoIdentifierField(identifier),
  ];
  for (const binding of bindings) {
    const annotations =
      binding.column.nullable || binding.column.defaultValue !== undefined ? [] : ['  @NotNull'];
    body.push(
      ...annotations,
      `  private ${binding.javaType} ${binding.column.javaPropertyName};`,
      '',
      ...renderDtoAccessors(binding.javaType, binding.column.javaPropertyName),
    );
  }
  body.push('}');
  return lines(body);
}

function renderDtoIdentifierField(identifier: IdentifierDescriptor): string[] {
  return [
    ...(identifier.generated ? [] : ['  @NotNull']),
    ...(identifier.composite ? ['  @Valid'] : []),
    `  private ${identifier.type} id;`,
    '',
    ...renderDtoAccessors(identifier.type, 'id'),
  ];
}

function renderDtoAccessors(type: string, propertyName: string): string[] {
  return [
    `  public ${type} get${toAccessorName(propertyName)}() {`,
    `    return ${propertyName};`,
    '  }',
    '',
    `  public void set${toAccessorName(propertyName)}(${type} ${propertyName}) {`,
    `    this.${propertyName} = ${propertyName};`,
    '  }',
    '',
  ];
}

function renderMapper(context: GenerationContext, table: RelationalTable): string {
  const imports = new Set<string>([
    `${entityPackage(context)}.${table.javaEntityName}`,
    `${dtoPackage(context)}.${table.javaEntityName}Dto`,
    'org.springframework.stereotype.Component',
  ]);
  const identifier = identifierDescriptor(context, table);
  const root = rootTable(context, table);
  if (identifier.composite) {
    imports.add(`${entityPackage(context)}.${root.javaEntityName}Id`);
  } else {
    addJavaTypeImport(imports, identifier.type);
  }
  const bindings = entityBindings(context, table);
  for (const binding of bindings) {
    addJavaTypeImport(imports, binding.javaType);
  }
  const body = [
    `package ${mapperPackage(context)};`,
    '',
    ...sortedImports(imports),
    '',
    '@Component',
    `public class ${table.javaEntityName}Mapper {`,
    `  public ${table.javaEntityName}Dto toDto(${table.javaEntityName} entity) {`,
    `    ${table.javaEntityName}Dto dto = new ${table.javaEntityName}Dto();`,
    `    dto.setId(${entityIdentifierGetter(context, table)});`,
    ...bindings.map(
      (binding) =>
        `    dto.set${toAccessorName(binding.column.javaPropertyName)}(entity.get${toAccessorName(binding.column.javaPropertyName)}());`,
    ),
    '    return dto;',
    '  }',
    '',
    `  public ${table.javaEntityName} toEntity(${table.javaEntityName}Dto dto) {`,
    `    ${table.javaEntityName} entity = new ${table.javaEntityName}();`,
    ...(identifier.generated
      ? []
      : [`    ${entityIdentifierSetter(context, table, 'dto.getId()')}`]),
    '    updateEntity(dto, entity);',
    '    return entity;',
    '  }',
    '',
    `  public void updateEntity(${table.javaEntityName}Dto dto, ${table.javaEntityName} entity) {`,
    ...bindings.flatMap((binding) => {
      const setter = `entity.set${toAccessorName(binding.column.javaPropertyName)}(dto.get${toAccessorName(binding.column.javaPropertyName)}());`;
      return binding.column.defaultValue === undefined
        ? [`    ${setter}`]
        : [
            `    if (dto.get${toAccessorName(binding.column.javaPropertyName)}() != null) {`,
            `      ${setter}`,
            '    }',
          ];
    }),
    '  }',
    '}',
  ];
  return lines(body);
}

function renderService(context: GenerationContext, table: RelationalTable): string {
  const references = referenceDescriptors(context, table);
  const referenceTargets = references
    .map((reference) => reference.target)
    .filter((target) => target.id !== table.id)
    .filter((target, index, targets) => targets.findIndex(({ id }) => id === target.id) === index)
    .toSorted(compareTables);
  const imports = new Set<string>([
    `${dtoPackage(context)}.${table.javaEntityName}Dto`,
    `${entityPackage(context)}.${table.javaEntityName}`,
    `${mapperPackage(context)}.${table.javaEntityName}Mapper`,
    `${repositoryPackage(context)}.${table.javaEntityName}Repository`,
    `${exceptionPackage(context)}.InvalidIdentifierException`,
    `${exceptionPackage(context)}.ResourceNotFoundException`,
    'org.springframework.stereotype.Service',
    'org.springframework.transaction.annotation.Transactional',
    'java.util.List',
  ]);
  const identifier = identifierDescriptor(context, table);
  const root = rootTable(context, table);
  if (identifier.composite) {
    imports.add(`${entityPackage(context)}.${root.javaEntityName}Id`);
  } else {
    addJavaTypeImport(imports, identifier.type);
  }
  const identifierTypes = identifier.columns.map((column) => scalarJavaType(context, root, column));
  addParserImports(imports, identifierTypes);
  for (const target of referenceTargets) {
    imports.add(`${repositoryPackage(context)}.${target.javaEntityName}Repository`);
  }
  for (const reference of references) {
    const targetIdentifier = identifierDescriptor(context, reference.target);
    if (referenceUsesPrimaryKey(context, reference) && targetIdentifier.composite) {
      imports.add(
        `${entityPackage(context)}.${rootTable(context, reference.target).javaEntityName}Id`,
      );
    }
  }
  const body = [
    `package ${servicePackage(context)};`,
    '',
    ...sortedImports(imports),
    '',
    '@Service',
    '@Transactional(readOnly = true)',
    `public class ${table.javaEntityName}Service {`,
    `  private final ${table.javaEntityName}Repository repository;`,
    `  private final ${table.javaEntityName}Mapper mapper;`,
    ...referenceTargets.map(
      (target) =>
        `  private final ${target.javaEntityName}Repository ${referenceRepositoryFieldName(target)};`,
    ),
    '',
    `  public ${table.javaEntityName}Service(${[
      `${table.javaEntityName}Repository repository`,
      `${table.javaEntityName}Mapper mapper`,
      ...referenceTargets.map(
        (target) => `${target.javaEntityName}Repository ${referenceRepositoryFieldName(target)}`,
      ),
    ].join(', ')}) {`,
    '    this.repository = repository;',
    '    this.mapper = mapper;',
    ...referenceTargets.map(
      (target) =>
        `    this.${referenceRepositoryFieldName(target)} = ${referenceRepositoryFieldName(target)};`,
    ),
    '  }',
    '',
    `  public List<${table.javaEntityName}Dto> findAll() {`,
    '    return repository.findAll().stream().map(mapper::toDto).toList();',
    '  }',
    '',
    `  public ${table.javaEntityName}Dto findById(String rawId) {`,
    `    return repository.findById(parseIdentifier(rawId)).map(mapper::toDto).orElseThrow(() -> new ResourceNotFoundException("${table.javaEntityName} not found"));`,
    '  }',
    '',
    '  @Transactional',
    `  public ${table.javaEntityName}Dto create(${table.javaEntityName}Dto request) {`,
    ...(references.length > 0 ? ['    resolveReferences(request);'] : []),
    '    return mapper.toDto(repository.save(mapper.toEntity(request)));',
    '  }',
    '',
    '  @Transactional',
    `  public ${table.javaEntityName}Dto update(String rawId, ${table.javaEntityName}Dto request) {`,
    `    ${identifier.type} identifier = parseIdentifier(rawId);`,
    `    if (request.getId() != null && !${identifierEqualsRequestExpression()}) {`,
    '      throw new InvalidIdentifierException("Request identifier does not match path identifier");',
    '    }',
    `    ${table.javaEntityName} entity = repository.findById(identifier).orElseThrow(() -> new ResourceNotFoundException("${table.javaEntityName} not found"));`,
    ...(references.length > 0 ? ['    resolveReferences(request);'] : []),
    '    mapper.updateEntity(request, entity);',
    '    return mapper.toDto(repository.save(entity));',
    '  }',
    '',
    '  @Transactional',
    '  public void delete(String rawId) {',
    `    ${table.javaEntityName} entity = repository.findById(parseIdentifier(rawId)).orElseThrow(() -> new ResourceNotFoundException("${table.javaEntityName} not found"));`,
    '    repository.delete(entity);',
    '  }',
    '',
    ...renderIdentifierParser(context, table),
    ...renderReferenceResolver(context, table, references),
    '}',
  ];
  return lines(body);
}

function renderReferenceResolver(
  context: GenerationContext,
  table: RelationalTable,
  references: AssociationDescriptor[],
): string[] {
  if (references.length === 0) {
    return [];
  }

  const body = ['  private void resolveReferences(' + table.javaEntityName + 'Dto request) {'];
  const lookupVariables = new Set<string>();
  for (const reference of references) {
    const values = reference.joins.map(({ local }) => dtoColumnGetter(context, table, local));
    const optional = reference.joins.some(
      ({ local }) => local.nullable || local.defaultValue !== undefined,
    );
    const indent = optional ? '      ' : '    ';
    const targetIdentifier = identifierDescriptor(context, reference.target);
    const compositeVariableName =
      referenceUsesPrimaryKey(context, reference) && targetIdentifier.composite
        ? uniqueJavaName(compositeReferenceVariableName(reference), lookupVariables)
        : undefined;
    if (compositeVariableName) {
      lookupVariables.add(compositeVariableName);
    }
    if (optional) {
      body.push(`    if (${values.map((value) => `${value} != null`).join(' && ')}) {`);
    }
    body.push(
      ...renderReferenceLookup(context, table, reference, values, indent, compositeVariableName),
    );
    if (optional) {
      body.push('    }');
    }
  }
  body.push('  }', '');
  return body;
}

function renderReferenceLookup(
  context: GenerationContext,
  table: RelationalTable,
  reference: AssociationDescriptor,
  values: string[],
  indent: string,
  compositeVariableName: string | undefined,
): string[] {
  const repository =
    reference.target.id === table.id
      ? 'repository'
      : referenceRepositoryFieldName(reference.target);
  const missing = `new ResourceNotFoundException("${reference.target.javaEntityName} not found for ${reference.foreignKey.physicalName}")`;
  if (!referenceUsesPrimaryKey(context, reference)) {
    return [
      `${indent}${repository}.${repositoryLookupMethodName(reference.joins.map(({ referenced }) => referenced))}(${values.join(', ')}).orElseThrow(() -> ${missing});`,
    ];
  }

  const targetIdentifier = identifierDescriptor(context, reference.target);
  if (!targetIdentifier.composite) {
    return [`${indent}${repository}.findById(${values[0]!}).orElseThrow(() -> ${missing});`];
  }

  if (!compositeVariableName) {
    throw generationError(
      'FOREIGN_KEY_VARIABLE_MISSING',
      `Foreign key ${reference.foreignKey.id} is missing a composite identifier variable.`,
    );
  }
  const body = [
    `${indent}${targetIdentifier.type} ${compositeVariableName} = new ${targetIdentifier.type}();`,
  ];
  reference.joins.forEach((_, index) => {
    const targetColumn = targetIdentifier.columns[index];
    const value = values[index];
    if (!targetColumn || value === undefined) {
      throw generationError(
        'FOREIGN_KEY_COLUMN_MISSING',
        `Foreign key ${reference.foreignKey.id} cannot construct ${targetIdentifier.type}.`,
      );
    }
    body.push(
      `${indent}${compositeVariableName}.set${toAccessorName(targetColumn.javaPropertyName)}(${value});`,
    );
  });
  body.push(
    `${indent}${repository}.findById(${compositeVariableName}).orElseThrow(() -> ${missing});`,
  );
  return body;
}

function dtoColumnGetter(
  context: GenerationContext,
  table: RelationalTable,
  column: RelationalColumn,
): string {
  const identifier = identifierDescriptor(context, table);
  const identifierColumn = identifier.columns.find((candidate) => candidate.id === column.id);
  if (!identifierColumn) {
    return `request.get${toAccessorName(column.javaPropertyName)}()`;
  }
  if (!identifier.composite) {
    return 'request.getId()';
  }
  return `request.getId().get${toAccessorName(identifierColumn.javaPropertyName)}()`;
}

function renderIdentifierParser(context: GenerationContext, table: RelationalTable): string[] {
  const identifier = identifierDescriptor(context, table);
  if (!identifier.composite) {
    const type = scalarJavaType(context, rootTable(context, table), identifier.columns[0]!);
    return [
      `  private ${type} parseIdentifier(String rawId) {`,
      `    return ${scalarParserMethodName(type)}(rawId, "id");`,
      '  }',
      '',
      ...renderScalarParser(type),
    ];
  }
  const idType = identifier.type;
  const columns = identifier.columns;
  const body = [
    `  private ${idType} parseIdentifier(String rawId) {`,
    '    String[] parts = rawId.split(",", -1);',
    `    if (parts.length != ${columns.length}) {`,
    `      throw new InvalidIdentifierException("Expected ${columns.length} identifier values separated by commas");`,
    '    }',
    `    ${idType} id = new ${idType}();`,
  ];
  columns.forEach((column, index) => {
    const type = scalarJavaType(context, rootTable(context, table), column);
    body.push(
      `    id.set${toAccessorName(column.javaPropertyName)}(${scalarParserMethodName(type)}(parts[${index}], "${column.javaPropertyName}"));`,
    );
  });
  body.push(
    '    return id;',
    '  }',
    '',
    ...[
      ...new Set(
        columns.map((column) => scalarJavaType(context, rootTable(context, table), column)),
      ),
    ].flatMap((type) => renderScalarParser(type)),
    '',
  );
  return uniqueLines(body);
}

function renderScalarParser(type: string): string[] {
  const parseExpression: Record<string, string> = {
    Byte: 'Byte.valueOf(rawValue)',
    Short: 'Short.valueOf(rawValue)',
    Integer: 'Integer.valueOf(rawValue)',
    Long: 'Long.valueOf(rawValue)',
    Float: 'Float.valueOf(rawValue)',
    Double: 'Double.valueOf(rawValue)',
    BigDecimal: 'new BigDecimal(rawValue)',
    BigInteger: 'new BigInteger(rawValue)',
    LocalDate: 'LocalDate.parse(rawValue)',
    LocalDateTime: 'LocalDateTime.parse(rawValue)',
    Instant: 'Instant.parse(rawValue)',
    UUID: 'UUID.fromString(rawValue)',
  };
  if (type === 'String') {
    return [
      '  private String parseString(String rawValue, String fieldName) {',
      '    return rawValue;',
      '  }',
      '',
    ];
  }
  if (type === 'Character') {
    return [
      '  private Character parseCharacter(String rawValue, String fieldName) {',
      '    if (rawValue.length() != 1) {',
      '      throw new InvalidIdentifierException("Invalid " + fieldName);',
      '    }',
      '    return rawValue.charAt(0);',
      '  }',
      '',
    ];
  }
  if (type === 'Boolean') {
    return [
      '  private Boolean parseBoolean(String rawValue, String fieldName) {',
      '    if (!rawValue.equalsIgnoreCase("true") && !rawValue.equalsIgnoreCase("false")) {',
      '      throw new InvalidIdentifierException("Invalid " + fieldName);',
      '    }',
      '    return Boolean.valueOf(rawValue);',
      '  }',
      '',
    ];
  }
  const expression = parseExpression[type];
  if (!expression) {
    throw generationError(
      'IDENTIFIER_TYPE_UNSUPPORTED',
      `Identifier type ${type} cannot be parsed from a REST path.`,
    );
  }
  return [
    `  private ${type} ${scalarParserMethodName(type)}(String rawValue, String fieldName) {`,
    '    try {',
    `      return ${expression};`,
    '    } catch (RuntimeException error) {',
    '      throw new InvalidIdentifierException("Invalid " + fieldName, error);',
    '    }',
    '  }',
    '',
  ];
}

function renderController(context: GenerationContext, table: RelationalTable): string {
  const imports = new Set<string>([
    `${dtoPackage(context)}.${table.javaEntityName}Dto`,
    `${servicePackage(context)}.${table.javaEntityName}Service`,
    'jakarta.validation.Valid',
    'org.springframework.http.HttpStatus',
    'org.springframework.web.bind.annotation.DeleteMapping',
    'org.springframework.web.bind.annotation.GetMapping',
    'org.springframework.web.bind.annotation.PathVariable',
    'org.springframework.web.bind.annotation.PostMapping',
    'org.springframework.web.bind.annotation.PutMapping',
    'org.springframework.web.bind.annotation.RequestBody',
    'org.springframework.web.bind.annotation.RequestMapping',
    'org.springframework.web.bind.annotation.ResponseStatus',
    'org.springframework.web.bind.annotation.RestController',
    'java.util.List',
  ]);
  return lines([
    `package ${controllerPackage(context)};`,
    '',
    ...sortedImports(imports),
    '',
    '@RestController',
    `@RequestMapping("/api/${routeName(table)}")`,
    `public class ${table.javaEntityName}Controller {`,
    `  private final ${table.javaEntityName}Service service;`,
    '',
    `  public ${table.javaEntityName}Controller(${table.javaEntityName}Service service) {`,
    '    this.service = service;',
    '  }',
    '',
    '  @GetMapping',
    `  public List<${table.javaEntityName}Dto> findAll() {`,
    '    return service.findAll();',
    '  }',
    '',
    '  @GetMapping("/{id}")',
    `  public ${table.javaEntityName}Dto findById(@PathVariable String id) {`,
    '    return service.findById(id);',
    '  }',
    '',
    '  @PostMapping',
    '  @ResponseStatus(HttpStatus.CREATED)',
    `  public ${table.javaEntityName}Dto create(@Valid @RequestBody ${table.javaEntityName}Dto request) {`,
    '    return service.create(request);',
    '  }',
    '',
    '  @PutMapping("/{id}")',
    `  public ${table.javaEntityName}Dto update(@PathVariable String id, @Valid @RequestBody ${table.javaEntityName}Dto request) {`,
    '    return service.update(id, request);',
    '  }',
    '',
    '  @DeleteMapping("/{id}")',
    '  @ResponseStatus(HttpStatus.NO_CONTENT)',
    '  public void delete(@PathVariable String id) {',
    '    service.delete(id);',
    '  }',
    '}',
  ]);
}

function renderResourceNotFoundException(context: GenerationContext): string {
  return lines([
    `package ${exceptionPackage(context)};`,
    '',
    `public class ResourceNotFoundException extends RuntimeException {`,
    '  public ResourceNotFoundException(String message) {',
    '    super(message);',
    '  }',
    '}',
  ]);
}

function renderInvalidIdentifierException(context: GenerationContext): string {
  return lines([
    `package ${exceptionPackage(context)};`,
    '',
    'public class InvalidIdentifierException extends RuntimeException {',
    '  public InvalidIdentifierException(String message) {',
    '    super(message);',
    '  }',
    '',
    '  public InvalidIdentifierException(String message, Throwable cause) {',
    '    super(message, cause);',
    '  }',
    '}',
  ]);
}

function renderApiError(context: GenerationContext): string {
  return lines([
    `package ${exceptionPackage(context)};`,
    '',
    'public record ApiError(int status, String code, String message) {}',
  ]);
}

function renderApiExceptionHandler(context: GenerationContext): string {
  return lines([
    `package ${exceptionPackage(context)};`,
    '',
    'import org.springframework.dao.DataIntegrityViolationException;',
    'import org.springframework.http.HttpStatus;',
    'import org.springframework.http.ResponseEntity;',
    'import org.springframework.http.converter.HttpMessageNotReadableException;',
    'import org.springframework.web.bind.MethodArgumentNotValidException;',
    'import org.springframework.web.bind.annotation.ExceptionHandler;',
    'import org.springframework.web.bind.annotation.RestControllerAdvice;',
    '',
    '@RestControllerAdvice',
    'public class ApiExceptionHandler {',
    '',
    '  @ExceptionHandler(ResourceNotFoundException.class)',
    '  public ResponseEntity<ApiError> handleNotFound(ResourceNotFoundException exception) {',
    '    return error(HttpStatus.NOT_FOUND, "RESOURCE_NOT_FOUND", exception.getMessage());',
    '  }',
    '',
    '  @ExceptionHandler(InvalidIdentifierException.class)',
    '  public ResponseEntity<ApiError> handleInvalidIdentifier(InvalidIdentifierException exception) {',
    '    return error(HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", exception.getMessage());',
    '  }',
    '',
    '  @ExceptionHandler({ MethodArgumentNotValidException.class, HttpMessageNotReadableException.class })',
    '  public ResponseEntity<ApiError> handleRequestValidation(Exception exception) {',
    '    return error(HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "Request validation failed.");',
    '  }',
    '',
    '  @ExceptionHandler(DataIntegrityViolationException.class)',
    '  public ResponseEntity<ApiError> handleConstraintViolation(DataIntegrityViolationException exception) {',
    '    return error(HttpStatus.CONFLICT, "CONSTRAINT_VIOLATION", "Database constraint violation.");',
    '  }',
    '',
    '  private ResponseEntity<ApiError> error(HttpStatus status, String code, String message) {',
    '    return ResponseEntity.status(status).body(new ApiError(status.value(), code, message));',
    '  }',
    '}',
  ]);
}

function renderMigration(context: GenerationContext): string {
  const statements: string[] = [];
  for (const table of context.tables) {
    const columns = table.columns.toSorted(compareColumns);
    const columnLines = columns.map((column) => {
      const definition = [
        `  ${sqlIdentifier(column.physicalName)} ${safePostgresType(column.postgresType)}`,
        column.defaultValue === undefined
          ? undefined
          : `DEFAULT ${safeDefaultValue(
              column.defaultValue,
              column.postgresType,
              scalarJavaType(context, table, column),
              column.nullable,
            )}`,
        column.nullable ? undefined : 'NOT NULL',
      ].filter((part): part is string => part !== undefined);
      return definition.join(' ');
    });
    const primaryColumns = table.primaryKey.columnIds.map((columnId) => {
      const column = table.columns.find((candidate) => candidate.id === columnId);
      if (!column) {
        throw generationError(
          'PRIMARY_KEY_COLUMN_MISSING',
          `Primary key column ${columnId} is missing.`,
          `/tables/${table.id}/primaryKey`,
        );
      }
      return sqlIdentifier(column.physicalName);
    });
    columnLines.push(
      `  CONSTRAINT ${sqlIdentifier(table.primaryKey.physicalName)} PRIMARY KEY (${primaryColumns.join(', ')})`,
    );
    for (const constraint of table.uniqueConstraints.toSorted((left, right) =>
      compareStrings(left.id, right.id),
    )) {
      const columnsForConstraint = constraint.columnIds.map((columnId) => {
        const column = table.columns.find((candidate) => candidate.id === columnId);
        if (!column) {
          throw generationError(
            'UNIQUE_COLUMN_MISSING',
            `Unique constraint column ${columnId} is missing.`,
            `/tables/${table.id}/uniqueConstraints`,
          );
        }
        return sqlIdentifier(column.physicalName);
      });
      columnLines.push(
        `  CONSTRAINT ${sqlIdentifier(constraint.physicalName)} UNIQUE (${columnsForConstraint.join(', ')})`,
      );
    }
    statements.push(
      lines([
        `CREATE TABLE ${sqlIdentifier(table.physicalName)} (`,
        `${columnLines.join(',\n')}`,
        ');',
      ]),
    );
  }
  for (const table of context.tables) {
    for (const foreignKey of table.foreignKeys.toSorted((left, right) =>
      compareStrings(left.id, right.id),
    )) {
      const target = context.tableById.get(foreignKey.referencedTableId);
      if (!target) {
        throw generationError(
          'FOREIGN_KEY_TARGET_MISSING',
          `Foreign key ${foreignKey.id} references a missing table.`,
          `/tables/${table.id}/foreignKeys`,
        );
      }
      const localColumns = foreignKey.columnIds.map((columnId) => columnById(table, columnId));
      const referencedColumns = foreignKey.referencedColumnIds.map((columnId) =>
        columnById(target, columnId),
      );
      statements.push(
        lines([
          `ALTER TABLE ${sqlIdentifier(table.physicalName)}`,
          `  ADD CONSTRAINT ${sqlIdentifier(foreignKey.physicalName)}`,
          `  FOREIGN KEY (${localColumns.map((column) => sqlIdentifier(column.physicalName)).join(', ')})`,
          `  REFERENCES ${sqlIdentifier(target.physicalName)} (${referencedColumns.map((column) => sqlIdentifier(column.physicalName)).join(', ')})`,
          `  ON DELETE ${renderOnDelete(foreignKey.onDelete)};`,
        ]),
      );
    }
  }
  const requiresPgcrypto = context.tables.some((table) =>
    table.columns.some(
      (column) => column.defaultValue?.trim().toLowerCase() === 'gen_random_uuid()',
    ),
  );
  return lines([
    ...(requiresPgcrypto ? ['CREATE EXTENSION IF NOT EXISTS pgcrypto;', ''] : []),
    '-- Generated schema: tables first, foreign keys second.',
    ...(requiresPgcrypto
      ? [
          '-- JPA assigns UUID primary keys with GenerationType.UUID; this default is for direct SQL inserts.',
        ]
      : []),
    '',
    statements.join('\n\n'),
  ]);
}

function entityPackage(context: GenerationContext): string {
  return `${context.options.packageName}.domain.entity`;
}

function repositoryPackage(context: GenerationContext): string {
  return `${context.options.packageName}.domain.repository`;
}

function dtoPackage(context: GenerationContext): string {
  return `${context.options.packageName}.web.dto`;
}

function mapperPackage(context: GenerationContext): string {
  return `${context.options.packageName}.web.mapper`;
}

function servicePackage(context: GenerationContext): string {
  return `${context.options.packageName}.application.service`;
}

function controllerPackage(context: GenerationContext): string {
  return `${context.options.packageName}.web`;
}

function exceptionPackage(context: GenerationContext): string {
  return `${context.options.packageName}.shared.exception`;
}

function entityPath(context: GenerationContext, className: string): string {
  return `src/main/java/${context.packagePath}/domain/entity/${className}.java`;
}

function repositoryPath(context: GenerationContext, table: RelationalTable): string {
  return `src/main/java/${context.packagePath}/domain/repository/${table.javaEntityName}Repository.java`;
}

function dtoPath(context: GenerationContext, table: RelationalTable): string {
  return `src/main/java/${context.packagePath}/web/dto/${table.javaEntityName}Dto.java`;
}

function mapperPath(context: GenerationContext, table: RelationalTable): string {
  return `src/main/java/${context.packagePath}/web/mapper/${table.javaEntityName}Mapper.java`;
}

function servicePath(context: GenerationContext, table: RelationalTable): string {
  return `src/main/java/${context.packagePath}/application/service/${table.javaEntityName}Service.java`;
}

function controllerPath(context: GenerationContext, table: RelationalTable): string {
  return `src/main/java/${context.packagePath}/web/${table.javaEntityName}Controller.java`;
}

function rootTable(context: GenerationContext, table: RelationalTable): RelationalTable {
  let current = table;
  const seen = new Set<string>();
  while (current.inheritance?.role === 'subclass') {
    if (seen.has(current.id)) {
      throw generationError(
        'INHERITANCE_CYCLE',
        `Inheritance cycle detected at table ${table.id}.`,
      );
    }
    seen.add(current.id);
    const parentId = current.inheritance.parentTableId;
    if (!parentId) {
      throw generationError(
        'INHERITANCE_PARENT_MISSING',
        `Inheritance parent is missing for table ${table.id}.`,
      );
    }
    const parent = context.tableById.get(parentId);
    if (!parent) {
      throw generationError(
        'INHERITANCE_PARENT_MISSING',
        `Inheritance parent ${parentId} is missing for table ${table.id}.`,
      );
    }
    current = parent;
  }
  return current;
}

function rootParent(context: GenerationContext, table: RelationalTable): RelationalTable {
  const parentId = table.inheritance?.parentTableId;
  if (!parentId) {
    throw generationError('INHERITANCE_PARENT_MISSING', `Subclass ${table.id} has no parent.`);
  }
  const parent = context.tableById.get(parentId);
  if (!parent) {
    throw generationError(
      'INHERITANCE_PARENT_MISSING',
      `Subclass ${table.id} references missing parent ${parentId}.`,
    );
  }
  return parent;
}

function identifierDescriptor(
  context: GenerationContext,
  table: RelationalTable,
): IdentifierDescriptor {
  const root = rootTable(context, table);
  const columns = primaryKeyColumns(root).map((column) => ({ ...column }));
  const binaryColumn = columns.find(
    (candidate) => scalarJavaType(context, root, candidate) === 'byte[]',
  );
  if (binaryColumn) {
    throw generationError(
      'IDENTIFIER_TYPE_UNSUPPORTED',
      `Binary primary key ${binaryColumn.id} is unsupported because generated REST paths require a stable textual identifier.`,
      `/tables/${root.id}/columns/${binaryColumn.id}/javaType`,
    );
  }
  if (columns.length > 1) {
    return {
      type: `${root.javaEntityName}Id`,
      composite: true,
      generated: false,
      columns,
    };
  }
  const column = columns[0];
  if (!column) {
    throw generationError('PRIMARY_KEY_MISSING', `Table ${table.id} has no primary-key column.`);
  }
  const type = scalarJavaType(context, root, column);
  return {
    type,
    composite: false,
    generated: column.generated === 'UUID',
    columns,
  };
}

function primaryKeyColumns(table: RelationalTable): RelationalColumn[] {
  return table.primaryKey.columnIds.map((columnId) => columnById(table, columnId));
}

function columnById(table: RelationalTable, columnId: string): RelationalColumn {
  const column = table.columns.find((candidate) => candidate.id === columnId);
  if (!column) {
    throw generationError(
      'COLUMN_MISSING',
      `Table ${table.id} references missing column ${columnId}.`,
      `/tables/${table.id}`,
    );
  }
  return column;
}

function entityDirectColumns(
  context: GenerationContext,
  table: RelationalTable,
): RelationalColumn[] {
  const inheritedPrimaryKeys =
    table.inheritance?.role === 'subclass'
      ? new Set(table.primaryKey.columnIds)
      : new Set<string>();
  const columns = table.columns
    .filter((column) => !inheritedPrimaryKeys.has(column.id))
    .toSorted(compareColumns);
  const directNames = new Set<string>();
  for (const column of columns) {
    if (directNames.has(column.javaPropertyName)) {
      throw generationError(
        'ENTITY_PROPERTY_COLLISION',
        `Entity ${table.javaEntityName} has duplicate property ${column.javaPropertyName}.`,
        `/tables/${table.id}/columns`,
      );
    }
    directNames.add(column.javaPropertyName);
  }
  if (table.inheritance?.role === 'subclass') {
    const inheritedNames = new Set(
      entityHierarchyColumns(context, rootParent(context, table)).map(
        (column) => column.javaPropertyName,
      ),
    );
    for (const column of columns) {
      if (inheritedNames.has(column.javaPropertyName)) {
        throw generationError(
          'INHERITED_PROPERTY_COLLISION',
          `Entity ${table.javaEntityName} shadows inherited property ${column.javaPropertyName}.`,
          `/tables/${table.id}/columns`,
        );
      }
    }
  }
  return columns;
}

function entityHierarchyTables(
  context: GenerationContext,
  table: RelationalTable,
): RelationalTable[] {
  const result: RelationalTable[] = [];
  let current: RelationalTable | undefined = table;
  const seen = new Set<string>();
  while (current) {
    if (seen.has(current.id)) {
      throw generationError(
        'INHERITANCE_CYCLE',
        `Inheritance cycle detected at table ${table.id}.`,
      );
    }
    seen.add(current.id);
    result.unshift(current);
    current = current.inheritance?.role === 'subclass' ? rootParent(context, current) : undefined;
  }
  return result;
}

function entityHierarchyColumns(
  context: GenerationContext,
  table: RelationalTable,
): RelationalColumn[] {
  const result: RelationalColumn[] = [];
  for (const current of entityHierarchyTables(context, table)) {
    result.push(...entityDirectColumns(context, current));
  }
  return result;
}

function entityBindings(context: GenerationContext, table: RelationalTable): ColumnBinding[] {
  const bindings: ColumnBinding[] = [];
  for (const owner of entityHierarchyTables(context, table)) {
    for (const column of entityDirectColumns(context, owner)) {
      if (owner.inheritance?.role !== 'subclass' && column.primaryKey) {
        continue;
      }
      bindings.push({
        table: owner,
        column,
        javaType: scalarJavaType(context, owner, column),
      });
    }
  }
  if (bindings.some((binding) => binding.column.javaPropertyName === 'id')) {
    throw generationError(
      'DTO_PROPERTY_COLLISION',
      `Entity ${table.javaEntityName} has a non-primary-key property named id, which collides with the DTO identifier field.`,
      `/tables/${table.id}/columns`,
    );
  }
  return bindings;
}

function scalarJavaType(
  context: GenerationContext,
  table: RelationalTable,
  column: RelationalColumn,
  seen = new Set<string>(),
): string {
  const key = `${table.id}:${column.id}`;
  if (seen.has(key)) {
    const fallback = SUPPORTED_JAVA_TYPES.has(column.javaType)
      ? column.javaType
      : FALLBACK_JAVA_TYPES_BY_POSTGRES_TYPE[column.postgresType];
    if (fallback) {
      return fallback;
    }
    throw generationError('COLUMN_TYPE_CYCLE', `Foreign-key type resolution cycles at ${key}.`);
  }
  seen.add(key);
  const references = table.foreignKeys
    .filter((foreignKey) => foreignKey.columnIds.includes(column.id))
    .toSorted((left, right) => compareStrings(left.id, right.id));
  const resolvedTypes = references.map((foreignKey) => {
    const target = context.tableById.get(foreignKey.referencedTableId);
    if (!target) {
      throw generationError(
        'FOREIGN_KEY_TARGET_MISSING',
        `Foreign key ${foreignKey.id} references a missing table.`,
        `/tables/${table.id}/foreignKeys`,
      );
    }
    const index = foreignKey.columnIds.indexOf(column.id);
    const referencedId = foreignKey.referencedColumnIds[index];
    if (!referencedId) {
      throw generationError(
        'FOREIGN_KEY_COLUMN_MISSING',
        `Foreign key ${foreignKey.id} has no referenced column.`,
        `/tables/${table.id}/foreignKeys`,
      );
    }
    return scalarJavaType(context, target, columnById(target, referencedId), new Set(seen));
  });
  const distinct = [...new Set(resolvedTypes)];
  if (distinct.length > 1) {
    throw generationError(
      'FOREIGN_KEY_TYPE_CONFLICT',
      `Column ${column.id} has conflicting foreign-key types.`,
      `/tables/${table.id}/columns`,
    );
  }
  const resolved = distinct[0] ?? column.javaType;
  if (!SUPPORTED_JAVA_TYPES.has(resolved)) {
    throw generationError(
      'JAVA_TYPE_UNSUPPORTED',
      `Java type ${resolved} is not supported by the generated JPA project.`,
      `/tables/${table.id}/columns/${column.id}/javaType`,
    );
  }
  return resolved;
}

function entityIdentifierGetter(context: GenerationContext, table: RelationalTable): string {
  const descriptor = identifierDescriptor(context, table);
  if (descriptor.composite) {
    return 'entity.getId()';
  }
  return `entity.get${toAccessorName(descriptor.columns[0]!.javaPropertyName)}()`;
}

function entityIdentifierSetter(
  context: GenerationContext,
  table: RelationalTable,
  value: string,
): string {
  const descriptor = identifierDescriptor(context, table);
  if (descriptor.composite) {
    return `entity.setId(${value});`;
  }
  const column = descriptor.columns[0]!;
  return `entity.set${toAccessorName(column.javaPropertyName)}(${value});`;
}

function identifierEqualsRequestExpression(): string {
  return 'identifier.equals(request.getId())';
}

function renderTableAnnotation(table: RelationalTable): string {
  const constraints = table.uniqueConstraints
    .toSorted((left, right) => compareStrings(left.id, right.id))
    .map(
      (constraint) =>
        `@UniqueConstraint(name = "${constraint.physicalName}", columnNames = {${constraint.columnIds.map((columnId) => `"${columnById(table, columnId).physicalName}"`).join(', ')}})`,
    );
  if (constraints.length === 0) {
    return `@Table(name = "${table.physicalName}")`;
  }
  return `@Table(name = "${table.physicalName}", uniqueConstraints = {${constraints.join(', ')}})`;
}

function renderPrimaryKeyJoinAnnotations(
  context: GenerationContext,
  table: RelationalTable,
): string[] {
  if (table.inheritance?.role !== 'subclass') {
    return [];
  }
  const parent = rootParent(context, table);
  const joins = table.primaryKey.columnIds.map((columnId, index) => {
    const local = columnById(table, columnId);
    const parentId = table.inheritance?.parentColumnIds?.[index];
    if (!parentId) {
      throw generationError(
        'INHERITANCE_COLUMN_MISSING',
        `Subclass ${table.id} has no parent column mapping.`,
      );
    }
    const referenced = columnById(parent, parentId);
    return `@PrimaryKeyJoinColumn(name = "${local.physicalName}", referencedColumnName = "${referenced.physicalName}")`;
  });
  return joins.length === 1
    ? [joins[0]!]
    : [
        '@PrimaryKeyJoinColumns({',
        ...joins.map((join, index) => `  ${join}${index === joins.length - 1 ? '' : ','}`),
        '})',
      ];
}

function joinedInheritanceForeignKey(table: RelationalTable): RelationalForeignKey | undefined {
  if (table.inheritance?.role !== 'subclass') {
    return undefined;
  }
  return table.foreignKeys.find(
    (foreignKey) =>
      foreignKey.referencedTableId === table.inheritance?.parentTableId &&
      foreignKey.onDelete === 'CASCADE' &&
      sameIds(foreignKey.columnIds, table.primaryKey.columnIds) &&
      sameIds(foreignKey.referencedColumnIds, table.inheritance.parentColumnIds ?? []),
  );
}

function associationBaseName(local: RelationalColumn, target: RelationalTable): string {
  const localName = local.javaPropertyName.endsWith('Id')
    ? local.javaPropertyName.slice(0, -2)
    : local.javaPropertyName;
  return localName || decapitalize(target.javaEntityName);
}

function uniqueJavaName(baseName: string, usedNames: Set<string>): string {
  let candidate =
    JAVA_IDENTIFIER.test(baseName) && baseName !== '_' && !JAVA_KEYWORDS.has(baseName)
      ? baseName
      : 'reference';
  let suffix = 2;
  while (usedNames.has(candidate)) {
    candidate = `${baseName}Reference${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function compositeReferenceVariableName(reference: AssociationDescriptor): string {
  return `${decapitalize(reference.target.javaEntityName)}${toTypeName(reference.foreignKey.id.replaceAll('_', '-'))}Id`;
}

function hasUniqueConstraint(table: RelationalTable, columnIds: string[]): boolean {
  return (
    sameIds(table.primaryKey.columnIds, columnIds) ||
    table.uniqueConstraints.some((constraint) => sameIds(constraint.columnIds, columnIds))
  );
}

function addParserImports(imports: Set<string>, types: string[]): void {
  for (const type of types) {
    if (type === 'byte[]') {
      imports.add('java.util.Base64');
    }
    if (type === 'BigDecimal') {
      imports.add('java.math.BigDecimal');
    }
    if (type === 'BigInteger') {
      imports.add('java.math.BigInteger');
    }
    addJavaTypeImport(imports, type);
  }
}

function addJavaTypeImport(imports: Set<string>, type: string): void {
  if (type === 'JsonNode') {
    imports.add('tools.jackson.databind.JsonNode');
    return;
  }
  const importName = JAVA_SCALAR_IMPORTS[type];
  if (importName) {
    imports.add(importName);
  }
}

function sortedImports(imports: Set<string>): string[] {
  return [...imports].toSorted().map((value) => `import ${value};`);
}

function createGeneratedFile(path: string, content: string): GeneratedFile {
  const pathParts = path.split('/');
  if (
    !path ||
    path.startsWith('/') ||
    path.includes('\\') ||
    pathParts.some(
      (part) =>
        part === '.' ||
        part === '..' ||
        part === '' ||
        part.endsWith('.') ||
        part.endsWith(' ') ||
        isWindowsReservedPathComponent(part),
    )
  ) {
    throw generationError('OUTPUT_PATH_INVALID', `Generated path is unsafe: ${path}.`);
  }
  const normalizedContent = normalizeContent(content);
  return {
    path,
    content: normalizedContent,
    byteLength: Buffer.byteLength(normalizedContent, 'utf8'),
    sha256: createHash('sha256').update(normalizedContent, 'utf8').digest('hex'),
  };
}

function assertUniqueFilePaths(files: GeneratedFile[]): void {
  const paths = new Set<string>();
  for (const file of files) {
    const normalizedPath = file.path.toLowerCase();
    if (paths.has(normalizedPath)) {
      throw generationError('OUTPUT_PATH_COLLISION', `Generated path is duplicated: ${file.path}.`);
    }
    paths.add(normalizedPath);
  }
}

function safePostgresType(value: string): string {
  if (!SUPPORTED_POSTGRES_TYPES.has(value)) {
    throw generationError(
      'POSTGRES_TYPE_UNSUPPORTED',
      `PostgreSQL type ${value} is not supported.`,
    );
  }
  return value;
}

function safeDefaultValue(
  value: string,
  postgresType: string,
  javaType: string,
  nullable: boolean,
): string {
  const trimmed = value.trim();
  if (/^NULL$/i.test(trimmed) && !nullable) {
    throw generationError(
      'DEFAULT_VALUE_NULL_INVALID',
      `Non-nullable ${postgresType} columns cannot default to NULL.`,
    );
  }
  if (/^gen_random_uuid\(\)$/i.test(trimmed) && postgresType !== 'uuid') {
    throw generationError(
      'DEFAULT_VALUE_TYPE_MISMATCH',
      `Default ${trimmed} requires a uuid column, not ${postgresType}.`,
    );
  }
  const temporalDefault =
    /^(?:CURRENT_DATE|CURRENT_TIME|CURRENT_TIMESTAMP|LOCALTIME|LOCALTIMESTAMP|now\(\))(?:\((\d{1,2})\))?$/i.exec(
      trimmed,
    );
  if (temporalDefault) {
    const precision = temporalDefault[1];
    const expression = trimmed.replace(/\(\d{1,2}\)$/u, '').toUpperCase();
    if (precision && Number(precision) > 6) {
      throw generationError(
        'DEFAULT_VALUE_PRECISION_INVALID',
        `Temporal default precision must be between 0 and 6: ${trimmed}.`,
      );
    }
    const compatible =
      (postgresType === 'date' && expression === 'CURRENT_DATE' && !precision) ||
      (postgresType === 'timestamp(3)' &&
        ['CURRENT_TIMESTAMP', 'LOCALTIMESTAMP', 'NOW()'].includes(expression) &&
        (expression !== 'NOW()' || !precision)) ||
      (postgresType === 'timestamptz(3)' &&
        ['CURRENT_TIMESTAMP', 'NOW()'].includes(expression) &&
        (expression !== 'NOW()' || !precision));
    if (!compatible) {
      throw generationError(
        'DEFAULT_VALUE_TYPE_MISMATCH',
        `Default ${trimmed} is not compatible with ${postgresType}.`,
      );
    }
  }
  const quotedDefault = /^'(?:''|[^'])*'$/.test(trimmed);
  if (quotedDefault) {
    if (!TEXT_POSTGRES_TYPES.has(postgresType)) {
      throw generationError(
        'DEFAULT_VALUE_TYPE_MISMATCH',
        `Quoted default ${trimmed} is only supported for textual PostgreSQL columns.`,
      );
    }
    validateTextDefaultLength(trimmed, postgresType);
  }
  const numericDefault = /^[+-]?\d+(?:\.\d+)?$/.test(trimmed);
  if (
    (numericDefault && !NUMERIC_POSTGRES_TYPES.has(postgresType)) ||
    (/^(?:TRUE|FALSE)$/i.test(trimmed) && postgresType !== 'boolean')
  ) {
    throw generationError(
      'DEFAULT_VALUE_TYPE_MISMATCH',
      `Default ${trimmed} is not compatible with ${postgresType}.`,
    );
  }
  if (numericDefault) {
    validateNumericDefaultRange(trimmed, postgresType, javaType);
  }
  if (
    /^(?:NULL|TRUE|FALSE|CURRENT_DATE|CURRENT_TIME|CURRENT_TIMESTAMP|LOCALTIME|LOCALTIMESTAMP)$/i.test(
      trimmed,
    ) ||
    /^(?:CURRENT_TIME|CURRENT_TIMESTAMP|LOCALTIME|LOCALTIMESTAMP)\(\d{1,2}\)$/i.test(trimmed) ||
    /^now\(\)$/i.test(trimmed) ||
    /^gen_random_uuid\(\)$/i.test(trimmed) ||
    /^[+-]?\d+(?:\.\d+)?$/.test(trimmed) ||
    /^'(?:''|[^'])*'$/.test(trimmed)
  ) {
    return trimmed;
  }
  throw generationError(
    'DEFAULT_VALUE_UNSAFE',
    `Default value is not in the safe SQL allowlist: ${value}.`,
  );
}

function validateTextDefaultLength(value: string, postgresType: string): void {
  const literal = value.slice(1, -1).replaceAll("''", "'");
  const maxLength = postgresType === 'varchar(255)' ? 255 : postgresType === 'char' ? 1 : undefined;
  if (maxLength !== undefined && Array.from(literal).length > maxLength) {
    throw generationError(
      'DEFAULT_VALUE_LENGTH_INVALID',
      `Default ${value} exceeds ${postgresType} length ${maxLength}.`,
    );
  }
}

function validateNumericDefaultRange(value: string, postgresType: string, javaType: string): void {
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) return;
  const sign = match[1] ?? '';
  const integerPart = match[2];
  const fractionalPart = match[3];
  if (!integerPart) return;
  const postgresIntegerRange = INTEGER_DEFAULT_RANGES.get(postgresType);
  const javaIntegerRange = JAVA_INTEGER_DEFAULT_RANGES.get(javaType);
  if (postgresIntegerRange || javaIntegerRange) {
    if (fractionalPart !== undefined) {
      throw generationError(
        'DEFAULT_VALUE_RANGE_INVALID',
        `Default ${value} is not an integer value for ${postgresType}.`,
      );
    }
    const integerValue = BigInt(`${sign}${integerPart}`.replace(/^\+/u, ''));
    const outsidePostgresRange =
      postgresIntegerRange !== undefined &&
      (integerValue < postgresIntegerRange[0] || integerValue > postgresIntegerRange[1]);
    const outsideJavaRange =
      javaIntegerRange !== undefined &&
      (integerValue < javaIntegerRange[0] || integerValue > javaIntegerRange[1]);
    if (outsidePostgresRange || outsideJavaRange) {
      throw generationError(
        'DEFAULT_VALUE_RANGE_INVALID',
        `Default ${value} is outside the ${outsideJavaRange ? `Java ${javaType}` : postgresType} range.`,
      );
    }
    return;
  }
  if (postgresType === 'real' || postgresType === 'double precision') {
    const numericValue = Number(value);
    if (
      !Number.isFinite(numericValue) ||
      (postgresType === 'real' && Math.abs(numericValue) > POSTGRES_REAL_MAX)
    ) {
      throw generationError(
        'DEFAULT_VALUE_RANGE_INVALID',
        `Default ${value} is outside the ${postgresType} range.`,
      );
    }
    return;
  }
  const precision =
    postgresType === 'numeric(19,2)' ? 19 : postgresType === 'numeric(38,0)' ? 38 : undefined;
  const scale =
    postgresType === 'numeric(19,2)' ? 2 : postgresType === 'numeric(38,0)' ? 0 : undefined;
  if (precision === undefined || scale === undefined) return;
  const normalizedInteger = integerPart.replace(/^0+/u, '') || '0';
  const normalizedFraction = fractionalPart?.replace(/0+$/u, '') ?? '';
  if (
    normalizedInteger.length > precision - scale ||
    normalizedFraction.length > scale ||
    normalizedInteger.length + normalizedFraction.length > precision
  ) {
    throw generationError(
      'DEFAULT_VALUE_RANGE_INVALID',
      `Default ${value} exceeds ${postgresType} precision or scale.`,
    );
  }
}

function scalarParserMethodName(type: string): string {
  return type === 'byte[]' ? 'parseByteArray' : `parse${toTypeName(type)}`;
}

function isWindowsReservedPathComponent(value: string): boolean {
  const baseName = value.split('.', 1)[0]?.toLowerCase();
  return baseName !== undefined && WINDOWS_RESERVED_PATH_COMPONENTS.has(baseName);
}

function safeSqlIdentifier(value: string): string {
  if (!SQL_IDENTIFIER.test(value)) {
    throw generationError('SQL_IDENTIFIER_UNSAFE', `Unsafe SQL identifier: ${value}.`);
  }
  return value;
}

function sqlIdentifier(value: string): string {
  const identifier = safeSqlIdentifier(value);
  return POSTGRES_RESERVED_KEYWORDS.has(identifier) ? `"${identifier}"` : identifier;
}

function renderOnDelete(value: RelationalForeignKey['onDelete']): string {
  return value === 'NO_ACTION' ? 'NO ACTION' : value.replace('_', ' ');
}

function routeName(table: RelationalTable): string {
  return table.physicalName.replaceAll('_', '-');
}

function compareTables(left: RelationalTable, right: RelationalTable): number {
  return compareStrings(left.id, right.id);
}

function compareColumns(left: RelationalColumn, right: RelationalColumn): number {
  if (left.primaryKey !== right.primaryKey) {
    return left.primaryKey ? -1 : 1;
  }
  return compareStrings(left.id, right.id);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareDiagnostics(
  left: GeneratedSpringProject['diagnostics'][number],
  right: GeneratedSpringProject['diagnostics'][number],
): number {
  return (
    compareStrings(left.severity, right.severity) ||
    compareStrings(left.code, right.code) ||
    compareStrings(left.path ?? '', right.path ?? '') ||
    compareStrings(left.message, right.message) ||
    compareStrings((left.sourceIds ?? []).join('|'), (right.sourceIds ?? []).join('|'))
  );
}

function sameIds(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function toAccessorName(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function decapitalize(value: string): string {
  return value.charAt(0).toLowerCase() + value.slice(1);
}

function toTypeName(value: string): string {
  const result = value
    .split(/[^A-Za-z0-9_$]+/u)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
  return result || 'Generated';
}

function slugify(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 100);
}

function defaultArtifactId(value: string): string {
  const slug = slugify(value);
  const prefixed = /^[a-z]/.test(slug) ? slug : `app-${slug || 'generated'}`;
  return prefixed.slice(0, 100).replace(/-+$/u, '') || 'generated';
}

function packageSegment(value: string): string {
  const result = slugify(value).replaceAll('-', '');
  return /^[a-z]/.test(result) ? result : `app${result}`;
}

function xmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function lines(values: string[]): string {
  return `${values.join('\n').replace(/\n+$/u, '')}\n`;
}

function uniqueLines(values: string[]): string[] {
  return values.filter((value, index) => value !== '' || values[index - 1] !== '');
}

function normalizeContent(value: string): string {
  return `${value.replace(/\r\n?/gu, '\n').replace(/\n+$/u, '')}\n`;
}

function generationError(
  code: string,
  message: string,
  path?: string,
): SpringBootProjectGenerationError {
  return new SpringBootProjectGenerationError([{ code, message, ...(path ? { path } : {}) }]);
}
