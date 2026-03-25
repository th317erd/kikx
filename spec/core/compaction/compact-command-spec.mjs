'use strict';

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import CompactionRunner from '../../../src/core/compaction/index.mjs';
import { FrameManager } from '../../../src/shared/frame-manager/frame-manager.mjs';

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

function createMockPlugin(options = {}) {
  return {
    getCompactionPrompt:    options.getCompactionPrompt    || (() => 'Compact this conversation.'),
    getMaxCompactionTokens: options.getMaxCompactionTokens || (() => 4000),
    _createSingleTurn:      options._createSingleTurn      || (async () => 'Summary of conversation.'),
  };
}

function createMockAgent(overrides = {}) {
  return {
    id:       'agt_test123',
    name:     'test-compactor',
    pluginID: 'claude',
    apiKey:   'sk-test-key-123',
    ...overrides,
  };
}

/**
 * Seed a FrameManager with a set of conversational frames.
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

/**
 * Build a mock context with pluginRegistry and sessionManager.
 * Supports customization of agent type, frame manager, and models.
 */
function createMockContext(overrides = {}) {
  let fm       = overrides.frameManager || createFrameManager();
  let agent    = overrides.agent || createMockAgent();
  let plugin   = overrides.plugin || createMockPlugin();

  let AgentClass = overrides.AgentClass || function MockAgentClass() {};
  AgentClass.prototype.getCompactionPrompt    = plugin.getCompactionPrompt;
  AgentClass.prototype.getMaxCompactionTokens = plugin.getMaxCompactionTokens;
  AgentClass.prototype._createSingleTurn      = plugin._createSingleTurn;

  let pluginRegistry = {
    getAgentType: (pluginID) => {
      if (pluginID === (agent.pluginID || 'claude'))
        return AgentClass;

      return null;
    },
  };

  let sessionManager = {
    getFrameManager: (_sessionID) => fm,
  };

  let framePersistence = {
    loadFramesInto: async () => {},
  };

  let properties = {
    pluginRegistry,
    sessionManager,
    framePersistence,
    ...overrides.properties,
  };

  return {
    getProperty: (name) => properties[name] || null,
  };
}

/**
 * Import the compact command setup and register it.
 * Returns { handler, registration } — handler is the capability handler function.
 */
async function loadCompactCommand(contextOverrides = {}) {
  let { setup } = await import('../../../src/core/internal-plugins/compact/index.mjs');
  let { PluginRegistry } = await import('../../../src/core/plugin-loader/registry.mjs');

  let mockContext = createMockContext(contextOverrides);
  let registry = new PluginRegistry();

  setup((cb) => cb({ registry, context: mockContext }));

  let cap = registry.getCapability('compact');

  return {
    registration: cap,
    handler:      cap ? cap.handler : null,
    context:      mockContext,
  };
}

// =============================================================================
// /compact Command — Unit Tests
// =============================================================================

describe('/compact command', () => {
  // ---------------------------------------------------------------------------
  // Registration
  // ---------------------------------------------------------------------------

  describe('registration', () => {
    it('should register a compact capability', async () => {
      let { registration } = await loadCompactCommand();

      assert.ok(registration, 'Should register a "compact" capability');
    });

    it('should have slashCommand set to "compact"', async () => {
      let { registration } = await loadCompactCommand();

      assert.equal(registration.slashCommand, 'compact');
    });

    it('should have a description', async () => {
      let { registration } = await loadCompactCommand();

      assert.ok(registration.description, 'Should have a description');
      assert.ok(registration.description.length > 10, 'Description should be meaningful');
    });

    it('should have a handler function', async () => {
      let { registration } = await loadCompactCommand();

      assert.equal(typeof registration.handler, 'function');
    });

    it('should be discoverable via slashCommand', async () => {
      let { registration } = await loadCompactCommand();

      assert.equal(registration.slashCommand, 'compact',
        'Should be invocable as /compact');
    });
  });

  // ---------------------------------------------------------------------------
  // Happy path: compaction succeeds
  // ---------------------------------------------------------------------------

  describe('successful compaction', () => {
    it('should return success message on completion', async () => {
      let fm = createFrameManager();
      seedConversation(fm, 5);

      let { handler } = await loadCompactCommand({
        frameManager: fm,
        plugin: createMockPlugin({
          _createSingleTurn: async () => 'Compressed summary.',
        }),
      });

      let result = await handler({
        params:    {},
        sessionID: 'ses_001',
        context:   createMockContext({
          frameManager: fm,
          plugin: createMockPlugin({
            _createSingleTurn: async () => 'Compressed summary.',
          }),
        }),
        agent:     createMockAgent(),
      });

      assert.ok(result, 'Should return a result');
      assert.ok(result.content, 'Should have content');
      assert.ok(result.content.html, 'Should have html');
      assert.ok(
        result.content.html.toLowerCase().includes('compact'),
        'Should mention compaction in the result',
      );
    });

    it('should trigger compaction on the frame manager', async () => {
      let fm = createFrameManager();
      seedConversation(fm, 3);

      let singleTurnCalled = false;

      let plugin = createMockPlugin({
        _createSingleTurn: async () => {
          singleTurnCalled = true;
          return 'Summary output.';
        },
      });

      let { handler } = await loadCompactCommand({
        frameManager: fm,
        plugin,
      });

      await handler({
        params:    {},
        sessionID: 'ses_001',
        context:   createMockContext({ frameManager: fm, plugin }),
        agent:     createMockAgent(),
      });

      assert.ok(singleTurnCalled, 'Should call _createSingleTurn on the plugin');
    });

    it('should create a compaction frame in the frame manager', async () => {
      let fm = createFrameManager();
      seedConversation(fm, 3);

      let plugin = createMockPlugin({
        _createSingleTurn: async () => 'Summarized content.',
      });

      let { handler } = await loadCompactCommand({
        frameManager: fm,
        plugin,
      });

      await handler({
        params:    {},
        sessionID: 'ses_001',
        context:   createMockContext({ frameManager: fm, plugin }),
        agent:     createMockAgent(),
      });

      let compactionFrames = fm.toArray().filter((f) => f.type === 'compaction');
      assert.ok(compactionFrames.length >= 1, 'Should have a compaction frame');
      assert.equal(compactionFrames[0].content.status, 'finished');
    });
  });

  // ---------------------------------------------------------------------------
  // Error: compaction already in progress
  // ---------------------------------------------------------------------------

  describe('compaction already in progress', () => {
    it('should return error when compaction is already running', async () => {
      let fm = createFrameManager();
      seedConversation(fm, 3);

      // Inject an active compaction frame
      fm.merge([{
        id:         'frm_active_compact',
        type:       'compaction',
        authorType: 'system',
        content:    { status: 'started', compactionID: 'frm_active_compact' },
        hidden:     false,
        deleted:    false,
      }], { authorType: 'system' });

      let plugin = createMockPlugin();

      let { handler } = await loadCompactCommand({
        frameManager: fm,
        plugin,
      });

      let result = await handler({
        params:    {},
        sessionID: 'ses_001',
        context:   createMockContext({ frameManager: fm, plugin }),
        agent:     createMockAgent(),
      });

      assert.ok(result.content.html.toLowerCase().includes('already'),
        'Should mention compaction is already in progress');
    });

    it('should not call _createSingleTurn when compaction is in progress', async () => {
      let fm = createFrameManager();
      seedConversation(fm, 3);

      fm.merge([{
        id:         'frm_active_compact',
        type:       'compaction',
        authorType: 'system',
        content:    { status: 'started', compactionID: 'frm_active_compact' },
        hidden:     false,
        deleted:    false,
      }], { authorType: 'system' });

      let called = false;
      let plugin = createMockPlugin({
        _createSingleTurn: async () => {
          called = true;
          return 'nope';
        },
      });

      let { handler } = await loadCompactCommand({
        frameManager: fm,
        plugin,
      });

      await handler({
        params:    {},
        sessionID: 'ses_001',
        context:   createMockContext({ frameManager: fm, plugin }),
        agent:     createMockAgent(),
      });

      assert.equal(called, false, 'Should NOT call _createSingleTurn');
    });
  });

  // ---------------------------------------------------------------------------
  // Error: no agent found
  // ---------------------------------------------------------------------------

  describe('no agent found', () => {
    it('should return error when no agent is provided', async () => {
      let fm = createFrameManager();
      seedConversation(fm, 3);

      let { handler } = await loadCompactCommand({
        frameManager: fm,
      });

      let result = await handler({
        params:    {},
        sessionID: 'ses_001',
        context:   createMockContext({ frameManager: fm }),
        agent:     null,
      });

      assert.ok(result.content.html.toLowerCase().includes('no agent'),
        'Should mention no agent found');
    });

    it('should return error when agent has no pluginID', async () => {
      let fm = createFrameManager();
      seedConversation(fm, 3);

      let { handler } = await loadCompactCommand({
        frameManager: fm,
      });

      let result = await handler({
        params:    {},
        sessionID: 'ses_001',
        context:   createMockContext({ frameManager: fm }),
        agent:     { id: 'agt_test', name: 'test-agent' },
      });

      assert.ok(result.content.html.toLowerCase().includes('no agent') ||
                result.content.html.toLowerCase().includes('plugin'),
        'Should indicate agent cannot be used for compaction');
    });
  });

  // ---------------------------------------------------------------------------
  // Error: compaction fails
  // ---------------------------------------------------------------------------

  describe('compaction errors', () => {
    it('should return error when _createSingleTurn throws', async () => {
      let fm = createFrameManager();
      seedConversation(fm, 3);

      let plugin = createMockPlugin({
        _createSingleTurn: async () => {
          throw new Error('API rate limit exceeded');
        },
      });

      let { handler } = await loadCompactCommand({
        frameManager: fm,
        plugin,
      });

      let result = await handler({
        params:    {},
        sessionID: 'ses_001',
        context:   createMockContext({ frameManager: fm, plugin }),
        agent:     createMockAgent(),
      });

      assert.ok(result.content.html, 'Should return html content');
      // Should not throw — error is caught and returned as message
    });

    it('should return error when session has no frames to compact', async () => {
      let fm = createFrameManager();
      // Don't seed any frames

      let plugin = createMockPlugin();

      let { handler } = await loadCompactCommand({
        frameManager: fm,
        plugin,
      });

      let result = await handler({
        params:    {},
        sessionID: 'ses_001',
        context:   createMockContext({ frameManager: fm, plugin }),
        agent:     createMockAgent(),
      });

      assert.ok(result.content.html, 'Should return html content');
      assert.ok(
        result.content.html.toLowerCase().includes('no') ||
        result.content.html.toLowerCase().includes('nothing') ||
        result.content.html.toLowerCase().includes('empty'),
        'Should indicate nothing to compact',
      );
    });

    it('should handle plugin registry not having the agent type', async () => {
      let fm = createFrameManager();
      seedConversation(fm, 3);

      let mockContext = {
        getProperty: (name) => {
          if (name === 'pluginRegistry')
            return { getAgentType: () => null };
          if (name === 'sessionManager')
            return { getFrameManager: () => fm };
          if (name === 'framePersistence')
            return { loadFramesInto: async () => {} };
          return null;
        },
      };

      let { handler } = await loadCompactCommand({
        frameManager: fm,
      });

      let result = await handler({
        params:    {},
        sessionID: 'ses_001',
        context:   mockContext,
        agent:     createMockAgent({ pluginID: 'unknown-plugin' }),
      });

      assert.ok(result.content.html, 'Should return html content');
      assert.ok(
        result.content.html.toLowerCase().includes('no agent') ||
        result.content.html.toLowerCase().includes('plugin') ||
        result.content.html.toLowerCase().includes('not found'),
        'Should indicate agent plugin not found',
      );
    });
  });

  // ---------------------------------------------------------------------------
  // CompactionRunner — apiKey forwarding
  // ---------------------------------------------------------------------------

  describe('CompactionRunner apiKey forwarding', () => {
    it('should pass agent.apiKey to _createSingleTurn options', async () => {
      let fm = createFrameManager();
      seedConversation(fm, 3);

      let capturedOptions = null;

      let plugin = createMockPlugin({
        _createSingleTurn: async (_messages, options) => {
          capturedOptions = options;
          return 'Summary.';
        },
      });

      let runner = new CompactionRunner({ logger: silentLogger() });
      let agent  = createMockAgent({ apiKey: 'sk-captured-key' });

      await runner.runCompaction('ses_001', { agent, plugin, frameManager: fm });

      assert.ok(capturedOptions, 'Should have called _createSingleTurn');
      assert.equal(capturedOptions.apiKey, 'sk-captured-key',
        'Should forward agent.apiKey to plugin');
    });

    it('should pass agent.model to _createSingleTurn options when available', async () => {
      let fm = createFrameManager();
      seedConversation(fm, 3);

      let capturedOptions = null;

      let plugin = createMockPlugin({
        _createSingleTurn: async (_messages, options) => {
          capturedOptions = options;
          return 'Summary.';
        },
      });

      let runner = new CompactionRunner({ logger: silentLogger() });
      let agent  = createMockAgent({ apiKey: 'sk-test', model: 'claude-sonnet-4-20250514' });

      await runner.runCompaction('ses_001', { agent, plugin, frameManager: fm });

      assert.ok(capturedOptions, 'Should have called _createSingleTurn');
      assert.equal(capturedOptions.model, 'claude-sonnet-4-20250514',
        'Should forward agent.model to plugin');
    });

    it('should not break when agent has no apiKey', async () => {
      let fm = createFrameManager();
      seedConversation(fm, 3);

      let capturedOptions = null;

      let plugin = createMockPlugin({
        _createSingleTurn: async (_messages, options) => {
          capturedOptions = options;
          return 'Summary.';
        },
      });

      let runner = new CompactionRunner({ logger: silentLogger() });
      let agent  = createMockAgent({ apiKey: undefined });

      await runner.runCompaction('ses_001', { agent, plugin, frameManager: fm });

      assert.ok(capturedOptions, 'Should have called _createSingleTurn');
      // apiKey should be undefined, not crash
      assert.equal(capturedOptions.apiKey, undefined);
    });
  });

  // ---------------------------------------------------------------------------
  // setup() return value
  // ---------------------------------------------------------------------------

  describe('setup() return value', () => {
    it('should return a teardown function', async () => {
      let { setup } = await import('../../../src/core/internal-plugins/compact/index.mjs');

      let { PluginRegistry } = await import('../../../src/core/plugin-loader/registry.mjs');
      let registry = new PluginRegistry();
      let teardown = setup((cb) => cb({ registry, context: createMockContext() }));

      assert.equal(typeof teardown, 'function', 'setup() should return a teardown function');
    });
  });
});
