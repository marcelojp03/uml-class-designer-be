import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { EventEmitter } from 'node:events';

export type ProjectCollaborationChange =
  | {
      type: 'member-granted';
      projectId: string;
      userId: string;
    }
  | {
      type: 'member-removed';
      projectId: string;
      userId: string;
      documentIds: string[];
    }
  | {
      type: 'project-deleted';
      projectId: string;
      documentIds: string[];
    };

@Injectable()
export class ProjectCollaborationEventBus implements OnApplicationShutdown {
  private readonly changes = new EventEmitter();

  publish(change: ProjectCollaborationChange): void {
    this.changes.emit('changed', change);
  }

  onChanged(listener: (change: ProjectCollaborationChange) => void): () => void {
    this.changes.on('changed', listener);
    return () => this.changes.off('changed', listener);
  }

  onApplicationShutdown(): void {
    this.changes.removeAllListeners();
  }
}
