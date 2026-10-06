'use strict';

// Parity: the real AeorDBFrameStore runs over the driver contract, not just a
// raw file-verb client. The store is constructed with the AeorDBConnection
// driver wrapping FakeAeorDBClient and round-trips sessions, frames and commits
// through the public document methods. This is the P2 gate proving the stores
// can be repointed from `aeordb` to `db` without a format/behaviour change.

import assert from 'node:assert/strict';
import test from 'node:test';

import { FrameEngine } from '../../../src/core/frames/index.mjs';
import { AeorDBConnection } from '../../../src/core/aeordb/aeordb-connection.mjs';
import { AeorDBFrameStore } from '../../../src/core/aeordb/aeordb-frame-store.mjs';
import { AgentTodoStore } from '../../../src/core/agents/agent-todo-store.mjs';
import { ToolOutputStore } from '../../../src/core/tools/tool-output-store.mjs';
import { FakeAeorDBClient } from './fake-aeordb-client.mjs';

function createStore(options = {}) {
  let db = new AeorDBConnection({ client: new FakeAeorDBClient() });
  let store = new AeorDBFrameStore({ db, ...options });
  return { db, store };
}

test('AeorDBFrameStore accepts db and wires the driver', () => {
  let { db, store } = createStore();

  assert.equal(store.aeordb, db);
  assert.equal(store.db, db);
});

test('AeorDBFrameStore round-trips a session over the driver contract', async () => {
  let { db, store } = createStore();

  try {
    await store.saveSession({ id: 'ses_1', organizationID: 'org_1', title: 'Example' });

    let session = await store.loadSession('ses_1');
    assert.equal(session.id, 'ses_1');
    assert.equal(session.title, 'Example');

    let sessions = await store.listSessions({ limit: 25, offset: 0 });
    assert.deepEqual(sessions.map((entry) => entry.id), [ 'ses_1' ]);
  } finally {
    await db.close();
  }
});

test('AeorDBFrameStore persists frames and a commit over the driver contract', async () => {
  let { db, store } = createStore();

  try {
    await store.saveSession({ id: 'ses_1', title: 'Example' });

    let frames = new FrameEngine({
      clock: () => 1000,
      idGenerator: () => 'commit_1',
    });

    frames.merge([
      {
        id: 'frm_1',
        type: 'UserMessage',
        sessionID: 'ses_1',
        interactionID: 'int_1',
        authorType: 'user',
        authorID: 'usr_1',
        content: { text: 'hello' },
        hidden: false,
      },
    ], { authorType: 'user', authorID: 'usr_1' });

    let commit = frames.getLatestCommit();
    await store.saveCommit('ses_1', commit, frames.diffFrames(0, 'heads/main'));

    let loadedFrames = await store.listFrames('ses_1');
    assert.equal(loadedFrames.length, 1);
    assert.equal(loadedFrames[0].id, 'frm_1');
    assert.equal(loadedFrames[0].content.text, 'hello');

    let loadedCommits = await store.listCommits('ses_1');
    assert.equal(loadedCommits.length, 1);
    assert.equal(loadedCommits[0].id, 'commit_1');
  } finally {
    await db.close();
  }
});

test('stores accept db directly instead of the aeordb alias', () => {
  let db = new AeorDBConnection({ client: new FakeAeorDBClient() });

  assert.equal(new AgentTodoStore({ db }).db, db);
  assert.equal(new ToolOutputStore({ db }).db, db);
});
