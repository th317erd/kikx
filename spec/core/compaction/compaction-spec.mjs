'use strict';

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import CompactionRunner, { DEFAULT_COMPACTION_PROMPT } from '../../../src/core/compaction/index.mjs';
import { FrameManager } from '../../../src/shared/frame-manager/frame-manager.mjs';

// =============================================================================
// Helpers
// =============================================================================

function createFrameManager() {
  return new FrameManager({ history: false });
}

function createMockPlugin(options = {}) {
  return {
    getCompactionPrompt:    options.getCompactionPrompt    || (() => 'Compact this conversation.'),
    getMaxCompactionTokens: options.getMaxCompactionTokens || (() => 4000),
    _createSingleTurn:      options._createSingleTurn      || (async () => 'Summary of conversation.'),
  };
}

function createMockAgent(overrides = {}) {
  return {
    id:   'agt_test123',
    name: 'test-compactor',
    ...overrides,
  };
}

function silentLogger() {
  return {
    info:  () => {},
    warn:  () => {},
    error: () => {},
  };
}

/**
 * Seed a FrameManager with a set of conversational frames.
 * Returns the list of frame data objects that were merged.
 */
function seedConversation(fm, count = 5) {
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

  fm.merge(frames, { authorType: 'system' });
  return frames;
}

// =============================================================================
// CompactionRunner — Unit Tests
// =============================================================================

describe('CompactionRunner', () => {
  let runner;
  let fm;
  let plugin;
  let agent;

  beforeEach(() => {
    runner = new CompactionRunner({ logger: silentLogger() });
    fm     = createFrameManager();
    plugin = createMockPlugin();
    agent  = createMockAgent();
  });

  // ---------------------------------------------------------------------------
  // canStartCompaction
  // ---------------------------------------------------------------------------

  describe('canStartCompaction()', () => {
    it('should return true when no compaction frames exist', async () => {
      seedConversation(fm);
      let result = await runner.canStartCompaction('ses_001', fm);
      assert.equal(result, true);
    });

    it('should return true when only finished compaction frames exist', async () => {
      seedConversation(fm);

      fm.merge([{
        id:         'frm_compact_done',
        type:       'compaction',
        authorType: 'system',
        content:    { status: 'finished', summary: 'old summary' },
        hidden:     false,
        deleted:    false,
      }], { authorType: 'system' });

      let result = await runner.canStartCompaction('ses_001', fm);
      assert.equal(result, true);
    });

    it('should return true when only abandoned compaction frames exist', async () => {
      seedConversation(fm);

      fm.merge([{
        id:         'frm_compact_abandoned',
        type:       'compaction',
        authorType: 'system',
        content:    { status: 'abandoned' },
        hidden:     false,
        deleted:    false,
      }], { authorType: 'system' });

      let result = await runner.canStartCompaction('ses_001', fm);
      assert.equal(result, true);
    });

    it('should return false when a started compaction frame exists', async () => {
      seedConversation(fm);

      fm.merge([{
        id:         'frm_compact_active',
        type:       'compaction',
        authorType: 'system',
        content:    { status: 'started', compactionID: 'frm_compact_active' },
        hidden:     false,
        deleted:    false,
      }], { authorType: 'system' });

      let result = await runner.canStartCompaction('ses_001', fm);
      assert.equal(result, false);
    });

    it('should return true for empty FrameManager', async () => {
      let result = await runner.canStartCompaction('ses_001', fm);
      assert.equal(result, true);
    });
  });

  // ---------------------------------------------------------------------------
  // runCompaction — Happy Paths
  // ---------------------------------------------------------------------------

  describe('runCompaction() — happy paths', () => {
    it('should create a compaction frame with status=started', async () => {
      seedConversation(fm);

      let framesBefore = fm.toArray().length;

      await runner.runCompaction('ses_001', { agent, plugin, frameManager: fm });

      // A compaction frame should exist
      let compactionFrames = fm.toArray().filter((f) => f.type === 'compaction');
      assert.ok(compactionFrames.length >= 1, 'Should have at least one compaction frame');

      // The compaction frame content should have been updated to 'finished'
      // (since the mock plugin returns successfully)
      let latest = compactionFrames[0];
      assert.equal(latest.content.status, 'finished');
    });

    it('should call _createSingleTurn with correct messages', async () => {
      seedConversation(fm, 3);

      let capturedMessages = null;
      let capturedOptions  = null;

      plugin._createSingleTurn = async (messages, options) => {
        capturedMessages = messages;
        capturedOptions  = options;
        return 'Compressed summary.';
      };

      await runner.runCompaction('ses_001', { agent, plugin, frameManager: fm });

      assert.ok(capturedMessages, 'Should have called _createSingleTurn');
      assert.equal(capturedMessages.length, 1);
      assert.equal(capturedMessages[0].role, 'user');
      assert.ok(capturedMessages[0].content.includes('Compact this conversation.'),
        'Should include the compaction prompt');
      assert.ok(capturedMessages[0].content.includes('User message 0'),
        'Should include frame content');
      assert.ok(capturedOptions.maxTokens, 'Should pass maxTokens');
    });

    it('should update compaction frame to status=finished with summary', async () => {
      seedConversation(fm);

      plugin._createSingleTurn = async () => 'This is the compressed summary.';

      await runner.runCompaction('ses_001', { agent, plugin, frameManager: fm });

      let compactionFrames = fm.toArray().filter((f) => f.type === 'compaction');
      assert.ok(compactionFrames.length >= 1);

      let compFrame = compactionFrames[0];
      assert.equal(compFrame.content.status, 'finished');
      assert.equal(compFrame.content.summary, 'This is the compressed summary.');
      assert.ok(compFrame.content.finishedAt, 'Should have finishedAt timestamp');
      assert.equal(compFrame.content.compactorAgentID, 'agt_test123');
    });

    it('should record correct framesCompacted count', async () => {
      seedConversation(fm, 7);

      await runner.runCompaction('ses_001', { agent, plugin, frameManager: fm });

      let compactionFrames = fm.toArray().filter((f) => f.type === 'compaction');
      let compFrame        = compactionFrames[0];

      assert.equal(compFrame.content.framesCompacted, 7);
    });

    it('should record firstFrameID and lastFrameID', async () => {
      seedConversation(fm, 4);

      await runner.runCompaction('ses_001', { agent, plugin, frameManager: fm });

      let compactionFrames = fm.toArray().filter((f) => f.type === 'compaction');
      let compFrame        = compactionFrames[0];

      assert.equal(compFrame.content.firstFrameID, 'frm_seed_0');
      assert.equal(compFrame.content.lastFrameID, 'frm_seed_3');
    });

    it('should return the compaction frame ID on success', async () => {
      seedConversation(fm);

      let result = await runner.runCompaction('ses_001', { agent, plugin, frameManager: fm });

      assert.ok(result, 'Should return a frame ID');
      assert.ok(result.startsWith('frm_'), 'Should be a frame ID');
    });

    it('should use DEFAULT_COMPACTION_PROMPT when plugin has no getCompactionPrompt', async () => {
      seedConversation(fm, 2);

      let capturedMessages = null;

      plugin._createSingleTurn = async (messages) => {
        capturedMessages = messages;
        return 'Summary.';
      };

      delete plugin.getCompactionPrompt;

      await runner.runCompaction('ses_001', { agent, plugin, frameManager: fm });

      assert.ok(capturedMessages[0].content.includes('VITALLY IMPORTANT'),
        'Should use the default compaction prompt');
    });

    it('should use default maxTokens=8000 when plugin has no getMaxCompactionTokens', async () => {
      seedConversation(fm, 2);

      let capturedOptions = null;

      plugin._createSingleTurn = async (_messages, options) => {
        capturedOptions = options;
        return 'Summary.';
      };

      delete plugin.getMaxCompactionTokens;

      await runner.runCompaction('ses_001', { agent, plugin, frameManager: fm });

      assert.equal(capturedOptions.maxTokens, 8000);
    });
  });

  // ---------------------------------------------------------------------------
  // runCompaction — Failure Paths
  // ---------------------------------------------------------------------------

  describe('runCompaction() — failure paths', () => {
    it('should mark frame abandoned when _createSingleTurn throws', async () => {
      seedConversation(fm);

      plugin._createSingleTurn = async () => {
        throw new Error('API rate limit exceeded');
      };

      let result = await runner.runCompaction('ses_001', { agent, plugin, frameManager: fm });

      assert.equal(result, null, 'Should return null on failure');

      let compactionFrames = fm.toArray().filter((f) => f.type === 'compaction');
      assert.ok(compactionFrames.length >= 1);
      assert.equal(compactionFrames[0].content.status, 'abandoned');
      assert.ok(compactionFrames[0].content.finishedAt, 'Should have finishedAt even on abandon');
    });

    it('should mark frame abandoned when summary is empty string', async () => {
      seedConversation(fm);

      plugin._createSingleTurn = async () => '';

      let result = await runner.runCompaction('ses_001', { agent, plugin, frameManager: fm });

      assert.equal(result, null);

      let compactionFrames = fm.toArray().filter((f) => f.type === 'compaction');
      assert.equal(compactionFrames[0].content.status, 'abandoned');
    });

    it('should mark frame abandoned when summary is whitespace-only', async () => {
      seedConversation(fm);

      plugin._createSingleTurn = async () => '   \n  \t  ';

      let result = await runner.runCompaction('ses_001', { agent, plugin, frameManager: fm });

      assert.equal(result, null);

      let compactionFrames = fm.toArray().filter((f) => f.type === 'compaction');
      assert.equal(compactionFrames[0].content.status, 'abandoned');
    });

    it('should mark frame abandoned when summary is null', async () => {
      seedConversation(fm);

      plugin._createSingleTurn = async () => null;

      let result = await runner.runCompaction('ses_001', { agent, plugin, frameManager: fm });

      assert.equal(result, null);

      let compactionFrames = fm.toArray().filter((f) => f.type === 'compaction');
      assert.equal(compactionFrames[0].content.status, 'abandoned');
    });

    it('should return early if compaction already in progress (race guard)', async () => {
      seedConversation(fm);

      // Simulate an in-progress compaction
      fm.merge([{
        id:         'frm_existing_compact',
        type:       'compaction',
        authorType: 'system',
        content:    { status: 'started', compactionID: 'frm_existing_compact' },
        hidden:     false,
        deleted:    false,
      }], { authorType: 'system' });

      let called = false;
      plugin._createSingleTurn = async () => {
        called = true;
        return 'Should not reach here.';
      };

      let result = await runner.runCompaction('ses_001', { agent, plugin, frameManager: fm });

      assert.equal(result, null, 'Should return null when compaction already active');
      assert.equal(called, false, 'Should NOT call _createSingleTurn');
    });

    it('should not throw when _createSingleTurn throws — error is caught', async () => {
      seedConversation(fm);

      plugin._createSingleTurn = async () => {
        throw new TypeError('Cannot read properties of undefined');
      };

      // Should not throw
      await runner.runCompaction('ses_001', { agent, plugin, frameManager: fm });
    });
  });

  // ---------------------------------------------------------------------------
  // runCompaction — Edge Cases
  // ---------------------------------------------------------------------------

  describe('runCompaction() — edge cases', () => {
    it('should return null for empty session (no frames)', async () => {
      let result = await runner.runCompaction('ses_001', { agent, plugin, frameManager: fm });
      assert.equal(result, null);
    });

    it('should return null when session has only compaction frames (nothing to compact)', async () => {
      fm.merge([{
        id:         'frm_old_compact',
        type:       'compaction',
        authorType: 'system',
        content:    { status: 'finished', summary: 'old' },
        hidden:     false,
        deleted:    false,
      }], { authorType: 'system' });

      let called = false;
      plugin._createSingleTurn = async () => {
        called = true;
        return 'nope';
      };

      let result = await runner.runCompaction('ses_001', { agent, plugin, frameManager: fm });

      assert.equal(result, null, 'Should return null when nothing to compact');
      assert.equal(called, false, 'Should NOT call _createSingleTurn');
    });

    it('should skip deleted frames when counting framesCompacted', async () => {
      fm.merge([
        { id: 'frm_a', type: 'user-message', authorType: 'user', content: { text: 'hi' }, hidden: false, deleted: false },
        { id: 'frm_b', type: 'message', authorType: 'agent', content: { html: 'hey' }, hidden: false, deleted: true },
        { id: 'frm_c', type: 'user-message', authorType: 'user', content: { text: 'ok' }, hidden: false, deleted: false },
      ], { authorType: 'system' });

      await runner.runCompaction('ses_001', { agent, plugin, frameManager: fm });

      let compactionFrames = fm.toArray().filter((f) => f.type === 'compaction');
      // frm_b is deleted, so only frm_a and frm_c are compacted
      assert.equal(compactionFrames[0].content.framesCompacted, 2);
    });

    it('should handle single-frame session', async () => {
      fm.merge([{
        id: 'frm_only', type: 'user-message', authorType: 'user',
        content: { text: 'Hello' }, hidden: false, deleted: false,
      }], { authorType: 'system' });

      let result = await runner.runCompaction('ses_001', { agent, plugin, frameManager: fm });

      assert.ok(result, 'Should succeed even with a single frame');

      let compactionFrames = fm.toArray().filter((f) => f.type === 'compaction');
      assert.equal(compactionFrames[0].content.framesCompacted, 1);
      assert.equal(compactionFrames[0].content.firstFrameID, 'frm_only');
      assert.equal(compactionFrames[0].content.lastFrameID, 'frm_only');
    });
  });

  // ---------------------------------------------------------------------------
  // cleanupStaleCompactions
  // ---------------------------------------------------------------------------

  describe('cleanupStaleCompactions()', () => {
    it('should mark started compaction frames as abandoned', async () => {
      fm.merge([
        {
          id: 'frm_stale_1', type: 'compaction', authorType: 'system',
          content: { status: 'started', compactionID: 'frm_stale_1' },
          hidden: false, deleted: false,
        },
        {
          id: 'frm_stale_2', type: 'compaction', authorType: 'system',
          content: { status: 'started', compactionID: 'frm_stale_2' },
          hidden: false, deleted: false,
        },
      ], { authorType: 'system' });

      let cleaned = await runner.cleanupStaleCompactions(fm);

      assert.equal(cleaned, 2);

      let compactionFrames = fm.toArray().filter((f) => f.type === 'compaction');

      for (let frame of compactionFrames) {
        assert.equal(frame.content.status, 'abandoned');
        assert.ok(frame.content.finishedAt, 'Should have finishedAt set');
      }
    });

    it('should not touch finished compaction frames', async () => {
      fm.merge([{
        id: 'frm_done', type: 'compaction', authorType: 'system',
        content: { status: 'finished', summary: 'Complete.' },
        hidden: false, deleted: false,
      }], { authorType: 'system' });

      let cleaned = await runner.cleanupStaleCompactions(fm);

      assert.equal(cleaned, 0);

      let compactionFrames = fm.toArray().filter((f) => f.type === 'compaction');
      assert.equal(compactionFrames[0].content.status, 'finished');
    });

    it('should not touch abandoned compaction frames', async () => {
      fm.merge([{
        id: 'frm_aband', type: 'compaction', authorType: 'system',
        content: { status: 'abandoned' },
        hidden: false, deleted: false,
      }], { authorType: 'system' });

      let cleaned = await runner.cleanupStaleCompactions(fm);
      assert.equal(cleaned, 0);
    });

    it('should return 0 for empty FrameManager', async () => {
      let cleaned = await runner.cleanupStaleCompactions(fm);
      assert.equal(cleaned, 0);
    });

    it('should handle mix of started, finished, and abandoned', async () => {
      fm.merge([
        { id: 'frm_c1', type: 'compaction', authorType: 'system', content: { status: 'started' }, hidden: false, deleted: false },
        { id: 'frm_c2', type: 'compaction', authorType: 'system', content: { status: 'finished', summary: 'ok' }, hidden: false, deleted: false },
        { id: 'frm_c3', type: 'compaction', authorType: 'system', content: { status: 'abandoned' }, hidden: false, deleted: false },
        { id: 'frm_c4', type: 'compaction', authorType: 'system', content: { status: 'started' }, hidden: false, deleted: false },
      ], { authorType: 'system' });

      let cleaned = await runner.cleanupStaleCompactions(fm);

      assert.equal(cleaned, 2, 'Should clean up exactly the 2 started frames');

      let all = fm.toArray().filter((f) => f.type === 'compaction');
      let statuses = all.map((f) => f.content.status);

      assert.ok(!statuses.includes('started'), 'No frames should be in started status');
    });
  });

  // ---------------------------------------------------------------------------
  // _buildConversationContent
  // ---------------------------------------------------------------------------

  describe('_buildConversationContent()', () => {
    it('should format frames as authorType: text separated by ---', () => {
      let frames = [
        { type: 'user-message', authorType: 'user', content: { text: 'Hello' }, deleted: false },
        { type: 'message', authorType: 'agent', content: { html: '<p>Hi there</p>' }, deleted: false },
      ];

      let result = runner._buildConversationContent(frames);

      assert.ok(result.includes('user: Hello'));
      assert.ok(result.includes('agent: <p>Hi there</p>'));
      assert.ok(result.includes('---'), 'Should include separator');
    });

    it('should skip compaction frames', () => {
      let frames = [
        { type: 'user-message', authorType: 'user', content: { text: 'Hello' }, deleted: false },
        { type: 'compaction', authorType: 'system', content: { status: 'finished', summary: 'old' }, deleted: false },
        { type: 'message', authorType: 'agent', content: { html: 'Reply' }, deleted: false },
      ];

      let result = runner._buildConversationContent(frames);

      assert.ok(!result.includes('finished'), 'Should not include compaction frame content');
      assert.ok(!result.includes('old'), 'Should not include compaction summary');
      assert.ok(result.includes('user: Hello'));
      assert.ok(result.includes('agent: Reply'));
    });

    it('should skip deleted frames', () => {
      let frames = [
        { type: 'user-message', authorType: 'user', content: { text: 'Keep' }, deleted: false },
        { type: 'message', authorType: 'agent', content: { html: 'Drop' }, deleted: true },
      ];

      let result = runner._buildConversationContent(frames);

      assert.ok(result.includes('Keep'));
      assert.ok(!result.includes('Drop'));
    });

    it('should handle tool-call frames', () => {
      let frames = [
        { type: 'tool-call', authorType: 'agent', content: { toolName: 'search' }, deleted: false },
      ];

      let result = runner._buildConversationContent(frames);
      assert.ok(result.includes('[tool-call: search]'));
    });

    it('should handle tool-result frames', () => {
      let frames = [
        { type: 'tool-result', authorType: 'system', content: { output: 'Found 3 results' }, deleted: false },
      ];

      let result = runner._buildConversationContent(frames);
      assert.ok(result.includes('Found 3 results'));
    });

    it('should handle frames with no content', () => {
      let frames = [
        { type: 'user-message', authorType: 'user', content: null, deleted: false },
        { type: 'message', authorType: 'agent', content: {}, deleted: false },
      ];

      let result = runner._buildConversationContent(frames);

      // Should not crash, may produce empty or minimal output
      assert.equal(typeof result, 'string');
    });

    it('should return empty string for empty frames array', () => {
      let result = runner._buildConversationContent([]);
      assert.equal(result, '');
    });

    it('should use unknown for frames without authorType', () => {
      let frames = [
        { type: 'user-message', content: { text: 'anon' }, deleted: false },
      ];

      let result = runner._buildConversationContent(frames);
      assert.ok(result.includes('unknown: anon'));
    });

    it('should handle tool-result with object output', () => {
      let frames = [
        { type: 'tool-result', authorType: 'system', content: { output: { key: 'value' } }, deleted: false },
      ];

      let result = runner._buildConversationContent(frames);
      assert.ok(result.includes('{"key":"value"}'));
    });
  });

  // ---------------------------------------------------------------------------
  // DEFAULT_COMPACTION_PROMPT export
  // ---------------------------------------------------------------------------

  describe('DEFAULT_COMPACTION_PROMPT', () => {
    it('should be a non-empty string', () => {
      assert.equal(typeof DEFAULT_COMPACTION_PROMPT, 'string');
      assert.ok(DEFAULT_COMPACTION_PROMPT.length > 100, 'Should be a substantial prompt');
    });

    it('should mention key preservation concepts', () => {
      assert.ok(DEFAULT_COMPACTION_PROMPT.includes('VITALLY IMPORTANT'));
      assert.ok(DEFAULT_COMPACTION_PROMPT.includes('file paths'));
      assert.ok(DEFAULT_COMPACTION_PROMPT.includes('gradient'));
    });
  });

  // ---------------------------------------------------------------------------
  // Constructor
  // ---------------------------------------------------------------------------

  describe('constructor', () => {
    it('should use console as default logger', () => {
      let r = new CompactionRunner();
      assert.equal(r._logger, console);
    });

    it('should accept custom logger', () => {
      let logger = { info: () => {}, warn: () => {}, error: () => {} };
      let r = new CompactionRunner({ logger });
      assert.equal(r._logger, logger);
    });
  });
});
