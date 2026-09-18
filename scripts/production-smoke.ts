import { spawn, type ChildProcess } from 'node:child_process';

const baseUrl = 'http://127.0.0.1:3001';
const pnpmExecPath = process.env.npm_execpath;
const shutdownTimeoutMs = 10_000;

type ChildExit = { code: number | null; signal: NodeJS.Signals | null };

interface ProductionServer {
  child: ChildProcess;
  spawnError: Error | null;
  exit: ChildExit | null;
  exited: Promise<ChildExit>;
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', cwd: process.cwd(), env: process.env });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)),
    );
  });
}

function runPnpm(args: string[]): Promise<void> {
  if (!pnpmExecPath) throw new Error('npm_execpath is required to run pnpm safely.');
  return run(process.execPath, [pnpmExecPath, ...args]);
}

async function waitForHealth(
  server: ProductionServer,
  interrupted: () => Error | null,
): Promise<void> {
  for (let attempt = 0; attempt < 480; attempt += 1) {
    const interruption = interrupted();
    if (interruption) throw interruption;
    if (server.spawnError)
      throw new Error('Production process failed to spawn.', { cause: server.spawnError });
    if (server.exit) {
      throw new Error(
        `Production process exited before health check (${server.exit.code ?? server.exit.signal}).`,
      );
    }
    try {
      const response = await fetch(`${baseUrl}/health`);
      const body = (await response.json()) as { status?: string };
      if (response.ok && body.status === 'ok') {
        console.log('SMOKE health: 200 ok');
        return;
      }
    } catch (error: unknown) {
      if (error instanceof Error && /Production process|Interrupted/.test(error.message))
        throw error;
      // The production process can still be binding its port.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('The compiled backend did not expose /health.');
}

function startProductionServer(): ProductionServer {
  if (!pnpmExecPath) throw new Error('npm_execpath is required to run pnpm start safely.');
  const child = spawn(process.execPath, [pnpmExecPath, 'start'], {
    stdio: 'inherit',
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: 'test', PORT: '3001', CORS_ORIGINS: 'http://localhost:4173' },
  });
  const server: ProductionServer = {
    child,
    spawnError: null,
    exit: null,
    exited: Promise.resolve({ code: null, signal: null }),
  };
  server.exited = new Promise((resolve) => {
    child.once('error', (error) => {
      server.spawnError = error;
      resolve({ code: null, signal: null });
    });
    child.once('exit', (code, signal) => {
      server.exit = { code, signal };
      resolve(server.exit);
    });
  });
  return server;
}

async function waitForExit(server: ProductionServer): Promise<void> {
  if (server.exit || server.spawnError) return;
  await Promise.race([
    server.exited,
    new Promise<void>((_, reject) =>
      setTimeout(
        () => reject(new Error('Production process did not exit in time.')),
        shutdownTimeoutMs,
      ),
    ),
  ]);
}

async function stopProductionServer(server: ProductionServer | undefined): Promise<void> {
  if (!server || server.exit || server.spawnError) return;
  const pid = server.child.pid;
  if (!pid || !Number.isSafeInteger(pid) || pid <= 0)
    throw new Error('Production process has no valid PID.');
  if (process.platform === 'win32') {
    await run('taskkill.exe', ['/pid', String(pid), '/t', '/f']);
    await waitForExit(server);
    return;
  }
  if (!server.child.kill('SIGTERM'))
    throw new Error('Unable to send SIGTERM to production process.');
  try {
    await waitForExit(server);
  } catch {
    if (!server.child.kill('SIGKILL'))
      throw new Error('Unable to send SIGKILL to production process.');
    await waitForExit(server);
  }
}

async function main(): Promise<void> {
  let server: ProductionServer | undefined;
  let cleanupPromise: Promise<Error[]> | undefined;
  let cleanupRuns = 0;
  let interrupted: Error | null = null;
  const cleanup = () => {
    cleanupPromise ??= (async () => {
      cleanupRuns += 1;
      console.log(`SMOKE cleanup: ${cleanupRuns}`);
      const errors: Error[] = [];
      try {
        await stopProductionServer(server);
      } catch (error: unknown) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
      try {
        await runPnpm(['db:test:down']);
      } catch (error: unknown) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
      return errors;
    })();
    return cleanupPromise;
  };
  const onSignal = (signal: NodeJS.Signals) => {
    if (!interrupted) interrupted = new Error(`Interrupted by ${signal}.`);
  };
  const throwIfInterrupted = () => {
    if (interrupted) throw interrupted;
  };
  const runPreparation = async (args: string[]) => {
    await runPnpm(args);
    throwIfInterrupted();
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  let primaryError: unknown;
  try {
    await runPreparation(['db:test:down']);
    await runPreparation(['db:test:up']);
    const controlledSignal = process.env.SMOKE_SIGNAL_AFTER_DB_UP;
    if (controlledSignal === 'SIGINT' || controlledSignal === 'SIGTERM') onSignal(controlledSignal);
    throwIfInterrupted();
    await runPreparation(['db:test:migrate']);
    await runPreparation(['db:test:status']);
    await runPreparation(['prisma:generate']);
    await runPreparation(['build']);
    server = startProductionServer();
    throwIfInterrupted();
    await waitForHealth(server, () => interrupted);
    throwIfInterrupted();
    if (process.env.SMOKE_FAIL_AFTER_START === '1') throw new Error('Controlled smoke failure.');

    const email = `production-smoke-${Date.now()}@example.com`;
    const registration = await fetch(`${baseUrl}/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Auth-Intent': '1' },
      body: JSON.stringify({
        email,
        displayName: 'Production Smoke',
        password: 'Correct-Horse-Battery-2026',
      }),
    });
    throwIfInterrupted();
    if (!registration.ok) throw new Error(`Registration failed with ${registration.status}.`);
    console.log(`SMOKE registration: ${registration.status}`);
    await registration.json();
    const cookie = registration.headers.get('set-cookie');
    if (!cookie) throw new Error('Registration did not issue a refresh cookie.');
    const refresh = await fetch(`${baseUrl}/auth/refresh`, {
      method: 'POST',
      headers: { cookie, 'X-Auth-Intent': '1' },
    });
    throwIfInterrupted();
    if (!refresh.ok) throw new Error(`Refresh failed with ${refresh.status}.`);
    console.log(`SMOKE refresh: ${refresh.status}`);
    const refreshed = (await refresh.json()) as { accessToken?: unknown };
    if (typeof refreshed.accessToken !== 'string' || !refreshed.accessToken) {
      throw new Error('Refresh did not return a usable access token.');
    }
    const projects = await fetch(`${baseUrl}/projects`, {
      headers: { authorization: `Bearer ${refreshed.accessToken}` },
    });
    throwIfInterrupted();
    if (!projects.ok) throw new Error(`Protected request failed with ${projects.status}.`);
    if (!Array.isArray(await projects.json()))
      throw new Error('Protected projects response is not an array.');
    console.log(`SMOKE projects: ${projects.status}`);
  } catch (error: unknown) {
    primaryError = error;
  } finally {
    const cleanupErrors = await cleanup();
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    cleanupErrors.forEach((error) => console.error('Cleanup error:', error));
    if (!primaryError && cleanupErrors.length > 0)
      primaryError = new AggregateError(cleanupErrors, 'Smoke cleanup failed.');
  }
  if (primaryError) throw primaryError;
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
