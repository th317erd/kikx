'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { FrameRuntime } from '../../src/core/runtime/frame-runtime.mjs';

function createClient(options = {}) {
  let calls = [];
  return {
    calls,
    async putFile(path, body) {
      calls.push({ method: 'putFile', path, body });

      if (options.failPut)
        throw new Error(options.failPut);

      return { path };
    },
  };
}

function createRuntime(options = {}) {
  let ids = options.ids || [ 'ses_1', 'int_1', 'msg_1', 'commit_1' ];
  let index = 0;

  return new FrameRuntime({
    aeordb: options.aeordb || createClient(),
    clock: () => options.now || 1000,
    idGenerator: () => ids[index++],
  });
}

test('FrameRuntime creates sessions and writes AeorDB index configs', async () => {
  let aeordb = createClient();
  let runtime = createRuntime({ aeordb, ids: [ 'ses_1' ] });

  let session = await runtime.createSession({
    title: 'Scratch',
    organizationID: 'org_1',
    createdByUserID: 'usr_1',
  });

  assert.equal(session.id, 'ses_1');
  assert.equal(session.title, 'Scratch');
  assert.equal(runtime.getSession('ses_1'), session);
  assert.deepEqual(aeordb.calls.map((call) => call.path), [
    '/kikx/sessions/.aeordb-config/indexes.json',
    '/kikx/sessions/ses_1/interactions/.aeordb-config/indexes.json',
    '/kikx/sessions/ses_1/values/.aeordb-config/indexes.json',
    '/kikx/sessions/ses_1/tool-log/.aeordb-config/indexes.json',
    '/kikx/sessions/ses_1/session.json',
  ]);
});

test('FrameRuntime defaults session titles to numbered names', async () => {
  let runtime = createRuntime({ ids: [ 'ses_1', 'ses_2' ] });

  let first = await runtime.createSession();
  let second = await runtime.createSession();

  assert.equal(first.title, 'Session 1');
  assert.equal(second.title, 'Session 2');
});

test('FrameRuntime renames sessions and persists the manifest', async () => {
  let aeordb = createClient();
  let runtime = createRuntime({ aeordb, ids: [ 'ses_1' ], now: 1000 });

  await runtime.createSession();
  runtime.clock = () => 2000;
  let session = await runtime.updateSession('ses_1', { title: 'Project Alpha' });

  assert.equal(session.title, 'Project Alpha');
  assert.equal(session.updatedAt, 2000);
  assert.equal(runtime.getSession('ses_1'), session);
  assert.equal(aeordb.calls.at(-1).path, '/kikx/sessions/ses_1/session.json');
  assert.equal(aeordb.calls.at(-1).body.title, 'Project Alpha');
});

test('FrameRuntime appends user messages through FrameEngine and AeorDBFrameStore', async () => {
  let aeordb = createClient();
  let runtime = createRuntime({ aeordb, ids: [ 'ses_1', 'int_1', 'msg_1', 'commit_1' ] });

  await runtime.createSession({ title: 'Scratch' });
  let result = await runtime.appendUserMessage('ses_1', {
    text: 'hello',
    userID: 'usr_1',
  });

  assert.equal(result.frame.id, 'msg_1');
  assert.equal(result.frame.type, 'UserMessage');
  assert.equal(result.frame.hidden, false);
  assert.equal(result.frame.content.text, 'hello');
  assert.equal(result.commit.id, 'commit_1');
  assert.equal(result.commit.order, 1);
  assert.deepEqual(runtime.listFrames('ses_1').map((frame) => frame.id), [ 'msg_1' ]);
  assert.ok(aeordb.calls.some((call) => call.path === '/kikx/sessions/ses_1/commits/0000000000000001-commit_1.json'));
  assert.ok(aeordb.calls.some((call) => call.path === '/kikx/sessions/ses_1/interactions/int_1/frames/0000000000000001-UserMessage-msg_1.json'));
});

test('FrameRuntime rejects invalid session and message inputs', async () => {
  let runtime = createRuntime();

  await assert.rejects(
    () => runtime.createSession({ title: '' }),
    /title must be a non-empty string/,
  );

  await runtime.createSession({ title: 'Scratch' });

  await assert.rejects(
    () => runtime.appendUserMessage('missing', { text: 'hello' }),
    /Unknown session/,
  );

  await assert.rejects(
    () => runtime.appendUserMessage('ses_1', { text: '   ' }),
    /text must be a non-empty string/,
  );

  await assert.rejects(
    () => runtime.updateSession('missing', { title: 'New title' }),
    /Unknown session/,
  );

  await assert.rejects(
    () => runtime.updateSession('ses_1', { title: '   ' }),
    /title must be a non-empty string/,
  );
});

test('FrameRuntime surfaces AeorDB persistence failures', async () => {
  let aeordb = createClient({ failPut: 'disk is gone' });
  let runtime = createRuntime({ aeordb, ids: [ 'ses_1' ] });

  await assert.rejects(
    () => runtime.createSession({ title: 'Scratch' }),
    /disk is gone/,
  );
});
