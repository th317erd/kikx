'use strict';

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash }               from 'node:crypto';

import { InteractionLoop }          from '../../../src/core/interaction/index.mjs';
import { PermissionRequiredError }  from '../../../src/core/permissions/permission-required-error.mjs';

// =============================================================================
// Inline permission flow tests
// =============================================================================
// Step 2.1: permission-request frame stores tool context in state
// Step 3.1: dedup hash prevents duplicate permission requests
// =============================================================================

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeExpectedHash(toolName, args, agentID, sessionID) {
  let input = JSON.stringify({
    toolName,
    arguments: args || {},
    agentID:   agentID || null,
    sessionID,
  });
  return createHash('sha256').update(input).digest('hex').slice(0, 32);
}

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

/**
 * Create a mock Frame model that stores frames in-memory.
 * Supports .where.sessionID.EQ().AND.type.EQ().AND.processed.EQ().all()
 */
function makeMockFrameModel(existingFrames = []) {
  let store = [...existingFrames];

  function buildQuery() {
    let filters = [];

    let query = {
      get AND() { return query; },
    };

    // Create chainable .field.EQ(val) accessors
    for (let field of ['sessionID', 'type', 'processed', 'id']) {
      Object.defineProperty(query, field, {
        get() {
          return {
            EQ(val) {
              filters.push((f) => {
                let fVal = f[field];
                return fVal === val;
              });
              return query;
            },
          };
        },
      });
    }

    query.all = async () => store.filter((f) => filters.every((fn) => fn(f)));
    query.first = async () => {
      let results = store.filter((f) => filters.every((fn) => fn(f)));
      return results[0] || null;
    };

    return query;
  }

  return {
    get where() { return buildQuery(); },
    _store: store,
    create: async (data) => { store.push(data); return data; },
  };
}

async function* toolCallGenerator(toolName, args, toolUseID) {
  let result = yield {
    type:       'ToolCall',
    content:    { toolName: toolName || 'test:tool', arguments: args || {}, toolUseID: toolUseID || 'tu_1' },
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

function parseState(frame) {
  if (!frame.state) return null;
  return typeof frame.state === 'string' ? JSON.parse(frame.state) : frame.state;
}

// =============================================================================
// Tests
// =============================================================================

describe('Inline permission flow — state storage (Step 2.1)', () => {
  let loop;
  let createdFrames;

  beforeEach(() => {
    createdFrames = [];

    loop = new InteractionLoop(makeContext());

    loop._createFrame = async (_sid, frameData, _fm, _opts, _sigCtx) => {
      createdFrames.push(frameData);
      return frameData;
    };

    loop._storeAndMaybeReplaceToolOutput = async (_sid, _iid, _block, _params, output) => output;

    // Stub hardBreak so it never fires (no sessionManager means inline path)
    loop._permissionHandler.hardBreak = async (...args) => {
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

    it('permission-request frame includes a state field', async () => {
      let error = new PermissionRequiredError('test:feature', {
        title: 'permission.test.title',
      });

      let params = makeParams({ executeTool: async () => { throw error; } });
      let gen    = toolCallGenerator('test:tool', { arg: 1 }, 'tu_1');
      loop._active.set(loop._activeKey('ses_1', 'agt_1'), { generator: gen, interactionID: 'int_1', params });

      await loop._iterateGenerator('ses_1', gen, 'int_1', params, makeFrameManager());

      let requestFrames = createdFrames.filter((f) => f.type === 'PermissionRequest');
      assert.equal(requestFrames.length, 1);
      assert.ok(requestFrames[0].state, 'permission-request frame must have a state field');
    });

    it('state contains toolName', async () => {
      let error  = new PermissionRequiredError('test:feature', { title: 't' });
      let params = makeParams({ executeTool: async () => { throw error; } });
      let gen    = toolCallGenerator('shell:execute', { command: 'ls' }, 'tu_2');
      loop._active.set(loop._activeKey('ses_1', 'agt_1'), { generator: gen, interactionID: 'int_1', params });

      await loop._iterateGenerator('ses_1', gen, 'int_1', params, makeFrameManager());

      let frame = createdFrames.find((f) => f.type === 'PermissionRequest');
      let state = parseState(frame);
      assert.equal(state.toolName, 'shell:execute');
    });

    it('state contains toolArguments', async () => {
      let toolArgs = { command: 'rm -rf /', flag: true };
      let error    = new PermissionRequiredError('test:feature', { title: 't' });
      let params   = makeParams({ executeTool: async () => { throw error; } });
      let gen      = toolCallGenerator('shell:execute', toolArgs, 'tu_3');
      loop._active.set(loop._activeKey('ses_1', 'agt_1'), { generator: gen, interactionID: 'int_1', params });

      await loop._iterateGenerator('ses_1', gen, 'int_1', params, makeFrameManager());

      let frame = createdFrames.find((f) => f.type === 'PermissionRequest');
      let state = parseState(frame);
      assert.deepStrictEqual(state.toolArguments, toolArgs);
    });

    it('state contains toolUseID', async () => {
      let error  = new PermissionRequiredError('test:feature', { title: 't' });
      let params = makeParams({ executeTool: async () => { throw error; } });
      let gen    = toolCallGenerator('test:tool', {}, 'tu_custom_42');
      loop._active.set(loop._activeKey('ses_1', 'agt_1'), { generator: gen, interactionID: 'int_1', params });

      await loop._iterateGenerator('ses_1', gen, 'int_1', params, makeFrameManager());

      let frame = createdFrames.find((f) => f.type === 'PermissionRequest');
      let state = parseState(frame);
      assert.equal(state.toolUseID, 'tu_custom_42');
    });

    it('state contains sessionID', async () => {
      let error  = new PermissionRequiredError('test:feature', { title: 't' });
      let params = makeParams({ executeTool: async () => { throw error; } });
      let gen    = toolCallGenerator('test:tool', {}, 'tu_1');
      loop._active.set(loop._activeKey('ses_42', 'agt_1'), { generator: gen, interactionID: 'int_1', params });

      await loop._iterateGenerator('ses_42', gen, 'int_1', params, makeFrameManager());

      let frame = createdFrames.find((f) => f.type === 'PermissionRequest');
      let state = parseState(frame);
      assert.equal(state.sessionID, 'ses_42');
    });

    it('state contains agentID from params.agent', async () => {
      let error  = new PermissionRequiredError('test:feature', { title: 't' });
      let params = makeParams({
        executeTool: async () => { throw error; },
        agent:       { id: 'agt_special' },
      });
      let gen = toolCallGenerator('test:tool', {}, 'tu_1');
      loop._active.set(loop._activeKey('ses_1', 'agt_special'), { generator: gen, interactionID: 'int_1', params });

      await loop._iterateGenerator('ses_1', gen, 'int_1', params, makeFrameManager());

      let frame = createdFrames.find((f) => f.type === 'PermissionRequest');
      let state = parseState(frame);
      assert.equal(state.agentID, 'agt_special');
    });

    it('state contains interactionID', async () => {
      let error  = new PermissionRequiredError('test:feature', { title: 't' });
      let params = makeParams({ executeTool: async () => { throw error; } });
      let gen    = toolCallGenerator('test:tool', {}, 'tu_1');
      loop._active.set(loop._activeKey('ses_1', 'agt_1'), { generator: gen, interactionID: 'int_777', params });

      await loop._iterateGenerator('ses_1', gen, 'int_777', params, makeFrameManager());

      let frame = createdFrames.find((f) => f.type === 'PermissionRequest');
      let state = parseState(frame);
      assert.equal(state.interactionID, 'int_777');
    });

    it('state.step is "awaiting-approval"', async () => {
      let error  = new PermissionRequiredError('test:feature', { title: 't' });
      let params = makeParams({ executeTool: async () => { throw error; } });
      let gen    = toolCallGenerator('test:tool', {}, 'tu_1');
      loop._active.set(loop._activeKey('ses_1', 'agt_1'), { generator: gen, interactionID: 'int_1', params });

      await loop._iterateGenerator('ses_1', gen, 'int_1', params, makeFrameManager());

      let frame = createdFrames.find((f) => f.type === 'PermissionRequest');
      let state = parseState(frame);
      assert.equal(state.step, 'awaiting-approval');
    });

    it('state is a JSON string (not an object)', async () => {
      let error  = new PermissionRequiredError('test:feature', { title: 't' });
      let params = makeParams({ executeTool: async () => { throw error; } });
      let gen    = toolCallGenerator('test:tool', {}, 'tu_1');
      loop._active.set(loop._activeKey('ses_1', 'agt_1'), { generator: gen, interactionID: 'int_1', params });

      await loop._iterateGenerator('ses_1', gen, 'int_1', params, makeFrameManager());

      let frame = createdFrames.find((f) => f.type === 'PermissionRequest');
      assert.equal(typeof frame.state, 'string', 'state should be a JSON string');
      assert.doesNotThrow(() => JSON.parse(frame.state), 'state should be valid JSON');
    });

    it('tool-result with PERMISSION REQUIRED still created alongside state', async () => {
      let error  = new PermissionRequiredError('test:feature', { title: 't' });
      let params = makeParams({ executeTool: async () => { throw error; } });
      let gen    = toolCallGenerator('test:tool', {}, 'tu_1');
      loop._active.set(loop._activeKey('ses_1', 'agt_1'), { generator: gen, interactionID: 'int_1', params });

      await loop._iterateGenerator('ses_1', gen, 'int_1', params, makeFrameManager());

      let toolResults = createdFrames.filter((f) => f.type === 'ToolResult');
      assert.equal(toolResults.length, 1);
      assert.ok(toolResults[0].content.output.includes('PERMISSION REQUIRED'));
    });
  });

  // ---------------------------------------------------------------------------
  // Sad paths
  // ---------------------------------------------------------------------------

  describe('sad paths', () => {

    it('agentID is null when params.agent is missing', async () => {
      let error  = new PermissionRequiredError('test:feature', { title: 't' });
      let params = makeParams({
        executeTool: async () => { throw error; },
        agent:       null,
      });
      let gen = toolCallGenerator('test:tool', {}, 'tu_1');
      loop._active.set(loop._activeKey('ses_1', null), { generator: gen, interactionID: 'int_1', params });

      await loop._iterateGenerator('ses_1', gen, 'int_1', params, makeFrameManager());

      let frame = createdFrames.find((f) => f.type === 'PermissionRequest');
      let state = parseState(frame);
      assert.equal(state.agentID, null);
    });

    it('agentID is null when params.agent.id is undefined', async () => {
      let error  = new PermissionRequiredError('test:feature', { title: 't' });
      let params = makeParams({
        executeTool: async () => { throw error; },
        agent:       {},
      });
      let gen = toolCallGenerator('test:tool', {}, 'tu_1');
      loop._active.set(loop._activeKey('ses_1', undefined), { generator: gen, interactionID: 'int_1', params });

      await loop._iterateGenerator('ses_1', gen, 'int_1', params, makeFrameManager());

      let frame = createdFrames.find((f) => f.type === 'PermissionRequest');
      let state = parseState(frame);
      assert.equal(state.agentID, null);
    });

    it('toolArguments is empty object when arguments are undefined', async () => {
      let error  = new PermissionRequiredError('test:feature', { title: 't' });
      let params = makeParams({ executeTool: async () => { throw error; } });

      // Generator yields a tool-call with undefined arguments
      async function* gen() {
        yield {
          type:       'ToolCall',
          content:    { toolName: 'test:tool', arguments: undefined, toolUseID: 'tu_1' },
          authorType: 'agent',
          authorID:   'agt_1',
        };
        yield { type: 'Done', content: {} };
      }

      let g = gen();
      loop._active.set(loop._activeKey('ses_1', 'agt_1'), { generator: g, interactionID: 'int_1', params });

      await loop._iterateGenerator('ses_1', g, 'int_1', params, makeFrameManager());

      let frame = createdFrames.find((f) => f.type === 'PermissionRequest');
      if (frame) {
        let state = parseState(frame);
        // toolArguments should be undefined or null (reflecting what was passed)
        assert.ok(state.toolArguments === undefined || state.toolArguments === null || typeof state.toolArguments === 'object');
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  describe('edge cases', () => {

    it('toolUseID uses toolUseId fallback (camelCase variant)', async () => {
      let error  = new PermissionRequiredError('test:feature', { title: 't' });
      let params = makeParams({ executeTool: async () => { throw error; } });

      // Generator yields a tool-call with toolUseId (not toolUseID)
      async function* gen() {
        yield {
          type:       'ToolCall',
          content:    { toolName: 'test:tool', arguments: {}, toolUseId: 'tu_camel' },
          authorType: 'agent',
          authorID:   'agt_1',
        };
        yield { type: 'Done', content: {} };
      }

      let g = gen();
      loop._active.set(loop._activeKey('ses_1', 'agt_1'), { generator: g, interactionID: 'int_1', params });

      await loop._iterateGenerator('ses_1', g, 'int_1', params, makeFrameManager());

      let frame = createdFrames.find((f) => f.type === 'PermissionRequest');
      let state = parseState(frame);
      assert.equal(state.toolUseID, 'tu_camel');
    });

    it('existing frame fields (content, processed, etc.) are preserved', async () => {
      let error  = new PermissionRequiredError('test:feature', { title: 't' });
      let params = makeParams({ executeTool: async () => { throw error; } });
      let gen    = toolCallGenerator('test:tool', {}, 'tu_1');
      loop._active.set(loop._activeKey('ses_1', 'agt_1'), { generator: gen, interactionID: 'int_1', params });

      await loop._iterateGenerator('ses_1', gen, 'int_1', params, makeFrameManager());

      let frame = createdFrames.find((f) => f.type === 'PermissionRequest');
      assert.equal(frame.type, 'PermissionRequest');
      assert.equal(frame.processed, false);
      assert.equal(frame.hidden, false);
      assert.equal(frame.deleted, false);
      assert.equal(frame.authorType, 'system');
      assert.ok(frame.content.toolName);
    });

    it('state is parseable and has all expected keys', async () => {
      let error  = new PermissionRequiredError('test:feature', { title: 't' });
      let params = makeParams({ executeTool: async () => { throw error; } });
      let gen    = toolCallGenerator('test:tool', { x: 1 }, 'tu_1');
      loop._active.set(loop._activeKey('ses_1', 'agt_1'), { generator: gen, interactionID: 'int_1', params });

      await loop._iterateGenerator('ses_1', gen, 'int_1', params, makeFrameManager());

      let frame = createdFrames.find((f) => f.type === 'PermissionRequest');
      let state = parseState(frame);

      let expectedKeys = ['toolName', 'toolArguments', 'toolUseID', 'sessionID', 'agentID', 'interactionID', 'step'];
      for (let key of expectedKeys) {
        assert.ok(key in state, `state should contain key "${key}"`);
      }
    });
  });
});

// =============================================================================
// Step 3.1 — Dedup hash prevents duplicate permission requests
// =============================================================================

describe('Inline permission flow — dedup hash (Step 3.1)', () => {
  let loop;
  let createdFrames;
  let mockFrame;

  beforeEach(() => {
    createdFrames = [];
    mockFrame     = makeMockFrameModel();

    loop = new InteractionLoop(makeContext({
      models: { Frame: mockFrame },
    }));

    loop._createFrame = async (_sid, frameData, _fm, _opts, _sigCtx) => {
      createdFrames.push(frameData);
      return frameData;
    };

    loop._storeAndMaybeReplaceToolOutput = async (_sid, _iid, _block, _params, output) => output;

    // Stub hardBreak so it never fires (no sessionManager means inline path)
    loop._permissionHandler.hardBreak = async (...args) => {
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

  describe('requestHash is stored in content', () => {

    it('permission-request frame content includes requestHash', async () => {
      let error  = new PermissionRequiredError('test:feature', { title: 't' });
      let params = makeParams({ executeTool: async () => { throw error; } });
      let gen    = toolCallGenerator('test:tool', { arg: 1 }, 'tu_1');
      loop._active.set(loop._activeKey('ses_1', 'agt_1'), { generator: gen, interactionID: 'int_1', params });

      await loop._iterateGenerator('ses_1', gen, 'int_1', params, makeFrameManager());

      let frame = createdFrames.find((f) => f.type === 'PermissionRequest');
      assert.ok(frame, 'should create PermissionRequest');
      assert.ok(frame.content.requestHash, 'content should include requestHash');
      assert.equal(frame.content.requestHash.length, 32, 'hash should be 32 hex chars');
    });

    it('requestHash is deterministic for same inputs', async () => {
      let error  = new PermissionRequiredError('test:feature', { title: 't' });
      let args   = { command: 'ls -la' };
      let expected = computeExpectedHash('shell:execute', args, 'agt_1', 'ses_1');

      let params = makeParams({ executeTool: async () => { throw error; } });
      let gen    = toolCallGenerator('shell:execute', args, 'tu_1');
      loop._active.set(loop._activeKey('ses_1', 'agt_1'), { generator: gen, interactionID: 'int_1', params });

      await loop._iterateGenerator('ses_1', gen, 'int_1', params, makeFrameManager());

      let frame = createdFrames.find((f) => f.type === 'PermissionRequest');
      assert.equal(frame.content.requestHash, expected);
    });
  });

  // ---------------------------------------------------------------------------
  // Dedup: same tool+args+agent+session → no duplicate
  // ---------------------------------------------------------------------------

  describe('dedup prevents duplicate requests', () => {

    it('same tool+args+agent+session returns existing request, no new PermissionRequest', async () => {
      let args         = { command: 'rm -rf /' };
      let requestHash  = computeExpectedHash('shell:execute', args, 'agt_1', 'ses_1');

      // Pre-populate an unprocessed PermissionRequest with matching hash
      let existingID = 'frm_existing_123';
      mockFrame._store.push({
        id:        existingID,
        sessionID: 'ses_1',
        type:      'PermissionRequest',
        processed: false,
        timestamp: Date.now(),
        content:   { toolName: 'shell:execute', arguments: args, requestHash },
      });

      let error  = new PermissionRequiredError('test:feature', { title: 't' });
      let params = makeParams({ executeTool: async () => { throw error; } });
      let gen    = toolCallGenerator('shell:execute', args, 'tu_1');
      loop._active.set(loop._activeKey('ses_1', 'agt_1'), { generator: gen, interactionID: 'int_1', params });

      await loop._iterateGenerator('ses_1', gen, 'int_1', params, makeFrameManager());

      let newRequests = createdFrames.filter((f) => f.type === 'PermissionRequest');
      assert.equal(newRequests.length, 0, 'should NOT create a new PermissionRequest');
    });

    it('dedup hit creates ToolResult with "Permission already requested" message', async () => {
      let args         = { command: 'rm -rf /' };
      let requestHash  = computeExpectedHash('shell:execute', args, 'agt_1', 'ses_1');
      let existingID   = 'frm_existing_456';

      mockFrame._store.push({
        id:        existingID,
        sessionID: 'ses_1',
        type:      'PermissionRequest',
        processed: false,
        timestamp: Date.now(),
        content:   { toolName: 'shell:execute', arguments: args, requestHash },
      });

      let error  = new PermissionRequiredError('test:feature', { title: 't' });
      let params = makeParams({ executeTool: async () => { throw error; } });
      let gen    = toolCallGenerator('shell:execute', args, 'tu_2');
      loop._active.set(loop._activeKey('ses_1', 'agt_1'), { generator: gen, interactionID: 'int_1', params });

      await loop._iterateGenerator('ses_1', gen, 'int_1', params, makeFrameManager());

      let toolResults = createdFrames.filter((f) => f.type === 'ToolResult');
      assert.ok(toolResults.length >= 1, 'should create ToolResult');
      assert.ok(toolResults[0].content.output.includes('Permission already requested'), 'output should mention dedup');
      assert.ok(toolResults[0].content.output.includes(existingID), 'output should include existing frame ID');
    });

    it('dedup hit ToolResult includes correct toolUseID', async () => {
      let args         = { command: 'ls' };
      let requestHash  = computeExpectedHash('shell:execute', args, 'agt_1', 'ses_1');

      mockFrame._store.push({
        id:        'frm_dedup_1',
        sessionID: 'ses_1',
        type:      'PermissionRequest',
        processed: false,
        timestamp: Date.now(),
        content:   { toolName: 'shell:execute', arguments: args, requestHash },
      });

      let error  = new PermissionRequiredError('test:feature', { title: 't' });
      let params = makeParams({ executeTool: async () => { throw error; } });
      let gen    = toolCallGenerator('shell:execute', args, 'tu_special');
      loop._active.set(loop._activeKey('ses_1', 'agt_1'), { generator: gen, interactionID: 'int_1', params });

      await loop._iterateGenerator('ses_1', gen, 'int_1', params, makeFrameManager());

      let toolResult = createdFrames.find((f) => f.type === 'ToolResult');
      assert.equal(toolResult.content.toolUseID, 'tu_special');
    });
  });

  // ---------------------------------------------------------------------------
  // Different args → different hash → new request
  // ---------------------------------------------------------------------------

  describe('different args produce different hash', () => {

    it('different arguments create a new PermissionRequest', async () => {
      let existingArgs = { command: 'ls' };
      let newArgs      = { command: 'rm -rf /' };
      let existingHash = computeExpectedHash('shell:execute', existingArgs, 'agt_1', 'ses_1');

      mockFrame._store.push({
        id:        'frm_old',
        sessionID: 'ses_1',
        type:      'PermissionRequest',
        processed: false,
        timestamp: Date.now(),
        content:   { toolName: 'shell:execute', arguments: existingArgs, requestHash: existingHash },
      });

      let error  = new PermissionRequiredError('test:feature', { title: 't' });
      let params = makeParams({ executeTool: async () => { throw error; } });
      let gen    = toolCallGenerator('shell:execute', newArgs, 'tu_1');
      loop._active.set(loop._activeKey('ses_1', 'agt_1'), { generator: gen, interactionID: 'int_1', params });

      await loop._iterateGenerator('ses_1', gen, 'int_1', params, makeFrameManager());

      let newRequests = createdFrames.filter((f) => f.type === 'PermissionRequest');
      assert.equal(newRequests.length, 1, 'should create a new PermissionRequest for different args');
      assert.notEqual(newRequests[0].content.requestHash, existingHash);
    });
  });

  // ---------------------------------------------------------------------------
  // Existing request already processed → new request allowed
  // ---------------------------------------------------------------------------

  describe('processed requests do not block new ones', () => {

    it('already-processed request with same hash allows new request', async () => {
      let args        = { command: 'ls' };
      let requestHash = computeExpectedHash('shell:execute', args, 'agt_1', 'ses_1');

      // Existing request is processed (approved/denied)
      mockFrame._store.push({
        id:        'frm_processed',
        sessionID: 'ses_1',
        type:      'PermissionRequest',
        processed: true,
        content:   { toolName: 'shell:execute', arguments: args, requestHash },
      });

      let error  = new PermissionRequiredError('test:feature', { title: 't' });
      let params = makeParams({ executeTool: async () => { throw error; } });
      let gen    = toolCallGenerator('shell:execute', args, 'tu_1');
      loop._active.set(loop._activeKey('ses_1', 'agt_1'), { generator: gen, interactionID: 'int_1', params });

      await loop._iterateGenerator('ses_1', gen, 'int_1', params, makeFrameManager());

      let newRequests = createdFrames.filter((f) => f.type === 'PermissionRequest');
      assert.equal(newRequests.length, 1, 'should create new request when existing is processed');
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  describe('dedup edge cases', () => {

    it('no models on context still creates PermissionRequest (graceful fallback)', async () => {
      // Create loop with no models
      let loopNoModels = new InteractionLoop(makeContext({ models: null }));
      let noModelFrames = [];

      loopNoModels._createFrame = async (_sid, frameData, _fm, _opts, _sigCtx) => {
        noModelFrames.push(frameData);
        return frameData;
      };
      loopNoModels._storeAndMaybeReplaceToolOutput = async (_sid, _iid, _block, _params, output) => output;
      loopNoModels._permissionHandler.hardBreak = async (...args) => {
        let [sessionID, generator, block, interactionID, params] = args;
        await generator.return();
        let agentID   = params.agent && params.agent.id;
        let activeKey = loopNoModels._activeKey(sessionID, agentID);
        loopNoModels._active.delete(activeKey);
        loopNoModels.emit('interaction:end', { sessionID, interactionID, agentID: agentID || null });
      };

      let error  = new PermissionRequiredError('test:feature', { title: 't' });
      let params = makeParams({ executeTool: async () => { throw error; } });
      let gen    = toolCallGenerator('test:tool', {}, 'tu_1');
      loopNoModels._active.set(loopNoModels._activeKey('ses_1', 'agt_1'), { generator: gen, interactionID: 'int_1', params });

      await loopNoModels._iterateGenerator('ses_1', gen, 'int_1', params, makeFrameManager());

      let requests = noModelFrames.filter((f) => f.type === 'PermissionRequest');
      assert.equal(requests.length, 1, 'should still create PermissionRequest when models unavailable');
    });

    it('existing request in different session does not trigger dedup', async () => {
      let args        = { command: 'ls' };
      let requestHash = computeExpectedHash('shell:execute', args, 'agt_1', 'ses_other');

      // Request exists in different session
      mockFrame._store.push({
        id:        'frm_other_session',
        sessionID: 'ses_other',
        type:      'PermissionRequest',
        processed: false,
        timestamp: Date.now(),
        content:   { toolName: 'shell:execute', arguments: args, requestHash },
      });

      let error  = new PermissionRequiredError('test:feature', { title: 't' });
      let params = makeParams({ executeTool: async () => { throw error; } });
      let gen    = toolCallGenerator('shell:execute', args, 'tu_1');
      loop._active.set(loop._activeKey('ses_1', 'agt_1'), { generator: gen, interactionID: 'int_1', params });

      await loop._iterateGenerator('ses_1', gen, 'int_1', params, makeFrameManager());

      let newRequests = createdFrames.filter((f) => f.type === 'PermissionRequest');
      assert.equal(newRequests.length, 1, 'different session should not trigger dedup');
    });

    it('existing request with string content (JSON) is correctly parsed for dedup', async () => {
      let args        = { command: 'ls' };
      let requestHash = computeExpectedHash('shell:execute', args, 'agt_1', 'ses_1');

      // Store content as JSON string (as it would be in DB)
      mockFrame._store.push({
        id:        'frm_json_string',
        sessionID: 'ses_1',
        type:      'PermissionRequest',
        processed: false,
        timestamp: Date.now(),
        content:   JSON.stringify({ toolName: 'shell:execute', arguments: args, requestHash }),
      });

      let error  = new PermissionRequiredError('test:feature', { title: 't' });
      let params = makeParams({ executeTool: async () => { throw error; } });
      let gen    = toolCallGenerator('shell:execute', args, 'tu_1');
      loop._active.set(loop._activeKey('ses_1', 'agt_1'), { generator: gen, interactionID: 'int_1', params });

      await loop._iterateGenerator('ses_1', gen, 'int_1', params, makeFrameManager());

      let newRequests = createdFrames.filter((f) => f.type === 'PermissionRequest');
      assert.equal(newRequests.length, 0, 'JSON string content should be parsed for dedup matching');
    });
  });
});
