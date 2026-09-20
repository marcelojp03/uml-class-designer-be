import { spawn, type ChildProcess } from 'node:child_process';
import {
  awaitTerminationBeforeCleanup,
  terminateProcessTree,
} from './verify-spring-boot-generation';

const itOnPosix = process.platform === 'win32' ? it.skip : it;

describe('Spring Boot Maven verification cleanup', () => {
  it('waits for signal-triggered cleanup before removing a temporary project', async () => {
    let resolveTermination: (() => void) | undefined;
    const termination = new Promise<void>((resolve) => {
      resolveTermination = resolve;
    });
    let completed = false;
    const waitForCleanup = awaitTerminationBeforeCleanup(termination).then(() => {
      completed = true;
    });

    await Promise.resolve();
    expect(completed).toBe(false);
    resolveTermination?.();
    await waitForCleanup;
    expect(completed).toBe(true);
  });

  itOnPosix('force-kills a descendant that survives the parent SIGTERM', async () => {
    const parent = spawn(
      process.execPath,
      [
        '-e',
        [
          "const { spawn } = require('node:child_process');",
          "const child = spawn(process.execPath, ['-e', 'process.on(\"SIGTERM\", () => {}); setInterval(() => {}, 1000);'], { stdio: 'ignore' });",
          'process.stdout.write(String(child.pid) + "\\n");',
          'setInterval(() => {}, 1000);',
        ].join(' '),
      ],
      { detached: true, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    let descendantPid: number | undefined;
    try {
      descendantPid = await waitForDescendantPid(parent);
      await terminateProcessTree(parent, 500);
      const terminatedDescendantPid = descendantPid;
      if (!terminatedDescendantPid) throw new Error('Expected descendant PID.');
      expect(() => process.kill(terminatedDescendantPid, 0)).toThrow();
    } finally {
      if (parent.pid) {
        try {
          process.kill(-parent.pid, 'SIGKILL');
        } catch {
          // The process group was already terminated by the assertion path.
        }
      }
      if (descendantPid) {
        try {
          process.kill(descendantPid, 'SIGKILL');
        } catch {
          // The descendant was already terminated by the assertion path.
        }
      }
    }
  });
});

function waitForDescendantPid(parent: ChildProcess): Promise<number> {
  const stdout = parent.stdout;
  if (!stdout) {
    return Promise.reject(new Error('Expected parent process stdout.'));
  }
  const readable = stdout;
  readable.setEncoding('utf8');
  return new Promise((resolvePid, rejectPid) => {
    const timeout = setTimeout(
      () => complete(new Error('Timed out waiting for descendant PID.')),
      1_000,
    );
    const onData = (chunk: string) => {
      const pid = Number(chunk.trim());
      if (!Number.isSafeInteger(pid) || pid <= 0) {
        complete(new Error(`Invalid descendant PID: ${chunk}.`));
        return;
      }
      complete(undefined, pid);
    };
    const onError = (error: Error) => complete(error);
    function complete(error?: Error, pid?: number): void {
      clearTimeout(timeout);
      readable.removeListener('data', onData);
      parent.removeListener('error', onError);
      if (error) {
        rejectPid(error);
      } else if (pid !== undefined) {
        resolvePid(pid);
      }
    }
    readable.once('data', onData);
    parent.once('error', onError);
  });
}
