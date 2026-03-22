'use strict';

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createKikxCore }          from '../../src/core/index.mjs';
import { InteractionLoop }         from '../../src/core/interaction/index.mjs';
import { SessionManager }          from '../../src/core/session/index.mjs';
import { FramePersistence }        from '../../src/core/frames/index.mjs';
import { ContentSanitizer }        from '../../src/core/lib/content-sanitizer.mjs';
import { AgentInterface }          from '../../src/core/plugins/agent-interface.mjs';
import { PermissionEngine }        from '../../src/core/permissions/permission-engine.mjs';
import { PermissionDeniedError }    from '../../src/core/permissions/permission-denied-error.mjs';
import { PermissionRequiredError } from '../../src/core/permissions/permission-required-error.mjs';
import { parseShellCommands }      from '../../src/core/internal-plugins/shell/command-parser.mjs';

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
// Shell Permission Flow Tests
// =============================================================================

describe('Shell Permission Flow (per-command)', () => {
  let core;
  let models;
  let context;
  let sessionManager;
  let framePersistence;
  let sanitizer;
  let permissionEngine;

  before(async () => {
    core    = createKikxCore();
    await core.start();
    models  = core.getModels();
    context = core.getContext();

    sessionManager   = new SessionManager(context);
    framePersistence = new FramePersistence(context);
    sanitizer        = new ContentSanitizer();
    permissionEngine = new PermissionEngine(context);

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
    let org     = await models.Organization.create({ name: 'Shell Perm Org' });
    let session = await sessionManager.createSession(org.id, { name: 'Shell Perm Session' });

    return { session, organizationID: org.id };
  }

  function createLoop() {
    return new InteractionLoop(context);
  }

  function shellToolCall(command) {
    return {
      type:    'tool-call',
      content: {
        toolName:  'shell:execute',
        arguments: { command },
        toolUseID: `tu_${Date.now()}`,
      },
    };
  }

  function defaultParams(agentPlugin, overrides = {}) {
    return {
      agentPlugin,
      agent:       { name: 'test-mock', pluginID: 'mock-agent' },
      userMessage: 'run something',
      authorType:  'user',
      authorID:    'user_shell_test',
      ...overrides,
    };
  }

  // ===========================================================================
  // 1. parseShellCommands works correctly
  // ===========================================================================

  describe('parseShellCommands', () => {
    it('should parse a single command', () => {
      let result = parseShellCommands('ls -la');
      assert.equal(result.length, 1);
      assert.equal(result[0].command, 'ls');
      assert.deepEqual(result[0].arguments, ['-la']);
    });

    it('should parse piped commands', () => {
      let result = parseShellCommands('ls | grep foo');
      assert.equal(result.length, 2);
      assert.equal(result[0].command, 'ls');
      assert.equal(result[1].command, 'grep');
      assert.deepEqual(result[1].arguments, ['foo']);
    });

    it('should parse chained commands (&&)', () => {
      let result = parseShellCommands('cd /tmp && ls -la && cat file.txt');
      assert.equal(result.length, 3);
      assert.equal(result[0].command, 'cd');
      assert.equal(result[1].command, 'ls');
      assert.equal(result[2].command, 'cat');
    });

    it('should return empty array for empty input', () => {
      assert.deepEqual(parseShellCommands(''), []);
      assert.deepEqual(parseShellCommands(null), []);
      assert.deepEqual(parseShellCommands(undefined), []);
    });
  });

  // ===========================================================================
  // 2. Permission-request frame includes parsedCommands
  // ===========================================================================

  describe('permission-request frame enrichment', () => {
    it('should include parsedCommands in permission-request frame for shell:execute', async () => {
      let { session } = await createTestSession();
      let loop        = createLoop();
      let emitted     = [];

      loop.on('frame', (ev) => emitted.push(ev.frame));

      let agent = new MockAgent(context, [shellToolCall('ls | grep tmp')]);

      await loop.startInteraction(session.id, defaultParams(agent, {
        agentPlugin: agent,
        executeTool: async () => {
          throw new PermissionRequiredError('shell:execute', {
            title:       'permission.shell.executeTitle',
            description: 'permission.shell.executeDescription',
            details: [
              { label: 'permission.detail.pendingCommand', value: 'ls' },
              { label: 'permission.detail.pendingCommand', value: 'grep tmp' },
            ],
          });
        },
      }));

      let permFrames = emitted.filter((f) => f.type === 'permission-request');
      assert.equal(permFrames.length, 1);

      let content = permFrames[0].content;
      // parsedCommands come from fallback parse in permission-handler
      assert.ok(content.parsedCommands, 'Should have parsedCommands in frame content');
      assert.equal(content.parsedCommands.length, 2);
      assert.equal(content.parsedCommands[0].command, 'ls');
      assert.equal(content.parsedCommands[1].command, 'grep');
    });

    it('should fall back to parsing from command string via PermissionRequiredError path', async () => {
      let { session } = await createTestSession();
      let loop        = createLoop();
      let emitted     = [];

      loop.on('frame', (ev) => emitted.push(ev.frame));

      let agent = new MockAgent(context, [shellToolCall('ls -la')]);

      await loop.startInteraction(session.id, defaultParams(agent, {
        agentPlugin: agent,
        executeTool: async () => {
          throw new PermissionRequiredError('shell:execute', {
            title: 'permission.shell.executeTitle',
          });
        },
      }));

      let permFrames = emitted.filter((f) => f.type === 'permission-request');
      assert.equal(permFrames.length, 1);
      assert.ok(permFrames[0].content.parsedCommands);
      assert.equal(permFrames[0].content.parsedCommands[0].command, 'ls');
    });
  });

  // ===========================================================================
  // 3. Per-command checkPermission logic (simulating controller)
  // ===========================================================================

  describe('per-command checkPermission evaluation', () => {
    it('should return false (all allowed) when all per-command checks pass', async () => {
      let { session, organizationID } = await createTestSession();

      // Create allow rules for both commands
      await permissionEngine.createRule({
        organizationID,
        featureName: 'shell:ls',
        effect:      'allow',
        scope:       'session',
        scopeID:     session.id,
        createdBy:   'user_test',
      });

      await permissionEngine.createRule({
        organizationID,
        featureName: 'shell:grep',
        effect:      'allow',
        scope:       'session',
        scopeID:     session.id,
        createdBy:   'user_test',
      });

      // Simulate the controller's checkPermission logic
      let command = 'ls | grep foo';
      let parsed  = parseShellCommands(command);
      let options = { organizationID, scope: 'session', scopeID: session.id };
      let anyNeedsApproval = false;

      for (let cmd of parsed) {
        let needs = await permissionEngine.checkPermission(`shell:${cmd.command}`, cmd, options);
        if (needs)
          anyNeedsApproval = true;
      }

      assert.equal(anyNeedsApproval, false, 'All commands should be auto-allowed');
    });

    it('should return true (needs approval) when any per-command check returns true', async () => {
      let { session, organizationID } = await createTestSession();

      // Only create allow rule for ls, NOT for grep
      await permissionEngine.createRule({
        organizationID,
        featureName: 'shell:ls',
        effect:      'allow',
        scope:       'session',
        scopeID:     session.id,
        createdBy:   'user_test',
      });

      let command = 'ls | grep foo';
      let parsed  = parseShellCommands(command);
      let options = { organizationID, scope: 'session', scopeID: session.id };
      let anyNeedsApproval = false;
      let statuses = [];

      for (let cmd of parsed) {
        let needs = await permissionEngine.checkPermission(`shell:${cmd.command}`, cmd, options);
        statuses.push({ command: cmd.command, status: needs ? 'needs-approval' : 'allowed' });
        if (needs)
          anyNeedsApproval = true;
      }

      assert.equal(anyNeedsApproval, true, 'Pipeline needs approval because grep has no allow rule');
      assert.equal(statuses[0].status, 'allowed');
      assert.equal(statuses[1].status, 'needs-approval');
    });

    it('should throw PermissionDeniedError when any command has a deny rule', async () => {
      let { session, organizationID } = await createTestSession();

      // Create deny rule for rm
      await permissionEngine.createRule({
        organizationID,
        featureName: 'shell:rm',
        effect:      'deny',
        scope:       'session',
        scopeID:     session.id,
        createdBy:   'user_test',
      });

      let command = 'ls && rm -rf /tmp/test';
      let parsed  = parseShellCommands(command);
      let options = { organizationID, scope: 'session', scopeID: session.id };

      await assert.rejects(async () => {
        for (let cmd of parsed)
          await permissionEngine.checkPermission(`shell:${cmd.command}`, cmd, options);
      }, (error) => {
        assert.equal(error.name, 'PermissionDeniedError');
        return true;
      });
    });
  });

  // ===========================================================================
  // 4. Rule creation for forever decisions
  // ===========================================================================

  describe('rule creation for forever decisions', () => {
    it('should create allow rule for allow-forever decision', async () => {
      let { session, organizationID } = await createTestSession();

      await permissionEngine.createRule({
        organizationID,
        featureName: 'shell:cat',
        effect:      'allow',
        scope:       'session',
        scopeID:     session.id,
        createdBy:   'user_test',
      });

      // Verify the rule works
      let options = { organizationID, scope: 'session', scopeID: session.id };
      let needs   = await permissionEngine.checkPermission('shell:cat', {}, options);

      assert.equal(needs, false, 'cat should be auto-allowed after allow rule creation');
    });

    it('should create deny rule for deny-forever decision', async () => {
      let { session, organizationID } = await createTestSession();

      await permissionEngine.createRule({
        organizationID,
        featureName: 'shell:rm',
        effect:      'deny',
        scope:       'session',
        scopeID:     session.id,
        createdBy:   'user_test',
      });

      // Verify the rule works — should throw PermissionDeniedError
      let options = { organizationID, scope: 'session', scopeID: session.id };

      await assert.rejects(
        () => permissionEngine.checkPermission('shell:rm', {}, options),
        (error) => {
          assert.equal(error.name, 'PermissionDeniedError');
          return true;
        },
      );
    });
  });

  // ===========================================================================
  // 4b. Argument-level matching (ShellPermissions.matchesRule)
  // ===========================================================================

  describe('argument-level matching via ShellPermissions', () => {
    let ShellToolClass;

    before(() => {
      let pluginRegistry = context.getProperty('pluginRegistry');
      ShellToolClass     = pluginRegistry.getTool('shell:execute');
    });

    it('should auto-allow when command AND arguments match exactly', async () => {
      let { session, organizationID } = await createTestSession();

      await permissionEngine.createRule({
        organizationID,
        featureName: 'shell:ls',
        effect:      'allow',
        scope:       'session',
        scopeID:     session.id,
        createdBy:   'user_test',
        metadata:    { command: 'ls', arguments: ['-la', '/tmp/'] },
      });

      let options = { organizationID, scope: 'session', scopeID: session.id, toolClass: ShellToolClass };
      let needs   = await permissionEngine.checkPermission('shell:ls', { command: 'ls', arguments: ['-la', '/tmp/'] }, options);

      assert.equal(needs, false, 'Exact match should be auto-allowed');
    });

    it('should NOT auto-allow when arguments differ', async () => {
      let { session, organizationID } = await createTestSession();

      await permissionEngine.createRule({
        organizationID,
        featureName: 'shell:ls',
        effect:      'allow',
        scope:       'session',
        scopeID:     session.id,
        createdBy:   'user_test',
        metadata:    { command: 'ls', arguments: ['-la', '/tmp/'] },
      });

      let options = { organizationID, scope: 'session', scopeID: session.id, toolClass: ShellToolClass };
      let needs   = await permissionEngine.checkPermission('shell:ls', { command: 'ls', arguments: ['/etc/shadow'] }, options);

      assert.equal(needs, true, 'Different arguments should still need approval');
    });

    it('should NOT auto-allow when argument count differs', async () => {
      let { session, organizationID } = await createTestSession();

      await permissionEngine.createRule({
        organizationID,
        featureName: 'shell:ls',
        effect:      'allow',
        scope:       'session',
        scopeID:     session.id,
        createdBy:   'user_test',
        metadata:    { command: 'ls', arguments: ['-la', '/tmp/'] },
      });

      let options = { organizationID, scope: 'session', scopeID: session.id, toolClass: ShellToolClass };
      let needs   = await permissionEngine.checkPermission('shell:ls', { command: 'ls', arguments: [] }, options);

      assert.equal(needs, true, 'No-argument ls should not be covered by ls -la /tmp/ rule');
    });

    it('should deny-forever with argument matching', async () => {
      let { session, organizationID } = await createTestSession();

      await permissionEngine.createRule({
        organizationID,
        featureName: 'shell:rm',
        effect:      'deny',
        scope:       'session',
        scopeID:     session.id,
        createdBy:   'user_test',
        metadata:    { command: 'rm', arguments: ['-rf', '/'] },
      });

      let options = { organizationID, scope: 'session', scopeID: session.id, toolClass: ShellToolClass };

      // Exact match should be denied
      await assert.rejects(
        () => permissionEngine.checkPermission('shell:rm', { command: 'rm', arguments: ['-rf', '/'] }, options),
        (error) => {
          assert.equal(error.name, 'PermissionDeniedError');
          return true;
        },
      );

      // Different arguments should NOT be denied by this rule
      let needs = await permissionEngine.checkPermission('shell:rm', { command: 'rm', arguments: ['file.txt'] }, options);
      assert.equal(needs, true, 'rm file.txt should need approval (not auto-denied by rm -rf / rule)');
    });

    it('should NOT match when arguments are in different order', async () => {
      let { session, organizationID } = await createTestSession();

      await permissionEngine.createRule({
        organizationID,
        featureName: 'shell:ls',
        effect:      'allow',
        scope:       'session',
        scopeID:     session.id,
        createdBy:   'user_test',
        metadata:    { command: 'ls', arguments: ['-la', '/tmp/'] },
      });

      let options = { organizationID, scope: 'session', scopeID: session.id, toolClass: ShellToolClass };

      // Same args, different order — should NOT match (argument order is semantically meaningful)
      let needs = await permissionEngine.checkPermission('shell:ls', { command: 'ls', arguments: ['/tmp/', '-la'] }, options);
      assert.equal(needs, true, 'Different argument order should require fresh approval');
    });

    it('should fall through to default when no metadata rules match', async () => {
      let { session, organizationID } = await createTestSession();

      // Rule WITHOUT metadata (legacy style) — matches everything
      await permissionEngine.createRule({
        organizationID,
        featureName: 'shell:cat',
        effect:      'allow',
        scope:       'session',
        scopeID:     session.id,
        createdBy:   'user_test',
      });

      let options = { organizationID, scope: 'session', scopeID: session.id, toolClass: ShellToolClass };
      let needs   = await permissionEngine.checkPermission('shell:cat', { command: 'cat', arguments: ['/etc/passwd'] }, options);

      assert.equal(needs, false, 'Rule without metadata should match any arguments (legacy compat)');
    });
  });

  // ===========================================================================
  // 5. Deny with replay
  // ===========================================================================

  describe('deny with replay', () => {
    it('should start new interaction after denyPermission', async () => {
      let { session } = await createTestSession();
      let loop        = createLoop();
      let emitted     = [];
      let interactionStarts = 0;

      loop.on('frame', (ev) => emitted.push(ev.frame));
      loop.on('interaction:start', () => interactionStarts++);

      let agent = new MockAgent(context, [shellToolCall('ls -la')]);

      // First interaction — will hit permission hard-break
      await loop.startInteraction(session.id, defaultParams(agent, {
        agentPlugin: agent,
        executeTool: async () => {
          throw new PermissionRequiredError('shell:execute', { title: 'shell:execute' });
        },
      }));

      assert.equal(interactionStarts, 1);

      // Now deny — should start a replay interaction
      await loop.denyPermission(session.id);

      // Interaction starts should be 2 (original + replay)
      assert.equal(interactionStarts, 2);

      // Should have denial frame
      let denialFrames = emitted.filter((f) => f.type === 'permission-denied');
      assert.equal(denialFrames.length, 1);
    });
  });

  // ===========================================================================
  // 6. Backward compatibility — no body = approve all
  // ===========================================================================

  describe('backward compatibility', () => {
    it('should approve when no decisions are provided', async () => {
      let { session } = await createTestSession();
      let loop        = createLoop();
      let emitted     = [];
      let toolExecuted = false;

      loop.on('frame', (ev) => emitted.push(ev.frame));

      let agent = new MockAgent(context, [shellToolCall('echo hello')]);

      let callCount = 0;

      await loop.startInteraction(session.id, defaultParams(agent, {
        agentPlugin: agent,
        executeTool: async () => {
          callCount++;
          if (callCount === 1)
            throw new PermissionRequiredError('shell:execute', { title: 'shell:execute' });

          toolExecuted = true;
          return 'hello';
        },
      }));

      // Now approve without decisions (backward compat)
      await loop.approvePermission(session.id);

      assert.ok(toolExecuted, 'Tool should have been executed via approvePermission');
    });
  });
});
