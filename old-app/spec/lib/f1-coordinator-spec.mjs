'use strict';

/**
 * F1: Active Coordinator Model Tests
 *
 * Covers:
 * - PARTY-001: promoteCoordinator atomic swap
 * - PARTY-002: promoteCoordinator edge cases (not participant, already coordinator)
 * - PARTY-003: /promote command via name and ID
 * - PARTY-004: /participants shows aliases
 * - ALIAS-001: addParticipant with alias
 * - ALIAS-002: updateParticipantAlias
 * - ALIAS-003: /invite with as:<alias> syntax
 * - COORD-004: findAgentByName case-insensitive lookup
 * - RENDER-001: /kick accepts agent name
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ============================================================================
// Environment Setup (must happen before any app module imports)
// ============================================================================

let testDir = mkdtempSync(join(tmpdir(), 'hero-f1-coordinator-test-'));

process.env.HERO_JWT_SECRET     = 'test-secret-key-for-testing';
process.env.HERO_ENCRYPTION_KEY = 'test-encryption-key-32chars!!';
process.env.XDG_CONFIG_HOME     = testDir;

// Dynamic imports after env is configured
let commands;
let database;
let auth;
let participants;

async function loadModules() {
  database     = await import('../../server/database.mjs');
  auth         = await import('../../server/auth.mjs');
  participants = await import('../../server/lib/participants/index.mjs');
  commands     = await import('../../server/lib/commands/index.mjs');
}

describe('F1: Active Coordinator Model', async () => {
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
      VALUES (?, 'test-alpha', 'claude', 'fake-key')
    `).run(userId);
    agentId = Number(agent1Result.lastInsertRowid);

    let agent2Result = db.prepare(`
      INSERT INTO agents (user_id, name, type, encrypted_api_key)
      VALUES (?, 'test-beta', 'claude', 'fake-key')
    `).run(userId);
    agent2Id = Number(agent2Result.lastInsertRowid);

    let agent3Result = db.prepare(`
      INSERT INTO agents (user_id, name, type, encrypted_api_key)
      VALUES (?, 'Test-Gamma', 'claude', 'fake-key')
    `).run(userId);
    agent3Id = Number(agent3Result.lastInsertRowid);

    // Create session with participants
    let sessionResult = db.prepare(`
      INSERT INTO sessions (user_id, agent_id, name)
      VALUES (?, ?, 'Test Session')
    `).run(userId, agentId);
    sessionId = Number(sessionResult.lastInsertRowid);

    participants.addParticipant(sessionId, 'user', userId, 'owner', db);
    participants.addParticipant(sessionId, 'agent', agentId, 'coordinator', db);
    participants.addParticipant(sessionId, 'agent', agent2Id, 'member', db);
  });

  // ===========================================================================
  // PARTY-001: promoteCoordinator atomic swap
  // ===========================================================================

  describe('PARTY-001: promoteCoordinator', () => {
    it('should promote a member to coordinator', () => {
      let result = participants.promoteCoordinator(sessionId, agent2Id, db);

      assert.strictEqual(result.promoted, true);
      assert.strictEqual(result.previousCoordinatorId, agentId);
    });

    it('should demote previous coordinator to member', () => {
      participants.promoteCoordinator(sessionId, agent2Id, db);

      let old = db.prepare(`
        SELECT role FROM session_participants
        WHERE session_id = ? AND participant_type = 'agent' AND participant_id = ?
      `).get(sessionId, agentId);

      assert.strictEqual(old.role, 'member');
    });

    it('should set new agent as coordinator', () => {
      participants.promoteCoordinator(sessionId, agent2Id, db);

      let fresh = db.prepare(`
        SELECT role FROM session_participants
        WHERE session_id = ? AND participant_type = 'agent' AND participant_id = ?
      `).get(sessionId, agent2Id);

      assert.strictEqual(fresh.role, 'coordinator');
    });

    it('should return correct coordinator via getCoordinator after promote', () => {
      participants.promoteCoordinator(sessionId, agent2Id, db);

      let coordinator = participants.getCoordinator(sessionId, db);
      assert.strictEqual(coordinator.participantId, agent2Id);
      assert.strictEqual(coordinator.role, 'coordinator');
    });

    it('should handle promote when there is no current coordinator', () => {
      // Demote current coordinator manually
      db.prepare(`
        UPDATE session_participants SET role = 'member'
        WHERE session_id = ? AND participant_type = 'agent' AND role = 'coordinator'
      `).run(sessionId);

      let result = participants.promoteCoordinator(sessionId, agent2Id, db);

      assert.strictEqual(result.promoted, true);
      assert.strictEqual(result.previousCoordinatorId, null);

      let coordinator = participants.getCoordinator(sessionId, db);
      assert.strictEqual(coordinator.participantId, agent2Id);
    });
  });

  // ===========================================================================
  // PARTY-002: promoteCoordinator edge cases
  // ===========================================================================

  describe('PARTY-002: promoteCoordinator edge cases', () => {
    it('should fail if agent is not a participant', () => {
      let result = participants.promoteCoordinator(sessionId, agent3Id, db);

      assert.strictEqual(result.promoted, false);
      assert.ok(result.error.includes('not a participant'));
    });

    it('should fail if agent is already coordinator', () => {
      let result = participants.promoteCoordinator(sessionId, agentId, db);

      assert.strictEqual(result.promoted, false);
      assert.ok(result.error.includes('already the coordinator'));
    });
  });

  // ===========================================================================
  // PARTY-003: /promote command
  // ===========================================================================

  describe('PARTY-003: /promote command', () => {
    it('should be registered', () => {
      assert.ok(commands.getCommand('promote'));
    });

    it('should promote agent by name', async () => {
      let context = { sessionId, userId, db };
      let result  = await commands.executeCommand('promote', 'test-beta', context);

      assert.strictEqual(result.success, true);
      assert.ok(result.content.includes('test-beta'));
      assert.ok(result.content.includes('coordinator'));

      let coordinator = participants.getCoordinator(sessionId, db);
      assert.strictEqual(coordinator.participantId, agent2Id);
    });

    it('should promote agent by numeric ID', async () => {
      let context = { sessionId, userId, db };
      let result  = await commands.executeCommand('promote', String(agent2Id), context);

      assert.strictEqual(result.success, true);
      assert.ok(result.content.includes('test-beta'));
    });

    it('should show previous coordinator name', async () => {
      let context = { sessionId, userId, db };
      let result  = await commands.executeCommand('promote', 'test-beta', context);

      assert.ok(result.content.includes('test-alpha'));
    });

    it('should fail for unknown agent name', async () => {
      let context = { sessionId, userId, db };
      let result  = await commands.executeCommand('promote', 'nonexistent', context);

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('not found'));
    });

    it('should fail without args', async () => {
      let context = { sessionId, userId, db };
      let result  = await commands.executeCommand('promote', '', context);

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('Usage'));
    });

    it('should fail without session', async () => {
      let context = { userId, db };
      let result  = await commands.executeCommand('promote', 'test-beta', context);

      assert.strictEqual(result.success, false);
    });

    it('should fail for agent not in session', async () => {
      let context = { sessionId, userId, db };
      let result  = await commands.executeCommand('promote', 'Test-Gamma', context);

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('not a participant'));
    });
  });

  // ===========================================================================
  // ALIAS-001: addParticipant with alias
  // ===========================================================================

  describe('ALIAS-001: addParticipant with alias', () => {
    it('should store alias when adding participant', () => {
      let participant = participants.addParticipant(sessionId, 'agent', agent3Id, 'member', db, 'Reviewer');

      assert.strictEqual(participant.alias, 'Reviewer');
    });

    it('should return null alias when none provided', () => {
      let allParticipants = participants.getSessionParticipants(sessionId, db);
      let agent1 = allParticipants.find((p) => p.participantId === agentId);

      assert.strictEqual(agent1.alias, null);
    });

    it('should include alias in getSessionParticipants result', () => {
      participants.addParticipant(sessionId, 'agent', agent3Id, 'member', db, 'CodeBot');

      let allParticipants = participants.getSessionParticipants(sessionId, db);
      let agent3 = allParticipants.find((p) => p.participantId === agent3Id);

      assert.strictEqual(agent3.alias, 'CodeBot');
    });
  });

  // ===========================================================================
  // ALIAS-002: updateParticipantAlias
  // ===========================================================================

  describe('ALIAS-002: updateParticipantAlias', () => {
    it('should set alias on existing participant', () => {
      let updated = participants.updateParticipantAlias(sessionId, 'agent', agentId, 'LeadBot', db);

      assert.strictEqual(updated, true);

      let allParticipants = participants.getSessionParticipants(sessionId, db);
      let agent1 = allParticipants.find((p) => p.participantId === agentId);
      assert.strictEqual(agent1.alias, 'LeadBot');
    });

    it('should clear alias when set to null', () => {
      participants.updateParticipantAlias(sessionId, 'agent', agentId, 'TempAlias', db);
      participants.updateParticipantAlias(sessionId, 'agent', agentId, null, db);

      let allParticipants = participants.getSessionParticipants(sessionId, db);
      let agent1 = allParticipants.find((p) => p.participantId === agentId);
      assert.strictEqual(agent1.alias, null);
    });

    it('should return false for non-existent participant', () => {
      let updated = participants.updateParticipantAlias(sessionId, 'agent', 99999, 'Ghost', db);
      assert.strictEqual(updated, false);
    });
  });

  // ===========================================================================
  // ALIAS-003: /invite with as:<alias> syntax
  // ===========================================================================

  describe('ALIAS-003: /invite with alias', () => {
    it('should invite agent by name with alias', async () => {
      let context = { sessionId, userId, db };
      let result  = await commands.executeCommand('invite', 'Test-Gamma as:Reviewer', context);

      assert.strictEqual(result.success, true);
      assert.ok(result.content.includes('Test-Gamma'));
      assert.ok(result.content.includes('Reviewer'));

      // Verify alias stored
      let allParticipants = participants.getSessionParticipants(sessionId, db);
      let agent3 = allParticipants.find((p) => p.participantId === agent3Id);
      assert.strictEqual(agent3.alias, 'Reviewer');
    });

    it('should invite agent by name without alias', async () => {
      let context = { sessionId, userId, db };
      let result  = await commands.executeCommand('invite', 'Test-Gamma', context);

      assert.strictEqual(result.success, true);
      assert.ok(result.content.includes('Test-Gamma'));

      let allParticipants = participants.getSessionParticipants(sessionId, db);
      let agent3 = allParticipants.find((p) => p.participantId === agent3Id);
      assert.strictEqual(agent3.alias, null);
    });

    it('should invite agent by numeric ID with alias', async () => {
      let context = { sessionId, userId, db };
      let result  = await commands.executeCommand('invite', `${agent3Id} as:Helper`, context);

      assert.strictEqual(result.success, true);

      let allParticipants = participants.getSessionParticipants(sessionId, db);
      let agent3 = allParticipants.find((p) => p.participantId === agent3Id);
      assert.strictEqual(agent3.alias, 'Helper');
    });

    it('should fail for agent already in session', async () => {
      let context = { sessionId, userId, db };
      let result  = await commands.executeCommand('invite', 'test-alpha', context);

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('already a participant'));
    });

    it('should fail for unknown agent name', async () => {
      let context = { sessionId, userId, db };
      let result  = await commands.executeCommand('invite', 'nonexistent-agent', context);

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('not found'));
    });

    it('should fail with empty args', async () => {
      let context = { sessionId, userId, db };
      let result  = await commands.executeCommand('invite', '', context);

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('Usage'));
    });
  });

  // ===========================================================================
  // COORD-004: findAgentByName
  // ===========================================================================

  describe('COORD-004: findAgentByName', () => {
    it('should find agent by exact name', () => {
      let agent = participants.findAgentByName('test-alpha', userId, db);

      assert.ok(agent);
      assert.strictEqual(agent.id, agentId);
      assert.strictEqual(agent.name, 'test-alpha');
    });

    it('should find agent case-insensitively', () => {
      let agent = participants.findAgentByName('TEST-ALPHA', userId, db);

      assert.ok(agent);
      assert.strictEqual(agent.id, agentId);
    });

    it('should find agent with mixed case', () => {
      let agent = participants.findAgentByName('test-gamma', userId, db);

      assert.ok(agent);
      assert.strictEqual(agent.id, agent3Id);
      assert.strictEqual(agent.name, 'Test-Gamma');
    });

    it('should return null for unknown name', () => {
      let agent = participants.findAgentByName('nonexistent', userId, db);
      assert.strictEqual(agent, null);
    });

    it('should not find agents owned by other users', async () => {
      // Create another user
      let otherUser   = await auth.createUser('otheruser', 'otherpass');
      let otherUserId = otherUser.id;

      db.prepare(`
        INSERT INTO agents (user_id, name, type, encrypted_api_key)
        VALUES (?, 'other-agent', 'claude', 'fake')
      `).run(otherUserId);

      let agent = participants.findAgentByName('other-agent', userId, db);
      assert.strictEqual(agent, null);
    });
  });

  // ===========================================================================
  // PARTY-004: /participants shows aliases
  // ===========================================================================

  describe('PARTY-004: /participants shows aliases', () => {
    it('should show alias in participant list', async () => {
      // Add agent3 with alias
      participants.addParticipant(sessionId, 'agent', agent3Id, 'member', db, 'CodeBot');

      let context = { sessionId, userId, db };
      let result  = await commands.executeCommand('participants', '', context);

      assert.strictEqual(result.success, true);
      assert.ok(result.content.includes('CodeBot'), 'Should show alias in output');
      assert.ok(result.content.includes('Test-Gamma'), 'Should show agent name');
    });

    it('should not show alias tag for participants without alias', async () => {
      let context = { sessionId, userId, db };
      let result  = await commands.executeCommand('participants', '', context);

      assert.strictEqual(result.success, true);
      // "aka" only appears when there's an alias
      assert.ok(!result.content.includes('aka'), 'Should not show aka for participants without alias');
    });
  });

  // ===========================================================================
  // RENDER-001: /kick accepts agent name
  // ===========================================================================

  describe('RENDER-001: /kick accepts agent name', () => {
    it('should kick agent by name', async () => {
      let context = { sessionId, userId, db };
      let result  = await commands.executeCommand('kick', 'test-beta', context);

      assert.strictEqual(result.success, true);
      assert.ok(result.content.includes('test-beta'));
      assert.ok(result.content.includes('removed'));

      assert.strictEqual(
        participants.isParticipant(sessionId, 'agent', agent2Id, db),
        false
      );
    });

    it('should kick agent by numeric ID', async () => {
      let context = { sessionId, userId, db };
      let result  = await commands.executeCommand('kick', String(agent2Id), context);

      assert.strictEqual(result.success, true);
    });

    it('should fail for agent not in session', async () => {
      let context = { sessionId, userId, db };
      let result  = await commands.executeCommand('kick', 'Test-Gamma', context);

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('not a participant'));
    });

    it('should fail for unknown agent name', async () => {
      let context = { sessionId, userId, db };
      let result  = await commands.executeCommand('kick', 'nonexistent', context);

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('not found'));
    });
  });

  // ===========================================================================
  // createSessionWithParticipants assigns correct roles
  // ===========================================================================

  describe('createSessionWithParticipants role assignment', () => {
    it('should assign first agent as coordinator', () => {
      let session = participants.createSessionWithParticipants({
        userId,
        name:     'Multi-agent Session',
        agentIds: [agentId, agent2Id, agent3Id],
      }, db);

      let allParticipants = session.participants;
      let agents = allParticipants.filter((p) => p.participantType === 'agent');

      let coordinator = agents.find((p) => p.participantId === agentId);
      let member1     = agents.find((p) => p.participantId === agent2Id);
      let member2     = agents.find((p) => p.participantId === agent3Id);

      assert.strictEqual(coordinator.role, 'coordinator');
      assert.strictEqual(member1.role, 'member');
      assert.strictEqual(member2.role, 'member');
    });

    it('should assign user as owner', () => {
      let session = participants.createSessionWithParticipants({
        userId,
        name:     'Multi-agent Session',
        agentIds: [agentId],
      }, db);

      let owner = session.participants.find((p) => p.participantType === 'user');
      assert.strictEqual(owner.role, 'owner');
      assert.strictEqual(owner.participantId, userId);
    });
  });
});
