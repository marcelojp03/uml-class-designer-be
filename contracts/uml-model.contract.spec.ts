import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import type { AnySchema } from 'ajv';

function loadJson(relativePath: string): unknown {
  return JSON.parse(readFileSync(resolve(process.cwd(), relativePath), 'utf8')) as unknown;
}

describe('canonical UML contract', () => {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const validate = ajv.compile(loadJson('contracts/uml-model.schema.json') as AnySchema);

  it('accepts the valid fixture', () => {
    expect(validate(loadJson('contracts/fixtures/valid-uml-model.json'))).toBe(true);
    expect(validate.errors).toBeNull();
  });

  it('rejects the invalid fixture', () => {
    expect(validate(loadJson('contracts/fixtures/invalid-uml-model.json'))).toBe(false);
    expect(validate.errors?.some((error) => error.instancePath.endsWith('/multiplicity'))).toBe(
      true,
    );
  });

  it('does not couple the canonical schema to React Flow', () => {
    const schemaText = readFileSync(
      resolve(process.cwd(), 'contracts/uml-model.schema.json'),
      'utf8',
    );

    expect(schemaText).not.toMatch(/react.?flow|@xyflow|"nodes"|"edges"/i);
  });
});
