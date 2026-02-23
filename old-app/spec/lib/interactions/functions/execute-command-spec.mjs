'use strict';

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ============================================================================
// Environment Setup (must happen before any app module imports)
// ============================================================================

let testDir = mkdtempSync(join(tmpdir(), 'hero-exec-cmd-test-'));

process.env.HERO_JWT_SECRET     = 'test-secret-key-for-testing';
process.env.HERO_ENCRYPTION_KEY = 'test-encryption-key-32chars!!';
process.env.XDG_CONFIG_HOME     = testDir;

// Dynamic imports after env is configured
let ExecuteCommandFunction;
let database;
let auth;
let permissions;
let permissionPrompt;

async function loadModules() {
  database = await import('../../../../server/database.mjs');
  auth     = await import('../../../../server/auth.mjs');

  let execModule       = await import('../../../../server/lib/interactions/functions/execute-command.mjs');
  ExecuteCommandFunction = execModule.ExecuteCommandFunction;

  permissions      = await import('../../../../server/lib/permissions/index.mjs');
  permissionPrompt = await import('../../../../server/lib/permissions/prompt.mjs');
}

describe('ExecuteCommandFunction', async () => {
  await loadModules();

  let db;
  let userId;
  let agentId;
  let sessionId;

  beforeEach(async () => {
    db = database.getDatabase();

    // Clear test data
    db.exec('DELETE FROM permission_rules');
    db.exec('DELETE FROM frames');
    db.exec('DELETE FROM session_participants');
    db.exec('DELETE FROM sessions');
    db.exec('DELETE FROM agents');
    db.exec('DELETE FROM users');

    // Create test user
    let user = await auth.createUser('testuser', 'testpass');
    userId = user.id;

    // Create test agent
    let agentResult = db.prepare(`
      INSERT INTO agents (user_id, name, type, encrypted_api_key)
      VALUES (?, 'test-agent', 'claude', 'fake-key')
    `).run(userId);
    agentId = Number(agentResult.lastInsertRowid);

    // Create test session
    let sessionResult = db.prepare(`
      INSERT INTO sessions (user_id, agent_id, name)
      VALUES (?, ?, 'Test Session')
    `).run(userId, agentId);
    sessionId = Number(sessionResult.lastInsertRowid);
  });

  describe('static register()', () => {
    it('should return valid registration info', () => {
      let reg = ExecuteCommandFunction.register();
      assert.strictEqual(reg.name, 'execute_command');
      assert.strictEqual(reg.target, '@system');
      assert.ok(reg.description);
      assert.ok(reg.schema);
      assert.deepStrictEqual(reg.schema.required, ['command']);
    });
  });

  describe('allowed()', () => {
    it('should allow valid command requests', async () => {
      let func   = new ExecuteCommandFunction({});
      let result = await func.allowed({ command: 'help' }, {});
      assert.strictEqual(result.allowed, true);
    });

    it('should deny when no command name', async () => {
      let func   = new ExecuteCommandFunction({});
      let result = await func.allowed({}, {});
      assert.strictEqual(result.allowed, false);
      assert.ok(result.reason.includes('required'));
    });

    it('should deny for unknown commands', async () => {
      let func   = new ExecuteCommandFunction({});
      let result = await func.allowed({ command: 'nonexistent_xyz_abc' }, {});
      assert.strictEqual(result.allowed, false);
      assert.ok(result.reason.includes('Unknown command'));
    });
  });

  describe('execute()', () => {
    it('should execute the help command successfully when explicitly allowed', async () => {
      // Agent needs explicit allow rule to execute commands
      permissions.createRule({
        ownerId:      userId,
        subjectType:  permissions.SubjectType.AGENT,
        subjectId:    agentId,
        resourceType: permissions.ResourceType.COMMAND,
        resourceName: 'help',
        action:       permissions.Action.ALLOW,
      }, db);

      let func = new ExecuteCommandFunction({
        sessionId,
        userId,
        agentId,
        db,
      });

      let result = await func.execute({ command: 'help' });
      assert.strictEqual(result.status, 'completed');
      assert.strictEqual(result.command, 'help');
      assert.ok(result.result.success);
      assert.ok(result.result.content.includes('Help'));
    });

    it('should execute the session command when allowed', async () => {
      permissions.createRule({
        ownerId:      userId,
        subjectType:  permissions.SubjectType.AGENT,
        subjectId:    agentId,
        resourceType: permissions.ResourceType.COMMAND,
        resourceName: 'session',
        action:       permissions.Action.ALLOW,
      }, db);

      let func = new ExecuteCommandFunction({
        sessionId,
        userId,
        agentId,
        db,
      });

      let result = await func.execute({ command: 'session' });
      assert.strictEqual(result.command, 'session');
      assert.strictEqual(result.status, 'completed');
    });

    it('should pass args to the command', async () => {
      permissions.createRule({
        ownerId:      userId,
        subjectType:  permissions.SubjectType.AGENT,
        subjectId:    agentId,
        resourceType: permissions.ResourceType.COMMAND,
        resourceName: 'help',
        action:       permissions.Action.ALLOW,
      }, db);

      let func = new ExecuteCommandFunction({
        sessionId,
        userId,
        agentId,
        db,
      });

      // /help with a filter arg
      let result = await func.execute({ command: 'help', args: 'session' });
      assert.strictEqual(result.status, 'completed');
      assert.strictEqual(result.args, 'session');
    });

    it('should default args to empty string', async () => {
      // Add allow rule so command executes
      permissions.createRule({
        ownerId:      userId,
        subjectType:  permissions.SubjectType.AGENT,
        subjectId:    agentId,
        resourceType: permissions.ResourceType.COMMAND,
        resourceName: 'help',
        action:       permissions.Action.ALLOW,
      }, db);

      let func = new ExecuteCommandFunction({
        sessionId,
        userId,
        agentId,
        db,
      });

      let result = await func.execute({ command: 'help' });
      assert.strictEqual(result.status, 'completed');
      assert.strictEqual(result.args, '');
    });

    it('should fail for unknown commands even when permission prompt is approved', async () => {
      // Allow all commands for this agent
      permissions.createRule({
        ownerId:      userId,
        subjectType:  permissions.SubjectType.AGENT,
        subjectId:    agentId,
        resourceType: permissions.ResourceType.COMMAND,
        action:       permissions.Action.ALLOW,
      }, db);

      let func = new ExecuteCommandFunction({
        sessionId,
        userId,
        agentId,
        db,
      });

      // allowed() already catches unknown commands before execute()
      let allowed = await func.allowed({ command: 'nonexistent_xyz' });
      assert.strictEqual(allowed.allowed, false);
      assert.ok(allowed.reason.includes('Unknown command'));
    });

    it('should return failed for unknown commands when allowed by wildcard', async () => {
      // Allow all commands for this agent
      permissions.createRule({
        ownerId:      userId,
        subjectType:  permissions.SubjectType.AGENT,
        subjectId:    agentId,
        resourceType: permissions.ResourceType.COMMAND,
        action:       permissions.Action.ALLOW,
      }, db);

      let func = new ExecuteCommandFunction({
        sessionId,
        userId,
        agentId,
        db,
      });

      let result = await func.execute({ command: 'nonexistent_xyz' });
      assert.strictEqual(result.status, 'failed');
      assert.ok(result.result.error.includes('Unknown command'));
    });
  });

  describe('permission integration', () => {
    it('should trigger permission prompt when no rules exist (default: prompt)', async () => {
      // Default action is 'prompt' — verify the permission engine returns it
      let evaluation = permissions.evaluate(
        { type: permissions.SubjectType.AGENT, id: agentId },
        { type: permissions.ResourceType.COMMAND, name: 'help' },
        { sessionId, ownerId: userId },
        db,
      );
      assert.strictEqual(evaluation.action, permissions.Action.PROMPT);
      assert.strictEqual(evaluation.rule, null);
    });

    it('should deny commands with explicit deny rule', async () => {
      permissions.createRule({
        ownerId:      userId,
        subjectType:  permissions.SubjectType.AGENT,
        subjectId:    agentId,
        resourceType: permissions.ResourceType.COMMAND,
        resourceName: 'help',
        action:       permissions.Action.DENY,
      }, db);

      let func = new ExecuteCommandFunction({
        sessionId,
        userId,
        agentId,
        db,
      });

      let result = await func.execute({ command: 'help' });
      assert.strictEqual(result.status, 'failed');
      assert.ok(result.error.includes('Permission denied'));
    });

    it('should allow commands with explicit allow rule', async () => {
      permissions.createRule({
        ownerId:      userId,
        subjectType:  permissions.SubjectType.AGENT,
        subjectId:    agentId,
        resourceType: permissions.ResourceType.COMMAND,
        resourceName: 'help',
        action:       permissions.Action.ALLOW,
      }, db);

      let func = new ExecuteCommandFunction({
        sessionId,
        userId,
        agentId,
        db,
      });

      let result = await func.execute({ command: 'help' });
      assert.strictEqual(result.status, 'completed');
      assert.ok(result.result.success);
    });

    it('should deny one command but allow another', async () => {
      // Deny 'session' for this agent
      permissions.createRule({
        ownerId:      userId,
        subjectType:  permissions.SubjectType.AGENT,
        subjectId:    agentId,
        resourceType: permissions.ResourceType.COMMAND,
        resourceName: 'session',
        action:       permissions.Action.DENY,
      }, db);

      // Allow 'help' for this agent
      permissions.createRule({
        ownerId:      userId,
        subjectType:  permissions.SubjectType.AGENT,
        subjectId:    agentId,
        resourceType: permissions.ResourceType.COMMAND,
        resourceName: 'help',
        action:       permissions.Action.ALLOW,
      }, db);

      let func = new ExecuteCommandFunction({
        sessionId,
        userId,
        agentId,
        db,
      });

      // help should work
      let helpResult = await func.execute({ command: 'help' });
      assert.strictEqual(helpResult.status, 'completed');

      // session should be denied
      let sessionResult = await func.execute({ command: 'session' });
      assert.strictEqual(sessionResult.status, 'failed');
      assert.ok(sessionResult.error.includes('Permission denied'));
    });

    it('should deny all commands with wildcard deny rule', async () => {
      permissions.createRule({
        ownerId:      userId,
        subjectType:  permissions.SubjectType.AGENT,
        subjectId:    agentId,
        resourceType: permissions.ResourceType.COMMAND,
        action:       permissions.Action.DENY,
      }, db);

      let func = new ExecuteCommandFunction({
        sessionId,
        userId,
        agentId,
        db,
      });

      let helpResult = await func.execute({ command: 'help' });
      assert.strictEqual(helpResult.status, 'failed');
      assert.ok(helpResult.error.includes('Permission denied'));

      let sessionResult = await func.execute({ command: 'session' });
      assert.strictEqual(sessionResult.status, 'failed');
      assert.ok(sessionResult.error.includes('Permission denied'));
    });

    it('should invoke requestPermissionPrompt when action is prompt', async () => {
      // Verify that execute-command.mjs calls requestPermissionPrompt
      // for the prompt path. The full prompt flow (create frame → user
      // answers → rule created → promise resolved) is tested in
      // permission-prompt-spec.mjs. Here we just verify the integration
      // by checking the engine defaults to PROMPT and that the source
      // code imports and calls requestPermissionPrompt.
      let evaluation = permissions.evaluate(
        { type: permissions.SubjectType.AGENT, id: agentId },
        { type: permissions.ResourceType.COMMAND, name: 'help' },
        { sessionId, ownerId: userId },
        db,
      );
      assert.strictEqual(evaluation.action, permissions.Action.PROMPT);

      // Structural check: execute-command.mjs imports requestPermissionPrompt
      let fs   = await import('node:fs');
      let path = await import('node:path');
      let source = fs.readFileSync(
        path.join(process.cwd(), 'server/lib/interactions/functions/execute-command.mjs'), 'utf-8'
      );
      assert.ok(source.includes('requestPermissionPrompt'), 'Should import requestPermissionPrompt');
      assert.ok(source.includes('await requestPermissionPrompt'), 'Should await requestPermissionPrompt');
    });

    it('should consume once-scoped rules on first use', async () => {
      permissions.createRule({
        ownerId:      userId,
        subjectType:  permissions.SubjectType.AGENT,
        subjectId:    agentId,
        resourceType: permissions.ResourceType.COMMAND,
        resourceName: 'help',
        action:       permissions.Action.ALLOW,
        scope:        permissions.Scope.ONCE,
      }, db);

      let func = new ExecuteCommandFunction({
        sessionId,
        userId,
        agentId,
        db,
      });

      // First call: allowed (once-scoped rule exists)
      let result1 = await func.execute({ command: 'help' });
      assert.strictEqual(result1.status, 'completed');

      // Verify rule was consumed
      let rules = permissions.listRules({
        ownerId:      userId,
        resourceName: 'help',
      }, db);
      assert.strictEqual(rules.length, 0, 'Once-scoped rule should be consumed');

      // Verify evaluation now returns default (prompt)
      let evaluation = permissions.evaluate(
        { type: permissions.SubjectType.AGENT, id: agentId },
        { type: permissions.ResourceType.COMMAND, name: 'help' },
        { sessionId, ownerId: userId },
        db,
      );
      assert.strictEqual(evaluation.action, permissions.Action.PROMPT);
    });
  });
});
