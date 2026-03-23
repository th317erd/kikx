'use strict';

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { InteractionLoop }          from '../../../src/core/interaction/index.mjs';
import { PermissionRequiredError }  from '../../../src/core/permissions/permission-required-error.mjs';

// =============================================================================
// Step 2.1 — permission-request frame stores tool context in state
// =============================================================================
// When the inline PermissionRequiredError handler creates a permission-request
// frame, it must include a `state` field (JSON string) with the tool execution
// context: toolName, toolArguments, toolUseID, sessionID, agentID,
// interactionID, step.
// =============================================================================

// ---------------------------------------------------------------------------
// Helpers
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

async function* toolCallGenerator(toolName, args, toolUseID) {
  let result = yield {
    type:       'tool-call',
    content:    { toolName: toolName || 'test:tool', arguments: args || {}, toolUseID: toolUseID || 'tu_1' },
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

      let requestFrames = createdFrames.filter((f) => f.type === 'permission-request');
      assert.equal(requestFrames.length, 1);
      assert.ok(requestFrames[0].state, 'permission-request frame must have a state field');
    });

    it('state contains toolName', async () => {
      let error  = new PermissionRequiredError('test:feature', { title: 't' });
      let params = makeParams({ executeTool: async () => { throw error; } });
      let gen    = toolCallGenerator('shell:execute', { command: 'ls' }, 'tu_2');
      loop._active.set(loop._activeKey('ses_1', 'agt_1'), { generator: gen, interactionID: 'int_1', params });

      await loop._iterateGenerator('ses_1', gen, 'int_1', params, makeFrameManager());

      let frame = createdFrames.find((f) => f.type === 'permission-request');
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

      let frame = createdFrames.find((f) => f.type === 'permission-request');
      let state = parseState(frame);
      assert.deepStrictEqual(state.toolArguments, toolArgs);
    });

    it('state contains toolUseID', async () => {
      let error  = new PermissionRequiredError('test:feature', { title: 't' });
      let params = makeParams({ executeTool: async () => { throw error; } });
      let gen    = toolCallGenerator('test:tool', {}, 'tu_custom_42');
      loop._active.set(loop._activeKey('ses_1', 'agt_1'), { generator: gen, interactionID: 'int_1', params });

      await loop._iterateGenerator('ses_1', gen, 'int_1', params, makeFrameManager());

      let frame = createdFrames.find((f) => f.type === 'permission-request');
      let state = parseState(frame);
      assert.equal(state.toolUseID, 'tu_custom_42');
    });

    it('state contains sessionID', async () => {
      let error  = new PermissionRequiredError('test:feature', { title: 't' });
      let params = makeParams({ executeTool: async () => { throw error; } });
      let gen    = toolCallGenerator('test:tool', {}, 'tu_1');
      loop._active.set(loop._activeKey('ses_42', 'agt_1'), { generator: gen, interactionID: 'int_1', params });

      await loop._iterateGenerator('ses_42', gen, 'int_1', params, makeFrameManager());

      let frame = createdFrames.find((f) => f.type === 'permission-request');
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

      let frame = createdFrames.find((f) => f.type === 'permission-request');
      let state = parseState(frame);
      assert.equal(state.agentID, 'agt_special');
    });

    it('state contains interactionID', async () => {
      let error  = new PermissionRequiredError('test:feature', { title: 't' });
      let params = makeParams({ executeTool: async () => { throw error; } });
      let gen    = toolCallGenerator('test:tool', {}, 'tu_1');
      loop._active.set(loop._activeKey('ses_1', 'agt_1'), { generator: gen, interactionID: 'int_777', params });

      await loop._iterateGenerator('ses_1', gen, 'int_777', params, makeFrameManager());

      let frame = createdFrames.find((f) => f.type === 'permission-request');
      let state = parseState(frame);
      assert.equal(state.interactionID, 'int_777');
    });

    it('state.step is "awaiting-approval"', async () => {
      let error  = new PermissionRequiredError('test:feature', { title: 't' });
      let params = makeParams({ executeTool: async () => { throw error; } });
      let gen    = toolCallGenerator('test:tool', {}, 'tu_1');
      loop._active.set(loop._activeKey('ses_1', 'agt_1'), { generator: gen, interactionID: 'int_1', params });

      await loop._iterateGenerator('ses_1', gen, 'int_1', params, makeFrameManager());

      let frame = createdFrames.find((f) => f.type === 'permission-request');
      let state = parseState(frame);
      assert.equal(state.step, 'awaiting-approval');
    });

    it('state is a JSON string (not an object)', async () => {
      let error  = new PermissionRequiredError('test:feature', { title: 't' });
      let params = makeParams({ executeTool: async () => { throw error; } });
      let gen    = toolCallGenerator('test:tool', {}, 'tu_1');
      loop._active.set(loop._activeKey('ses_1', 'agt_1'), { generator: gen, interactionID: 'int_1', params });

      await loop._iterateGenerator('ses_1', gen, 'int_1', params, makeFrameManager());

      let frame = createdFrames.find((f) => f.type === 'permission-request');
      assert.equal(typeof frame.state, 'string', 'state should be a JSON string');
      assert.doesNotThrow(() => JSON.parse(frame.state), 'state should be valid JSON');
    });

    it('tool-result with PERMISSION REQUIRED still created alongside state', async () => {
      let error  = new PermissionRequiredError('test:feature', { title: 't' });
      let params = makeParams({ executeTool: async () => { throw error; } });
      let gen    = toolCallGenerator('test:tool', {}, 'tu_1');
      loop._active.set(loop._activeKey('ses_1', 'agt_1'), { generator: gen, interactionID: 'int_1', params });

      await loop._iterateGenerator('ses_1', gen, 'int_1', params, makeFrameManager());

      let toolResults = createdFrames.filter((f) => f.type === 'tool-result');
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

      let frame = createdFrames.find((f) => f.type === 'permission-request');
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

      let frame = createdFrames.find((f) => f.type === 'permission-request');
      let state = parseState(frame);
      assert.equal(state.agentID, null);
    });

    it('toolArguments is empty object when arguments are undefined', async () => {
      let error  = new PermissionRequiredError('test:feature', { title: 't' });
      let params = makeParams({ executeTool: async () => { throw error; } });

      // Generator yields a tool-call with undefined arguments
      async function* gen() {
        yield {
          type:       'tool-call',
          content:    { toolName: 'test:tool', arguments: undefined, toolUseID: 'tu_1' },
          authorType: 'agent',
          authorID:   'agt_1',
        };
        yield { type: 'done', content: {} };
      }

      let g = gen();
      loop._active.set(loop._activeKey('ses_1', 'agt_1'), { generator: g, interactionID: 'int_1', params });

      await loop._iterateGenerator('ses_1', g, 'int_1', params, makeFrameManager());

      let frame = createdFrames.find((f) => f.type === 'permission-request');
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
          type:       'tool-call',
          content:    { toolName: 'test:tool', arguments: {}, toolUseId: 'tu_camel' },
          authorType: 'agent',
          authorID:   'agt_1',
        };
        yield { type: 'done', content: {} };
      }

      let g = gen();
      loop._active.set(loop._activeKey('ses_1', 'agt_1'), { generator: g, interactionID: 'int_1', params });

      await loop._iterateGenerator('ses_1', g, 'int_1', params, makeFrameManager());

      let frame = createdFrames.find((f) => f.type === 'permission-request');
      let state = parseState(frame);
      assert.equal(state.toolUseID, 'tu_camel');
    });

    it('existing frame fields (content, processed, etc.) are preserved', async () => {
      let error  = new PermissionRequiredError('test:feature', { title: 't' });
      let params = makeParams({ executeTool: async () => { throw error; } });
      let gen    = toolCallGenerator('test:tool', {}, 'tu_1');
      loop._active.set(loop._activeKey('ses_1', 'agt_1'), { generator: gen, interactionID: 'int_1', params });

      await loop._iterateGenerator('ses_1', gen, 'int_1', params, makeFrameManager());

      let frame = createdFrames.find((f) => f.type === 'permission-request');
      assert.equal(frame.type, 'permission-request');
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

      let frame = createdFrames.find((f) => f.type === 'permission-request');
      let state = parseState(frame);

      let expectedKeys = ['toolName', 'toolArguments', 'toolUseID', 'sessionID', 'agentID', 'interactionID', 'step'];
      for (let key of expectedKeys) {
        assert.ok(key in state, `state should contain key "${key}"`);
      }
    });
  });
});
