import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  assertRequiredEvidenceFiles,
  assertTrackedBackendPath,
  assertZip,
  collectTrackedBackendEntries,
  createZip,
  listTrackedBackendPaths,
  REQUIRED_6A3A_EVIDENCE_FILES,
} from './package-6a3';

const execFileAsync = promisify(execFile);
const ZIP_COMMENT = 'tracked-source-test';

describe('6A.3 delivery packaging', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'uml-delivery-package-'));
    await writeRepositoryFixture(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('selects exactly tracked files and excludes ignored and untracked files', async () => {
    const paths = await listTrackedBackendPaths(root);
    const entries = await collectTrackedBackendEntries(root, 'backend');

    expect(paths).toEqual(['.env.example', '.gitignore', 'README.md', 'src/main.ts']);
    expect(entries.map((entry) => entry.path)).toEqual(paths.map((path) => `backend/${path}`));
    expect(entries.map((entry) => entry.path).join('\n')).not.toContain('generated/prisma');
    expect(entries.map((entry) => entry.path).join('\n')).not.toContain('untracked');
  });

  it('rejects tracked generated Prisma output and native binaries', async () => {
    await git(root, ['add', '--force', 'src/generated/prisma/query_engine-windows.dll.node']);
    await git(root, ['commit', '-m', 'track generated engine']);
    await expect(collectTrackedBackendEntries(root)).rejects.toThrow('Generated Prisma output');

    await writeFile(join(root, 'src', 'native.wasm'), 'not a real binary');
    await git(root, ['add', 'src/native.wasm']);
    await git(root, ['rm', '--cached', 'src/generated/prisma/query_engine-windows.dll.node']);
    await git(root, ['commit', '-m', 'track native binary']);
    await expect(collectTrackedBackendEntries(root)).rejects.toThrow(
      'Native or Prisma engine binaries',
    );
  });

  it('rejects case variants of excluded generated and dependency paths', () => {
    expect(() => assertTrackedBackendPath('SRC/GENERATED/PRISMA/client.ts')).toThrow(
      'Generated Prisma output',
    );
    expect(() => assertTrackedBackendPath('NODE_MODULES/package/index.js')).toThrow(
      'Forbidden delivery ZIP path',
    );
  });

  it('rejects a tracked file that is removed from the worktree', async () => {
    await unlink(join(root, 'src', 'main.ts'));
    await expect(collectTrackedBackendEntries(root)).rejects.toThrow();
  });

  it('requires the complete 6A3A evidence set before packaging', async () => {
    const evidenceRoot = join(root, 'evidence');
    await mkdir(evidenceRoot);
    await writeFile(join(evidenceRoot, '00_RESUMEN_EJECUTIVO.md'), '# incomplete\n');

    await expect(
      assertRequiredEvidenceFiles(evidenceRoot, REQUIRED_6A3A_EVIDENCE_FILES),
    ).rejects.toThrow('Delivery evidence is incomplete');

    await Promise.all(
      REQUIRED_6A3A_EVIDENCE_FILES.map((file) =>
        writeFile(join(evidenceRoot, file), `# ${file}\n`),
      ),
    );
    await assertRequiredEvidenceFiles(evidenceRoot, REQUIRED_6A3A_EVIDENCE_FILES);
  });

  it('writes identical ZIPs with ordered tracked entries and EOCD comments', async () => {
    const entries = await collectTrackedBackendEntries(root, 'backend');
    const first = join(root, 'first.zip');
    const second = join(root, 'second.zip');
    const third = join(root, 'third.zip');

    await createZip(entries, first, ZIP_COMMENT);
    await createZip(entries, second, ZIP_COMMENT);
    await createZip(entries, third, ZIP_COMMENT);

    expect(await readFile(first)).toEqual(await readFile(second));
    expect(await readFile(second)).toEqual(await readFile(third));
    expect(await assertZip(first, ZIP_COMMENT)).toEqual(
      new Set(entries.map((entry) => entry.path)),
    );
  });
});

async function writeRepositoryFixture(root: string): Promise<void> {
  await mkdir(join(root, 'src', 'generated', 'prisma'), { recursive: true });
  await writeFile(
    join(root, '.gitignore'),
    ['dist/', 'src/generated/prisma/', '*.secret', ''].join('\n'),
  );
  await writeFile(join(root, '.env.example'), 'DATABASE_URL=postgresql://example.invalid/test\n');
  await writeFile(join(root, 'README.md'), '# package fixture\n');
  await writeFile(join(root, 'src', 'main.ts'), 'export const value = 1;\n');
  await git(root, ['init', '--quiet']);
  await git(root, ['config', 'user.email', 'package-test@example.com']);
  await git(root, ['config', 'user.name', 'Package Test']);
  await git(root, ['add', '.']);
  await git(root, ['commit', '--quiet', '-m', 'fixture']);

  await writeFile(join(root, 'untracked.txt'), 'untracked\n');
  await mkdir(join(root, 'dist'), { recursive: true });
  await writeFile(join(root, 'dist', 'bundle.js'), 'ignored\n');
  await writeFile(
    join(root, 'src', 'generated', 'prisma', 'query_engine-windows.dll.node'),
    'generated engine\n',
  );
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd });
}
