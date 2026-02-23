'use strict';

// ============================================================================
// Session Participants Tests
// ============================================================================
// Tests for multi-party session participant management.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import {
  addParticipant,
  removeParticipant,
  getSessionParticipants,
  getParticipantsByRole,
  getParticipantsByType,
  getCoordinator,
  getCoordinators,
  updateParticipantRole,
  isParticipant,
  getParticipantSessions,
  loadSessionWithAgent,
  createSessionWithParticipants,
  ParticipantType,
  ParticipantRole,
} from '../../server/lib/participants/index.mjs';

// ============================================================================
// Test Database Setup
// ============================================================================

let db = null;

function createTestDatabase() {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL
    );

    CREATE TABLE agents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      type TEXT DEFAULT 'claude',
      api_url TEXT,
      avatar_url TEXT,
      encrypted_api_key TEXT,
      encrypted_config TEXT,
      default_processes TEXT DEFAULT '[]',
      default_abilities TEXT DEFAULT '[]'
    );

    CREATE TABLE sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      system_prompt TEXT,
      status TEXT DEFAULT NULL,
      parent_session_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE session_participants (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id       INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      participant_type TEXT NOT NULL,
      participant_id   INTEGER NOT NULL,
      role             TEXT DEFAULT 'member',
      alias            TEXT,
      joined_at        TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(session_id, participant_type, participant_id)
    );

    CREATE INDEX idx_session_participants_session ON session_participants(session_id);
    CREATE INDEX idx_session_participants_type ON session_participants(participant_type);
    CREATE INDEX idx_session_participants_role ON session_participants(role);
  `);

  // Seed test data
  db.prepare("INSERT INTO users (id, username) VALUES (1, 'alice')").run();
  db.prepare("INSERT INTO users (id, username) VALUES (2, 'bob')").run();
  db.prepare("INSERT INTO agents (id, user_id, name) VALUES (1, 1, 'agent-alpha')").run();
  db.prepare("INSERT INTO agents (id, user_id, name) VALUES (2, 1, 'agent-beta')").run();
  db.prepare("INSERT INTO agents (id, user_id, name) VALUES (3, 2, 'agent-gamma')").run();
  db.prepare("INSERT INTO sessions (id, user_id, agent_id, name) VALUES (1, 1, 1, 'Session One')").run();
  db.prepare("INSERT INTO sessions (id, user_id, agent_id, name) VALUES (2, 1, NULL, 'Session Two')").run();

  return db;
}

// ============================================================================
// Tests
// ============================================================================

describe('Session Participants', () => {
  beforeEach(() => {
    createTestDatabase();
  });

  afterEach(() => {
    if (db) {
      db.close();
      db = null;
    }
  });

  // --------------------------------------------------------------------------
  // Constants
  // --------------------------------------------------------------------------

  describe('ParticipantType', () => {
    it('should define user and agent types', () => {
      assert.equal(ParticipantType.USER, 'user');
      assert.equal(ParticipantType.AGENT, 'agent');
    });
  });

  describe('ParticipantRole', () => {
    it('should define owner, coordinator, and member roles', () => {
      assert.equal(ParticipantRole.OWNER, 'owner');
      assert.equal(ParticipantRole.COORDINATOR, 'coordinator');
      assert.equal(ParticipantRole.MEMBER, 'member');
    });
  });

  // --------------------------------------------------------------------------
  // addParticipant
  // --------------------------------------------------------------------------

  describe('addParticipant', () => {
    it('should add a user participant with default member role', () => {
      let participant = addParticipant(1, 'user', 1, undefined, db);
      assert.equal(participant.sessionId, 1);
      assert.equal(participant.participantType, 'user');
      assert.equal(participant.participantId, 1);
      assert.equal(participant.role, 'member');
      assert.ok(participant.id);
      assert.ok(participant.joinedAt);
    });

    it('should add an agent participant with coordinator role', () => {
      let participant = addParticipant(1, 'agent', 1, 'coordinator', db);
      assert.equal(participant.participantType, 'agent');
      assert.equal(participant.participantId, 1);
      assert.equal(participant.role, 'coordinator');
    });

    it('should add an agent participant with owner role', () => {
      let participant = addParticipant(1, 'user', 1, 'owner', db);
      assert.equal(participant.role, 'owner');
    });

    it('should reject duplicate participant', () => {
      addParticipant(1, 'user', 1, 'member', db);
      assert.throws(() => {
        addParticipant(1, 'user', 1, 'member', db);
      });
    });

    it('should allow same participant in different sessions', () => {
      let p1 = addParticipant(1, 'user', 1, 'member', db);
      let p2 = addParticipant(2, 'user', 1, 'member', db);
      assert.notEqual(p1.id, p2.id);
    });

    it('should allow different participant types with same ID in same session', () => {
      let p1 = addParticipant(1, 'user', 1, 'owner', db);
      let p2 = addParticipant(1, 'agent', 1, 'coordinator', db);
      assert.notEqual(p1.id, p2.id);
    });

    it('should add multiple agents to the same session', () => {
      addParticipant(1, 'agent', 1, 'coordinator', db);
      addParticipant(1, 'agent', 2, 'member', db);
      let participants = getSessionParticipants(1, db);
      let agents = participants.filter((p) => p.participantType === 'agent');
      assert.equal(agents.length, 2);
    });
  });

  // --------------------------------------------------------------------------
  // removeParticipant
  // --------------------------------------------------------------------------

  describe('removeParticipant', () => {
    it('should remove a participant and return true', () => {
      addParticipant(1, 'user', 1, 'member', db);
      let removed = removeParticipant(1, 'user', 1, db);
      assert.equal(removed, true);
      assert.equal(isParticipant(1, 'user', 1, db), false);
    });

    it('should return false when participant does not exist', () => {
      let removed = removeParticipant(1, 'user', 99, db);
      assert.equal(removed, false);
    });

    it('should not affect other participants', () => {
      addParticipant(1, 'user', 1, 'owner', db);
      addParticipant(1, 'agent', 1, 'coordinator', db);
      removeParticipant(1, 'user', 1, db);
      assert.equal(isParticipant(1, 'agent', 1, db), true);
    });
  });

  // --------------------------------------------------------------------------
  // getSessionParticipants
  // --------------------------------------------------------------------------

  describe('getSessionParticipants', () => {
    it('should return empty array for session with no participants', () => {
      let participants = getSessionParticipants(1, db);
      assert.deepEqual(participants, []);
    });

    it('should return all participants for a session', () => {
      addParticipant(1, 'user', 1, 'owner', db);
      addParticipant(1, 'agent', 1, 'coordinator', db);
      addParticipant(1, 'agent', 2, 'member', db);

      let participants = getSessionParticipants(1, db);
      assert.equal(participants.length, 3);
    });

    it('should not return participants from other sessions', () => {
      addParticipant(1, 'user', 1, 'owner', db);
      addParticipant(2, 'user', 2, 'owner', db);

      let participants = getSessionParticipants(1, db);
      assert.equal(participants.length, 1);
      assert.equal(participants[0].participantId, 1);
    });

    it('should return participants with correct shape', () => {
      addParticipant(1, 'user', 1, 'owner', db);
      let participants = getSessionParticipants(1, db);
      let participant = participants[0];

      assert.ok(participant.id);
      assert.equal(participant.sessionId, 1);
      assert.equal(participant.participantType, 'user');
      assert.equal(participant.participantId, 1);
      assert.equal(participant.role, 'owner');
      assert.ok(participant.joinedAt);
    });
  });

  // --------------------------------------------------------------------------
  // getParticipantsByRole
  // --------------------------------------------------------------------------

  describe('getParticipantsByRole', () => {
    it('should return only participants with the specified role', () => {
      addParticipant(1, 'user', 1, 'owner', db);
      addParticipant(1, 'agent', 1, 'coordinator', db);
      addParticipant(1, 'agent', 2, 'member', db);

      let coordinators = getParticipantsByRole(1, 'coordinator', db);
      assert.equal(coordinators.length, 1);
      assert.equal(coordinators[0].participantType, 'agent');
      assert.equal(coordinators[0].participantId, 1);
    });

    it('should return empty array when no participants have the role', () => {
      addParticipant(1, 'user', 1, 'member', db);
      let coordinators = getParticipantsByRole(1, 'coordinator', db);
      assert.deepEqual(coordinators, []);
    });

    it('should return multiple participants with same role', () => {
      addParticipant(1, 'agent', 1, 'coordinator', db);
      addParticipant(1, 'agent', 2, 'coordinator', db);
      let coordinators = getParticipantsByRole(1, 'coordinator', db);
      assert.equal(coordinators.length, 2);
    });
  });

  // --------------------------------------------------------------------------
  // getParticipantsByType
  // --------------------------------------------------------------------------

  describe('getParticipantsByType', () => {
    it('should return only agents', () => {
      addParticipant(1, 'user', 1, 'owner', db);
      addParticipant(1, 'agent', 1, 'coordinator', db);
      addParticipant(1, 'agent', 2, 'member', db);

      let agents = getParticipantsByType(1, 'agent', db);
      assert.equal(agents.length, 2);
    });

    it('should return only users', () => {
      addParticipant(1, 'user', 1, 'owner', db);
      addParticipant(1, 'user', 2, 'member', db);
      addParticipant(1, 'agent', 1, 'coordinator', db);

      let users = getParticipantsByType(1, 'user', db);
      assert.equal(users.length, 2);
    });
  });

  // --------------------------------------------------------------------------
  // getCoordinator / getCoordinators
  // --------------------------------------------------------------------------

  describe('getCoordinator', () => {
    it('should return the coordinator agent', () => {
      addParticipant(1, 'user', 1, 'owner', db);
      addParticipant(1, 'agent', 1, 'coordinator', db);
      addParticipant(1, 'agent', 2, 'member', db);

      let coordinator = getCoordinator(1, db);
      assert.equal(coordinator.participantType, 'agent');
      assert.equal(coordinator.participantId, 1);
      assert.equal(coordinator.role, 'coordinator');
    });

    it('should return null when no coordinator exists', () => {
      addParticipant(1, 'user', 1, 'owner', db);
      addParticipant(1, 'agent', 1, 'member', db);

      let coordinator = getCoordinator(1, db);
      assert.equal(coordinator, null);
    });

    it('should return first coordinator when multiple exist', () => {
      addParticipant(1, 'agent', 1, 'coordinator', db);
      addParticipant(1, 'agent', 2, 'coordinator', db);

      let coordinator = getCoordinator(1, db);
      assert.ok(coordinator);
      assert.equal(coordinator.role, 'coordinator');
    });
  });

  describe('getCoordinators', () => {
    it('should return all coordinators', () => {
      addParticipant(1, 'agent', 1, 'coordinator', db);
      addParticipant(1, 'agent', 2, 'coordinator', db);
      addParticipant(1, 'agent', 3, 'member', db);

      let coordinators = getCoordinators(1, db);
      assert.equal(coordinators.length, 2);
    });

    it('should return only agent coordinators', () => {
      addParticipant(1, 'user', 1, 'coordinator', db);
      addParticipant(1, 'agent', 1, 'coordinator', db);

      let coordinators = getCoordinators(1, db);
      assert.equal(coordinators.length, 1);
      assert.equal(coordinators[0].participantType, 'agent');
    });
  });

  // --------------------------------------------------------------------------
  // updateParticipantRole
  // --------------------------------------------------------------------------

  describe('updateParticipantRole', () => {
    it('should update the role of a participant', () => {
      addParticipant(1, 'agent', 1, 'member', db);
      let updated = updateParticipantRole(1, 'agent', 1, 'coordinator', db);
      assert.equal(updated, true);

      let coordinator = getCoordinator(1, db);
      assert.equal(coordinator.participantId, 1);
    });

    it('should return false when participant does not exist', () => {
      let updated = updateParticipantRole(1, 'agent', 99, 'coordinator', db);
      assert.equal(updated, false);
    });
  });

  // --------------------------------------------------------------------------
  // isParticipant
  // --------------------------------------------------------------------------

  describe('isParticipant', () => {
    it('should return true when participant exists', () => {
      addParticipant(1, 'user', 1, 'owner', db);
      assert.equal(isParticipant(1, 'user', 1, db), true);
    });

    it('should return false when participant does not exist', () => {
      assert.equal(isParticipant(1, 'user', 99, db), false);
    });

    it('should distinguish between participant types', () => {
      addParticipant(1, 'agent', 1, 'coordinator', db);
      assert.equal(isParticipant(1, 'agent', 1, db), true);
      assert.equal(isParticipant(1, 'user', 1, db), false);
    });
  });

  // --------------------------------------------------------------------------
  // getParticipantSessions
  // --------------------------------------------------------------------------

  describe('getParticipantSessions', () => {
    it('should return session IDs where participant is a member', () => {
      addParticipant(1, 'user', 1, 'owner', db);
      addParticipant(2, 'user', 1, 'member', db);

      let sessionIds = getParticipantSessions('user', 1, db);
      assert.deepEqual(sessionIds.sort(), [1, 2]);
    });

    it('should return empty array for non-participant', () => {
      let sessionIds = getParticipantSessions('user', 99, db);
      assert.deepEqual(sessionIds, []);
    });

    it('should only return sessions for specified type', () => {
      addParticipant(1, 'user', 1, 'owner', db);
      addParticipant(2, 'agent', 1, 'coordinator', db);

      let userSessions = getParticipantSessions('user', 1, db);
      assert.deepEqual(userSessions, [1]);
    });
  });

  // --------------------------------------------------------------------------
  // Cascade behavior
  // --------------------------------------------------------------------------

  describe('cascade on session delete', () => {
    it('should delete participants when session is deleted', () => {
      addParticipant(1, 'user', 1, 'owner', db);
      addParticipant(1, 'agent', 1, 'coordinator', db);

      db.prepare('DELETE FROM sessions WHERE id = 1').run();

      let participants = getSessionParticipants(1, db);
      assert.deepEqual(participants, []);
    });
  });

  // --------------------------------------------------------------------------
  // loadSessionWithAgent
  // --------------------------------------------------------------------------

  describe('loadSessionWithAgent', () => {
    it('should load session with coordinator agent info from participants', () => {
      addParticipant(1, 'user', 1, 'owner', db);
      addParticipant(1, 'agent', 1, 'coordinator', db);

      let session = loadSessionWithAgent(1, 1, db);
      assert.equal(session.id, 1);
      assert.equal(session.agent_id, 1);
      assert.equal(session.agent_name, 'agent-alpha');
      assert.equal(session.session_name, 'Session One');
    });

    it('should fall back to legacy agent_id when no participants exist', () => {
      // Session 1 has agent_id=1 but no participants added
      let session = loadSessionWithAgent(1, 1, db);
      assert.equal(session.id, 1);
      assert.equal(session.agent_id, 1);
      assert.equal(session.agent_name, 'agent-alpha');
    });

    it('should return null for non-existent session', () => {
      let session = loadSessionWithAgent(999, 1, db);
      assert.equal(session, null);
    });

    it('should return null for session owned by different user', () => {
      let session = loadSessionWithAgent(1, 2, db);
      assert.equal(session, null);
    });

    it('should return session with null agent when session has no agent', () => {
      // Session 2 has agent_id=NULL
      let session = loadSessionWithAgent(2, 1, db);
      assert.equal(session.id, 2);
      assert.equal(session.agent_id, null);
    });

    it('should prefer coordinator over legacy agent_id', () => {
      // Session 1 has agent_id=1, but let's set coordinator to agent 2
      addParticipant(1, 'agent', 2, 'coordinator', db);
      // No coordinator for agent 1
      addParticipant(1, 'agent', 1, 'member', db);

      let session = loadSessionWithAgent(1, 1, db);
      assert.equal(session.agent_id, 2);
      assert.equal(session.agent_name, 'agent-beta');
    });

    it('should include encrypted fields for agent setup', () => {
      addParticipant(1, 'user', 1, 'owner', db);
      addParticipant(1, 'agent', 1, 'coordinator', db);

      let session = loadSessionWithAgent(1, 1, db);
      assert.ok('encrypted_api_key' in session);
      assert.ok('encrypted_config' in session);
      assert.ok('default_processes' in session);
      assert.ok('system_prompt' in session);
    });
  });

  // --------------------------------------------------------------------------
  // createSessionWithParticipants
  // --------------------------------------------------------------------------

  describe('createSessionWithParticipants', () => {
    it('should create a session with single agent as coordinator', () => {
      let result = createSessionWithParticipants({
        userId:   1,
        name:     'New Session',
        agentIds: 1,
      }, db);

      assert.ok(result.id);
      assert.equal(result.name, 'New Session');

      // Check participants
      let participants = getSessionParticipants(result.id, db);
      assert.equal(participants.length, 2); // user + agent

      let owner = participants.find((p) => p.role === 'owner');
      assert.equal(owner.participantType, 'user');
      assert.equal(owner.participantId, 1);

      let coordinator = participants.find((p) => p.role === 'coordinator');
      assert.equal(coordinator.participantType, 'agent');
      assert.equal(coordinator.participantId, 1);
    });

    it('should create a session with multiple agents', () => {
      let result = createSessionWithParticipants({
        userId:   1,
        name:     'Multi-Agent Session',
        agentIds: [1, 2],
      }, db);

      let participants = getSessionParticipants(result.id, db);
      let agents = participants.filter((p) => p.participantType === 'agent');
      assert.equal(agents.length, 2);

      // First agent is coordinator
      let coordinator = agents.find((p) => p.role === 'coordinator');
      assert.equal(coordinator.participantId, 1);

      // Second agent is member
      let member = agents.find((p) => p.role === 'member');
      assert.equal(member.participantId, 2);
    });

    it('should populate legacy agent_id for backwards compatibility', () => {
      let result = createSessionWithParticipants({
        userId:   1,
        name:     'Compat Session',
        agentIds: [2],
      }, db);

      let session = db.prepare('SELECT agent_id FROM sessions WHERE id = ?').get(result.id);
      assert.equal(session.agent_id, 2);
    });

    it('should support optional fields', () => {
      let result = createSessionWithParticipants({
        userId:       1,
        name:         'Full Session',
        agentIds:     [1],
        systemPrompt: 'Be helpful',
        status:       'agent',
      }, db);

      assert.equal(result.systemPrompt, 'Be helpful');
      assert.equal(result.status, 'agent');
    });

    it('should return participants list', () => {
      let result = createSessionWithParticipants({
        userId:   1,
        name:     'With Participants',
        agentIds: [1, 2],
      }, db);

      assert.equal(result.participants.length, 3); // 1 user + 2 agents
    });
  });
});
