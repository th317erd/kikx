'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveFrameRecipients,
  resolveRouteTargets,
} from '../../../src/core/agents/agent-route/targeting.mjs';

const PARTICIPANTS = [ 'agent_1', 'agent_2', 'agent_3' ];
const COORDINATOR = 'agent_1';

function targets(frame, participants = PARTICIPANTS, coordinatorAgentID = COORDINATOR) {
  return resolveRouteTargets({ frame, participantAgentIDs: participants, coordinatorAgentID });
}

test('resolveRouteTargets sends an unaddressed user message to the coordinator only', () => {
  let result = targets({
    id: 'msg_1',
    type: 'UserMessage',
    authorType: 'user',
    content: { text: 'hello everyone' },
  });

  assert.deepEqual(result, [ 'agent_1' ]);
});

test('resolveRouteTargets adds explicit recipients to the coordinator', () => {
  let result = targets({
    id: 'msg_1',
    type: 'UserMessage',
    authorType: 'user',
    content: { text: 'Reviewer, look' },
    recipients: [ 'agent_3' ],
  });

  assert.deepEqual(result.sort(), [ 'agent_1', 'agent_3' ]);
});

test('resolveRouteTargets derives recipients from resolved mentions', () => {
  let result = targets({
    id: 'msg_1',
    type: 'UserMessage',
    authorType: 'user',
    content: { text: '@agent_2 please' },
    mentions: {
      agent_2: { id: 'agent_2', type: 'agent', name: 'Reviewer' },
    },
  });

  assert.deepEqual(result.sort(), [ 'agent_1', 'agent_2' ]);
});

test('resolveRouteTargets never targets the author of the frame', () => {
  let result = targets({
    id: 'msg_1',
    type: 'AgentMessage',
    authorType: 'agent',
    authorID: 'agent_2',
    content: { text: 'here is my answer' },
  });

  assert.deepEqual(result, [ 'agent_1' ]);
  assert.equal(result.includes('agent_2'), false);
});

test('resolveRouteTargets sends an unaddressed agent reply to the coordinator only', () => {
  let result = targets({
    id: 'reply_1',
    type: 'AgentMessage',
    authorType: 'agent',
    authorID: 'agent_3',
    content: { text: 'done' },
  });

  assert.deepEqual(result, [ 'agent_1' ]);
});

test('resolveRouteTargets honors an explicit targetAgentID bypass over routing', () => {
  let result = targets({
    id: 'wake_1',
    type: 'UserMessage',
    authorType: 'system',
    authorID: 'internal:process-manager',
    targetAgentID: 'agent_3',
    content: { text: 'wake' },
  });

  assert.deepEqual(result, [ 'agent_3' ]);
});

test('resolveRouteTargets drops a targetAgentID that is not a participant', () => {
  let result = targets({
    id: 'wake_1',
    type: 'UserMessage',
    authorType: 'system',
    targetAgentID: 'agent_missing',
    content: { text: 'wake' },
  });

  assert.deepEqual(result, []);
});

test('resolveRouteTargets routes a coordinated frame to its recipients only, not the coordinator', () => {
  let result = targets({
    id: 'msg_1',
    type: 'UserMessage',
    authorType: 'user',
    coordinated: true,
    recipients: [ 'agent_2', 'agent_3' ],
    content: { text: 'routed' },
  });

  assert.deepEqual(result.sort(), [ 'agent_2', 'agent_3' ]);
});

test('resolveRouteTargets filters a coordinated frame author from its own recipients', () => {
  let result = targets({
    id: 'agent_msg_1',
    type: 'AgentMessage',
    authorType: 'agent',
    authorID: 'agent_2',
    coordinated: true,
    recipients: [ 'agent_2', 'agent_3' ],
    content: { text: 'routed reply' },
  });

  assert.deepEqual(result, [ 'agent_3' ]);
});

test('resolveRouteTargets ignores recipients that are not participants', () => {
  let result = targets({
    id: 'msg_1',
    type: 'UserMessage',
    authorType: 'user',
    recipients: [ 'outsider', 'agent_2' ],
    content: { text: 'hi' },
  });

  assert.deepEqual(result.sort(), [ 'agent_1', 'agent_2' ]);
});

test('resolveRouteTargets returns no targets when there are no participants', () => {
  let result = resolveRouteTargets({
    frame: { id: 'msg_1', type: 'UserMessage', authorType: 'user', content: { text: 'hi' } },
    participantAgentIDs: [],
    coordinatorAgentID: null,
  });

  assert.deepEqual(result, []);
});

test('resolveFrameRecipients prefers explicit recipients over mentions', () => {
  let value = resolveFrameRecipients({
    recipients: [ 'agent_3' ],
    mentions: { agent_2: { id: 'agent_2' } },
  });

  assert.deepEqual(value, [ 'agent_3' ]);
});

test('resolveFrameRecipients derives from mentions when recipients are absent', () => {
  let value = resolveFrameRecipients({
    mentions: {
      agent_2: { id: 'agent_2' },
      agent_3: { id: 'agent_3' },
    },
  });

  assert.deepEqual(value.sort(), [ 'agent_2', 'agent_3' ]);
});

test('resolveFrameRecipients returns empty for an unaddressed frame', () => {
  assert.deepEqual(resolveFrameRecipients({ content: { text: 'hi' } }), []);
  assert.deepEqual(resolveFrameRecipients(null), []);
});
