import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { generateSpringBootProject } from '../src/modules/generation/spring-boot';
import {
  assertRelationalModelContract,
  type RelationalModel,
} from '../src/modules/generation/relational-model';

const fixtureNames = [
  '01-simple-crud.json',
  '02-composite-primary-key.json',
  '03-composite-foreign-key.json',
  '04-joined-inheritance-abstract.json',
  '05-unique-cascade.json',
  '06-uuid-pgcrypto.json',
  '07-json-and-advanced-types.json',
  '08-self-reference.json',
  '09-association-class.json',
] as const;

const repeatedFixtureNames = [
  '03-composite-foreign-key.json',
  '04-joined-inheritance-abstract.json',
  '06-uuid-pgcrypto.json',
] as const;

const mavenTimeoutMs = 300_000;
const terminationTimeoutMs = 10_000;
const fixtureDirectory = resolve(process.cwd(), 'contracts/fixtures/spring-boot');
const reportPath = process.env.SPRING_BOOT_VERIFY_REPORT;

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

interface FixtureResult {
  fixture: string;
  attempt: number;
  generatedFileCount: number;
  elapsedMs: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

interface VerificationReport {
  javaHome: string;
  mavenVersion: CommandResult | null;
  fixtureResults: FixtureResult[];
}

let activeChild: ChildProcess | undefined;
let activeTermination: Promise<void> | undefined;
let activeTerminationChild: ChildProcess | undefined;
let interrupted: Error | undefined;

async function main(): Promise<void> {
  const javaHome = requireJdk21Home();
  const onSignal = (signal: NodeJS.Signals) => {
    interrupted ??= new Error(`Interrupted by ${signal}.`);
    const termination = requestActiveChildTermination();
    void termination?.catch((error: unknown) => {
      interrupted ??= error instanceof Error ? error : new Error(String(error));
    });
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  const report: VerificationReport = {
    javaHome,
    mavenVersion: null,
    fixtureResults: [],
  };

  try {
    report.mavenVersion = await runMaven(['-v'], process.cwd());
    assertMavenUsesJdk21(report.mavenVersion, javaHome);
    for (const fixture of fixtureNames) {
      const result = await compileFixture(fixture, 1);
      report.fixtureResults.push(result);
      assertFixtureCompiled(result);
    }
    for (const fixture of repeatedFixtureNames) {
      for (let attempt = 2; attempt <= 3; attempt += 1) {
        const result = await compileFixture(fixture, attempt);
        report.fixtureResults.push(result);
        assertFixtureCompiled(result);
      }
    }
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    if (reportPath) {
      await mkdir(dirname(resolve(reportPath)), { recursive: true });
      await writeFile(resolve(reportPath), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    }
  }

  throwIfInterrupted();
  console.log(`Maven JDK 21 verification passed for ${report.fixtureResults.length} fixture runs.`);
}

async function compileFixture(
  fixture: (typeof fixtureNames)[number],
  attempt: number,
): Promise<FixtureResult> {
  throwIfInterrupted();
  const model = await loadFixture(fixture);
  const project = generateSpringBootProject(model);
  const directory = await mkdtemp(join(tmpdir(), 'uml-spring-boot-'));

  try {
    for (const file of project.files) {
      const destination = resolve(directory, file.path);
      const relativeDestination = relative(directory, destination);
      if (
        !relativeDestination ||
        relativeDestination.startsWith('..') ||
        isAbsolute(relativeDestination)
      ) {
        throw new Error(`Generated path escaped temporary directory: ${file.path}.`);
      }
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, file.content, 'utf8');
    }

    const result = await runMaven(['--batch-mode', '-DskipTests', 'package'], directory);
    const fixtureResult: FixtureResult = {
      fixture,
      attempt,
      generatedFileCount: project.files.length,
      elapsedMs: result.elapsedMs,
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      stdout: result.stdout,
      stderr: result.stderr,
    };
    if (result.exitCode === 0 && !result.timedOut) {
      console.log(
        `Maven fixture ${fixture} attempt ${attempt}: PASS in ${result.elapsedMs} ms (${project.files.length} files).`,
      );
    }
    return fixtureResult;
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

async function loadFixture(name: string): Promise<RelationalModel> {
  const value = JSON.parse(await readFile(resolve(fixtureDirectory, name), 'utf8')) as unknown;
  assertRelationalModelContract(value);
  return value;
}

async function runMaven(args: string[], cwd: string): Promise<CommandResult> {
  throwIfInterrupted();
  const invocation = mavenInvocation(args);
  const startedAt = performance.now();
  const result = await runCommand(invocation.command, invocation.args, cwd, mavenTimeoutMs);
  result.elapsedMs = Math.round(performance.now() - startedAt);
  return result;
}

function mavenInvocation(args: string[]): { command: string; args: string[] } {
  if (process.platform !== 'win32') {
    return { command: 'mvn', args };
  }
  const command =
    process.env.ComSpec ?? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe');
  const commandLine = ['mvn.cmd', ...args].map(quoteForCmd).join(' ');
  return { command, args: ['/d', '/s', '/c', commandLine] };
}

function quoteForCmd(value: string): string {
  if (!/[\s&|<>()^"%]/u.test(value)) {
    return value;
  }
  return `"${value.replaceAll('"', '""')}"`;
}

async function runCommand(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<CommandResult> {
  let timedOut = false;
  const child = spawn(command, args, {
    cwd,
    env: process.env,
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

  let timeout: NodeJS.Timeout | undefined;
  let termination: Promise<void> | undefined;
  try {
    const exited = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
      (resolveExit, reject) => {
        child.once('error', reject);
        child.once('exit', (exitCode, signal) => resolveExit({ exitCode, signal }));
      },
    );
    const timeoutExit = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
      (resolveExit, rejectExit) => {
        timeout = setTimeout(() => {
          timedOut = true;
          termination = requestProcessTermination(child);
          void termination
            .then(() => resolveExit({ exitCode: null, signal: null }))
            .catch(rejectExit);
        }, timeoutMs);
      },
    );
    const exit = await Promise.race([exited, timeoutExit]);
    if (timedOut) {
      await awaitTerminationBeforeCleanup(termination);
    }
    return { command, args, elapsedMs: 0, ...exit, stdout, stderr, timedOut };
  } finally {
    if (timeout) clearTimeout(timeout);
    await awaitTrackedProcessTermination(child);
    if (activeChild === child) {
      activeChild = undefined;
    }
  }
}

export async function awaitTerminationBeforeCleanup(
  termination: Promise<void> | undefined,
): Promise<void> {
  if (termination) {
    await termination;
  }
}

function requestActiveChildTermination(): Promise<void> | undefined {
  return activeChild ? requestProcessTermination(activeChild) : undefined;
}

function requestProcessTermination(child: ChildProcess): Promise<void> {
  if (activeTerminationChild === child && activeTermination) {
    return activeTermination;
  }
  const termination = terminateProcessTree(child);
  activeTerminationChild = child;
  activeTermination = termination;
  return termination;
}

async function awaitTrackedProcessTermination(child: ChildProcess): Promise<void> {
  if (activeTerminationChild !== child || !activeTermination) return;
  const termination = activeTermination;
  try {
    await awaitTerminationBeforeCleanup(termination);
  } finally {
    if (activeTerminationChild === child && activeTermination === termination) {
      activeTerminationChild = undefined;
      activeTermination = undefined;
    }
  }
}

export async function terminateProcessTree(
  child: ChildProcess | undefined,
  timeoutMs = terminationTimeoutMs,
): Promise<void> {
  const pid = child?.pid;
  if (!pid || !Number.isSafeInteger(pid) || pid <= 0 || child.exitCode !== null) {
    return;
  }
  if (process.platform === 'win32') {
    try {
      await new Promise<void>((resolveTerminate, rejectTerminate) => {
        const taskkill = spawn('taskkill.exe', ['/pid', String(pid), '/t', '/f'], {
          stdio: 'ignore',
          windowsHide: true,
        });
        let settled = false;
        let timeout: NodeJS.Timeout | undefined;
        const complete = (error?: Error) => {
          if (settled) return;
          settled = true;
          if (timeout) clearTimeout(timeout);
          if (error) {
            rejectTerminate(error);
          } else {
            resolveTerminate();
          }
        };
        timeout = setTimeout(() => {
          taskkill.kill();
          complete(new Error(`taskkill.exe timed out while terminating Maven process ${pid}.`));
        }, timeoutMs);
        taskkill.once('error', (error) => {
          complete(new Error(`taskkill.exe failed for Maven process ${pid}: ${error.message}`));
        });
        taskkill.once('exit', (exitCode, signal) => {
          if (exitCode === 0) {
            complete();
            return;
          }
          complete(
            new Error(
              `taskkill.exe failed for Maven process ${pid} with exit code ${String(exitCode)} and signal ${String(signal)}.`,
            ),
          );
        });
      });
    } catch (error) {
      if (await waitForProcessExit(child, timeoutMs)) return;
      throw error;
    }
    if (!(await waitForProcessExit(child, timeoutMs))) {
      throw new Error(`Maven process ${pid} did not exit after taskkill.exe completed.`);
    }
    return;
  }
  signalProcessGroup(child, pid, 'SIGTERM');
  if (await waitForProcessGroupExit(pid, timeoutMs)) return;
  signalProcessGroup(child, pid, 'SIGKILL');
  if (!(await waitForProcessGroupExit(pid, timeoutMs))) {
    throw new Error(`Maven process group ${pid} did not exit after SIGKILL.`);
  }
}

function signalProcessGroup(child: ChildProcess, pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    child.kill(signal);
  }
}

async function waitForProcessGroupExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (processGroupExists(pid)) {
    const remainingMs = deadline - performance.now();
    if (remainingMs <= 0) return false;
    await new Promise<void>((resolveDelay) => {
      setTimeout(resolveDelay, Math.min(100, remainingMs));
    });
  }
  return true;
}

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function waitForProcessExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolveExit) => {
    let timeout: NodeJS.Timeout | undefined;
    function complete(exited: boolean): void {
      if (timeout) clearTimeout(timeout);
      child.removeListener('exit', onExit);
      child.removeListener('error', onError);
      resolveExit(exited);
    }
    function onExit(): void {
      complete(true);
    }
    function onError(): void {
      complete(true);
    }
    timeout = setTimeout(() => complete(false), timeoutMs);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

function requireJdk21Home(): string {
  const javaHome = process.env.JAVA_HOME;
  if (!javaHome) {
    throw new Error('JAVA_HOME must explicitly point to a JDK 21 installation.');
  }
  return javaHome;
}

function assertMavenUsesJdk21(result: CommandResult, javaHome: string): void {
  if (result.exitCode !== 0 || result.timedOut) {
    throw new Error(`Unable to inspect Maven version.\n${result.stdout}\n${result.stderr}`);
  }
  const output = `${result.stdout}\n${result.stderr}`;
  if (!/Java version:\s*21(?:[.\s]|$)/iu.test(output)) {
    throw new Error(`Maven must run with JDK 21 from JAVA_HOME=${javaHome}.\n${output}`);
  }
}

function assertFixtureCompiled(fixture: FixtureResult): void {
  if (fixture.exitCode === 0 && !fixture.timedOut) {
    return;
  }
  const timeout = fixture.timedOut ? ` timed out after ${mavenTimeoutMs} ms` : '';
  throw new Error(
    [
      `Maven compilation failed for ${fixture.fixture} attempt ${fixture.attempt}${timeout}.`,
      `Exit code: ${String(fixture.exitCode)}; signal: ${String(fixture.signal)}.`,
      'stdout:',
      fixture.stdout,
      'stderr:',
      fixture.stderr,
    ].join('\n'),
  );
}

function throwIfInterrupted(): void {
  if (interrupted) {
    throw interrupted;
  }
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
