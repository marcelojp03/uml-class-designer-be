import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { dirname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createDeterministicSpringBootArchive,
  generateSpringBootExportArtifacts,
} from '../src/modules/generation/spring-boot-export';
import { generateSpringBootProject } from '../src/modules/generation/spring-boot';
import {
  assertRelationalModelContract,
  type RelationalModel,
} from '../src/modules/generation/relational-model';
import { terminateProcessTree } from './verify-spring-boot-generation';

const FIXTURE_NAME = process.env.SPRING_BOOT_RUNTIME_FIXTURE ?? '01-simple-crud.json';
const CONTAINER_NAME = `uml-class-designer-be-spring-boot-runtime-postgres-${randomUUID().slice(0, 8)}`;
const CONTAINER_LABEL = 'uml-class-designer.runtime=spring-boot-runtime';
const CONTROLLED_OCCUPIED_PORT = 55_435;
const DATABASE_NAME = 'generated_runtime';
const DATABASE_USER = 'generated_runtime';
const DATABASE_PASSWORD = 'runtime_test_only';
const COMMAND_TIMEOUT_MS = 180_000;
const APPLICATION_TIMEOUT_MS = 60_000;
const DATABASE_TIMEOUT_MS = 60_000;
const FAILURE_MODES = [
  'occupied-port',
  'postgres-unavailable',
  'jar-startup',
  'newman-request',
  'interrupt',
] as const;
const FAILURE_MODE = parseFailureMode(process.env.SPRING_BOOT_RUNTIME_FAILURE_MODE);
const fixturePath = resolve(process.cwd(), 'contracts/fixtures/spring-boot', FIXTURE_NAME);
const reportPath = process.env.SPRING_BOOT_RUNTIME_REPORT;
let activeChild: ChildProcess | undefined;
let interrupted: Error | undefined;
let cleanupInProgress = false;
let databasePort: number | undefined;
let applicationPort: number | undefined;

interface CommandResult {
  command: string;
  args: string[];
  elapsedMs: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

interface RuntimeReport {
  fixture: string;
  failureMode: (typeof FAILURE_MODES)[number] | 'none';
  generatedFileCount: number;
  archiveBytes: number;
  archiveSha256: string;
  databasePort: number;
  applicationPort: number;
  cleanupVerified: boolean;
  javaVersion: CommandResult;
  mavenVersion: CommandResult;
  mavenPackage: CommandResult;
  newman: CommandResult;
}

interface RunningProcess {
  child: ChildProcess;
  output: () => string;
  error: () => Error | undefined;
}

async function main(): Promise<void> {
  const javaHome = await requireJdk21Home();
  const directory = await mkdtemp(join(tmpdir(), 'uml-spring-boot-runtime-'));
  let createdContainer = false;
  let application: RunningProcess | undefined;
  let portBlocker: Server | undefined;
  let primaryError: unknown;
  const cleanupErrors: Error[] = [];
  let report: Partial<RuntimeReport> = {
    fixture: FIXTURE_NAME,
    failureMode: FAILURE_MODE ?? 'none',
  };
  const onSignal = (signal: NodeJS.Signals) => {
    interrupted ??= new Error(`Runtime verification interrupted by ${signal}.`);
    if (activeChild) {
      void terminateProcessTree(activeChild).catch(() => undefined);
    }
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    throwIfInterrupted();
    await removeExistingOwnedContainer();
    if (FAILURE_MODE === 'occupied-port') {
      portBlocker = await occupyRuntimeDatabasePort();
    }
    createdContainer = true;
    await startDatabase();
    if (FAILURE_MODE === 'postgres-unavailable') {
      await stopRuntimeDatabase();
      throw new Error('Controlled runtime failure: PostgreSQL is unavailable.');
    }
    throwIfInterrupted();
    await waitForDatabase();

    const model = await loadFixture();
    const project = generateSpringBootProject(model);
    const artifacts = generateSpringBootExportArtifacts(model, {
      documentRevision: 0,
      project,
    });
    const files = [...project.files, ...artifacts.files];
    const archive = await createDeterministicSpringBootArchive(files);
    if (!archive.subarray(0, 2).equals(Buffer.from('PK'))) {
      throw new Error('Generated Spring Boot export is not a ZIP archive.');
    }
    const archivePath = join(directory, 'spring-boot-export.zip');
    const extractedProjectDirectory = join(directory, 'extracted-project');
    await writeFile(archivePath, archive);
    await extractArchive(archivePath, extractedProjectDirectory, files);
    report = {
      ...report,
      generatedFileCount: files.length,
      archiveBytes: archive.byteLength,
      archiveSha256: createHash('sha256').update(archive).digest('hex'),
    };

    const runtimeEnv = {
      ...process.env,
      JAVA_HOME: javaHome,
      DB_PASSWORD: DATABASE_PASSWORD,
      DB_URL:
        FAILURE_MODE === 'jar-startup'
          ? `jdbc:postgresql://127.0.0.1:1/${DATABASE_NAME}`
          : `jdbc:postgresql://127.0.0.1:${requiredDatabasePort()}/${DATABASE_NAME}`,
      DB_USERNAME: DATABASE_USER,
      SERVER_ADDRESS: '127.0.0.1',
      SERVER_PORT: '0',
    };
    const javaVersion = await runCommand(
      javaExecutable(javaHome),
      ['-version'],
      extractedProjectDirectory,
      runtimeEnv,
      30_000,
    );
    assertSuccessful(javaVersion, 'JDK inspection');
    assertJdk21(javaVersion, javaHome);
    const mavenVersion = await runMaven(['-v'], extractedProjectDirectory, runtimeEnv, 30_000);
    assertSuccessful(mavenVersion, 'Maven inspection');
    assertJdk21(mavenVersion, javaHome);
    const mavenPackage = await runMaven(
      ['--batch-mode', '-DskipTests', 'package'],
      extractedProjectDirectory,
      runtimeEnv,
    );
    assertSuccessful(mavenPackage, 'Generated Maven package');
    report = { ...report, javaVersion, mavenVersion, mavenPackage };
    const applicationConfig = project.files.find(
      (file) => file.path === 'src/main/resources/application.yml',
    )?.content;
    if (!applicationConfig?.includes('ddl-auto: validate')) {
      throw new Error('Generated application must use Hibernate ddl-auto: validate.');
    }

    const jar = await findPackagedJar(extractedProjectDirectory);
    application = startApplication(javaHome, jar, extractedProjectDirectory, runtimeEnv);
    applicationPort = await waitForApplication(application, readinessPath(model));
    report = {
      ...report,
      applicationPort,
      databasePort: requiredDatabasePort(),
    };
    await verifyFlywayHistory();
    if (FAILURE_MODE === 'interrupt') {
      onSignal('SIGINT');
      throwIfInterrupted();
    }
    const newman = await runNewman(
      join(extractedProjectDirectory, artifacts.postmanCollection.path),
      extractedProjectDirectory,
      runtimeEnv,
      FAILURE_MODE === 'newman-request'
        ? 'http://127.0.0.1:1'
        : `http://127.0.0.1:${requiredApplicationPort()}`,
    );
    assertSuccessful(newman, 'Generated Newman collection');
    report = { ...report, newman };
    console.log(
      `Spring Boot runtime verification passed for ${FIXTURE_NAME} (${files.length} generated files).`,
    );
  } catch (error: unknown) {
    primaryError = error;
  } finally {
    cleanupInProgress = true;
    await collectCleanupError(cleanupErrors, async () => {
      if (application) await terminateProcessTree(application.child);
    });
    await collectCleanupError(cleanupErrors, async () => {
      if (createdContainer) await removeOwnedContainer();
    });
    await collectCleanupError(cleanupErrors, async () => {
      if (portBlocker) await closePortBlocker(portBlocker);
    });
    await collectCleanupError(cleanupErrors, async () => {
      await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    });
    await collectCleanupError(cleanupErrors, () => assertRuntimeCleanup(directory));
    if (cleanupErrors.length === 0) report = { ...report, cleanupVerified: true };
    await collectCleanupError(cleanupErrors, () => writeReport(report));
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
  if (cleanupErrors.length > 0) {
    if (primaryError) {
      throw new AggregateError(
        [toError(primaryError), ...cleanupErrors],
        'Runtime verification and cleanup failed.',
      );
    }
    throw new AggregateError(cleanupErrors, 'Runtime cleanup failed.');
  }
  if (primaryError) throw primaryError;
}

async function loadFixture(): Promise<RelationalModel> {
  const value = JSON.parse(await readFile(fixturePath, 'utf8')) as unknown;
  assertRelationalModelContract(value);
  return value;
}

function parseFailureMode(value: string | undefined): (typeof FAILURE_MODES)[number] | undefined {
  if (!value) return undefined;
  if ((FAILURE_MODES as readonly string[]).includes(value)) {
    return value as (typeof FAILURE_MODES)[number];
  }
  throw new Error(
    `Unsupported SPRING_BOOT_RUNTIME_FAILURE_MODE=${value}. Expected one of: ${FAILURE_MODES.join(', ')}.`,
  );
}

async function occupyRuntimeDatabasePort(): Promise<Server> {
  return new Promise((resolveServer, rejectServer) => {
    const server = createServer();
    server.once('error', rejectServer);
    server.listen(CONTROLLED_OCCUPIED_PORT, '127.0.0.1', () => {
      server.removeListener('error', rejectServer);
      resolveServer(server);
    });
  });
}

async function closePortBlocker(server: Server): Promise<void> {
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
}

async function collectCleanupError(errors: Error[], cleanup: () => Promise<void>): Promise<void> {
  try {
    await cleanup();
  } catch (error: unknown) {
    errors.push(toError(error));
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

async function assertRuntimeCleanup(directory: string): Promise<void> {
  const inspected = await runCommand(
    'docker',
    ['container', 'inspect', CONTAINER_NAME],
    process.cwd(),
    process.env,
    30_000,
  );
  if (inspected.exitCode === 0) {
    throw new Error(`Runtime PostgreSQL container ${CONTAINER_NAME} remains after cleanup.`);
  }
  if (!/No such (container|object)/iu.test(`${inspected.stdout}\n${inspected.stderr}`)) {
    throw new Error(`Unable to validate runtime PostgreSQL cleanup.\n${inspected.stderr}`);
  }
  try {
    await access(directory, constants.F_OK);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`Runtime temporary directory ${directory} remains after cleanup.`);
}

async function extractArchive(
  archivePath: string,
  directory: string,
  files: ReadonlyArray<{ path: string; content: string }>,
): Promise<void> {
  await mkdir(directory, { recursive: true });
  const extraction = await runCommand(
    process.platform === 'win32' ? 'tar.exe' : 'tar',
    ['-xf', archivePath, '-C', directory],
    directory,
    process.env,
    30_000,
  );
  assertSuccessful(extraction, 'Generated Spring Boot ZIP extraction');

  const extractedPaths = await collectExtractedPaths(directory);
  const expectedPaths = files.map((file) => file.path).toSorted();
  if (JSON.stringify(extractedPaths) !== JSON.stringify(expectedPaths)) {
    throw new Error('Extracted ZIP contents do not match the generated Spring Boot manifest.');
  }
  for (const file of files) {
    const destination = resolve(directory, file.path);
    const insideDirectory = relative(directory, destination);
    if (!insideDirectory || insideDirectory.startsWith('..')) {
      throw new Error(`Generated file path escaped runtime directory: ${file.path}.`);
    }
    if ((await readFile(destination, 'utf8')) !== file.content) {
      throw new Error(`Extracted ZIP content mismatch: ${file.path}.`);
    }
  }
}

async function collectExtractedPaths(directory: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(join(directory, prefix), { withFileTypes: true });
  const paths: string[] = [];
  for (const entry of entries) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      paths.push(...(await collectExtractedPaths(directory, path)));
    } else if (entry.isFile()) {
      paths.push(path);
    } else {
      throw new Error(`Extracted ZIP contains a non-file entry: ${path}.`);
    }
  }
  return paths.toSorted();
}

async function requireJdk21Home(): Promise<string> {
  const javaHome = process.env.JAVA_HOME;
  if (!javaHome) {
    throw new Error('JAVA_HOME must explicitly point to a JDK 21 installation.');
  }
  const executable = javaExecutable(javaHome);
  await access(executable, constants.F_OK);
  return javaHome;
}

function javaExecutable(javaHome: string): string {
  return join(javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
}

async function removeExistingOwnedContainer(): Promise<void> {
  await removeOwnedContainer();
}

async function runtimeContainerLabel(): Promise<string | undefined> {
  const inspected = await runCommand(
    'docker',
    [
      'container',
      'inspect',
      CONTAINER_NAME,
      '--format',
      '{{ index .Config.Labels "uml-class-designer.runtime" }}',
    ],
    process.cwd(),
    process.env,
    30_000,
  );
  return inspected.exitCode === 0 ? inspected.stdout.trim() : undefined;
}

async function startDatabase(): Promise<void> {
  const publishedPort =
    FAILURE_MODE === 'occupied-port'
      ? `127.0.0.1:${CONTROLLED_OCCUPIED_PORT}:5432`
      : '127.0.0.1::5432';
  const result = await runCommand(
    'docker',
    [
      'run',
      '--detach',
      '--rm',
      '--name',
      CONTAINER_NAME,
      '--label',
      CONTAINER_LABEL,
      '--publish',
      publishedPort,
      '--env',
      `POSTGRES_DB=${DATABASE_NAME}`,
      '--env',
      `POSTGRES_USER=${DATABASE_USER}`,
      '--env',
      `POSTGRES_PASSWORD=${DATABASE_PASSWORD}`,
      '--health-cmd',
      `pg_isready -U ${DATABASE_USER} -d ${DATABASE_NAME}`,
      '--health-interval',
      '2s',
      '--health-timeout',
      '3s',
      '--health-retries',
      '30',
      'postgres:17-alpine',
    ],
    process.cwd(),
    process.env,
    DATABASE_TIMEOUT_MS,
  );
  assertSuccessful(result, 'Runtime PostgreSQL startup');
  databasePort = await resolveRuntimeDatabasePort();
}

async function resolveRuntimeDatabasePort(): Promise<number> {
  const result = await runCommand(
    'docker',
    ['container', 'port', CONTAINER_NAME, '5432/tcp'],
    process.cwd(),
    process.env,
    30_000,
  );
  assertSuccessful(result, 'Runtime PostgreSQL port inspection');
  const match = /127\.0\.0\.1:(\d+)/u.exec(result.stdout);
  if (!match?.[1]) {
    throw new Error(`Runtime PostgreSQL did not publish a 127.0.0.1 port.\n${result.stdout}`);
  }
  const port = Number(match[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Runtime PostgreSQL published an invalid port: ${match[1]}.`);
  }
  return port;
}

async function stopRuntimeDatabase(): Promise<void> {
  const result = await runCommand(
    'docker',
    ['container', 'stop', CONTAINER_NAME],
    process.cwd(),
    process.env,
    30_000,
  );
  assertSuccessful(result, 'Controlled runtime PostgreSQL shutdown');
}

async function waitForDatabase(): Promise<void> {
  const deadline = Date.now() + DATABASE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    throwIfInterrupted();
    const result = await runCommand(
      'docker',
      ['container', 'inspect', CONTAINER_NAME, '--format', '{{.State.Health.Status}}'],
      process.cwd(),
      process.env,
      10_000,
    );
    if (result.exitCode === 0 && result.stdout.trim() === 'healthy') return;
    await delay(500);
  }
  throw new Error(`Runtime PostgreSQL container ${CONTAINER_NAME} did not become healthy.`);
}

async function verifyFlywayHistory(): Promise<void> {
  const result = await runCommand(
    'docker',
    [
      'exec',
      CONTAINER_NAME,
      'psql',
      '-U',
      DATABASE_USER,
      '-d',
      DATABASE_NAME,
      '-tAc',
      'SELECT count(*) FROM flyway_schema_history WHERE success = true',
    ],
    process.cwd(),
    process.env,
    30_000,
  );
  assertSuccessful(result, 'Flyway schema history inspection');
  if (Number(result.stdout.trim()) < 1) {
    throw new Error('Flyway did not record a successful generated migration.');
  }
}

async function removeOwnedContainer(): Promise<void> {
  const label = await runtimeContainerLabel();
  if (label === undefined) return;
  if (label !== 'spring-boot-runtime') {
    throw new Error(`Refusing to remove pre-existing container ${CONTAINER_NAME}.`);
  }
  const result = await runCommand(
    'docker',
    ['container', 'rm', '--force', CONTAINER_NAME],
    process.cwd(),
    process.env,
    30_000,
  );
  if (result.exitCode !== 0 && !/No such container/iu.test(`${result.stdout}\n${result.stderr}`)) {
    throw new Error(`Unable to remove runtime PostgreSQL container.\n${result.stderr}`);
  }
}

async function runMaven(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs = COMMAND_TIMEOUT_MS,
): Promise<CommandResult> {
  if (process.platform !== 'win32') {
    return runCommand('mvn', args, cwd, env, timeoutMs);
  }
  const command =
    process.env.ComSpec ?? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe');
  return runCommand(
    command,
    ['/d', '/s', '/c', ['mvn.cmd', ...args].map(quoteForCmd).join(' ')],
    cwd,
    env,
    timeoutMs,
  );
}

async function findPackagedJar(directory: string): Promise<string> {
  const target = join(directory, 'target');
  const jars = (await readdir(target)).filter(
    (name) => name.endsWith('.jar') && !name.startsWith('original-'),
  );
  if (jars.length !== 1 || !jars[0]) {
    throw new Error(
      `Expected exactly one packaged executable JAR, found: ${jars.join(', ') || 'none'}.`,
    );
  }
  return join(target, jars[0]);
}

function startApplication(
  javaHome: string,
  jar: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): RunningProcess {
  throwIfInterrupted();
  const child = spawn(javaExecutable(javaHome), ['-jar', jar], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached: process.platform !== 'win32',
  });
  let output = '';
  let error: Error | undefined;
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    output += chunk;
  });
  child.stderr?.on('data', (chunk: string) => {
    output += chunk;
  });
  child.once('error', (cause) => {
    error = cause;
  });
  activeChild = child;
  return { child, output: () => output, error: () => error };
}

async function waitForApplication(application: RunningProcess, path: string): Promise<number> {
  const deadline = Date.now() + APPLICATION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    throwIfInterrupted();
    if (application.error()) {
      throw new Error(
        `Generated Spring Boot application failed to start.\n${application.error()?.message}`,
      );
    }
    if (application.child.exitCode !== null) {
      throw new Error(
        `Generated Spring Boot application exited before readiness.\n${application.output()}`,
      );
    }
    const port = applicationPortFromOutput(application.output());
    if (port) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}${path}`, {
          signal: AbortSignal.timeout(2_000),
        });
        if (response.status === 200) return port;
      } catch {
        // The process is still starting or Flyway has not completed yet.
      }
    }
    await delay(500);
  }
  throw new Error(
    `Generated Spring Boot application did not become ready.\n${application.output()}`,
  );
}

function applicationPortFromOutput(output: string): number | undefined {
  const match = /Tomcat started on port (\d+)\b/u.exec(output);
  if (!match?.[1]) return undefined;
  const port = Number(match[1]);
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : undefined;
}

async function runNewman(
  collectionPath: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  baseUrl: string,
): Promise<CommandResult> {
  return runCommand(
    process.execPath,
    [
      require.resolve('newman/bin/newman.js'),
      'run',
      collectionPath,
      '--env-var',
      `baseUrl=${baseUrl}`,
      '--reporters',
      'cli',
    ],
    cwd,
    env,
    COMMAND_TIMEOUT_MS,
  );
}

async function runCommand(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<CommandResult> {
  if (!cleanupInProgress) throwIfInterrupted();
  const startedAt = performance.now();
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached: process.platform !== 'win32',
  });
  activeChild = child;
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const completed = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
    (resolveExit, rejectExit) => {
      child.once('error', rejectExit);
      child.once('exit', (exitCode, signal) => resolveExit({ exitCode, signal }));
    },
  );
  let timedOut = false;
  let timeout: NodeJS.Timeout | undefined;
  let termination: Promise<void> | undefined;
  const timeoutResult = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
    (resolveTimeout, rejectTimeout) => {
      timeout = setTimeout(() => {
        timedOut = true;
        termination = terminateProcessTree(child);
        void termination
          .then(() => resolveTimeout({ exitCode: null, signal: null }))
          .catch(rejectTimeout);
      }, timeoutMs);
    },
  );
  try {
    const result = await Promise.race([completed, timeoutResult]);
    if (timedOut && termination) await termination;
    return {
      command,
      args,
      elapsedMs: Math.round(performance.now() - startedAt),
      ...result,
      stdout,
      stderr,
      timedOut,
    };
  } finally {
    if (timeout) clearTimeout(timeout);
    if (termination) await termination;
    if (activeChild === child) {
      activeChild = undefined;
    }
  }
}

function assertSuccessful(result: CommandResult, label: string): void {
  if (result.exitCode === 0 && !result.timedOut) return;
  throw new Error(
    [
      `${label} failed${result.timedOut ? ' after timeout' : ''}.`,
      `Command: ${result.command} ${result.args.join(' ')}`,
      `Exit code: ${String(result.exitCode)}; signal: ${String(result.signal)}.`,
      'stdout:',
      result.stdout,
      'stderr:',
      result.stderr,
    ].join('\n'),
  );
}

function assertJdk21(result: CommandResult, javaHome: string): void {
  const output = `${result.stdout}\n${result.stderr}`;
  if (!/(?:version|Java version:)\s*["']?21(?:[.\s"']|$)/iu.test(output)) {
    throw new Error(`JDK 21 is required from JAVA_HOME=${javaHome}.\n${output}`);
  }
}

function quoteForCmd(value: string): string {
  if (!/[\s&|<>()^"%]/u.test(value)) return value;
  return `"${value.replaceAll('"', '""')}"`;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function readinessPath(model: RelationalModel): string {
  const table = model.tables
    .filter((candidate) => candidate.isAbstract !== true)
    .toSorted((left, right) => left.physicalName.localeCompare(right.physicalName))[0];
  if (!table) {
    throw new Error('Runtime fixture must expose at least one concrete table.');
  }
  return `/api/${table.physicalName.replaceAll('_', '-')}`;
}

function requiredDatabasePort(): number {
  if (databasePort === undefined) {
    throw new Error('Runtime PostgreSQL port is unavailable.');
  }
  return databasePort;
}

function requiredApplicationPort(): number {
  if (applicationPort === undefined) {
    throw new Error('Generated Spring Boot application port is unavailable.');
  }
  return applicationPort;
}

function throwIfInterrupted(): void {
  if (interrupted) throw interrupted;
}

async function writeReport(report: Partial<RuntimeReport>): Promise<void> {
  if (!reportPath) return;
  await mkdir(dirname(resolve(reportPath)), { recursive: true });
  await writeFile(resolve(reportPath), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
