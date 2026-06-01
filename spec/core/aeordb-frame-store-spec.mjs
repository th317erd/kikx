'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { FrameEngine } from '../../src/core/frames/index.mjs';
import { AeorDBFrameStore } from '../../src/core/aeordb/aeordb-frame-store.mjs';

function createClient() {
  let calls = [];
  return {
    calls,
    files: new Map(),
    async putFile(path, body) {
      calls.push({ method: 'putFile', path, body });
      this.files.set(path, body);
      return { path };
    },
    async patchFile(path, body) {
      calls.push({ method: 'patchFile', path, body });
      return { path };
    },
    async getFile(path) {
      calls.push({ method: 'getFile', path });
      return this.files.get(path) || null;
    },
    async listDirectory(path, options) {
      calls.push({ method: 'listDirectory', path, options });
      let prefix = `${path.replace(/\/+$/g, '')}/`;
      let items = [];
      for (let filePath of this.files.keys()) {
        if (!filePath.startsWith(prefix))
          continue;

        if (options?.glob === '**/session.json' && !/^\/kikx\/sessions\/[^/]+\/session\.json$/.test(filePath))
          continue;

        if (options?.glob === '**/*.json' && !filePath.endsWith('.json'))
          continue;

        items.push({ path: filePath });
      }

      return {
        items: items.slice(options?.offset || 0, (options?.offset || 0) + (options?.limit || items.length)),
      };
    },
  };
}

test('AeorDBFrameStore builds stable Kikx paths', () => {
  let store = new AeorDBFrameStore({ aeordb: createClient(), rootPath: '/kikx' });

  assert.equal(store.sessionPath('ses_1'), '/kikx/sessions/ses_1/session.json');
  assert.equal(store.commitPath('ses_1', { order: 7, id: 'commit_1' }), '/kikx/sessions/ses_1/commits/0000000000000007-commit_1.json');
  assert.equal(store.framePath('ses_1', {
    id: 'frm_1',
    type: 'UserMessage',
    interactionID: 'int_1',
    order: 12,
  }), '/kikx/sessions/ses_1/interactions/int_1/frames/0000000000000012-UserMessage-frm_1.json');
  assert.equal(store.refPath('ses_1', 'processed/agent_1'), '/kikx/sessions/ses_1/refs/processed%2Fagent_1.json');
});

test('AeorDBFrameStore writes global and session-local index configs', async () => {
  let aeordb = createClient();
  let store = new AeorDBFrameStore({ aeordb, rootPath: '/kikx' });

  await store.ensureIndexConfigs();
  await store.ensureSessionIndexConfigs('ses_1');

  assert.deepEqual(aeordb.calls.map((call) => call.path), [
    '/kikx/sessions/.aeordb-config/indexes.json',
    '/kikx/sessions/ses_1/interactions/.aeordb-config/indexes.json',
    '/kikx/sessions/ses_1/values/.aeordb-config/indexes.json',
    '/kikx/sessions/ses_1/tool-log/.aeordb-config/indexes.json',
  ]);
  assert.equal(aeordb.calls[1].body.glob, '**/frames/*.json');
  assert.ok(aeordb.calls[1].body.indexes.some((index) => index.name === 'contentText'));
});

test('AeorDBFrameStore saves session manifests after creating session-local indexes', async () => {
  let aeordb = createClient();
  let store = new AeorDBFrameStore({ aeordb, rootPath: '/kikx' });

  await store.saveSession({
    id: 'ses_1',
    organizationID: 'org_1',
    title: 'Example',
  });

  assert.deepEqual(aeordb.calls.map((call) => call.path), [
    '/kikx/sessions/ses_1/interactions/.aeordb-config/indexes.json',
    '/kikx/sessions/ses_1/values/.aeordb-config/indexes.json',
    '/kikx/sessions/ses_1/tool-log/.aeordb-config/indexes.json',
    '/kikx/sessions/ses_1/session.json',
  ]);
});

test('AeorDBFrameStore lists persisted session manifests with a bounded query', async () => {
  let aeordb = createClient();
  let store = new AeorDBFrameStore({ aeordb, rootPath: '/kikx' });
  aeordb.files.set('/kikx/sessions/ses_2/session.json', { id: 'ses_2', title: 'Second', updatedAt: 20 });
  aeordb.files.set('/kikx/sessions/ses_1/session.json', { id: 'ses_1', title: 'First', updatedAt: 10 });
  aeordb.files.set('/kikx/sessions/ses_1/interactions/int_1/frames/0000000000000001-UserMessage-msg_1.json', { id: 'msg_1' });

  let sessions = await store.listSessions({ limit: 25, offset: 0 });

  assert.deepEqual(aeordb.calls[0], {
    method: 'listDirectory',
    path: '/kikx/sessions',
      options: {
      depth: -1,
      glob: '**/session.json',
      limit: 25,
      offset: 0,
    },
  });
  assert.deepEqual(sessions.map((session) => session.id), [ 'ses_2', 'ses_1' ]);
});

test('AeorDBFrameStore loads one session manifest and its frames on demand', async () => {
  let aeordb = createClient();
  let store = new AeorDBFrameStore({ aeordb, rootPath: '/kikx' });
  aeordb.files.set('/kikx/sessions/ses_1/session.json', { id: 'ses_1', title: 'First' });
  aeordb.files.set('/kikx/sessions/ses_1/interactions/int_1/frames/0000000000000002-UserMessage-msg_2.json', {
    id: 'msg_2',
    type: 'UserMessage',
    order: 2,
  });
  aeordb.files.set('/kikx/sessions/ses_1/interactions/int_1/frames/0000000000000001-UserMessage-msg_1.json', {
    id: 'msg_1',
    type: 'UserMessage',
    order: 1,
  });

  assert.deepEqual(await store.loadSession('ses_1'), { id: 'ses_1', title: 'First' });
  assert.deepEqual((await store.listFrames('ses_1')).map((frame) => frame.id), [ 'msg_1', 'msg_2' ]);
});

test('AeorDBFrameStore persists a commit and changed frames', async () => {
  let aeordb = createClient();
  let store = new AeorDBFrameStore({ aeordb, rootPath: '/kikx' });
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
  await store.saveCommit('ses_1', commit, frames.diffFrames(0, 'heads/main'), frames);

  assert.deepEqual(aeordb.calls.map((call) => [ call.method, call.path ]), [
    [ 'putFile', '/kikx/sessions/ses_1/commits/0000000000000001-commit_1.json' ],
    [ 'putFile', '/kikx/sessions/ses_1/interactions/int_1/frames/0000000000000001-UserMessage-frm_1.json' ],
    [ 'putFile', '/kikx/sessions/ses_1/refs/heads%2Fmain.json' ],
  ]);
  assert.equal(aeordb.calls[1].body.contentText, 'hello');
  assert.equal(aeordb.calls[1].body.hidden, false);
  assert.equal(aeordb.calls[1].body.hiddenIndex, 'false');
  assert.equal(aeordb.calls[2].body.commitOrder, 1);
});

test('AeorDBFrameStore connects to FrameEngine commits and serializes writes', async () => {
  let aeordb = createClient();
  let store = new AeorDBFrameStore({ aeordb, rootPath: '/kikx' });
  let frames = new FrameEngine({
    clock: () => 1000,
    idGenerator: (() => {
      let counter = 0;
      return () => `commit_${++counter}`;
    })(),
  });

  store.connect(frames, { sessionID: 'ses_1' });

  frames.merge([{ id: 'frm_1', type: 'UserMessage', sessionID: 'ses_1', interactionID: 'int_1', content: { text: 'one' } }]);
  frames.merge([{ id: 'frm_2', type: 'UserMessage', sessionID: 'ses_1', interactionID: 'int_2', content: { text: 'two' } }]);

  await store.flush();

  let commitPaths = aeordb.calls
    .filter((call) => call.path.includes('/commits/'))
    .map((call) => call.path);

  assert.deepEqual(commitPaths, [
    '/kikx/sessions/ses_1/commits/0000000000000001-commit_1.json',
    '/kikx/sessions/ses_1/commits/0000000000000002-commit_2.json',
  ]);
});

test('AeorDBFrameStore keeps accepting queued writes after a failed write is observed', async () => {
  let calls = [];
  let aeordb = {
    async putFile(path, body) {
      calls.push({ path, body });

      if (calls.length === 1)
        throw new Error('first write failed');

      return { path };
    },
  };
  let store = new AeorDBFrameStore({ aeordb, rootPath: '/kikx' });
  let frames = new FrameEngine({
    clock: () => 1000,
    idGenerator: (() => {
      let counter = 0;
      return () => `commit_${++counter}`;
    })(),
  });

  let first = frames.merge([{ id: 'frm_1', type: 'UserMessage', sessionID: 'ses_1', interactionID: 'int_1' }]);
  await assert.rejects(
    () => store.enqueueSaveCommit('ses_1', frames.getLatestCommit(), first, frames),
    /first write failed/,
  );

  let second = frames.merge([{ id: 'frm_2', type: 'UserMessage', sessionID: 'ses_1', interactionID: 'int_2' }]);
  await store.enqueueSaveCommit('ses_1', frames.getLatestCommit(), second, frames);

  assert.ok(calls.some((call) => call.path === '/kikx/sessions/ses_1/commits/0000000000000002-commit_2.json'));
});

test('AeorDBFrameStore fails loudly when sessionID cannot be resolved', async () => {
  let store = new AeorDBFrameStore({ aeordb: createClient() });
  let frames = new FrameEngine();

  frames.merge([{ id: 'frm_1', type: 'UserMessage', interactionID: 'int_1' }]);

  await assert.rejects(
    () => store.saveCommit(null, frames.getLatestCommit(), frames.toArray(), frames),
    /sessionID is required/,
  );
});
