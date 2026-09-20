import { createHash } from 'node:crypto';
import archiver = require('archiver');
import type { GeneratedFile } from '../spring-boot';
import { SPRING_BOOT_EXPORT_LIMITS, SpringBootExportLimitError } from './spring-boot-export.types';

const ZIP_ENTRY_DATE = new Date('1980-01-01T00:00:00.000Z');
const ZIP_ENTRY_MODE = 0o100644;
const GENERATED_JAVA_PATH =
  /^src\/main\/java\/[a-z][a-z0-9_]*(?:\/[a-z][a-z0-9_]*)*\/[A-Za-z][A-Za-z0-9_]*\.java$/;
const GENERATED_SQL_PATH = /^src\/main\/resources\/db\/migration\/V\d+__[A-Za-z0-9_]+\.sql$/;
const FORBIDDEN_PATH_SEGMENTS = new Set([
  '.git',
  '.svn',
  'coverage',
  'dist',
  'node_modules',
  'target',
]);

export class SpringBootExportArchiveError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SpringBootExportArchiveError';
  }
}

export async function createDeterministicSpringBootArchive(
  files: readonly GeneratedFile[],
): Promise<Buffer> {
  assertArchiveFiles(files);
  const archive = archiver('zip', {
    forceLocalTime: false,
    forceZip64: false,
    zlib: { level: 9 },
  });
  const chunks: Buffer[] = [];
  let archiveError: Error | undefined;
  let timedOut = false;
  archive.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  archive.on('error', (error: Error) => {
    archiveError = error;
  });

  const timeout = setTimeout(() => {
    timedOut = true;
    archive.abort();
  }, SPRING_BOOT_EXPORT_LIMITS.maxArchiveMs);
  try {
    for (const file of files.toSorted(compareFiles)) {
      archive.append(Buffer.from(file.content, 'utf8'), {
        date: ZIP_ENTRY_DATE,
        mode: ZIP_ENTRY_MODE,
        name: file.path,
      });
    }
    await archive.finalize();
    if (timedOut) {
      throw new SpringBootExportLimitError(
        'ARCHIVE_TIMEOUT',
        `Generated ZIP exceeded ${SPRING_BOOT_EXPORT_LIMITS.maxArchiveMs} ms.`,
      );
    }
    if (archiveError) {
      throw archiveError;
    }
  } catch (error) {
    if (archiveError) {
      throw new SpringBootExportArchiveError('ARCHIVE_WRITE_FAILED', archiveError.message);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  const output = Buffer.concat(chunks);
  if (output.byteLength > SPRING_BOOT_EXPORT_LIMITS.maxArchiveBytes) {
    throw new SpringBootExportLimitError(
      'ARCHIVE_BYTES_EXCEEDED',
      `Generated ZIP exceeds ${SPRING_BOOT_EXPORT_LIMITS.maxArchiveBytes} bytes.`,
    );
  }
  return output;
}

export function assertArchiveFiles(files: readonly GeneratedFile[]): void {
  if (files.length === 0) {
    throw new SpringBootExportArchiveError(
      'ARCHIVE_EMPTY',
      'The generated archive cannot be empty.',
    );
  }
  if (files.length > SPRING_BOOT_EXPORT_LIMITS.maxGeneratedFiles) {
    throw new SpringBootExportLimitError(
      'GENERATED_FILES_EXCEEDED',
      `Generated project exceeds ${SPRING_BOOT_EXPORT_LIMITS.maxGeneratedFiles} files.`,
    );
  }

  const paths = new Set<string>();
  let totalBytes = 0;
  for (const file of files) {
    assertSafeArchivePath(file.path);
    if (paths.has(file.path)) {
      throw new SpringBootExportArchiveError(
        'ARCHIVE_PATH_DUPLICATE',
        `Generated archive has a duplicate path: ${file.path}.`,
      );
    }
    paths.add(file.path);
    if (file.content.includes('\r') || !file.content.endsWith('\n')) {
      throw new SpringBootExportArchiveError(
        'ARCHIVE_FILE_ENCODING_INVALID',
        `Generated file ${file.path} must use LF and end with one newline.`,
      );
    }
    const byteLength = Buffer.byteLength(file.content, 'utf8');
    const sha256 = createHash('sha256').update(file.content, 'utf8').digest('hex');
    if (byteLength !== file.byteLength || sha256 !== file.sha256) {
      throw new SpringBootExportArchiveError(
        'ARCHIVE_FILE_CHECKSUM_INVALID',
        `Generated file ${file.path} has inconsistent metadata.`,
      );
    }
    totalBytes += byteLength;
  }
  if (totalBytes > SPRING_BOOT_EXPORT_LIMITS.maxUncompressedBytes) {
    throw new SpringBootExportLimitError(
      'UNCOMPRESSED_BYTES_EXCEEDED',
      `Generated project exceeds ${SPRING_BOOT_EXPORT_LIMITS.maxUncompressedBytes} bytes.`,
    );
  }
}

function assertSafeArchivePath(path: string): void {
  if (
    !path ||
    path.includes('\\') ||
    path.includes('\u0000') ||
    path.startsWith('/') ||
    path.endsWith('/') ||
    path.toLowerCase().endsWith('.zip')
  ) {
    throw new SpringBootExportArchiveError(
      'ARCHIVE_PATH_INVALID',
      'Generated archive path is unsafe.',
    );
  }
  const segments = path.split('/');
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === '.' ||
        segment === '..' ||
        segment.toLowerCase() === '.env' ||
        segment.toLowerCase().startsWith('.env.') ||
        FORBIDDEN_PATH_SEGMENTS.has(segment.toLowerCase()),
    )
  ) {
    throw new SpringBootExportArchiveError(
      'ARCHIVE_PATH_INVALID',
      'Generated archive path is unsafe.',
    );
  }
  if (!isAllowedArchivePath(path)) {
    throw new SpringBootExportArchiveError(
      'ARCHIVE_PATH_NOT_ALLOWED',
      'Generated archive path is outside the Spring Boot export allowlist.',
    );
  }
}

function isAllowedArchivePath(path: string): boolean {
  return (
    path === '.gitignore' ||
    path === 'README.md' ||
    path === 'pom.xml' ||
    path === 'generation-manifest.json' ||
    path === 'openapi/generated-api.openapi.json' ||
    path === 'postman/generated-api.postman_collection.json' ||
    path === 'src/main/resources/application.yml' ||
    GENERATED_JAVA_PATH.test(path) ||
    GENERATED_SQL_PATH.test(path)
  );
}

function compareFiles(left: GeneratedFile, right: GeneratedFile): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}
