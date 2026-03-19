'use strict';

import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import { buildMessages } from '../../../src/core/interaction/message-history.mjs';
import CompactionRunner  from '../../../src/core/compaction/index.mjs';
import { FrameManager }  from '../../../src/shared/frame-manager/frame-manager.mjs';

// =============================================================================
// Helpers
// =============================================================================

function createFrameManager() {
  return new FrameManager({ history: false });
}

function silentLogger() {
  return {
    info:  () => {},
    warn:  () => {},
    error: () => {},
  };
}

function createMockPlugin(overrides = {}) {
  return {
    shouldCompact:          overrides.shouldCompact          || (() => ({ compact: false, reason: '' })),
    getContextWindow:       overrides.getContextWindow       || (() => 200000),
    getModelID:             overrides.getModelID             || (() => 'test-model'),
    getCompactionPrompt:    overrides.getCompactionPrompt    || (() => 'Compact this.'),
    getMaxCompactionTokens: overrides.getMaxCompactionTokens || (() => 4000),
    _createSingleTurn:      overrides._createSingleTurn      || (async () => 'Summary text.'),
  };
}

function createMockAgent(overrides = {}) {
  return {
    id:   'agt_test123',
    name: 'test-compactor',
    ...overrides,
  };
}

/**
 * Seed a FrameManager with conversation frames and return the frames.
 * Each frame gets an `order` property assigned by the FrameManager.
 */
function seedConversation(frameManager, count = 6) {
  let frames = [];

  for (let i = 0; i < count; i++) {
    let isUser = (i % 2 === 0);

    frames.push({
      id:         `frm_seed_${i}`,
      type:       isUser ? 'user-message' : 'message',
      authorType: isUser ? 'user' : 'agent',
      authorID:   isUser ? 'usr_001' : 'agt_test123',
      content:    isUser ? { text: `User message ${i}` } : { html: `<p>Agent reply ${i}</p>` },
      hidden:     false,
      deleted:    false,
    });
  }

  frameManager.merge(frames, { authorType: 'system' });
  return frameManager.toArray();
}

// =============================================================================
// Compaction Integration Tests
// =============================================================================

describe('Compaction Integration', () => {

  // ---------------------------------------------------------------------------
  // Compaction Trigger Tests
  // ---------------------------------------------------------------------------

  describe('Compaction trigger logic', () => {
    let runner;
    let frameManager;

    beforeEach(() => {
      runner       = new CompactionRunner({ logger: silentLogger() });
      frameManager = createFrameManager();
    });

    it('should trigger compaction when shouldCompact returns { compact: true } and no active compaction', async () => {
      let mergedFrames = seedConversation(frameManager);
      let agent        = createMockAgent();

      let compactionRan = false;

      let plugin = createMockPlugin({
        shouldCompact: () => ({ compact: true, reason: 'approaching limit' }),
        _createSingleTurn: async () => {
          compactionRan = true;
          return 'Compressed summary.';
        },
      });

      // Simulate what startInteraction does: check shouldCompact then run compaction
      let stats  = { totalChars: 100000, estimatedTokens: 28571, contextWindow: 200000, modelID: 'test', sessionID: 'ses_001' };
      let result = plugin.shouldCompact(stats);

      assert.equal(result.compact, true);

      let canStart = await runner.canStartCompaction('ses_001', frameManager);
      assert.equal(canStart, true);

      // Fire-and-forget (but here we await for test assertion)
      await runner.runCompaction('ses_001', { agent, plugin, frameManager });

      assert.equal(compactionRan, true, 'Compaction should have run');

      // Verify compaction frame exists
      let compactionFrames = frameManager.toArray().filter((f) => f.type === 'compaction');
      assert.ok(compactionFrames.length >= 1);
      assert.equal(compactionFrames[0].content.status, 'finished');
    });

    it('should NOT trigger compaction when shouldCompact returns { compact: false }', () => {
      let plugin = createMockPlugin({
        shouldCompact: () => ({ compact: false, reason: '' }),
      });

      let stats  = { totalChars: 1000, estimatedTokens: 285, contextWindow: 200000, modelID: 'test', sessionID: 'ses_001' };
      let result = plugin.shouldCompact(stats);

      assert.equal(result.compact, false, 'shouldCompact should return false');
      // No compaction should be initiated — nothing else to check
    });

    it('should NOT trigger compaction when already in progress (canStartCompaction returns false)', async () => {
      seedConversation(frameManager);

      // Add an active compaction frame
      frameManager.merge([{
        id:         'frm_active_compact',
        type:       'compaction',
        authorType: 'system',
        content:    { status: 'started', compactionID: 'frm_active_compact' },
        hidden:     false,
        deleted:    false,
      }], { authorType: 'system' });

      let canStart = await runner.canStartCompaction('ses_001', frameManager);
      assert.equal(canStart, false, 'Should not be able to start compaction when one is in progress');
    });

    it('should not crash the interaction when compaction errors (fire-and-forget error handling)', async () => {
      seedConversation(frameManager);
      let agent = createMockAgent();

      let plugin = createMockPlugin({
        shouldCompact:     () => ({ compact: true }),
        _createSingleTurn: async () => { throw new Error('LLM service unavailable'); },
      });

      // Simulate fire-and-forget: catch the error, do not propagate
      let errorCaught = false;

      let compactionPromise = runner.runCompaction('ses_001', { agent, plugin, frameManager })
        .catch((error) => {
          errorCaught = true;
        });

      // runCompaction should not throw — it catches internally and marks abandoned
      let result = await compactionPromise;

      // The runner catches the LLM error internally and returns null
      assert.equal(result, null, 'Should return null on LLM failure');
      assert.equal(errorCaught, false, 'Error should be caught internally by CompactionRunner, not propagated');

      // Verify the frame was marked abandoned
      let compactionFrames = frameManager.toArray().filter((f) => f.type === 'compaction');
      assert.ok(compactionFrames.length >= 1);
      assert.equal(compactionFrames[0].content.status, 'abandoned');
    });
  });

  // ---------------------------------------------------------------------------
  // Message Filter Tests (buildMessages with activeCompaction)
  // ---------------------------------------------------------------------------

  describe('buildMessages — compaction filter', () => {

    it('should return normal results when no activeCompaction is set (backward compatibility)', () => {
      let frames = [
        { id: 'f1', type: 'user-message', authorType: 'user', content: { text: 'Hello' }, order: 1, hidden: false, deleted: false },
        { id: 'f2', type: 'message', authorType: 'agent', content: { html: 'Hi' }, order: 2, hidden: false, deleted: false },
        { id: 'f3', type: 'user-message', authorType: 'user', content: { text: 'How?' }, order: 3, hidden: false, deleted: false },
      ];

      // No options — backward compat
      let messages = buildMessages(frames);
      assert.equal(messages.length, 3);
      assert.equal(messages[0].role, 'user');
      assert.equal(messages[1].role, 'assistant');
      assert.equal(messages[2].role, 'user');
    });

    it('should return normal results when options is empty object', () => {
      let frames = [
        { id: 'f1', type: 'user-message', authorType: 'user', content: { text: 'Hello' }, order: 1, hidden: false, deleted: false },
        { id: 'f2', type: 'message', authorType: 'agent', content: { html: 'Hi' }, order: 2, hidden: false, deleted: false },
      ];

      let messages = buildMessages(frames, null, {});
      assert.equal(messages.length, 2);
    });

    it('should include all frames before compaction start frame', () => {
      let frames = [
        { id: 'f1', type: 'user-message', authorType: 'user', content: { text: 'msg 1' }, order: 1, hidden: false, deleted: false },
        { id: 'f2', type: 'message', authorType: 'agent', content: { html: 'reply 1' }, order: 2, hidden: false, deleted: false },
        { id: 'f3', type: 'user-message', authorType: 'user', content: { text: 'msg 2' }, order: 3, hidden: false, deleted: false },
        { id: 'f4', type: 'message', authorType: 'agent', content: { html: 'reply 2' }, order: 4, hidden: false, deleted: false },
        // Compaction starts at order 5
        { id: 'f5', type: 'compaction', authorType: 'system', content: { status: 'started' }, order: 5, hidden: false, deleted: false },
        // After compaction start
        { id: 'f6', type: 'user-message', authorType: 'user', content: { text: 'msg 3' }, order: 6, hidden: false, deleted: false },
        { id: 'f7', type: 'message', authorType: 'agent', content: { html: 'reply 3' }, order: 7, hidden: false, deleted: false },
      ];

      let activeCompaction = { order: 5, frameID: 'f5' };
      let messages = buildMessages(frames, null, { activeCompaction });

      // Frames before compaction (f1-f4) should be included
      // f5 (compaction) is type 'compaction' — not in buildMessages output (excluded by EXCLUDED_TYPES? No, but also not handled by any type branch)
      // f6 (user-message, authorType 'user', order 6 > 5) — should be included (user frame)
      // f7 (message, authorType 'agent', order 7 > 5) — should be EXCLUDED

      // f1: user-message (order 1, included)
      // f2: message/agent (order 2, included)
      // f3: user-message (order 3, included)
      // f4: message/agent (order 4, included)
      // f6: user-message (order 6, user, included)
      // Total: 5 messages
      assert.equal(messages.length, 5);

      // Verify first 4 are the pre-compaction messages
      assert.equal(messages[0].content, 'msg 1');
      assert.equal(messages[1].content, 'reply 1');
      assert.equal(messages[2].content, 'msg 2');
      assert.equal(messages[3].content, 'reply 2');
    });

    it('should include user frames after compaction start', () => {
      let frames = [
        { id: 'f1', type: 'user-message', authorType: 'user', content: { text: 'before' }, order: 1, hidden: false, deleted: false },
        { id: 'f2', type: 'compaction', authorType: 'system', content: { status: 'started' }, order: 2, hidden: false, deleted: false },
        { id: 'f3', type: 'user-message', authorType: 'user', content: { text: 'during 1' }, order: 3, hidden: false, deleted: false },
        { id: 'f4', type: 'user-message', authorType: 'user', content: { text: 'during 2' }, order: 4, hidden: false, deleted: false },
      ];

      let activeCompaction = { order: 2, frameID: 'f2' };
      let messages = buildMessages(frames, null, { activeCompaction });

      // f1: included (before compaction)
      // f2: compaction frame — not handled by any type branch, skipped
      // f3: user, order 3 > 2, authorType='user' → included
      // f4: user, order 4 > 2, authorType='user' → included
      assert.equal(messages.length, 3);
      assert.equal(messages[0].content, 'before');
      assert.equal(messages[1].content, 'during 1');
      assert.equal(messages[2].content, 'during 2');
    });

    it('should exclude non-user frames after compaction start', () => {
      let frames = [
        { id: 'f1', type: 'user-message', authorType: 'user', content: { text: 'before' }, order: 1, hidden: false, deleted: false },
        { id: 'f2', type: 'compaction', authorType: 'system', content: { status: 'started' }, order: 2, hidden: false, deleted: false },
        { id: 'f3', type: 'message', authorType: 'agent', content: { html: 'agent after' }, order: 3, hidden: false, deleted: false },
        { id: 'f4', type: 'tool-call', authorType: 'agent', content: { toolName: 'search' }, order: 4, hidden: false, deleted: false },
        { id: 'f5', type: 'tool-result', authorType: 'system', content: { output: 'result' }, order: 5, hidden: false, deleted: false },
        { id: 'f6', type: 'user-message', authorType: 'user', content: { text: 'user after' }, order: 6, hidden: false, deleted: false },
      ];

      let activeCompaction = { order: 2, frameID: 'f2' };
      let messages = buildMessages(frames, null, { activeCompaction });

      // f1: included (before compaction, user)
      // f2: compaction frame — skipped (no type handler)
      // f3: agent message, order 3 > 2, authorType='agent' → EXCLUDED
      // f4: tool-call, order 4 > 2, authorType='agent' → EXCLUDED
      // f5: tool-result, order 5 > 2, authorType='system' → EXCLUDED
      // f6: user-message, order 6 > 2, authorType='user' → included
      assert.equal(messages.length, 2);
      assert.equal(messages[0].content, 'before');
      assert.equal(messages[1].content, 'user after');
    });

    it('should include frames at exact compaction order boundary', () => {
      // The compaction frame itself sits at the boundary order.
      // Frames AT that order (order === activeCompaction.order) should be included.
      let frames = [
        { id: 'f1', type: 'user-message', authorType: 'user', content: { text: 'at boundary' }, order: 5, hidden: false, deleted: false },
        { id: 'f2', type: 'message', authorType: 'agent', content: { html: 'also at boundary' }, order: 5, hidden: false, deleted: false },
        { id: 'f3', type: 'message', authorType: 'agent', content: { html: 'after boundary' }, order: 6, hidden: false, deleted: false },
      ];

      let activeCompaction = { order: 5, frameID: 'compact_id' };
      let messages = buildMessages(frames, null, { activeCompaction });

      // f1: order 5 <= 5, included
      // f2: order 5 <= 5, included
      // f3: order 6 > 5, authorType='agent', EXCLUDED
      assert.equal(messages.length, 2);
      assert.equal(messages[0].content, 'at boundary');
      assert.equal(messages[1].content, 'also at boundary');
    });

    it('should handle activeCompaction with no frames after the compaction order', () => {
      let frames = [
        { id: 'f1', type: 'user-message', authorType: 'user', content: { text: 'only before' }, order: 1, hidden: false, deleted: false },
        { id: 'f2', type: 'message', authorType: 'agent', content: { html: 'reply' }, order: 2, hidden: false, deleted: false },
      ];

      let activeCompaction = { order: 10, frameID: 'compact_id' };
      let messages = buildMessages(frames, null, { activeCompaction });

      // All frames have order <= 10, so all are included
      assert.equal(messages.length, 2);
    });

    it('should work correctly with forAgentID and activeCompaction combined', () => {
      let frames = [
        { id: 'f1', type: 'user-message', authorType: 'user', authorID: 'usr_001', content: { text: 'hello' }, order: 1, hidden: false, deleted: false },
        { id: 'f2', type: 'message', authorType: 'agent', authorID: 'agt_A', content: { html: 'hi from A' }, order: 2, hidden: false, deleted: false },
        { id: 'f3', type: 'message', authorType: 'agent', authorID: 'agt_B', content: { html: 'hi from B' }, order: 3, hidden: false, deleted: false },
        // Compaction starts here
        { id: 'f4', type: 'compaction', authorType: 'system', content: { status: 'started' }, order: 4, hidden: false, deleted: false },
        { id: 'f5', type: 'user-message', authorType: 'user', authorID: 'usr_001', content: { text: 'new user msg' }, order: 5, hidden: false, deleted: false },
        { id: 'f6', type: 'message', authorType: 'agent', authorID: 'agt_A', content: { html: 'agent A after' }, order: 6, hidden: false, deleted: false },
      ];

      let activeCompaction = { order: 4, frameID: 'f4' };

      // From agent B's perspective
      let messages = buildMessages(frames, 'agt_B', { activeCompaction });

      // f1: user-message, order 1, included
      // f2: message from agt_A (not agt_B), order 2, included — wrapped as agent-message
      // f3: message from agt_B (self), order 3, included — standard assistant
      // f4: compaction, skipped
      // f5: user-message, order 5 > 4, authorType='user', included
      // f6: message from agt_A, order 6 > 4, authorType='agent', EXCLUDED
      assert.equal(messages.length, 4);
      assert.equal(messages[0].role, 'user');
      assert.equal(messages[1].role, 'user'); // wrapped agent-message from agt_A
      assert.ok(messages[1].content.includes('agent-message'));
      assert.equal(messages[2].role, 'assistant'); // agt_B's own message
      assert.equal(messages[3].role, 'user'); // user message during compaction
    });
  });

  // ---------------------------------------------------------------------------
  // Cleanup Delegation Tests
  // ---------------------------------------------------------------------------

  describe('cleanupStaleCompactions delegation', () => {
    it('should delegate to CompactionRunner.cleanupStaleCompactions', async () => {
      let runner       = new CompactionRunner({ logger: silentLogger() });
      let frameManager = createFrameManager();

      // Add a stale compaction
      frameManager.merge([{
        id:         'frm_stale',
        type:       'compaction',
        authorType: 'system',
        content:    { status: 'started', compactionID: 'frm_stale' },
        hidden:     false,
        deleted:    false,
      }], { authorType: 'system' });

      let cleaned = await runner.cleanupStaleCompactions(frameManager);
      assert.equal(cleaned, 1, 'Should clean up 1 stale compaction');

      // Verify it was marked abandoned
      let compactionFrames = frameManager.toArray().filter((f) => f.type === 'compaction');
      assert.equal(compactionFrames[0].content.status, 'abandoned');
    });
  });

  // ---------------------------------------------------------------------------
  // Additional edge cases for compaction filter
  // ---------------------------------------------------------------------------

  describe('buildMessages — compaction filter edge cases', () => {

    it('should pass activeCompaction=null through without filtering (explicit null)', () => {
      let frames = [
        { id: 'f1', type: 'user-message', authorType: 'user', content: { text: 'a' }, order: 1, hidden: false, deleted: false },
        { id: 'f2', type: 'message', authorType: 'agent', content: { html: 'b' }, order: 2, hidden: false, deleted: false },
      ];

      let messages = buildMessages(frames, null, { activeCompaction: null });
      assert.equal(messages.length, 2);
    });

    it('should still exclude EXCLUDED_TYPES even during compaction', () => {
      let frames = [
        { id: 'f1', type: 'user-message', authorType: 'user', content: { text: 'msg' }, order: 1, hidden: false, deleted: false },
        { id: 'f2', type: 'error', authorType: 'system', content: { message: 'oops' }, order: 2, hidden: false, deleted: false },
        { id: 'f3', type: 'reflection', authorType: 'agent', content: { text: 'thinking' }, order: 2, hidden: true, deleted: false },
      ];

      let activeCompaction = { order: 10, frameID: 'x' };
      let messages = buildMessages(frames, null, { activeCompaction });

      // error and reflection are excluded regardless of compaction
      assert.equal(messages.length, 1);
      assert.equal(messages[0].content, 'msg');
    });

    it('should handle empty frames array with activeCompaction set', () => {
      let messages = buildMessages([], null, { activeCompaction: { order: 5, frameID: 'x' } });
      assert.deepEqual(messages, []);
    });
  });
});
