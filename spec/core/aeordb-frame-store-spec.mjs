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

        if (options?.glob === '**/frames/*.json' && !filePath.includes('/frames/'))
          continue;

        if (options?.depth === 1) {
          let relativePath = filePath.slice(prefix.length);
          if (relativePath.includes('/'))
            continue;
        }

        items.push({ path: filePath });
      }

      // Match real AeorDB: basename-sorted (frame filenames are zero-padded order
      // prefixes, so this is also chronological).
      items.sort((left, right) => {
        let leftName = left.path.split('/').pop();
        let rightName = right.path.split('/').pop();
        return leftName.localeCompare(rightName);
      });

      let offset = options?.offset || 0;
      let limit = options?.limit || items.length;

      return {
        items: items.slice(offset, offset + limit),
        limit,
        offset,
        total: items.length,
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
  assert.ok(aeordb.calls[1].body.indexes.some((index) => index.name === 'scheduledAt'));
  assert.ok(aeordb.calls[1].body.indexes.some((index) => index.name === 'scheduledStatus'));
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

test('AeorDBFrameStore skips unreadable session manifests without modifying evidence', async () => {
  let aeordb = createClient({
    failGetPath: '/kikx/sessions/ses_bad/session.json',
    failGetMessage: 'fetch failed',
  });
  let store = new AeorDBFrameStore({ aeordb, rootPath: '/kikx' });
  aeordb.files.set('/kikx/sessions/ses_good/session.json', { id: 'ses_good', title: 'Good', updatedAt: 20 });
  aeordb.files.set('/kikx/sessions/ses_bad/session.json', { id: 'ses_bad', title: 'Unreadable', updatedAt: 10 });

  let sessions = await store.listSessions({ limit: 25, offset: 0 });

  assert.deepEqual(sessions.map((session) => session.id), [ 'ses_good' ]);
  assert.ok(aeordb.calls.some((call) => call.method === 'fetchFiles'));
  assert.equal(aeordb.calls.filter((call) => call.method === 'getFile').length, 2);
  assert.equal(aeordb.calls.some((call) => call.method === 'putFile' || call.method === 'patchFile'), false);
});

test('AeorDBFrameStore treats a missing sessions directory as an empty list', async () => {
  let aeordb = createClient();
  let store = new AeorDBFrameStore({ aeordb, rootPath: '/kikx' });

  aeordb.listDirectory = async (path, options) => {
    aeordb.calls.push({ method: 'listDirectory', path, options });
    let error = new Error('Not found: kikx/sessions');
    error.status = 404;
    throw error;
  };

  assert.deepEqual(await store.listSessions({ limit: 25, offset: 0 }), []);
  assert.deepEqual(aeordb.calls, [
    {
      method: 'listDirectory',
      path: '/kikx/sessions',
      options: {
        depth: -1,
        glob: '**/session.json',
        limit: 25,
        offset: 0,
      },
    },
  ]);
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

test('AeorDBFrameStore walks AeorDB pages for large session histories', async () => {
  let aeordb = createClient();
  let store = new AeorDBFrameStore({ aeordb, rootPath: '/kikx' });

  for (let index = 1; index <= 520; index++) {
    let padded = String(index).padStart(16, '0');
    aeordb.files.set(`/kikx/sessions/ses_1/interactions/int_${index}/frames/${padded}-UserMessage-msg_${index}.json`, {
      id: `msg_${index}`,
      type: 'UserMessage',
      sessionID: 'ses_1',
      interactionID: `int_${index}`,
      order: index,
      hidden: false,
      content: { text: `message ${index}` },
    });
    aeordb.files.set(`/kikx/sessions/ses_1/commits/${padded}-commit_${index}.json`, {
      id: `commit_${index}`,
      order: index,
      changes: [{ frameID: `msg_${index}`, operation: 'create' }],
    });
  }

  let frames = await store.listFrames('ses_1');
  let interactionCalls = aeordb.calls.filter((call) => call.method === 'listDirectory' && call.path.endsWith('/interactions'));
  let commitCalls = aeordb.calls.filter((call) => call.method === 'listDirectory' && call.path.endsWith('/commits'));

  assert.equal(frames.length, 520);
  assert.equal(frames[0].id, 'msg_1');
  assert.equal(frames.at(-1).id, 'msg_520');
  assert.deepEqual(interactionCalls.map((call) => call.options.offset), [ 0, 500 ]);
  assert.deepEqual(commitCalls.map((call) => call.options.offset), [ 0, 500 ]);
});

test('AeorDBFrameStore lists pending scheduled frames for runtime queue hydration', async () => {
  let aeordb = createClient();
  let store = new AeorDBFrameStore({ aeordb, rootPath: '/kikx' });
  aeordb.files.set('/kikx/sessions/ses_1/session.json', { id: 'ses_1', title: 'First' });
  aeordb.files.set('/kikx/sessions/ses_2/session.json', { id: 'ses_2', title: 'Second' });
  aeordb.files.set('/kikx/sessions/ses_1/interactions/int_1/frames/0000000000000001-UserMessage-later.json', {
    id: 'later',
    type: 'UserMessage',
    sessionID: 'ses_1',
    interactionID: 'int_1',
    order: 1,
    scheduledAt: 5000,
    scheduledStatus: 'pending',
    content: { text: 'later' },
  });
  aeordb.files.set('/kikx/sessions/ses_2/interactions/int_2/frames/0000000000000001-UserMessage-done.json', {
    id: 'done',
    type: 'UserMessage',
    sessionID: 'ses_2',
    interactionID: 'int_2',
    order: 1,
    scheduledAt: 4000,
    scheduledStatus: 'fired',
    content: { text: 'done' },
  });

  let scheduledFrames = await store.listScheduledFrames();

  assert.deepEqual(scheduledFrames.map((frame) => frame.id), [ 'later' ]);
});

test('AeorDBFrameStore queries pending scheduled frames through the structured query endpoint', async () => {
  let aeordb = createClient();
  let store = new AeorDBFrameStore({ aeordb, rootPath: '/kikx' });
  let laterPath = '/kikx/sessions/ses_1/interactions/int_1/frames/0000000000000001-UserMessage-later.json';
  aeordb.files.set(laterPath, {
    id: 'later',
    type: 'UserMessage',
    sessionID: 'ses_1',
    interactionID: 'int_1',
    order: 1,
    scheduledAt: 5000,
    scheduledStatus: 'pending',
    content: { text: 'later' },
  });
  aeordb.queryFiles = async (query) => {
    aeordb.calls.push({ method: 'queryFiles', query });
    return { results: [{ path: laterPath }] };
  };

  let scheduledFrames = await store.listScheduledFrames({ limit: 25, offset: 5 });

  assert.deepEqual(scheduledFrames.map((frame) => frame.id), [ 'later' ]);
  assert.deepEqual(aeordb.calls.find((call) => call.method === 'queryFiles').query, {
    path: '/kikx/sessions',
    where: {
      and: [
        { field: 'scheduledAt', op: 'gt', value: 0 },
        { not: { field: 'scheduledStatus', op: 'eq', value: 'fired' } },
        { not: { field: 'scheduledStatus', op: 'eq', value: 'cancelled' } },
      ],
    },
    limit: 25,
    offset: 5,
  });
});

test('AeorDBFrameStore falls back to scanning when scheduled-frame query is unsupported', async () => {
  let aeordb = createClient();
  let store = new AeorDBFrameStore({ aeordb, rootPath: '/kikx' });
  aeordb.files.set('/kikx/sessions/ses_1/session.json', { id: 'ses_1', title: 'First' });
  aeordb.files.set('/kikx/sessions/ses_1/interactions/int_1/frames/0000000000000001-UserMessage-later.json', {
    id: 'later',
    type: 'UserMessage',
    sessionID: 'ses_1',
    interactionID: 'int_1',
    order: 1,
    scheduledAt: 5000,
    scheduledStatus: 'pending',
    content: { text: 'later' },
  });
  aeordb.queryFiles = async (query) => {
    aeordb.calls.push({ method: 'queryFiles', query });
    let error = new Error('AeorDB HTTP 400');
    error.status = 400;
    error.body = { error: "Missing 'field' in where clause" };
    throw error;
  };

  let scheduledFrames = await store.listScheduledFrames();

  assert.deepEqual(scheduledFrames.map((frame) => frame.id), [ 'later' ]);
  assert.ok(aeordb.calls.some((call) => call.method === 'queryFiles'));
  assert.ok(aeordb.calls.some((call) => call.method === 'listDirectory'));
});

test('AeorDBFrameStore keeps stable frame order and exposes missing committed frames last', async () => {
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

  assert.deepEqual(frames.map((frame) => frame.id), [ 'agent_1', 'user_1', 'load-error:commit_4:missing_agent' ]);
  assert.equal(frames[0].order, 10);
  assert.equal(frames[0].commitOrder, 3);
  assert.equal(frames[1].commitOrder, 2);
  assert.equal(frames[2].type, 'FrameLoadError');
  assert.equal(frames[2].commitOrder, 4);
  assert.match(frames[2].content.text, /Committed frame could not be loaded/);
});

test('AeorDBFrameStore orders frames by stable creation clocks before legacy commit order', async () => {
  let aeordb = createClient();
  let store = new AeorDBFrameStore({ aeordb, rootPath: '/kikx' });

  aeordb.files.set('/kikx/sessions/ses_1/interactions/int_1/frames/0000000000000001-AgentMessage-agent_1.json', {
    id: 'agent_1',
    type: 'AgentMessage',
    order: 1,
    commitOrder: 3,
    createdClock: '0000000001001000-000000-runner',
    updatedClock: '0000000001003000-000000-runner',
    hidden: false,
  });
  aeordb.files.set('/kikx/sessions/ses_1/interactions/int_2/frames/0000000000000002-UserMessage-user_1.json', {
    id: 'user_1',
    type: 'UserMessage',
    order: 2,
    commitOrder: 2,
    createdClock: '0000000001002000-000000-runner',
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

  assert.deepEqual(frames.map((frame) => frame.id), [ 'agent_1', 'user_1' ]);
});

test('AeorDBFrameStore orders closed agent responses by close clock on reload', async () => {
  let aeordb = createClient();
  let store = new AeorDBFrameStore({ aeordb, rootPath: '/kikx' });

  aeordb.files.set('/kikx/sessions/ses_1/interactions/int_1/frames/0000000000000001-UserMessage-user_1.json', {
    id: 'user_1',
    type: 'UserMessage',
    order: 1,
    createdClock: '0000000001000000-000000-runner',
    updatedClock: '0000000001000000-000000-runner',
    hidden: false,
  });
  aeordb.files.set('/kikx/sessions/ses_1/interactions/int_1/frames/0000000000000002-AgentMessage-agent_1.json', {
    id: 'agent_1',
    type: 'AgentMessage',
    order: 2,
    createdClock: '0000000001001000-000000-runner',
    updatedClock: '0000000009000000-000000-runner',
    hidden: false,
    content: {
      text: 'answer',
      status: 'complete',
    },
    state: {
      lifecycle: {
        status: 'closed',
        closedClock: '0000000001002000-000000-runner',
        closedAt: 1002,
      },
    },
  });
  aeordb.files.set('/kikx/sessions/ses_1/interactions/int_2/frames/0000000000000003-UserMessage-user_2.json', {
    id: 'user_2',
    type: 'UserMessage',
    order: 3,
    createdClock: '0000000001003000-000000-runner',
    updatedClock: '0000000001003000-000000-runner',
    hidden: false,
  });

  let frames = await store.listFrames('ses_1');

  assert.deepEqual(frames.map((frame) => frame.id), [ 'user_1', 'agent_1', 'user_2' ]);
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

function seedSessionWithFrames(aeordb, sessionID, count, options = {}) {
  aeordb.files.set(`/kikx/sessions/${sessionID}/session.json`, {
    id: sessionID,
    title: options.title || `Session ${sessionID}`,
    messageCount: count,
    updatedAt: options.updatedAt || 1000,
  });

  for (let order = 1; order <= count; order++) {
    let type = order % 3 === 0 ? 'AgentMessage' : 'UserMessage';
    let frame = {
      id: `${sessionID}_f${order}`,
      type,
      sessionID,
      interactionID: 'int_1',
      order,
      commitOrder: order,
      authorType: type === 'UserMessage' ? 'user' : 'agent',
      authorID: type === 'UserMessage' ? 'usr_1' : 'agent_1',
      createdAt: order,
      createdClock: String(order).padStart(20, '0'),
      hidden: false,
      deleted: false,
      content: { text: `frame ${order}` },
    };
    let padded = String(order).padStart(16, '0');
    aeordb.files.set(`/kikx/sessions/${sessionID}/interactions/int_1/frames/${padded}-${type}-${frame.id}.json`, frame);
  }
}

test('AeorDBFrameStore previews only the bounded tail per session', async () => {
  let aeordb = createClient();
  let store = new AeorDBFrameStore({ aeordb, rootPath: '/kikx' });
  seedSessionWithFrames(aeordb, 'ses_big', 300);

  let previews = await store.listSessionPreviews([ 'ses_big' ], { previewCount: 5 });

  assert.equal(previews.length, 1);
  assert.equal(previews[0].sessionID, 'ses_big');
  assert.equal(previews[0].session.title, 'Session ses_big');
  assert.equal(previews[0].truncated, true);
  assert.equal(previews[0].error, null);
  assert.equal(previews[0].heads.length, 5);
  // The heads must be the newest visible frames, in order.
  assert.deepEqual(previews[0].heads.map((frame) => frame.order), [ 296, 297, 298, 299, 300 ]);

  // Bodies fetched must be bounded, not all 300.
  let fetchCalls = aeordb.calls.filter((call) => call.method === 'fetchFiles');
  let frameFetch = fetchCalls.find((call) => call.paths.some((path) => path.includes('/frames/')));
  assert.ok(frameFetch, 'preview fetched frame bodies');
  assert.ok(frameFetch.paths.length <= 5 * 8, `bounded frame fetch (got ${frameFetch.paths.length})`);
  assert.ok(frameFetch.paths.length < 300, 'did not fetch all frames');

  // No FrameEngine / full listFrames path is used.
  assert.equal(aeordb.calls.some((call) => call.method === 'getFile' && call.path.includes('/frames/')), false);
});

test('AeorDBFrameStore previews many sessions in one call', async () => {
  let aeordb = createClient();
  let store = new AeorDBFrameStore({ aeordb, rootPath: '/kikx' });
  seedSessionWithFrames(aeordb, 'ses_a', 12, { title: 'A' });
  seedSessionWithFrames(aeordb, 'ses_b', 4, { title: 'B' });

  let previews = await store.listSessionPreviews([ 'ses_a', 'ses_b' ], { previewCount: 3 });

  assert.deepEqual(previews.map((entry) => entry.sessionID), [ 'ses_a', 'ses_b' ]);
  assert.equal(previews[0].heads.length, 3);
  assert.deepEqual(previews[0].heads.map((frame) => frame.order), [ 10, 11, 12 ]);
  assert.equal(previews[0].truncated, true);
  assert.equal(previews[1].heads.length, 3);
  assert.deepEqual(previews[1].heads.map((frame) => frame.order), [ 2, 3, 4 ]);
  assert.equal(previews[1].truncated, true);

  // Manifests for both sessions come from a single bulk fetch.
  let manifestFetch = aeordb.calls.find((call) => (
    call.method === 'fetchFiles'
    && call.paths.includes('/kikx/sessions/ses_a/session.json')
    && call.paths.includes('/kikx/sessions/ses_b/session.json')
  ));
  assert.ok(manifestFetch, 'manifests fetched in one bulk call');
});

test('AeorDBFrameStore marks short sessions untruncated', async () => {
  let aeordb = createClient();
  let store = new AeorDBFrameStore({ aeordb, rootPath: '/kikx' });
  seedSessionWithFrames(aeordb, 'ses_small', 2);

  let previews = await store.listSessionPreviews([ 'ses_small' ], { previewCount: 5 });

  assert.equal(previews[0].truncated, false);
  assert.deepEqual(previews[0].heads.map((frame) => frame.order), [ 1, 2 ]);
});

test('AeorDBFrameStore degrades a missing session to an error entry', async () => {
  let aeordb = createClient();
  let store = new AeorDBFrameStore({ aeordb, rootPath: '/kikx' });

  let previews = await store.listSessionPreviews([ 'ses_missing' ], { previewCount: 5 });

  assert.deepEqual(previews[0].heads, []);
  assert.equal(previews[0].session, null);
  assert.match(previews[0].error, /not found/);
});

test('AeorDBFrameStore preview tolerates a corrupt tail frame', async () => {
  let aeordb = createClient();
  let store = new AeorDBFrameStore({ aeordb, rootPath: '/kikx' });
  seedSessionWithFrames(aeordb, 'ses_corrupt', 10);
  // Corrupt the newest frame: multi-fetch returns a value that fails to project.
  aeordb.files.set('/kikx/sessions/ses_corrupt/interactions/int_1/frames/0000000000000010-AgentMessage-ses_corrupt_f10.json', { junk: true });

  let previews = await store.listSessionPreviews([ 'ses_corrupt' ], { previewCount: 3 });

  assert.equal(previews[0].error, null);
  // Valid frames still project; the bad one is skipped by id/type guard.
  assert.ok(previews[0].heads.length >= 1);
  assert.equal(previews[0].heads.every((frame) => frame.id && frame.type), true);
});

test('AeorDBFrameStore preview bounds previewCount and session count', async () => {
  let aeordb = createClient();
  let store = new AeorDBFrameStore({ aeordb, rootPath: '/kikx' });
  seedSessionWithFrames(aeordb, 'ses_big', 100);

  // previewCount above the max clamps to MAX_PREVIEW_COUNT (20).
  let previews = await store.listSessionPreviews([ 'ses_big' ], { previewCount: 999 });
  assert.equal(previews[0].heads.length, 20);

  // Invalid previewCount falls back to the default (5).
  let fallback = await store.listSessionPreviews([ 'ses_big' ], { previewCount: 0 });
  assert.equal(fallback[0].heads.length, 5);

  // Deduplicates and caps session IDs.
  let ids = [];
  for (let index = 0; index < 150; index++)
    ids.push('ses_big');
  let deduped = await store.listSessionPreviews(ids, { previewCount: 2 });
  assert.equal(deduped.length, 1);
});

test('AeorDBFrameStore window returns the newest frames by default', async () => {
  let aeordb = createClient();
  let store = new AeorDBFrameStore({ aeordb, rootPath: '/kikx' });
  seedSessionWithFrames(aeordb, 'ses_big', 300);

  let result = await store.listFrameWindow('ses_big', { limit: 20 });

  assert.equal(result.total, 300);
  assert.equal(result.hasMore, true);
  assert.equal(result.frames.length, 20);
  // Newest frames, ascending display order.
  assert.deepEqual(result.frames.map((frame) => frame.order), Array.from({ length: 20 }, (_value, index) => 281 + index));
  assert.equal(result.newestOrder, 300);
  assert.equal(result.oldestOrder, 281);

  // Bodies fetched must be bounded, not all 300.
  let frameFetch = aeordb.calls.find((call) => call.method === 'fetchFiles' && call.paths.some((path) => path.includes('/frames/')));
  assert.ok(frameFetch, 'window fetched frame bodies');
  assert.ok(frameFetch.paths.length < 300, 'did not fetch all frames');
});

test('AeorDBFrameStore window pages older frames with a before cursor', async () => {
  let aeordb = createClient();
  let store = new AeorDBFrameStore({ aeordb, rootPath: '/kikx' });
  seedSessionWithFrames(aeordb, 'ses_big', 300);

  let firstPage = await store.listFrameWindow('ses_big', { limit: 20 });
  let secondPage = await store.listFrameWindow('ses_big', { limit: 20, before: firstPage.oldestOrder });

  assert.deepEqual(secondPage.frames.map((frame) => frame.order), Array.from({ length: 20 }, (_value, index) => 261 + index));
  assert.equal(secondPage.newestOrder, 280);
  assert.equal(secondPage.oldestOrder, 261);
  assert.equal(secondPage.hasMore, true);
  assert.equal(secondPage.total, 300);

  // Pages do not overlap.
  assert.equal(firstPage.frames.some((frame) => secondPage.frames.some((other) => other.id === frame.id)), false);
});

test('AeorDBFrameStore window marks the oldest page as no more', async () => {
  let aeordb = createClient();
  let store = new AeorDBFrameStore({ aeordb, rootPath: '/kikx' });
  seedSessionWithFrames(aeordb, 'ses_big', 300);

  let result = await store.listFrameWindow('ses_big', { limit: 20, before: 41 });

  assert.deepEqual(result.frames.map((frame) => frame.order), Array.from({ length: 20 }, (_value, index) => 21 + index));
  assert.equal(result.oldestOrder, 21);
  assert.equal(result.newestOrder, 40);
  assert.equal(result.hasMore, true);

  let finalPage = await store.listFrameWindow('ses_big', { limit: 20, before: 21 });
  assert.deepEqual(finalPage.frames.map((frame) => frame.order), Array.from({ length: 20 }, (_value, index) => 1 + index));
  assert.equal(finalPage.hasMore, false);
  assert.equal(finalPage.oldestOrder, 1);
  assert.equal(finalPage.newestOrder, 20);
});

test('AeorDBFrameStore window returns a whole small session untruncated', async () => {
  let aeordb = createClient();
  let store = new AeorDBFrameStore({ aeordb, rootPath: '/kikx' });
  seedSessionWithFrames(aeordb, 'ses_small', 3);

  let result = await store.listFrameWindow('ses_small', { limit: 20 });

  assert.equal(result.total, 3);
  assert.equal(result.hasMore, false);
  assert.deepEqual(result.frames.map((frame) => frame.order), [ 1, 2, 3 ]);
  assert.equal(result.oldestOrder, 1);
  assert.equal(result.newestOrder, 3);
});

test('AeorDBFrameStore window returns empty metadata for a session with no frames', async () => {
  let aeordb = createClient();
  let store = new AeorDBFrameStore({ aeordb, rootPath: '/kikx' });

  let result = await store.listFrameWindow('ses_empty', { limit: 20 });

  assert.equal(result.total, 0);
  assert.equal(result.hasMore, false);
  assert.deepEqual(result.frames, []);
  assert.equal(result.oldestOrder, null);
  assert.equal(result.newestOrder, null);
});

test('AeorDBFrameStore window projects visible heads only', async () => {
  let aeordb = createClient();
  let store = new AeorDBFrameStore({ aeordb, rootPath: '/kikx' });
  seedSessionWithFrames(aeordb, 'ses_mixed', 5);
  // Hide one middle frame and delete another; neither should surface.
  aeordb.files.set('/kikx/sessions/ses_mixed/interactions/int_1/frames/0000000000000002-UserMessage-ses_mixed_f2.json', {
    id: 'ses_mixed_f2',
    type: 'UserMessage',
    sessionID: 'ses_mixed',
    interactionID: 'int_1',
    order: 2,
    hidden: true,
    content: { text: 'hidden frame' },
  });
  aeordb.files.set('/kikx/sessions/ses_mixed/interactions/int_1/frames/0000000000000004-UserMessage-ses_mixed_f4.json', {
    id: 'ses_mixed_f4',
    type: 'UserMessage',
    sessionID: 'ses_mixed',
    interactionID: 'int_1',
    order: 4,
    deleted: true,
    content: { text: 'deleted frame' },
  });

  let result = await store.listFrameWindow('ses_mixed', { limit: 20 });

  assert.deepEqual(result.frames.map((frame) => frame.order), [ 1, 3, 5 ]);
  assert.equal(result.newestOrder, 5);
});
