import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020';
import { generateSpringBootProject } from '../src/modules/generation/spring-boot';
import {
  assertGeneratedSpringProjectContract,
  GeneratedSpringProjectContractError,
} from '../src/modules/generation/spring-boot/spring-boot-project.validator';
import { generatedSpringProjectSchema } from '../src/modules/generation/spring-boot/spring-boot-project.schema';
import { generateRelationalModel } from '../src/modules/generation/relational-model';
import type { CanonicalUmlModel } from '../src/modules/uml-domain/collaboration.types';

function loadSchema(): unknown {
  return JSON.parse(
    readFileSync(resolve(process.cwd(), 'contracts/generated-spring-project.schema.json'), 'utf8'),
  );
}

describe('generated Spring Boot project contract', () => {
  it('keeps TypeScript runtime schema synchronized with the checked-in JSON Schema', () => {
    expect(generatedSpringProjectSchema).toEqual(loadSchema());
  });

  it('compiles as a strict Draft 2020-12 schema', () => {
    expect(() =>
      new Ajv2020({ allErrors: true, strict: true }).compile(generatedSpringProjectSchema),
    ).not.toThrow();
  });

  it('validates the generated metadata, deterministic files and diagnostics', () => {
    const canonicalModel = JSON.parse(
      readFileSync(resolve(process.cwd(), 'contracts/fixtures/valid-uml-model.json'), 'utf8'),
    ) as CanonicalUmlModel;
    const project = generateSpringBootProject(generateRelationalModel(canonicalModel));

    expect(() => assertGeneratedSpringProjectContract(project)).not.toThrow();
    expect(project.sourceSchemaVersion).toBe('0.1.0');
    expect(project.metadata.relationalSchemaVersion).toBe('0.1.0');
    expect(project.metadata.versions.flyway).toBe('12.4.0');
  });

  it('rejects extra output properties and tampered file metadata', () => {
    const canonicalModel = JSON.parse(
      readFileSync(resolve(process.cwd(), 'contracts/fixtures/valid-uml-model.json'), 'utf8'),
    ) as CanonicalUmlModel;
    const project = generateSpringBootProject(generateRelationalModel(canonicalModel));

    expect(() => assertGeneratedSpringProjectContract({ ...project, unexpected: true })).toThrow(
      GeneratedSpringProjectContractError,
    );

    const tampered = structuredClone(project);
    tampered.files[0]!.sha256 = '0'.repeat(64);
    expect(() => assertGeneratedSpringProjectContract(tampered)).toThrow(
      GeneratedSpringProjectContractError,
    );

    const extraNewline = structuredClone(project);
    extraNewline.files[0]!.content += '\n';
    extraNewline.files[0]!.byteLength = Buffer.byteLength(extraNewline.files[0]!.content, 'utf8');
    extraNewline.files[0]!.sha256 = createHash('sha256')
      .update(extraNewline.files[0]!.content, 'utf8')
      .digest('hex');
    expect(() => assertGeneratedSpringProjectContract(extraNewline)).toThrow(
      GeneratedSpringProjectContractError,
    );
  });
});
