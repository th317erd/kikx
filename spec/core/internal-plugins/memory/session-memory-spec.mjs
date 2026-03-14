'use strict';

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createKikxCore }   from '../../../../src/core/index.mjs';
import { PluginInterface }  from '../../../../src/core/plugin-loader/plugin-interface.mjs';
import { PluginRegistry }   from '../../../../src/core/plugin-loader/registry.mjs';
import { SessionManager }   from '../../../../src/core/session/index.mjs';
import { setup }            from '../../../../src/core/internal-plugins/memory/index.mjs';

// =============================================================================
// Memory Plugin — Session Tools Tests
// =============================================================================
// Tests for memory:getSessionContext, memory:setSessionContext,
// memory:updateSessionContext
// =============================================================================

describe('Memory Plugin — Session Tools', () => {
  let core;
  let models;
  let context;
  let sessionManager;
  let registry;
  let organization;

  let GetSessionContextTool;
  let SetSessionContextTool;
  let UpdateSessionContextTool;

  before(async () => {
    core    = createKikxCore();
    await core.start();
    models  = core.getModels();
    context = core.getContext();

    sessionManager = new SessionManager(context);
    context.setProperty('sessionManager', sessionManager);

    registry = new PluginRegistry();
    setup({
      registerTool: (name, cls) => registry.registerTool(name, cls),
      PluginInterface,
      context,
    });

    GetSessionContextTool    = registry.getTool('memory:getSessionContext');
    SetSessionContextTool    = registry.getTool('memory:setSessionContext');
    UpdateSessionContextTool = registry.getTool('memory:updateSessionContext');
  });

  after(async () => {
    if (core && core.isStarted())
      await core.stop();
  });

  beforeEach(async () => {
    organization = await models.Organization.create({ name: 'Session Memory Test Org' });
  });

  async function createSession(opts = {}) {
    return sessionManager.createSession(organization.id, opts);
  }

  function instantiateTool(ToolClass) {
    return new ToolClass({
      getProperty: (key) => context.getProperty(key),
    });
  }

  // ---------------------------------------------------------------------------
  // Registration
  // ---------------------------------------------------------------------------

  describe('setup()', () => {
    it('registers all 3 session memory tools', () => {
      assert.ok(GetSessionContextTool, 'memory:getSessionContext should be registered');
      assert.ok(SetSessionContextTool, 'memory:setSessionContext should be registered');
      assert.ok(UpdateSessionContextTool, 'memory:updateSessionContext should be registered');
    });

    it('all tools extend PluginInterface', () => {
      assert.ok(GetSessionContextTool.prototype instanceof PluginInterface);
      assert.ok(SetSessionContextTool.prototype instanceof PluginInterface);
      assert.ok(UpdateSessionContextTool.prototype instanceof PluginInterface);
    });

    it('getSessionContext has riskLevel low', () => {
      assert.equal(GetSessionContextTool.riskLevel, 'low');
    });

    it('setSessionContext has riskLevel high', () => {
      assert.equal(SetSessionContextTool.riskLevel, 'high');
    });

    it('updateSessionContext has riskLevel high', () => {
      assert.equal(UpdateSessionContextTool.riskLevel, 'high');
    });
  });

  // ---------------------------------------------------------------------------
  // memory:getSessionContext
  // ---------------------------------------------------------------------------

  describe('memory:getSessionContext', () => {
    it('returns session context', async () => {
      let session = await createSession();
      await session.setContext({ mood: 'productive', topic: 'testing' });

      let tool   = instantiateTool(GetSessionContextTool);
      let result = await tool.execute({ sessionID: session.id });

      assert.equal(result.context.mood, 'productive');
      assert.equal(result.context.topic, 'testing');
    });

    it('returns empty object when no context stored', async () => {
      let session = await createSession();

      let tool   = instantiateTool(GetSessionContextTool);
      let result = await tool.execute({ sessionID: session.id });

      assert.deepStrictEqual(result.context, {});
    });

    it('with effective: true returns inherited context', async () => {
      let parent = await createSession();
      await parent.setContext({ parentKey: 'parentValue', shared: 'from-parent' });

      let child = await createSession({ parentSessionID: parent.id });
      await child.setContext({ shared: 'from-child' });

      let tool   = instantiateTool(GetSessionContextTool);
      let result = await tool.execute({ sessionID: child.id, effective: true });

      assert.equal(result.context.parentKey, 'parentValue');
      assert.equal(result.context.shared, 'from-child');
    });

    it('rejects when session not found', async () => {
      let tool = instantiateTool(GetSessionContextTool);

      await assert.rejects(
        () => tool.execute({ sessionID: 'ses_nonexistent' }),
        (err) => {
          assert.ok(err.message.toLowerCase().includes('not found') || err.message.toLowerCase().includes('session'));
          return true;
        },
      );
    });

    it('rejects when no sessionID provided', async () => {
      let tool = instantiateTool(GetSessionContextTool);

      await assert.rejects(
        () => tool.execute({}),
        (err) => {
          assert.ok(err.message.toLowerCase().includes('required') || err.message.toLowerCase().includes('session'));
          return true;
        },
      );
    });
  });

  // ---------------------------------------------------------------------------
  // memory:setSessionContext
  // ---------------------------------------------------------------------------

  describe('memory:setSessionContext', () => {
    it('persists context and round-trips via getSessionContext', async () => {
      let session = await createSession();

      let setTool = instantiateTool(SetSessionContextTool);
      await setTool.execute({
        sessionID: session.id,
        context:   { goal: 'ship it', priority: 'high' },
      });

      let getTool = instantiateTool(GetSessionContextTool);
      let result  = await getTool.execute({ sessionID: session.id });

      assert.equal(result.context.goal, 'ship it');
      assert.equal(result.context.priority, 'high');
    });

    it('rejects when session not found', async () => {
      let tool = instantiateTool(SetSessionContextTool);

      await assert.rejects(
        () => tool.execute({ sessionID: 'ses_nonexistent', context: { foo: 'bar' } }),
        (err) => {
          assert.ok(err.message.toLowerCase().includes('not found') || err.message.toLowerCase().includes('session'));
          return true;
        },
      );
    });
  });

  // ---------------------------------------------------------------------------
  // memory:updateSessionContext
  // ---------------------------------------------------------------------------

  describe('memory:updateSessionContext', () => {
    it('merges partial context into existing', async () => {
      let session = await createSession();
      await session.setContext({ mood: 'calm', topic: 'design' });

      let tool = instantiateTool(UpdateSessionContextTool);
      await tool.execute({
        sessionID: session.id,
        updates:   { priority: 'urgent' },
      });

      let getTool = instantiateTool(GetSessionContextTool);
      let result  = await getTool.execute({ sessionID: session.id });

      assert.equal(result.context.mood, 'calm');
      assert.equal(result.context.topic, 'design');
      assert.equal(result.context.priority, 'urgent');
    });

    it('rejects when session not found', async () => {
      let tool = instantiateTool(UpdateSessionContextTool);

      await assert.rejects(
        () => tool.execute({ sessionID: 'ses_nonexistent', updates: { foo: 'bar' } }),
        (err) => {
          assert.ok(err.message.toLowerCase().includes('not found') || err.message.toLowerCase().includes('session'));
          return true;
        },
      );
    });
  });

  // ---------------------------------------------------------------------------
  // UTF8 and arbitrary keys
  // ---------------------------------------------------------------------------

  describe('UTF8 and arbitrary data', () => {
    it('UTF8 content round-trips through session tools', async () => {
      let session = await createSession();

      let setTool = instantiateTool(SetSessionContextTool);
      await setTool.execute({
        sessionID: session.id,
        context:   { emoji: '🚀🎉', japanese: 'こんにちは' },
      });

      let getTool = instantiateTool(GetSessionContextTool);
      let result  = await getTool.execute({ sessionID: session.id });

      assert.equal(result.context.emoji, '🚀🎉');
      assert.equal(result.context.japanese, 'こんにちは');
    });

    it('arbitrary nested keys round-trip', async () => {
      let session = await createSession();

      let setTool = instantiateTool(SetSessionContextTool);
      await setTool.execute({
        sessionID: session.id,
        context:   {
          deliberation: { rounds: 5, votes: ['yes', 'no', 'abstain'] },
          metadata:     { version: 1 },
        },
      });

      let getTool = instantiateTool(GetSessionContextTool);
      let result  = await getTool.execute({ sessionID: session.id });

      assert.equal(result.context.deliberation.rounds, 5);
      assert.deepStrictEqual(result.context.deliberation.votes, ['yes', 'no', 'abstain']);
      assert.equal(result.context.metadata.version, 1);
    });
  });
});
