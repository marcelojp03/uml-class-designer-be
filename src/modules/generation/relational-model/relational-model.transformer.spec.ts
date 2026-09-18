import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
  CanonicalUmlModel,
  UmlAttribute,
  UmlClass,
  UmlClassifier,
  UmlRelationship,
  UmlTypeReference,
} from '../../uml-domain/collaboration.types';
import {
  generateRelationalModel,
  RelationalModelGenerationError,
  serializeRelationalModel,
} from './relational-model.transformer';
import type { RelationalModel } from './relational-model.types';

function loadFixture(): CanonicalUmlModel {
  return JSON.parse(
    readFileSync(resolve(process.cwd(), 'contracts/fixtures/valid-uml-model.json'), 'utf8'),
  ) as CanonicalUmlModel;
}

function type(name: string, options: Partial<UmlTypeReference> = {}): UmlTypeReference {
  return { name, collection: false, nullable: false, ...options };
}

function attribute(
  id: string,
  name: string,
  typeReference: UmlTypeReference = type('String'),
  options: Partial<UmlAttribute> = {},
): UmlAttribute {
  return {
    id,
    name,
    visibility: 'private',
    type: typeReference,
    isStatic: false,
    isReadOnly: false,
    ...options,
  };
}

function classifier(
  id: string,
  name: string,
  attributes: UmlAttribute[] = [],
  options: Partial<UmlClass> = {},
): UmlClass {
  return {
    id,
    kind: 'class',
    name,
    isAbstract: false,
    attributes,
    operations: [],
    ...options,
  };
}

function relationship(
  id: string,
  source: string,
  target: string,
  sourceMultiplicity: string,
  targetMultiplicity: string,
  options: Partial<UmlRelationship> = {},
): UmlRelationship {
  return {
    id,
    kind: 'association',
    source: {
      elementId: source,
      role: '',
      multiplicity: sourceMultiplicity,
      navigable: true,
    },
    target: {
      elementId: target,
      role: '',
      multiplicity: targetMultiplicity,
      navigable: true,
    },
    ...options,
  };
}

function model(
  elements: UmlClassifier[],
  relationships: UmlRelationship[] = [],
): CanonicalUmlModel {
  return {
    schemaVersion: '0.1.0',
    project: { id: 'project_test', name: 'Test project' },
    diagram: {
      id: 'diagram_test',
      name: 'Test diagram',
      elements,
      relationships,
      visual: {
        positions: elements.map((element, index) => ({
          elementId: element.id,
          x: index,
          y: index,
        })),
      },
    },
    metadata: {
      createdAt: '2026-09-04T12:00:00.000Z',
      updatedAt: '2026-09-04T12:00:00.000Z',
      revision: 0,
    },
  };
}

function table(
  modelResult: RelationalModel,
  sourceClassifierId: string,
): RelationalModel['tables'][number] {
  const result = modelResult.tables.find(
    (candidate) => candidate.sourceClassifierId === sourceClassifierId,
  );
  if (!result) {
    throw new Error(`Expected table for ${sourceClassifierId}.`);
  }
  return result;
}

function expectGenerationError(input: unknown): RelationalModelGenerationError {
  try {
    generateRelationalModel(input);
  } catch (error) {
    if (error instanceof RelationalModelGenerationError) {
      return error;
    }
    throw error;
  }
  throw new Error('Expected relational model generation to fail.');
}

describe('relational model transformer', () => {
  it('1. emits the versioned relational contract', () => {
    const result = generateRelationalModel(model([classifier('aa', 'Customer')]));

    expect(result.schemaVersion).toBe('0.1.0');
    expect(result.sourceSchemaVersion).toBe('0.1.0');
    expect(result.conventions.inheritanceStrategy).toBe('JOINED');
  });

  it('2. ignores visual positions as persistence input', () => {
    const first = model([classifier('aa', 'Customer'), classifier('bb', 'Order')]);
    const second = structuredClone(first);
    second.diagram.visual.positions.reverse();
    second.diagram.visual.positions.forEach((position, index) => {
      position.x = 1000 - index;
      position.y = 500 - index;
    });

    expect(serializeRelationalModel(generateRelationalModel(first))).toBe(
      serializeRelationalModel(generateRelationalModel(second)),
    );
  });

  it('3. does not mutate the canonical input', () => {
    const input = loadFixture();
    const snapshot = structuredClone(input);

    generateRelationalModel(input);

    expect(input).toEqual(snapshot);
  });

  it('4. is deterministic when canonical arrays are reordered', () => {
    const first = loadFixture();
    const second = structuredClone(first);
    second.diagram.elements.reverse();
    second.diagram.relationships.reverse();
    second.diagram.elements.forEach((element) => element.attributes.reverse());

    expect(serializeRelationalModel(generateRelationalModel(first))).toBe(
      serializeRelationalModel(generateRelationalModel(second)),
    );
  });

  it('5. serializes with canonical object-key ordering', () => {
    const result = generateRelationalModel(model([classifier('aa', 'Customer')]));

    expect(serializeRelationalModel(result).startsWith('{"conventions"')).toBe(true);
    expect(serializeRelationalModel(result)).toBe(serializeRelationalModel(result));
  });

  it('5b. keeps a many-to-many model stable when relationship endpoints are inverted', () => {
    const first = model(
      [classifier('aa', 'Student'), classifier('bb', 'Course')],
      [
        relationship('r1', 'aa', 'bb', '0..*', '0..*', {
          source: { elementId: 'aa', role: 'student', multiplicity: '0..*', navigable: true },
          target: { elementId: 'bb', role: 'course', multiplicity: '0..*', navigable: true },
        }),
      ],
    );
    const inverted = structuredClone(first);
    inverted.diagram.relationships[0] = {
      ...inverted.diagram.relationships[0]!,
      source: inverted.diagram.relationships[0]!.target,
      target: inverted.diagram.relationships[0]!.source,
    };

    expect(serializeRelationalModel(generateRelationalModel(first))).toBe(
      serializeRelationalModel(generateRelationalModel(inverted)),
    );
  });

  it('6. creates a synthetic UUID identifier when no id attribute exists', () => {
    const result = generateRelationalModel(model([classifier('aa', 'Customer')]));
    const idColumn = table(result, 'aa').columns.find((column) => column.primaryKey);

    expect(idColumn).toMatchObject({
      physicalName: 'id',
      javaType: 'UUID',
      postgresType: 'uuid',
      generated: 'UUID',
    });
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'SYNTHETIC_IDENTIFIER' })]),
    );
  });

  it('7. preserves an explicit id attribute as the primary key', () => {
    const result = generateRelationalModel(
      model([classifier('aa', 'Customer', [attribute('aa_id', 'id', type('Long'))])]),
    );
    const idColumn = table(result, 'aa').columns.find((column) => column.primaryKey);

    expect(idColumn).toMatchObject({ javaType: 'Long', postgresType: 'bigint' });
    expect(idColumn?.generated).toBeUndefined();
  });

  it('8. normalizes class, attribute and constraint names to snake_case', () => {
    const result = generateRelationalModel(
      model([classifier('aa', 'OrderLine', [attribute('aa_total', 'grossTotal')])]),
    );
    const orderLine = table(result, 'aa');

    expect(orderLine.physicalName).toBe('order_line');
    expect(orderLine.columns.map((column) => column.physicalName)).toEqual(['id', 'gross_total']);
  });

  it('8b. handles acronym, punctuation, accents, digits and reserved names', () => {
    const result = generateRelationalModel(
      model([
        classifier('aa', 'HTTPRequest', [
          attribute('a1', 'URLValue'),
          attribute('a2', 'CustomerID'),
          attribute('a3', 'first-name'),
          attribute('a4', 'Áccent Name'),
          attribute('a5', '123 start'),
          attribute('a6', 'class'),
        ]),
        classifier('bb', 'Order'),
      ]),
    );
    const request = table(result, 'aa');

    expect(request.physicalName).toBe('http_request');
    expect(request.columns.map((column) => column.physicalName)).toEqual(
      expect.arrayContaining([
        'url_value',
        'customer_id',
        'first_name',
        'accent_name',
        'n_123_start',
        'class_',
      ]),
    );
    expect(
      request.columns.find((column) => column.physicalName === 'class_')?.javaPropertyName,
    ).toBe('classValue');
    expect(table(result, 'bb').physicalName).toBe('order_');
  });

  it('9. resolves physical table name collisions with stable hashes', () => {
    const result = generateRelationalModel(
      model([classifier('aa', 'OrderLine'), classifier('bb', 'order_line')]),
    );

    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'PHYSICAL_TABLE_NAME_COLLISION_RESOLVED' }),
      ]),
    );
    expect(result.tables.map((candidate) => candidate.physicalName)).toHaveLength(2);
  });

  it('9b. resolves Java entity and property name collisions with stable hashes', () => {
    const result = generateRelationalModel(
      model([
        classifier('aa', 'CustomerOrder', [attribute('a1', 'foo-bar'), attribute('a2', 'foo_bar')]),
        classifier('bb', 'customer_order'),
      ]),
    );
    const entities = result.tables.map((candidate) => candidate.javaEntityName);
    const first = table(result, 'aa');
    const properties = first.columns.map((column) => column.javaPropertyName);

    expect(new Set(entities).size).toBe(2);
    expect(new Set(properties).size).toBe(properties.length);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'JAVA_ENTITY_NAME_COLLISION_RESOLVED' }),
        expect.objectContaining({ code: 'JAVA_PROPERTY_NAME_COLLISION_RESOLVED' }),
      ]),
    );
  });

  it('9c. keeps collection columns and foreign keys after a table-name collision', () => {
    const result = generateRelationalModel(
      model([
        classifier('aa', 'CustomerTags'),
        classifier('bb', 'Customer', [
          attribute('bb_tags', 'tags', type('String', { collection: true })),
        ]),
      ]),
    );
    const collection = result.tables.find((candidate) => candidate.kind === 'collection');

    expect(collection?.physicalName).toMatch(/^customer_tags_[0-9a-f]{8}$/);
    expect(collection?.columns.map((column) => column.physicalName)).toEqual(['owner_id', 'value']);
    expect(collection?.primaryKey.columnIds).toHaveLength(2);
    expect(collection?.foreignKeys).toHaveLength(1);
  });

  it('9d. keeps join columns and foreign keys after a table-name collision', () => {
    const result = generateRelationalModel(
      model(
        [
          classifier('aa', 'CourseStudent'),
          classifier('bb', 'Student'),
          classifier('cc', 'Course'),
        ],
        [
          relationship('r1', 'bb', 'cc', '0..*', '0..*', {
            source: { elementId: 'bb', role: 'student', multiplicity: '0..*', navigable: true },
            target: { elementId: 'cc', role: 'course', multiplicity: '0..*', navigable: true },
          }),
        ],
      ),
    );
    const join = result.tables.find((candidate) => candidate.kind === 'join');

    expect(join?.physicalName).toMatch(/^course_student_[0-9a-f]{8}$/);
    expect(join?.primaryKey.columnIds).toHaveLength(2);
    expect(join?.columns).toHaveLength(2);
    expect(join?.foreignKeys).toHaveLength(2);
  });

  it('9e. keeps association-class attributes and foreign keys after physical and Java collisions', () => {
    const result = generateRelationalModel(
      model(
        [
          classifier('aa', 'OrderLine'),
          classifier('bb', 'Order'),
          classifier('cc', 'Product'),
          classifier('dd', 'Order-Line', [attribute('dd_note', 'note')]),
        ],
        [
          relationship('r1', 'bb', 'cc', '0..*', '0..*', {
            associationClassId: 'dd',
            source: { elementId: 'bb', role: 'order', multiplicity: '0..*', navigable: true },
            target: { elementId: 'cc', role: 'product', multiplicity: '0..*', navigable: true },
          }),
        ],
      ),
    );
    const associationClass = table(result, 'dd');

    expect(associationClass.physicalName).toMatch(/^order_line_[0-9a-f]{8}$/);
    expect(associationClass.javaEntityName).toMatch(/^OrderLine_[0-9a-f]{8}$/);
    expect(associationClass.columns.map((column) => column.physicalName)).toContain('note');
    expect(associationClass.primaryKey.columnIds).toHaveLength(2);
    expect(associationClass.foreignKeys).toHaveLength(2);
  });

  it('9f. keeps derived collision output byte-stable when input order changes', () => {
    const first = model([
      classifier('aa', 'CustomerTags'),
      classifier('bb', 'Customer', [
        attribute('bb_tags', 'tags', type('String', { collection: true })),
      ]),
    ]);
    const second = structuredClone(first);
    second.diagram.elements.reverse();

    expect(serializeRelationalModel(generateRelationalModel(first))).toBe(
      serializeRelationalModel(generateRelationalModel(second)),
    );
    const collection = generateRelationalModel(second).tables.find(
      (candidate) => candidate.kind === 'collection',
    );
    expect(collection?.foreignKeys).toHaveLength(1);
  });

  it('10. maps supported scalar UML types to Java and PostgreSQL types', () => {
    const result = generateRelationalModel(
      model([
        classifier('aa', 'Types', [
          attribute('a1', 'textValue', type('String')),
          attribute('a2', 'countValue', type('Integer')),
          attribute('a3', 'totalValue', type('Decimal')),
          attribute('a4', 'activeValue', type('Boolean')),
          attribute('a5', 'createdValue', type('Instant')),
          attribute('a6', 'payloadValue', type('Json')),
          attribute('a7', 'dateValue', type('Date')),
          attribute('a8', 'dateTimeValue', type('DateTime')),
          attribute('a9', 'localDateTimeValue', type('LocalDateTime')),
          attribute('a10', 'bigIntegerValue', type('BigInteger')),
        ]),
      ]),
    );
    const columns = table(result, 'aa').columns;

    expect(columns.find((column) => column.physicalName === 'text_value')).toMatchObject({
      javaType: 'String',
      postgresType: 'varchar(255)',
    });
    expect(columns.find((column) => column.physicalName === 'count_value')).toMatchObject({
      javaType: 'Integer',
      postgresType: 'integer',
    });
    expect(columns.find((column) => column.physicalName === 'total_value')).toMatchObject({
      javaType: 'BigDecimal',
      postgresType: 'numeric(19,2)',
    });
    expect(columns.find((column) => column.physicalName === 'active_value')).toMatchObject({
      javaType: 'Boolean',
      postgresType: 'boolean',
    });
    expect(columns.find((column) => column.physicalName === 'created_value')).toMatchObject({
      javaType: 'Instant',
      postgresType: 'timestamptz(3)',
    });
    expect(columns.find((column) => column.physicalName === 'payload_value')).toMatchObject({
      javaType: 'JsonNode',
      postgresType: 'jsonb',
    });
    expect(columns.find((column) => column.physicalName === 'date_value')).toMatchObject({
      javaType: 'LocalDate',
      postgresType: 'date',
    });
    expect(columns.find((column) => column.physicalName === 'date_time_value')).toMatchObject({
      javaType: 'Instant',
      postgresType: 'timestamptz(3)',
    });
    expect(columns.find((column) => column.physicalName === 'local_date_time_value')).toMatchObject(
      {
        javaType: 'LocalDateTime',
        postgresType: 'timestamp(3)',
      },
    );
    expect(columns.find((column) => column.physicalName === 'big_integer_value')).toMatchObject({
      javaType: 'BigInteger',
      postgresType: 'numeric(38,0)',
    });
  });

  it('11. rejects unsupported scalar types instead of silently mapping them to text', () => {
    const error = expectGenerationError(
      model([classifier('aa', 'Customer', [attribute('aa_value', 'value', type('UnknownType'))])]),
    );

    expect(error.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'UNSUPPORTED_UML_TYPE', severity: 'ERROR' }),
        expect.objectContaining({ sourceIds: ['aa', 'aa_value'] }),
      ]),
    );
  });

  it('12. maps a scalar classifier attribute to a foreign key', () => {
    const result = generateRelationalModel(
      model([
        classifier('aa', 'Customer'),
        classifier('bb', 'Address'),
        classifier('cc', 'Profile', [
          attribute('cc_address', 'address', type('Address', { elementId: 'bb' })),
        ]),
      ]),
    );
    const profile = table(result, 'cc');

    expect(profile.columns.map((column) => column.physicalName)).toContain('address_id');
    expect(profile.foreignKeys).toEqual(
      expect.arrayContaining([expect.objectContaining({ referencedTableId: 'table_bb' })]),
    );
  });

  it('13. preserves nullable semantics on scalar classifier references', () => {
    const result = generateRelationalModel(
      model([
        classifier('aa', 'Customer'),
        classifier('bb', 'Address'),
        classifier('cc', 'Profile', [
          attribute('cc_address', 'address', type('Address', { elementId: 'bb', nullable: true })),
        ]),
      ]),
    );
    const address = table(result, 'cc').columns.find(
      (column) => column.physicalName === 'address_id',
    );

    expect(address?.nullable).toBe(true);
  });

  it('13b. uses a synthetic identifier when an id attribute is a collection', () => {
    const result = generateRelationalModel(
      model([
        classifier('aa', 'Customer', [
          attribute('aa_id', 'id', type('String', { collection: true })),
        ]),
      ]),
    );
    const customer = table(result, 'aa');

    expect(customer.columns.find((column) => column.primaryKey)).toMatchObject({
      generated: 'UUID',
      postgresType: 'uuid',
    });
    expect(result.tables.some((candidate) => candidate.kind === 'collection')).toBe(true);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'INCOMPATIBLE_IDENTIFIER_ATTRIBUTE' }),
      ]),
    );
  });

  it('14. places the foreign key on the many endpoint for one-to-many', () => {
    const result = generateRelationalModel(
      model(
        [classifier('aa', 'Customer'), classifier('bb', 'Order')],
        [
          relationship('r1', 'aa', 'bb', '1', '0..*', {
            source: { elementId: 'aa', role: 'customer', multiplicity: '1', navigable: true },
          }),
        ],
      ),
    );

    expect(table(result, 'bb').columns.map((column) => column.physicalName)).toContain(
      'customer_id',
    );
    expect(table(result, 'aa').columns.map((column) => column.physicalName)).not.toContain(
      'order_id',
    );
  });

  it('15. reverses the foreign key direction for many-to-one', () => {
    const result = generateRelationalModel(
      model(
        [classifier('aa', 'Order'), classifier('bb', 'Customer')],
        [
          relationship('r1', 'aa', 'bb', '0..*', '1', {
            target: { elementId: 'bb', role: 'customer', multiplicity: '1', navigable: true },
          }),
        ],
      ),
    );

    expect(table(result, 'aa').columns.map((column) => column.physicalName)).toContain(
      'customer_id',
    );
  });

  it('15b. preserves finite multiplicity bounds and warns when the database cannot enforce them', () => {
    const result = generateRelationalModel(
      model(
        [classifier('aa', 'Order'), classifier('bb', 'Customer')],
        [
          relationship('r1', 'aa', 'bb', '2..4', '1', {
            source: { elementId: 'aa', role: 'orders', multiplicity: '2..4', navigable: true },
            target: { elementId: 'bb', role: 'customer', multiplicity: '1', navigable: true },
          }),
        ],
      ),
    );
    const foreignKey = table(result, 'aa').foreignKeys[0];

    expect(foreignKey).toMatchObject({ sourceMultiplicity: '2..4', targetMultiplicity: '1' });
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'MULTIPLICITY_RANGE_NOT_ENFORCED' }),
      ]),
    );
  });

  it('15c. keeps asymmetric relationship output stable when endpoints are inverted', () => {
    const first = model(
      [classifier('aa', 'Customer'), classifier('bb', 'Order')],
      [
        relationship('r1', 'aa', 'bb', '1', '0..*', {
          source: { elementId: 'aa', role: 'customer', multiplicity: '1', navigable: true },
          target: { elementId: 'bb', role: 'orders', multiplicity: '0..*', navigable: true },
        }),
      ],
    );
    const inverted = structuredClone(first);
    inverted.diagram.relationships[0] = {
      ...inverted.diagram.relationships[0]!,
      source: inverted.diagram.relationships[0]!.target,
      target: inverted.diagram.relationships[0]!.source,
    };

    expect(serializeRelationalModel(generateRelationalModel(first))).toBe(
      serializeRelationalModel(generateRelationalModel(inverted)),
    );
  });

  it('15d. truncates long relationship-derived foreign-key names safely', () => {
    const longRole = `customer${'VeryLongRole'.repeat(9)}`.slice(0, 120);
    const result = generateRelationalModel(
      model(
        [classifier('aa', 'Order'), classifier('bb', 'Customer')],
        [
          relationship('r1', 'aa', 'bb', '0..*', '1', {
            source: { elementId: 'aa', role: 'orders', multiplicity: '0..*', navigable: true },
            target: { elementId: 'bb', role: longRole, multiplicity: '1', navigable: true },
          }),
        ],
      ),
    );

    expect(
      table(result, 'aa').columns.every(
        (column) => Buffer.byteLength(column.physicalName, 'utf8') <= 63,
      ),
    ).toBe(true);
  });

  it('16. uses a unique foreign key for one-to-one', () => {
    const result = generateRelationalModel(
      model(
        [classifier('aa', 'User'), classifier('bb', 'Profile')],
        [
          relationship('r1', 'aa', 'bb', '1', '0..1', {
            target: { elementId: 'bb', role: 'profile', multiplicity: '0..1', navigable: true },
          }),
        ],
      ),
    );
    const user = table(result, 'aa');

    expect(user.uniqueConstraints).toHaveLength(1);
    expect(user.foreignKeys).toHaveLength(1);
    expect(user.columns.find((column) => column.physicalName === 'profile_id')?.nullable).toBe(
      true,
    );
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'ONE_TO_ONE_OWNER_TIE_BREAK' })]),
    );
  });

  it('16b. keeps an obligatory one-to-one foreign key non-null', () => {
    const result = generateRelationalModel(
      model(
        [classifier('aa', 'User'), classifier('bb', 'Profile')],
        [relationship('r1', 'aa', 'bb', '1', '1')],
      ),
    );
    const user = table(result, 'aa');

    expect(user.columns.find((column) => column.physicalName === 'profile_id')?.nullable).toBe(
      false,
    );
    expect(user.uniqueConstraints).toHaveLength(1);
  });

  it('16c. places a one-way navigable one-to-one FK on the navigable-from endpoint', () => {
    const result = generateRelationalModel(
      model(
        [classifier('aa', 'User'), classifier('bb', 'Profile')],
        [
          relationship('r1', 'aa', 'bb', '1', '0..1', {
            source: { elementId: 'aa', role: 'user', multiplicity: '1', navigable: false },
            target: { elementId: 'bb', role: 'profile', multiplicity: '0..1', navigable: true },
          }),
        ],
      ),
    );

    expect(table(result, 'aa').columns.map((column) => column.physicalName)).toContain(
      'profile_id',
    );
    expect(table(result, 'bb').columns.map((column) => column.physicalName)).not.toContain(
      'user_id',
    );
  });

  it('17. creates a composite-key join table for many-to-many', () => {
    const result = generateRelationalModel(
      model(
        [classifier('aa', 'Student'), classifier('bb', 'Course')],
        [
          relationship('r1', 'aa', 'bb', '0..*', '0..*', {
            source: { elementId: 'aa', role: 'student', multiplicity: '0..*', navigable: true },
            target: { elementId: 'bb', role: 'course', multiplicity: '0..*', navigable: true },
          }),
        ],
      ),
    );
    const join = result.tables.find((candidate) => candidate.kind === 'join');

    expect(join).toMatchObject({ kind: 'join' });
    expect(join?.primaryKey.columnIds).toHaveLength(2);
    expect(join?.foreignKeys).toHaveLength(2);
  });

  it('17b. keeps parallel many-to-many relationships in distinct join tables', () => {
    const result = generateRelationalModel(
      model(
        [classifier('aa', 'Student'), classifier('bb', 'Course')],
        [
          relationship('r1', 'aa', 'bb', '0..*', '0..*', {
            name: 'enrollments',
            source: { elementId: 'aa', role: 'student', multiplicity: '0..*', navigable: true },
            target: { elementId: 'bb', role: 'course', multiplicity: '0..*', navigable: true },
          }),
          relationship('r2', 'aa', 'bb', '0..*', '0..*', {
            name: 'favorites',
            source: { elementId: 'aa', role: 'learner', multiplicity: '0..*', navigable: true },
            target: { elementId: 'bb', role: 'class', multiplicity: '0..*', navigable: true },
          }),
        ],
      ),
    );
    const joins = result.tables.filter((candidate) => candidate.kind === 'join');

    expect(joins).toHaveLength(2);
    expect(new Set(joins.map((join) => join.physicalName)).size).toBe(2);
  });

  it('18. maps a self one-to-many association to a self foreign key', () => {
    const result = generateRelationalModel(
      model(
        [classifier('aa', 'Person')],
        [
          relationship('r1', 'aa', 'aa', '0..1', '0..*', {
            source: { elementId: 'aa', role: 'manager', multiplicity: '0..1', navigable: true },
            target: { elementId: 'aa', role: 'reports', multiplicity: '0..*', navigable: true },
          }),
        ],
      ),
    );
    const person = table(result, 'aa');

    expect(person.columns.map((column) => column.physicalName)).toContain('manager_id');
    expect(person.foreignKeys[0]?.referencedTableId).toBe('table_aa');
  });

  it('19. gives a self many-to-many relationship distinct endpoint columns', () => {
    const result = generateRelationalModel(
      model(
        [classifier('aa', 'Person')],
        [
          relationship('r1', 'aa', 'aa', '0..*', '0..*', {
            source: { elementId: 'aa', role: 'follower', multiplicity: '0..*', navigable: true },
            target: { elementId: 'aa', role: 'followed', multiplicity: '0..*', navigable: true },
          }),
        ],
      ),
    );
    const join = result.tables.find((candidate) => candidate.kind === 'join');

    expect(join?.columns.map((column) => column.physicalName)).toEqual([
      'followed_id',
      'follower_id',
    ]);
  });

  it('19b. resolves Java property collisions on join endpoint columns', () => {
    const result = generateRelationalModel(
      model(
        [classifier('aa', 'Student'), classifier('bb', 'Course')],
        [
          relationship('r1', 'aa', 'bb', '0..*', '0..*', {
            source: { elementId: 'aa', role: 'foo_1', multiplicity: '0..*', navigable: true },
            target: { elementId: 'bb', role: 'foo1', multiplicity: '0..*', navigable: true },
          }),
        ],
      ),
    );
    const join = result.tables.find((candidate) => candidate.kind === 'join');

    expect(new Set(join?.columns.map((column) => column.javaPropertyName)).size).toBe(2);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'JAVA_PROPERTY_NAME_COLLISION_RESOLVED' }),
      ]),
    );
  });

  it('20. uses CASCADE for composition foreign keys', () => {
    const result = generateRelationalModel(
      model(
        [classifier('aa', 'Order'), classifier('bb', 'Line')],
        [
          relationship('r1', 'aa', 'bb', '1', '1..*', {
            kind: 'composition',
            source: { elementId: 'aa', role: 'order', multiplicity: '1', navigable: true },
            target: { elementId: 'bb', role: 'lines', multiplicity: '1..*', navigable: true },
          }),
        ],
      ),
    );

    expect(table(result, 'bb').foreignKeys[0]?.onDelete).toBe('CASCADE');
  });

  it('20b. rejects composition with multiple owners', () => {
    const error = expectGenerationError(
      model(
        [classifier('aa', 'Order'), classifier('bb', 'Tag')],
        [
          relationship('r1', 'aa', 'bb', '0..*', '0..*', {
            kind: 'composition',
            source: { elementId: 'aa', role: 'order', multiplicity: '0..*', navigable: true },
            target: { elementId: 'bb', role: 'tags', multiplicity: '0..*', navigable: true },
          }),
        ],
      ),
    );

    expect(error.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'COMPOSITION_MULTIPLE_OWNERS_UNSUPPORTED',
          severity: 'ERROR',
          sourceIds: ['aa', 'bb', 'r1'],
        }),
      ]),
    );
  });

  it('20c. places a one-to-one composition FK on the part and cascades to the owner', () => {
    const result = generateRelationalModel(
      model(
        [classifier('aa', 'Order'), classifier('bb', 'Invoice')],
        [
          relationship('r1', 'aa', 'bb', '1', '1', {
            kind: 'composition',
            source: { elementId: 'aa', role: 'order', multiplicity: '1', navigable: true },
            target: { elementId: 'bb', role: 'invoice', multiplicity: '1', navigable: true },
          }),
        ],
      ),
    );
    const owner = table(result, 'aa');
    const part = table(result, 'bb');
    const foreignKey = part.foreignKeys[0];

    expect(owner.foreignKeys).toHaveLength(0);
    expect(foreignKey).toMatchObject({ referencedTableId: owner.id, onDelete: 'CASCADE' });
    expect(part.uniqueConstraints).toHaveLength(1);
    expect(part.columns.find((column) => column.physicalName === 'order_id')?.nullable).toBe(false);
  });

  it('20d. preserves an optional composition owner without adding a uniqueness constraint', () => {
    const result = generateRelationalModel(
      model(
        [classifier('aa', 'Order'), classifier('bb', 'Line')],
        [
          relationship('r1', 'aa', 'bb', '0..1', '0..*', {
            kind: 'composition',
            source: { elementId: 'aa', role: 'order', multiplicity: '0..1', navigable: true },
            target: { elementId: 'bb', role: 'lines', multiplicity: '0..*', navigable: true },
          }),
        ],
      ),
    );
    const part = table(result, 'bb');

    expect(part.foreignKeys[0]?.onDelete).toBe('CASCADE');
    expect(part.uniqueConstraints).toHaveLength(0);
    expect(part.columns.find((column) => column.physicalName === 'order_id')?.nullable).toBe(true);
  });

  it('20e. rejects composition when source is not the single-owner endpoint', () => {
    const error = expectGenerationError(
      model(
        [classifier('aa', 'Order'), classifier('bb', 'Line')],
        [
          relationship('r1', 'aa', 'bb', '0..*', '1', {
            kind: 'composition',
            source: { elementId: 'aa', role: 'orders', multiplicity: '0..*', navigable: true },
            target: { elementId: 'bb', role: 'line', multiplicity: '1', navigable: true },
          }),
        ],
      ),
    );

    expect(error.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'COMPOSITION_MULTIPLE_OWNERS_UNSUPPORTED' }),
      ]),
    );
  });

  it('21. keeps aggregation foreign keys non-cascading', () => {
    const result = generateRelationalModel(
      model(
        [classifier('aa', 'Team'), classifier('bb', 'Member')],
        [
          relationship('r1', 'aa', 'bb', '1', '0..*', {
            kind: 'aggregation',
            source: { elementId: 'aa', role: 'team', multiplicity: '1', navigable: true },
            target: { elementId: 'bb', role: 'members', multiplicity: '0..*', navigable: true },
          }),
        ],
      ),
    );

    expect(table(result, 'bb').foreignKeys[0]?.onDelete).toBe('NO_ACTION');
  });

  it('21b. keeps aggregation join tables non-cascading', () => {
    const result = generateRelationalModel(
      model(
        [classifier('aa', 'Team'), classifier('bb', 'Skill')],
        [
          relationship('r1', 'aa', 'bb', '0..*', '0..*', {
            kind: 'aggregation',
            source: { elementId: 'aa', role: 'team', multiplicity: '0..*', navigable: true },
            target: { elementId: 'bb', role: 'skills', multiplicity: '0..*', navigable: true },
          }),
        ],
      ),
    );
    const join = result.tables.find((candidate) => candidate.kind === 'join');

    expect(join?.foreignKeys.map((foreignKey) => foreignKey.onDelete)).toEqual([
      'NO_ACTION',
      'NO_ACTION',
    ]);
  });

  it('22. materializes a primitive collection as a collection table', () => {
    const result = generateRelationalModel(
      model([
        classifier('aa', 'Customer', [
          attribute('aa_tags', 'tags', type('String', { collection: true })),
        ]),
      ]),
    );
    const collection = result.tables.find((candidate) => candidate.kind === 'collection');

    expect(collection).toMatchObject({ physicalName: 'customer_tags' });
    expect(collection?.primaryKey.columnIds).toHaveLength(2);
  });

  it('23. materializes a classifier collection with an element foreign key', () => {
    const result = generateRelationalModel(
      model([
        classifier('aa', 'Customer', [
          attribute('aa_orders', 'orders', type('Order', { elementId: 'bb', collection: true })),
        ]),
        classifier('bb', 'Order'),
      ]),
    );
    const collection = result.tables.find((candidate) => candidate.kind === 'collection');

    expect(collection?.foreignKeys).toHaveLength(2);
    expect(collection?.columns.map((column) => column.physicalName)).toEqual([
      'owner_id',
      'value_id',
    ]);
  });

  it('23b. resolves Java property collisions in class-valued collection tables', () => {
    const result = generateRelationalModel(
      model([
        classifier('aa', 'Customer', [
          attribute('aa_orders', 'owner-id', type('Order', { elementId: 'bb', collection: true })),
        ]),
        classifier('bb', 'Order'),
      ]),
    );
    const collection = result.tables.find((candidate) => candidate.kind === 'collection');

    expect(new Set(collection?.columns.map((column) => column.javaPropertyName)).size).toBe(2);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'JAVA_PROPERTY_NAME_COLLISION_RESOLVED' }),
      ]),
    );
  });

  it('24. represents an association class with endpoint FKs and a composite PK', () => {
    const result = generateRelationalModel(
      model(
        [
          classifier('aa', 'Student'),
          classifier('bb', 'Course'),
          classifier('cc', 'Enrollment', [attribute('cc_date', 'enrolledAt', type('LocalDate'))]),
        ],
        [
          relationship('r1', 'aa', 'bb', '0..*', '0..*', {
            associationClassId: 'cc',
            source: { elementId: 'aa', role: 'student', multiplicity: '0..*', navigable: true },
            target: { elementId: 'bb', role: 'course', multiplicity: '0..*', navigable: true },
          }),
        ],
      ),
    );
    const enrollment = table(result, 'cc');

    expect(enrollment.kind).toBe('association-class');
    expect(enrollment.primaryKey.columnIds).toHaveLength(2);
    expect(enrollment.foreignKeys).toHaveLength(2);
    expect(enrollment.columns.map((column) => column.physicalName)).toContain('enrolled_at');
  });

  it('24a. uses an explicit association-class id and uniquely constrains both endpoints', () => {
    const result = generateRelationalModel(
      model(
        [
          classifier('aa', 'Student'),
          classifier('bb', 'Course'),
          classifier('cc', 'Enrollment', [attribute('cc_id', 'id', type('Long'))]),
        ],
        [
          relationship('r1', 'aa', 'bb', '0..*', '0..*', {
            associationClassId: 'cc',
            source: { elementId: 'aa', role: 'student', multiplicity: '0..*', navigable: true },
            target: { elementId: 'bb', role: 'course', multiplicity: '0..*', navigable: true },
          }),
        ],
      ),
    );
    const enrollment = table(result, 'cc');
    const idColumn = enrollment.columns.find((column) => column.physicalName === 'id');

    expect(enrollment.primaryKey.columnIds).toEqual([idColumn?.id]);
    expect(idColumn).toMatchObject({ primaryKey: true, javaType: 'Long', postgresType: 'bigint' });
    expect(enrollment.columns.filter((column) => column.primaryKey)).toHaveLength(1);
    expect(enrollment.foreignKeys).toHaveLength(2);
    expect(enrollment.uniqueConstraints).toHaveLength(1);
    expect(enrollment.uniqueConstraints[0]?.columnIds).toHaveLength(2);
  });

  it('24a.1 references an explicitly identified association class with one column', () => {
    const result = generateRelationalModel(
      model(
        [
          classifier('aa', 'Student'),
          classifier('bb', 'Course'),
          classifier('cc', 'Enrollment', [attribute('cc_id', 'id', type('Long'))]),
          classifier('dd', 'Profile', [
            attribute('dd_enrollment', 'enrollment', type('Enrollment', { elementId: 'cc' })),
          ]),
        ],
        [
          relationship('r1', 'aa', 'bb', '0..*', '0..*', {
            associationClassId: 'cc',
          }),
        ],
      ),
    );

    expect(table(result, 'dd').foreignKeys).toEqual(
      expect.arrayContaining([expect.objectContaining({ referencedTableId: 'table_cc' })]),
    );
  });

  it('24a.2 rejects an incompatible association-class id explicitly', () => {
    const error = expectGenerationError(
      model(
        [
          classifier('aa', 'Student'),
          classifier('bb', 'Course'),
          classifier('cc', 'Enrollment', [
            attribute('cc_id', 'id', type('Student', { elementId: 'aa' })),
          ]),
        ],
        [relationship('r1', 'aa', 'bb', '0..*', '0..*', { associationClassId: 'cc' })],
      ),
    );

    expect(error.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'INCOMPATIBLE_ASSOCIATION_CLASS_IDENTIFIER',
          severity: 'ERROR',
          sourceIds: ['cc', 'cc_id', 'r1'],
        }),
      ]),
    );
  });

  it('24b. rejects a single-column reference to a composite-key table', () => {
    const error = expectGenerationError(
      model(
        [
          classifier('aa', 'Student'),
          classifier('bb', 'Course'),
          classifier('cc', 'Enrollment'),
          classifier('dd', 'Profile', [
            attribute('dd_enrollment', 'enrollment', type('Enrollment', { elementId: 'cc' })),
          ]),
        ],
        [
          relationship('r1', 'aa', 'bb', '0..*', '0..*', {
            associationClassId: 'cc',
          }),
        ],
      ),
    );

    expect(error.diagnostics.find((diagnostic) => diagnostic.severity === 'ERROR')).toMatchObject({
      code: 'COMPOSITE_PRIMARY_KEY_REFERENCE_UNSUPPORTED',
      severity: 'ERROR',
    });
  });

  it('24c. resolves Java property collisions on association-class endpoint columns', () => {
    const result = generateRelationalModel(
      model(
        [classifier('aa', 'Student'), classifier('bb', 'Course'), classifier('cc', 'Enrollment')],
        [
          relationship('r1', 'aa', 'bb', '0..*', '0..*', {
            associationClassId: 'cc',
            source: { elementId: 'aa', role: 'foo_1', multiplicity: '0..*', navigable: true },
            target: { elementId: 'bb', role: 'foo1', multiplicity: '0..*', navigable: true },
          }),
        ],
      ),
    );
    const associationClass = table(result, 'cc');

    expect(new Set(associationClass.columns.map((column) => column.javaPropertyName)).size).toBe(2);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'JAVA_PROPERTY_NAME_COLLISION_RESOLVED' }),
      ]),
    );
  });

  it('25. maps class generalization to JOINED primary-key inheritance', () => {
    const result = generateRelationalModel(
      model(
        [classifier('aa', 'Person'), classifier('bb', 'Customer')],
        [relationship('r1', 'bb', 'aa', '1', '1', { kind: 'generalization' })],
      ),
    );
    const customer = table(result, 'bb');

    expect(customer.inheritance).toMatchObject({
      strategy: 'JOINED',
      role: 'subclass',
      parentTableId: 'table_aa',
    });
    expect(customer.foreignKeys[0]).toMatchObject({
      referencedTableId: 'table_aa',
      onDelete: 'CASCADE',
    });
    expect(customer.foreignKeys[0]?.columnIds).toEqual(customer.primaryKey.columnIds);
    expect(
      table(result, 'bb').columns.find((column) => column.primaryKey)?.generated,
    ).toBeUndefined();
  });

  it('25a. adopts an explicit Long parent identifier for a synthetic child', () => {
    const result = generateRelationalModel(
      model(
        [
          classifier('aa', 'Person', [attribute('aa_id', 'id', type('Long'))]),
          classifier('bb', 'Customer'),
        ],
        [relationship('r1', 'bb', 'aa', '1', '1', { kind: 'generalization' })],
      ),
    );
    const identifier = table(result, 'bb').columns.find((column) => column.primaryKey);

    expect(identifier).toMatchObject({
      javaType: 'Long',
      postgresType: 'bigint',
      umlType: 'Long',
      nullable: false,
    });
    expect(identifier?.generated).toBeUndefined();
    expect(identifier?.defaultValue).toBeUndefined();
  });

  it('25a.1 adopts explicit UUID and String parent identifiers for synthetic children', () => {
    const uuidResult = generateRelationalModel(
      model(
        [
          classifier('aa', 'Person', [attribute('aa_id', 'id', type('UUID'))]),
          classifier('bb', 'Customer'),
        ],
        [relationship('r1', 'bb', 'aa', '1', '1', { kind: 'generalization' })],
      ),
    );
    const stringResult = generateRelationalModel(
      model(
        [
          classifier('aa', 'Person', [attribute('aa_id', 'id', type('String'))]),
          classifier('bb', 'Customer'),
        ],
        [relationship('r1', 'bb', 'aa', '1', '1', { kind: 'generalization' })],
      ),
    );

    expect(table(uuidResult, 'bb').columns.find((column) => column.primaryKey)).toMatchObject({
      javaType: 'UUID',
      postgresType: 'uuid',
    });
    expect(table(stringResult, 'bb').columns.find((column) => column.primaryKey)).toMatchObject({
      javaType: 'String',
      postgresType: 'varchar(255)',
    });
  });

  it('25a.2 preserves compatible explicit JOINED identifiers', () => {
    const result = generateRelationalModel(
      model(
        [
          classifier('aa', 'Person', [attribute('aa_id', 'id', type('Long'))]),
          classifier('bb', 'Customer', [attribute('bb_id', 'id', type('Long'))]),
        ],
        [relationship('r1', 'bb', 'aa', '1', '1', { kind: 'generalization' })],
      ),
    );

    expect(table(result, 'bb').columns.find((column) => column.primaryKey)).toMatchObject({
      javaType: 'Long',
      postgresType: 'bigint',
    });
  });

  it('25a.3 resolves inheritance parent-before-child independent of relationship IDs and order', () => {
    const first = model(
      [
        classifier('cc', 'VipCustomer'),
        classifier('aa', 'Person', [attribute('aa_id', 'id', type('Long'))]),
        classifier('bb', 'Customer'),
      ],
      [
        relationship('r1', 'cc', 'bb', '1', '1', { kind: 'generalization' }),
        relationship('r2', 'bb', 'aa', '1', '1', { kind: 'generalization' }),
      ],
    );
    const second = structuredClone(first);
    second.diagram.elements.reverse();
    second.diagram.relationships.reverse();

    expect(serializeRelationalModel(generateRelationalModel(first))).toBe(
      serializeRelationalModel(generateRelationalModel(second)),
    );
    const firstResult = generateRelationalModel(first);
    const middleIdentifier = table(firstResult, 'bb').columns.find((column) => column.primaryKey);
    const grandchildIdentifier = table(firstResult, 'cc').columns.find(
      (column) => column.primaryKey,
    );
    expect(middleIdentifier?.javaType).toBe('Long');
    expect(middleIdentifier?.generated).toBeUndefined();
    expect(grandchildIdentifier?.javaType).toBe('Long');
    expect(grandchildIdentifier?.generated).toBeUndefined();
  });

  it('25b. rejects incompatible explicit JOINED identifier types', () => {
    const error = expectGenerationError(
      model(
        [
          classifier('aa', 'Person', [attribute('aa_id', 'id', type('Long'))]),
          classifier('bb', 'Customer', [attribute('bb_id', 'id', type('UUID'))]),
        ],
        [relationship('r1', 'bb', 'aa', '1', '1', { kind: 'generalization' })],
      ),
    );

    expect(error.diagnostics.find((diagnostic) => diagnostic.severity === 'ERROR')).toMatchObject({
      code: 'JOINED_IDENTIFIER_TYPE_MISMATCH',
      severity: 'ERROR',
    });
  });

  it('25b. maps three inheritance levels without losing the middle parent', () => {
    const result = generateRelationalModel(
      model(
        [classifier('aa', 'Person'), classifier('bb', 'Customer'), classifier('cc', 'VipCustomer')],
        [
          relationship('r1', 'bb', 'aa', '1', '1', { kind: 'generalization' }),
          relationship('r2', 'cc', 'bb', '1', '1', { kind: 'generalization' }),
        ],
      ),
    );

    expect(table(result, 'bb').inheritance?.parentTableId).toBe('table_aa');
    expect(table(result, 'cc').inheritance?.parentTableId).toBe('table_bb');
  });

  it('25c. keeps generated identifiers within PostgreSQL length limits', () => {
    const longName = `Class${'VeryLongName'.repeat(7)}`;
    const result = generateRelationalModel(model([classifier('aa', longName)]));
    const generated = table(result, 'aa');

    expect(Buffer.byteLength(generated.physicalName, 'utf8')).toBeLessThanOrEqual(63);
    expect(Buffer.byteLength(generated.primaryKey.physicalName, 'utf8')).toBeLessThanOrEqual(63);
    expect(generated.physicalName).toMatch(/_[0-9a-f]{8}$/);
  });

  it('25c.1 keeps generated artifact identifiers within the contract limit', () => {
    const longClassifierId = `a${'b'.repeat(63)}`;
    const longAttributeId = `c${'d'.repeat(63)}`;
    const result = generateRelationalModel(
      model([
        classifier(longClassifierId, 'Customer', [
          attribute(longAttributeId, 'tags', type('String', { collection: true })),
        ]),
      ]),
    );
    const ids = result.tables.flatMap((candidate) => [
      candidate.id,
      candidate.primaryKey.id,
      ...candidate.columns.map((column) => column.id),
      ...candidate.foreignKeys.map((foreignKey) => foreignKey.id),
    ]);

    expect(ids.every((id) => Buffer.byteLength(id, 'utf8') <= 160)).toBe(true);
  });

  it('25d. rejects invalid multiplicities, missing references and inheritance cycles', () => {
    const invalidMultiplicity = expectGenerationError(
      model(
        [classifier('aa', 'Parent'), classifier('bb', 'Child')],
        [relationship('r1', 'aa', 'bb', '2..1', '1')],
      ),
    );
    expect(invalidMultiplicity.diagnostics[0]?.code).toBe('CANONICAL_SEMANTIC_INVALID');

    const missingReference = expectGenerationError(
      model([
        classifier('aa', 'Customer', [
          attribute('a1', 'address', type('MissingAddress', { elementId: 'bb' })),
        ]),
      ]),
    );
    expect(missingReference.diagnostics[0]?.code).toBe('CANONICAL_SEMANTIC_INVALID');

    const inheritanceCycle = expectGenerationError(
      model(
        [classifier('aa', 'Parent'), classifier('bb', 'Child')],
        [
          relationship('r1', 'aa', 'bb', '1', '1', { kind: 'generalization' }),
          relationship('r2', 'bb', 'aa', '1', '1', { kind: 'generalization' }),
        ],
      ),
    );
    expect(inheritanceCycle.diagnostics[0]?.code).toBe('CANONICAL_SEMANTIC_INVALID');

    const zeroMultiplicity = expectGenerationError(
      model(
        [classifier('aa', 'Parent'), classifier('bb', 'Child')],
        [relationship('r1', 'aa', 'bb', '0', '1')],
      ),
    );
    expect(
      zeroMultiplicity.diagnostics.find((diagnostic) => diagnostic.severity === 'ERROR')?.code,
    ).toBe('ZERO_MULTIPLICITY_UNSUPPORTED');
  });

  it('26. emits traceable diagnostics for interfaces, realization and dependency', () => {
    const interfaceClassifier: UmlClassifier = {
      id: 'bb',
      kind: 'interface',
      name: 'Repository',
      attributes: [],
      operations: [],
    };
    const result = generateRelationalModel(
      model(
        [classifier('aa', 'Order'), interfaceClassifier],
        [
          relationship('r1', 'aa', 'bb', '1', '1', { kind: 'realization' }),
          relationship('r2', 'aa', 'bb', '1', '1', { kind: 'dependency' }),
        ],
      ),
    );

    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'INTERFACE_NOT_PERSISTED', sourceIds: ['bb'] }),
        expect.objectContaining({
          code: 'REALIZATION_NOT_PERSISTED',
          sourceIds: ['aa', 'bb', 'r1'],
        }),
        expect.objectContaining({
          code: 'DEPENDENCY_NOT_PERSISTED',
          sourceIds: ['aa', 'bb', 'r2'],
        }),
      ]),
    );
  });

  it('rejects invalid canonical input without returning partial relational output', () => {
    const input = model([classifier('aa', 'Customer')]);
    input.diagram.elements[0]!.name = '   ';

    const error = expectGenerationError(input);

    expect(error.diagnostics[0]).toMatchObject({
      severity: 'ERROR',
      code: 'CANONICAL_SEMANTIC_INVALID',
    });
  });
});
