'use strict';

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ============================================================================
// Environment Setup (must happen before any app module imports)
// ============================================================================

let testDir = mkdtempSync(join(tmpdir(), 'hero-cmd-handler-test-'));

process.env.HERO_JWT_SECRET = 'test-secret-key-for-testing';
process.env.HERO_ENCRYPTION_KEY = 'test-encryption-key-32chars!!';
process.env.XDG_CONFIG_HOME = testDir;

// Dynamic imports after env is configured
let handleCommandInterception;
let database;
let auth;

async function loadModules() {
  database = await import('../../../server/database.mjs');
  auth = await import('../../../server/auth.mjs');
  let mod = await import('../../../server/lib/messaging/command-handler.mjs');
  handleCommandInterception = mod.handleCommandInterception;
}

let permissions;

async function loadPermissionsModule() {
  permissions = await import('../../../server/lib/permissions/index.mjs');
}

describe('command-handler', async () => {
  await loadModules();
  await loadPermissionsModule();

  let db;
  let userId;
  let sessionId;
  let agentId;

  beforeEach(async () => {
    db = database.getDatabase();

    // Clear test data for isolation
    db.exec('DELETE FROM permission_rules');
    db.exec('DELETE FROM frames');
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

  describe('handleCommandInterception()', () => {
    it('should return handled: false for non-command content', async () => {
      let result = await handleCommandInterception({
        content: 'Hello world',
        sessionId,
        userId,
      });
      assert.strictEqual(result.handled, false);
    });

    it('should return handled: true for /help', async () => {
      let result = await handleCommandInterception({
        content: '/help',
        sessionId,
        userId,
      });
      assert.strictEqual(result.handled, true);
      assert.ok(result.result);
      assert.strictEqual(result.result.command, 'help');
      assert.strictEqual(result.result.success, true);
    });

    it('should return 404 for non-existent session', async () => {
      let result = await handleCommandInterception({
        content: '/help',
        sessionId: 99999,
        userId,
      });
      assert.strictEqual(result.handled, true);
      assert.strictEqual(result.status, 404);
      assert.ok(result.error);
    });

    it('should create user message frame', async () => {
      await handleCommandInterception({
        content: '/help',
        sessionId,
        userId,
      });

      let frames = db.prepare(`
        SELECT * FROM frames WHERE session_id = ? AND author_type = 'user'
      `).all(sessionId);
      assert.ok(frames.length > 0, 'Should have created a user frame');
    });

    it('should create agent response frame', async () => {
      await handleCommandInterception({
        content: '/help',
        sessionId,
        userId,
      });

      let frames = db.prepare(`
        SELECT * FROM frames WHERE session_id = ? AND author_type = 'agent'
      `).all(sessionId);
      assert.ok(frames.length > 0, 'Should have created an agent frame');
    });

    it('should return handled: false for non-command text', async () => {
      let result = await handleCommandInterception({
        content: 'not a /command',
        sessionId,
        userId,
      });
      assert.strictEqual(result.handled, false);
    });

    it('should handle /session command', async () => {
      let result = await handleCommandInterception({
        content: '/session',
        sessionId,
        userId,
      });
      assert.strictEqual(result.handled, true);
      assert.strictEqual(result.result.command, 'session');
      assert.strictEqual(result.result.success, true);
    });

    it('should handle unknown commands', async () => {
      let result = await handleCommandInterception({
        content: '/nonexistent_xyz',
        sessionId,
        userId,
      });
      assert.strictEqual(result.handled, true);
      assert.ok(result.result);
    });

    it('should reject wrong user for session', async () => {
      let otherUser = await auth.createUser('otheruser', 'otherpass');

      let result = await handleCommandInterception({
        content: '/help',
        sessionId,
        userId: otherUser.id,
      });
      assert.strictEqual(result.handled, true);
      assert.strictEqual(result.status, 404);
    });

    it('should handle /stream command', async () => {
      let result = await handleCommandInterception({
        content: '/stream on',
        sessionId,
        userId,
      });
      assert.strictEqual(result.handled, true);
      assert.strictEqual(result.result.command, 'stream');
    });

    it('should handle command with leading whitespace', async () => {
      let result = await handleCommandInterception({
        content: '  /help',
        sessionId,
        userId,
      });
      assert.strictEqual(result.handled, true);
      assert.strictEqual(result.result.command, 'help');
    });
  });

  describe('Permission integration', () => {
    it('should allow commands when no permission rules exist (default: prompt, not deny)', async () => {
      // Default action is 'prompt' which does NOT block user-initiated commands
      let result = await handleCommandInterception({
        content: '/help',
        sessionId,
        userId,
      });
      assert.strictEqual(result.handled, true);
      assert.strictEqual(result.result.success, true);
    });

    it('should deny commands when an explicit deny rule exists', async () => {
      permissions.createRule({
        ownerId:      userId,
        subjectType:  permissions.SubjectType.USER,
        subjectId:    userId,
        resourceType: permissions.ResourceType.COMMAND,
        resourceName: 'help',
        action:       permissions.Action.DENY,
      }, db);

      let result = await handleCommandInterception({
        content: '/help',
        sessionId,
        userId,
      });
      assert.strictEqual(result.handled, true);
      assert.strictEqual(result.result.success, false);
      assert.strictEqual(result.result.error, 'Permission denied');
    });

    it('should create a permission denied response frame', async () => {
      permissions.createRule({
        ownerId:      userId,
        subjectType:  permissions.SubjectType.USER,
        subjectId:    userId,
        resourceType: permissions.ResourceType.COMMAND,
        resourceName: 'session',
        action:       permissions.Action.DENY,
      }, db);

      await handleCommandInterception({
        content: '/session',
        sessionId,
        userId,
      });

      let frames = db.prepare(`
        SELECT * FROM frames WHERE session_id = ? AND author_type = 'agent'
      `).all(sessionId);

      assert.ok(frames.length > 0, 'Should have created a denial response frame');
      let payloadRaw = frames[0].payload;
      // The payload may be double-encoded or wrapped in content blocks
      assert.ok(
        payloadRaw.includes('Permission denied'),
        `Frame should contain permission denied message, got: ${payloadRaw.substring(0, 200)}`,
      );
    });

    it('should allow commands with explicit allow rule', async () => {
      permissions.createRule({
        ownerId:      userId,
        subjectType:  permissions.SubjectType.USER,
        subjectId:    userId,
        resourceType: permissions.ResourceType.COMMAND,
        resourceName: 'help',
        action:       permissions.Action.ALLOW,
      }, db);

      let result = await handleCommandInterception({
        content: '/help',
        sessionId,
        userId,
      });
      assert.strictEqual(result.handled, true);
      assert.strictEqual(result.result.success, true);
    });

    it('should deny specific command but allow others', async () => {
      // Deny 'session' command for this user
      permissions.createRule({
        ownerId:      userId,
        subjectType:  permissions.SubjectType.USER,
        subjectId:    userId,
        resourceType: permissions.ResourceType.COMMAND,
        resourceName: 'session',
        action:       permissions.Action.DENY,
      }, db);

      // /session should be denied
      let sessionResult = await handleCommandInterception({
        content: '/session',
        sessionId,
        userId,
      });
      assert.strictEqual(sessionResult.result.error, 'Permission denied');

      // /help should still work (no deny rule)
      let helpResult = await handleCommandInterception({
        content: '/help',
        sessionId,
        userId,
      });
      assert.strictEqual(helpResult.result.success, true);
    });

    it('should respect once-scoped rules (consumed after first use)', async () => {
      permissions.createRule({
        ownerId:      userId,
        subjectType:  permissions.SubjectType.USER,
        subjectId:    userId,
        resourceType: permissions.ResourceType.COMMAND,
        resourceName: 'help',
        action:       permissions.Action.DENY,
        scope:        permissions.Scope.ONCE,
      }, db);

      // First attempt: denied
      let result1 = await handleCommandInterception({
        content: '/help',
        sessionId,
        userId,
      });
      assert.strictEqual(result1.result.error, 'Permission denied');

      // Second attempt: rule consumed, falls to default (prompt = allowed for users)
      let result2 = await handleCommandInterception({
        content: '/help',
        sessionId,
        userId,
      });
      assert.strictEqual(result2.result.success, true);
    });

    it('should deny all commands with wildcard resource deny rule', async () => {
      permissions.createRule({
        ownerId:      userId,
        subjectType:  permissions.SubjectType.USER,
        subjectId:    userId,
        resourceType: permissions.ResourceType.COMMAND,
        action:       permissions.Action.DENY,
      }, db);

      let helpResult = await handleCommandInterception({
        content: '/help',
        sessionId,
        userId,
      });
      assert.strictEqual(helpResult.result.error, 'Permission denied');

      let sessionResult = await handleCommandInterception({
        content: '/session',
        sessionId,
        userId,
      });
      assert.strictEqual(sessionResult.result.error, 'Permission denied');
    });
  });
});
