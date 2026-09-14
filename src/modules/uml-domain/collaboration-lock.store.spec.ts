import { CollaborationLockStore } from './collaboration-lock.store';

describe('CollaborationLockStore', () => {
  it('expires a lease automatically after its TTL', async () => {
    const store = new CollaborationLockStore();
    try {
      const acquired = store.acquire({
        documentId: 'd1',
        elementId: 'person',
        userId: 'u1',
        socketId: 's1',
        ttlSeconds: 1,
      });
      expect(acquired).not.toBeNull();
      expect(store.list('d1')).toHaveLength(1);

      await new Promise((resolve) => setTimeout(resolve, 1_200));

      expect(store.list('d1')).toHaveLength(0);
      const reacquired = store.acquire({
        documentId: 'd1',
        elementId: 'person',
        userId: 'u2',
        socketId: 's2',
        ttlSeconds: 30,
      });
      expect(reacquired).not.toBeNull();
    } finally {
      store.onApplicationShutdown();
    }
  });

  it('releases all locks held by a disconnected socket', () => {
    const store = new CollaborationLockStore();
    try {
      store.acquire({
        documentId: 'd1',
        elementId: 'person',
        userId: 'u1',
        socketId: 's1',
        ttlSeconds: 30,
      });
      store.releaseBySocket('s1');
      expect(store.list('d1')).toHaveLength(0);
    } finally {
      store.onApplicationShutdown();
    }
  });
});
