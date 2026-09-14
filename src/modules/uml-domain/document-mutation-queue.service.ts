import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfiguration } from '../../config/app.config';

export class DocumentMutationQueueOverloadedError extends Error {
  constructor() {
    super('The document mutation queue is full.');
    this.name = 'DocumentMutationQueueOverloadedError';
  }
}

@Injectable()
export class DocumentMutationQueueService implements OnApplicationShutdown {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly pendingByDocument = new Map<string, number>();

  constructor(private readonly configService: ConfigService) {}

  async run<Result>(
    documentId: string,
    operation: () => Promise<Result> | Result,
  ): Promise<Result> {
    return this.enqueue(documentId, operation, 'standard');
  }

  async runCritical<Result>(
    documentId: string,
    operation: () => Promise<Result> | Result,
  ): Promise<Result> {
    return this.enqueue(documentId, operation, 'critical');
  }

  private async enqueue<Result>(
    documentId: string,
    operation: () => Promise<Result> | Result,
    priority: 'standard' | 'critical',
  ): Promise<Result> {
    const pending = this.pendingByDocument.get(documentId) ?? 0;
    const capacity = this.maxPendingMutationsPerDocument();
    const standardCapacity = Math.max(1, capacity - 1);
    if (
      (priority === 'standard' && pending >= standardCapacity) ||
      (priority === 'critical' && pending >= capacity)
    ) {
      throw new DocumentMutationQueueOverloadedError();
    }
    this.pendingByDocument.set(documentId, pending + 1);
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
      const remaining = (this.pendingByDocument.get(documentId) ?? 1) - 1;
      if (remaining > 0) {
        this.pendingByDocument.set(documentId, remaining);
      } else {
        this.pendingByDocument.delete(documentId);
      }
    }
  }

  onApplicationShutdown(): void {
    this.tails.clear();
    this.pendingByDocument.clear();
  }

  private maxPendingMutationsPerDocument(): number {
    return this.configService.getOrThrow<AppConfiguration>('app').collaboration
      .maxPendingMutationsPerDocument;
  }
}
