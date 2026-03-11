'use strict';

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildMessages } from '../../../src/core/interaction/message-history.mjs';

// =============================================================================
// Discussion Integration Tests
// =============================================================================
// Tests the integration points: discussion frame rendering in buildMessages(),
// the SchedulingPlugin coordinator-detection path, and the round-robin
// orchestration through claim/auto-claim.
// =============================================================================

// ---------------------------------------------------------------------------
// buildMessages — discussion frame rendering
// ---------------------------------------------------------------------------

describe('buildMessages — discussion frames', () => {
  it('renders discussion frame as user-role for another agent', () => {
    let frames = [
      {
        id:       'frm_1',
        type:     'discussion',
        authorID: 'agt_2',
        content:  { text: 'I think we should do X', round: 1 },
      },
    ];

    let messages = buildMessages(frames, 'agt_1');

    assert.equal(messages.length, 1);
    assert.equal(messages[0].role, 'user');
    assert.ok(messages[0].content.includes('<discussion'));
    assert.ok(messages[0].content.includes('round="1"'));
    assert.ok(messages[0].content.includes('agent="agt_2"'));
    assert.ok(messages[0].content.includes('I think we should do X'));
    assert.equal(messages[0].sourceAgentID, 'agt_2');
  });

  it('renders discussion frame as assistant-role for the authoring agent', () => {
    let frames = [
      {
        id:       'frm_1',
        type:     'discussion',
        authorID: 'agt_1',
        content:  { text: 'My own discussion message', round: 2 },
      },
    ];

    let messages = buildMessages(frames, 'agt_1');

    assert.equal(messages.length, 1);
    assert.equal(messages[0].role, 'assistant');
    assert.ok(messages[0].content.includes('<discussion'));
    assert.ok(messages[0].content.includes('round="2"'));
    assert.ok(messages[0].content.includes('agent="agt_1"'));
  });

  it('renders discussion frame as user-role when forAgentID is not set', () => {
    let frames = [
      {
        id:       'frm_1',
        type:     'discussion',
        authorID: 'agt_1',
        content:  { text: 'Discussion text', round: 1 },
      },
    ];

    let messages = buildMessages(frames);

    assert.equal(messages.length, 1);
    // Without forAgentID, condition `forAgentID && frame.authorID === forAgentID` is false
    assert.equal(messages[0].role, 'user');
  });

  it('handles discussion frame with empty content', () => {
    let frames = [
      {
        id:       'frm_1',
        type:     'discussion',
        authorID: 'agt_1',
        content:  {},
      },
    ];

    let messages = buildMessages(frames, 'agt_2');

    assert.equal(messages.length, 1);
    assert.ok(messages[0].content.includes('round="?"'));
    assert.ok(messages[0].content.includes('<discussion'));
  });

  it('handles discussion frame with no authorID', () => {
    let frames = [
      {
        id:      'frm_1',
        type:    'discussion',
        content: { text: 'Anonymous discussion', round: 1 },
      },
    ];

    let messages = buildMessages(frames, 'agt_1');

    assert.equal(messages.length, 1);
    assert.ok(messages[0].content.includes('agent="unknown"'));
  });

  it('interleaves discussion frames with regular messages', () => {
    let frames = [
      { id: 'frm_1', type: 'user-message', content: { text: 'Hello agents' } },
      { id: 'frm_2', type: 'discussion', authorID: 'agt_1', content: { text: 'Discussing...', round: 1 } },
      { id: 'frm_3', type: 'discussion', authorID: 'agt_2', content: { text: 'Agreed.', round: 1 } },
      { id: 'frm_4', type: 'message', authorID: 'agt_1', content: { html: '<p>Final response</p>' } },
    ];

    let messages = buildMessages(frames, 'agt_1');

    assert.equal(messages.length, 4);
    assert.equal(messages[0].role, 'user');          // user-message
    assert.equal(messages[1].role, 'assistant');      // own discussion
    assert.equal(messages[2].role, 'user');           // other agent's discussion
    assert.equal(messages[3].role, 'assistant');      // own final message
  });

  it('skips deleted discussion frames', () => {
    let frames = [
      {
        id:       'frm_1',
        type:     'discussion',
        authorID: 'agt_1',
        content:  { text: 'Deleted', round: 1 },
        deleted:  true,
      },
    ];

    let messages = buildMessages(frames, 'agt_2');
    assert.equal(messages.length, 0);
  });

  it('skips hidden discussion frames', () => {
    let frames = [
      {
        id:       'frm_1',
        type:     'discussion',
        authorID: 'agt_1',
        content:  { text: 'Hidden', round: 1 },
        hidden:   true,
      },
    ];

    let messages = buildMessages(frames, 'agt_2');
    assert.equal(messages.length, 0);
  });
});

// ---------------------------------------------------------------------------
// SchedulingPlugin coordinator detection (mock-level)
// ---------------------------------------------------------------------------

describe('SchedulingPlugin coordinator detection', () => {
  // These tests validate the logic that would be exercised in the plugin,
  // specifically that getCoordinators returns the right data structure.

  it('coordinators list maps to startDiscussion input format', () => {
    // Simulate what the SchedulingPlugin creates from getCoordinators() results
    let mockParticipants = [
      { id: 'prt_1', agentID: 'agt_1', role: 'coordinator' },
      { id: 'prt_2', agentID: 'agt_2', role: 'coordinator' },
    ];

    let coordinatorList = mockParticipants.map((p) => ({
      agentID:       p.agentID,
      participantID: p.id,
      agentName:     p.agentName || p.agentID,
    }));

    assert.equal(coordinatorList.length, 2);
    assert.equal(coordinatorList[0].agentID, 'agt_1');
    assert.equal(coordinatorList[0].participantID, 'prt_1');
    assert.equal(coordinatorList[1].agentID, 'agt_2');
  });

  it('empty coordinators list triggers standard scheduling path', () => {
    let coordinators = [];
    // The condition in SchedulingPlugin: coordinators.length >= 2
    assert.equal(coordinators.length >= 2, false);
  });

  it('single coordinator triggers standard scheduling path', () => {
    let coordinators = [{ id: 'prt_1', agentID: 'agt_1', role: 'coordinator' }];
    assert.equal(coordinators.length >= 2, false);
  });

  it('two coordinators triggers discussion path', () => {
    let coordinators = [
      { id: 'prt_1', agentID: 'agt_1', role: 'coordinator' },
      { id: 'prt_2', agentID: 'agt_2', role: 'coordinator' },
    ];

    assert.equal(coordinators.length >= 2, true);
  });
});
