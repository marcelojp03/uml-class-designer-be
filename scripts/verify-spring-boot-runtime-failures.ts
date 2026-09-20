import { spawn } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';

const FAILURE_MODES = [
  'occupied-port',
  'postgres-unavailable',
  'jar-startup',
  'newman-request',
  'interrupt',
] as const;
const RUNTIME_CONTAINER_LABEL = 'uml-class-designer.runtime=spring-boot-runtime';
const RUNTIME_TEMPORARY_DIRECTORY_PREFIX = 'uml-spring-boot-runtime-';
const reportPath = process.env.SPRING_BOOT_RUNTIME_FAILURE_REPORT;

interface CommandResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  output: string;
}

interface FailureResult {
  mode: (typeof FAILURE_MODES)[number];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  expectedFailure: string;
  cleanupVerified: boolean;
}

const expectedFailures: Record<(typeof FAILURE_MODES)[number], string> = {
  'occupied-port': 'Runtime PostgreSQL startup failed.',
  'postgres-unavailable': 'Controlled runtime failure: PostgreSQL is unavailable.',
  'jar-startup': 'Generated Spring Boot application',
  'newman-request': 'Generated Newman collection failed.',
  interrupt: 'Runtime verification interrupted by SIGINT.',
};

async function main(): Promise<void> {
  const results: FailureResult[] = [];
  let primaryError: unknown;
  try {
    for (const mode of FAILURE_MODES) {
      const result = await runRuntimeFailure(mode);
      const expectedFailure = expectedFailures[mode];
      if (result.exitCode === 0 || !result.output.includes(expectedFailure)) {
        throw new Error(
          `Failure mode ${mode} did not fail as expected.\n${result.output.slice(-4_000)}`,
        );
      }
      await assertNoOwnedContainers();
      await assertNoRuntimeTemporaryDirectories();
      results.push({
        mode,
        exitCode: result.exitCode,
        signal: result.signal,
        expectedFailure,
        cleanupVerified: true,
      });
      console.log(`Controlled runtime failure ${mode}: PASS cleanup verified.`);
    }
  } catch (error: unknown) {
    primaryError = error;
  } finally {
    if (reportPath) {
      await mkdir(dirname(resolve(reportPath)), { recursive: true });
      await writeFile(resolve(reportPath), `${JSON.stringify({ results }, null, 2)}\n`, 'utf8');
    }
  }
  if (primaryError) throw primaryError;
  console.log(`Controlled runtime failures passed for ${results.length} scenarios.`);
}

async function runRuntimeFailure(mode: (typeof FAILURE_MODES)[number]): Promise<CommandResult> {
  const {
    SPRING_BOOT_RUNTIME_FAILURE_REPORT: _,
    SPRING_BOOT_RUNTIME_REPORT: __,
    ...env
  } = process.env;
  return runCommand(
    process.execPath,
    ['-r', 'ts-node/register', 'scripts/spring-boot-runtime.ts'],
    {
      ...env,
      SPRING_BOOT_RUNTIME_FAILURE_MODE: mode,
    },
  );
}

async function assertNoOwnedContainers(): Promise<void> {
  const result = await runCommand(
    'docker',
    ['container', 'ls', '--all', '--quiet', '--filter', `label=${RUNTIME_CONTAINER_LABEL}`],
    process.env,
  );
  if (result.exitCode !== 0) {
    throw new Error(`Unable to validate runtime Docker cleanup.\n${result.output}`);
  }
  if (result.output.trim()) {
    throw new Error(`Runtime containers remain after controlled failure: ${result.output.trim()}`);
  }
}

async function assertNoRuntimeTemporaryDirectories(): Promise<void> {
  const entries = await readdir(tmpdir());
  const leftovers = entries.filter((entry) => entry.startsWith(RUNTIME_TEMPORARY_DIRECTORY_PREFIX));
  if (leftovers.length > 0) {
    throw new Error(`Runtime temporary directories remain: ${leftovers.join(', ')}.`);
  }
}

function runCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<CommandResult> {
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let output = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      output += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      output += chunk;
    });
    child.once('error', rejectResult);
    child.once('exit', (exitCode, signal) => resolveResult({ exitCode, signal, output }));
  });
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
