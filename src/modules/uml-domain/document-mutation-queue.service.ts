import { Injectable, OnApplicationShutdown } from '@nestjs/common';

@Injectable()
export class DocumentMutationQueueService implements OnApplicationShutdown {
  private readonly tails = new Map<string, Promise<void>>();

  async run<Result>(
    documentId: string,
    operation: () => Promise<Result> | Result,
  ): Promise<Result> {
    const previous = this.tails.get(documentId) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => current);
    this.tails.set(documentId, tail);

    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release?.();
      if (this.tails.get(documentId) === tail) {
        this.tails.delete(documentId);
      }
    }
  }

  onApplicationShutdown(): void {
    this.tails.clear();
  }
}
