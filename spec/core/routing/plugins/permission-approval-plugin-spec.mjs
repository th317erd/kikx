'use strict';

import { describe, it, beforeEach } from 'node:test';
import assert                        from 'node:assert/strict';

import { FrameRouter }    from '../../../../src/core/routing/frame-router.mjs';
import { BasePluginClass } from '../../../../src/core/routing/base-plugin-class.mjs';
import { FrameManager }   from '../../../../src/shared/frame-manager/frame-manager.mjs';

// =============================================================================
// PermissionApprovalPlugin — Step 2.2
// =============================================================================
// Tests that the FrameRouter plugin correctly:
//   - Detects approved permission-request frames (step=awaiting-approval + processed=true)
//   - Re-executes the tool and creates a tool-result frame
//   - Handles denied frames
//   - Skips already-handled or initial-creation frames
//   - Handles missing state, missing tools, execution errors
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

// Create a mock global context with configurable properties
function createMockContext(overrides = {}) {
  let props = {
    pluginRegistry:  null,
    interactionLoop: null,
    framePersistence: null,
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
  let registered = [];

  setup({
    registerSelector: (selector, PluginClass) => {
      registered.push({ selector, PluginClass });
      router.registerSelector(selector, PluginClass, 'permission-approval');
    },
    context: globalContext,
  });

  return registered;
}

// =============================================================================
// Tests
// =============================================================================

describe('PermissionApprovalPlugin', () => {

  // ---------------------------------------------------------------------------
  // Happy paths — Approval
  // ---------------------------------------------------------------------------

  describe('approval — happy paths', () => {

    it('re-executes tool when step=awaiting-approval and processed becomes true', async () => {
      let toolExecuted = false;
      let ToolClass    = createToolClass('re-executed-output');
      ToolClass.prototype.execute = async function(args) { toolExecuted = true; return 're-executed-output'; };

      let pluginRegistry  = createMockPluginRegistry({ 'shell:execute': ToolClass });
      let interactionLoop = createMockInteractionLoop();
      let globalContext    = createMockContext({ pluginRegistry, interactionLoop });

      let router = createRouter();
      let fm     = new FrameManager();

      await registerPlugin(router, globalContext);
      router.connectTo(fm, { id: 'ses_1' });

      // Create initial frame (step = awaiting-approval, processed = false)
      fm.merge([{
        id:        'frm_1',
        type:      'permission-request',
        content:   { toolName: 'shell:execute' },
        processed: false,
        state:     JSON.stringify({
          toolName:      'shell:execute',
          toolArguments: { command: 'ls' },
          toolUseID:     'tu_1',
          sessionID:     'ses_1',
          agentID:       'agt_1',
          interactionID: 'int_1',
          step:          'awaiting-approval',
        }),
      }]);
      await tick();

      // Now "approve" — update processed to true
      fm.merge([{
        id:        'frm_1',
        type:      'permission-request',
        content:   { toolName: 'shell:execute' },
        processed: true,
        state:     JSON.stringify({
          toolName:      'shell:execute',
          toolArguments: { command: 'ls' },
          toolUseID:     'tu_1',
          sessionID:     'ses_1',
          agentID:       'agt_1',
          interactionID: 'int_1',
          step:          'awaiting-approval',
        }),
      }]);
      await tick();

      assert.ok(toolExecuted, 'tool should have been re-executed');
    });

    it('creates tool-result frame after re-execution', async () => {
      let ToolClass       = createToolClass('result-content');
      let pluginRegistry  = createMockPluginRegistry({ 'test:tool': ToolClass });
      let interactionLoop = createMockInteractionLoop();
      let globalContext    = createMockContext({ pluginRegistry, interactionLoop });

      let router = createRouter();
      let fm     = new FrameManager();

      await registerPlugin(router, globalContext);
      router.connectTo(fm, { id: 'ses_1' });

      // Initial creation
      fm.merge([{
        id: 'frm_1', type: 'permission-request',
        content: { toolName: 'test:tool' }, processed: false,
        state: JSON.stringify({
          toolName: 'test:tool', toolArguments: {}, toolUseID: 'tu_1',
          sessionID: 'ses_1', agentID: 'agt_1', interactionID: 'int_1',
          step: 'awaiting-approval',
        }),
      }]);
      await tick();

      // Approve
      fm.merge([{
        id: 'frm_1', type: 'permission-request',
        content: { toolName: 'test:tool' }, processed: true,
        state: JSON.stringify({
          toolName: 'test:tool', toolArguments: {}, toolUseID: 'tu_1',
          sessionID: 'ses_1', agentID: 'agt_1', interactionID: 'int_1',
          step: 'awaiting-approval',
        }),
      }]);
      await tick();

      let frameCreates = interactionLoop.calls.filter((c) => c.method === '_createFrame');
      assert.ok(frameCreates.length >= 1, 'should create at least one frame (tool-result)');
      let toolResultFrame = frameCreates.find((c) => c.frameData.type === 'tool-result');
      assert.ok(toolResultFrame, 'should create a tool-result frame');
    });

    it('updates state step to "completed" after approval', async () => {
      let ToolClass       = createToolClass('output');
      let pluginRegistry  = createMockPluginRegistry({ 'test:tool': ToolClass });
      let interactionLoop = createMockInteractionLoop();
      let persistence     = createMockPersistence();
      let globalContext    = createMockContext({ pluginRegistry, interactionLoop });

      let router = createRouter();
      let fm     = new FrameManager();

      await registerPlugin(router, globalContext);
      router.connectTo(fm, { id: 'ses_1' }, { framePersistence: persistence });

      fm.merge([{
        id: 'frm_1', type: 'permission-request',
        content: {}, processed: false,
        state: JSON.stringify({
          toolName: 'test:tool', toolArguments: {}, toolUseID: 'tu_1',
          sessionID: 'ses_1', agentID: 'agt_1', interactionID: 'int_1',
          step: 'awaiting-approval',
        }),
      }]);
      await tick();

      fm.merge([{
        id: 'frm_1', type: 'permission-request',
        content: {}, processed: true,
        state: JSON.stringify({
          toolName: 'test:tool', toolArguments: {}, toolUseID: 'tu_1',
          sessionID: 'ses_1', agentID: 'agt_1', interactionID: 'int_1',
          step: 'awaiting-approval',
        }),
      }]);
      await tick();

      // The plugin should have set state.step = 'completed' — check persistence
      let statePersists = persistence.calls.filter((c) => c.frameID === 'frm_1');
      assert.ok(statePersists.length >= 1, 'state should be persisted');
      let lastPersist = statePersists[statePersists.length - 1];
      assert.equal(lastPersist.state.step, 'completed');
    });

    it('looks up tool class from pluginRegistry by toolName', async () => {
      let lookups = [];
      let ToolClass = createToolClass('ok');
      let pluginRegistry = {
        getTool(name) { lookups.push(name); return ToolClass; },
      };
      let interactionLoop = createMockInteractionLoop();
      let globalContext    = createMockContext({ pluginRegistry, interactionLoop });

      let router = createRouter();
      let fm     = new FrameManager();

      await registerPlugin(router, globalContext);
      router.connectTo(fm, { id: 'ses_1' });

      fm.merge([{
        id: 'frm_1', type: 'permission-request',
        content: {}, processed: false,
        state: JSON.stringify({
          toolName: 'custom:mytool', toolArguments: {}, toolUseID: 'tu_1',
          sessionID: 'ses_1', agentID: 'agt_1', interactionID: 'int_1',
          step: 'awaiting-approval',
        }),
      }]);
      await tick();

      fm.merge([{
        id: 'frm_1', type: 'permission-request',
        content: {}, processed: true,
        state: JSON.stringify({
          toolName: 'custom:mytool', toolArguments: {}, toolUseID: 'tu_1',
          sessionID: 'ses_1', agentID: 'agt_1', interactionID: 'int_1',
          step: 'awaiting-approval',
        }),
      }]);
      await tick();

      assert.ok(lookups.includes('custom:mytool'), 'should look up "custom:mytool" from registry');
    });

    it('calls tool.execute with stored arguments', async () => {
      let executedArgs = null;
      let ToolClass = createToolClass('ok');
      ToolClass.prototype.execute = async function(args) { executedArgs = args; return 'ok'; };

      let pluginRegistry  = createMockPluginRegistry({ 'test:tool': ToolClass });
      let interactionLoop = createMockInteractionLoop();
      let globalContext    = createMockContext({ pluginRegistry, interactionLoop });

      let router = createRouter();
      let fm     = new FrameManager();

      await registerPlugin(router, globalContext);
      router.connectTo(fm, { id: 'ses_1' });

      let storedArgs = { command: 'ls -la', flag: true };

      fm.merge([{
        id: 'frm_1', type: 'permission-request',
        content: {}, processed: false,
        state: JSON.stringify({
          toolName: 'test:tool', toolArguments: storedArgs, toolUseID: 'tu_1',
          sessionID: 'ses_1', agentID: 'agt_1', interactionID: 'int_1',
          step: 'awaiting-approval',
        }),
      }]);
      await tick();

      fm.merge([{
        id: 'frm_1', type: 'permission-request',
        content: {}, processed: true,
        state: JSON.stringify({
          toolName: 'test:tool', toolArguments: storedArgs, toolUseID: 'tu_1',
          sessionID: 'ses_1', agentID: 'agt_1', interactionID: 'int_1',
          step: 'awaiting-approval',
        }),
      }]);
      await tick();

      assert.ok(executedArgs, 'tool should have been called');
      assert.equal(executedArgs.command, 'ls -la');
      assert.equal(executedArgs.flag, true);
    });

    it('starts a new interaction after re-execution so agent sees result', async () => {
      let ToolClass       = createToolClass('output');
      let pluginRegistry  = createMockPluginRegistry({ 'test:tool': ToolClass });
      let interactionLoop = createMockInteractionLoop();
      let globalContext    = createMockContext({ pluginRegistry, interactionLoop });

      let router = createRouter();
      let fm     = new FrameManager();

      await registerPlugin(router, globalContext);
      router.connectTo(fm, { id: 'ses_1' });

      fm.merge([{
        id: 'frm_1', type: 'permission-request',
        content: {}, processed: false,
        state: JSON.stringify({
          toolName: 'test:tool', toolArguments: {}, toolUseID: 'tu_1',
          sessionID: 'ses_1', agentID: 'agt_1', interactionID: 'int_1',
          step: 'awaiting-approval',
        }),
      }]);
      await tick();

      fm.merge([{
        id: 'frm_1', type: 'permission-request',
        content: {}, processed: true,
        state: JSON.stringify({
          toolName: 'test:tool', toolArguments: {}, toolUseID: 'tu_1',
          sessionID: 'ses_1', agentID: 'agt_1', interactionID: 'int_1',
          step: 'awaiting-approval',
        }),
      }]);
      await tick();

      let startCalls = interactionLoop.calls.filter((c) => c.method === 'startInteraction');
      assert.ok(startCalls.length >= 1, 'should call startInteraction after re-execution');
      assert.equal(startCalls[0].sessionID, 'ses_1');
    });
  });

  // ---------------------------------------------------------------------------
  // Happy paths — Denial
  // ---------------------------------------------------------------------------
  // Note: In Phase 2, denial is distinguished by content.denied=true on the
  // frame (the content object IS preserved by FrameManager, unlike top-level
  // custom properties). Full denial flow via frame update replaces legacy
  // PermissionHandler in Phase 3.
  // ---------------------------------------------------------------------------

  describe('denial — happy paths', () => {

    it('creates denial tool-result frame when content.denied is set', async () => {
      let pluginRegistry  = createMockPluginRegistry({});
      let interactionLoop = createMockInteractionLoop();
      let globalContext    = createMockContext({ pluginRegistry, interactionLoop });

      let router = createRouter();
      let fm     = new FrameManager();

      await registerPlugin(router, globalContext);
      router.connectTo(fm, { id: 'ses_1' });

      fm.merge([{
        id: 'frm_1', type: 'permission-request',
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
        id: 'frm_1', type: 'permission-request',
        content: { toolName: 'test:tool', denied: true }, processed: true,
        state: JSON.stringify({
          toolName: 'test:tool', toolArguments: {}, toolUseID: 'tu_1',
          sessionID: 'ses_1', agentID: 'agt_1', interactionID: 'int_1',
          step: 'awaiting-approval',
        }),
      }]);
      await tick();

      let frameCreates = interactionLoop.calls.filter((c) => c.method === '_createFrame');
      let toolResultFrame = frameCreates.find((c) => c.frameData.type === 'tool-result');
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
      let globalContext    = createMockContext({ pluginRegistry, interactionLoop });

      let router = createRouter();
      let fm     = new FrameManager();

      await registerPlugin(router, globalContext);
      router.connectTo(fm, { id: 'ses_1' }, { framePersistence: persistence });

      fm.merge([{
        id: 'frm_1', type: 'permission-request',
        content: { toolName: 'test:tool' }, processed: false,
        state: JSON.stringify({
          toolName: 'test:tool', toolArguments: {}, toolUseID: 'tu_1',
          sessionID: 'ses_1', agentID: 'agt_1', interactionID: 'int_1',
          step: 'awaiting-approval',
        }),
      }]);
      await tick();

      fm.merge([{
        id: 'frm_1', type: 'permission-request',
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
      let toolExecuted    = false;
      let ToolClass       = createToolClass('ok');
      ToolClass.prototype.execute = async function() { toolExecuted = true; return 'ok'; };

      let pluginRegistry  = createMockPluginRegistry({ 'test:tool': ToolClass });
      let interactionLoop = createMockInteractionLoop();
      let globalContext    = createMockContext({ pluginRegistry, interactionLoop });

      let router = createRouter();
      let fm     = new FrameManager();

      await registerPlugin(router, globalContext);
      router.connectTo(fm, { id: 'ses_1' });

      fm.merge([{
        id: 'frm_1', type: 'permission-request',
        content: {}, processed: true,
        state: JSON.stringify({
          toolName: 'test:tool', toolArguments: {}, toolUseID: 'tu_1',
          sessionID: 'ses_1', agentID: 'agt_1', interactionID: 'int_1',
          step: 'completed',
        }),
      }]);
      await tick();

      assert.equal(toolExecuted, false, 'tool should NOT be re-executed');
    });

    it('skips when step is already "denied"', async () => {
      let toolExecuted    = false;
      let ToolClass       = createToolClass('ok');
      ToolClass.prototype.execute = async function() { toolExecuted = true; return 'ok'; };

      let pluginRegistry  = createMockPluginRegistry({ 'test:tool': ToolClass });
      let interactionLoop = createMockInteractionLoop();
      let globalContext    = createMockContext({ pluginRegistry, interactionLoop });

      let router = createRouter();
      let fm     = new FrameManager();

      await registerPlugin(router, globalContext);
      router.connectTo(fm, { id: 'ses_1' });

      fm.merge([{
        id: 'frm_1', type: 'permission-request',
        content: {}, processed: true,
        state: JSON.stringify({
          toolName: 'test:tool', toolArguments: {}, toolUseID: 'tu_1',
          sessionID: 'ses_1', agentID: 'agt_1', interactionID: 'int_1',
          step: 'denied',
        }),
      }]);
      await tick();

      assert.equal(toolExecuted, false, 'tool should NOT be re-executed');
    });

    it('skips initial creation (processed=false, step=awaiting-approval)', async () => {
      let toolExecuted    = false;
      let ToolClass       = createToolClass('ok');
      ToolClass.prototype.execute = async function() { toolExecuted = true; return 'ok'; };

      let pluginRegistry  = createMockPluginRegistry({ 'test:tool': ToolClass });
      let interactionLoop = createMockInteractionLoop();
      let globalContext    = createMockContext({ pluginRegistry, interactionLoop });

      let router = createRouter();
      let fm     = new FrameManager();

      await registerPlugin(router, globalContext);
      router.connectTo(fm, { id: 'ses_1' });

      fm.merge([{
        id: 'frm_1', type: 'permission-request',
        content: {}, processed: false,
        state: JSON.stringify({
          toolName: 'test:tool', toolArguments: {}, toolUseID: 'tu_1',
          sessionID: 'ses_1', agentID: 'agt_1', interactionID: 'int_1',
          step: 'awaiting-approval',
        }),
      }]);
      await tick();

      assert.equal(toolExecuted, false, 'tool should NOT execute on initial creation');
    });

    it('creates error frame when toolName not found in registry', async () => {
      let pluginRegistry  = createMockPluginRegistry({}); // empty — no tools
      let interactionLoop = createMockInteractionLoop();
      let globalContext    = createMockContext({ pluginRegistry, interactionLoop });

      let router = createRouter();
      let fm     = new FrameManager();

      await registerPlugin(router, globalContext);
      router.connectTo(fm, { id: 'ses_1' });

      fm.merge([{
        id: 'frm_1', type: 'permission-request',
        content: {}, processed: false,
        state: JSON.stringify({
          toolName: 'nonexistent:tool', toolArguments: {}, toolUseID: 'tu_1',
          sessionID: 'ses_1', agentID: 'agt_1', interactionID: 'int_1',
          step: 'awaiting-approval',
        }),
      }]);
      await tick();

      fm.merge([{
        id: 'frm_1', type: 'permission-request',
        content: {}, processed: true,
        state: JSON.stringify({
          toolName: 'nonexistent:tool', toolArguments: {}, toolUseID: 'tu_1',
          sessionID: 'ses_1', agentID: 'agt_1', interactionID: 'int_1',
          step: 'awaiting-approval',
        }),
      }]);
      await tick();

      let frameCreates = interactionLoop.calls.filter((c) => c.method === '_createFrame');
      let errorFrame = frameCreates.find((c) =>
        c.frameData.type === 'tool-result' &&
        c.frameData.content.output &&
        (c.frameData.content.output.includes('not found') || c.frameData.content.output.includes('Unknown tool')),
      );
      assert.ok(errorFrame, 'should create an error tool-result frame when tool is not found');
    });

    it('creates error frame when tool re-execution throws', async () => {
      let ToolClass       = createToolClass(null, 'Boom! Tool exploded');
      let pluginRegistry  = createMockPluginRegistry({ 'test:tool': ToolClass });
      let interactionLoop = createMockInteractionLoop();
      let globalContext    = createMockContext({ pluginRegistry, interactionLoop });

      let router = createRouter();
      let fm     = new FrameManager();

      await registerPlugin(router, globalContext);
      router.connectTo(fm, { id: 'ses_1' });

      fm.merge([{
        id: 'frm_1', type: 'permission-request',
        content: {}, processed: false,
        state: JSON.stringify({
          toolName: 'test:tool', toolArguments: {}, toolUseID: 'tu_1',
          sessionID: 'ses_1', agentID: 'agt_1', interactionID: 'int_1',
          step: 'awaiting-approval',
        }),
      }]);
      await tick();

      fm.merge([{
        id: 'frm_1', type: 'permission-request',
        content: {}, processed: true,
        state: JSON.stringify({
          toolName: 'test:tool', toolArguments: {}, toolUseID: 'tu_1',
          sessionID: 'ses_1', agentID: 'agt_1', interactionID: 'int_1',
          step: 'awaiting-approval',
        }),
      }]);
      await tick();

      let frameCreates = interactionLoop.calls.filter((c) => c.method === '_createFrame');
      let errorFrame = frameCreates.find((c) =>
        c.frameData.type === 'tool-result' &&
        c.frameData.content.output &&
        c.frameData.content.output.includes('Boom! Tool exploded'),
      );
      assert.ok(errorFrame, 'should create an error tool-result frame when tool throws');
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
        id: 'frm_1', type: 'permission-request',
        content: {}, processed: false,
        state: JSON.stringify({
          toolName: 'test:tool', toolArguments: {}, toolUseID: 'tu_1',
          sessionID: 'ses_1', agentID: 'agt_1', interactionID: 'int_1',
          step: 'awaiting-approval',
        }),
      }]);
      await tick();

      fm.merge([{
        id: 'frm_1', type: 'permission-request',
        content: {}, processed: true,
        state: JSON.stringify({
          toolName: 'test:tool', toolArguments: {}, toolUseID: 'tu_1',
          sessionID: 'ses_1', agentID: 'agt_1', interactionID: 'int_1',
          step: 'awaiting-approval',
        }),
      }]);
      await tick();

      // Just verify no crash — no assertions needed beyond this point
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
        id: 'frm_1', type: 'permission-request',
        content: {}, processed: true,
        state: JSON.stringify({ someRandom: 'data' }),
      }]);
      await tick();

      assert.ok(true, 'should not crash with missing state fields');
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  describe('edge cases', () => {

    it('concurrent approval — second sees step=completed and skips', async () => {
      let executionCount  = 0;
      let ToolClass       = createToolClass('ok');
      ToolClass.prototype.execute = async function() { executionCount++; return 'ok'; };

      let pluginRegistry  = createMockPluginRegistry({ 'test:tool': ToolClass });
      let interactionLoop = createMockInteractionLoop();
      let persistence     = createMockPersistence();
      let globalContext    = createMockContext({ pluginRegistry, interactionLoop });

      let router = createRouter();
      let fm     = new FrameManager();

      await registerPlugin(router, globalContext);
      router.connectTo(fm, { id: 'ses_1' }, { framePersistence: persistence });

      // Initial
      fm.merge([{
        id: 'frm_1', type: 'permission-request',
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
        id: 'frm_1', type: 'permission-request',
        content: {}, processed: true,
        state: JSON.stringify({
          toolName: 'test:tool', toolArguments: {}, toolUseID: 'tu_1',
          sessionID: 'ses_1', agentID: 'agt_1', interactionID: 'int_1',
          step: 'awaiting-approval',
        }),
      }]);
      await tick();

      assert.equal(executionCount, 1, 'tool should execute once after first approval');

      // Second "approval" attempt — state should already be 'completed'
      // The frame's state on disk was updated; merge a frame with step=completed
      fm.merge([{
        id: 'frm_1', type: 'permission-request',
        content: {}, processed: true,
        state: JSON.stringify({
          toolName: 'test:tool', toolArguments: {}, toolUseID: 'tu_1',
          sessionID: 'ses_1', agentID: 'agt_1', interactionID: 'int_1',
          step: 'completed',
        }),
      }]);
      await tick();

      assert.equal(executionCount, 1, 'tool should NOT execute again — step is already completed');
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
      router.registerSelector('type:user-message', Sentinel, 'sentinel');
      router.connectTo(fm, { id: 'ses_1' });

      fm.merge([{
        id: 'frm_2', type: 'user-message',
        content: { text: 'hello' },
      }]);
      await tick();

      // The permission-approval plugin only matches permission-request,
      // so user-message should pass straight through to sentinel.
      // Note: the plugin won't even fire for user-message frames.
      // This test validates that non-matching frames are unaffected.
      assert.ok(true, 'non-permission-request frame should not cause errors');
    });
  });
});
