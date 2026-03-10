'use strict';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createKikxCore }      from '../../../src/core/index.mjs';
import { InteractionLoop }     from '../../../src/core/interaction/index.mjs';
import { SessionManager }      from '../../../src/core/session/index.mjs';
import { FramePersistence }    from '../../../src/core/frames/index.mjs';
import { ContentSanitizer }    from '../../../src/core/lib/content-sanitizer.mjs';
import { SessionScheduler }    from '../../../src/core/scheduling/session-scheduler.mjs';
import { setup }               from '../../../src/core/internal-plugins/scheduling/index.mjs';

// =============================================================================
// Phase C2 — Scheduling Plugin Tests
// =============================================================================

describe('SchedulingPlugin (C2)', () => {
  let core;
  let models;
  let context;
  let sessionManager;
  let framePersistence;
  let interactionLoop;

  before(async () => {
    core    = createKikxCore();
    await core.start();
    models  = core.getModels();
    context = core.getContext();

    sessionManager   = new SessionManager(context);
    framePersistence = new FramePersistence(context);
    interactionLoop  = new InteractionLoop(context);

    context.setProperty('sessionManager', sessionManager);
    context.setProperty('framePersistence', framePersistence);
    context.setProperty('contentSanitizer', new ContentSanitizer());
    context.setProperty('interactionLoop', interactionLoop);
  });

  after(async () => {
    if (core && core.isStarted())
      await core.stop();
  });

  async function createTestOrg() {
    return models.Organization.create({ name: 'Plugin Org' });
  }

  async function createTestAgent(org, name = 'test-sched-plugin') {
    return models.Agent.create({
      organizationID: org.id,
      name,
      pluginID:       'mock-agent',
    });
  }

  // ---------------------------------------------------------------------------
  // setup()
  // ---------------------------------------------------------------------------

  describe('setup()', () => {
    it('should register a selector for type:user-message', () => {
      let scheduler = new SessionScheduler({ sessionManager, interactionLoop });
      context.setProperty('sessionScheduler', scheduler);

      let selectors = [];
      let registerSelector = (selector, PluginClass) => {
        selectors.push({ selector, PluginClass });
      };

      setup({ registerSelector, context });

      assert.equal(selectors.length, 1);
      assert.equal(selectors[0].selector, 'type:user-message');
      assert.ok(selectors[0].PluginClass);
    });

    it('should skip registration when no sessionScheduler on context', () => {
      // Create a fresh context mock without sessionScheduler
      let mockContext = {
        getProperty: (key) => {
          if (key === 'sessionScheduler') return undefined;
          return null;
        },
      };

      let selectors = [];
      let registerSelector = (selector, PluginClass) => {
        selectors.push({ selector, PluginClass });
      };

      setup({ registerSelector, context: mockContext });

      assert.equal(selectors.length, 0);
    });
  });

  // ---------------------------------------------------------------------------
  // SchedulingPlugin.process()
  // ---------------------------------------------------------------------------

  describe('process()', () => {
    it('should call scheduler.onCommit for user-authored commits', async () => {
      let org     = await createTestOrg();
      let agent   = await createTestAgent(org, 'test-sched-plg-a');
      let session = await sessionManager.createSession(org.id, { name: 'Plugin Process Test' });

      await sessionManager.addParticipant(session.id, agent.id);

      let scheduler = new SessionScheduler({ sessionManager, interactionLoop });
      context.setProperty('sessionScheduler', scheduler);

      let PluginClass;
      let registerSelector = (_selector, PC) => { PluginClass = PC; };
      setup({ registerSelector, context });

      let frameManager = sessionManager.getFrameManager(session.id);

      frameManager.merge([{
        id:         'frm_plg_1',
        type:       'user-message',
        content:    { text: 'Hello' },
        authorType: 'user',
        authorID:   'usr_1',
      }], { authorType: 'user', authorID: 'usr_1' });

      let commit = frameManager.getLatestCommit();

      // Create plugin instance with context
      let plugin = new PluginClass({
        commit,
        session: { id: session.id },
      });

      let nextCalled = false;
      let next = async () => { nextCalled = true; };
      let done = async () => {};

      await plugin.process(next, done);

      assert.equal(nextCalled, true);
      assert.equal(scheduler.isAgentActive(session.id, agent.id), true);
      assert.equal(scheduler.hasPendingTriggers(session.id), true);
    });

    it('should NOT call scheduler.onCommit for agent-authored commits', async () => {
      let org     = await createTestOrg();
      let agent   = await createTestAgent(org, 'test-sched-plg-b');
      let session = await sessionManager.createSession(org.id, { name: 'Plugin Agent Test' });

      await sessionManager.addParticipant(session.id, agent.id);

      let scheduler = new SessionScheduler({ sessionManager, interactionLoop });
      context.setProperty('sessionScheduler', scheduler);

      let PluginClass;
      let registerSelector = (_selector, PC) => { PluginClass = PC; };
      setup({ registerSelector, context });

      let frameManager = sessionManager.getFrameManager(session.id);

      frameManager.merge([{
        id:         'frm_plg_agent_1',
        type:       'message',
        content:    { html: '<p>Reply</p>' },
        authorType: 'agent',
        authorID:   agent.id,
      }], { authorType: 'agent', authorID: agent.id });

      let commit = frameManager.getLatestCommit();

      let plugin = new PluginClass({
        commit,
        session: { id: session.id },
      });

      let nextCalled = false;
      let next = async () => { nextCalled = true; };
      let done = async () => {};

      await plugin.process(next, done);

      // next() should still be called (pass-through)
      assert.equal(nextCalled, true);
      // But NO agents should be scheduled
      assert.equal(scheduler.isAgentActive(session.id, agent.id), false);
      assert.equal(scheduler.hasPendingTriggers(session.id), false);
    });

    it('should pass through when no sessionID', async () => {
      let scheduler = new SessionScheduler({ sessionManager, interactionLoop });
      context.setProperty('sessionScheduler', scheduler);

      let PluginClass;
      let registerSelector = (_selector, PC) => { PluginClass = PC; };
      setup({ registerSelector, context });

      let plugin = new PluginClass({
        commit:  { authorType: 'user' },
        session: null,
      });

      let nextCalled = false;
      let next = async () => { nextCalled = true; };
      let done = async () => {};

      await plugin.process(next, done);

      assert.equal(nextCalled, true);
    });

    it('should pass through when no commit', async () => {
      let scheduler = new SessionScheduler({ sessionManager, interactionLoop });
      context.setProperty('sessionScheduler', scheduler);

      let PluginClass;
      let registerSelector = (_selector, PC) => { PluginClass = PC; };
      setup({ registerSelector, context });

      let plugin = new PluginClass({
        commit:  null,
        session: { id: 'ses_test' },
      });

      let nextCalled = false;
      let next = async () => { nextCalled = true; };
      let done = async () => {};

      await plugin.process(next, done);

      assert.equal(nextCalled, true);
    });

    it('should still call next() even when onCommit throws', async () => {
      let scheduler = new SessionScheduler({ sessionManager, interactionLoop });
      context.setProperty('sessionScheduler', scheduler);

      // Sabotage onCommit to throw
      let originalOnCommit = scheduler.onCommit.bind(scheduler);
      scheduler.onCommit = async () => { throw new Error('boom'); };

      let PluginClass;
      let registerSelector = (_selector, PC) => { PluginClass = PC; };
      setup({ registerSelector, context });

      let plugin = new PluginClass({
        commit:  { authorType: 'user', changes: [] },
        session: { id: 'ses_err_test' },
      });

      let nextCalled = false;
      let next = async () => { nextCalled = true; };
      let done = async () => {};

      await plugin.process(next, done);

      assert.equal(nextCalled, true);

      // Restore
      scheduler.onCommit = originalOnCommit;
    });
  });
});
