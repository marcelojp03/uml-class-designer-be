import { createHash } from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020';
import type { ErrorObject, ValidateFunction } from 'ajv';
import { generatedSpringProjectSchema } from './spring-boot-project.schema';
import type { GeneratedSpringProject } from './spring-boot.types';

export interface GeneratedSpringProjectContractIssue {
  path: string;
  keyword: string;
  message: string;
}

export class GeneratedSpringProjectContractError extends Error {
  constructor(readonly validationErrors: GeneratedSpringProjectContractIssue[]) {
    super('generatedSpringProject must conform to generated Spring Boot project schema 0.1.0.');
    this.name = 'GeneratedSpringProjectContractError';
  }
}

const validate: ValidateFunction = new Ajv2020({ allErrors: true, strict: true }).compile(
  generatedSpringProjectSchema,
);

export function assertGeneratedSpringProjectContract(
  value: unknown,
): asserts value is GeneratedSpringProject {
  if (!validate(value)) {
    throw new GeneratedSpringProjectContractError((validate.errors ?? []).map(toValidationIssue));
  }

  const project = value as GeneratedSpringProject;
  const issues: GeneratedSpringProjectContractIssue[] = [];
  const paths = new Set<string>();
  let previousPath = '';

  for (const [index, file] of project.files.entries()) {
    const path = `/files/${index}`;
    if (paths.has(file.path)) {
      issues.push(semanticIssue(`${path}/path`, `duplicates generated path ${file.path}.`));
    }
    paths.add(file.path);
    if (previousPath && previousPath > file.path) {
      issues.push(semanticIssue(`${path}/path`, 'generated files must be sorted by path.'));
    }
    previousPath = file.path;
    if (
      file.content.includes('\r') ||
      !file.content.endsWith('\n') ||
      file.content.endsWith('\n\n')
    ) {
      issues.push(
        semanticIssue(`${path}/content`, 'content must use LF and end with one newline.'),
      );
    }
    if (file.byteLength !== Buffer.byteLength(file.content, 'utf8')) {
      issues.push(semanticIssue(`${path}/byteLength`, 'does not match UTF-8 content length.'));
    }
    const sha256 = createHash('sha256').update(file.content, 'utf8').digest('hex');
    if (file.sha256 !== sha256) {
      issues.push(semanticIssue(`${path}/sha256`, 'does not match content SHA-256.'));
    }
  }

  if (issues.length > 0) {
    throw new GeneratedSpringProjectContractError(issues);
  }
}

function semanticIssue(path: string, message: string): GeneratedSpringProjectContractIssue {
  return { path, keyword: 'semantic', message };
}

function toValidationIssue(error: ErrorObject): GeneratedSpringProjectContractIssue {
  return {
    path: error.instancePath || '/',
    keyword: error.keyword,
    message: error.message ?? 'is invalid',
  };
}
