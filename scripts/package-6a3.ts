import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { access, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { finished } from 'node:stream/promises';
import { promisify } from 'node:util';
import archiver = require('archiver');
import {
  generateSpringBootExportArtifacts,
  SPRING_BOOT_EXPORT_VERSION,
} from '../src/modules/generation/spring-boot-export';
import { generateSpringBootProject } from '../src/modules/generation/spring-boot';
import {
  assertRelationalModelContract,
  type RelationalModel,
} from '../src/modules/generation/relational-model';

const execFileAsync = promisify(execFile);
const ZIP_ENTRY_DATE = new Date('1980-01-01T00:00:00.000Z');
const ZIP_ENTRY_MODE = 0o100644;
const DELIVERY_NAME = '6A3';
const DELIVERY_DATE = '2026-09-20';
const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const ZIP_COMMENT_PREFIX = 'UML Class Designer 6A.3';
const EXCLUDED_SEGMENTS = new Set([
  '.git',
  '.pnpm-store',
  'coverage',
  'dist',
  'node_modules',
  'target',
]);

interface ArchiveEntry {
  path: string;
  content: Buffer;
}

interface DeliveryArtifact {
  name: string;
  path: string;
  comment: string;
}

async function main(): Promise<void> {
  const backendRoot = process.cwd();
  const workspaceRoot = resolve(backendRoot, '..');
  const knowledgeRoot = join(workspaceRoot, 'uml-class-designer-knowledge');
  const evidenceRoot = join(
    knowledgeRoot,
    'resultados-opencode',
    '025-incremento-6a3-exportacion-runtime',
  );
  const deliveryRoot = join(workspaceRoot, 'entregables', DELIVERY_NAME);
  const promptPath = join(
    knowledgeRoot,
    'prompts',
    '030_PROMPT_INCREMENTO_6A_3_EXPORTACION_RUNTIME.md',
  );
  await Promise.all([access(knowledgeRoot), access(evidenceRoot), access(promptPath)]);

  const [head, promptHash] = await Promise.all([gitHead(backendRoot), sha256File(promptPath)]);
  const comment = `${ZIP_COMMENT_PREFIX}; HEAD=${head}; PROMPT030=${promptHash}; DATE=${DELIVERY_DATE}`;
  await writeEvidenceManifest(evidenceRoot, promptHash);
  await rm(deliveryRoot, { recursive: true, force: true });
  await mkdir(deliveryRoot, { recursive: true });

  const artifacts: DeliveryArtifact[] = [
    {
      name: 'uml-class-designer-be-6A3-exportacion-runtime.zip',
      path: join(deliveryRoot, 'uml-class-designer-be-6A3-exportacion-runtime.zip'),
      comment,
    },
    {
      name: 'uml-class-designer-knowledge-6A3-exportacion-runtime.zip',
      path: join(deliveryRoot, 'uml-class-designer-knowledge-6A3-exportacion-runtime.zip'),
      comment,
    },
    {
      name: 'evidencia-6A3-exportacion-runtime.zip',
      path: join(deliveryRoot, 'evidencia-6A3-exportacion-runtime.zip'),
      comment,
    },
    {
      name: 'ejemplo-proyecto-spring-boot-6A3.zip',
      path: join(deliveryRoot, 'ejemplo-proyecto-spring-boot-6A3.zip'),
      comment,
    },
  ];

  await createZip(
    await collectDirectoryEntries(backendRoot, 'uml-class-designer-be', excludeBackendPath),
    artifacts[0]!.path,
    artifacts[0]!.comment,
  );
  await createZip(
    await collectDirectoryEntries(
      knowledgeRoot,
      'uml-class-designer-knowledge',
      excludeKnowledgePath,
    ),
    artifacts[1]!.path,
    artifacts[1]!.comment,
  );
  await createZip(
    await collectDirectoryEntries(
      evidenceRoot,
      '025-incremento-6a3-exportacion-runtime',
      excludeEvidencePath,
    ),
    artifacts[2]!.path,
    artifacts[2]!.comment,
  );
  await createZip(await generatedSampleEntries(), artifacts[3]!.path, artifacts[3]!.comment);

  for (const artifact of artifacts) {
    await assertZip(artifact.path, artifact.comment);
  }
  await writeDeliveryManifest(deliveryRoot, artifacts, head, promptHash);
  console.log(`6A.3 delivery created and validated in ${deliveryRoot}`);
}

async function generatedSampleEntries(): Promise<ArchiveEntry[]> {
  const fixturePath = resolve(process.cwd(), 'contracts/fixtures/spring-boot/01-simple-crud.json');
  const model = JSON.parse(await readFile(fixturePath, 'utf8')) as unknown;
  assertRelationalModelContract(model);
  const project = generateSpringBootProject(model as RelationalModel);
  const artifacts = generateSpringBootExportArtifacts(model as RelationalModel, {
    documentRevision: 0,
    project,
  });
  return [...project.files, ...artifacts.files].map((file) => ({
    path: file.path,
    content: Buffer.from(file.content, 'utf8'),
  }));
}

async function collectDirectoryEntries(
  root: string,
  prefix: string,
  shouldExclude: (path: string, isDirectory: boolean) => boolean,
): Promise<ArchiveEntry[]> {
  const entries: ArchiveEntry[] = [];
  await collectDirectoryEntriesAt(root, '', prefix, shouldExclude, entries);
  return entries.toSorted((left, right) => left.path.localeCompare(right.path));
}

async function collectDirectoryEntriesAt(
  root: string,
  currentPath: string,
  prefix: string,
  shouldExclude: (path: string, isDirectory: boolean) => boolean,
  collected: ArchiveEntry[],
): Promise<void> {
  const directory = join(root, currentPath);
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
    const nestedPath = currentPath ? `${currentPath}/${entry.name}` : entry.name;
    if (shouldExclude(nestedPath, entry.isDirectory())) continue;
    if (entry.isSymbolicLink()) {
      throw new Error(`Delivery source cannot contain symbolic links: ${nestedPath}`);
    }
    if (entry.isDirectory()) {
      await collectDirectoryEntriesAt(root, nestedPath, prefix, shouldExclude, collected);
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`Delivery source contains a non-file entry: ${nestedPath}`);
    }
    collected.push({
      path: prefix ? `${prefix}/${nestedPath}` : nestedPath,
      content: await readFile(join(root, nestedPath)),
    });
  }
}

function excludeBackendPath(path: string, isDirectory: boolean): boolean {
  return excludeCommonPath(path, isDirectory);
}

function excludeKnowledgePath(path: string, isDirectory: boolean): boolean {
  return path === 'resultados-opencode' || excludeCommonPath(path, isDirectory);
}

function excludeEvidencePath(path: string, isDirectory: boolean): boolean {
  return excludeCommonPath(path, isDirectory);
}

function excludeCommonPath(path: string, isDirectory: boolean): boolean {
  const segments = path.split('/');
  if (segments.some((segment) => EXCLUDED_SEGMENTS.has(segment))) return true;
  const name = basename(path).toLowerCase();
  if (name.endsWith('.zip') || name.endsWith('.log')) return true;
  if (
    name === '.env' ||
    (name.startsWith('.env.') && name !== '.env.example' && name !== '.env.test.example')
  ) {
    return true;
  }
  return isDirectory && name === 'tmp';
}

async function createZip(
  entries: readonly ArchiveEntry[],
  outputPath: string,
  comment: string,
): Promise<void> {
  if (entries.length === 0) throw new Error(`Cannot create an empty delivery ZIP: ${outputPath}`);
  const paths = new Set<string>();
  for (const entry of entries) {
    assertDeliveryPath(entry.path);
    if (paths.has(entry.path)) throw new Error(`Duplicate delivery ZIP path: ${entry.path}`);
    paths.add(entry.path);
  }

  await mkdir(dirname(outputPath), { recursive: true });
  const output = createWriteStream(outputPath, { flags: 'w' });
  const archive = archiver('zip', {
    comment,
    forceLocalTime: false,
    forceZip64: false,
    zlib: { level: 9 },
  });
  const outputFinished = finished(output);
  archive.on('error', (error) => output.destroy(error));
  archive.pipe(output);
  for (const entry of entries.toSorted((left, right) => left.path.localeCompare(right.path))) {
    archive.append(entry.content, {
      date: ZIP_ENTRY_DATE,
      mode: ZIP_ENTRY_MODE,
      name: entry.path,
    });
  }
  await archive.finalize();
  await outputFinished;
}

async function assertZip(outputPath: string, expectedComment: string): Promise<void> {
  const bytes = await readFile(outputPath);
  const eocdOffset = findEndOfCentralDirectory(bytes);
  const commentLength = bytes.readUInt16LE(eocdOffset + 20);
  const comment = bytes.subarray(eocdOffset + 22, eocdOffset + 22 + commentLength).toString('utf8');
  if (comment !== expectedComment || eocdOffset + 22 + commentLength !== bytes.byteLength) {
    throw new Error(`ZIP EOCD comment is invalid: ${outputPath}`);
  }

  const entryCount = bytes.readUInt16LE(eocdOffset + 10);
  const centralDirectoryOffset = bytes.readUInt32LE(eocdOffset + 16);
  const paths = new Set<string>();
  let offset = centralDirectoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (bytes.readUInt32LE(offset) !== ZIP_CENTRAL_DIRECTORY_SIGNATURE) {
      throw new Error(`ZIP central directory is invalid: ${outputPath}`);
    }
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const fileCommentLength = bytes.readUInt16LE(offset + 32);
    const path = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    assertDeliveryPath(path);
    if (paths.has(path)) throw new Error(`ZIP has duplicate paths: ${outputPath}`);
    paths.add(path);
    offset += 46 + nameLength + extraLength + fileCommentLength;
  }
  if (offset !== centralDirectoryOffset + bytes.readUInt32LE(eocdOffset + 12)) {
    throw new Error(`ZIP central directory size is invalid: ${outputPath}`);
  }
}

function findEndOfCentralDirectory(bytes: Buffer): number {
  const minimumOffset = Math.max(0, bytes.byteLength - 65_557);
  for (let offset = bytes.byteLength - 22; offset >= minimumOffset; offset -= 1) {
    if (bytes.readUInt32LE(offset) === ZIP_EOCD_SIGNATURE) return offset;
  }
  throw new Error('ZIP EOCD record was not found.');
}

function assertDeliveryPath(path: string): void {
  if (!path || path.includes('\\') || path.startsWith('/') || path.includes('\u0000')) {
    throw new Error(`Unsafe delivery ZIP path: ${path}`);
  }
  const segments = path.split('/');
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === '.' ||
        segment === '..' ||
        EXCLUDED_SEGMENTS.has(segment) ||
        segment.toLowerCase() === '.env' ||
        (segment.toLowerCase().startsWith('.env.') &&
          segment !== '.env.example' &&
          segment !== '.env.test.example'),
    ) ||
    path.toLowerCase().endsWith('.zip')
  ) {
    throw new Error(`Forbidden delivery ZIP path: ${path}`);
  }
}

async function writeEvidenceManifest(evidenceRoot: string, promptHash: string): Promise<void> {
  const manifestPath = join(evidenceRoot, 'MANIFIESTO_SHA256_6A3.txt');
  await rm(manifestPath, { force: true });
  const entries = await collectDirectoryEntries(evidenceRoot, '', excludeEvidencePath);
  const lines = [
    'Evidencia: Incremento 6A.3 - Exportacion runtime',
    `Fecha: ${DELIVERY_DATE}`,
    `Prompt 030 SHA-256: ${promptHash}`,
    `Generator version: ${SPRING_BOOT_EXPORT_VERSION}`,
    '',
    'Archivos incluidos:',
  ];
  for (const entry of entries) {
    lines.push(
      `${sha256(entry.content)}  ${entry.content.byteLength.toString().padStart(8, ' ')}  ${entry.path}`,
    );
  }
  await writeFile(manifestPath, `${lines.join('\n')}\n`, 'utf8');
}

async function writeDeliveryManifest(
  deliveryRoot: string,
  artifacts: readonly DeliveryArtifact[],
  head: string,
  promptHash: string,
): Promise<void> {
  const lines = [
    'Entrega: Incremento 6A.3 - Exportacion runtime',
    `Fecha: ${DELIVERY_DATE}`,
    `Backend HEAD: ${head}`,
    `Prompt 030 SHA-256: ${promptHash}`,
    '',
    'Artefactos:',
  ];
  for (const artifact of artifacts) {
    const content = await readFile(artifact.path);
    const metadata = await stat(artifact.path);
    lines.push(
      `${sha256(content)}  ${metadata.size.toString().padStart(8, ' ')}  ${artifact.name}`,
    );
  }
  lines.push('');
  lines.push('Verificaciones:');
  lines.push('- Los ZIP usan paths ordenados, fecha/modo fijo y comentario EOCD verificable.');
  lines.push(
    '- Los ZIP rechazan .env, secretos de entorno, node_modules, dist, coverage, target y ZIPs anidados.',
  );
  lines.push(
    '- El backend se empaqueta desde el worktree verificado; knowledge excluye resultados historicos y evidencia se entrega por separado.',
  );
  await writeFile(join(deliveryRoot, 'MANIFIESTO_SHA256_6A3.txt'), `${lines.join('\n')}\n`, 'utf8');
}

async function gitHead(cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd });
  return stdout.trim();
}

async function sha256File(path: string): Promise<string> {
  return sha256(await readFile(path));
}

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex').toUpperCase();
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
