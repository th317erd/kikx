'use strict';

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { InteractionLoop }          from '../../../src/core/interaction/index.mjs';
import { PermissionRequiredError }  from '../../../src/core/permissions/permission-required-error.mjs';
import { PermissionDeniedError }    from '../../../src/core/permissions/permission-denied-error.mjs';

// =============================================================================
// Step 1.3 — InteractionLoop catches PermissionRequiredError from executeTool
// =============================================================================
// Tests that _iterateGenerator routes PermissionRequiredError to hardBreak()
// with the rich permissionContext, while preserving existing error flows.
// =============================================================================

// ---------------------------------------------------------------------------
// Helpers — minimal mock context and generator
// ---------------------------------------------------------------------------

function makeContext(overrides = {}) {
  let props = {
    contentSanitizer: null,
    hookService:      null,
    hookRunner:       null,
    models:           null,
    keystore:         null,
    ...overrides,
  };
  return {
    getProperty(name) { return props[name] || null; },
    setProperty(name, val) { props[name] = val; },
  };
}

// A generator that yields a single tool-call block, then done.
async function* toolCallGenerator(toolName, args, toolUseID) {
  let result = yield {
    type:       'tool-call',
    content:    { toolName: toolName || 'test:tool', arguments: args || {}, toolUseID: toolUseID || 'tu_1' },
    authorType: 'agent',
    authorID:   'agt_1',
  };

  yield { type: 'done', content: {} };
}

// A generator that yields a message block (no tool call).
async function* messageGenerator() {
  yield {
    type:       'message',
    content:    { html: '<p>hello</p>' },
    authorType: 'agent',
    authorID:   'agt_1',
  };
  yield { type: 'done', content: {} };
}

function makeFrameManager() {
  let refs = new Map();
  return {
    getRef(name)          { return refs.get(name); },
    createRef(name, val)  { refs.set(name, val); },
    updateRef(name, val)  { refs.set(name, val); },
  };
}

function makeParams(overrides = {}) {
  return {
    agent:           { id: 'agt_1', organizationID: 'org_1' },
    agentPlugin:     {},
    executeTool:     async () => 'ok',
    checkPermission: null,
    parentID:        null,
    _signingContext:  null,
    ...overrides,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('InteractionLoop — PermissionRequiredError routing (Step 1.3)', () => {
  let loop;
  let createdFrames;
  let emitted;
  let hardBreakCalls;
  let originalHardBreak;

  beforeEach(() => {
    createdFrames  = [];
    emitted        = [];
    hardBreakCalls = [];

    loop = new InteractionLoop(makeContext());

    // Stub _createFrame to capture frames without DB
    loop._createFrame = async (_sid, frameData, _fm, _opts, _sigCtx) => {
      createdFrames.push(frameData);
      return frameData;
    };

    // Stub _storeAndMaybeReplaceToolOutput to pass through
    loop._storeAndMaybeReplaceToolOutput = async (_sid, _iid, _block, _params, output) => output;

    // Capture events
    loop.on('interaction:end', (data) => emitted.push({ event: 'interaction:end', data }));
    loop.on('interaction:start', (data) => emitted.push({ event: 'interaction:start', data }));

    // Spy on hardBreak
    originalHardBreak = loop._permissionHandler.hardBreak.bind(loop._permissionHandler);
    loop._permissionHandler.hardBreak = async (...args) => {
      hardBreakCalls.push(args);
      // Simulate what hardBreak does: destroy generator, remove from active, emit end
      let [sessionID, generator, block, interactionID, params] = args;
      await generator.return();
      let agentID   = params.agent && params.agent.id;
      let activeKey = loop._activeKey(sessionID, agentID);
      loop._permissionWaiting.set(activeKey, { interactionID, params });
      loop._active.delete(activeKey);
      loop.emit('interaction:end', { sessionID, interactionID, agentID: agentID || null });
    };
  });

  // ---------------------------------------------------------------------------
  // Happy paths
  // ---------------------------------------------------------------------------

  describe('happy paths', () => {

    it('PermissionRequiredError from executeTool calls hardBreak with permissionContext', async () => {
      let error = new PermissionRequiredError('test:feature', {
        title:       'permission.test.title',
        titleParams: { name: 'Test' },
        description: 'permission.test.description',
        details:     [{ label: 'key', value: 'val' }],
      });

      let params = makeParams({
        executeTool: async () => { throw error; },
      });

      let gen = toolCallGenerator('test:tool', { arg: 1 }, 'tu_1');
      loop._active.set(loop._activeKey('ses_1', 'agt_1'), { generator: gen, interactionID: 'int_1', params });

      await loop._iterateGenerator('ses_1', gen, 'int_1', params, makeFrameManager());

      assert.equal(hardBreakCalls.length, 1, 'hardBreak should be called once');
    });

    it('permissionContext includes title, titleParams, description, details from the error', async () => {
      let error = new PermissionRequiredError('test:feature', {
        title:       'permission.test.title',
        titleParams: { name: 'Test' },
        description: 'permission.test.description',
        details:     [{ label: 'key', value: 'val' }],
      });

      let params = makeParams({
        executeTool: async () => { throw error; },
      });

      let gen = toolCallGenerator('test:tool', {}, 'tu_1');
      loop._active.set(loop._activeKey('ses_1', 'agt_1'), { generator: gen, interactionID: 'int_1', params });

      await loop._iterateGenerator('ses_1', gen, 'int_1', params, makeFrameManager());

      let [, , , , , , permCtx] = hardBreakCalls[0];
      assert.deepStrictEqual(permCtx, {
        title:       'permission.test.title',
        titleParams: { name: 'Test' },
        description: 'permission.test.description',
        details:     [{ label: 'key', value: 'val' }],
      });
    });

    it('generator is destroyed after hardBreak (returns from _iterateGenerator)', async () => {
      let error = new PermissionRequiredError('test:feature', {
        title: 'permission.test.title',
      });

      let params = makeParams({
        executeTool: async () => { throw error; },
      });

      let gen = toolCallGenerator('test:tool', {}, 'tu_1');
      loop._active.set(loop._activeKey('ses_1', 'agt_1'), { generator: gen, interactionID: 'int_1', params });

      await loop._iterateGenerator('ses_1', gen, 'int_1', params, makeFrameManager());

      // After hardBreak, the loop should have returned (no more frames after tool-call)
      // No tool-result frame should exist
      let toolResults = createdFrames.filter((f) => f.type === 'tool-result');
      assert.equal(toolResults.length, 0, 'no tool-result frame after hardBreak');
    });

    it('normal tool execution still works (no regression)', async () => {
      let params = makeParams({
        executeTool: async () => 'tool output here',
      });

      let gen = toolCallGenerator('test:tool', {}, 'tu_1');
      loop._active.set(loop._activeKey('ses_1', 'agt_1'), { generator: gen, interactionID: 'int_1', params });

      await loop._iterateGenerator('ses_1', gen, 'int_1', params, makeFrameManager());

      assert.equal(hardBreakCalls.length, 0, 'hardBreak should NOT be called');

      let toolResults = createdFrames.filter((f) => f.type === 'tool-result');
      assert.equal(toolResults.length, 1, 'tool-result frame should be created');
      assert.equal(toolResults[0].content.output, 'tool output here');
    });

    it('PermissionDeniedError from executeTool still creates tool-error frame (no regression)', async () => {
      let error = new PermissionDeniedError('test:feature', 'not allowed');

      let params = makeParams({
        executeTool: async () => { throw error; },
      });

      let gen = toolCallGenerator('test:tool', {}, 'tu_1');
      loop._active.set(loop._activeKey('ses_1', 'agt_1'), { generator: gen, interactionID: 'int_1', params });

      await loop._iterateGenerator('ses_1', gen, 'int_1', params, makeFrameManager());

      assert.equal(hardBreakCalls.length, 0, 'hardBreak should NOT be called for PermissionDeniedError');

      let toolErrors = createdFrames.filter((f) => f.type === 'tool-error');
      assert.equal(toolErrors.length, 1, 'tool-error frame should be created');
    });

    it('tool-call frame is created before PermissionRequiredError catch', async () => {
      let error = new PermissionRequiredError('test:feature', {
        title: 'permission.test.title',
      });

      let params = makeParams({
        executeTool: async () => { throw error; },
      });

      let gen = toolCallGenerator('test:tool', { arg: 'x' }, 'tu_1');
      loop._active.set(loop._activeKey('ses_1', 'agt_1'), { generator: gen, interactionID: 'int_1', params });

      await loop._iterateGenerator('ses_1', gen, 'int_1', params, makeFrameManager());

      let toolCalls = createdFrames.filter((f) => f.type === 'tool-call');
      assert.equal(toolCalls.length, 1, 'tool-call frame should still be created before executeTool');
    });

    it('hardBreak receives correct sessionID, generator, block, interactionID, params', async () => {
      let error = new PermissionRequiredError('test:feature', { title: 'test' });

      let params = makeParams({
        executeTool: async () => { throw error; },
      });

      let gen = toolCallGenerator('test:tool', { arg: 1 }, 'tu_1');
      loop._active.set(loop._activeKey('ses_1', 'agt_1'), { generator: gen, interactionID: 'int_1', params });

      await loop._iterateGenerator('ses_1', gen, 'int_1', params, makeFrameManager());

      let [sid, , block, iid, p] = hardBreakCalls[0];
      assert.equal(sid, 'ses_1');
      assert.equal(iid, 'int_1');
      assert.equal(p, params);
      assert.equal(block.content.toolName, 'test:tool');
    });

    it('hardBreak receives frameManager as 6th argument', async () => {
      let error = new PermissionRequiredError('test:feature', { title: 'test' });
      let fm    = makeFrameManager();

      let params = makeParams({
        executeTool: async () => { throw error; },
      });

      let gen = toolCallGenerator('test:tool', {}, 'tu_1');
      loop._active.set(loop._activeKey('ses_1', 'agt_1'), { generator: gen, interactionID: 'int_1', params });

      await loop._iterateGenerator('ses_1', gen, 'int_1', params, fm);

      let [, , , , , receivedFm] = hardBreakCalls[0];
      assert.equal(receivedFm, fm);
    });
  });

  // ---------------------------------------------------------------------------
  // Sad paths
  // ---------------------------------------------------------------------------

  describe('sad paths', () => {

    it('PermissionRequiredError with null context fields still calls hardBreak', async () => {
      let error = new PermissionRequiredError('test:feature');
      // Default constructor sets title/titleParams/description to null, details to []

      let params = makeParams({
        executeTool: async () => { throw error; },
      });

      let gen = toolCallGenerator('test:tool', {}, 'tu_1');
      loop._active.set(loop._activeKey('ses_1', 'agt_1'), { generator: gen, interactionID: 'int_1', params });

      await loop._iterateGenerator('ses_1', gen, 'int_1', params, makeFrameManager());

      assert.equal(hardBreakCalls.length, 1, 'hardBreak called even with null context');

      let [, , , , , , permCtx] = hardBreakCalls[0];
      assert.deepStrictEqual(permCtx, {
        title:       null,
        titleParams: null,
        description: null,
        details:     [],
      });
    });

    it('PermissionRequiredError with empty string fields still calls hardBreak', async () => {
      let error = new PermissionRequiredError('', {
        title:       '',
        titleParams: {},
        description: '',
        details:     [],
      });

      let params = makeParams({
        executeTool: async () => { throw error; },
      });

      let gen = toolCallGenerator('test:tool', {}, 'tu_1');
      loop._active.set(loop._activeKey('ses_1', 'agt_1'), { generator: gen, interactionID: 'int_1', params });

      await loop._iterateGenerator('ses_1', gen, 'int_1', params, makeFrameManager());

      assert.equal(hardBreakCalls.length, 1, 'hardBreak called with empty-string context');
    });

    it('generic tool error still creates tool-error frame (existing behavior preserved)', async () => {
      let params = makeParams({
        executeTool: async () => { throw new Error('something broke'); },
      });

      let gen = toolCallGenerator('test:tool', {}, 'tu_1');
      loop._active.set(loop._activeKey('ses_1', 'agt_1'), { generator: gen, interactionID: 'int_1', params });

      await loop._iterateGenerator('ses_1', gen, 'int_1', params, makeFrameManager());

      assert.equal(hardBreakCalls.length, 0, 'hardBreak NOT called for generic error');

      let toolErrors = createdFrames.filter((f) => f.type === 'tool-error');
      assert.equal(toolErrors.length, 1, 'tool-error frame created');
      assert.equal(toolErrors[0].content.message, 'something broke');
    });

    it('generic tool error toolOutput contains error message', async () => {
      let params = makeParams({
        executeTool: async () => { throw new Error('oops'); },
      });

      let gen = toolCallGenerator('test:tool', {}, 'tu_1');
      loop._active.set(loop._activeKey('ses_1', 'agt_1'), { generator: gen, interactionID: 'int_1', params });

      await loop._iterateGenerator('ses_1', gen, 'int_1', params, makeFrameManager());

      let toolResults = createdFrames.filter((f) => f.type === 'tool-result');
      assert.equal(toolResults.length, 1, 'tool-result frame created with error message');
      assert.ok(toolResults[0].content.output.includes('oops'), 'output contains error message');
    });
  });

  // ---------------------------------------------------------------------------
  // Backwards compatibility
  // ---------------------------------------------------------------------------

  describe('backwards compatibility', () => {

    it('external checkPermission still runs before executeTool', async () => {
      let callOrder = [];

      let params = makeParams({
        checkPermission: async () => { callOrder.push('checkPermission'); return false; },
        executeTool:     async () => { callOrder.push('executeTool'); return 'result'; },
      });

      let gen = toolCallGenerator('test:tool', {}, 'tu_1');
      loop._active.set(loop._activeKey('ses_1', 'agt_1'), { generator: gen, interactionID: 'int_1', params });

      await loop._iterateGenerator('ses_1', gen, 'int_1', params, makeFrameManager());

      assert.deepStrictEqual(callOrder, ['checkPermission', 'executeTool']);
    });

    it('external checkPermission returning true triggers hardBreak, executeTool never runs', async () => {
      let executeToolCalled = false;

      let params = makeParams({
        checkPermission: async () => true,
        executeTool:     async () => { executeToolCalled = true; return 'result'; },
      });

      let gen = toolCallGenerator('test:tool', {}, 'tu_1');
      loop._active.set(loop._activeKey('ses_1', 'agt_1'), { generator: gen, interactionID: 'int_1', params });

      await loop._iterateGenerator('ses_1', gen, 'int_1', params, makeFrameManager());

      assert.equal(executeToolCalled, false, 'executeTool should NOT be called');
      assert.equal(hardBreakCalls.length, 1, 'hardBreak called from external check');
    });

    it('external checkPermission and internal PermissionRequiredError can coexist', async () => {
      // External check passes (returns false), but executeTool throws PermissionRequiredError
      let error = new PermissionRequiredError('test:feature', {
        title:       'permission.test.title',
        description: 'permission.test.desc',
        details:     [{ label: 'l', value: 'v' }],
      });

      let params = makeParams({
        checkPermission: async () => false,
        executeTool:     async () => { throw error; },
      });

      let gen = toolCallGenerator('test:tool', {}, 'tu_1');
      loop._active.set(loop._activeKey('ses_1', 'agt_1'), { generator: gen, interactionID: 'int_1', params });

      await loop._iterateGenerator('ses_1', gen, 'int_1', params, makeFrameManager());

      assert.equal(hardBreakCalls.length, 1, 'hardBreak called from internal check');

      let [, , , , , , permCtx] = hardBreakCalls[0];
      assert.equal(permCtx.title, 'permission.test.title');
    });

    it('PermissionDeniedError from external checkPermission still creates permission-denied frame', async () => {
      let error = new PermissionDeniedError('test:feature', 'denied by policy');

      let params = makeParams({
        checkPermission: async () => { throw error; },
        executeTool:     async () => 'should not run',
      });

      let gen = toolCallGenerator('test:tool', {}, 'tu_1');
      loop._active.set(loop._activeKey('ses_1', 'agt_1'), { generator: gen, interactionID: 'int_1', params });

      await loop._iterateGenerator('ses_1', gen, 'int_1', params, makeFrameManager());

      let deniedFrames = createdFrames.filter((f) => f.type === 'permission-denied');
      assert.equal(deniedFrames.length, 1, 'permission-denied frame created from external check');
      assert.equal(hardBreakCalls.length, 0, 'hardBreak NOT called for denied');
    });
  });
});
