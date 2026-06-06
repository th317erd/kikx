'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  frameDisplayLabel,
  frameSecondaryLabel,
} from '../../src/client/components/frame-labels.mjs';

test('frameDisplayLabel prefers embedded agent author display names', () => {
  let state = {
    agentDetailsByID: {
      agent_1: { id: 'agent_1', name: 'Renamed Later' },
    },
  };

  let frame = {
    type: 'AgentMessage',
    authorType: 'agent',
    authorID: 'agent_1',
    authorDisplayName: 'Mr. Bennett',
  };

  assert.equal(frameDisplayLabel(frame, state), 'Mr. Bennett');
  assert.equal(frameSecondaryLabel(frame), 'AgentMessage');
});

test('frameDisplayLabel resolves agent names from global state when old frames lack display names', () => {
  let frame = {
    type: 'AgentMessage',
    authorType: 'agent',
    authorID: 'agent_1',
  };
  let state = {
    agentDetailsByID: {
      agent_1: { id: 'agent_1', name: 'Test 1' },
    },
  };

  assert.equal(frameDisplayLabel(frame, state), 'Test 1');
});

test('frameDisplayLabel falls back cleanly for agent phantoms and non-agent frames', () => {
  assert.equal(frameDisplayLabel({
    type: 'BeginTyping',
    authorID: 'agent_1',
    content: { agentName: 'Codex' },
  }), 'Codex');
  assert.equal(frameDisplayLabel({ type: 'AgentMessage', authorID: 'agent_1' }), 'agent_1');
  assert.equal(frameDisplayLabel({ type: 'CommandResult', authorID: 'internal:slash-command-router' }), 'CommandResult');
  assert.equal(frameSecondaryLabel({ type: 'CommandResult', authorID: 'internal:slash-command-router' }), 'internal:slash-command-router');
});
