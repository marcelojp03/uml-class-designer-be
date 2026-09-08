import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { EventEmitter } from 'node:events';

export type DocumentCollaborationChange =
  | {
      type: 'resync-required';
      documentId: string;
      revision: number;
      activeElementIds: string[];
    }
  | { type: 'deleted'; documentId: string };

@Injectable()
export class DocumentCollaborationEventBus implements OnApplicationShutdown {
  private readonly changes = new EventEmitter();

  publish(change: DocumentCollaborationChange): void {
    this.changes.emit('changed', change);
  }

  onChanged(listener: (change: DocumentCollaborationChange) => void): () => void {
    this.changes.on('changed', listener);
    return () => this.changes.off('changed', listener);
  }

  onApplicationShutdown(): void {
    this.changes.removeAllListeners();
  }
}
