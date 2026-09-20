import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { CanonicalUmlModel } from '../../uml-domain/collaboration.types';
import type {
  RelationalColumn,
  RelationalForeignKey,
  RelationalModel,
  RelationalTable,
  RelationalTraceability,
} from '../relational-model';
import { generateRelationalModel } from '../relational-model';
import {
  generateSpringBootProject,
  SpringBootProjectGenerationError,
} from './spring-boot.generator';

function trace(id: string): RelationalTraceability {
  return {
    sourceIds: [id],
    sourcePaths: [`/test/${id}`],
    rule: 'test.fixture',
  };
}

function column(
  id: string,
  logicalName: string,
  physicalName: string,
  javaPropertyName: string,
  javaType: string,
  postgresType: string,
  options: Partial<RelationalColumn> = {},
): RelationalColumn {
  return {
    id,
    logicalName,
    physicalName,
    javaPropertyName,
    javaType,
    postgresType,
    umlType: javaType,
    nullable: false,
    primaryKey: false,
    source: trace(id),
    ...options,
  };
}

function foreignKey(
  id: string,
  physicalName: string,
  columnIds: string[],
  referencedTableId: string,
  referencedColumnIds: string[],
  options: Partial<RelationalForeignKey> = {},
): RelationalForeignKey {
  return {
    id,
    physicalName,
    columnIds,
    referencedTableId,
    referencedColumnIds,
    onDelete: 'NO_ACTION',
    source: trace(id),
    ...options,
  };
}

function table(
  id: string,
  logicalName: string,
  physicalName: string,
  javaEntityName: string,
  columns: RelationalColumn[],
  foreignKeys: RelationalForeignKey[] = [],
  options: Partial<RelationalTable> = {},
): RelationalTable {
  const primaryColumns = columns.filter((candidate) => candidate.primaryKey);
  return {
    id,
    logicalName,
    physicalName,
    javaEntityName,
    kind: 'entity',
    columns,
    primaryKey: {
      id: `${id}_pk`,
      physicalName: `pk_${physicalName}`,
      columnIds: primaryColumns.map((candidate) => candidate.id),
      source: trace(`${id}_pk`),
    },
    foreignKeys,
    uniqueConstraints: [],
    source: trace(id),
    ...options,
  };
}

function fixture(): RelationalModel {
  const customerId = column('customer_id', 'id', 'id', 'id', 'Long', 'bigint', {
    primaryKey: true,
  });
  const customerName = column('customer_name', 'name', 'name', 'name', 'String', 'varchar(255)', {
    nullable: false,
  });
  const customer = table('t_customer', 'Customer', 'customer', 'Customer', [
    customerId,
    customerName,
  ]);

  const orderId = column('order_id', 'id', 'id', 'id', 'Long', 'bigint', {
    primaryKey: true,
  });
  const orderCustomerId = column(
    'order_customer_id',
    'customerId',
    'customer_id',
    'customerId',
    'Customer',
    'bigint',
  );
  const order = table(
    't_order',
    'Order',
    'orders',
    'Order',
    [orderId, orderCustomerId],
    [
      foreignKey(
        'fk_order_customer',
        'fk_orders_customer',
        ['order_customer_id'],
        't_customer',
        ['customer_id'],
        {
          sourceMultiplicity: '0..*',
          targetMultiplicity: '1',
        },
      ),
    ],
  );

  const membershipOrganizationId = column(
    'membership_organization_id',
    'organizationId',
    'organization_id',
    'organizationId',
    'Long',
    'bigint',
    { primaryKey: true },
  );
  const membershipUserId = column(
    'membership_user_id',
    'userId',
    'user_id',
    'userId',
    'Long',
    'bigint',
    { primaryKey: true },
  );
  const membership = table(
    't_membership',
    'Membership',
    'membership',
    'Membership',
    [membershipOrganizationId, membershipUserId],
    [
      foreignKey(
        'fk_membership_organization',
        'fk_membership_organization',
        ['membership_organization_id'],
        't_customer',
        ['customer_id'],
      ),
      foreignKey('fk_membership_user', 'fk_membership_user', ['membership_user_id'], 't_customer', [
        'customer_id',
      ]),
    ],
  );

  const auditId = column('audit_id', 'id', 'id', 'id', 'Long', 'bigint', {
    primaryKey: true,
  });
  const auditOrganizationId = column(
    'audit_organization_id',
    'organizationId',
    'organization_id',
    'organizationId',
    'Long',
    'bigint',
  );
  const auditUserId = column('audit_user_id', 'userId', 'user_id', 'userId', 'Long', 'bigint');
  const audit = table(
    't_audit',
    'MembershipAudit',
    'membership_audit',
    'MembershipAudit',
    [auditId, auditOrganizationId, auditUserId],
    [
      foreignKey(
        'fk_audit_membership',
        'fk_audit_membership',
        ['audit_organization_id', 'audit_user_id'],
        't_membership',
        ['membership_organization_id', 'membership_user_id'],
      ),
    ],
  );

  const baseId = column('base_id', 'id', 'id', 'id', 'Long', 'bigint', {
    primaryKey: true,
  });
  const base = table('t_base', 'Base', 'base', 'Base', [baseId], [], {
    isAbstract: true,
    inheritance: {
      strategy: 'JOINED',
      role: 'root',
      source: trace('inheritance_base'),
    },
  });

  const childId = column('child_id', 'id', 'id', 'id', 'Long', 'bigint', {
    primaryKey: true,
  });
  const childTitle = column('child_title', 'title', 'title', 'title', 'String', 'varchar(255)');
  const child = table(
    't_child',
    'Child',
    'child',
    'Child',
    [childId, childTitle],
    [
      foreignKey('fk_child_base', 'fk_child_base', ['child_id'], 't_base', ['base_id'], {
        onDelete: 'CASCADE',
      }),
    ],
    {
      inheritance: {
        strategy: 'JOINED',
        role: 'subclass',
        parentTableId: 't_base',
        parentColumnIds: ['base_id'],
        source: trace('inheritance_child'),
      },
    },
  );

  return {
    schemaVersion: '0.1.0',
    sourceSchemaVersion: '0.1.0',
    project: { id: 'project_test', name: 'Generated Demo' },
    conventions: {
      naming: 'snake_case',
      identifierMaxLength: 63,
      inheritanceStrategy: 'JOINED',
      identifierStrategy: 'attribute-id-or-synthetic-uuid',
    },
    tables: [customer, order, membership, audit, base, child],
    diagnostics: [],
  };
}

function file(project: ReturnType<typeof generateSpringBootProject>, path: string): string {
  const result = project.files.find((candidate) => candidate.path === path);
  if (!result) {
    throw new Error(`Expected generated file ${path}.`);
  }
  return result.content;
}

function hasFile(project: ReturnType<typeof generateSpringBootProject>, path: string): boolean {
  return project.files.some((candidate) => candidate.path === path);
}

function fixtureDirectory(): string {
  return resolve(process.cwd(), 'contracts/fixtures/spring-boot');
}

function fixtureNames(): string[] {
  return readdirSync(fixtureDirectory())
    .filter((name) => name.endsWith('.json'))
    .toSorted();
}

function relationalFixture(name: string): RelationalModel {
  return JSON.parse(readFileSync(resolve(fixtureDirectory(), name), 'utf8')) as RelationalModel;
}

function expectIssue(action: () => unknown, code: string): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(SpringBootProjectGenerationError);
    expect((error as SpringBootProjectGenerationError).issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code })]),
    );
    return;
  }
  throw new Error(`Expected generator issue ${code}.`);
}

describe('spring boot project generator', () => {
  it('emits a complete in-memory project contract with hashes', () => {
    const project = generateSpringBootProject(fixture(), {
      packageName: 'com.example.generated',
      groupId: 'com.example',
      artifactId: 'generated-demo',
    });

    expect(project.sourceSchemaVersion).toBe('0.1.0');
    expect(project.metadata).toEqual({
      relationalSchemaVersion: '0.1.0',
      projectId: 'project_test',
      projectName: 'Generated Demo',
      groupId: 'com.example',
      artifactId: 'generated-demo',
      packageName: 'com.example.generated',
      applicationName: 'GeneratedDemoApplication',
      versions: {
        java: '21',
        springBoot: '4.1.1',
        springDataJpa: 'managed-by-spring-boot',
        flyway: '12.4.0',
        mavenCompilerPlugin: 'managed-by-spring-boot-parent',
      },
    });
    expect(project.diagnostics).toEqual([]);
    const paths = project.files.map((candidate) => candidate.path);
    expect(paths).toEqual(paths.toSorted());
    for (const generatedFile of project.files) {
      expect(generatedFile.content.endsWith('\n')).toBe(true);
      expect(generatedFile.content.includes('\r')).toBe(false);
      expect(generatedFile.byteLength).toBe(Buffer.byteLength(generatedFile.content, 'utf8'));
      expect(generatedFile.sha256).toBe(
        createHash('sha256').update(generatedFile.content, 'utf8').digest('hex'),
      );
      expect(generatedFile.path.startsWith('/')).toBe(false);
      expect(generatedFile.path.includes('..')).toBe(false);
    }
    expect(file(project, 'pom.xml')).toContain(
      '<maven.compiler.release>21</maven.compiler.release>',
    );
    expect(file(project, 'pom.xml')).toContain(
      '<artifactId>spring-boot-starter-data-jpa</artifactId>',
    );
    expect(file(project, 'pom.xml')).toContain(
      '<artifactId>spring-boot-starter-flyway</artifactId>',
    );
    expect(file(project, 'src/main/resources/application.yml')).toContain('ddl-auto: validate');
    expect(file(project, 'src/main/resources/application.yml')).toContain('${DB_PASSWORD}');
  });

  it('is deterministic when relational arrays are reordered', () => {
    const first = fixture();
    const second = structuredClone(first);
    second.tables.reverse();
    second.tables.forEach((tableRecord) => {
      tableRecord.columns.reverse();
      tableRecord.foreignKeys.reverse();
      tableRecord.uniqueConstraints.reverse();
    });

    expect(generateSpringBootProject(second)).toEqual(generateSpringBootProject(first));
  });

  it('normalizes source diagnostics into deterministic output diagnostics', () => {
    const model = fixture();
    model.diagnostics = [
      {
        severity: 'WARNING',
        code: 'TEST_WARNING',
        message: 'warning',
        path: '/tables/1',
        sourceIds: ['zeta', 'alpha'],
      },
      {
        severity: 'INFO',
        code: 'TEST_INFO',
        message: 'info',
        path: '/tables/0',
        sourceIds: ['beta'],
      },
    ];

    expect(generateSpringBootProject(model).diagnostics).toEqual([
      {
        severity: 'INFO',
        code: 'TEST_INFO',
        message: 'info',
        path: '/tables/0',
        sourceIds: ['beta'],
      },
      {
        severity: 'WARNING',
        code: 'TEST_WARNING',
        message: 'warning',
        path: '/tables/1',
        sourceIds: ['alpha', 'zeta'],
      },
    ]);
  });

  it('renders entities, composite identifiers, composite joins, inheritance and abstract classes', () => {
    const project = generateSpringBootProject(fixture());
    const customer = file(
      project,
      'src/main/java/com/generated/generateddemo/domain/entity/Customer.java',
    );
    const order = file(
      project,
      'src/main/java/com/generated/generateddemo/domain/entity/Order.java',
    );
    const membershipId = file(
      project,
      'src/main/java/com/generated/generateddemo/domain/entity/MembershipId.java',
    );
    const audit = file(
      project,
      'src/main/java/com/generated/generateddemo/domain/entity/MembershipAudit.java',
    );
    const base = file(project, 'src/main/java/com/generated/generateddemo/domain/entity/Base.java');
    const child = file(
      project,
      'src/main/java/com/generated/generateddemo/domain/entity/Child.java',
    );

    expect(customer).toContain('@Entity');
    expect(order).toContain('@JoinColumn(name = "customer_id"');
    expect(membershipId).toContain('@Embeddable');
    expect(audit).toContain('@JoinColumns({');
    expect(audit).toContain('referencedColumnName = "organization_id"');
    expect(base).toContain('public abstract class Base');
    expect(child).toContain('public class Child extends Base');
    expect(child).toContain('@PrimaryKeyJoinColumn(name = "id", referencedColumnName = "id")');
    expect(
      file(project, 'src/main/java/com/generated/generateddemo/web/ChildController.java'),
    ).toContain('@RequestMapping("/api/child")');
    expect(
      hasFile(
        project,
        'src/main/java/com/generated/generateddemo/domain/repository/BaseRepository.java',
      ),
    ).toBe(true);
  });

  it('creates tables before foreign keys and does not interpolate unsafe defaults', () => {
    const project = generateSpringBootProject(fixture());
    const migration = file(project, 'src/main/resources/db/migration/V1__initial_schema.sql');
    expect(migration.indexOf('CREATE TABLE')).toBeLessThan(migration.indexOf('ALTER TABLE'));

    const unsafe = structuredClone(fixture());
    unsafe.tables[0]!.columns[1]!.defaultValue = '0); DROP TABLE customer; --';
    expectIssue(() => generateSpringBootProject(unsafe), 'DEFAULT_VALUE_UNSAFE');
  });

  it('enables pgcrypto for UUID defaults from the canonical fixture', () => {
    const canonicalModel = JSON.parse(
      readFileSync(resolve(process.cwd(), 'contracts/fixtures/valid-uml-model.json'), 'utf8'),
    ) as CanonicalUmlModel;
    const project = generateSpringBootProject(generateRelationalModel(canonicalModel));
    const migration = file(project, 'src/main/resources/db/migration/V1__initial_schema.sql');

    expect(migration).toContain('CREATE EXTENSION IF NOT EXISTS pgcrypto;');
    expect(migration).toContain('DEFAULT gen_random_uuid()');
  });

  it('covers twelve separated relational fixtures and rejects the invalid generation case', () => {
    const names = fixtureNames();
    expect(names).toHaveLength(12);

    for (const name of names.filter((candidate) => candidate !== '12-invalid-default-type.json')) {
      const project = generateSpringBootProject(relationalFixture(name));
      expect(project.files.length).toBeGreaterThan(8);
      expect(project.files.map((candidate) => candidate.path)).toEqual(
        project.files.map((candidate) => candidate.path).toSorted(),
      );
    }

    expectIssue(
      () => generateSpringBootProject(relationalFixture('12-invalid-default-type.json')),
      'DEFAULT_VALUE_TYPE_MISMATCH',
    );
  });

  it.each([
    [
      '01-simple-crud.json',
      'src/main/java/com/generated/simplecrud/application/service/OrderService.java',
      'customerReferenceRepository.findById(request.getCustomerId())',
    ],
    [
      '02-composite-primary-key.json',
      'src/main/java/com/generated/compositeprimarykey/domain/entity/SubscriptionId.java',
      '@Embeddable',
    ],
    [
      '03-composite-foreign-key.json',
      'src/main/java/com/generated/compositeforeignkey/domain/entity/Stock.java',
      '@JoinColumns({',
    ],
    [
      '04-joined-inheritance-abstract.json',
      'src/main/java/com/generated/joinedinheritance/domain/entity/Employee.java',
      'public class Employee extends Person',
    ],
    [
      '05-unique-cascade.json',
      'src/main/resources/db/migration/V1__initial_schema.sql',
      'ON DELETE CASCADE',
    ],
    [
      '06-uuid-pgcrypto.json',
      'src/main/resources/db/migration/V1__initial_schema.sql',
      'CREATE EXTENSION IF NOT EXISTS pgcrypto;',
    ],
    [
      '07-json-and-advanced-types.json',
      'src/main/java/com/generated/advancedtypes/domain/entity/Event.java',
      '@JdbcTypeCode(SqlTypes.JSON)',
    ],
    [
      '08-self-reference.json',
      'src/main/java/com/generated/selfreference/application/service/CategoryService.java',
      'repository.findById(request.getParentId())',
    ],
    [
      '09-association-class.json',
      'src/main/java/com/generated/associationclass/application/service/EnrollmentService.java',
      'studentReferenceRepository.findById(request.getId().getStudentId())',
    ],
    [
      '10-deterministic-order-a.json',
      'src/main/java/com/generated/deterministicorder/domain/entity/Post.java',
      '@ManyToOne(fetch = FetchType.LAZY, optional = false)',
    ],
    [
      '11-deterministic-order-b.json',
      'src/main/java/com/generated/deterministicorder/domain/entity/Post.java',
      '@ManyToOne(fetch = FetchType.LAZY, optional = false)',
    ],
  ])('renders semantic requirement for fixture %s', (fixtureName, path, expected) => {
    expect(file(generateSpringBootProject(relationalFixture(fixtureName)), path)).toContain(
      expected,
    );
  });

  it('renders FK reference resolution before persisting and maps absent targets to 404', () => {
    const simple = generateSpringBootProject(relationalFixture('01-simple-crud.json'));
    const orderService = file(
      simple,
      'src/main/java/com/generated/simplecrud/application/service/OrderService.java',
    );
    expect(orderService).toContain('private final CustomerRepository customerReferenceRepository;');
    expect(orderService).toContain('resolveReferences(request);');
    expect(orderService).toContain(
      'customerReferenceRepository.findById(request.getCustomerId()).orElseThrow(() -> new ResourceNotFoundException("Customer not found for fk_orders_customer"));',
    );

    const composite = generateSpringBootProject(relationalFixture('03-composite-foreign-key.json'));
    const stockService = file(
      composite,
      'src/main/java/com/generated/compositeforeignkey/application/service/StockService.java',
    );
    expect(stockService).toContain('WarehouseId warehouseFkStockWarehouseId = new WarehouseId();');
    expect(stockService).toContain(
      'warehouseFkStockWarehouseId.setCountryCode(request.getWarehouseCountryCode());',
    );
    expect(stockService).toContain(
      'warehouseReferenceRepository.findById(warehouseFkStockWarehouseId)',
    );

    const unique = generateSpringBootProject(relationalFixture('05-unique-cascade.json'));
    expect(
      file(
        unique,
        'src/main/java/com/generated/uniquecascade/domain/repository/EmailCustomerRepository.java',
      ),
    ).toContain('Optional<EmailCustomer> findByEmail(String email);');
    expect(
      file(
        unique,
        'src/main/java/com/generated/uniquecascade/application/service/InvoiceService.java',
      ),
    ).toContain('emailCustomerReferenceRepository.findByEmail(request.getCustomerEmail())');

    const joined = generateSpringBootProject(
      relationalFixture('04-joined-inheritance-abstract.json'),
    );
    expect(
      file(
        joined,
        'src/main/java/com/generated/joinedinheritance/application/service/EmployeeService.java',
      ),
    ).toContain('private final CompanyRepository companyReferenceRepository;');
    expect(
      file(
        joined,
        'src/main/java/com/generated/joinedinheritance/application/service/EmployeeService.java',
      ),
    ).toContain('companyReferenceRepository.findById(request.getCompanyId())');

    const selfReference = generateSpringBootProject(relationalFixture('08-self-reference.json'));
    expect(
      file(selfReference, 'src/main/java/com/generated/selfreference/domain/entity/Category.java'),
    ).not.toContain('import com.generated.selfreference.domain.entity.Category;');
  });

  it('renders JPA identifiers, inheritance, JSON and UUID semantics coherently', () => {
    const composite = generateSpringBootProject(relationalFixture('02-composite-primary-key.json'));
    const identifier = file(
      composite,
      'src/main/java/com/generated/compositeprimarykey/domain/entity/SubscriptionId.java',
    );
    expect(identifier).toContain('implements Serializable');
    expect(identifier).toContain('@NotNull\n  @Column(name = "account_id"');
    expect(identifier).toContain('Arrays.deepEquals');
    expect(identifier).toContain('Arrays.deepHashCode');
    const compositeDto = file(
      composite,
      'src/main/java/com/generated/compositeprimarykey/web/dto/SubscriptionDto.java',
    );
    expect(compositeDto).toContain('import jakarta.validation.Valid;');
    expect(compositeDto).toContain('@NotNull\n  @Valid\n  private SubscriptionId id;');

    const inheritance = generateSpringBootProject(
      relationalFixture('04-joined-inheritance-abstract.json'),
    );
    expect(
      file(inheritance, 'src/main/java/com/generated/joinedinheritance/domain/entity/Person.java'),
    ).toContain('@Inheritance(strategy = InheritanceType.JOINED)');
    expect(
      file(
        inheritance,
        'src/main/java/com/generated/joinedinheritance/domain/entity/Employee.java',
      ),
    ).toContain('@PrimaryKeyJoinColumn(name = "id", referencedColumnName = "id")');
    expect(
      hasFile(
        inheritance,
        'src/main/java/com/generated/joinedinheritance/web/PersonController.java',
      ),
    ).toBe(false);
    expect(
      hasFile(
        inheritance,
        'src/main/java/com/generated/joinedinheritance/domain/repository/PersonRepository.java',
      ),
    ).toBe(true);

    const advanced = generateSpringBootProject(
      relationalFixture('07-json-and-advanced-types.json'),
    );
    expect(
      file(advanced, 'src/main/java/com/generated/advancedtypes/domain/entity/Event.java'),
    ).toContain('import tools.jackson.databind.JsonNode;');

    const uuid = generateSpringBootProject(relationalFixture('06-uuid-pgcrypto.json'));
    expect(
      file(uuid, 'src/main/java/com/generated/uuidpgcrypto/domain/entity/Document.java'),
    ).toContain('@GeneratedValue(strategy = GenerationType.UUID)');
    const migration = file(uuid, 'src/main/resources/db/migration/V1__initial_schema.sql');
    expect(migration).toContain('CREATE EXTENSION IF NOT EXISTS pgcrypto;');
    expect(migration).toContain('this default is for direct SQL inserts');
    expect(file(uuid, 'pom.xml')).not.toContain('flyway-maven-plugin');
  });

  it('keeps fixture output deterministic and validates Java names and typed defaults', () => {
    expect(generateSpringBootProject(relationalFixture('10-deterministic-order-a.json'))).toEqual(
      generateSpringBootProject(relationalFixture('11-deterministic-order-b.json')),
    );

    const keyword = structuredClone(fixture());
    keyword.tables[0]!.columns[1]!.javaPropertyName = 'class';
    expectIssue(() => generateSpringBootProject(keyword), 'JAVA_IDENTIFIER_INVALID');

    const numericProjectName = structuredClone(fixture());
    numericProjectName.project.name = '123';
    expect(generateSpringBootProject(numericProjectName).metadata).toMatchObject({
      artifactId: 'app-123',
      packageName: 'com.generated.app123',
      applicationName: 'App123Application',
    });
    expectIssue(
      () => generateSpringBootProject(fixture(), { applicationName: 'SpringApplication' }),
      'APPLICATION_NAME_RESERVED',
    );

    const invalidPrecision = structuredClone(fixture());
    invalidPrecision.tables[0]!.columns[1]!.javaType = 'Instant';
    invalidPrecision.tables[0]!.columns[1]!.postgresType = 'timestamptz(3)';
    invalidPrecision.tables[0]!.columns[1]!.defaultValue = 'CURRENT_TIMESTAMP(99)';
    expectIssue(
      () => generateSpringBootProject(invalidPrecision),
      'DEFAULT_VALUE_PRECISION_INVALID',
    );

    const incompatibleTemporal = structuredClone(fixture());
    incompatibleTemporal.tables[0]!.columns[1]!.javaType = 'LocalDate';
    incompatibleTemporal.tables[0]!.columns[1]!.postgresType = 'date';
    incompatibleTemporal.tables[0]!.columns[1]!.defaultValue = 'CURRENT_TIME';
    expectIssue(
      () => generateSpringBootProject(incompatibleTemporal),
      'DEFAULT_VALUE_TYPE_MISMATCH',
    );

    const quotedNumeric = structuredClone(fixture());
    quotedNumeric.tables[0]!.columns[0]!.defaultValue = "'not-a-number'";
    expectIssue(() => generateSpringBootProject(quotedNumeric), 'DEFAULT_VALUE_TYPE_MISMATCH');

    const textualDefault = structuredClone(fixture());
    textualDefault.tables[0]!.columns[1]!.defaultValue = "'unknown'";
    const defaultedProject = generateSpringBootProject(textualDefault);
    expect(
      file(defaultedProject, 'src/main/resources/db/migration/V1__initial_schema.sql'),
    ).toContain("DEFAULT 'unknown'");
    expect(
      file(
        defaultedProject,
        'src/main/java/com/generated/generateddemo/domain/entity/Customer.java',
      ),
    ).toContain('@DynamicInsert');
    expect(
      file(defaultedProject, 'src/main/java/com/generated/generateddemo/web/dto/CustomerDto.java'),
    ).not.toContain('@NotNull\n  private String name;');
    expect(
      file(
        defaultedProject,
        'src/main/java/com/generated/generateddemo/web/mapper/CustomerMapper.java',
      ),
    ).toContain('if (dto.getName() != null) {');

    const invalidUuid = structuredClone(fixture());
    invalidUuid.tables[0]!.columns[0]!.generated = 'UUID';
    expectIssue(() => generateSpringBootProject(invalidUuid), 'UUID_GENERATION_INVALID');

    const inheritedUuid = structuredClone(fixture());
    inheritedUuid.tables[4]!.columns[0]!.javaType = 'UUID';
    inheritedUuid.tables[4]!.columns[0]!.postgresType = 'uuid';
    inheritedUuid.tables[5]!.columns[0]!.javaType = 'UUID';
    inheritedUuid.tables[5]!.columns[0]!.postgresType = 'uuid';
    inheritedUuid.tables[5]!.columns[0]!.generated = 'UUID';
    expectIssue(() => generateSpringBootProject(inheritedUuid), 'UUID_GENERATION_INVALID');
  });

  it('honors inherited and foreign-key database defaults without bypassing validation', () => {
    const inheritedDefault = relationalFixture('04-joined-inheritance-abstract.json');
    const person = inheritedDefault.tables.find((candidate) => candidate.id === 'table_person');
    const personName = person?.columns.find((candidate) => candidate.id === 'column_person_name');
    if (!personName) throw new Error('Expected inherited Person name column.');
    personName.defaultValue = "'unknown'";
    expect(
      file(
        generateSpringBootProject(inheritedDefault),
        'src/main/java/com/generated/joinedinheritance/domain/entity/Employee.java',
      ),
    ).toContain('@DynamicInsert');

    const foreignKeyDefault = structuredClone(fixture());
    const order = foreignKeyDefault.tables.find((candidate) => candidate.id === 't_order');
    const customerId = order?.columns.find((candidate) => candidate.id === 'order_customer_id');
    if (!customerId) throw new Error('Expected Order customer foreign key column.');
    customerId.defaultValue = '1';
    expect(
      file(
        generateSpringBootProject(foreignKeyDefault),
        'src/main/java/com/generated/generateddemo/application/service/OrderService.java',
      ),
    ).toContain('if (request.getCustomerId() != null) {');

    const smallintOutOfRange = structuredClone(fixture());
    const numericColumn = smallintOutOfRange.tables[0]!.columns[1]!;
    numericColumn.javaType = 'Short';
    numericColumn.postgresType = 'smallint';
    numericColumn.defaultValue = '32768';
    expectIssue(() => generateSpringBootProject(smallintOutOfRange), 'DEFAULT_VALUE_RANGE_INVALID');

    const byteOutOfRange = structuredClone(fixture());
    const byteColumn = byteOutOfRange.tables[0]!.columns[1]!;
    byteColumn.javaType = 'Byte';
    byteColumn.postgresType = 'smallint';
    byteColumn.defaultValue = '128';
    expectIssue(() => generateSpringBootProject(byteOutOfRange), 'DEFAULT_VALUE_RANGE_INVALID');

    const realOutOfRange = structuredClone(fixture());
    const realColumn = realOutOfRange.tables[0]!.columns[1]!;
    realColumn.javaType = 'Float';
    realColumn.postgresType = 'real';
    realColumn.defaultValue = '400000000000000000000000000000000000000';
    expectIssue(() => generateSpringBootProject(realOutOfRange), 'DEFAULT_VALUE_RANGE_INVALID');

    const numericOutOfRange = structuredClone(fixture());
    const decimalColumn = numericOutOfRange.tables[0]!.columns[1]!;
    decimalColumn.javaType = 'BigDecimal';
    decimalColumn.postgresType = 'numeric(19,2)';
    decimalColumn.defaultValue = '100000000000000000.00';
    expectIssue(() => generateSpringBootProject(numericOutOfRange), 'DEFAULT_VALUE_RANGE_INVALID');

    const textTooLong = structuredClone(fixture());
    textTooLong.tables[0]!.columns[1]!.defaultValue = `'${'x'.repeat(256)}'`;
    expectIssue(() => generateSpringBootProject(textTooLong), 'DEFAULT_VALUE_LENGTH_INVALID');

    const nullDefault = structuredClone(fixture());
    nullDefault.tables[0]!.columns[1]!.defaultValue = 'NULL';
    expectIssue(() => generateSpringBootProject(nullDefault), 'DEFAULT_VALUE_NULL_INVALID');
  });

  it('keeps generated parser and composite reference local names unique', () => {
    const duplicateReferenceName = structuredClone(fixture());
    const audit = duplicateReferenceName.tables.find((candidate) => candidate.id === 't_audit');
    const membershipReference = audit?.foreignKeys.find(
      (candidate) => candidate.id === 'fk_audit_membership',
    );
    if (!audit || !membershipReference) {
      throw new Error('Expected composite Membership reference.');
    }
    audit.foreignKeys.push({
      ...membershipReference,
      id: 'fk-audit-membership',
      physicalName: 'fk_audit_membership_alternate',
      source: trace('fk-audit-membership'),
    });
    const service = file(
      generateSpringBootProject(duplicateReferenceName),
      'src/main/java/com/generated/generateddemo/application/service/MembershipAuditService.java',
    );
    expect(service).toContain('MembershipId membershipFkAuditMembershipId = new MembershipId();');
    expect(service).toContain(
      'MembershipId membershipFkAuditMembershipIdReference2 = new MembershipId();',
    );

    const byteIdentifier = structuredClone(fixture());
    byteIdentifier.tables.push(
      table('t_binary_key', 'Binary Key', 'binary_key', 'BinaryKey', [
        column('binary_key_code', 'code', 'code', 'code', 'Byte', 'smallint', {
          primaryKey: true,
        }),
        column('binary_key_payload', 'payload', 'payload', 'payload', 'byte[]', 'bytea', {
          primaryKey: true,
        }),
      ]),
    );
    const binaryKeyService = file(
      generateSpringBootProject(byteIdentifier),
      'src/main/java/com/generated/generateddemo/application/service/BinaryKeyService.java',
    );
    expect(binaryKeyService).toContain('parseByte(parts[0], "code")');
    expect(binaryKeyService).toContain('parseByteArray(parts[1], "payload")');
    expect(binaryKeyService).toContain(
      'private byte[] parseByteArray(String rawValue, String fieldName)',
    );
  });

  it('supports cyclic primary-key foreign keys and preserves shared-primary-key one-to-one mappings', () => {
    const selfPrimaryKey = relationalFixture('08-self-reference.json');
    const category = selfPrimaryKey.tables[0];
    if (!category) throw new Error('Expected self-reference fixture table.');
    category.foreignKeys[0]!.columnIds = ['column_category_id'];
    category.foreignKeys[0]!.referencedColumnIds = ['column_category_id'];
    category.foreignKeys[0]!.onDelete = 'NO_ACTION';
    expect(() => generateSpringBootProject(selfPrimaryKey)).not.toThrow();

    const sharedPrimaryKey = structuredClone(fixture());
    const profileId = column('profile_id', 'id', 'id', 'id', 'Long', 'bigint', {
      primaryKey: true,
    });
    sharedPrimaryKey.tables.push(
      table(
        't_profile',
        'Profile',
        'profile',
        'Profile',
        [profileId],
        [
          foreignKey('fk_profile_customer', 'fk_profile_customer', ['profile_id'], 't_customer', [
            'customer_id',
          ]),
        ],
      ),
    );
    expect(
      file(
        generateSpringBootProject(sharedPrimaryKey),
        'src/main/java/com/generated/generateddemo/domain/entity/Profile.java',
      ),
    ).toContain('@OneToOne(fetch = FetchType.LAZY, optional = false)');
  });

  it('rejects update bodies with an identifier that differs from the path', () => {
    const project = generateSpringBootProject(relationalFixture('01-simple-crud.json'));
    const service = file(
      project,
      'src/main/java/com/generated/simplecrud/application/service/OrderService.java',
    );
    expect(service).toContain('Long identifier = parseIdentifier(rawId);');
    expect(service).toContain(
      'if (request.getId() != null && !identifier.equals(request.getId())) {',
    );
    expect(service).toContain(
      'throw new InvalidIdentifierException("Request identifier does not match path identifier");',
    );
  });

  it('rejects unsafe output options and invalid relational identifiers', () => {
    expectIssue(
      () => generateSpringBootProject(fixture(), { packageName: 'com.example..unsafe' }),
      'PACKAGE_NAME_INVALID',
    );
    expectIssue(
      () => generateSpringBootProject(fixture(), { artifactId: '../escape' }),
      'ARTIFACT_ID_INVALID',
    );

    const invalid = structuredClone(fixture());
    invalid.tables[0]!.physicalName = '../customer';
    expectIssue(() => generateSpringBootProject(invalid), 'RELATIONAL_MODEL_INVALID');

    const reservedSql = structuredClone(fixture());
    reservedSql.tables[0]!.physicalName = 'order';
    const reservedProject = generateSpringBootProject(reservedSql);
    expect(
      file(reservedProject, 'src/main/resources/db/migration/V1__initial_schema.sql'),
    ).toContain('CREATE TABLE "order"');
    expect(file(reservedProject, 'src/main/resources/application.yml')).toContain(
      'globally_quoted_identifiers: true',
    );

    const underscore = structuredClone(fixture());
    underscore.tables[0]!.columns[1]!.javaPropertyName = '_';
    expectIssue(() => generateSpringBootProject(underscore), 'JAVA_IDENTIFIER_INVALID');

    const classAccessor = structuredClone(fixture());
    classAccessor.tables[0]!.columns[1]!.javaPropertyName = 'Class';
    expectIssue(() => generateSpringBootProject(classAccessor), 'JAVA_ACCESSOR_RESERVED');

    const accessorCollision = structuredClone(fixture());
    accessorCollision.tables[0]!.columns[1]!.javaPropertyName = 'foo';
    accessorCollision.tables[0]!.columns.push({
      ...accessorCollision.tables[0]!.columns[1]!,
      id: 'customer_foo_duplicate',
      logicalName: 'Foo',
      physicalName: 'foo_duplicate',
      javaPropertyName: 'Foo',
      source: trace('customer_foo_duplicate'),
    });
    expectIssue(() => generateSpringBootProject(accessorCollision), 'JAVA_ACCESSOR_COLLISION');

    const keywordAssociation = structuredClone(fixture());
    keywordAssociation.tables[1]!.columns[1]!.javaPropertyName = 'newId';
    const keywordAssociationEntity = file(
      generateSpringBootProject(keywordAssociation),
      'src/main/java/com/generated/generateddemo/domain/entity/Order.java',
    );
    expect(keywordAssociationEntity).toContain('private Customer reference;');
    expect(keywordAssociationEntity).not.toContain('private Customer new;');

    const windowsDeviceName = structuredClone(fixture());
    windowsDeviceName.tables[0]!.javaEntityName = 'Con';
    expectIssue(() => generateSpringBootProject(windowsDeviceName), 'OUTPUT_PATH_INVALID');

    const caseInsensitivePathCollision = structuredClone(fixture());
    caseInsensitivePathCollision.tables[0]!.javaEntityName = 'Foo';
    caseInsensitivePathCollision.tables[1]!.javaEntityName = 'FOO';
    expectIssue(
      () => generateSpringBootProject(caseInsensitivePathCollision),
      'OUTPUT_PATH_COLLISION',
    );
  });
});
