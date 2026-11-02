'use strict';

// Locking and open-index reads for QuestionsStore. The store keeps wrappers so
// callers and subclasses see the same methods.

  /**
   * Serialise a read-modify-write on one key. Waiters queue on a gate that is
   * released in `finally`, so a throwing critical section cannot wedge the queue.
   */
export async function withQuestionLock(store, key, fn) {
    let previous = store.locks.get(key) || Promise.resolve();
    let release = null;
    let gate = new Promise((resolve) => { release = resolve; });
    let chained = previous.then(() => gate);
    store.locks.set(key, chained);

    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (store.locks.get(key) === chained)
        store.locks.delete(key);
    }
  }

export async function readOpenQuestionIndex(store) {
    try {
      let index = await store.aeordb.getFile(store.indexPath());
      return {
        ids: Array.isArray(index?.ids) ? index.ids.filter((id) => typeof id === 'string') : [],
        summaries: Array.isArray(index?.summaries) ? index.summaries : [],
        updatedAt: index?.updatedAt || null,
      };
    } catch (error) {
      if (error.status !== 404)
        throw error;

      return { ids: [], summaries: [], updatedAt: null };
    }
  }
