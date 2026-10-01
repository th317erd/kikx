'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FrameTypeBase,
  FrameTypeDefault,
  FrameTypeUserMessage,
  FrameTypeAgentMessage,
  FrameTypeCommandResult,
  FrameTypeCompactionFrame,
  createTypedFrame,
} from '../../../src/core/frames/frame-types/index.mjs';

test('FrameTypeBase getters delegate to the raw frame data', () => {
  let raw = {
    id: 'frm_1',
    type: 'UserMessage',
    sessionID: 'ses_1',
    interactionID: 'int_1',
    content: { text: 'hello' },
    authorType: 'user',
    authorID: 'usr_1',
    hidden: false,
    deleted: false,
    order: 3,
  };
  let typed = new FrameTypeBase(raw, { registry: null });

  assert.equal(typed.id, 'frm_1');
  assert.equal(typed.type, 'UserMessage');
  assert.equal(typed.sessionID, 'ses_1');
  assert.equal(typed.interactionID, 'int_1');
  assert.equal(typed.content, raw.content);
  assert.equal(typed.authorType, 'user');
  assert.equal(typed.authorID, 'usr_1');
  assert.equal(typed.hidden, false);
  assert.equal(typed.deleted, false);
  assert.equal(typed.order, 3);
  assert.equal(typed.text, 'hello');
});

test('FrameTypeBase defaults to a null turn, null alignment, and system author', () => {
  let typed = new FrameTypeBase({ type: 'Unknown', content: { text: 'x' } });
  assert.equal(typed.toAgentMessage(), null);
  assert.equal(typed.getAlignment(), null);
  assert.equal(typed.getAuthorDisplayName(), 'System');
  assert.equal(typed.isRenderable(), false);
  assert.equal(typed.isHidden(), false);
});

test('FrameTypeBase getAlignment maps known author types and rejects others', () => {
  assert.equal(new FrameTypeBase({ authorType: 'user' }).getAlignment(), 'user');
  assert.equal(new FrameTypeBase({ authorType: 'agent' }).getAlignment(), 'agent');
  assert.equal(new FrameTypeBase({ authorType: 'system' }).getAlignment(), 'system');
  assert.equal(new FrameTypeBase({ authorType: 'robot' }).getAlignment(), null);
});

test('FrameTypeDefault is safe for unknown types', () => {
  let typed = new FrameTypeDefault({ type: 'Nope', content: { text: 'data' } });
  assert.ok(typed instanceof FrameTypeBase);
  assert.equal(typed.isRenderable(), true);
  assert.equal(typed.toAgentMessage(), null);
  assert.equal(typed.getAlignment(), null);
  assert.equal(typed.toMessage(), 'data');
});

test('frameToModelTurn-equivalent mapping for a UserMessage', () => {
  let typed = new FrameTypeUserMessage({ id: 'f1', type: 'UserMessage', content: { text: 'hello' } });
  assert.deepEqual(typed.toAgentMessage(), { role: 'user', content: 'hello' });
  assert.equal(typed.getAlignment(), 'user');
  assert.equal(typed.isRenderable(), true);
  assert.equal(typed.getAuthorDisplayName(), 'You');
});

test('AgentMessage maps own turns to assistant and other agents to wrapped user turns', () => {
  let own = new FrameTypeAgentMessage({ id: 'f1', type: 'AgentMessage', authorID: 'agent_1', content: { text: 'mine' } });
  assert.deepEqual(own.toAgentMessage({ currentAgentID: 'agent_1' }), { role: 'assistant', content: 'mine' });

  let other = new FrameTypeAgentMessage({
    id: 'f2',
    type: 'AgentMessage',
    authorID: 'agent_2',
    authorDisplayName: 'Mr. Bennett',
    content: { text: 'theirs' },
  });
  let turn = other.toAgentMessage({ currentAgentID: 'agent_1' });
  assert.equal(turn.role, 'user');
  assert.match(turn.content, /<agent-message source="agent_2" display-name="Mr\. Bennett">theirs<\/agent-message>/);
  assert.equal(other.getAlignment(), 'agent');
});

test('CommandResult and CompactionFrame project to their expected turns', () => {
  let command = new FrameTypeCommandResult({ id: 'f1', type: 'CommandResult', content: { text: 'ok' } });
  assert.deepEqual(command.toAgentMessage(), { role: 'user', content: '[System command result]\nok' });
  assert.equal(command.getAlignment(), 'system');

  let compaction = new FrameTypeCompactionFrame({
    id: 'cmp_1',
    type: 'CompactionFrame',
    hidden: true,
    content: { kind: 'compaction_frame', summary: 'old memory' },
  });
  let turn = compaction.toAgentMessage();
  assert.equal(turn.role, 'user');
  assert.match(turn.content, /Compacted context memory/);
  assert.match(turn.content, /old memory/);
  assert.equal(compaction.getAlignment(), 'system');
  assert.equal(compaction.isHidden(), true);
});

test('base projection drops deleted, hidden, empty, and unknown frames', () => {
  assert.equal(createTypedFrame({ type: 'UserMessage', deleted: true, content: { text: 'x' } }).toAgentMessage(), null);
  assert.equal(createTypedFrame({ type: 'UserMessage', hidden: true, content: { text: 'x' } }).toAgentMessage(), null);
  assert.equal(createTypedFrame({ type: 'UserMessage', content: { text: '   ' } }).toAgentMessage(), null);
  assert.equal(createTypedFrame({ type: 'AgentProgress', content: { text: 'x' } }).toAgentMessage(), null);
  assert.equal(createTypedFrame(null).toAgentMessage(), null);
});

test('createTypedFrame resolves a known type and falls back to default', () => {
  assert.ok(createTypedFrame({ type: 'UserMessage' }) instanceof FrameTypeUserMessage);
  assert.ok(createTypedFrame({ type: 'SomethingNew' }) instanceof FrameTypeDefault);
});

test('toMessage returns a human-readable summary without needing content', () => {
  assert.equal(new FrameTypeBase({ content: 'raw' }).toMessage(), 'raw');
  assert.equal(new FrameTypeBase({ content: { text: 't' } }).toMessage(), 't');
  assert.equal(new FrameTypeBase({ content: { summary: 's' } }).toMessage(), 's');
  assert.equal(new FrameTypeBase({ content: { output: 'o' } }).toMessage(), 'o');
  assert.equal(new FrameTypeBase({}).toMessage(), '');
});
