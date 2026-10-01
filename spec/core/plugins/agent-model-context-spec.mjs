'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { AgentInterface } from '../../../src/core/plugins/agent-interface.mjs';
import {
  SESSION_SYSTEM_PROMPT,
  buildModelMessages,
  frameToModelTurn,
} from '../../../src/core/plugins/agent-model-context.mjs';

test('frameToModelTurn maps a UserMessage to a user turn', () => {
  let turn = frameToModelTurn({ id: 'f1', type: 'UserMessage', content: { text: 'hello' } });
  assert.deepEqual(turn, { role: 'user', content: 'hello' });
});

test('frameToModelTurn maps an own AgentMessage to assistant and another agent to user', () => {
  let own = frameToModelTurn(
    { id: 'f1', type: 'AgentMessage', authorID: 'agent_1', content: { text: 'mine' } },
    { currentAgentID: 'agent_1' },
  );
  assert.deepEqual(own, { role: 'assistant', content: 'mine' });

  let other = frameToModelTurn(
    { id: 'f2', type: 'AgentMessage', authorID: 'agent_2', authorDisplayName: 'Mr. Bennett', content: { text: 'theirs' } },
    { currentAgentID: 'agent_1' },
  );
  assert.equal(other.role, 'user');
  assert.match(other.content, /<agent-message source="agent_2" display-name="Mr\. Bennett">theirs<\/agent-message>/);
});

test('frameToModelTurn maps a CommandResult to a user turn', () => {
  let turn = frameToModelTurn({ id: 'f1', type: 'CommandResult', content: { text: 'ok' } });
  assert.deepEqual(turn, { role: 'user', content: '[System command result]\nok' });
});

test('frameToModelTurn projects a hidden CompactionFrame summary into a user turn', () => {
  let turn = frameToModelTurn({
    id: 'cmp_1',
    type: 'CompactionFrame',
    hidden: true,
    content: { kind: 'compaction_frame', status: 'complete', summary: 'Earlier the user asked about deploys.' },
  });
  assert.equal(turn.role, 'user');
  assert.match(turn.content, /Compacted context memory/);
  assert.match(turn.content, /Earlier the user asked about deploys\./);
});

test('frameToModelTurn recognizes a compaction frame by content.kind alone', () => {
  let turn = frameToModelTurn({
    id: 'cmp_2',
    type: 'Internal',
    hidden: true,
    content: { kind: 'compaction_frame', summary: 'by kind' },
  });
  assert.match(turn?.content || '', /by kind/);
});

test('frameToModelTurn falls back to content.text for a compaction frame with no summary', () => {
  let turn = frameToModelTurn({
    id: 'cmp_3',
    type: 'CompactionFrame',
    hidden: true,
    content: { kind: 'compaction_frame', text: 'fallback text' },
  });
  assert.match(turn?.content || '', /fallback text/);
});

test('frameToModelTurn drops other hidden, deleted, empty, and unknown frames', () => {
  assert.equal(frameToModelTurn({ id: 'f1', type: 'UserMessage', hidden: true, content: { text: 'x' } }), null);
  assert.equal(frameToModelTurn({ id: 'f2', type: 'UserMessage', deleted: true, content: { text: 'x' } }), null);
  assert.equal(frameToModelTurn({ id: 'f3', type: 'UserMessage', content: { text: '   ' } }), null);
  assert.equal(frameToModelTurn({ id: 'f4', type: 'AgentProgress', content: { text: 'x' } }), null);
  assert.equal(frameToModelTurn(null), null);
});

test('buildModelMessages assembles system, frame turns (sans trigger frame), then the newest prompt', () => {
  let messages = buildModelMessages({
    prompt: 'newest question',
    frame: { id: 'trigger', type: 'UserMessage', content: { text: 'newest question' } },
    agent: { id: 'agent_1' },
    frames: [
      { id: 'cmp_1', type: 'CompactionFrame', hidden: true, content: { kind: 'compaction_frame', summary: 'old memory' } },
      { id: 'old_user', type: 'UserMessage', content: { text: 'older turn' } },
      { id: 'trigger', type: 'UserMessage', content: { text: 'newest question' } },
    ],
  });

  assert.equal(messages[0].role, 'system');
  assert.equal(messages[0].content, SESSION_SYSTEM_PROMPT);
  assert.equal(messages[1].role, 'user');
  assert.match(messages[1].content, /old memory/);
  assert.deepEqual(messages[2], { role: 'user', content: 'older turn' });
  assert.deepEqual(messages.at(-1), { role: 'user', content: 'newest question' });
  // The trigger frame must not be duplicated as a history turn.
  assert.equal(messages.filter((m) => m.content === 'newest question').length, 1);
});

test('buildModelMessages uses the triggering frame text when no prompt is supplied', () => {
  let messages = buildModelMessages({
    frame: { id: 'trigger', type: 'UserMessage', content: { text: 'from frame' } },
    frames: [],
  });
  assert.deepEqual(messages.at(-1), { role: 'user', content: 'from frame' });
});

test('AgentInterface exposes the shared projection', () => {
  assert.equal(typeof AgentInterface.buildModelMessages, 'function');
  assert.equal(typeof AgentInterface.frameToModelTurn, 'function');
  assert.equal(AgentInterface.SESSION_SYSTEM_PROMPT, SESSION_SYSTEM_PROMPT);
  assert.deepEqual(
    AgentInterface.buildModelMessages({ prompt: 'p', frames: [] }),
    buildModelMessages({ prompt: 'p', frames: [] }),
  );
});
