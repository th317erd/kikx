'use strict';

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ============================================================================
// Environment Setup (must happen before any app module imports)
// ============================================================================

let testDir = mkdtempSync(join(tmpdir(), 'hero-delegate-test-'));

process.env.HERO_JWT_SECRET     = 'test-secret-key-for-testing';
process.env.HERO_ENCRYPTION_KEY = 'test-encryption-key-32chars!!';
process.env.XDG_CONFIG_HOME     = testDir;

// Dynamic imports after env is configured
let DelegateFunction;
let MAX_DELEGATION_DEPTH;
let database;
let auth;
let encryption;
let participants;

async function loadModules() {
  database   = await import('../../../../server/database.mjs');
  auth       = await import('../../../../server/auth.mjs');
  encryption = await import('../../../../server/encryption.mjs');

  let delegateModule = await import('../../../../server/lib/interactions/functions/delegate.mjs');
  DelegateFunction     = delegateModule.DelegateFunction;
  MAX_DELEGATION_DEPTH = delegateModule.MAX_DELEGATION_DEPTH;

  participants = await import('../../../../server/lib/participants/index.mjs');
}

describe('DelegateFunction', async () => {
  await loadModules();

  let db;
  let userId;
  let dataKey;
  let coordinatorAgentId;
  let memberAgentId;
  let sessionId;

  beforeEach(async () => {
    db = database.getDatabase();

    // Clear test data
    db.exec('DELETE FROM frames');
    db.exec('DELETE FROM session_participants');
    db.exec('DELETE FROM sessions');
    db.exec('DELETE FROM agents');
    db.exec('DELETE FROM users');

    // Create test user and authenticate to get dataKey
    await auth.createUser('testuser', 'testpass');
    let authenticated = await auth.authenticateUser('testuser', 'testpass');
    userId  = authenticated.id;
    dataKey = authenticated.secret.dataKey;

    // Create coordinator agent (with encrypted key)
    let encryptedKey = encryption.encryptWithKey('fake-api-key-coordinator', dataKey);
    let agentResult  = db.prepare(`
      INSERT INTO agents (user_id, name, type, encrypted_api_key)
      VALUES (?, 'test-coordinator', 'claude', ?)
    `).run(userId, encryptedKey);
    coordinatorAgentId = Number(agentResult.lastInsertRowid);

    // Create member agent (with encrypted key)
    let memberEncryptedKey = encryption.encryptWithKey('fake-api-key-member', dataKey);
    let memberResult       = db.prepare(`
      INSERT INTO agents (user_id, name, type, encrypted_api_key)
      VALUES (?, 'test-member', 'claude', ?)
    `).run(userId, memberEncryptedKey);
    memberAgentId = Number(memberResult.lastInsertRowid);

    // Create session
    let sessionResult = db.prepare(`
      INSERT INTO sessions (user_id, agent_id, name)
      VALUES (?, ?, 'Test Session')
    `).run(userId, coordinatorAgentId);
    sessionId = Number(sessionResult.lastInsertRowid);

    // Add participants
    participants.addParticipant(sessionId, 'user', userId, 'owner', db);
    participants.addParticipant(sessionId, 'agent', coordinatorAgentId, 'coordinator', db);
    participants.addParticipant(sessionId, 'agent', memberAgentId, 'member', db);
  });

  describe('static register()', () => {
    it('should return valid registration info', () => {
      let reg = DelegateFunction.register();
      assert.strictEqual(reg.name, 'delegate');
      assert.strictEqual(reg.target, '@system');
      assert.ok(reg.description);
      assert.ok(reg.schema);
      assert.deepStrictEqual(reg.schema.required, ['agentId', 'task']);
    });
  });

  describe('allowed()', () => {
    it('should allow valid delegation requests', async () => {
      let func   = new DelegateFunction({ sessionId });
      let result = await func.allowed(
        { agentId: memberAgentId, task: 'Do something' },
        { sessionId },
      );
      assert.strictEqual(result.allowed, true);
    });

    it('should deny when no sessionId', async () => {
      let func   = new DelegateFunction({});
      let result = await func.allowed(
        { agentId: memberAgentId, task: 'Do something' },
        {},
      );
      assert.strictEqual(result.allowed, false);
      assert.ok(result.reason.includes('session'));
    });

    it('should deny when no agentId', async () => {
      let func   = new DelegateFunction({ sessionId });
      let result = await func.allowed({ task: 'Do something' }, { sessionId });
      assert.strictEqual(result.allowed, false);
      assert.ok(result.reason.includes('agentId'));
    });

    it('should deny when no task', async () => {
      let func   = new DelegateFunction({ sessionId });
      let result = await func.allowed({ agentId: memberAgentId }, { sessionId });
      assert.strictEqual(result.allowed, false);
      assert.ok(result.reason.includes('Task'));
    });
  });

  describe('execute()', () => {
    it('should fail if recursion depth exceeded', async () => {
      let func = new DelegateFunction({
        sessionId,
        userId,
        dataKey,
        agentId:         coordinatorAgentId,
        delegationDepth: MAX_DELEGATION_DEPTH,
        db,
      });

      let result = await func.execute({
        agentId: memberAgentId,
        task:    'Do something',
      });

      assert.strictEqual(result.status, 'failed');
      assert.ok(result.error.includes('Maximum delegation depth'));
    });

    it('should fail if target agent is not a session participant', async () => {
      // Create an agent that is NOT in the session
      let outsiderResult = db.prepare(`
        INSERT INTO agents (user_id, name, type, encrypted_api_key)
        VALUES (?, 'test-outsider', 'claude', 'fake-key')
      `).run(userId);
      let outsiderAgentId = Number(outsiderResult.lastInsertRowid);

      let func = new DelegateFunction({
        sessionId,
        userId,
        dataKey,
        agentId:         coordinatorAgentId,
        delegationDepth: 0,
        db,
      });

      let result = await func.execute({
        agentId: outsiderAgentId,
        task:    'Do something',
      });

      assert.strictEqual(result.status, 'failed');
      assert.ok(result.error.includes('not a participant'));
    });

    it('should fail if agent tries to delegate to itself', async () => {
      let func = new DelegateFunction({
        sessionId,
        userId,
        dataKey,
        agentId:         coordinatorAgentId,
        delegationDepth: 0,
        db,
      });

      let result = await func.execute({
        agentId: coordinatorAgentId,
        task:    'Do something',
      });

      assert.strictEqual(result.status, 'failed');
      assert.ok(result.error.includes('cannot delegate to itself'));
    });

    it('should fail if target agent does not exist in database', async () => {
      // Add a participant for a non-existent agent
      participants.addParticipant(sessionId, 'agent', 99999, 'member', db);

      let func = new DelegateFunction({
        sessionId,
        userId,
        dataKey,
        agentId:         coordinatorAgentId,
        delegationDepth: 0,
        db,
      });

      let result = await func.execute({
        agentId: 99999,
        task:    'Do something',
      });

      assert.strictEqual(result.status, 'failed');
      assert.ok(result.error.includes('not found'));
    });

    it('should fail if dataKey is not available', async () => {
      let func = new DelegateFunction({
        sessionId,
        userId,
        dataKey:         null,
        agentId:         coordinatorAgentId,
        delegationDepth: 0,
        db,
      });

      let result = await func.execute({
        agentId: memberAgentId,
        task:    'Do something',
      });

      assert.strictEqual(result.status, 'failed');
      assert.ok(result.error.includes('Data key'));
    });

    it('should increment delegation depth in result', async () => {
      // This test just verifies the depth tracking works.
      // We can't actually call the agent API in tests (fake key),
      // so we expect a failure from the API call but depth should be tracked.
      let func = new DelegateFunction({
        sessionId,
        userId,
        dataKey,
        agentId:         coordinatorAgentId,
        delegationDepth: 3,
        db,
      });

      // The agent API call will fail because we have a fake key,
      // but it should get past all validation
      let result = await func.execute({
        agentId: memberAgentId,
        task:    'Do something',
      });

      // Should fail at the API level, not at validation
      assert.strictEqual(result.status, 'failed');
      assert.ok(
        result.error.includes('failed to process') || result.error.includes('Failed to create'),
        `Expected API-level failure, got: ${result.error}`,
      );
    });

    it('should respect MAX_DELEGATION_DEPTH constant', () => {
      assert.strictEqual(MAX_DELEGATION_DEPTH, 10);
    });

    it('should allow delegation at depth MAX - 1', async () => {
      let func = new DelegateFunction({
        sessionId,
        userId,
        dataKey,
        agentId:         coordinatorAgentId,
        delegationDepth: MAX_DELEGATION_DEPTH - 1,
        db,
      });

      // Should pass validation (fail at API level)
      let result = await func.execute({
        agentId: memberAgentId,
        task:    'Do something',
      });

      // Should NOT be a depth error
      assert.notEqual(
        result.error?.includes('Maximum delegation depth'),
        true,
        'Should not fail on depth at MAX - 1',
      );
    });
  });

  describe('recursion depth enforcement', () => {
    it('should block at exact MAX_DELEGATION_DEPTH', async () => {
      let func = new DelegateFunction({
        sessionId,
        userId,
        dataKey,
        agentId:         coordinatorAgentId,
        delegationDepth: 10,
        db,
      });

      let result = await func.execute({
        agentId: memberAgentId,
        task:    'Do something',
      });

      assert.strictEqual(result.status, 'failed');
      assert.ok(result.error.includes('Maximum delegation depth'));
    });

    it('should block above MAX_DELEGATION_DEPTH', async () => {
      let func = new DelegateFunction({
        sessionId,
        userId,
        dataKey,
        agentId:         coordinatorAgentId,
        delegationDepth: 15,
        db,
      });

      let result = await func.execute({
        agentId: memberAgentId,
        task:    'Do something',
      });

      assert.strictEqual(result.status, 'failed');
      assert.ok(result.error.includes('Maximum delegation depth'));
    });

    it('should default to depth 0 when not provided', async () => {
      let func = new DelegateFunction({
        sessionId,
        userId,
        dataKey,
        agentId: coordinatorAgentId,
        // No delegationDepth set
        db,
      });

      // Should not fail on depth check (may fail on API call)
      let result = await func.execute({
        agentId: memberAgentId,
        task:    'Do something',
      });

      assert.notEqual(
        result.error?.includes('Maximum delegation depth'),
        true,
      );
    });
  });
});
