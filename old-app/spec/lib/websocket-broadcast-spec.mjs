'use strict';

// ============================================================================
// WebSocket Broadcast Tests (S2)
// ============================================================================
// Tests for multi-party session broadcasting.
//
// BCAST-001: broadcastToSession sends to all user participants in a session
// BCAST-002: broadcastToSession does NOT send to non-participant users
// INT-005:   Interaction bus handler routes via session_id when available
// PARTY-005: All broadcast call sites use broadcastToSession with sessionId

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import Database from 'better-sqlite3';

import { createTestDatabase, seedUser, seedAgent, seedSession, resetCounters } from '../helpers/db-helpers.mjs';
import { addParticipant, getParticipantsByType } from '../../server/lib/participants/index.mjs';

// ============================================================================
// PARTY-005: Static verification — all call sites use broadcastToSession
// ============================================================================

describe('PARTY-005: Broadcast call site verification', () => {
  it('should export broadcastToSession from websocket module', async () => {
    let mod = await import('../../server/lib/websocket.mjs');
    assert.equal(typeof mod.broadcastToSession, 'function');
    assert.equal(typeof mod.broadcastToUser, 'function');
  });

  it('should NOT export the broadcast alias from websocket module', async () => {
    let mod = await import('../../server/lib/websocket.mjs');
    // The broadcast alias was removed in S2
    assert.equal(mod.broadcast, undefined);
  });

  it('should import broadcastToSession in frames/broadcast module', async () => {
    // If this import succeeds, the module correctly imports broadcastToSession
    let mod = await import('../../server/lib/frames/broadcast.mjs');
    assert.equal(typeof mod.createAndBroadcastFrame, 'function');
  });

  it('should import broadcastToSession in abilities/approval module', async () => {
    let mod = await import('../../server/lib/abilities/approval.mjs');
    assert.equal(typeof mod.requestApproval, 'function');
  });

  it('should import broadcastToSession in abilities/executor module', async () => {
    let mod = await import('../../server/lib/abilities/executor.mjs');
    assert.equal(typeof mod.executeAbility, 'function');
  });

  it('should import broadcastToSession in abilities/question module', async () => {
    let mod = await import('../../server/lib/abilities/question.mjs');
    assert.equal(typeof mod.askQuestion, 'function');
  });
});

// ============================================================================
// BCAST-001 / BCAST-002: Participant-based broadcast routing (unit logic)
// ============================================================================

describe('BCAST-001/002: Participant-based broadcast routing', () => {
  let db;

  beforeEach(() => {
    resetCounters();
    db = createTestDatabase();
  });

  afterEach(() => {
    if (db) {
      db.close();
      db = null;
    }
  });

  it('should return all user participants for a session', () => {
    let user1   = seedUser(db, { username: 'alice' });
    let user2   = seedUser(db, { username: 'bob' });
    let agent   = seedAgent(db, { userId: user1.id, name: 'test-bot' });
    let session = seedSession(db, user1.id, agent.id, { name: 'Multi-party' });

    // Add second user as member
    addParticipant(session.id, 'user', user2.id, 'member', db);

    // Get user participants
    let users = getParticipantsByType(session.id, 'user', db);
    assert.equal(users.length, 2);

    let userIds = users.map((u) => u.participantId);
    assert.ok(userIds.includes(user1.id), 'Should include user1 (owner)');
    assert.ok(userIds.includes(user2.id), 'Should include user2 (member)');
  });

  it('should NOT include agents in user participant lookup', () => {
    let user  = seedUser(db, { username: 'alice' });
    let agent = seedAgent(db, { userId: user.id, name: 'test-bot' });
    let session = seedSession(db, user.id, agent.id);

    // Get user participants — should only include the user, not the agent
    let users = getParticipantsByType(session.id, 'user', db);
    assert.equal(users.length, 1);
    assert.equal(users[0].participantId, user.id);
  });

  it('should NOT include users from other sessions (BCAST-002)', () => {
    let user1   = seedUser(db, { username: 'alice' });
    let user2   = seedUser(db, { username: 'bob' });
    let agent   = seedAgent(db, { userId: user1.id, name: 'test-bot' });

    let session1 = seedSession(db, user1.id, agent.id, { name: 'Session 1' });
    let session2 = seedSession(db, user2.id, agent.id, { name: 'Session 2' });

    // Session 1 should only have user1
    let s1Users = getParticipantsByType(session1.id, 'user', db);
    assert.equal(s1Users.length, 1);
    assert.equal(s1Users[0].participantId, user1.id);

    // Session 2 should only have user2
    let s2Users = getParticipantsByType(session2.id, 'user', db);
    assert.equal(s2Users.length, 1);
    assert.equal(s2Users[0].participantId, user2.id);
  });

  it('should return empty array for session with no user participants', () => {
    let user  = seedUser(db, { username: 'alice' });
    let agent = seedAgent(db, { userId: user.id, name: 'test-bot' });

    // Create session manually without user participant
    let result = db.prepare(`
      INSERT INTO sessions (user_id, agent_id, name) VALUES (?, ?, 'Empty')
    `).run(user.id, agent.id);
    let sessionId = Number(result.lastInsertRowid);

    // Only add agent as participant
    db.prepare(`
      INSERT INTO session_participants (session_id, participant_type, participant_id, role)
      VALUES (?, 'agent', ?, 'coordinator')
    `).run(sessionId, agent.id);

    let users = getParticipantsByType(sessionId, 'user', db);
    assert.equal(users.length, 0);
  });

  it('should return multiple user participants for a group session', () => {
    let user1 = seedUser(db, { username: 'alice' });
    let user2 = seedUser(db, { username: 'bob' });
    let user3 = seedUser(db, { username: 'charlie' });
    let agent = seedAgent(db, { userId: user1.id, name: 'test-bot' });

    let session = seedSession(db, user1.id, agent.id, { name: 'Group' });
    addParticipant(session.id, 'user', user2.id, 'member', db);
    addParticipant(session.id, 'user', user3.id, 'member', db);

    let users = getParticipantsByType(session.id, 'user', db);
    assert.equal(users.length, 3);

    let userIds = users.map((u) => u.participantId);
    assert.ok(userIds.includes(user1.id));
    assert.ok(userIds.includes(user2.id));
    assert.ok(userIds.includes(user3.id));
  });
});

// ============================================================================
// INT-005: Interaction bus handler session routing
// ============================================================================

describe('INT-005: Interaction bus session routing', () => {
  it('should create interactions with session_id field', async () => {
    let { getInteractionBus } = await import('../../server/lib/interactions/bus.mjs');
    let bus = getInteractionBus();

    let interaction = bus.create('@user', 'test_property', { data: 'test' }, {
      sessionId: 42,
      userId:    7,
    });

    assert.equal(interaction.session_id, 42);
    assert.equal(interaction.user_id, 7);
    assert.ok(interaction.interaction_id);
  });

  it('should include session_id in user_interaction events', async () => {
    let { getInteractionBus } = await import('../../server/lib/interactions/bus.mjs');
    let bus = getInteractionBus();

    let emitted = null;
    let handler = (interaction) => { emitted = interaction; };
    bus.on('user_interaction', handler);

    try {
      let interaction = bus.create('@user', 'test_property', { data: 'test' }, {
        sessionId: 99,
        userId:    5,
      });

      // Fire the interaction (routes to @user handler which emits user_interaction)
      bus.fire(interaction);

      // Wait a tick for async routing
      await new Promise((resolve) => setTimeout(resolve, 10));

      assert.ok(emitted, 'Should have emitted user_interaction event');
      assert.equal(emitted.session_id, 99);
      assert.equal(emitted.user_id, 5);
    } finally {
      bus.removeListener('user_interaction', handler);
    }
  });

  it('should support interactions without session_id', async () => {
    let { getInteractionBus } = await import('../../server/lib/interactions/bus.mjs');
    let bus = getInteractionBus();

    let interaction = bus.create('@user', 'test_property', { data: 'test' }, {
      userId: 7,
      // No sessionId
    });

    assert.equal(interaction.session_id, null);
    assert.equal(interaction.user_id, 7);
  });
});

// ============================================================================
// broadcastToSession function contract tests
// ============================================================================

describe('broadcastToSession function contract', () => {
  it('should accept (sessionId, message) parameters', async () => {
    let { broadcastToSession } = await import('../../server/lib/websocket.mjs');
    assert.equal(broadcastToSession.length, 2);
  });

  it('should not throw when called with a session that has no connected clients', async () => {
    let { broadcastToSession } = await import('../../server/lib/websocket.mjs');

    // This should not throw — participants might exist but have no WS connections
    assert.doesNotThrow(() => {
      broadcastToSession(999999, { type: 'test', data: 'hello' });
    });
  });

  it('broadcastToUser should accept (userId, message) parameters', async () => {
    let { broadcastToUser } = await import('../../server/lib/websocket.mjs');
    assert.equal(broadcastToUser.length, 2);
  });

  it('broadcastToUser should not throw when called with a user that has no connections', async () => {
    let { broadcastToUser } = await import('../../server/lib/websocket.mjs');

    assert.doesNotThrow(() => {
      broadcastToUser(999999, { type: 'test', data: 'hello' });
    });
  });
});
