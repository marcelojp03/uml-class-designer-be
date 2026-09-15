import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { ElementLock } from './collaboration.types';

interface StoredElementLock extends Omit<ElementLock, 'expiresAt'> {
  expiresAt: Date;
  timer: NodeJS.Timeout;
}

export interface ElementLockChange {
  documentId: string;
  locks: ElementLock[];
}

@Injectable()
export class CollaborationLockStore implements OnApplicationShutdown {
  private readonly locksByDocument = new Map<string, Map<string, StoredElementLock>>();
  private readonly lockKeysBySocket = new Map<string, Set<string>>();
  private readonly changes = new EventEmitter();

  acquire(input: {
    documentId: string;
    elementId: string;
    userId: string;
    socketId: string;
    ttlSeconds: number;
  }): { lock: ElementLock; locks: ElementLock[] } | null {
    this.expireDocument(input.documentId);
    const documentLocks = this.locksByDocument.get(input.documentId) ?? new Map();
    const existing = documentLocks.get(input.elementId);
    if (existing) {
      if (existing.userId !== input.userId || existing.socketId !== input.socketId) {
        return null;
      }
      this.renewStored(existing, input.ttlSeconds);
      this.emitChange(input.documentId);
      return { lock: this.toPublic(existing), locks: this.list(input.documentId) };
    }

    const expiresAt = new Date(Date.now() + input.ttlSeconds * 1000);
    const lock: StoredElementLock = {
      documentId: input.documentId,
      elementId: input.elementId,
      userId: input.userId,
      socketId: input.socketId,
      leaseId: randomUUID(),
      expiresAt,
      timer: this.createExpirationTimer(input.documentId, input.elementId, expiresAt),
    };
    documentLocks.set(input.elementId, lock);
    this.locksByDocument.set(input.documentId, documentLocks);
    const socketKeys = this.lockKeysBySocket.get(input.socketId) ?? new Set<string>();
    socketKeys.add(this.lockKey(input.documentId, input.elementId));
    this.lockKeysBySocket.set(input.socketId, socketKeys);
    this.emitChange(input.documentId);
    return { lock: this.toPublic(lock), locks: this.list(input.documentId) };
  }

  renew(input: {
    documentId: string;
    elementId: string;
    userId: string;
    socketId: string;
    leaseId: string;
    ttlSeconds: number;
  }): { lock: ElementLock; locks: ElementLock[] } | null {
    this.expireDocument(input.documentId);
    const lock = this.locksByDocument.get(input.documentId)?.get(input.elementId);
    if (
      !lock ||
      lock.userId !== input.userId ||
      lock.socketId !== input.socketId ||
      lock.leaseId !== input.leaseId
    ) {
      return null;
    }
    this.renewStored(lock, input.ttlSeconds);
    this.emitChange(input.documentId);
    return { lock: this.toPublic(lock), locks: this.list(input.documentId) };
  }

  release(input: {
    documentId: string;
    elementId: string;
    userId: string;
    socketId: string;
    leaseId: string;
  }): boolean {
    this.expireDocument(input.documentId);
    const lock = this.locksByDocument.get(input.documentId)?.get(input.elementId);
    if (
      !lock ||
      lock.userId !== input.userId ||
      lock.socketId !== input.socketId ||
      lock.leaseId !== input.leaseId
    ) {
      return false;
    }
    this.remove(lock);
    this.emitChange(input.documentId);
    return true;
  }

  releaseBySocket(socketId: string): void {
    const lockKeys = [...(this.lockKeysBySocket.get(socketId) ?? [])];
    const changedDocuments = new Set<string>();
    for (const lockKey of lockKeys) {
      const [documentId, elementId] = lockKey.split(':', 2);
      if (!documentId || !elementId) {
        continue;
      }
      const lock = this.locksByDocument.get(documentId)?.get(elementId);
      if (lock?.socketId === socketId) {
        this.remove(lock);
        changedDocuments.add(documentId);
      }
    }
    for (const documentId of changedDocuments) {
      this.emitChange(documentId);
    }
  }

  releaseBySocketInDocument(socketId: string, documentId: string): void {
    const lockKeys = [...(this.lockKeysBySocket.get(socketId) ?? [])];
    let changed = false;
    for (const lockKey of lockKeys) {
      const [lockDocumentId, elementId] = lockKey.split(':', 2);
      if (lockDocumentId !== documentId || !elementId) {
        continue;
      }
      const lock = this.locksByDocument.get(documentId)?.get(elementId);
      if (lock?.socketId === socketId) {
        this.remove(lock);
        changed = true;
      }
    }
    if (changed) {
      this.emitChange(documentId);
    }
  }

  hasLockOwnedByAnotherSocket(
    documentId: string,
    elementIds: Set<string>,
    socketId: string,
  ): boolean {
    this.expireDocument(documentId);
    const documentLocks = this.locksByDocument.get(documentId);
    if (!documentLocks) {
      return false;
    }
    return [...elementIds].some((elementId) => {
      const lock = documentLocks.get(elementId);
      return lock !== undefined && lock.socketId !== socketId;
    });
  }

  hasAnyLock(documentId: string, elementIds: Set<string>): boolean {
    this.expireDocument(documentId);
    const documentLocks = this.locksByDocument.get(documentId);
    if (!documentLocks) {
      return false;
    }
    return [...elementIds].some((elementId) => documentLocks.has(elementId));
  }

  reconcileDocumentElements(documentId: string, activeElementIds: Set<string>): void {
    this.expireDocument(documentId);
    const locks = this.locksByDocument.get(documentId);
    if (!locks) {
      return;
    }
    let changed = false;
    for (const lock of locks.values()) {
      if (!activeElementIds.has(lock.elementId)) {
        this.remove(lock);
        changed = true;
      }
    }
    if (changed) {
      this.emitChange(documentId);
    }
  }

  list(documentId: string): ElementLock[] {
    this.expireDocument(documentId);
    return [...(this.locksByDocument.get(documentId)?.values() ?? [])].map((lock) =>
      this.toPublic(lock),
    );
  }

  onChanged(listener: (change: ElementLockChange) => void): () => void {
    this.changes.on('changed', listener);
    return () => this.changes.off('changed', listener);
  }

  onApplicationShutdown(): void {
    for (const locks of this.locksByDocument.values()) {
      for (const lock of locks.values()) {
        clearTimeout(lock.timer);
      }
    }
    this.locksByDocument.clear();
    this.lockKeysBySocket.clear();
    this.changes.removeAllListeners();
  }

  private createExpirationTimer(
    documentId: string,
    elementId: string,
    expiresAt: Date,
  ): NodeJS.Timeout {
    const timer = setTimeout(
      () => {
        const lock = this.locksByDocument.get(documentId)?.get(elementId);
        if (!lock || lock.expiresAt.getTime() > Date.now()) {
          return;
        }
        this.remove(lock);
        this.emitChange(documentId);
      },
      Math.max(1, expiresAt.getTime() - Date.now()),
    );
    timer.unref();
    return timer;
  }

  private renewStored(lock: StoredElementLock, ttlSeconds: number): void {
    clearTimeout(lock.timer);
    lock.expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    lock.timer = this.createExpirationTimer(lock.documentId, lock.elementId, lock.expiresAt);
  }

  private expireDocument(documentId: string): void {
    const locks = this.locksByDocument.get(documentId);
    if (!locks) {
      return;
    }
    let changed = false;
    for (const lock of locks.values()) {
      if (lock.expiresAt.getTime() <= Date.now()) {
        this.remove(lock);
        changed = true;
      }
    }
    if (changed) {
      this.emitChange(documentId);
    }
  }

  private remove(lock: StoredElementLock): void {
    clearTimeout(lock.timer);
    const locks = this.locksByDocument.get(lock.documentId);
    locks?.delete(lock.elementId);
    if (locks?.size === 0) {
      this.locksByDocument.delete(lock.documentId);
    }
    const socketKeys = this.lockKeysBySocket.get(lock.socketId);
    socketKeys?.delete(this.lockKey(lock.documentId, lock.elementId));
    if (socketKeys?.size === 0) {
      this.lockKeysBySocket.delete(lock.socketId);
    }
  }

  private emitChange(documentId: string): void {
    this.changes.emit('changed', {
      documentId,
      locks: this.list(documentId),
    } satisfies ElementLockChange);
  }

  private lockKey(documentId: string, elementId: string): string {
    return `${documentId}:${elementId}`;
  }

  private toPublic(lock: StoredElementLock): ElementLock {
    return {
      documentId: lock.documentId,
      elementId: lock.elementId,
      userId: lock.userId,
      socketId: lock.socketId,
      leaseId: lock.leaseId,
      expiresAt: lock.expiresAt.toISOString(),
    };
  }
}
