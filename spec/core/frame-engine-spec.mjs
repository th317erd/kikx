'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { deepMerge, FrameEngine } from '../../src/core/frames/index.mjs';

function engine() {
  let now = 1000;
  let ids = 0;
  return new FrameEngine({
    clock: () => ++now,
    idGenerator: () => `commit_${++ids}`,
  });
}

test('deepMerge deletes null keys, replaces arrays, recurses objects, and blocks prototype pollution', () => {
  let output = deepMerge(
    { a: { b: 1, c: 2 }, tags: [ 'old' ], keep: true },
    JSON.parse('{"a":{"b":null},"tags":["new"],"__proto__":{"polluted":true}}'),
  );

  assert.deepEqual(output, {
    a: { c: 2 },
    tags: [ 'new' ],
    keep: true,
  });
  assert.equal({}.polluted, undefined);
});

test('FrameEngine creates frames and a commit', () => {
  let frames = engine();
  let commits = [];
  frames.on('commit', (event) => commits.push(event.commit));

  let result = frames.merge([
    { id: 'frm_1', type: 'UserMessage', content: { text: 'hello' }, hidden: false },
  ], { authorType: 'user', authorID: 'usr_1' });

  assert.equal(result.length, 1);
  assert.equal(frames.get('frm_1').type, 'UserMessage');
  assert.equal(frames.get('frm_1').hidden, false);
  assert.equal(commits.length, 1);
  assert.equal(commits[0].authorType, 'user');
  assert.deepEqual(commits[0].changes, [
    { frameID: 'frm_1', operation: 'create' },
  ]);
  assert.equal(frames.getRef('heads/main'), 1);
});

test('FrameEngine requires merge input to be an array and skips malformed frames', () => {
  let frames = engine();

  assert.throws(() => frames.merge({ id: 'frm_1', type: 'UserMessage' }), /requires an array/);
  assert.deepEqual(frames.merge([{ id: 'missing_type' }, { type: 'MissingID' }]), []);
  assert.equal(frames.toArray().length, 0);
});

test('FrameEngine target merges only mergeable fields and keeps target identity stable', () => {
  let frames = engine();
  frames.merge([
    { id: 'prompt_1', type: 'HMLPrompt', content: { values: { name: '' } }, hidden: false },
  ]);

  frames.merge([
    {
      id: 'answer_1',
      type: 'HMLPromptValue',
      targets: [ 'prompt_1' ],
      content: { values: { name: 'Wyatt' } },
      typeOverride: 'Nope',
      hidden: true,
    },
  ]);

  let prompt = frames.get('prompt_1');
  assert.equal(prompt.id, 'prompt_1');
  assert.equal(prompt.type, 'HMLPrompt');
  assert.equal(prompt.hidden, true);
  assert.deepEqual(prompt.content, { values: { name: 'Wyatt' } });
  assert.equal(frames.getVersionHistory('prompt_1').length, 2);
});

test('FrameEngine sorts by stable frame creation order after later updates', () => {
  let frames = engine();
  frames.merge([{ id: 'agent_1', type: 'AgentMessage', content: { text: '' }, hidden: true }]);
  frames.merge([{ id: 'user_1', type: 'UserMessage', content: { text: 'later user' }, hidden: false }]);
  frames.merge([{ id: 'agent_1', type: 'AgentMessage', content: { text: 'final' }, hidden: false }]);

  assert.equal(frames.get('agent_1').order, 1);
  assert.equal(frames.get('agent_1').commitOrder, 3);
  assert.equal(frames.get('user_1').order, 2);
  assert.deepEqual(frames.toArray().map((frame) => frame.id), [ 'agent_1', 'user_1' ]);
});

test('FrameEngine stamps frames with sortable created and updated clocks', () => {
  let now = 1_000;
  let frames = new FrameEngine({
    clock: () => now,
    runnerID: 'test-runner',
    idGenerator: (() => {
      let index = 0;
      return () => `commit_${++index}`;
    })(),
  });

  frames.merge([{ id: 'agent_1', type: 'AgentMessage', content: { text: '' }, hidden: true }]);
  now = 1_001;
  frames.merge([{ id: 'user_1', type: 'UserMessage', content: { text: 'after initial response' }, hidden: false }]);
  now = 1_002;
  frames.merge([{ id: 'agent_1', type: 'AgentMessage', content: { text: 'final response' }, hidden: false }]);

  let agent = frames.get('agent_1');
  let user = frames.get('user_1');

  assert.equal(agent.createdAt, 1_000_000);
  assert.equal(agent.updatedAt, 1_002_000);
  assert.equal(agent.createdClock, '0000000001000000-000000-test-runner');
  assert.equal(agent.updatedClock, '0000000001002000-000000-test-runner');
  assert.equal(user.updatedClock, '0000000001001000-000000-test-runner');
  assert.deepEqual(frames.toArray().map((frame) => frame.id), [ 'agent_1', 'user_1' ]);
});

test('FrameEngine live frames collapse into a persistent group frame', () => {
  let frames = engine();

  frames.merge([
    {
      id: 'delta_1',
      type: 'MessageDelta',
      phantom: true,
      groupID: 'msg_1',
      groupType: 'Message',
      content: { text: 'hel' },
    },
    {
      id: 'delta_2',
      type: 'MessageDelta',
      phantom: true,
      groupID: 'msg_1',
      groupType: 'Message',
      content: { text: 'hello' },
    },
  ]);

  assert.equal(frames.get('delta_1'), undefined);
  assert.equal(frames.get('msg_1').type, 'Message');
  assert.deepEqual(frames.get('msg_1').content, { text: 'hello' });
});

test('FrameEngine emits event-only phantom frames without creating commits', () => {
  let frames = engine();
  let phantoms = [];
  let commits = [];
  frames.on('frame:phantom', ({ frame }) => phantoms.push(frame));
  frames.on('commit', ({ commit }) => commits.push(commit));

  let result = frames.merge([
    {
      id: 'delta_1',
      type: 'AgentThinking',
      phantom: true,
      content: { text: 'thinking' },
    },
  ]);

  assert.deepEqual(result, []);
  assert.equal(frames.get('delta_1'), undefined);
  assert.deepEqual(phantoms.map((frame) => frame.content.text), [ 'thinking' ]);
  assert.deepEqual(commits, []);
});

test('FrameEngine refs and diffFrames expose persistent promise-style progress', () => {
  let frames = engine();
  frames.merge([{ id: 'req_1', type: 'ToolCall', content: { toolName: 'shell:execute' } }]);
  frames.createRef('processed/agent_1', 1);
  frames.merge([{ id: 'perm_1', type: 'PermissionRequest', content: { status: 'pending' } }]);

  assert.deepEqual(frames.diffFrames('processed/agent_1', 'heads/main').map((frame) => frame.id), [ 'perm_1' ]);
  frames.updateRef('processed/agent_1', 2);
  assert.deepEqual(frames.diffFrames('processed/agent_1', 'heads/main'), []);
});

test('FrameEngine hydrates persisted frames without emitting commits', () => {
  let frames = engine();
  let commits = [];
  frames.on('commit', (event) => commits.push(event.commit));

  frames.hydrate([
    {
      id: 'msg_2',
      type: 'UserMessage',
      order: 2,
      content: { text: 'two' },
      hidden: false,
      updatedClock: '0000000001002000-000000-test',
    },
    {
      id: 'msg_1',
      type: 'UserMessage',
      order: 1,
      content: { text: 'one' },
      hidden: false,
      updatedClock: '0000000001001000-000000-test',
    },
  ]);

  assert.deepEqual(frames.toArray().map((frame) => frame.id), [ 'msg_1', 'msg_2' ]);
  assert.equal(frames.getRef('heads/main'), 2);
  assert.deepEqual(commits, []);

  frames.merge([{ id: 'msg_3', type: 'UserMessage', content: { text: 'three' }, hidden: false }]);
  assert.equal(frames.getLatestCommit().order, 3);
});
