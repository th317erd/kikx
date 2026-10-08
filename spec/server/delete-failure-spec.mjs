'use strict';

// S4: delete failures. A failed soft delete must surface as a 500 and must not
// emit a success event. A runtime-level finding is documented with a skipped
// contract: `deleteSession` mutates the cached manifest *before* persisting, so a
// failed write leaves the in-memory session looking deleted.

import assert from 'node:assert/strict';
import test from 'node:test';

import { AppContext } from '../../src/core/app/app-context.mjs';
import { FrameRuntime } from '../../src/core/runtime/frame-runtime.mjs';
import { createServer } from '../../src/server/create-server.mjs';

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      let address = server.address();
      resolve(`http://${address.address}:${address.port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

test('a failing delete is reported as a 500 JSON error', async () => {
  let events = [];
  let runtime = {
    on(type, handler) {
      if (type === 'event')
        events.push(handler);
    },
    async deleteSession() {
      throw new Error('delete write failed');
    },
  };
  runtime.emit = (event) => {
    for (let handler of events)
      handler(event);
  };

  let server = await createServer({ context: new AppContext({ aeordb: {}, frameRuntime: runtime }) });
  let baseURL = await listen(server);

  try {
    let response = await fetch(`${baseURL}/api/v1/sessions/ses_1`, { method: 'DELETE' });
    let body = await response.json();

    assert.equal(response.status, 500);
    assert.deepEqual(body, { error: { message: 'delete write failed' } });
    assert.deepEqual(events, [], 'a failed delete must not emit session.saved');
  } finally {
    await close(server);
  }
});

function createFrameStore(options = {}) {
  return {
    failSave: options.failSave === true,
    sessions: new Map([ [ 'ses_1', { id: 'ses_1', title: 'Keep me', deletedAt: null, messageCount: 0 } ] ]),
    async loadSession(sessionID) {
      let session = this.sessions.get(sessionID);
      return session ? { ...session } : null;
    },
    async listSessions() {
      return [ ...this.sessions.values() ].map((session) => ({ ...session }));
    },
    async listFrames() {
      return [];
    },
    async saveSession(session) {
      if (this.failSave)
        throw new Error('delete write failed');

      this.sessions.set(session.id, { ...session });
    },
    async saveSessionManifest(session) {
      this.sessions.set(session.id, { ...session });
    },
    connect() {
      return () => {};
    },
    async flush() {},
  };
}

test('a failed delete rejects and emits no success event', async () => {
  let store = createFrameStore({ failSave: true });
  let runtime = new FrameRuntime({ frameStore: store, clock: () => 1000, idGenerator: () => 'generated' });
  await runtime.ensureSessionEntry('ses_1');

  let emitted = [];
  runtime.on('event', (event) => emitted.push(event));

  await assert.rejects(() => runtime.deleteSession('ses_1'), /delete write failed/);
  assert.equal(emitted.some((event) => event.type === 'session.saved'), false);
  assert.equal(store.sessions.get('ses_1').deletedAt, null, 'the persisted record must be untouched');
});

// FINDING (S4) fixed: `FrameRuntime.deleteSession` stamped `session.deletedAt`
// on the live object and only then awaited `frameStore.saveSession(session)`.
// For a cached session that mutated the in-memory entry before the write could
// fail, so a failed delete made `getSession()` report deleted even though
// nothing was persisted. Deletion now persists a copy first and only swaps the
// live entry on success, so a failed delete leaves the caller's view unchanged.
test('a failed delete must leave the cached session looking undeleted (FINDING)', async () => {
  let store = createFrameStore({ failSave: true });
  let runtime = new FrameRuntime({ frameStore: store, clock: () => 1000, idGenerator: () => 'generated' });
  await runtime.ensureSessionEntry('ses_1');

  await assert.rejects(() => runtime.deleteSession('ses_1'), /delete write failed/);

  assert.equal(runtime.getSession('ses_1').deletedAt, null, 'a failed delete must not look deleted');
  assert.equal((await runtime.listSessions()).some((session) => session.id === 'ses_1'), true);
});

test('a failed delete leaves getSession and listSessions unchanged', async () => {
  let store = createFrameStore({ failSave: true });
  let runtime = new FrameRuntime({ frameStore: store, clock: () => 1000, idGenerator: () => 'generated' });
  await runtime.ensureSessionEntry('ses_1');

  let sessionBefore = runtime.getSession('ses_1');
  let sessionSnapshot = { ...sessionBefore };
  let listBefore = await runtime.listSessions();

  await assert.rejects(() => runtime.deleteSession('ses_1'), /delete write failed/);

  assert.strictEqual(runtime.getSession('ses_1'), sessionBefore, 'the cached object must not be replaced by a failed delete');
  assert.deepEqual(runtime.getSession('ses_1'), sessionSnapshot, 'the cached fields must be unchanged by a failed delete');
  assert.deepEqual(await runtime.listSessions(), listBefore, 'listSessions must be unchanged by a failed delete');
});
