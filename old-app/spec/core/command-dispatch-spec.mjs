'use strict';

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createKikxCore }     from '../../src/core/index.mjs';
import { InteractionLoop }    from '../../src/core/interaction/index.mjs';
import { SessionManager }     from '../../src/core/session/index.mjs';
import { FramePersistence }   from '../../src/core/frames/index.mjs';
import { ContentSanitizer }   from '../../src/core/lib/content-sanitizer.mjs';
import { AgentInterface }     from '../../src/core/plugins/agent-interface.mjs';

// =============================================================================
// Mock Agent — yields configurable blocks
// =============================================================================

class MockAgent extends AgentInterface {
  static pluginID    = 'mock-agent';
  static featureName = 'mock';
  static displayName = 'Mock Agent';
  static description = 'Mock agent for testing';
  static agentType   = 'mock';

  constructor(context, blocks) {
    super(context);
    this._blocks = blocks || [];
  }

  async *_createGenerator(_params) {
    for (let block of this._blocks)
      yield block;

    yield { type: 'Done', content: {} };
  }
}

// =============================================================================
// Command Dispatch Tests
// =============================================================================

describe('Command Dispatch', () => {
  let core;
  let models;
  let context;
  let sessionManager;
  let framePersistence;
  let sanitizer;

  before(async () => {
    core    = createKikxCore();
    await core.start();
    models  = core.getModels();
    context = core.getContext();

    sessionManager   = new SessionManager(context);
    framePersistence = new FramePersistence(context);
    sanitizer        = new ContentSanitizer();

    context.setProperty('sessionManager', sessionManager);
    context.setProperty('framePersistence', framePersistence);
    context.setProperty('contentSanitizer', sanitizer);
  });

  after(async () => {
    if (core && core.isStarted())
      await core.stop();
  });

  // Helpers
  async function createTestSession() {
    let org     = await models.Organization.create({ name: 'Cmd Test Org' });
    let session = await sessionManager.createSession(org.id, { name: 'Cmd Test Session' });

    return session;
  }

  function createLoop() {
    return new InteractionLoop(context);
  }

  function defaultParams(agentPlugin, overrides = {}) {
    return {
      agentPlugin,
      agent:       { name: 'test-mock', pluginID: 'mock-agent' },
      userMessage: 'Hello, agent!',
      authorType:  'user',
      authorID:    'user_cmd_test',
      ...overrides,
    };
  }

  // ===========================================================================
  // 1. _parseCommand
  // ===========================================================================

  describe('_parseCommand', () => {
    it('should parse /reload', () => {
      let loop   = createLoop();
      let result = loop._parseCommand('/reload');

      assert.deepEqual(result, { commandName: 'reload', arguments: '' });
    });

    it('should parse /invite with arguments', () => {
      let loop   = createLoop();
      let result = loop._parseCommand('/invite @test-claude as Claude');

      assert.equal(result.commandName, 'invite');
      assert.equal(result.arguments, '@test-claude as Claude');
    });

    it('should parse command with leading whitespace', () => {
      let loop   = createLoop();
      let result = loop._parseCommand('  /reload');

      assert.deepEqual(result, { commandName: 'reload', arguments: '' });
    });

    it('should parse command with hyphens and underscores', () => {
      let loop   = createLoop();
      let result = loop._parseCommand('/foo-bar_baz');

      assert.equal(result.commandName, 'foo-bar_baz');
    });

    it('should normalize command name to lowercase', () => {
      let loop   = createLoop();
      let result = loop._parseCommand('/RELOAD');

      assert.equal(result.commandName, 'reload');
    });

    it('should return null for non-commands', () => {
      let loop = createLoop();
      assert.equal(loop._parseCommand('hello world'), null);
      assert.equal(loop._parseCommand('what is /reload?'), null);
      assert.equal(loop._parseCommand(''), null);
      assert.equal(loop._parseCommand(null), null);
      assert.equal(loop._parseCommand(undefined), null);
    });

    it('should return null for messages starting with text before slash', () => {
      let loop = createLoop();
      assert.equal(loop._parseCommand('run /reload now'), null);
    });
  });

  // ===========================================================================
  // 2. _resolveCommand
  // ===========================================================================

  describe('_resolveCommand', () => {
    it('should find a registered command', () => {
      let loop    = createLoop();
      let handler = loop._resolveCommand('reload');

      // The reload plugin was loaded by core.start()
      assert.equal(typeof handler, 'function');
    });

    it('should return null for unregistered command', () => {
      let loop    = createLoop();
      let handler = loop._resolveCommand('nonexistent-command-xyz');

      assert.equal(handler, null);
    });
  });

  // ===========================================================================
  // 3. _executeCommand — basic flow
  // ===========================================================================

  describe('_executeCommand — basic flow', () => {
    it('should create user-message and command-result frames', async () => {
      let session = await createTestSession();
      let loop    = createLoop();
      let emitted = [];

      loop.on('frame', (ev) => emitted.push(ev.frame));

      let interactionID = await loop.startInteraction(session.id, defaultParams(
        new MockAgent(context, []),
        { userMessage: '/reload' },
      ));

      assert.ok(interactionID);
      assert.ok(interactionID.startsWith('int_'));

      let userFrames   = emitted.filter((f) => f.type === 'UserMessage');
      let resultFrames = emitted.filter((f) => f.type === 'CommandResult');

      assert.equal(userFrames.length, 1);
      assert.equal(userFrames[0].content.text, '/reload');
      assert.equal(userFrames[0].hidden, true, 'Command user-message should be hidden from agent');

      assert.equal(resultFrames.length, 1);
      assert.ok(resultFrames[0].content.html.includes('Instructions reloaded'));
      assert.equal(resultFrames[0].authorType, 'system');
    });

    it('should emit interaction:start and interaction:end', async () => {
      let session     = await createTestSession();
      let loop        = createLoop();
      let startEvents = [];
      let endEvents   = [];

      loop.on('interaction:start', (ev) => startEvents.push(ev));
      loop.on('interaction:end', (ev) => endEvents.push(ev));

      await loop.startInteraction(session.id, defaultParams(
        new MockAgent(context, []),
        { userMessage: '/reload' },
      ));

      assert.equal(startEvents.length, 1);
      assert.equal(endEvents.length, 1);
      assert.equal(startEvents[0].sessionID, session.id);
      assert.equal(startEvents[0].interactionID, endEvents[0].interactionID);
    });

    it('should emit frame events for both frames', async () => {
      let session = await createTestSession();
      let loop    = createLoop();
      let events  = [];

      loop.on('frame', (ev) => events.push(ev));

      await loop.startInteraction(session.id, defaultParams(
        new MockAgent(context, []),
        { userMessage: '/reload' },
      ));

      assert.equal(events.length, 2);
      assert.equal(events[0].frame.type, 'UserMessage');
      assert.equal(events[1].frame.type, 'CommandResult');
    });

    it('should NOT invoke the agent for commands', async () => {
      let session   = await createTestSession();
      let loop      = createLoop();
      let agentRan  = false;

      class SpyAgent extends AgentInterface {
        static pluginID    = 'spy';
        static featureName = 'spy';
        static agentType   = 'spy';

        async *_createGenerator() {
          agentRan = true;
          yield { type: 'Done', content: {} };
        }
      }

      let agent = new SpyAgent(context);

      await loop.startInteraction(session.id, defaultParams(agent, {
        agentPlugin: agent,
        userMessage: '/reload',
      }));

      assert.equal(agentRan, false);
    });
  });

  // ===========================================================================
  // 4. Unknown command
  // ===========================================================================

  describe('unknown command', () => {
    it('should create error result for unregistered command', async () => {
      let session = await createTestSession();
      let loop    = createLoop();

      await loop.startInteraction(session.id, defaultParams(
        new MockAgent(context, []),
        { userMessage: '/nonexistent' },
      ));

      let fm     = await framePersistence.loadFrames(session.id);
      let frames = fm.toArray();

      let resultFrames = frames.filter((f) => f.type === 'CommandResult');
      assert.equal(resultFrames.length, 1);
      assert.ok(resultFrames[0].content.html.includes('Unknown command'));
      assert.ok(resultFrames[0].content.html.includes('nonexistent'));
    });
  });

  // ===========================================================================
  // 5. /reload — injectPrimer flag
  // ===========================================================================

  describe('/reload command', () => {
    it('should add session to _primerNeeded', async () => {
      let session = await createTestSession();
      let loop    = createLoop();

      await loop.startInteraction(session.id, defaultParams(
        new MockAgent(context, []),
        { userMessage: '/reload' },
      ));

      // _primerNeeded should have the session
      assert.ok(loop._primerNeeded.has(session.id));
    });

    it('should clear _primerNeeded on next startInteraction', async () => {
      let session = await createTestSession();
      let loop    = createLoop();

      // Send /reload
      await loop.startInteraction(session.id, defaultParams(
        new MockAgent(context, []),
        { userMessage: '/reload' },
      ));

      assert.ok(loop._primerNeeded.has(session.id));

      // Send a normal message — should clear _primerNeeded
      let agent = new MockAgent(context, [
        { type: 'Message', content: { html: '<p>Hi</p>' }, authorType: 'agent', authorID: 'a1' },
      ]);

      await loop.startInteraction(session.id, defaultParams(agent, {
        agentPlugin: agent,
        userMessage: 'Hello',
      }));

      assert.equal(loop._primerNeeded.has(session.id), false);
    });
  });

  // ===========================================================================
  // 6. /invite command
  // ===========================================================================

  describe('/invite command', () => {
    it('should invite an agent by name', async () => {
      let session = await createTestSession();
      let loop    = createLoop();

      // Create an agent to invite
      let agent = await models.Agent.create({
        name:           'test-invitee',
        organizationID: session.organizationID,
        pluginID:       'mock-agent',
      });

      await loop.startInteraction(session.id, defaultParams(
        new MockAgent(context, []),
        { userMessage: `/invite @${agent.name}` },
      ));

      let fm     = await framePersistence.loadFrames(session.id);
      let frames = fm.toArray();

      let resultFrames = frames.filter((f) => f.type === 'CommandResult');
      assert.equal(resultFrames.length, 1);
      assert.ok(resultFrames[0].content.html.includes('Invited'));
      assert.ok(resultFrames[0].content.html.includes('test-invitee'));

      // Verify participant was actually added
      let participants = await sessionManager.getParticipants(session.id);
      let found = participants.some((p) => p.agentID === agent.id);
      assert.ok(found, 'Agent should be a participant');
    });

    it('should return error for unknown agent', async () => {
      let session = await createTestSession();
      let loop    = createLoop();

      await loop.startInteraction(session.id, defaultParams(
        new MockAgent(context, []),
        { userMessage: '/invite @no-such-agent-xyz' },
      ));

      let fm     = await framePersistence.loadFrames(session.id);
      let frames = fm.toArray();
      let resultFrames = frames.filter((f) => f.type === 'CommandResult');

      assert.equal(resultFrames.length, 1);
      assert.ok(resultFrames[0].content.html.includes('not found'));
    });

    it('should return usage when no arguments given', async () => {
      let session = await createTestSession();
      let loop    = createLoop();

      await loop.startInteraction(session.id, defaultParams(
        new MockAgent(context, []),
        { userMessage: '/invite' },
      ));

      let fm     = await framePersistence.loadFrames(session.id);
      let frames = fm.toArray();
      let resultFrames = frames.filter((f) => f.type === 'CommandResult');

      assert.equal(resultFrames.length, 1);
      assert.ok(resultFrames[0].content.html.includes('Usage'));
    });

    it('should work without @ prefix on agent name', async () => {
      let session = await createTestSession();
      let loop    = createLoop();

      let agent = await models.Agent.create({
        name:           'test-no-at-agent',
        organizationID: session.organizationID,
        pluginID:       'mock-agent',
      });

      await loop.startInteraction(session.id, defaultParams(
        new MockAgent(context, []),
        { userMessage: `/invite ${agent.name}` },
      ));

      let fm     = await framePersistence.loadFrames(session.id);
      let frames = fm.toArray();
      let resultFrames = frames.filter((f) => f.type === 'CommandResult');

      assert.ok(resultFrames[0].content.html.includes('Invited'));
    });
  });

  // ===========================================================================
  // 7. _buildMessages excludes command-result
  // ===========================================================================

  describe('_buildMessages — command frames in context', () => {
    it('should include command-result frames as system messages in agent context', () => {
      let loop   = createLoop();
      let frames = [
        { type: 'UserMessage', content: { text: '/reload' }, hidden: true },
        { type: 'CommandResult', content: { html: '<p>Done</p>' } },
        { type: 'UserMessage', content: { text: 'hello' } },
        { type: 'Message', content: { html: '<p>hi</p>' } },
      ];

      let messages = loop._buildMessages(frames);
      // hidden user-message (/reload) is excluded, but CommandResult is now included
      assert.equal(messages.length, 3);
      assert.equal(messages[0].role, 'user');
      assert.ok(messages[0].content.includes('[System:'));
      assert.equal(messages[1].role, 'user');
      assert.equal(messages[1].content, 'hello');
      assert.equal(messages[2].role, 'assistant');
    });

    it('should exclude hidden frames from message history', () => {
      let loop   = createLoop();
      let frames = [
        { type: 'UserMessage', content: { text: '/invite @bot' }, hidden: true },
        { type: 'CommandResult', content: { html: '<p>Invited</p>' } },
        { type: 'UserMessage', content: { text: 'hello' }, hidden: false },
        { type: 'Message', content: { html: '<p>hi</p>' } },
      ];

      let messages = loop._buildMessages(frames);
      // CommandResult is now included as system message
      assert.equal(messages.length, 3);
      assert.equal(messages[0].content, '[System: <p>Invited</p>]');
      assert.equal(messages[1].content, 'hello');
      assert.equal(messages[2].content, '<p>hi</p>');
    });
  });

  // ===========================================================================
  // 8. Command does not go to queue
  // ===========================================================================

  describe('command while interaction active', () => {
    it('should queue command message like any other when interaction is active', async () => {
      let session = await createTestSession();
      let loop    = createLoop();

      // Simulate an active interaction
      loop._active.set(session.id, { generator: null, interactionID: 'int_fake', params: {} });

      let result = await loop.startInteraction(session.id, defaultParams(
        new MockAgent(context, []),
        { userMessage: '/reload' },
      ));

      // Should have queued (returns null) because an interaction is active
      assert.equal(result, null);
      assert.equal(loop.getQueuedMessages(session.id).length, 1);
      assert.equal(loop.getQueuedMessages(session.id)[0], '/reload');

      // Clean up
      loop._active.delete(session.id);
      loop._queues.delete(session.id);
    });
  });

  // ===========================================================================
  // 9. Command handler that throws
  // ===========================================================================

  describe('command handler error', () => {
    it('should create error result when handler throws', async () => {
      let session  = await createTestSession();
      let loop     = createLoop();
      let registry = context.getProperty('pluginRegistry');

      // Register a command that throws
      registry.registerCommand('fail-cmd', async () => {
        throw new Error('handler exploded');
      });

      await loop.startInteraction(session.id, defaultParams(
        new MockAgent(context, []),
        { userMessage: '/fail-cmd' },
      ));

      let fm     = await framePersistence.loadFrames(session.id);
      let frames = fm.toArray();
      let resultFrames = frames.filter((f) => f.type === 'CommandResult');

      assert.equal(resultFrames.length, 1);
      assert.ok(resultFrames[0].content.html.includes('Command error'));
      assert.ok(resultFrames[0].content.html.includes('handler exploded'));
    });
  });

  // ===========================================================================
  // 10. Frame ordering
  // ===========================================================================

  describe('command frame ordering', () => {
    it('should assign monotonically increasing order to command frames', async () => {
      let session = await createTestSession();
      let loop    = createLoop();

      await loop.startInteraction(session.id, defaultParams(
        new MockAgent(context, []),
        { userMessage: '/reload' },
      ));

      let fm     = await framePersistence.loadFrames(session.id);
      let frames = fm.toArray();

      assert.ok(frames.length >= 2);
      assert.ok(frames[1].order > frames[0].order);
    });
  });
});
