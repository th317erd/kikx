'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { FrameEngine } from '../../src/core/frames/index.mjs';
import { AeorDBFrameStore } from '../../src/core/aeordb/aeordb-frame-store.mjs';

function createClient(options = {}) {
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
      if (options.failGetPath && path.includes(options.failGetPath))
        throw new Error(options.failGetMessage || 'read failed');

      return this.files.get(path) || null;
    },
    async fetchFiles(paths, requestOptions) {
      calls.push({ method: 'fetchFiles', paths, options: requestOptions });
      if (options.failGetPath && paths.some((path) => path.includes(options.failGetPath)))
        throw new Error(options.failGetMessage || 'read failed');

      let output = {};
      for (let path of paths) {
        if (!this.files.has(path)) {
          let error = new Error(`missing: ${path}`);
          error.status = 404;
          throw error;
        }

        output[path] = {
          path,
          content: JSON.stringify(this.files.get(path)),
        };
      }

      return output;
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

        if (options?.depth === 1) {
          let relativePath = filePath.slice(prefix.length);
          if (relativePath.includes('/'))
            continue;
        }

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
  assert.ok(aeordb.calls[1].body.indexes.some((index) => index.name === 'createdClock'));
  assert.ok(aeordb.calls[1].body.indexes.some((index) => index.name === 'updatedClock'));
  assert.ok(aeordb.calls[0].body.indexes.some((index) => index.name === 'coordinatorAgentID'));
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
  assert.deepEqual(aeordb.calls[1], {
    method: 'fetchFiles',
    paths: [
      '/kikx/sessions/ses_2/session.json',
      '/kikx/sessions/ses_1/session.json',
    ],
    options: undefined,
  });
});

test('AeorDBFrameStore falls back to shallow session manifests when recursive listing fails', async () => {
  let aeordb = createClient();
  let store = new AeorDBFrameStore({ aeordb, rootPath: '/kikx' });
  aeordb.files.set('/kikx/sessions/ses_2/session.json', { id: 'ses_2', title: 'Second', updatedAt: 20 });
  aeordb.files.set('/kikx/sessions/ses_1/session.json', { id: 'ses_1', title: 'First', updatedAt: 10 });
  aeordb.files.set('/kikx/sessions/ses_1/interactions/int_1/frames/bad.json', { id: 'bad' });

  aeordb.listDirectory = async (path, options) => {
    aeordb.calls.push({ method: 'listDirectory', path, options });
    if (options?.depth === -1 && options?.glob === '**/session.json') {
      let error = new Error('Invalid hash algorithm: 0x0000');
      error.status = 500;
      throw error;
    }

    let prefix = `${path.replace(/\/+$/g, '')}/`;
    let names = new Set();
    for (let filePath of aeordb.files.keys()) {
      if (!filePath.startsWith(prefix))
        continue;

      let name = filePath.slice(prefix.length).split('/')[0];
      if (name)
        names.add(name);
    }

    return {
      items: [ ...names ].sort().map((name) => ({
        path: `${prefix}${name}`,
        name,
      })),
    };
  };

  let sessions = await store.listSessions({ limit: 25, offset: 0 });

  assert.deepEqual(sessions.map((session) => session.id), [ 'ses_2', 'ses_1' ]);
  assert.deepEqual(aeordb.calls.filter((call) => call.method === 'listDirectory').map((call) => call.options), [
    {
      depth: -1,
      glob: '**/session.json',
      limit: 25,
      offset: 0,
    },
    {
      depth: 1,
      limit: 25,
      offset: 0,
    },
  ]);
  assert.deepEqual(aeordb.calls.find((call) => call.method === 'fetchFiles').paths, [
    '/kikx/sessions/ses_1/session.json',
    '/kikx/sessions/ses_2/session.json',
  ]);
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

test('AeorDBFrameStore orders frames by commit order and exposes missing committed frames', async () => {
  let aeordb = createClient();
  let store = new AeorDBFrameStore({ aeordb, rootPath: '/kikx' });

  aeordb.files.set('/kikx/sessions/ses_1/interactions/int_1/frames/0000000000000010-AgentMessage-agent_1.json', {
    id: 'agent_1',
    type: 'AgentMessage',
    order: 10,
    hidden: false,
    content: { text: 'agent final' },
  });
  aeordb.files.set('/kikx/sessions/ses_1/interactions/int_2/frames/0000000000000011-UserMessage-user_1.json', {
    id: 'user_1',
    type: 'UserMessage',
    order: 11,
    hidden: false,
    content: { text: 'user before final' },
  });
  aeordb.files.set('/kikx/sessions/ses_1/commits/0000000000000001-commit_1.json', {
    id: 'commit_1',
    order: 1,
    changes: [{ frameID: 'agent_1', operation: 'create' }],
  });
  aeordb.files.set('/kikx/sessions/ses_1/commits/0000000000000002-commit_2.json', {
    id: 'commit_2',
    order: 2,
    changes: [{ frameID: 'user_1', operation: 'create' }],
  });
  aeordb.files.set('/kikx/sessions/ses_1/commits/0000000000000003-commit_3.json', {
    id: 'commit_3',
    order: 3,
    changes: [{ frameID: 'agent_1', operation: 'update' }],
  });
  aeordb.files.set('/kikx/sessions/ses_1/commits/0000000000000004-commit_4.json', {
    id: 'commit_4',
    order: 4,
    changes: [{ frameID: 'missing_agent', operation: 'create' }],
  });

  let frames = await store.listFrames('ses_1');

  assert.deepEqual(frames.map((frame) => frame.id), [ 'user_1', 'agent_1', 'load-error:commit_4:missing_agent' ]);
  assert.equal(frames[0].commitOrder, 2);
  assert.equal(frames[1].order, 10);
  assert.equal(frames[1].commitOrder, 3);
  assert.equal(frames[2].type, 'FrameLoadError');
  assert.equal(frames[2].commitOrder, 4);
  assert.match(frames[2].content.text, /Committed frame could not be loaded/);
});

test('AeorDBFrameStore orders frames by updated clocks before legacy commit order', async () => {
  let aeordb = createClient();
  let store = new AeorDBFrameStore({ aeordb, rootPath: '/kikx' });

  aeordb.files.set('/kikx/sessions/ses_1/interactions/int_1/frames/0000000000000001-AgentMessage-agent_1.json', {
    id: 'agent_1',
    type: 'AgentMessage',
    order: 1,
    commitOrder: 3,
    updatedClock: '0000000001003000-000000-runner',
    hidden: false,
  });
  aeordb.files.set('/kikx/sessions/ses_1/interactions/int_2/frames/0000000000000002-UserMessage-user_1.json', {
    id: 'user_1',
    type: 'UserMessage',
    order: 2,
    commitOrder: 2,
    updatedClock: '0000000001002000-000000-runner',
    hidden: false,
  });
  aeordb.files.set('/kikx/sessions/ses_1/commits/0000000000000002-commit_2.json', {
    id: 'commit_2',
    order: 2,
    changes: [{ frameID: 'user_1', operation: 'create' }],
  });
  aeordb.files.set('/kikx/sessions/ses_1/commits/0000000000000003-commit_3.json', {
    id: 'commit_3',
    order: 3,
    changes: [{ frameID: 'agent_1', operation: 'update' }],
  });

  let frames = await store.listFrames('ses_1');

  assert.deepEqual(frames.map((frame) => frame.id), [ 'user_1', 'agent_1' ]);
});

test('AeorDBFrameStore preserves frame load failures as visible non-persisted placeholders', async () => {
  let aeordb = createClient({
    failGetPath: '0000000000000002-AgentMessage-bad_msg.json',
    failGetMessage: 'fetch failed',
  });
  let store = new AeorDBFrameStore({ aeordb, rootPath: '/kikx' });
  aeordb.files.set('/kikx/sessions/ses_1/interactions/int_1/frames/0000000000000001-UserMessage-msg_1.json', {
    id: 'msg_1',
    type: 'UserMessage',
    order: 1,
    hidden: false,
  });
  aeordb.files.set('/kikx/sessions/ses_1/interactions/int_1/frames/0000000000000002-AgentMessage-bad_msg.json', {
    id: 'bad_msg',
    type: 'AgentMessage',
    order: 2,
  });
  aeordb.files.set('/kikx/sessions/ses_1/interactions/int_1/frames/0000000000000003-UserMessage-msg_2.json', {
    id: 'msg_2',
    type: 'UserMessage',
    order: 3,
    hidden: false,
  });

  let frames = await store.listFrames('ses_1');

  assert.deepEqual(frames.map((frame) => frame.type), [ 'UserMessage', 'FrameLoadError', 'UserMessage' ]);
  assert.deepEqual(frames.map((frame) => frame.id), [
    'msg_1',
    'load-error:0000000000000002-AgentMessage-bad_msg.json',
    'msg_2',
  ]);
  assert.equal(frames[1].hidden, false);
  assert.equal(frames[1].deleted, false);
  assert.equal(frames[1].order, 2);
  assert.equal(frames[1].content.text, 'Frame could not be loaded from AeorDB. Original database evidence was not modified.');
  assert.equal(frames[1].content.path, '/kikx/sessions/ses_1/interactions/int_1/frames/0000000000000002-AgentMessage-bad_msg.json');
  assert.equal(frames[1].content.error, 'fetch failed');
  assert.equal(aeordb.calls.some((call) => call.method === 'putFile' || call.method === 'patchFile'), false);
  assert.ok(aeordb.calls.some((call) => call.method === 'fetchFiles'));
  assert.equal(aeordb.calls.filter((call) => call.method === 'getFile').length, 3);
});

test('AeorDBFrameStore falls back to individual frame reads when multi-fetch is all-or-nothing', async () => {
  let aeordb = createClient({
    failGetPath: '0000000000000002-AgentMessage-bad_msg.json',
    failGetMessage: 'multi-fetch 404',
  });
  let store = new AeorDBFrameStore({ aeordb, rootPath: '/kikx' });
  aeordb.files.set('/kikx/sessions/ses_1/interactions/int_1/frames/0000000000000001-UserMessage-msg_1.json', {
    id: 'msg_1',
    type: 'UserMessage',
    order: 1,
  });
  aeordb.files.set('/kikx/sessions/ses_1/interactions/int_1/frames/0000000000000002-AgentMessage-bad_msg.json', {
    id: 'bad_msg',
    type: 'AgentMessage',
    order: 2,
  });

  let frames = await store.listFrames('ses_1');

  assert.deepEqual(frames.map((frame) => frame.type), [ 'UserMessage', 'FrameLoadError' ]);
  assert.equal(frames[1].content.error, 'multi-fetch 404');
  assert.ok(aeordb.calls.some((call) => call.method === 'fetchFiles'));
  assert.equal(aeordb.calls.filter((call) => call.method === 'getFile').length, 2);
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
    [ 'putFile', '/kikx/sessions/ses_1/interactions/int_1/frames/0000000000000001-UserMessage-frm_1.json' ],
    [ 'putFile', '/kikx/sessions/ses_1/commits/0000000000000001-commit_1.json' ],
    [ 'putFile', '/kikx/sessions/ses_1/refs/heads%2Fmain.json' ],
  ]);
  assert.equal(aeordb.calls[0].body.contentText, 'hello');
  assert.equal(aeordb.calls[0].body.hidden, false);
  assert.equal(aeordb.calls[0].body.hiddenIndex, 'false');
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
