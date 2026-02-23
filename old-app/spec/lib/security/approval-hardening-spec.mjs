'use strict';

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ============================================================================
// Environment Setup
// ============================================================================

let testDir = mkdtempSync(join(tmpdir(), 'hero-approval-hardening-test-'));

process.env.HERO_JWT_SECRET     = 'test-secret-key-for-testing';
process.env.HERO_ENCRYPTION_KEY = 'test-encryption-key-32chars!!';
process.env.XDG_CONFIG_HOME     = testDir;

let database;
let auth;
let approval;

async function loadModules() {
  database = await import('../../../server/database.mjs');
  auth     = await import('../../../server/auth.mjs');
  approval = await import('../../../server/lib/abilities/approval.mjs');
}

describe('Approval System Hardening (Phase 7)', async () => {
  await loadModules();

  let db;
  let userId;
  let otherUserId;
  let sessionId;

  // Test ability object
  let testAbility = {
    name:        'bash',
    type:        'builtin',
    description: 'Execute bash commands',
    category:    'system',
    permissions: { autoApprovePolicy: 'ask', dangerLevel: 'dangerous' },
  };

  beforeEach(async () => {
    db = database.getDatabase();

    db.exec('DELETE FROM ability_approvals');
    db.exec('DELETE FROM session_approvals');
    db.exec('DELETE FROM frames');
    db.exec('DELETE FROM session_participants');
    db.exec('DELETE FROM sessions');
    db.exec('DELETE FROM agents');
    db.exec('DELETE FROM users');

    let user1 = await auth.createUser('approvaluser1', 'testpass');
    userId = user1.id;

    let user2 = await auth.createUser('approvaluser2', 'testpass');
    otherUserId = user2.id;

    let agent = db.prepare(`
      INSERT INTO agents (user_id, name, type, encrypted_api_key)
      VALUES (?, 'test-agent', 'claude', 'fake-key')
    `).run(userId);
    let agentId = Number(agent.lastInsertRowid);

    let session = db.prepare(`
      INSERT INTO sessions (user_id, agent_id, name)
      VALUES (?, ?, 'Test Session')
    `).run(userId, agentId);
    sessionId = Number(session.lastInsertRowid);
  });

  // ===========================================================================
  // generateRequestHash
  // ===========================================================================
  describe('generateRequestHash()', () => {
    it('should generate a consistent hash for same inputs', () => {
      let hash1 = approval.generateRequestHash('bash', { command: 'ls -la' });
      let hash2 = approval.generateRequestHash('bash', { command: 'ls -la' });

      assert.strictEqual(hash1, hash2);
    });

    it('should generate different hash for different ability', () => {
      let hash1 = approval.generateRequestHash('bash', { command: 'ls' });
      let hash2 = approval.generateRequestHash('read_file', { command: 'ls' });

      assert.notStrictEqual(hash1, hash2);
    });

    it('should generate different hash for different params', () => {
      let hash1 = approval.generateRequestHash('bash', { command: 'ls' });
      let hash2 = approval.generateRequestHash('bash', { command: 'rm -rf /' });

      assert.notStrictEqual(hash1, hash2);
    });

    it('should return a 64-char hex string (SHA-256)', () => {
      let hash = approval.generateRequestHash('test', {});

      assert.strictEqual(hash.length, 64);
      assert.ok(/^[0-9a-f]+$/.test(hash));
    });
  });

  // ===========================================================================
  // User Ownership Verification
  // ===========================================================================
  describe('Approval ownership verification', () => {
    it('should accept approval from correct user', async () => {
      let params  = { command: 'ls -la' };
      let context = { userId, sessionId };

      // Start approval request (non-blocking)
      let approvalPromise = approval.requestApproval(testAbility, params, context);

      // Find the pending execution
      let pending = approval.getPendingApprovals(userId);
      assert.strictEqual(pending.length, 1);
      let executionId = pending[0].execution_id;

      // Approve as correct user
      let result = approval.handleApprovalResponse(
        executionId, true, null, false,
        { userId: userId }
      );

      assert.strictEqual(result.success, true);
      let resolved = await approvalPromise;
      assert.strictEqual(resolved.status, 'approved');
    });

    it('should reject approval from wrong user', async () => {
      let params  = { command: 'ls -la' };
      let context = { userId, sessionId };

      let approvalPromise = approval.requestApproval(testAbility, params, context);

      let pending     = approval.getPendingApprovals(userId);
      let executionId = pending[0].execution_id;

      // Try to approve as different user
      let result = approval.handleApprovalResponse(
        executionId, true, null, false,
        { userId: otherUserId }
      );

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('Not authorized'));

      // The pending approval should still exist
      let pendingEntry = approval.getPendingApproval(executionId);
      assert.ok(pendingEntry, 'Pending approval should not be consumed');

      // Clean up: approve as correct user
      approval.handleApprovalResponse(executionId, false, 'test cleanup', false, { userId });
      await approvalPromise;
    });

    it('should allow approval without userId for backward compatibility', async () => {
      let params  = { command: 'ls' };
      let context = { userId, sessionId };

      let approvalPromise = approval.requestApproval(testAbility, params, context);

      let pending     = approval.getPendingApprovals(userId);
      let executionId = pending[0].execution_id;

      // Approve without security context (backward compat)
      let result = approval.handleApprovalResponse(executionId, true);

      assert.strictEqual(result.success, true);
      let resolved = await approvalPromise;
      assert.strictEqual(resolved.status, 'approved');
    });
  });

  // ===========================================================================
  // Request Hash / Replay Prevention
  // ===========================================================================
  describe('Request hash verification', () => {
    it('should accept matching request hash', async () => {
      let params  = { command: 'cat /etc/passwd' };
      let context = { userId, sessionId };

      let approvalPromise = approval.requestApproval(testAbility, params, context);

      let pending     = approval.getPendingApprovals(userId);
      let executionId = pending[0].execution_id;

      // Get the correct hash
      let correctHash = approval.generateRequestHash(testAbility.name, params);

      let result = approval.handleApprovalResponse(
        executionId, true, null, false,
        { userId, requestHash: correctHash }
      );

      assert.strictEqual(result.success, true);
      let resolved = await approvalPromise;
      assert.strictEqual(resolved.status, 'approved');
    });

    it('should reject mismatched request hash', async () => {
      let params  = { command: 'cat /etc/passwd' };
      let context = { userId, sessionId };

      let approvalPromise = approval.requestApproval(testAbility, params, context);

      let pending     = approval.getPendingApprovals(userId);
      let executionId = pending[0].execution_id;

      // Use wrong hash (hash of different command)
      let wrongHash = approval.generateRequestHash(testAbility.name, { command: 'rm -rf /' });

      let result = approval.handleApprovalResponse(
        executionId, true, null, false,
        { userId, requestHash: wrongHash }
      );

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('hash mismatch'));

      // Clean up
      approval.handleApprovalResponse(executionId, false, 'cleanup', false, { userId });
      await approvalPromise;
    });

    it('should allow approval without hash for backward compatibility', async () => {
      let params  = { command: 'ls' };
      let context = { userId, sessionId };

      let approvalPromise = approval.requestApproval(testAbility, params, context);

      let pending     = approval.getPendingApprovals(userId);
      let executionId = pending[0].execution_id;

      // Approve without hash
      let result = approval.handleApprovalResponse(
        executionId, true, null, false,
        { userId }
      );

      assert.strictEqual(result.success, true);
      await approvalPromise;
    });
  });

  // ===========================================================================
  // Duplicate Resolution Prevention
  // ===========================================================================
  describe('Duplicate resolution prevention', () => {
    it('should reject second approval for same execution', async () => {
      let params  = { command: 'ls' };
      let context = { userId, sessionId };

      let approvalPromise = approval.requestApproval(testAbility, params, context);

      let pending     = approval.getPendingApprovals(userId);
      let executionId = pending[0].execution_id;

      // First approval succeeds
      let result1 = approval.handleApprovalResponse(
        executionId, true, null, false, { userId }
      );
      assert.strictEqual(result1.success, true);

      // Second approval fails (already resolved)
      let result2 = approval.handleApprovalResponse(
        executionId, true, null, false, { userId }
      );
      assert.strictEqual(result2.success, false);
      assert.ok(result2.error.includes('already resolved'));

      await approvalPromise;
    });

    it('should reject approval for nonexistent execution', () => {
      let result = approval.handleApprovalResponse(
        'nonexistent-uuid', true, null, false, { userId }
      );

      assert.strictEqual(result.success, false);
    });
  });

  // ===========================================================================
  // Denial flow
  // ===========================================================================
  describe('Denial with security context', () => {
    it('should allow denial from correct user', async () => {
      let params  = { command: 'rm -rf /' };
      let context = { userId, sessionId };

      let approvalPromise = approval.requestApproval(testAbility, params, context);

      let pending     = approval.getPendingApprovals(userId);
      let executionId = pending[0].execution_id;

      let result = approval.handleApprovalResponse(
        executionId, false, 'Too dangerous', false,
        { userId }
      );

      assert.strictEqual(result.success, true);
      let resolved = await approvalPromise;
      assert.strictEqual(resolved.status, 'denied');
      assert.strictEqual(resolved.reason, 'Too dangerous');
    });

    it('should reject denial from wrong user', async () => {
      let params  = { command: 'rm -rf /' };
      let context = { userId, sessionId };

      let approvalPromise = approval.requestApproval(testAbility, params, context);

      let pending     = approval.getPendingApprovals(userId);
      let executionId = pending[0].execution_id;

      let result = approval.handleApprovalResponse(
        executionId, false, 'Attempted hijack', false,
        { userId: otherUserId }
      );

      assert.strictEqual(result.success, false);

      // Clean up
      approval.handleApprovalResponse(executionId, false, 'cleanup', false, { userId });
      await approvalPromise;
    });
  });

  // ===========================================================================
  // Session approval with security context
  // ===========================================================================
  describe('Session approval grant', () => {
    it('should grant session approval when rememberForSession=true', async () => {
      let params  = { command: 'ls' };
      let context = { userId, sessionId };

      let approvalPromise = approval.requestApproval(testAbility, params, context);

      let pending     = approval.getPendingApprovals(userId);
      let executionId = pending[0].execution_id;

      approval.handleApprovalResponse(
        executionId, true, null, true,
        { userId }
      );

      await approvalPromise;

      // Verify session approval was granted
      assert.ok(approval.hasSessionApproval(sessionId, testAbility.name));
    });

    it('should not grant session approval on denial', async () => {
      let params  = { command: 'ls' };
      let context = { userId, sessionId };

      let approvalPromise = approval.requestApproval(testAbility, params, context);

      let pending     = approval.getPendingApprovals(userId);
      let executionId = pending[0].execution_id;

      approval.handleApprovalResponse(
        executionId, false, 'denied', true,
        { userId }
      );

      await approvalPromise;

      assert.ok(!approval.hasSessionApproval(sessionId, testAbility.name));
    });
  });
});
