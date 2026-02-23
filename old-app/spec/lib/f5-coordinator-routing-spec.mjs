'use strict';

/**
 * F5: Active Coordinator Behavior — Routing Logic Tests
 *
 * Verifies:
 * - ROUTE-C01: loadSessionWithAgent returns coordinator agent
 * - ROUTE-C02: loadSessionWithAgent returns null agent when no coordinator
 * - ROUTE-C03: After promote, loadSessionWithAgent returns new coordinator
 * - ROUTE-C04: After kick coordinator, loadSessionWithAgent falls back to legacy
 * - ROUTE-C05: getCoordinator consistency
 * - ROUTE-C06: Members do NOT respond to unaddressed messages
 * - ROUTE-C07: Session with zero agents returns null agent
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ============================================================================
// Environment Setup
// ============================================================================

let testDir = mkdtempSync(join(tmpdir(), 'hero-f5-routing-test-'));

process.env.HERO_JWT_SECRET     = 'test-secret-key-for-testing';
process.env.HERO_ENCRYPTION_KEY = 'test-encryption-key-32chars!!';
process.env.XDG_CONFIG_HOME     = testDir;

let database;
let auth;
let participants;

async function loadModules() {
  database     = await import('../../server/database.mjs');
  auth         = await import('../../server/auth.mjs');
  participants = await import('../../server/lib/participants/index.mjs');
}

describe('F5: Active Coordinator Routing', async () => {
  await loadModules();

  let db;
  let userId;
  let agentId;
  let agent2Id;
  let agent3Id;
  let sessionId;

  beforeEach(async () => {
    db = database.getDatabase();

    // Clear test data
    db.exec('DELETE FROM frames');
    db.exec('DELETE FROM session_participants');
    db.exec('DELETE FROM sessions');
    db.exec('DELETE FROM agents');
    db.exec('DELETE FROM users');

    // Create test user
    let user = await auth.createUser('testuser', 'testpass');
    userId   = user.id;

    // Create test agents
    let agent1Result = db.prepare(`
      INSERT INTO agents (user_id, name, type, encrypted_api_key)
      VALUES (?, 'test-alpha', 'claude', 'enc-key-alpha')
    `).run(userId);
    agentId = Number(agent1Result.lastInsertRowid);

    let agent2Result = db.prepare(`
      INSERT INTO agents (user_id, name, type, encrypted_api_key)
      VALUES (?, 'test-beta', 'claude', 'enc-key-beta')
    `).run(userId);
    agent2Id = Number(agent2Result.lastInsertRowid);

    let agent3Result = db.prepare(`
      INSERT INTO agents (user_id, name, type, encrypted_api_key)
      VALUES (?, 'test-gamma', 'claude', 'enc-key-gamma')
    `).run(userId);
    agent3Id = Number(agent3Result.lastInsertRowid);

    // Create session: alpha = coordinator, beta = member
    let sessionResult = db.prepare(`
      INSERT INTO sessions (user_id, agent_id, name)
      VALUES (?, ?, 'Routing Test Session')
    `).run(userId, agentId);
    sessionId = Number(sessionResult.lastInsertRowid);

    participants.addParticipant(sessionId, 'user', userId, 'owner', db);
    participants.addParticipant(sessionId, 'agent', agentId, 'coordinator', db);
    participants.addParticipant(sessionId, 'agent', agent2Id, 'member', db);
  });

  // ===========================================================================
  // ROUTE-C01: loadSessionWithAgent returns coordinator
  // ===========================================================================

  describe('ROUTE-C01: loadSessionWithAgent returns coordinator', () => {
    it('should return coordinator agent details', () => {
      let session = participants.loadSessionWithAgent(sessionId, userId, db);

      assert.ok(session);
      assert.strictEqual(session.agent_id, agentId);
      assert.strictEqual(session.agent_name, 'test-alpha');
      assert.strictEqual(session.agent_type, 'claude');
    });

    it('should include encrypted API key from coordinator', () => {
      let session = participants.loadSessionWithAgent(sessionId, userId, db);

      assert.ok(session.encrypted_api_key);
      assert.strictEqual(session.encrypted_api_key, 'enc-key-alpha');
    });

    it('should NOT return member agent details', () => {
      let session = participants.loadSessionWithAgent(sessionId, userId, db);

      assert.notStrictEqual(session.agent_id, agent2Id);
      assert.strictEqual(session.agent_id, agentId);
    });
  });

  // ===========================================================================
  // ROUTE-C02: No coordinator returns null agent
  // ===========================================================================

  describe('ROUTE-C02: No coordinator agent', () => {
    it('should return null agent fields when coordinator removed and legacy cleared', () => {
      participants.removeParticipant(sessionId, 'agent', agentId, db);
      db.prepare('UPDATE sessions SET agent_id = NULL WHERE id = ?').run(sessionId);

      let session = participants.loadSessionWithAgent(sessionId, userId, db);

      assert.ok(session);
      assert.strictEqual(session.agent_id, null);
      assert.strictEqual(session.agent_name, null);
    });

    it('should fall back to legacy agent_id when no coordinator in participants', () => {
      participants.removeParticipant(sessionId, 'agent', agentId, db);

      // Legacy agent_id still set on sessions table
      let session = participants.loadSessionWithAgent(sessionId, userId, db);

      assert.ok(session);
      assert.strictEqual(session.agent_id, agentId);
      assert.strictEqual(session.agent_name, 'test-alpha');
    });
  });

  // ===========================================================================
  // ROUTE-C03: After promote, routing uses new coordinator
  // ===========================================================================

  describe('ROUTE-C03: Promote changes routing target', () => {
    it('should route to new coordinator after promote', () => {
      participants.promoteCoordinator(sessionId, agent2Id, db);

      let session = participants.loadSessionWithAgent(sessionId, userId, db);

      assert.strictEqual(session.agent_id, agent2Id);
      assert.strictEqual(session.agent_name, 'test-beta');
    });

    it('should return new coordinator API key after promote', () => {
      participants.promoteCoordinator(sessionId, agent2Id, db);

      let session = participants.loadSessionWithAgent(sessionId, userId, db);
      assert.strictEqual(session.encrypted_api_key, 'enc-key-beta');
    });

    it('should handle multiple promotes correctly', () => {
      participants.addParticipant(sessionId, 'agent', agent3Id, 'member', db);
      participants.promoteCoordinator(sessionId, agent2Id, db);
      participants.promoteCoordinator(sessionId, agent3Id, db);

      let session = participants.loadSessionWithAgent(sessionId, userId, db);
      assert.strictEqual(session.agent_id, agent3Id);
      assert.strictEqual(session.agent_name, 'test-gamma');

      let coordinators = participants.getCoordinators(sessionId, db);
      assert.strictEqual(coordinators.length, 1);
      assert.strictEqual(coordinators[0].participantId, agent3Id);
    });
  });

  // ===========================================================================
  // ROUTE-C04: Kick coordinator falls back
  // ===========================================================================

  describe('ROUTE-C04: Kick coordinator', () => {
    it('should fall back to legacy agent after coordinator kicked', () => {
      participants.removeParticipant(sessionId, 'agent', agentId, db);

      let session = participants.loadSessionWithAgent(sessionId, userId, db);
      assert.strictEqual(session.agent_id, agentId);
    });

    it('should return null agent after coordinator kicked and legacy cleared', () => {
      participants.removeParticipant(sessionId, 'agent', agentId, db);
      db.prepare('UPDATE sessions SET agent_id = NULL WHERE id = ?').run(sessionId);

      let session = participants.loadSessionWithAgent(sessionId, userId, db);
      assert.strictEqual(session.agent_id, null);
    });
  });

  // ===========================================================================
  // ROUTE-C05: getCoordinator consistency
  // ===========================================================================

  describe('ROUTE-C05: getCoordinator consistency', () => {
    it('should return single coordinator', () => {
      let coordinator = participants.getCoordinator(sessionId, db);

      assert.ok(coordinator);
      assert.strictEqual(coordinator.participantId, agentId);
      assert.strictEqual(coordinator.role, 'coordinator');
    });

    it('should return null when no coordinator exists', () => {
      db.prepare(`
        UPDATE session_participants SET role = 'member'
        WHERE session_id = ? AND role = 'coordinator'
      `).run(sessionId);

      let coordinator = participants.getCoordinator(sessionId, db);
      assert.strictEqual(coordinator, null);
    });

    it('should only return agent coordinators (not user owners)', () => {
      let coordinator = participants.getCoordinator(sessionId, db);
      assert.strictEqual(coordinator.participantType, 'agent');
    });
  });

  // ===========================================================================
  // ROUTE-C06: Members excluded from unaddressed routing
  // ===========================================================================

  describe('ROUTE-C06: Member agent exclusion', () => {
    it('should not return member agent from loadSessionWithAgent', () => {
      let session = participants.loadSessionWithAgent(sessionId, userId, db);

      assert.notStrictEqual(session.agent_id, agent2Id);
      assert.strictEqual(session.agent_id, agentId);
    });

    it('should list member in getSessionParticipants but not as route target', () => {
      let allParticipants = participants.getSessionParticipants(sessionId, db);
      let memberBeta = allParticipants.find((p) => p.participantId === agent2Id && p.participantType === 'agent');

      assert.ok(memberBeta, 'Member should be in participants list');
      assert.strictEqual(memberBeta.role, 'member');

      let session = participants.loadSessionWithAgent(sessionId, userId, db);
      assert.strictEqual(session.agent_id, agentId);
    });
  });

  // ===========================================================================
  // ROUTE-C07: Session with zero agents
  // ===========================================================================

  describe('ROUTE-C07: Session with zero agents', () => {
    it('should return null agent for session with no agent participants', () => {
      participants.removeParticipant(sessionId, 'agent', agentId, db);
      participants.removeParticipant(sessionId, 'agent', agent2Id, db);
      db.prepare('UPDATE sessions SET agent_id = NULL WHERE id = ?').run(sessionId);

      let session = participants.loadSessionWithAgent(sessionId, userId, db);

      assert.ok(session);
      assert.strictEqual(session.agent_id, null);
      assert.strictEqual(session.agent_name, null);
    });
  });

  // ===========================================================================
  // createSessionWithParticipants routing verification
  // ===========================================================================

  describe('createSessionWithParticipants routing', () => {
    it('should route to first agent (coordinator) via loadSessionWithAgent', () => {
      let created = participants.createSessionWithParticipants({
        userId,
        name:     'Multi-Agent Routing',
        agentIds: [agent3Id, agent2Id],
      }, db);

      let session = participants.loadSessionWithAgent(created.id, userId, db);

      assert.strictEqual(session.agent_id, agent3Id);
      assert.strictEqual(session.agent_name, 'test-gamma');
    });

    it('should not route to second agent (member)', () => {
      let created = participants.createSessionWithParticipants({
        userId,
        name:     'Multi-Agent Routing 2',
        agentIds: [agent3Id, agent2Id],
      }, db);

      let session = participants.loadSessionWithAgent(created.id, userId, db);

      assert.notStrictEqual(session.agent_id, agent2Id);
    });
  });
});
