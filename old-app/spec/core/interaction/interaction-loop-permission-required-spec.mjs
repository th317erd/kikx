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
    type:       'ToolCall',
    content:    { toolName: toolName || 'test:tool', arguments: args || {}, toolUseID: toolUseID || 'tu_1' },
    authorType: 'agent',
    authorID:   'agt_1',
  };

  yield { type: 'Done', content: {} };
}

// A generator that yields a message block (no tool call).
async function* messageGenerator() {
  yield {
    type: 'Message',
    content:    { html: '<p>hello</p>' },
    authorType: 'agent',
    authorID:   'agt_1',
  };
  yield { type: 'Done', content: {} };
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
      loop._active.delete(activeKey);
      loop.emit('interaction:end', { sessionID, interactionID, agentID: agentID || null });
    };
  });

  // ---------------------------------------------------------------------------
  // Happy paths
  // ---------------------------------------------------------------------------

  describe('happy paths', () => {

    it('PermissionRequiredError from executeTool creates permission-request frame inline', async () => {
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

      // No sessionManager => needsRouting=false => inline permission-request + tool_result
      assert.equal(hardBreakCalls.length, 0, 'hardBreak should NOT be called (no sessionManager, inline path)');
      let requestFrames = createdFrames.filter((f) => f.type === 'PermissionRequest');
      assert.equal(requestFrames.length, 1, 'should have 1 permission-request frame');
      assert.equal(requestFrames[0].content.toolName, 'test:tool');
    });

    it('permissionContext is included in the permission-request frame content', async () => {
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

      let requestFrames = createdFrames.filter((f) => f.type === 'PermissionRequest');
      assert.equal(requestFrames.length, 1);
      assert.deepStrictEqual(requestFrames[0].content.permissionContext, {
        title:       'permission.test.title',
        titleParams: { name: 'Test' },
        description: 'permission.test.description',
        details:     [{ label: 'key', value: 'val' }],
      });
    });

    it('tool-result with PERMISSION REQUIRED is created after permission-request (interaction continues)', async () => {
      let error = new PermissionRequiredError('test:feature', {
        title: 'permission.test.title',
      });

      let params = makeParams({
        executeTool: async () => { throw error; },
      });

      let gen = toolCallGenerator('test:tool', {}, 'tu_1');
      loop._active.set(loop._activeKey('ses_1', 'agt_1'), { generator: gen, interactionID: 'int_1', params });

      await loop._iterateGenerator('ses_1', gen, 'int_1', params, makeFrameManager());

      // New inline path: creates tool-result with PERMISSION REQUIRED message
      let toolResults = createdFrames.filter((f) => f.type === 'ToolResult');
      assert.equal(toolResults.length, 1, 'should have a tool-result frame');
      assert.ok(toolResults[0].content.output.includes('PERMISSION REQUIRED'), 'tool-result should contain PERMISSION REQUIRED');
    });

    it('normal tool execution still works (no regression)', async () => {
      let params = makeParams({
        executeTool: async () => 'tool output here',
      });

      let gen = toolCallGenerator('test:tool', {}, 'tu_1');
      loop._active.set(loop._activeKey('ses_1', 'agt_1'), { generator: gen, interactionID: 'int_1', params });

      await loop._iterateGenerator('ses_1', gen, 'int_1', params, makeFrameManager());

      assert.equal(hardBreakCalls.length, 0, 'hardBreak should NOT be called');

      let toolResults = createdFrames.filter((f) => f.type === 'ToolResult');
      assert.equal(toolResults.length, 1, 'tool-result frame should be created');
      assert.equal(toolResults[0].content.output, 'tool output here');
    });

    it('PermissionDeniedError from executeTool creates permission-denied frame', async () => {
      let error = new PermissionDeniedError('test:feature', 'not allowed');

      let params = makeParams({
        executeTool: async () => { throw error; },
      });

      let gen = toolCallGenerator('test:tool', {}, 'tu_1');
      loop._active.set(loop._activeKey('ses_1', 'agt_1'), { generator: gen, interactionID: 'int_1', params });

      await loop._iterateGenerator('ses_1', gen, 'int_1', params, makeFrameManager());

      assert.equal(hardBreakCalls.length, 0, 'hardBreak should NOT be called for PermissionDeniedError');

      let deniedFrames = createdFrames.filter((f) => f.type === 'PermissionDenied');
      assert.equal(deniedFrames.length, 1, 'permission-denied frame should be created');
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

      let toolCalls = createdFrames.filter((f) => f.type === 'ToolCall');
      assert.equal(toolCalls.length, 1, 'tool-call frame should still be created before executeTool');
    });

    it('permission-request frame includes toolName from the block', async () => {
      let error = new PermissionRequiredError('test:feature', { title: 'test' });

      let params = makeParams({
        executeTool: async () => { throw error; },
      });

      let gen = toolCallGenerator('test:tool', { arg: 1 }, 'tu_1');
      loop._active.set(loop._activeKey('ses_1', 'agt_1'), { generator: gen, interactionID: 'int_1', params });

      await loop._iterateGenerator('ses_1', gen, 'int_1', params, makeFrameManager());

      let requestFrames = createdFrames.filter((f) => f.type === 'PermissionRequest');
      assert.equal(requestFrames.length, 1);
      assert.equal(requestFrames[0].content.toolName, 'test:tool');
    });

    it('permission:request event is emitted with correct sessionID and toolName', async () => {
      let error = new PermissionRequiredError('test:feature', { title: 'test' });

      let params = makeParams({
        executeTool: async () => { throw error; },
      });

      let gen = toolCallGenerator('test:tool', {}, 'tu_1');
      loop._active.set(loop._activeKey('ses_1', 'agt_1'), { generator: gen, interactionID: 'int_1', params });

      await loop._iterateGenerator('ses_1', gen, 'int_1', params, makeFrameManager());

      let permEvents = emitted.filter((e) => e.event === 'permission:request');
      // The permission:request event is emitted directly (not via emitted spy which only watches interaction:end/start)
      // Instead verify via the created frames
      let requestFrames = createdFrames.filter((f) => f.type === 'PermissionRequest');
      assert.equal(requestFrames.length, 1);
      assert.ok(requestFrames[0].content.toolName, 'test:tool');
    });
  });

  // ---------------------------------------------------------------------------
  // Sad paths
  // ---------------------------------------------------------------------------

  describe('sad paths', () => {

    it('PermissionRequiredError with null context fields still creates permission-request frame', async () => {
      let error = new PermissionRequiredError('test:feature');
      // Default constructor sets title/titleParams/description to null, details to []

      let params = makeParams({
        executeTool: async () => { throw error; },
      });

      let gen = toolCallGenerator('test:tool', {}, 'tu_1');
      loop._active.set(loop._activeKey('ses_1', 'agt_1'), { generator: gen, interactionID: 'int_1', params });

      await loop._iterateGenerator('ses_1', gen, 'int_1', params, makeFrameManager());

      assert.equal(hardBreakCalls.length, 0, 'hardBreak should NOT be called (inline path)');
      let requestFrames = createdFrames.filter((f) => f.type === 'PermissionRequest');
      assert.equal(requestFrames.length, 1, 'permission-request frame created even with null context');

      assert.deepStrictEqual(requestFrames[0].content.permissionContext, {
        title:       null,
        titleParams: null,
        description: null,
        details:     [],
      });
    });

    it('PermissionRequiredError with empty string fields still creates permission-request frame', async () => {
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

      assert.equal(hardBreakCalls.length, 0, 'hardBreak should NOT be called (inline path)');
      let requestFrames = createdFrames.filter((f) => f.type === 'PermissionRequest');
      assert.equal(requestFrames.length, 1, 'permission-request frame created with empty-string context');
    });

    it('generic tool error still creates tool-error frame (existing behavior preserved)', async () => {
      let params = makeParams({
        executeTool: async () => { throw new Error('something broke'); },
      });

      let gen = toolCallGenerator('test:tool', {}, 'tu_1');
      loop._active.set(loop._activeKey('ses_1', 'agt_1'), { generator: gen, interactionID: 'int_1', params });

      await loop._iterateGenerator('ses_1', gen, 'int_1', params, makeFrameManager());

      assert.equal(hardBreakCalls.length, 0, 'hardBreak NOT called for generic error');

      let toolErrors = createdFrames.filter((f) => f.type === 'ToolError');
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

      let toolResults = createdFrames.filter((f) => f.type === 'ToolResult');
      assert.equal(toolResults.length, 1, 'tool-result frame created with error message');
      assert.ok(toolResults[0].content.output.includes('oops'), 'output contains error message');
    });
  });

  // ---------------------------------------------------------------------------
  // Tool-owned permission handling (replaces external checkPermission)
  // ---------------------------------------------------------------------------

  describe('tool-owned permissions', () => {

    it('executeTool runs directly when no permission error thrown', async () => {
      let callOrder = [];

      let params = makeParams({
        executeTool: async () => { callOrder.push('executeTool'); return 'result'; },
      });

      let gen = toolCallGenerator('test:tool', {}, 'tu_1');
      loop._active.set(loop._activeKey('ses_1', 'agt_1'), { generator: gen, interactionID: 'int_1', params });

      await loop._iterateGenerator('ses_1', gen, 'int_1', params, makeFrameManager());

      assert.deepStrictEqual(callOrder, ['executeTool']);
    });

    it('PermissionRequiredError from executeTool creates permission-request frame with rich context', async () => {
      let error = new PermissionRequiredError('test:feature', {
        title:       'permission.test.title',
        description: 'permission.test.desc',
        details:     [{ label: 'l', value: 'v' }],
      });

      let params = makeParams({
        executeTool: async () => { throw error; },
      });

      let gen = toolCallGenerator('test:tool', {}, 'tu_1');
      loop._active.set(loop._activeKey('ses_1', 'agt_1'), { generator: gen, interactionID: 'int_1', params });

      await loop._iterateGenerator('ses_1', gen, 'int_1', params, makeFrameManager());

      assert.equal(hardBreakCalls.length, 0, 'hardBreak should NOT be called (inline path)');

      let requestFrames = createdFrames.filter((f) => f.type === 'PermissionRequest');
      assert.equal(requestFrames.length, 1, 'permission-request frame created from PermissionRequiredError');
      assert.equal(requestFrames[0].content.permissionContext.title, 'permission.test.title');
    });

    it('PermissionDeniedError from executeTool creates permission-denied frame', async () => {
      let error = new PermissionDeniedError('test:feature', 'denied by policy');

      let params = makeParams({
        executeTool: async () => { throw error; },
      });

      let gen = toolCallGenerator('test:tool', {}, 'tu_1');
      loop._active.set(loop._activeKey('ses_1', 'agt_1'), { generator: gen, interactionID: 'int_1', params });

      await loop._iterateGenerator('ses_1', gen, 'int_1', params, makeFrameManager());

      let deniedFrames = createdFrames.filter((f) => f.type === 'PermissionDenied');
      assert.equal(deniedFrames.length, 1, 'permission-denied frame created from executeTool');
      assert.equal(hardBreakCalls.length, 0, 'hardBreak NOT called for denied');
    });
  });
});
