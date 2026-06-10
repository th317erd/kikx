'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  frameDisplayLabel,
  frameSecondaryLabel,
  frameTimestamp,
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

test('frameTimestamp prefers createdAt and preserves microsecond precision in metadata', () => {
  let timestamp = frameTimestamp({
    type: 'UserMessage',
    createdAt: 1781035262345678,
    updatedAt: 1781039999999999,
  }, {
    locale: 'en-US',
    timeZone: 'UTC',
  });

  assert.equal(timestamp.dateTime, '2026-06-09T20:01:02.345678Z');
  assert.equal(timestamp.title, '2026-06-09T20:01:02.345678Z');
  assert.match(timestamp.label, /2026/);
  assert.match(timestamp.label, /08:01:02 PM|20:01:02/);
});

test('frameTimestamp falls back to timestamp and returns null for missing values', () => {
  assert.deepEqual(frameTimestamp({ timestamp: 1000 })?.dateTime, '1970-01-01T00:00:01.000Z');
  assert.equal(frameTimestamp({}), null);
});
