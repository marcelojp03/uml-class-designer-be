import type { GeneratedFile, GeneratedSpringProject } from '../spring-boot';

export const SPRING_BOOT_EXPORT_VERSION = '0.1.0' as const;

export const SPRING_BOOT_EXPORT_LIMITS = {
  maxClasses: 100,
  maxRelationships: 200,
  maxSnapshotBytes: 1_048_576,
  maxGeneratedFiles: 1_000,
  maxUncompressedBytes: 10_485_760,
  maxArchiveBytes: 5_242_880,
  maxGenerationMs: 10_000,
  maxArchiveMs: 10_000,
  maxConcurrentExports: 2,
  actorLimit: 5,
  actorWindowMs: 60_000,
} as const;

export interface SpringBootExportOptions {
  groupId?: string;
  artifactId?: string;
  packageName?: string;
  applicationName?: string;
}

export interface GeneratedSpringBootExportArtifacts {
  openApi: GeneratedFile;
  postmanCollection: GeneratedFile;
  manifest: GeneratedFile;
  files: GeneratedFile[];
}

export interface SpringBootExportArchive {
  bytes: Buffer;
  fileName: string;
  generatorVersion: string;
  documentRevision: number;
}

export interface SpringBootExportBuildInput {
  documentRevision: number;
  project: GeneratedSpringProject;
}

export class SpringBootExportArtifactError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SpringBootExportArtifactError';
  }
}

export class SpringBootExportLimitError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SpringBootExportLimitError';
  }
}
