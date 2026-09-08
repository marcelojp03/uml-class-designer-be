import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import type { CollaborationParticipant } from './collaboration.types';

interface StoredParticipant extends CollaborationParticipant {
  lastPresenceUpdateAt: number;
}

export interface PresenceChange {
  documentId: string;
  participants: CollaborationParticipant[];
}

@Injectable()
export class CollaborationPresenceStore implements OnApplicationShutdown {
  private readonly participantsByDocument = new Map<string, Map<string, StoredParticipant>>();
  private readonly documentIdsBySocket = new Map<string, Set<string>>();
  private readonly changes = new EventEmitter();

  join(input: {
    documentId: string;
    userId: string;
    socketId: string;
    maxParticipants: number;
  }): CollaborationParticipant[] | null {
    const participants = this.participantsByDocument.get(input.documentId) ?? new Map();
    const existing = participants.get(input.socketId);
    if (!existing && participants.size >= input.maxParticipants) {
      return null;
    }

    const now = new Date();
    const participant: StoredParticipant = existing ?? {
      userId: input.userId,
      socketId: input.socketId,
      joinedAt: now.toISOString(),
      lastSeen: now.toISOString(),
      lastPresenceUpdateAt: 0,
    };
    participant.lastSeen = now.toISOString();
    participants.set(input.socketId, participant);
    this.participantsByDocument.set(input.documentId, participants);
    const documentIds = this.documentIdsBySocket.get(input.socketId) ?? new Set<string>();
    documentIds.add(input.documentId);
    this.documentIdsBySocket.set(input.socketId, documentIds);
    const publicParticipants = this.list(input.documentId);
    this.emitChange(input.documentId, publicParticipants);
    return publicParticipants;
  }

  update(
    documentId: string,
    socketId: string,
    update: Pick<CollaborationParticipant, 'selection' | 'cursor'>,
    minimumIntervalMs: number,
  ): CollaborationParticipant[] | 'RATE_LIMITED' | null {
    const participant = this.participantsByDocument.get(documentId)?.get(socketId);
    if (!participant) {
      return null;
    }
    const now = Date.now();
    if (now - participant.lastPresenceUpdateAt < minimumIntervalMs) {
      return 'RATE_LIMITED';
    }
    participant.lastPresenceUpdateAt = now;
    participant.lastSeen = new Date(now).toISOString();
    if (update.selection !== undefined) {
      participant.selection = [...update.selection];
    }
    if (update.cursor !== undefined) {
      participant.cursor = { ...update.cursor };
    }
    const participants = this.list(documentId);
    this.emitChange(documentId, participants);
    return participants;
  }

  touch(documentId: string, socketId: string): void {
    const participant = this.participantsByDocument.get(documentId)?.get(socketId);
    if (participant) {
      participant.lastSeen = new Date().toISOString();
    }
  }

  leave(documentId: string, socketId: string): CollaborationParticipant[] | null {
    const participants = this.participantsByDocument.get(documentId);
    if (!participants?.delete(socketId)) {
      return null;
    }
    if (participants.size === 0) {
      this.participantsByDocument.delete(documentId);
    }
    const documentIds = this.documentIdsBySocket.get(socketId);
    documentIds?.delete(documentId);
    if (documentIds?.size === 0) {
      this.documentIdsBySocket.delete(socketId);
    }
    const publicParticipants = this.list(documentId);
    this.emitChange(documentId, publicParticipants);
    return publicParticipants;
  }

  leaveBySocket(socketId: string): PresenceChange[] {
    const documentIds = [...(this.documentIdsBySocket.get(socketId) ?? [])];
    const changes: PresenceChange[] = [];
    for (const documentId of documentIds) {
      const participants = this.leave(documentId, socketId);
      if (participants) {
        changes.push({ documentId, participants });
      }
    }
    return changes;
  }

  list(documentId: string): CollaborationParticipant[] {
    return [...(this.participantsByDocument.get(documentId)?.values() ?? [])].map(
      ({ lastPresenceUpdateAt: _lastPresenceUpdateAt, ...participant }) => ({
        ...participant,
        selection: participant.selection ? [...participant.selection] : undefined,
        cursor: participant.cursor ? { ...participant.cursor } : undefined,
      }),
    );
  }

  onChanged(listener: (change: PresenceChange) => void): () => void {
    this.changes.on('changed', listener);
    return () => this.changes.off('changed', listener);
  }

  onApplicationShutdown(): void {
    this.participantsByDocument.clear();
    this.documentIdsBySocket.clear();
    this.changes.removeAllListeners();
  }

  private emitChange(documentId: string, participants: CollaborationParticipant[]): void {
    this.changes.emit('changed', { documentId, participants } satisfies PresenceChange);
  }
}
