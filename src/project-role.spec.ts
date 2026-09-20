import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function loadProjectRoles(): string[] {
  const schema = readFileSync(resolve(process.cwd(), 'prisma/schema.prisma'), 'utf8');
  const enumBody = /enum\s+ProjectRole\s*\{(?<body>[^}]*)\}/.exec(schema)?.groups?.body;

  if (!enumBody) {
    throw new Error('ProjectRole enum is missing from the Prisma schema.');
  }

  return enumBody
    .split(/\r?\n/)
    .map((line) => line.replace(/\/\/.*$/, '').trim())
    .filter(Boolean)
    .map((line) => line.split(/\s+/)[0])
    .filter((role): role is string => role !== undefined);
}

describe('ProjectRole Prisma enum', () => {
  it('defines only the supported project roles', () => {
    expect(loadProjectRoles()).toEqual(['OWNER', 'EDITOR']);
  });
});
