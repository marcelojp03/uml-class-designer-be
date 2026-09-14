import type { ConfigService } from '@nestjs/config';
import {
  DocumentMutationQueueOverloadedError,
  DocumentMutationQueueService,
} from './document-mutation-queue.service';

function queueWithCapacity(maxPendingMutationsPerDocument: number): DocumentMutationQueueService {
  return new DocumentMutationQueueService({
    getOrThrow: () => ({ collaboration: { maxPendingMutationsPerDocument } }),
  } as unknown as ConfigService);
}

describe('DocumentMutationQueueService', () => {
  it('bounds pending work per document and releases capacity after completion', async () => {
    const queue = queueWithCapacity(2);
    let release!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const first = queue.run('document-1', async () => {
      markStarted();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return 'first';
    });

    await started;
    await expect(queue.run('document-1', () => 'second')).rejects.toBeInstanceOf(
      DocumentMutationQueueOverloadedError,
    );
    const critical = queue.runCritical('document-1', () => 'critical');
    await expect(queue.runCritical('document-1', () => 'another critical')).rejects.toBeInstanceOf(
      DocumentMutationQueueOverloadedError,
    );
    release();
    await expect(first).resolves.toBe('first');
    await expect(critical).resolves.toBe('critical');
    await expect(queue.run('document-1', () => 'second')).resolves.toBe('second');
  });
});
