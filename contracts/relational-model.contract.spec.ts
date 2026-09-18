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
});
