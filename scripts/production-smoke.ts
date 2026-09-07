import { spawn, type ChildProcess } from 'node:child_process';

const baseUrl = 'http://localhost:3001';
const pnpmExecPath = process.env.npm_execpath;

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

async function waitForHealth(server: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    try {
      if (server.exitCode !== null)
        throw new Error(`Production process exited ${server.exitCode}.`);
      const response = await fetch(`${baseUrl}/health`);
      const body = (await response.json()) as { status?: string };
      if (response.ok && body.status === 'ok') {
        console.log('SMOKE health: 200 ok');
        return;
      }
    } catch {
      // The production process can still be binding its port.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('The compiled backend did not expose /health.');
}

async function main(): Promise<void> {
  let server: ChildProcess | undefined;
  try {
    await runPnpm(['db:test:down']);
    await runPnpm(['db:test:up']);
    await runPnpm(['db:test:migrate']);
    await runPnpm(['db:test:status']);
    await runPnpm(['prisma:generate']);
    await runPnpm(['build']);
    if (!pnpmExecPath) throw new Error('npm_execpath is required to run pnpm start safely.');
    server = spawn(process.execPath, [pnpmExecPath, 'start'], {
      stdio: 'inherit',
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: 'test',
        PORT: '3001',
        CORS_ORIGINS: 'http://localhost:4173',
      },
    });
    await waitForHealth(server);
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
    if (!registration.ok) throw new Error(`Registration failed with ${registration.status}.`);
    console.log(`SMOKE registration: ${registration.status}`);
    const { accessToken } = (await registration.json()) as { accessToken: string };
    const cookie = registration.headers.get('set-cookie');
    if (!cookie) throw new Error('Registration did not issue a refresh cookie.');
    const refresh = await fetch(`${baseUrl}/auth/refresh`, {
      method: 'POST',
      headers: { cookie, 'X-Auth-Intent': '1' },
    });
    if (!refresh.ok) throw new Error(`Refresh failed with ${refresh.status}.`);
    console.log(`SMOKE refresh: ${refresh.status}`);
    const projects = await fetch(`${baseUrl}/projects`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!projects.ok) throw new Error(`Protected request failed with ${projects.status}.`);
    console.log(`SMOKE projects: ${projects.status}`);
  } finally {
    if (server?.pid) {
      if (process.platform === 'win32')
        await run('taskkill.exe', ['/pid', String(server.pid), '/t', '/f']);
      else server.kill('SIGTERM');
    }
    await runPnpm(['db:test:down']);
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
