'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { FrameEngine } from '../../src/core/frames/index.mjs';

function createEngine(options = {}) {
  let index = 0;
  let now = 1000;
  return new FrameEngine({
    clock: () => ++now,
    idGenerator: () => `commit_${++index}`,
    ...options,
  });
}

test('FrameEngine caps per-id history and keeps the newest versions', () => {
  let engine = createEngine({ historyLimit: 3 });

  for (let index = 1; index <= 10; index++)
    engine.merge([{ id: 'agent_1', type: 'AgentMessage', content: { text: String(index) } }]);

  let history = engine.getVersionHistory('agent_1');
  assert.equal(history.length, 3);
  assert.deepEqual(history.map((frame) => frame.content.text), [ '8', '9', '10' ]);
  assert.equal(engine.get('agent_1').content.text, '10');
});

test('FrameEngine history-disabled mode retains only the latest version', () => {
  let engine = createEngine({ history: false, historyLimit: 5 });

  for (let index = 1; index <= 4; index++)
    engine.merge([{ id: 'agent_1', type: 'AgentMessage', content: { text: String(index) } }]);

  let history = engine.getVersionHistory('agent_1');
  assert.equal(history.length, 1);
  assert.equal(history[0].content.text, '4');
});

test('FrameEngine bounds commits while resolving retained orders by index', () => {
  let engine = createEngine({ commitLimit: 4 });

  for (let index = 1; index <= 8; index++)
    engine.merge([{ id: `msg_${index}`, type: 'UserMessage', content: { text: String(index) } }]);

  let commits = engine.getCommits();
  assert.equal(commits.length, 4);
  assert.deepEqual(commits.map((commit) => commit.order), [ 5, 6, 7, 8 ]);
  assert.equal(engine.getLatestCommit().order, 8);

  // Retained orders resolve without a linear scan.
  assert.equal(engine.getCommit(5).id, commits[0].id);
  assert.equal(engine.getCommit(8).id, commits[3].id);

  // Evicted orders are no longer in memory.
  assert.equal(engine.getCommit(1), undefined);
});

test('FrameEngine diffFrames still works within the retained commit window', () => {
  let engine = createEngine({ commitLimit: 4 });

  for (let index = 1; index <= 8; index++)
    engine.merge([{ id: `msg_${index}`, type: 'UserMessage', content: { text: String(index) } }]);

  assert.deepEqual(engine.getCommits(4, 8).map((commit) => commit.order), [ 5, 6, 7, 8 ]);
  assert.deepEqual(
    engine.diffFrames(5, 'heads/main').map((frame) => frame.id),
    [ 'msg_6', 'msg_7', 'msg_8' ],
  );
});

test('FrameEngine keeps unbounded growth impossible under a streaming burst', () => {
  let engine = createEngine({ historyLimit: 5, commitLimit: 6 });

  for (let index = 0; index < 500; index++)
    engine.merge([{ id: 'stream_1', type: 'AgentMessage', content: { text: 'x'.repeat(index) } }]);

  assert.equal(engine.getVersionHistory('stream_1').length, 5);
  assert.equal(engine.getCommits().length, 6);
});

test('FrameEngine rejects a commit and restores the retained history window', () => {
  let engine = createEngine({
    historyLimit: 2,
    commitLimit: 2,
    commitValidator: (commit) => commit.changes[0]?.frameID !== 'blocked',
  });

  engine.merge([{ id: 'keep_1', type: 'UserMessage', content: { text: 'keep' } }]);
  engine.merge([{ id: 'blocked', type: 'UserMessage', content: { text: 'nope' } }]);

  assert.equal(engine.get('blocked'), undefined);
  assert.equal(engine.getCommits().length, 1);
  assert.equal(engine.getLatestCommit().order, 1);
});
