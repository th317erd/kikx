'use strict';

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createKikxCore }          from '../../src/core/index.mjs';
import { InteractionLoop }         from '../../src/core/interaction/index.mjs';
import { SessionManager }          from '../../src/core/session/index.mjs';
import { FramePersistence }        from '../../src/core/frames/index.mjs';
import { ContentSanitizer }        from '../../src/core/lib/content-sanitizer.mjs';
import { AgentInterface }          from '../../src/core/plugins/agent-interface.mjs';
import { PermissionDeniedError }   from '../../src/core/permissions/permission-denied-error.mjs';

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

    yield { type: 'done', content: {} };
  }
}

// =============================================================================
// Command Permission Tests
// =============================================================================

describe('Command Permissions (system:command)', () => {
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
  /** Wrap context so permissionEngine returns null (bypass tool-level permissions). */
  function noPermContext() {
    return {
      getProperty: (key) => {
        if (key === 'permissionEngine') return null;
        return context.getProperty(key);
      },
      setProperty: (key, val) => context.setProperty(key, val),
    };
  }

  async function createTestSession() {
    let org     = await models.Organization.create({ name: 'Perm Test Org' });
    let session = await sessionManager.createSession(org.id, { name: 'Perm Test Session' });

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
      authorID:    'user_perm_test',
      ...overrides,
    };
  }

  // ===========================================================================
  // 1. Tool registration — system:command registered after core.start()
  // ===========================================================================

  describe('tool registration', () => {
    it('should register system:command tool after core.start()', () => {
      let registry  = core.getPluginRegistry();
      let ToolClass = registry.getTool('system:command');

      assert.ok(ToolClass, 'system:command tool should be registered');
      assert.equal(ToolClass.pluginID, 'system');
      assert.equal(ToolClass.featureName, 'command');
      assert.equal(ToolClass.riskLevel, 'high');
    });

    it('should register primer instructions for system:command', () => {
      let registry     = core.getPluginRegistry();
      let instructions = registry.getInstructions();
      let found = instructions.some((i) => i.content.includes('system:command'));

      assert.ok(found, 'Should have primer instructions mentioning system:command');
    });
  });

  // ===========================================================================
  // 2. Agent command execution — agent yields tool-call for system:command
  // ===========================================================================

  describe('agent command execution via system:command tool', () => {
    it('should execute a command when agent yields system:command tool-call', async () => {
      let session = await createTestSession();
      let loop    = createLoop();

      let blocks = [
        {
          type:    'tool-call',
          content: {
            toolName:  'system:command',
            arguments: { command: 'reload' },
          },
        },
      ];

      let agent       = new MockAgent(context, blocks);
      let toolResults = [];

      let interactionID = await loop.startInteraction(session.id, defaultParams(agent, {
        agentPlugin: agent,
        userMessage: 'please reload',
        checkPermission: async () => false, // always allowed
        executeTool: async (toolName, toolArgs) => {
          let registry  = context.getProperty('pluginRegistry');
          let ToolClass = registry.getTool(toolName);

          if (!ToolClass)
            throw new Error(`Unknown tool: ${toolName}`);

          let toolInstance = new ToolClass(context);
          let result = await toolInstance.execute({
            ...toolArgs,
            _sessionID: session.id,
            _authorID:  'user_perm_test',
            _agent:     { name: 'test-mock' },
          });

          toolResults.push(result);

          return result;
        },
      }));

      assert.ok(interactionID);
      assert.equal(toolResults.length, 1);
      assert.ok(toolResults[0].html.includes('Instructions reloaded'));
      assert.equal(toolResults[0].injectPrimer, true);
      assert.equal(toolResults[0].commandName, 'reload');
    });
  });

  // ===========================================================================
  // 3. Permission feature name translation
  // ===========================================================================

  describe('permission feature name translation', () => {
    it('should translate system:command to command:{name} in checkPermission', async () => {
      let session = await createTestSession();
      let loop    = createLoop();
      let checkedFeatureNames = [];

      let blocks = [
        {
          type:    'tool-call',
          content: {
            toolName:  'system:command',
            arguments: { command: 'invite', args: '@test-bot' },
          },
        },
      ];

      let agent = new MockAgent(context, blocks);

      // Mock checkPermission that records what it's called with
      // Simulates the controller's translation logic
      let checkPermission = async (featureName, toolArgs) => {
        // Replicate controller logic for translation
        if (featureName === 'system:command' && toolArgs && toolArgs.command)
          featureName = `command:${toolArgs.command.toLowerCase().trim()}`;

        checkedFeatureNames.push(featureName);

        return false; // allowed
      };

      await loop.startInteraction(session.id, defaultParams(agent, {
        agentPlugin: agent,
        userMessage: 'invite someone',
        checkPermission,
        executeTool: async (toolName, toolArgs) => {
          let registry  = context.getProperty('pluginRegistry');
          let ToolClass = registry.getTool(toolName);
          let tool      = new ToolClass(context);

          return tool.execute({ ...toolArgs, _sessionID: session.id });
        },
      }));

      // The checkPermission should have been called with the translated name
      assert.ok(checkedFeatureNames.includes('command:invite'), `Expected 'command:invite' in ${JSON.stringify(checkedFeatureNames)}`);
    });
  });

  // ===========================================================================
  // 4. User command permission check — checkPermission IS called
  // ===========================================================================

  describe('user command permission check', () => {
    it('should call checkPermission with command:{name} and authorType:user for user commands', async () => {
      let session = await createTestSession();
      let loop    = createLoop();
      let permCalls = [];

      let checkPermission = async (featureName, toolArgs) => {
        permCalls.push({ featureName, toolArgs });

        return false; // allowed
      };

      await loop.startInteraction(session.id, defaultParams(
        new MockAgent(context, []),
        {
          userMessage:     '/reload',
          checkPermission,
        },
      ));

      assert.equal(permCalls.length, 1);
      assert.equal(permCalls[0].featureName, 'command:reload');
      assert.equal(permCalls[0].toolArgs.authorType, 'user');
      assert.equal(permCalls[0].toolArgs.command, 'reload');
    });
  });

  // ===========================================================================
  // 5. User always allowed (for now) — checkPermission returns false
  // ===========================================================================

  describe('user always allowed for commands', () => {
    it('should execute the command handler when checkPermission returns false', async () => {
      let session = await createTestSession();
      let loop    = createLoop();
      let emitted = [];

      loop.on('frame', (ev) => emitted.push(ev.frame));

      await loop.startInteraction(session.id, defaultParams(
        new MockAgent(context, []),
        {
          userMessage:     '/reload',
          checkPermission: async () => false,
        },
      ));

      let resultFrames = emitted.filter((f) => f.type === 'command-result');
      assert.equal(resultFrames.length, 1);
      assert.ok(resultFrames[0].content.html.includes('Instructions reloaded'));
    });
  });

  // ===========================================================================
  // 6. Agent permission hard-break
  // ===========================================================================

  describe('agent permission hard-break for commands', () => {
    it('should create permission-request frame when checkPermission returns true for user /command', async () => {
      let session = await createTestSession();
      let loop    = createLoop();
      let emitted = [];
      let permEvents = [];

      loop.on('frame', (ev) => emitted.push(ev.frame));
      loop.on('permission:request', (ev) => permEvents.push(ev));

      await loop.startInteraction(session.id, defaultParams(
        new MockAgent(context, []),
        {
          userMessage:     '/invite @test-bot',
          authorType:      'agent',
          checkPermission: async () => true, // needs permission
        },
      ));

      let permFrames = emitted.filter((f) => f.type === 'permission-request');
      assert.equal(permFrames.length, 1);
      assert.equal(permFrames[0].content.commandName, 'invite');
      assert.equal(permFrames[0].content.featureName, 'command:invite');

      // Should have emitted permission:request event
      assert.equal(permEvents.length, 1);
      assert.equal(permEvents[0].commandName, 'invite');

      // No command-result frame should exist (handler not executed)
      let resultFrames = emitted.filter((f) => f.type === 'command-result');
      assert.equal(resultFrames.length, 0);
    });
  });

  // ===========================================================================
  // 7. Agent permission deny
  // ===========================================================================

  describe('agent permission deny for commands', () => {
    it('should show denial in command-result when checkPermission throws PermissionDeniedError', async () => {
      let session = await createTestSession();
      let loop    = createLoop();
      let emitted = [];

      loop.on('frame', (ev) => emitted.push(ev.frame));

      await loop.startInteraction(session.id, defaultParams(
        new MockAgent(context, []),
        {
          userMessage:     '/invite @test-bot',
          checkPermission: async () => {
            throw new PermissionDeniedError('command:invite', 'explicit deny');
          },
        },
      ));

      let resultFrames = emitted.filter((f) => f.type === 'command-result');
      assert.equal(resultFrames.length, 1);
      assert.ok(resultFrames[0].content.html.includes('Permission denied'));
      assert.ok(resultFrames[0].content.html.includes('/invite'));
    });
  });

  // ===========================================================================
  // 8. Agent permission allow — handler executes
  // ===========================================================================

  describe('agent permission allow for commands', () => {
    it('should execute handler when checkPermission returns false for agent command', async () => {
      let session = await createTestSession();
      let loop    = createLoop();
      let emitted = [];

      loop.on('frame', (ev) => emitted.push(ev.frame));

      await loop.startInteraction(session.id, defaultParams(
        new MockAgent(context, []),
        {
          userMessage:     '/reload',
          authorType:      'agent',
          checkPermission: async () => false, // allowed
        },
      ));

      let resultFrames = emitted.filter((f) => f.type === 'command-result');
      assert.equal(resultFrames.length, 1);
      assert.ok(resultFrames[0].content.html.includes('Instructions reloaded'));
    });
  });

  // ===========================================================================
  // 9. injectPrimer via tool path
  // ===========================================================================

  describe('injectPrimer via system:command tool', () => {
    it('should add session to _primerNeeded when reload via executeTool returns injectPrimer', async () => {
      let session = await createTestSession();
      let loop    = createLoop();

      let blocks = [
        {
          type:    'tool-call',
          content: {
            toolName:  'system:command',
            arguments: { command: 'reload' },
          },
        },
      ];

      let agent = new MockAgent(context, blocks);

      // Simulate controller executeTool that calls requestPrimerRefresh
      let executeTool = async (toolName, toolArgs) => {
        let registry  = context.getProperty('pluginRegistry');
        let ToolClass = registry.getTool(toolName);

        if (!ToolClass)
          throw new Error(`Unknown tool: ${toolName}`);

        let toolInstance = new ToolClass(context);
        let result = await toolInstance.execute({
          ...toolArgs,
          _sessionID: session.id,
          _authorID:  'user_perm_test',
          _agent:     { name: 'test-mock' },
        });

        // Simulate what the controller does
        if (result && result.injectPrimer)
          loop.requestPrimerRefresh(session.id);

        return result;
      };

      await loop.startInteraction(session.id, defaultParams(agent, {
        agentPlugin:     agent,
        userMessage:     'reload please',
        checkPermission: async () => false,
        executeTool,
      }));

      assert.ok(loop._primerNeeded.has(session.id), 'Session should be in _primerNeeded');
    });
  });

  // ===========================================================================
  // 10. Unknown command via tool
  // ===========================================================================

  describe('unknown command via system:command tool', () => {
    it('should return error HTML for unknown command, no crash', async () => {
      let session = await createTestSession();
      let loop    = createLoop();
      let toolResults = [];

      let blocks = [
        {
          type:    'tool-call',
          content: {
            toolName:  'system:command',
            arguments: { command: 'nonexistent-cmd-xyz' },
          },
        },
      ];

      let agent = new MockAgent(context, blocks);

      await loop.startInteraction(session.id, defaultParams(agent, {
        agentPlugin: agent,
        userMessage: 'run unknown command',
        checkPermission: async () => false,
        executeTool: async (toolName, toolArgs) => {
          let registry  = context.getProperty('pluginRegistry');
          let ToolClass = registry.getTool(toolName);

          if (!ToolClass)
            throw new Error(`Unknown tool: ${toolName}`);

          let toolInstance = new ToolClass(noPermContext());
          let result = await toolInstance._execute({
            ...toolArgs,
            _sessionID: session.id,
          });

          toolResults.push(result);

          return result;
        },
      }));

      assert.equal(toolResults.length, 1);
      assert.ok(toolResults[0].html.includes('Unknown command'));
      assert.ok(toolResults[0].html.includes('nonexistent-cmd-xyz'));
    });

    it('should return error HTML when command is empty', async () => {
      let registry  = context.getProperty('pluginRegistry');
      let ToolClass = registry.getTool('system:command');
      let tool      = new ToolClass(noPermContext());

      let result = await tool.execute({ command: '', _sessionID: 'ses_test' });
      assert.ok(result.html.includes('required'));
    });

    it('should return error HTML when command is missing', async () => {
      let registry  = context.getProperty('pluginRegistry');
      let ToolClass = registry.getTool('system:command');
      let tool      = new ToolClass(noPermContext());

      let result = await tool.execute({ _sessionID: 'ses_test' });
      assert.ok(result.html.includes('required'));
    });
  });

  // ===========================================================================
  // 11. authorType passed correctly
  // ===========================================================================

  describe('authorType passed correctly', () => {
    it('should pass authorType=user for user commands', async () => {
      let session  = await createTestSession();
      let loop     = createLoop();
      let registry = context.getProperty('pluginRegistry');
      let receivedAuthorType;

      // Register a spy command
      registry.registerCommand('spy-auth-cmd', async ({ authorType }) => {
        receivedAuthorType = authorType;

        return { content: { html: '<p>OK</p>' } };
      });

      await loop.startInteraction(session.id, defaultParams(
        new MockAgent(context, []),
        {
          userMessage:     '/spy-auth-cmd',
          authorType:      'user',
          checkPermission: async () => false,
        },
      ));

      assert.equal(receivedAuthorType, 'user');
    });

    it('should pass authorType=agent when command invoked via system:command tool', async () => {
      let session  = await createTestSession();
      let registry = context.getProperty('pluginRegistry');
      let receivedAuthorType;

      // Register a spy command
      registry.registerCommand('spy-auth-cmd-2', async ({ authorType }) => {
        receivedAuthorType = authorType;

        return { content: { html: '<p>OK</p>' } };
      });

      // Execute directly via the tool
      let ToolClass    = registry.getTool('system:command');
      let toolInstance = new ToolClass(noPermContext());

      await toolInstance._execute({
        command:    'spy-auth-cmd-2',
        args:       '',
        _sessionID: session.id,
        _authorID:  'user_test',
        _agent:     { name: 'test-mock' },
      });

      assert.equal(receivedAuthorType, 'agent');
    });
  });

  // ===========================================================================
  // 12. SystemCommandPermissions — read-only commands auto-approved
  // ===========================================================================

  describe('SystemCommandPermissions', () => {
    it('should have a getPermissionsClass() method on SystemCommandTool', () => {
      let registry  = core.getPluginRegistry();
      let ToolClass = registry.getTool('system:command');
      let instance  = new ToolClass(context);

      assert.equal(typeof instance.getPermissionsClass, 'function');
      assert.ok(instance.getPermissionsClass());
    });

    it('should auto-approve command:help', async () => {
      let registry         = core.getPluginRegistry();
      let ToolClass        = registry.getTool('system:command');
      let instance         = new ToolClass(context);
      let PermissionsClass = instance.getPermissionsClass();
      let permissions      = new PermissionsClass(context);

      let result = await permissions.checkPermission('command:help', { command: 'help' }, {});
      assert.equal(result, false, 'help should be auto-approved');
    });

    it('should throw PermissionRequiredError for non-read-only commands', async () => {
      let registry         = core.getPluginRegistry();
      let ToolClass        = registry.getTool('system:command');
      let instance         = new ToolClass(context);
      let PermissionsClass = instance.getPermissionsClass();
      let permissions      = new PermissionsClass(context);

      await assert.rejects(
        () => permissions.checkPermission('command:invite', { command: 'invite' }, {}),
        (err) => err.name === 'PermissionRequiredError',
      );
    });

    it('should auto-approve command:reload (low-risk capability)', async () => {
      let registry         = core.getPluginRegistry();
      let ToolClass        = registry.getTool('system:command');
      let instance         = new ToolClass(context);
      let PermissionsClass = instance.getPermissionsClass();
      let permissions      = new PermissionsClass(context);

      let result = await permissions.checkPermission('command:reload', { command: 'reload' }, {});
      assert.equal(result, false, 'reload is a low-risk capability — auto-approved');
    });

    it('should auto-approve help regardless of casing', async () => {
      let registry         = core.getPluginRegistry();
      let ToolClass        = registry.getTool('system:command');
      let instance         = new ToolClass(context);
      let PermissionsClass = instance.getPermissionsClass();
      let permissions      = new PermissionsClass(context);

      let result = await permissions.checkPermission('command:help', { command: 'HELP' }, {});
      assert.equal(result, false, 'HELP should be auto-approved');
    });

    it('should auto-approve when featureName encodes the command name', async () => {
      let registry         = core.getPluginRegistry();
      let ToolClass        = registry.getTool('system:command');
      let instance         = new ToolClass(context);
      let PermissionsClass = instance.getPermissionsClass();
      let permissions      = new PermissionsClass(context);

      // featureName is the primary source
      let result = await permissions.checkPermission('command:help', {}, {});
      assert.equal(result, false, 'should extract command name from featureName');
    });

    it('should throw PermissionRequiredError when featureName is not command-prefixed and args.command is non-safe', async () => {
      let registry         = core.getPluginRegistry();
      let ToolClass        = registry.getTool('system:command');
      let instance         = new ToolClass(context);
      let PermissionsClass = instance.getPermissionsClass();
      let permissions      = new PermissionsClass(context);

      await assert.rejects(
        () => permissions.checkPermission('system:command', { command: 'invite' }, {}),
        (err) => err.name === 'PermissionRequiredError',
      );
    });
  });

  // ===========================================================================
  // 13. requestPrimerRefresh public accessor
  // ===========================================================================

  describe('requestPrimerRefresh', () => {
    it('should add session to _primerNeeded', () => {
      let loop = createLoop();
      loop.requestPrimerRefresh('ses_test123');
      assert.ok(loop._primerNeeded.has('ses_test123'));
    });

    it('should be idempotent', () => {
      let loop = createLoop();
      loop.requestPrimerRefresh('ses_test123');
      loop.requestPrimerRefresh('ses_test123');
      assert.equal(loop._primerNeeded.size, 1);
    });
  });

  // ===========================================================================
  // 13. Permission check not called for unknown commands
  // ===========================================================================

  describe('permission check for unknown commands', () => {
    it('should NOT call checkPermission for unregistered commands', async () => {
      let session = await createTestSession();
      let loop    = createLoop();
      let permCalled = false;

      await loop.startInteraction(session.id, defaultParams(
        new MockAgent(context, []),
        {
          userMessage:     '/totally-unknown-cmd-xyz',
          checkPermission: async () => {
            permCalled = true;

            return false;
          },
        },
      ));

      assert.equal(permCalled, false, 'checkPermission should not be called for unknown commands');

      // Should still produce the unknown command result
      let fm     = await framePersistence.loadFrames(session.id);
      let frames = fm.toArray();
      let resultFrames = frames.filter((f) => f.type === 'command-result');

      assert.equal(resultFrames.length, 1);
      assert.ok(resultFrames[0].content.html.includes('Unknown command'));
    });
  });

  // ===========================================================================
  // 14. Non-PermissionDeniedError rethrown
  // ===========================================================================

  describe('non-permission errors rethrown', () => {
    it('should rethrow non-PermissionDeniedError from checkPermission', async () => {
      let session = await createTestSession();
      let loop    = createLoop();

      await assert.rejects(
        () => loop.startInteraction(session.id, defaultParams(
          new MockAgent(context, []),
          {
            userMessage:     '/reload',
            checkPermission: async () => {
              throw new TypeError('something broke');
            },
          },
        )),
        (error) => {
          assert.equal(error.name, 'TypeError');
          assert.equal(error.message, 'something broke');

          return true;
        },
      );
    });
  });

  // ===========================================================================
  // 15. Command frames hidden from agent context
  // ===========================================================================

  describe('command frames hidden from agent context', () => {
    it('should mark command user-message frame as hidden', async () => {
      let session = await createTestSession();
      let loop    = createLoop();
      let emitted = [];

      loop.on('frame', (ev) => emitted.push(ev.frame));

      await loop.startInteraction(session.id, defaultParams(
        new MockAgent(context, []),
        {
          userMessage:     '/reload',
          checkPermission: async () => false,
        },
      ));

      let userFrames = emitted.filter((f) => f.type === 'user-message');
      assert.equal(userFrames.length, 1);
      assert.equal(userFrames[0].hidden, true, 'Command user-message must be hidden');
    });

    it('should exclude hidden command frames from _buildMessages', () => {
      let loop   = createLoop();
      let frames = [
        { type: 'user-message', content: { text: '/reload' }, hidden: true },
        { type: 'command-result', content: { html: '<p>Reloaded</p>' } },
        { type: 'user-message', content: { text: 'Hello' }, hidden: false },
        { type: 'message', content: { html: '<p>Hi there</p>' } },
      ];

      let messages = loop._buildMessages(frames);
      // Agent should only see "Hello" and "Hi there" — not "/reload" or command-result
      assert.equal(messages.length, 2);
      assert.equal(messages[0].role, 'user');
      assert.equal(messages[0].content, 'Hello');
      assert.equal(messages[1].role, 'assistant');
      assert.equal(messages[1].content, '<p>Hi there</p>');
    });

    it('should not count hidden command frames in _isFirstMessage', async () => {
      let session = await createTestSession();
      let loop    = createLoop();

      // Run /reload first — this creates a hidden user-message
      await loop.startInteraction(session.id, defaultParams(
        new MockAgent(context, []),
        {
          userMessage:     '/reload',
          checkPermission: async () => false,
        },
      ));

      // Now load frames and check: _isFirstMessage should still return true
      // because the /reload frame is hidden
      let fm     = await framePersistence.loadFrames(session.id);
      let frames = fm.toArray();

      assert.ok(loop._isFirstMessage(frames), 'Hidden command frame should not count for _isFirstMessage');
    });

    it('should integrate end-to-end: /reload followed by normal message excludes command from agent history', async () => {
      let session = await createTestSession();
      let loop    = createLoop();
      let capturedMessages;

      // Step 1: /reload
      await loop.startInteraction(session.id, defaultParams(
        new MockAgent(context, []),
        {
          userMessage:     '/reload',
          checkPermission: async () => false,
        },
      ));

      // Step 2: Normal message — spy on the messages the agent receives
      class SpyAgent extends AgentInterface {
        static pluginID    = 'spy-hidden';
        static featureName = 'spy';
        static agentType   = 'spy';

        async *_createGenerator(params) {
          capturedMessages = params.messages;
          yield { type: 'message', content: { html: '<p>Response</p>' }, authorType: 'agent' };
          yield { type: 'done', content: {} };
        }
      }

      let spyAgent = new SpyAgent(context);

      await loop.startInteraction(session.id, defaultParams(spyAgent, {
        agentPlugin: spyAgent,
        userMessage: 'Hello after reload',
        checkPermission: async () => false,
      }));

      // Verify: agent should see "Hello after reload" but NOT "/reload"
      assert.ok(capturedMessages, 'Agent should have received messages');

      let userMessages = capturedMessages.filter((m) => m.role === 'user');
      let hasReload    = userMessages.some((m) => m.content.includes('/reload'));
      let hasHello     = userMessages.some((m) => m.content.includes('Hello after reload'));

      assert.equal(hasReload, false, 'Agent must NOT see /reload in message history');
      assert.ok(hasHello, 'Agent should see the normal message');
    });
  });
});
