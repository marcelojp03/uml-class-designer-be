import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { access, lstat, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
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
const DELIVERY_DATE = '2026-09-20';
const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const EXCLUDED_SEGMENTS = new Set(
  ['.git', '.pnpm-store', 'coverage', 'dist', 'node_modules', 'target'].map((segment) =>
    segment.toLowerCase(),
  ),
);
const PRISMA_GENERATED_ROOT = 'src/generated/prisma';
const PRISMA_GENERATED_ROOT_LOWER = PRISMA_GENERATED_ROOT.toLowerCase();
const FORBIDDEN_BACKEND_EXTENSIONS = new Set(['.dll', '.node', '.wasm']);

export interface ArchiveEntry {
  path: string;
  content: Buffer;
}

interface DeliveryArtifact {
  name: string;
  path: string;
  comment: string;
}

interface DeliverySpec {
  id: '6A3' | '6A3A';
  title: string;
  manifestTitle: string;
  evidenceDirectory: string;
  promptFile: string;
  promptLabel: string;
  artifactNames: readonly [string, string, string, string];
}

const DELIVERY_SPECS: Record<DeliverySpec['id'], DeliverySpec> = {
  '6A3': {
    id: '6A3',
    title: '6A.3',
    manifestTitle: 'Incremento 6A.3 - Exportacion runtime',
    evidenceDirectory: '025-incremento-6a3-exportacion-runtime',
    promptFile: '030_PROMPT_INCREMENTO_6A_3_EXPORTACION_RUNTIME.md',
    promptLabel: 'Prompt 030',
    artifactNames: [
      'uml-class-designer-be-6A3-exportacion-runtime.zip',
      'uml-class-designer-knowledge-6A3-exportacion-runtime.zip',
      'evidencia-6A3-exportacion-runtime.zip',
      'ejemplo-proyecto-spring-boot-6A3.zip',
    ],
  },
  '6A3A': {
    id: '6A3A',
    title: '6A.3A',
    manifestTitle: 'Correccion 6A.3A - Roles y empaquetado',
    evidenceDirectory: '026-correccion-6a3a-roles-empaquetado',
    promptFile: '031_PROMPT_CORRECCION_6A_3A_ROLES_Y_EMPAQUETADO.md',
    promptLabel: 'Prompt 031',
    artifactNames: [
      'uml-class-designer-be-6A3A.zip',
      'uml-class-designer-knowledge-6A3A.zip',
      'evidencia-6A3A.zip',
      'ejemplo-proyecto-spring-boot-6A3A.zip',
    ],
  },
};

export async function main(
  deliveryId = process.argv.slice(2).find((argument) => !argument.startsWith('--')) ?? '6A3',
  verifyDeterminism = process.argv.includes('--verify-determinism'),
): Promise<void> {
  const delivery = deliverySpec(deliveryId);
  const backendRoot = process.cwd();
  const workspaceRoot = resolve(backendRoot, '..');
  const knowledgeRoot = join(workspaceRoot, 'uml-class-designer-knowledge');
  const evidenceRoot = join(knowledgeRoot, 'resultados-opencode', delivery.evidenceDirectory);
  const deliveryRoot = join(workspaceRoot, 'entregables', delivery.id);
  const promptPath = join(knowledgeRoot, 'prompts', delivery.promptFile);
  await Promise.all([access(knowledgeRoot), access(evidenceRoot), access(promptPath)]);
  await assertCleanBackendWorktree(backendRoot);

  const attempts = verifyDeterminism ? 3 : 1;
  let expectedFingerprint: readonly string[] | undefined;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const fingerprint = await createDelivery(
      delivery,
      backendRoot,
      knowledgeRoot,
      evidenceRoot,
      deliveryRoot,
      promptPath,
    );
    if (expectedFingerprint && !sameStrings(expectedFingerprint, fingerprint)) {
      throw new Error('Delivery ZIPs are not deterministic across consecutive packaging runs.');
    }
    expectedFingerprint ??= fingerprint;
  }

  console.log(
    `${delivery.title} delivery created and validated in ${deliveryRoot}${
      verifyDeterminism ? ' with three identical packaging runs' : ''
    }.`,
  );
}

async function createDelivery(
  delivery: DeliverySpec,
  backendRoot: string,
  knowledgeRoot: string,
  evidenceRoot: string,
  deliveryRoot: string,
  promptPath: string,
): Promise<readonly string[]> {
  const [head, branch, promptHash] = await Promise.all([
    gitHead(backendRoot),
    gitBranch(backendRoot),
    sha256File(promptPath),
  ]);
  const comment = `UML Class Designer ${delivery.title}; HEAD=${head}; BRANCH=${branch}; ${delivery.promptLabel.replaceAll(' ', '').toUpperCase()}=${promptHash}; DATE=${DELIVERY_DATE}`;
  await writeEvidenceManifest(evidenceRoot, delivery, promptHash);
  await rm(deliveryRoot, { recursive: true, force: true });
  await mkdir(deliveryRoot, { recursive: true });

  const artifacts: DeliveryArtifact[] = [
    {
      name: delivery.artifactNames[0],
      path: join(deliveryRoot, delivery.artifactNames[0]),
      comment,
    },
    {
      name: delivery.artifactNames[1],
      path: join(deliveryRoot, delivery.artifactNames[1]),
      comment,
    },
    {
      name: delivery.artifactNames[2],
      path: join(deliveryRoot, delivery.artifactNames[2]),
      comment,
    },
    {
      name: delivery.artifactNames[3],
      path: join(deliveryRoot, delivery.artifactNames[3]),
      comment,
    },
  ];

  const backendEntries = await collectTrackedBackendEntries(backendRoot, 'uml-class-designer-be');
  await createZip(backendEntries, artifacts[0]!.path, artifacts[0]!.comment);
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
    await collectDirectoryEntries(evidenceRoot, delivery.evidenceDirectory, excludeEvidencePath),
    artifacts[2]!.path,
    artifacts[2]!.comment,
  );
  await createZip(await generatedSampleEntries(), artifacts[3]!.path, artifacts[3]!.comment);

  await assertBackendZipTracked(
    artifacts[0]!.path,
    artifacts[0]!.comment,
    new Set(backendEntries.map((entry) => entry.path)),
  );
  for (const artifact of artifacts.slice(1)) {
    await assertZip(artifact.path, artifact.comment);
  }
  const manifestPath = await writeDeliveryManifest(
    deliveryRoot,
    delivery,
    artifacts,
    head,
    branch,
    promptHash,
  );
  return Promise.all(
    [...artifacts.map((artifact) => artifact.path), manifestPath].map(async (path) =>
      sha256File(path),
    ),
  );
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

export async function listTrackedBackendPaths(backendRoot: string): Promise<string[]> {
  const { stdout } = await execFileAsync('git', ['ls-files', '-z'], { cwd: backendRoot });
  return stdout
    .split('\0')
    .filter((path) => path.length > 0)
    .toSorted(compareArchivePaths);
}

export async function collectTrackedBackendEntries(
  backendRoot: string,
  prefix = 'uml-class-designer-be',
): Promise<ArchiveEntry[]> {
  const paths = await listTrackedBackendPaths(backendRoot);
  return Promise.all(
    paths.map(async (path) => {
      assertTrackedBackendPath(path);
      const filePath = await trackedRegularFilePath(backendRoot, path);
      return {
        path: `${prefix}/${path}`,
        content: await readFile(filePath),
      };
    }),
  );
}

async function trackedRegularFilePath(root: string, relativePath: string): Promise<string> {
  let currentPath = root;
  const segments = relativePath.split('/');
  for (const [index, segment] of segments.entries()) {
    currentPath = join(currentPath, segment);
    const metadata = await lstat(currentPath);
    if (metadata.isSymbolicLink()) {
      throw new Error(`Tracked delivery source cannot contain symbolic links: ${relativePath}`);
    }
    if (index === segments.length - 1) {
      if (!metadata.isFile()) {
        throw new Error(`Tracked delivery source is not a regular file: ${relativePath}`);
      }
      continue;
    }
    if (!metadata.isDirectory()) {
      throw new Error(`Tracked delivery source has an invalid parent path: ${relativePath}`);
    }
  }
  return currentPath;
}

export function assertTrackedBackendPath(path: string): void {
  assertDeliveryPath(path);
  const lowerPath = path.toLowerCase();
  if (
    lowerPath === PRISMA_GENERATED_ROOT_LOWER ||
    lowerPath.startsWith(`${PRISMA_GENERATED_ROOT_LOWER}/`)
  ) {
    throw new Error(`Generated Prisma output cannot be packaged: ${path}`);
  }
  const name = basename(path).toLowerCase();
  if (
    [...FORBIDDEN_BACKEND_EXTENSIONS].some((extension) => name.endsWith(extension)) ||
    /^(?:lib)?(?:query|schema|migration)[_-]?engine/.test(name)
  ) {
    throw new Error(`Native or Prisma engine binaries cannot be packaged: ${path}`);
  }
}

async function collectDirectoryEntries(
  root: string,
  prefix: string,
  shouldExclude: (path: string, isDirectory: boolean) => boolean,
): Promise<ArchiveEntry[]> {
  const entries: ArchiveEntry[] = [];
  await collectDirectoryEntriesAt(root, '', prefix, shouldExclude, entries);
  return entries.toSorted((left, right) => compareArchivePaths(left.path, right.path));
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
  for (const entry of entries.toSorted((left, right) =>
    compareArchivePaths(left.name, right.name),
  )) {
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

function excludeKnowledgePath(path: string, isDirectory: boolean): boolean {
  return path === 'resultados-opencode' || excludeCommonPath(path, isDirectory);
}

function excludeEvidencePath(path: string, isDirectory: boolean): boolean {
  return excludeCommonPath(path, isDirectory);
}

function excludeCommonPath(path: string, isDirectory: boolean): boolean {
  const segments = path.split('/');
  if (segments.some((segment) => EXCLUDED_SEGMENTS.has(segment.toLowerCase()))) return true;
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

export async function createZip(
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
  for (const entry of entries.toSorted((left, right) =>
    compareArchivePaths(left.path, right.path),
  )) {
    archive.append(entry.content, {
      date: ZIP_ENTRY_DATE,
      mode: ZIP_ENTRY_MODE,
      name: entry.path,
    });
  }
  await archive.finalize();
  await outputFinished;
}

export async function assertZip(outputPath: string, expectedComment: string): Promise<Set<string>> {
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
  let previousPath: string | undefined;
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
    if (previousPath && compareArchivePaths(previousPath, path) >= 0) {
      throw new Error(`ZIP paths are not deterministically ordered: ${outputPath}`);
    }
    if (bytes.readUInt16LE(offset + 12) !== 0 || bytes.readUInt16LE(offset + 14) !== 0x21) {
      throw new Error(`ZIP timestamp is not deterministic: ${outputPath}`);
    }
    if (bytes.readUInt32LE(offset + 38) >>> 16 !== ZIP_ENTRY_MODE) {
      throw new Error(`ZIP mode is not deterministic: ${outputPath}`);
    }
    paths.add(path);
    previousPath = path;
    offset += 46 + nameLength + extraLength + fileCommentLength;
  }
  if (offset !== centralDirectoryOffset + bytes.readUInt32LE(eocdOffset + 12)) {
    throw new Error(`ZIP central directory size is invalid: ${outputPath}`);
  }
  return paths;
}

async function assertBackendZipTracked(
  outputPath: string,
  expectedComment: string,
  expectedPaths: ReadonlySet<string>,
): Promise<void> {
  const actualPaths = await assertZip(outputPath, expectedComment);
  if (actualPaths.size !== expectedPaths.size) {
    throw new Error(`Backend ZIP entry count differs from git ls-files: ${outputPath}`);
  }
  for (const path of actualPaths) {
    if (!expectedPaths.has(path)) {
      throw new Error(`Backend ZIP contains a non-versioned path: ${path}`);
    }
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
  if (
    !path ||
    path.includes('\\') ||
    path.startsWith('/') ||
    /^[A-Za-z]:\//.test(path) ||
    path.includes('\u0000')
  ) {
    throw new Error(`Unsafe delivery ZIP path: ${path}`);
  }
  const segments = path.split('/');
  if (
    segments.some((segment) => {
      const lower = segment.toLowerCase();
      return (
        !segment ||
        segment === '.' ||
        segment === '..' ||
        EXCLUDED_SEGMENTS.has(lower) ||
        lower === '.env' ||
        (lower.startsWith('.env.') && lower !== '.env.example' && lower !== '.env.test.example')
      );
    }) ||
    path.toLowerCase().endsWith('.zip')
  ) {
    throw new Error(`Forbidden delivery ZIP path: ${path}`);
  }
}

function compareArchivePaths(left: string, right: string): number {
  return Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8'));
}

async function writeEvidenceManifest(
  evidenceRoot: string,
  delivery: DeliverySpec,
  promptHash: string,
): Promise<void> {
  const manifestPath = join(evidenceRoot, `MANIFIESTO_SHA256_${delivery.id}.txt`);
  await rm(manifestPath, { force: true });
  const entries = await collectDirectoryEntries(evidenceRoot, '', excludeEvidencePath);
  const lines = [
    `Evidencia: ${delivery.manifestTitle}`,
    `Fecha: ${DELIVERY_DATE}`,
    `${delivery.promptLabel} SHA-256: ${promptHash}`,
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
  delivery: DeliverySpec,
  artifacts: readonly DeliveryArtifact[],
  head: string,
  branch: string,
  promptHash: string,
): Promise<string> {
  const lines = [
    `Entrega: ${delivery.manifestTitle}`,
    `Fecha: ${DELIVERY_DATE}`,
    `Backend branch: ${branch}`,
    `Backend HEAD: ${head}`,
    `${delivery.promptLabel} SHA-256: ${promptHash}`,
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
    '- El backend se empaqueta exclusivamente desde git ls-files de un worktree limpio; knowledge excluye resultados historicos y evidencia se entrega por separado.',
  );
  const manifestPath = join(deliveryRoot, `MANIFIESTO_SHA256_${delivery.id}.txt`);
  await writeFile(manifestPath, `${lines.join('\n')}\n`, 'utf8');
  return manifestPath;
}

async function gitHead(cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd });
  return stdout.trim();
}

async function gitBranch(cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['branch', '--show-current'], { cwd });
  const branch = stdout.trim();
  if (!branch) throw new Error('Delivery packaging requires a named Git branch.');
  return branch;
}

async function assertCleanBackendWorktree(cwd: string): Promise<void> {
  const { stdout } = await execFileAsync(
    'git',
    ['status', '--porcelain', '--untracked-files=all'],
    { cwd },
  );
  if (stdout) {
    throw new Error(
      'Delivery packaging requires a clean backend worktree. Commit intended changes first.',
    );
  }
}

function deliverySpec(id: string): DeliverySpec {
  if (id === '6A3' || id === '6A3A') return DELIVERY_SPECS[id];
  throw new Error(`Unknown delivery identifier: ${id}`);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function sha256File(path: string): Promise<string> {
  return sha256(await readFile(path));
}

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex').toUpperCase();
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
