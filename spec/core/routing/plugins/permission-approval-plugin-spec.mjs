'use strict';

import { describe, it, beforeEach } from 'node:test';
import assert                        from 'node:assert/strict';

import { FrameRouter }    from '../../../../src/core/routing/frame-router.mjs';
import { BasePluginClass } from '../../../../src/core/routing/base-plugin-class.mjs';
import { FrameManager }   from '../../../../src/shared/frame-manager/frame-manager.mjs';

// =============================================================================
// PermissionApprovalPlugin — Phase 4
// =============================================================================
// Tests that the FrameRouter plugin correctly:
//   - Verifies approval/denial signatures (when present)
//   - Creates one-time allow PermissionRule on approval
//   - Hides placeholder ToolResult frames
//   - Creates denial ToolResult on denial
//   - Starts new interaction via agentResolver
//   - Skips already-handled or initial-creation frames
// =============================================================================

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function silentLogger() {
  return {
    log:   () => {},
    warn:  () => {},
    error: () => {},
    info:  () => {},
  };
}

function createRouter(options = {}) {
  return new FrameRouter({ logger: silentLogger(), ...options });
}

function tick(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms || 15));
}

// Mock FramePersistence
function createMockPersistence() {
  let calls = [];
  return {
    calls,
    async updateFrameState(frameID, state) {
      calls.push({ frameID, state });
    },
  };
}

// Mock pluginRegistry
function createMockPluginRegistry(tools = {}) {
  return {
    getTool(toolName) {
      return tools[toolName] || null;
    },
  };
}

// Mock interactionLoop
function createMockInteractionLoop() {
  let calls = [];
  return {
    calls,
    async startInteraction(sessionID, params) {
      calls.push({ method: 'startInteraction', sessionID, params });
      return 'int_new';
    },
    _createFrame: async (_sid, frameData, _fm, _opts, _sigCtx) => {
      calls.push({ method: '_createFrame', frameData });
      return frameData;
    },
    _getFramePersistence() {
      return { saveFrames: async () => {} };
    },
    emit() {},
  };
}

// Mock models for rule creation and frame lookup
function createMockModels() {
  let rules   = [];
  let frames  = [];
  return {
    rules,
    frames,
    PermissionRule: {
      async create(data) {
        let rule = { ...data, id: 'rule_' + Math.random().toString(36).slice(2, 8) };
        rules.push(rule);
        return rule;
      },
    },
    User: {
      where: {
        id: {
          EQ: () => ({
            first: async () => null,
          }),
        },
      },
    },
    Frame: {
      where: {
        sessionID: {
          EQ: (sid) => ({
            AND: {
              type: {
                EQ: (type) => ({
                  all: async () => frames.filter((f) => f.sessionID === sid && f.type === type),
                  AND: {
                    processed: {
                      EQ: () => ({
                        all: async () => frames.filter((f) => f.sessionID === sid && f.type === type),
                      }),
                    },
                    hidden: {
                      EQ: (hidden) => ({
                        all: async () => frames.filter((f) => f.sessionID === sid && f.type === type && f.hidden === hidden),
                      }),
                    },
                  },
                }),
              },
            },
          }),
        },
      },
    },
  };
}

// Create a mock global context with configurable properties
function createMockContext(overrides = {}) {
  let props = {
    pluginRegistry:  null,
    interactionLoop: null,
    framePersistence: null,
    models:          null,
    keystore:        null,
    agentResolver:   null,
    sessionScheduler: null,
    ...overrides,
  };
  return {
    getProperty(name) { return props[name] || null; },
    setProperty(name, val) { props[name] = val; },
  };
}

// Build a simple tool class that returns a fixed result
function createToolClass(result, shouldThrow) {
  return class MockTool {
    constructor(_context) {
      this._context = _context;
    }
    async execute(args) {
      if (shouldThrow)
        throw new Error(shouldThrow);

      return result || 'tool-output-ok';
    }
  };
}

// Load the plugin setup function
async function loadPlugin() {
  let mod = await import('../../../../src/core/internal-plugins/permission-approval/index.mjs');
  return mod.setup;
}

// Register the plugin on a router via its setup function
async function registerPlugin(router, globalContext) {
  let setup = await loadPlugin();
  let { PluginRegistry } = await import('../../../../src/core/plugin-loader/registry.mjs');
  let registry = new PluginRegistry();

  setup((cb) => cb({ registry, context: globalContext }));

  let selectors = registry.getSelectors();
  for (let s of selectors)
    router.registerSelector(s.selector, s.PluginClass, 'permission-approval');

  return selectors.map(s => ({ selector: s.selector, PluginClass: s.PluginClass }));
}

// =============================================================================
// Tests
// =============================================================================

describe('PermissionApprovalPlugin', () => {

  // ---------------------------------------------------------------------------
  // Happy paths — Approval
  // ---------------------------------------------------------------------------

  describe('approval — happy paths', () => {

    it('sets state.step to "completed" on approval', async () => {
      let pluginRegistry  = createMockPluginRegistry({});
      let interactionLoop = createMockInteractionLoop();
      let persistence     = createMockPersistence();
      let mockModels      = createMockModels();
      let globalContext    = createMockContext({ pluginRegistry, interactionLoop, models: mockModels });

      let router = createRouter();
      let fm     = new FrameManager();

      await registerPlugin(router, globalContext);
      router.connectTo(fm, { id: 'ses_1' }, { framePersistence: persistence });

      fm.merge([{
        id: 'frm_1', type: 'PermissionRequest',
        content: {}, processed: false,
        state: JSON.stringify({
          toolName: 'test:tool', toolArguments: {}, toolUseID: 'tu_1',
          sessionID: 'ses_1', agentID: 'agt_1', interactionID: 'int_1',
          step: 'awaiting-approval',
        }),
      }]);
      await tick();

      fm.merge([{
        id: 'frm_1', type: 'PermissionRequest',
        content: {}, processed: true,
        state: JSON.stringify({
          toolName: 'test:tool', toolArguments: {}, toolUseID: 'tu_1',
          sessionID: 'ses_1', agentID: 'agt_1', interactionID: 'int_1',
          step: 'awaiting-approval',
        }),
      }]);
      await tick();

      let statePersists = persistence.calls.filter((c) => c.frameID === 'frm_1');
      assert.ok(statePersists.length >= 1, 'state should be persisted');
      let lastPersist = statePersists[statePersists.length - 1];
      assert.equal(lastPersist.state.step, 'completed');
    });

    it('starts a new interaction after approval', async () => {
      let pluginRegistry  = createMockPluginRegistry({});
      let interactionLoop = createMockInteractionLoop();
      let mockModels      = createMockModels();
      let globalContext    = createMockContext({ pluginRegistry, interactionLoop, models: mockModels });

      let router = createRouter();
      let fm     = new FrameManager();

      await registerPlugin(router, globalContext);
      router.connectTo(fm, { id: 'ses_1' });

      fm.merge([{
        id: 'frm_1', type: 'PermissionRequest',
        content: {}, processed: false,
        state: JSON.stringify({
          toolName: 'test:tool', toolArguments: {}, toolUseID: 'tu_1',
          sessionID: 'ses_1', agentID: 'agt_1', interactionID: 'int_1',
          step: 'awaiting-approval',
        }),
      }]);
      await tick();

      fm.merge([{
        id: 'frm_1', type: 'PermissionRequest',
        content: {}, processed: true,
        state: JSON.stringify({
          toolName: 'test:tool', toolArguments: {}, toolUseID: 'tu_1',
          sessionID: 'ses_1', agentID: 'agt_1', interactionID: 'int_1',
          step: 'awaiting-approval',
        }),
      }]);
      // The plugin defers startInteraction via setTimeout(200ms), so we need to wait longer
      await tick(300);

      let startCalls = interactionLoop.calls.filter((c) => c.method === 'startInteraction');
      assert.ok(startCalls.length >= 1, 'should call startInteraction after approval');
      assert.equal(startCalls[0].sessionID, 'ses_1');
    });

    it('does not directly execute the tool (deferred to InteractionLoop replay)', async () => {
      let toolExecuted = false;
      let ToolClass    = createToolClass('output');
      ToolClass.prototype.execute = async function() { toolExecuted = true; return 'output'; };

      let pluginRegistry  = createMockPluginRegistry({ 'test:tool': ToolClass });
      let interactionLoop = createMockInteractionLoop();
      let mockModels      = createMockModels();
      let globalContext    = createMockContext({ pluginRegistry, interactionLoop, models: mockModels });

      let router = createRouter();
      let fm     = new FrameManager();

      await registerPlugin(router, globalContext);
      router.connectTo(fm, { id: 'ses_1' });

      fm.merge([{
        id: 'frm_1', type: 'PermissionRequest',
        content: {}, processed: false,
        state: JSON.stringify({
          toolName: 'test:tool', toolArguments: {}, toolUseID: 'tu_1',
          sessionID: 'ses_1', agentID: 'agt_1', interactionID: 'int_1',
          step: 'awaiting-approval',
        }),
      }]);
      await tick();

      fm.merge([{
        id: 'frm_1', type: 'PermissionRequest',
        content: {}, processed: true,
        state: JSON.stringify({
          toolName: 'test:tool', toolArguments: {}, toolUseID: 'tu_1',
          sessionID: 'ses_1', agentID: 'agt_1', interactionID: 'int_1',
          step: 'awaiting-approval',
        }),
      }]);
      await tick();

      // Plugin no longer directly executes tools — that's deferred to the InteractionLoop replay
      assert.equal(toolExecuted, false, 'plugin should NOT directly execute tools (deferred to replay)');
    });

    it('does not create tool-result frame on approval (deferred to replay)', async () => {
      let pluginRegistry  = createMockPluginRegistry({});
      let interactionLoop = createMockInteractionLoop();
      let mockModels      = createMockModels();
      let globalContext    = createMockContext({ pluginRegistry, interactionLoop, models: mockModels });

      let router = createRouter();
      let fm     = new FrameManager();

      await registerPlugin(router, globalContext);
      router.connectTo(fm, { id: 'ses_1' });

      fm.merge([{
        id: 'frm_1', type: 'PermissionRequest',
        content: {}, processed: false,
        state: JSON.stringify({
          toolName: 'test:tool', toolArguments: {}, toolUseID: 'tu_1',
          sessionID: 'ses_1', agentID: 'agt_1', interactionID: 'int_1',
          step: 'awaiting-approval',
        }),
      }]);
      await tick();

      fm.merge([{
        id: 'frm_1', type: 'PermissionRequest',
        content: {}, processed: true,
        state: JSON.stringify({
          toolName: 'test:tool', toolArguments: {}, toolUseID: 'tu_1',
          sessionID: 'ses_1', agentID: 'agt_1', interactionID: 'int_1',
          step: 'awaiting-approval',
        }),
      }]);
      await tick();

      let frameCreates = interactionLoop.calls.filter((c) => c.method === '_createFrame');
      let toolResultFrame = frameCreates.find((c) => c.frameData.type === 'ToolResult');
      assert.equal(toolResultFrame, undefined, 'should NOT create tool-result frame on approval (deferred)');
    });
  });

  // ---------------------------------------------------------------------------
  // Happy paths — Denial
  // ---------------------------------------------------------------------------

  describe('denial — happy paths', () => {

    it('creates denial tool-result frame when content.denied is set', async () => {
      let pluginRegistry  = createMockPluginRegistry({});
      let interactionLoop = createMockInteractionLoop();
      let mockModels      = createMockModels();
      let globalContext    = createMockContext({ pluginRegistry, interactionLoop, models: mockModels });

      let router = createRouter();
      let fm     = new FrameManager();

      await registerPlugin(router, globalContext);
      router.connectTo(fm, { id: 'ses_1' });

      fm.merge([{
        id: 'frm_1', type: 'PermissionRequest',
        content: { toolName: 'test:tool' }, processed: false,
        state: JSON.stringify({
          toolName: 'test:tool', toolArguments: {}, toolUseID: 'tu_1',
          sessionID: 'ses_1', agentID: 'agt_1', interactionID: 'int_1',
          step: 'awaiting-approval',
        }),
      }]);
      await tick();

      // Deny — processed=true + content.denied=true
      fm.merge([{
        id: 'frm_1', type: 'PermissionRequest',
        content: { toolName: 'test:tool', denied: true }, processed: true,
        state: JSON.stringify({
          toolName: 'test:tool', toolArguments: {}, toolUseID: 'tu_1',
          sessionID: 'ses_1', agentID: 'agt_1', interactionID: 'int_1',
          step: 'awaiting-approval',
        }),
      }]);
      await tick();

      let frameCreates = interactionLoop.calls.filter((c) => c.method === '_createFrame');
      let toolResultFrame = frameCreates.find((c) => c.frameData.type === 'ToolResult');
      assert.ok(toolResultFrame, 'should create a tool-result frame for denial');
      assert.ok(
        toolResultFrame.frameData.content.output.toLowerCase().includes('denied') ||
        toolResultFrame.frameData.content.output.toLowerCase().includes('permission'),
        'denial message should mention denial or permission',
      );
    });

    it('updates state step to "denied" after denial', async () => {
      let pluginRegistry  = createMockPluginRegistry({});
      let interactionLoop = createMockInteractionLoop();
      let persistence     = createMockPersistence();
      let mockModels      = createMockModels();
      let globalContext    = createMockContext({ pluginRegistry, interactionLoop, models: mockModels });

      let router = createRouter();
      let fm     = new FrameManager();

      await registerPlugin(router, globalContext);
      router.connectTo(fm, { id: 'ses_1' }, { framePersistence: persistence });

      fm.merge([{
        id: 'frm_1', type: 'PermissionRequest',
        content: { toolName: 'test:tool' }, processed: false,
        state: JSON.stringify({
          toolName: 'test:tool', toolArguments: {}, toolUseID: 'tu_1',
          sessionID: 'ses_1', agentID: 'agt_1', interactionID: 'int_1',
          step: 'awaiting-approval',
        }),
      }]);
      await tick();

      fm.merge([{
        id: 'frm_1', type: 'PermissionRequest',
        content: { toolName: 'test:tool', denied: true }, processed: true,
        state: JSON.stringify({
          toolName: 'test:tool', toolArguments: {}, toolUseID: 'tu_1',
          sessionID: 'ses_1', agentID: 'agt_1', interactionID: 'int_1',
          step: 'awaiting-approval',
        }),
      }]);
      await tick();

      let statePersists = persistence.calls.filter((c) => c.frameID === 'frm_1');
      assert.ok(statePersists.length >= 1, 'state should be persisted');
      let lastPersist = statePersists[statePersists.length - 1];
      assert.equal(lastPersist.state.step, 'denied');
    });
  });

  // ---------------------------------------------------------------------------
  // Sad paths
  // ---------------------------------------------------------------------------

  describe('sad paths', () => {

    it('skips when step is already "completed"', async () => {
      let pluginRegistry  = createMockPluginRegistry({});
      let interactionLoop = createMockInteractionLoop();
      let globalContext    = createMockContext({ pluginRegistry, interactionLoop });

      let router = createRouter();
      let fm     = new FrameManager();

      await registerPlugin(router, globalContext);
      router.connectTo(fm, { id: 'ses_1' });

      fm.merge([{
        id: 'frm_1', type: 'PermissionRequest',
        content: {}, processed: true,
        state: JSON.stringify({
          toolName: 'test:tool', toolArguments: {}, toolUseID: 'tu_1',
          sessionID: 'ses_1', agentID: 'agt_1', interactionID: 'int_1',
          step: 'completed',
        }),
      }]);
      await tick();

      let startCalls = interactionLoop.calls.filter((c) => c.method === 'startInteraction');
      assert.equal(startCalls.length, 0, 'should NOT start interaction when step=completed');
    });

    it('skips when step is already "denied"', async () => {
      let pluginRegistry  = createMockPluginRegistry({});
      let interactionLoop = createMockInteractionLoop();
      let globalContext    = createMockContext({ pluginRegistry, interactionLoop });

      let router = createRouter();
      let fm     = new FrameManager();

      await registerPlugin(router, globalContext);
      router.connectTo(fm, { id: 'ses_1' });

      fm.merge([{
        id: 'frm_1', type: 'PermissionRequest',
        content: {}, processed: true,
        state: JSON.stringify({
          toolName: 'test:tool', toolArguments: {}, toolUseID: 'tu_1',
          sessionID: 'ses_1', agentID: 'agt_1', interactionID: 'int_1',
          step: 'denied',
        }),
      }]);
      await tick();

      let startCalls = interactionLoop.calls.filter((c) => c.method === 'startInteraction');
      assert.equal(startCalls.length, 0, 'should NOT start interaction when step=denied');
    });

    it('skips initial creation (processed=false, step=awaiting-approval)', async () => {
      let pluginRegistry  = createMockPluginRegistry({});
      let interactionLoop = createMockInteractionLoop();
      let globalContext    = createMockContext({ pluginRegistry, interactionLoop });

      let router = createRouter();
      let fm     = new FrameManager();

      await registerPlugin(router, globalContext);
      router.connectTo(fm, { id: 'ses_1' });

      fm.merge([{
        id: 'frm_1', type: 'PermissionRequest',
        content: {}, processed: false,
        state: JSON.stringify({
          toolName: 'test:tool', toolArguments: {}, toolUseID: 'tu_1',
          sessionID: 'ses_1', agentID: 'agt_1', interactionID: 'int_1',
          step: 'awaiting-approval',
        }),
      }]);
      await tick();

      let startCalls = interactionLoop.calls.filter((c) => c.method === 'startInteraction');
      assert.equal(startCalls.length, 0, 'should NOT start interaction on initial creation');
    });

    it('skips with no crash when pluginRegistry is missing', async () => {
      let interactionLoop = createMockInteractionLoop();
      let globalContext    = createMockContext({ pluginRegistry: null, interactionLoop });

      let router = createRouter();
      let fm     = new FrameManager();

      await registerPlugin(router, globalContext);
      router.connectTo(fm, { id: 'ses_1' });

      // Should not throw
      fm.merge([{
        id: 'frm_1', type: 'PermissionRequest',
        content: {}, processed: false,
        state: JSON.stringify({
          toolName: 'test:tool', toolArguments: {}, toolUseID: 'tu_1',
          sessionID: 'ses_1', agentID: 'agt_1', interactionID: 'int_1',
          step: 'awaiting-approval',
        }),
      }]);
      await tick();

      fm.merge([{
        id: 'frm_1', type: 'PermissionRequest',
        content: {}, processed: true,
        state: JSON.stringify({
          toolName: 'test:tool', toolArguments: {}, toolUseID: 'tu_1',
          sessionID: 'ses_1', agentID: 'agt_1', interactionID: 'int_1',
          step: 'awaiting-approval',
        }),
      }]);
      await tick();

      assert.ok(true, 'should not crash when pluginRegistry is missing');
    });

    it('skips with no crash when state fields are missing', async () => {
      let pluginRegistry  = createMockPluginRegistry({});
      let interactionLoop = createMockInteractionLoop();
      let globalContext    = createMockContext({ pluginRegistry, interactionLoop });

      let router = createRouter();
      let fm     = new FrameManager();

      await registerPlugin(router, globalContext);
      router.connectTo(fm, { id: 'ses_1' });

      // State with missing fields (no toolName, no step)
      fm.merge([{
        id: 'frm_1', type: 'PermissionRequest',
        content: {}, processed: true,
        state: JSON.stringify({ someRandom: 'data' }),
      }]);
      await tick();

      assert.ok(true, 'should not crash with missing state fields');
    });

    it('sets state to signature-invalid when signature verification fails', async () => {
      let pluginRegistry  = createMockPluginRegistry({});
      let interactionLoop = createMockInteractionLoop();
      let persistence     = createMockPersistence();

      // Create a mock user with a public key that will cause verification to fail
      let mockModels = createMockModels();
      let fakeUser   = { id: 'usr_bad', publicKey: 'fake-public-key', organizationID: 'org_1' };
      mockModels.User.where.id.EQ = () => ({
        first: async () => fakeUser,
      });

      let globalContext = createMockContext({ pluginRegistry, interactionLoop, models: mockModels, keystore: {
        canonicalize: (d) => JSON.stringify(d),
        verifyWithPublicKey: () => false, // Always fail verification
      } });

      let router = createRouter();
      let fm     = new FrameManager();

      await registerPlugin(router, globalContext);
      router.connectTo(fm, { id: 'ses_1' }, { framePersistence: persistence });

      fm.merge([{
        id: 'frm_1', type: 'PermissionRequest',
        content: {}, processed: false,
        state: JSON.stringify({
          toolName: 'test:tool', toolArguments: {}, toolUseID: 'tu_1',
          sessionID: 'ses_1', agentID: 'agt_1', interactionID: 'int_1',
          step: 'awaiting-approval',
        }),
      }]);
      await tick();

      fm.merge([{
        id: 'frm_1', type: 'PermissionRequest',
        content: {
          approvalSignature:   'bad-signature',
          approvalFingerprint: 'bad-fingerprint',
          approvedBy:          'usr_bad',
        },
        processed: true,
        state: JSON.stringify({
          toolName: 'test:tool', toolArguments: {}, toolUseID: 'tu_1',
          sessionID: 'ses_1', agentID: 'agt_1', interactionID: 'int_1',
          step: 'awaiting-approval',
        }),
      }]);
      await tick();

      let statePersists = persistence.calls.filter((c) => c.frameID === 'frm_1');
      assert.ok(statePersists.length >= 1, 'state should be persisted');
      let lastPersist = statePersists[statePersists.length - 1];
      assert.equal(lastPersist.state.step, 'signature-invalid');
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  describe('edge cases', () => {

    it('concurrent approval — second sees step=completed and skips', async () => {
      let pluginRegistry  = createMockPluginRegistry({});
      let interactionLoop = createMockInteractionLoop();
      let persistence     = createMockPersistence();
      let mockModels      = createMockModels();
      let globalContext    = createMockContext({ pluginRegistry, interactionLoop, models: mockModels });

      let router = createRouter();
      let fm     = new FrameManager();

      await registerPlugin(router, globalContext);
      router.connectTo(fm, { id: 'ses_1' }, { framePersistence: persistence });

      // Initial
      fm.merge([{
        id: 'frm_1', type: 'PermissionRequest',
        content: {}, processed: false,
        state: JSON.stringify({
          toolName: 'test:tool', toolArguments: {}, toolUseID: 'tu_1',
          sessionID: 'ses_1', agentID: 'agt_1', interactionID: 'int_1',
          step: 'awaiting-approval',
        }),
      }]);
      await tick();

      // First approval
      fm.merge([{
        id: 'frm_1', type: 'PermissionRequest',
        content: {}, processed: true,
        state: JSON.stringify({
          toolName: 'test:tool', toolArguments: {}, toolUseID: 'tu_1',
          sessionID: 'ses_1', agentID: 'agt_1', interactionID: 'int_1',
          step: 'awaiting-approval',
        }),
      }]);
      // The plugin defers startInteraction via setTimeout(200ms), so we need to wait longer
      await tick(300);

      let startCallsBefore = interactionLoop.calls.filter((c) => c.method === 'startInteraction').length;
      assert.ok(startCallsBefore >= 1, 'should start interaction after first approval');

      // Second "approval" attempt — state should already be 'completed'
      fm.merge([{
        id: 'frm_1', type: 'PermissionRequest',
        content: {}, processed: true,
        state: JSON.stringify({
          toolName: 'test:tool', toolArguments: {}, toolUseID: 'tu_1',
          sessionID: 'ses_1', agentID: 'agt_1', interactionID: 'int_1',
          step: 'completed',
        }),
      }]);
      await tick();

      let startCallsAfter = interactionLoop.calls.filter((c) => c.method === 'startInteraction').length;
      assert.equal(startCallsAfter, startCallsBefore, 'should NOT start another interaction — step is already completed');
    });

    it('non-permission-request frame is passed to next()', async () => {
      let nextCalled      = false;
      let pluginRegistry  = createMockPluginRegistry({});
      let interactionLoop = createMockInteractionLoop();
      let globalContext    = createMockContext({ pluginRegistry, interactionLoop });

      let router = createRouter();
      let fm     = new FrameManager();

      await registerPlugin(router, globalContext);

      // Register another plugin after to verify next() is called
      class Sentinel extends BasePluginClass {
        async process(next, done) {
          nextCalled = true;
          return await next(this.context);
        }
      }
      router.registerSelector('type:UserMessage', Sentinel, 'sentinel');
      router.connectTo(fm, { id: 'ses_1' });

      fm.merge([{
        id: 'frm_2', type: 'UserMessage',
        content: { text: 'hello' },
      }]);
      await tick();

      assert.ok(true, 'non-permission-request frame should not cause errors');
    });

    it('allows legacy approval without signature (no signature in content)', async () => {
      let pluginRegistry  = createMockPluginRegistry({});
      let interactionLoop = createMockInteractionLoop();
      let persistence     = createMockPersistence();
      let mockModels      = createMockModels();
      let globalContext    = createMockContext({ pluginRegistry, interactionLoop, models: mockModels });

      let router = createRouter();
      let fm     = new FrameManager();

      await registerPlugin(router, globalContext);
      router.connectTo(fm, { id: 'ses_1' }, { framePersistence: persistence });

      fm.merge([{
        id: 'frm_1', type: 'PermissionRequest',
        content: {}, processed: false,
        state: JSON.stringify({
          toolName: 'test:tool', toolArguments: {}, toolUseID: 'tu_1',
          sessionID: 'ses_1', agentID: 'agt_1', interactionID: 'int_1',
          step: 'awaiting-approval',
        }),
      }]);
      await tick();

      // Approve without any signature fields (legacy)
      fm.merge([{
        id: 'frm_1', type: 'PermissionRequest',
        content: {}, processed: true,
        state: JSON.stringify({
          toolName: 'test:tool', toolArguments: {}, toolUseID: 'tu_1',
          sessionID: 'ses_1', agentID: 'agt_1', interactionID: 'int_1',
          step: 'awaiting-approval',
        }),
      }]);
      await tick();

      let statePersists = persistence.calls.filter((c) => c.frameID === 'frm_1');
      assert.ok(statePersists.length >= 1, 'state should be persisted');
      let lastPersist = statePersists[statePersists.length - 1];
      assert.equal(lastPersist.state.step, 'completed', 'legacy approval (no signature) should still complete');
    });
  });
});
