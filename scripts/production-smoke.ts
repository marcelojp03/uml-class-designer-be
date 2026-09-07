import { spawn } from 'node:child_process';

const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const baseUrl = 'http://localhost:3001';

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', shell: process.platform === 'win32' });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`))));
  });
}

async function waitForHealth(): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // The production process can still be binding its port.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('The compiled backend did not expose /health.');
}

async function main(): Promise<void> {
  let server: ReturnType<typeof spawn> | undefined;
  try {
    await run(pnpm, ['db:test:up']);
    await run(pnpm, ['db:test:migrate']);
    await run(pnpm, ['prisma:generate']);
    await run(pnpm, ['build']);
    server = spawn(pnpm, ['start'], {
      stdio: 'inherit',
      shell: process.platform === 'win32',
      env: { ...process.env, NODE_ENV: 'test', PORT: '3001', CORS_ORIGINS: 'http://localhost:4173' },
    });
    await waitForHealth();

    const email = `production-smoke-${Date.now()}@example.com`;
    const registration = await fetch(`${baseUrl}/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Auth-Intent': '1' },
      body: JSON.stringify({ email, displayName: 'Production Smoke', password: 'Correct-Horse-Battery-2026' }),
    });
    if (!registration.ok) throw new Error(`Registration failed with ${registration.status}.`);
    const { accessToken } = (await registration.json()) as { accessToken: string };
    const projects = await fetch(`${baseUrl}/projects`, { headers: { authorization: `Bearer ${accessToken}` } });
    if (!projects.ok) throw new Error(`Protected request failed with ${projects.status}.`);
  } finally {
    if (server?.pid) {
      if (process.platform === 'win32') await run('taskkill', ['/pid', String(server.pid), '/t', '/f']);
      else server.kill('SIGTERM');
    }
    await run(pnpm, ['db:test:down']);
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
