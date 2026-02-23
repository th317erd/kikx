'use strict';

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ============================================================================
// Environment Setup (must happen before any app module imports)
// ============================================================================

let testDir = mkdtempSync(join(tmpdir(), 'hero-coordination-test-'));

process.env.HERO_JWT_SECRET     = 'test-secret-key-for-testing';
process.env.HERO_ENCRYPTION_KEY = 'test-encryption-key-32chars!!';
process.env.XDG_CONFIG_HOME     = testDir;

// Dynamic imports after env is configured
let database;
let auth;
let participants;
let permissions;
let DelegateFunction;
let ExecuteCommandFunction;
let MAX_DELEGATION_DEPTH;

async function loadModules() {
  database     = await import('../../server/database.mjs');
  auth         = await import('../../server/auth.mjs');
  participants = await import('../../server/lib/participants/index.mjs');
  permissions  = await import('../../server/lib/permissions/index.mjs');

  let delegateModule         = await import('../../server/lib/interactions/functions/delegate.mjs');
  DelegateFunction           = delegateModule.DelegateFunction;
  MAX_DELEGATION_DEPTH       = delegateModule.MAX_DELEGATION_DEPTH;

  let execCommandModule      = await import('../../server/lib/interactions/functions/execute-command.mjs');
  ExecuteCommandFunction     = execCommandModule.ExecuteCommandFunction;
}

describe('Agent Coordination Integration', async () => {
  await loadModules();

  let db;
  let userId;
  let coordinatorAgentId;
  let memberAgent1Id;
  let memberAgent2Id;
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
    userId   = user.id;

    // Create agents
    let agent1 = db.prepare(`
      INSERT INTO agents (user_id, name, type, encrypted_api_key)
      VALUES (?, 'test-coordinator', 'claude', 'fake-key')
    `).run(userId);
    coordinatorAgentId = Number(agent1.lastInsertRowid);

    let agent2 = db.prepare(`
      INSERT INTO agents (user_id, name, type, encrypted_api_key)
      VALUES (?, 'test-researcher', 'claude', 'fake-key')
    `).run(userId);
    memberAgent1Id = Number(agent2.lastInsertRowid);

    let agent3 = db.prepare(`
      INSERT INTO agents (user_id, name, type, encrypted_api_key)
      VALUES (?, 'test-coder', 'claude', 'fake-key')
    `).run(userId);
    memberAgent2Id = Number(agent3.lastInsertRowid);

    // Create session with participants
    let sessionResult = db.prepare(`
      INSERT INTO sessions (user_id, agent_id, name)
      VALUES (?, ?, 'Multi-Agent Session')
    `).run(userId, coordinatorAgentId);
    sessionId = Number(sessionResult.lastInsertRowid);

    participants.addParticipant(sessionId, 'user', userId, 'owner', db);
    participants.addParticipant(sessionId, 'agent', coordinatorAgentId, 'coordinator', db);
    participants.addParticipant(sessionId, 'agent', memberAgent1Id, 'member', db);
    participants.addParticipant(sessionId, 'agent', memberAgent2Id, 'member', db);
  });

  describe('Role assignment', () => {
    it('should have correct roles for all participants', () => {
      let allParticipants = participants.getSessionParticipants(sessionId, db);
      assert.strictEqual(allParticipants.length, 4);

      let owner = allParticipants.find((p) => p.role === 'owner');
      assert.ok(owner);
      assert.strictEqual(owner.participantType, 'user');
      assert.strictEqual(owner.participantId, userId);

      let coordinator = allParticipants.find((p) => p.role === 'coordinator');
      assert.ok(coordinator);
      assert.strictEqual(coordinator.participantType, 'agent');
      assert.strictEqual(coordinator.participantId, coordinatorAgentId);

      let members = allParticipants.filter((p) => p.role === 'member');
      assert.strictEqual(members.length, 2);
    });

    it('should identify coordinator correctly', () => {
      let coordinator = participants.getCoordinator(sessionId, db);
      assert.ok(coordinator);
      assert.strictEqual(coordinator.participantId, coordinatorAgentId);
      assert.strictEqual(coordinator.role, 'coordinator');
    });

    it('should list all coordinators', () => {
      let coordinators = participants.getCoordinators(sessionId, db);
      assert.strictEqual(coordinators.length, 1);
      assert.strictEqual(coordinators[0].participantId, coordinatorAgentId);
    });

    it('should support multiple coordinators', () => {
      // Promote member to coordinator
      participants.updateParticipantRole(
        sessionId, 'agent', memberAgent1Id, 'coordinator', db,
      );

      let coordinators = participants.getCoordinators(sessionId, db);
      assert.strictEqual(coordinators.length, 2);
    });

    it('should allow role changes', () => {
      let updated = participants.updateParticipantRole(
        sessionId, 'agent', memberAgent1Id, 'coordinator', db,
      );
      assert.strictEqual(updated, true);

      let participant = participants.getParticipantsByRole(sessionId, 'coordinator', db);
      assert.strictEqual(participant.length, 2);
    });
  });

  describe('Delegation validation', () => {
    it('should only allow delegation to session members', async () => {
      // Create a non-participant agent
      let outsider = db.prepare(`
        INSERT INTO agents (user_id, name, type, encrypted_api_key)
        VALUES (?, 'test-outsider', 'claude', 'fake-key')
      `).run(userId);
      let outsiderId = Number(outsider.lastInsertRowid);

      let func = new DelegateFunction({
        sessionId,
        userId,
        agentId: coordinatorAgentId,
        db,
      });

      let result = await func.execute({
        agentId: outsiderId,
        task:    'Something',
      });

      assert.strictEqual(result.status, 'failed');
      assert.ok(result.error.includes('not a participant'));
    });

    it('should prevent self-delegation', async () => {
      let func = new DelegateFunction({
        sessionId,
        userId,
        agentId: coordinatorAgentId,
        db,
      });

      let result = await func.execute({
        agentId: coordinatorAgentId,
        task:    'Self reference',
      });

      assert.strictEqual(result.status, 'failed');
      assert.ok(result.error.includes('cannot delegate to itself'));
    });
  });

  describe('Permission gating for agent commands', () => {
    it('should allow agent to execute commands with explicit allow', async () => {
      permissions.createRule({
        ownerId:      userId,
        subjectType:  permissions.SubjectType.AGENT,
        subjectId:    coordinatorAgentId,
        resourceType: permissions.ResourceType.COMMAND,
        resourceName: 'help',
        action:       permissions.Action.ALLOW,
      }, db);

      let func = new ExecuteCommandFunction({
        sessionId,
        userId,
        agentId: coordinatorAgentId,
        db,
      });

      let result = await func.execute({ command: 'help' });
      assert.strictEqual(result.status, 'completed');
    });

    it('should deny agent from executing blocked commands', async () => {
      permissions.createRule({
        ownerId:      userId,
        subjectType:  permissions.SubjectType.AGENT,
        subjectId:    coordinatorAgentId,
        resourceType: permissions.ResourceType.COMMAND,
        resourceName: 'help',
        action:       permissions.Action.DENY,
      }, db);

      let func = new ExecuteCommandFunction({
        sessionId,
        userId,
        agentId: coordinatorAgentId,
        db,
      });

      let result = await func.execute({ command: 'help' });
      assert.strictEqual(result.status, 'failed');
      assert.ok(result.error.includes('Permission denied'));
    });

    it('should have different permission rules per agent', async () => {
      // Allow coordinator to execute help
      permissions.createRule({
        ownerId:      userId,
        subjectType:  permissions.SubjectType.AGENT,
        subjectId:    coordinatorAgentId,
        resourceType: permissions.ResourceType.COMMAND,
        resourceName: 'help',
        action:       permissions.Action.ALLOW,
      }, db);

      // Deny member from executing help
      permissions.createRule({
        ownerId:      userId,
        subjectType:  permissions.SubjectType.AGENT,
        subjectId:    memberAgent1Id,
        resourceType: permissions.ResourceType.COMMAND,
        resourceName: 'help',
        action:       permissions.Action.DENY,
      }, db);

      // Coordinator should succeed
      let coordinatorFunc = new ExecuteCommandFunction({
        sessionId,
        userId,
        agentId: coordinatorAgentId,
        db,
      });
      let coordResult = await coordinatorFunc.execute({ command: 'help' });
      assert.strictEqual(coordResult.status, 'completed');

      // Member should be denied
      let memberFunc = new ExecuteCommandFunction({
        sessionId,
        userId,
        agentId: memberAgent1Id,
        db,
      });
      let memberResult = await memberFunc.execute({ command: 'help' });
      assert.strictEqual(memberResult.status, 'failed');
      assert.ok(memberResult.error.includes('Permission denied'));
    });
  });

  describe('Recursion depth tracking', () => {
    it('should enforce max delegation depth across chained delegations', async () => {
      // Simulate depth escalation
      for (let depth = 0; depth <= MAX_DELEGATION_DEPTH + 1; depth++) {
        let func = new DelegateFunction({
          sessionId,
          userId,
          agentId:         coordinatorAgentId,
          delegationDepth: depth,
          db,
        });

        let result = await func.execute({
          agentId: memberAgent1Id,
          task:    `Task at depth ${depth}`,
        });

        if (depth >= MAX_DELEGATION_DEPTH) {
          assert.strictEqual(result.status, 'failed');
          assert.ok(result.error.includes('Maximum delegation depth'));
        } else {
          // Should not be a depth error (might be API error from fake key)
          assert.notEqual(
            result.error?.includes('Maximum delegation depth'),
            true,
            `Depth ${depth} should not trigger depth limit`,
          );
        }
      }
    });
  });

  describe('Session participant queries', () => {
    it('should get participants by type', () => {
      let agents = participants.getParticipantsByType(sessionId, 'agent', db);
      assert.strictEqual(agents.length, 3);

      let users = participants.getParticipantsByType(sessionId, 'user', db);
      assert.strictEqual(users.length, 1);
    });

    it('should get participants by role', () => {
      let members = participants.getParticipantsByRole(sessionId, 'member', db);
      assert.strictEqual(members.length, 2);
    });

    it('should check participant membership', () => {
      assert.strictEqual(
        participants.isParticipant(sessionId, 'agent', coordinatorAgentId, db),
        true,
      );

      assert.strictEqual(
        participants.isParticipant(sessionId, 'agent', 99999, db),
        false,
      );
    });
  });
});
