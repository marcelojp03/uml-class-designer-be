import Ajv2020 from 'ajv/dist/2020';
import type { ErrorObject, ValidateFunction } from 'ajv';
import { relationalModelSchema } from './relational-model.schema';
import type { RelationalModel } from './relational-model.types';

export interface RelationalContractValidationIssue {
  path: string;
  keyword: string;
  message: string;
}

export class RelationalModelContractError extends Error {
  constructor(readonly validationErrors: RelationalContractValidationIssue[]) {
    super('relationalModel must conform to relational model schema 0.1.0.');
    this.name = 'RelationalModelContractError';
  }
}

const validate: ValidateFunction = new Ajv2020({ allErrors: true, strict: true }).compile(
  relationalModelSchema,
);

export function assertRelationalModelContract(value: unknown): asserts value is RelationalModel {
  if (!validate(value)) {
    throw new RelationalModelContractError((validate.errors ?? []).map(toValidationIssue));
  }
  const semanticIssues = validateRelationalModelSemantics(value as RelationalModel);
  if (semanticIssues.length > 0) {
    throw new RelationalModelContractError(semanticIssues);
  }
}

function validateRelationalModelSemantics(
  model: RelationalModel,
): RelationalContractValidationIssue[] {
  const issues: RelationalContractValidationIssue[] = [];
  const tablesById = new Map<string, RelationalModel['tables'][number]>();
  const tableNames = new Set<string>();
  const entityNames = new Set<string>();

  for (const [tableIndex, table] of model.tables.entries()) {
    const tablePath = `/tables/${tableIndex}`;
    if (tablesById.has(table.id)) {
      issues.push(semanticIssue(`${tablePath}/id`, `duplicates table identifier ${table.id}.`));
    }
    tablesById.set(table.id, table);
    if (tableNames.has(table.physicalName)) {
      issues.push(
        semanticIssue(
          `${tablePath}/physicalName`,
          `duplicates physical table name ${table.physicalName}.`,
        ),
      );
    }
    tableNames.add(table.physicalName);
    if (entityNames.has(table.javaEntityName)) {
      issues.push(
        semanticIssue(
          `${tablePath}/javaEntityName`,
          `duplicates Java entity name ${table.javaEntityName}.`,
        ),
      );
    }
    entityNames.add(table.javaEntityName);
  }

  for (const [tableIndex, table] of model.tables.entries()) {
    const tablePath = `/tables/${tableIndex}`;
    const columnsById = new Map<string, RelationalModel['tables'][number]['columns'][number]>();
    const physicalColumns = new Set<string>();
    const javaProperties = new Set<string>();
    const constraintNames = new Set<string>();
    const registerConstraintName = (name: string, path: string): void => {
      if (constraintNames.has(name)) {
        issues.push(semanticIssue(path, `duplicates constraint name ${name}.`));
      }
      constraintNames.add(name);
    };
    registerConstraintName(table.primaryKey.physicalName, `${tablePath}/primaryKey/physicalName`);
    for (const [columnIndex, column] of table.columns.entries()) {
      const columnPath = `${tablePath}/columns/${columnIndex}`;
      if (columnsById.has(column.id)) {
        issues.push(
          semanticIssue(`${columnPath}/id`, `duplicates column identifier ${column.id}.`),
        );
      }
      columnsById.set(column.id, column);
      if (physicalColumns.has(column.physicalName)) {
        issues.push(
          semanticIssue(
            `${columnPath}/physicalName`,
            `duplicates physical column name ${table.physicalName}.${column.physicalName}.`,
          ),
        );
      }
      physicalColumns.add(column.physicalName);
      if (javaProperties.has(column.javaPropertyName)) {
        issues.push(
          semanticIssue(
            `${columnPath}/javaPropertyName`,
            `duplicates Java property name ${table.javaEntityName}.${column.javaPropertyName}.`,
          ),
        );
      }
      javaProperties.add(column.javaPropertyName);
    }

    for (const [columnIndex, columnId] of table.primaryKey.columnIds.entries()) {
      const column = columnsById.get(columnId);
      if (!column) {
        issues.push(
          semanticIssue(
            `${tablePath}/primaryKey/columnIds/${columnIndex}`,
            `references missing column ${columnId}.`,
          ),
        );
      } else if (!column.primaryKey) {
        issues.push(
          semanticIssue(
            `${tablePath}/primaryKey/columnIds/${columnIndex}`,
            `references a column that is not marked primaryKey.`,
          ),
        );
      } else if (column.nullable) {
        issues.push(
          semanticIssue(
            `${tablePath}/primaryKey/columnIds/${columnIndex}`,
            'primary-key columns cannot be nullable.',
          ),
        );
      }
    }

    for (const [uniqueIndex, constraint] of table.uniqueConstraints.entries()) {
      registerConstraintName(
        constraint.physicalName,
        `${tablePath}/uniqueConstraints/${uniqueIndex}/physicalName`,
      );
      for (const [columnIndex, columnId] of constraint.columnIds.entries()) {
        if (!columnsById.has(columnId)) {
          issues.push(
            semanticIssue(
              `${tablePath}/uniqueConstraints/${uniqueIndex}/columnIds/${columnIndex}`,
              `references missing column ${columnId}.`,
            ),
          );
        }
      }
    }

    for (const [foreignKeyIndex, foreignKey] of table.foreignKeys.entries()) {
      const foreignKeyPath = `${tablePath}/foreignKeys/${foreignKeyIndex}`;
      registerConstraintName(foreignKey.physicalName, `${foreignKeyPath}/physicalName`);
      const localColumns = foreignKey.columnIds.map((columnId) => columnsById.get(columnId));
      for (const [columnIndex, columnId] of foreignKey.columnIds.entries()) {
        if (!columnsById.has(columnId)) {
          issues.push(
            semanticIssue(
              `${foreignKeyPath}/columnIds/${columnIndex}`,
              `references missing local column ${columnId}.`,
            ),
          );
        }
      }
      const referencedTable = tablesById.get(foreignKey.referencedTableId);
      if (!referencedTable) {
        issues.push(
          semanticIssue(
            `${foreignKeyPath}/referencedTableId`,
            `references missing table ${foreignKey.referencedTableId}.`,
          ),
        );
      } else {
        const referencedColumns = new Map(
          referencedTable.columns.map((column) => [column.id, column]),
        );
        for (const [columnIndex, columnId] of foreignKey.referencedColumnIds.entries()) {
          if (!referencedColumns.has(columnId)) {
            issues.push(
              semanticIssue(
                `${foreignKeyPath}/referencedColumnIds/${columnIndex}`,
                `references missing column ${columnId} on ${referencedTable.physicalName}.`,
              ),
            );
          }
        }
        if (!isDeclaredKey(referencedTable, foreignKey.referencedColumnIds)) {
          issues.push(
            semanticIssue(
              `${foreignKeyPath}/referencedColumnIds`,
              `must reference the primary key or a unique constraint on ${referencedTable.physicalName}.`,
            ),
          );
        }
        if (foreignKey.columnIds.length === foreignKey.referencedColumnIds.length) {
          for (const [columnIndex, columnId] of foreignKey.columnIds.entries()) {
            const localColumn = localColumns[columnIndex];
            const referencedColumn = referencedColumns.get(
              foreignKey.referencedColumnIds[columnIndex]!,
            );
            if (
              localColumn &&
              referencedColumn &&
              localColumn.postgresType !== referencedColumn.postgresType
            ) {
              issues.push(
                semanticIssue(
                  `${foreignKeyPath}/columnIds/${columnIndex}`,
                  `foreign-key column ${columnId} type ${localColumn.postgresType} must match referenced column ${referencedColumn.postgresType}.`,
                ),
              );
            }
          }
        }
      }
      if (foreignKey.columnIds.length !== foreignKey.referencedColumnIds.length) {
        issues.push(
          semanticIssue(
            foreignKeyPath,
            'foreign-key local and referenced column counts must match.',
          ),
        );
      }
      if (
        (foreignKey.sourceMultiplicity === undefined) !==
        (foreignKey.targetMultiplicity === undefined)
      ) {
        issues.push(
          semanticIssue(
            foreignKeyPath,
            'relationship foreign keys must provide both UML multiplicities or neither.',
          ),
        );
      }
      if (
        foreignKey.onDelete === 'SET_NULL' &&
        localColumns.some((column) => column !== undefined && !column.nullable)
      ) {
        issues.push(
          semanticIssue(
            `${foreignKeyPath}/onDelete`,
            'SET_NULL foreign keys require nullable local columns.',
          ),
        );
      }
    }

    const inheritance = table.inheritance;
    if (inheritance?.role === 'subclass') {
      if (!inheritance.parentTableId || !inheritance.parentColumnIds) {
        issues.push(
          semanticIssue(
            `${tablePath}/inheritance`,
            'subclass inheritance requires parentTableId and parentColumnIds.',
          ),
        );
      } else {
        const parentTable = tablesById.get(inheritance.parentTableId);
        if (!parentTable) {
          issues.push(
            semanticIssue(
              `${tablePath}/inheritance/parentTableId`,
              `references missing parent table ${inheritance.parentTableId}.`,
            ),
          );
        } else {
          const parentColumns = new Set(parentTable.columns.map((column) => column.id));
          for (const [columnIndex, columnId] of inheritance.parentColumnIds.entries()) {
            if (!parentColumns.has(columnId)) {
              issues.push(
                semanticIssue(
                  `${tablePath}/inheritance/parentColumnIds/${columnIndex}`,
                  `references missing parent column ${columnId}.`,
                ),
              );
            }
          }
          const joinedForeignKey = table.foreignKeys.find(
            (foreignKey) =>
              foreignKey.referencedTableId === parentTable.id &&
              foreignKey.onDelete === 'CASCADE' &&
              sameIds(foreignKey.columnIds, table.primaryKey.columnIds) &&
              sameIds(foreignKey.referencedColumnIds, inheritance.parentColumnIds!),
          );
          if (!joinedForeignKey) {
            issues.push(
              semanticIssue(
                `${tablePath}/inheritance`,
                'subclass inheritance requires a cascading primary-key foreign key to its parent.',
              ),
            );
          }
        }
      }
    } else if (inheritance?.parentTableId || inheritance?.parentColumnIds) {
      issues.push(
        semanticIssue(
          `${tablePath}/inheritance`,
          'root inheritance cannot declare parent table metadata.',
        ),
      );
    }
  }

  return issues;
}

function semanticIssue(path: string, message: string): RelationalContractValidationIssue {
  return { path, keyword: 'semantic', message };
}

function sameIds(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isDeclaredKey(table: RelationalModel['tables'][number], columnIds: string[]): boolean {
  return (
    sameIds(columnIds, table.primaryKey.columnIds) ||
    table.uniqueConstraints.some((constraint) => sameIds(columnIds, constraint.columnIds))
  );
}

function toValidationIssue(error: ErrorObject): RelationalContractValidationIssue {
  return {
    path: error.instancePath || '/',
    keyword: error.keyword,
    message: error.message ?? 'is invalid',
  };
}
