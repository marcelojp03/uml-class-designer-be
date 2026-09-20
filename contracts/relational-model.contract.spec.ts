import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import { relationalModelSchema } from '../src/modules/generation/relational-model/relational-model.schema';
import {
  assertRelationalModelContract,
  generateRelationalModel,
  RelationalModelContractError,
} from '../src/modules/generation/relational-model';
import type { RelationalModel } from '../src/modules/generation/relational-model';

function loadSchema(): unknown {
  return JSON.parse(
    readFileSync(resolve(process.cwd(), 'contracts/relational-model.schema.json'), 'utf8'),
  );
}

function loadSpringBootFixture(name: string): RelationalModel {
  return JSON.parse(
    readFileSync(resolve(process.cwd(), `contracts/fixtures/spring-boot/${name}`), 'utf8'),
  ) as RelationalModel;
}

describe('relational model contract', () => {
  it('keeps the runtime schema synchronized with the checked-in JSON Schema', () => {
    expect(relationalModelSchema).toEqual(loadSchema());
  });

  it('compiles as a strict Draft 2020-12 schema', () => {
    expect(() =>
      new Ajv2020({ allErrors: true, strict: true }).compile(relationalModelSchema),
    ).not.toThrow();
  });

  it('validates a generated result through the TypeScript and runtime contracts', () => {
    const fixture = JSON.parse(
      readFileSync(resolve(process.cwd(), 'contracts/fixtures/valid-uml-model.json'), 'utf8'),
    ) as unknown;
    const result: RelationalModel = generateRelationalModel(fixture);

    expect(() => assertRelationalModelContract(result)).not.toThrow();
    expect(result.schemaVersion).toBe('0.1.0');
  });

  it('rejects dangling relational references after structural schema validation', () => {
    const fixture = JSON.parse(
      readFileSync(resolve(process.cwd(), 'contracts/fixtures/valid-uml-model.json'), 'utf8'),
    ) as unknown;
    const result = generateRelationalModel(fixture);
    const broken = structuredClone(result);
    broken.tables[0]!.primaryKey.columnIds = ['missing_column'];

    expect(() => assertRelationalModelContract(broken)).toThrow(RelationalModelContractError);
  });

  it('rejects foreign keys that do not target a primary or unique key', () => {
    const fixture = JSON.parse(
      readFileSync(resolve(process.cwd(), 'contracts/fixtures/valid-uml-model.json'), 'utf8'),
    ) as unknown;
    const result = generateRelationalModel(fixture);
    const broken = structuredClone(result);
    const foreignKeyOwner = broken.tables.find((table) => table.foreignKeys.length > 0);
    const foreignKey = foreignKeyOwner?.foreignKeys[0];
    const referencedTable = foreignKey
      ? broken.tables.find((table) => table.id === foreignKey.referencedTableId)
      : undefined;
    const nonKeyColumn = referencedTable?.columns.find((column) => !column.primaryKey);

    if (!foreignKey || !nonKeyColumn) {
      throw new Error('Expected a generated foreign key and a non-key target column.');
    }
    foreignKey.referencedColumnIds = [nonKeyColumn.id];

    expect(() => assertRelationalModelContract(broken)).toThrow(RelationalModelContractError);
  });

  it('rejects foreign keys whose PostgreSQL types do not match', () => {
    const fixture = JSON.parse(
      readFileSync(resolve(process.cwd(), 'contracts/fixtures/valid-uml-model.json'), 'utf8'),
    ) as unknown;
    const result = generateRelationalModel(fixture);
    const broken = structuredClone(result);
    const owner = broken.tables.find((table) => table.foreignKeys.length > 0);
    const foreignKey = owner?.foreignKeys[0];
    const localColumn = foreignKey
      ? owner?.columns.find((column) => column.id === foreignKey.columnIds[0])
      : undefined;

    if (!localColumn) {
      throw new Error('Expected a generated foreign key with a local column.');
    }
    localColumn.postgresType = 'text';

    expect(() => assertRelationalModelContract(broken)).toThrow(RelationalModelContractError);
  });

  it('rejects nullable-invariant violations for primary keys and SET_NULL foreign keys', () => {
    const fixture = JSON.parse(
      readFileSync(resolve(process.cwd(), 'contracts/fixtures/valid-uml-model.json'), 'utf8'),
    ) as unknown;
    const result = generateRelationalModel(fixture);
    const primaryKeyBroken = structuredClone(result);
    const primaryKeyColumn = primaryKeyBroken.tables[0]!.columns.find(
      (column) => column.primaryKey,
    );

    if (!primaryKeyColumn) {
      throw new Error('Expected a generated primary key column.');
    }
    primaryKeyColumn.nullable = true;
    expect(() => assertRelationalModelContract(primaryKeyBroken)).toThrow(
      RelationalModelContractError,
    );

    const setNullBroken = structuredClone(result);
    const owner = setNullBroken.tables.find((table) => table.foreignKeys.length > 0);
    const foreignKey = owner?.foreignKeys[0];
    if (!owner || !foreignKey) {
      throw new Error('Expected a generated foreign key.');
    }
    foreignKey.onDelete = 'SET_NULL';
    const localColumn = owner.columns.find((column) => column.id === foreignKey.columnIds[0]);
    if (!localColumn) {
      throw new Error('Expected a local column for the generated foreign key.');
    }
    localColumn.nullable = false;
    expect(() => assertRelationalModelContract(setNullBroken)).toThrow(
      RelationalModelContractError,
    );
  });

  it('requires compatible declared Java and PostgreSQL column types', () => {
    const fixture = JSON.parse(
      readFileSync(resolve(process.cwd(), 'contracts/fixtures/valid-uml-model.json'), 'utf8'),
    ) as unknown;
    const broken = generateRelationalModel(fixture);
    const table = broken.tables.find((candidate) =>
      candidate.columns.some(
        (column) =>
          !candidate.foreignKeys.some((foreignKey) => foreignKey.columnIds.includes(column.id)),
      ),
    );
    if (!table) throw new Error('Expected a relational table with a direct column.');
    const column = table.columns.find(
      (candidate) =>
        !table.foreignKeys.some((foreignKey) => foreignKey.columnIds.includes(candidate.id)),
    );
    if (!column) throw new Error('Expected a relational column.');
    column.javaType = 'String';
    column.postgresType = 'bigint';
    expect(() => assertRelationalModelContract(broken)).toThrow(RelationalModelContractError);
  });

  it('requires every primaryKey-marked column to be declared by the table key', () => {
    const fixture = JSON.parse(
      readFileSync(resolve(process.cwd(), 'contracts/fixtures/valid-uml-model.json'), 'utf8'),
    ) as unknown;
    const broken = generateRelationalModel(fixture);
    const table = broken.tables.find((candidate) =>
      candidate.columns.some((column) => !column.primaryKey),
    );
    const nonPrimaryColumn = table?.columns.find((column) => !column.primaryKey);
    if (!nonPrimaryColumn) throw new Error('Expected a non-primary relational column.');
    nonPrimaryColumn.primaryKey = true;
    expect(() => assertRelationalModelContract(broken)).toThrow(RelationalModelContractError);
  });

  it('requires JOINED inheritance to terminate at a root primary key', () => {
    const missingRoot = loadSpringBootFixture('04-joined-inheritance-abstract.json');
    const person = missingRoot.tables.find((table) => table.id === 'table_person');
    if (!person) throw new Error('Expected Person inheritance root fixture.');
    person.inheritance = undefined;
    expect(() => assertRelationalModelContract(missingRoot)).toThrow(RelationalModelContractError);

    const nonPrimaryParentKey = loadSpringBootFixture('04-joined-inheritance-abstract.json');
    const parent = nonPrimaryParentKey.tables.find((table) => table.id === 'table_person');
    const child = nonPrimaryParentKey.tables.find((table) => table.id === 'table_employee');
    const parentCompanyId = parent?.columns.find(
      (column) => column.id === 'column_person_company_id',
    );
    const inheritanceForeignKey = child?.foreignKeys.find(
      (foreignKey) => foreignKey.id === 'fk_employee_person',
    );
    if (!parent || !child?.inheritance || !parentCompanyId || !inheritanceForeignKey) {
      throw new Error('Expected JOINED inheritance fixture metadata.');
    }
    parent.uniqueConstraints.push({
      id: 'uq_person_company',
      physicalName: 'uq_person_company',
      columnIds: [parentCompanyId.id],
      source: parent.source,
    });
    child.inheritance.parentColumnIds = [parentCompanyId.id];
    inheritanceForeignKey.referencedColumnIds = [parentCompanyId.id];
    expect(() => assertRelationalModelContract(nonPrimaryParentKey)).toThrow(
      RelationalModelContractError,
    );
  });

  it('rejects duplicate constraint identifiers and ambiguous JOINED foreign keys', () => {
    const duplicateUnique = loadSpringBootFixture('04-joined-inheritance-abstract.json');
    const company = duplicateUnique.tables.find((table) => table.id === 'table_company');
    if (!company) throw new Error('Expected Company fixture table.');
    company.uniqueConstraints.push(
      {
        id: 'uq_company_duplicate',
        physicalName: 'uq_company_duplicate_one',
        columnIds: ['column_company_id'],
        source: company.source,
      },
      {
        id: 'uq_company_duplicate',
        physicalName: 'uq_company_duplicate_two',
        columnIds: ['column_company_id'],
        source: company.source,
      },
    );
    expect(() => assertRelationalModelContract(duplicateUnique)).toThrow(
      RelationalModelContractError,
    );

    const duplicateJoinedForeignKey = loadSpringBootFixture('04-joined-inheritance-abstract.json');
    const employee = duplicateJoinedForeignKey.tables.find(
      (table) => table.id === 'table_employee',
    );
    const joinedForeignKey = employee?.foreignKeys.find(
      (foreignKey) => foreignKey.id === 'fk_employee_person',
    );
    if (!employee || !joinedForeignKey) {
      throw new Error('Expected JOINED inheritance foreign key fixture.');
    }
    employee.foreignKeys.push({
      ...joinedForeignKey,
      id: 'fk_employee_person',
      physicalName: 'fk_employee_person_duplicate',
      source: employee.source,
    });
    expect(() => assertRelationalModelContract(duplicateJoinedForeignKey)).toThrow(
      RelationalModelContractError,
    );
  });

  it('rejects primary and unique constraint names that collide across tables', () => {
    const duplicateConstraintName = loadSpringBootFixture('04-joined-inheritance-abstract.json');
    const company = duplicateConstraintName.tables.find((table) => table.id === 'table_company');
    const person = duplicateConstraintName.tables.find((table) => table.id === 'table_person');
    if (!company || !person) throw new Error('Expected Company and Person fixture tables.');
    person.primaryKey.physicalName = company.primaryKey.physicalName;

    expect(() => assertRelationalModelContract(duplicateConstraintName)).toThrow(
      RelationalModelContractError,
    );

    const tableNameCollision = loadSpringBootFixture('04-joined-inheritance-abstract.json');
    const collisionCompany = tableNameCollision.tables.find(
      (table) => table.id === 'table_company',
    );
    const collisionPerson = tableNameCollision.tables.find((table) => table.id === 'table_person');
    if (!collisionCompany || !collisionPerson) {
      throw new Error('Expected Company and Person fixture tables.');
    }
    collisionPerson.primaryKey.physicalName = collisionCompany.physicalName;
    expect(() => assertRelationalModelContract(tableNameCollision)).toThrow(
      RelationalModelContractError,
    );
  });
});
