'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { FrameRuntime } from '../../src/core/runtime/frame-runtime.mjs';
import {
  matchSessionDeleteRoute,
} from '../../src/server/routes/route-matchers.mjs';

// "We NEVER fully delete anything": deleting a session only stamps the manifest
// with deletedAt. The record, frames, and tool outputs stay — a later "show
// deleted" filter reads the field, and clearing it restores the session.
//
// The runtime clock is a HybridLogicalClock, so the stamp value is opaque; these
// assertions check the contract (present / preserved / unchanged), not a number.

function createClient() {
  return {
    files: new Map(),
    async putFile(path, body) {
      this.files.set(path, body);
      return { path };
    },
    async getFile(path) {
      return this.files.get(path) || null;
    },
    async listDirectory() {
      return { items: [] };
    },
  };
}

function createRuntime(options = {}) {
  let ids = options.ids || [ 'ses_1', 'int_1', 'msg_1', 'commit_1' ];
  let index = 0;
  return new FrameRuntime({
    aeordb: options.aeordb || createClient(),
    clock: () => options.now || 1000,
    runnerID: 'runtime',
    idGenerator: () => ids[index++],
  });
}

// A pure in-memory frame store so listSessions() returns a controlled set
// without standing up AeorDB. FrameRuntime filters the store's output in JS, so
// every driver sees the same behaviour.
function createFrameStore(sessions = []) {
  let records = new Map(sessions.map((session) => [ session.id, session ]));
  return {
    async saveSession(session) {
      records.set(session.id, session);
    },
    async loadSession(sessionID) {
      return records.get(sessionID) || null;
    },
    async listSessions() {
      return [ ...records.values() ];
    },
    async listFrames() {
      return [];
    },
    async ensureIndexConfigs() {},
    connect() {
      return () => {};
    },
    async flush() {},
  };
}

function createStoreRuntime(sessions = []) {
  return new FrameRuntime({
    frameStore: createFrameStore(sessions),
    clock: () => 1000,
    runnerID: 'runtime',
    idGenerator: () => 'generated',
  });
}

test('matchSessionDeleteRoute matches only a bare session id', () => {
  assert.deepEqual(matchSessionDeleteRoute('/api/v1/sessions/ses_1'), { sessionID: 'ses_1' });
  assert.deepEqual(matchSessionDeleteRoute('/api/v1/sessions/a%2Fb'), { sessionID: 'a/b' });
  assert.equal(matchSessionDeleteRoute('/api/v1/sessions/ses_1/frames'), null);
  assert.equal(matchSessionDeleteRoute('/api/v1/sessions'), null);
});

test('createSession sets deletedAt to null', async () => {
  let runtime = createRuntime({ ids: [ 'ses_1' ] });
  let session = await runtime.createSession({ title: 'Scratch' });
  assert.equal(session.deletedAt, null);
});

test('deleteSession stamps deletedAt without removing the record', async () => {
  let aeordb = createClient();
  let runtime = createRuntime({ aeordb, ids: [ 'ses_1' ] });
  await runtime.createSession({ title: 'Keep me' });

  let deleted = await runtime.deleteSession('ses_1');
  assert.ok(deleted.deletedAt, 'deletedAt must be set after delete');
  assert.equal(deleted.title, 'Keep me');

  // Still persisted, still loadable — the manifest file was rewritten, not removed.
  let stored = aeordb.files.get('/kikx/sessions/ses_1/session.json');
  assert.equal(stored.deletedAt, deleted.deletedAt);
  assert.equal(stored.title, 'Keep me');
  assert.equal(runtime.getSession('ses_1').deletedAt, deleted.deletedAt);
});

test('deleteSession on an unknown session is a 404', async () => {
  let runtime = createRuntime({ ids: [ 'ses_1' ] });
  await assert.rejects(() => runtime.deleteSession('nope'), (error) => error.status === 404);
});

test('updateSession with deletedAt:null restores a deleted session', async () => {
  let runtime = createRuntime({ ids: [ 'ses_1' ] });
  await runtime.createSession({ title: 'Temp' });
  await runtime.deleteSession('ses_1');
  assert.ok(runtime.getSession('ses_1').deletedAt);

  let restored = await runtime.updateSession('ses_1', { deletedAt: null });
  assert.equal(restored.deletedAt, null);
  assert.equal(runtime.getSession('ses_1').deletedAt, null);
});

test('an ordinary title update leaves deletedAt untouched', async () => {
  let runtime = createRuntime({ ids: [ 'ses_1' ] });
  await runtime.createSession({ title: 'Temp' });
  let deleted = await runtime.deleteSession('ses_1');

  let updated = await runtime.updateSession('ses_1', { title: 'Renamed' });
  assert.equal(updated.title, 'Renamed');
  assert.equal(updated.deletedAt, deleted.deletedAt, 'a rename must not resurrect a deleted session');
});

test('listSessions hides soft-deleted sessions unless includeDeleted is set', async () => {
  let runtime = createStoreRuntime([
    { id: 'ses_live', title: 'Live', deletedAt: null },
    { id: 'ses_gone', title: 'Gone', deletedAt: 'stamp-1' },
  ]);

  let visible = await runtime.listSessions();
  assert.deepEqual(visible.map((session) => session.id), [ 'ses_live' ]);

  let all = await runtime.listSessions({ includeDeleted: true });
  assert.deepEqual(all.map((session) => session.id).sort(), [ 'ses_gone', 'ses_live' ]);
});

test('a soft-deleted session stays reachable by getSession and the load path', async () => {
  let runtime = createRuntime({ ids: [ 'ses_1' ] });
  await runtime.createSession({ title: 'Keep me' });
  let deleted = await runtime.deleteSession('ses_1');

  assert.equal(runtime.getSession('ses_1').deletedAt, deleted.deletedAt);

  // Simulate a cold cache: the manifest must still load from the store.
  runtime.sessions.delete('ses_1');
  let entry = await runtime.ensureSessionEntry('ses_1');
  assert.equal(entry.session.id, 'ses_1');
  assert.equal(entry.session.deletedAt, deleted.deletedAt);
});
