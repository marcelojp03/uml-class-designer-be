import type { RelationalModel } from '../relational-model';

export const SPRING_BOOT_GENERATOR_VERSION = '0.1.0' as const;
export const SPRING_BOOT_VERSION = '4.1.1' as const;
export const JAVA_VERSION = '21' as const;
export const FLYWAY_VERSION = '12.4.0' as const;

export interface SpringBootGeneratorOptions {
  packageName?: string;
  groupId?: string;
  artifactId?: string;
  applicationName?: string;
}

export type GenerationDiagnosticSeverity = 'ERROR' | 'WARNING' | 'INFO';

export interface GenerationDiagnostic {
  severity: GenerationDiagnosticSeverity;
  code: string;
  message: string;
  path?: string;
  sourceIds?: string[];
}

export interface GeneratedFile {
  path: string;
  content: string;
  byteLength: number;
  sha256: string;
}

export interface SpringBootProjectVersions {
  java: typeof JAVA_VERSION;
  springBoot: typeof SPRING_BOOT_VERSION;
  springDataJpa: 'managed-by-spring-boot';
  flyway: typeof FLYWAY_VERSION;
  mavenCompilerPlugin: 'managed-by-spring-boot-parent';
}

export interface SpringBootProjectMetadata {
  relationalSchemaVersion: RelationalModel['schemaVersion'];
  projectId: string;
  projectName: string;
  groupId: string;
  artifactId: string;
  packageName: string;
  applicationName: string;
  versions: SpringBootProjectVersions;
}

export interface GeneratedSpringProject {
  generatorVersion: typeof SPRING_BOOT_GENERATOR_VERSION;
  sourceSchemaVersion: RelationalModel['sourceSchemaVersion'];
  metadata: SpringBootProjectMetadata;
  files: GeneratedFile[];
  diagnostics: GenerationDiagnostic[];
}
