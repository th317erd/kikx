'use strict';

// ============================================================================
// Sessions API Tests
// ============================================================================
// Tests for the sessions REST API endpoints, including participant-based
// session management. Tests SQL operations directly using in-memory SQLite
// (no HTTP mocking), calling the same participant library functions the
// route handlers use.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import {
  addParticipant,
  removeParticipant,
  getSessionParticipants,
  getCoordinator,
  loadSessionWithAgent,
  createSessionWithParticipants,
  isParticipant,
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
      username TEXT UNIQUE NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE agents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'claude',
      api_url TEXT,
      avatar_url TEXT,
      encrypted_api_key TEXT,
      encrypted_config TEXT,
      default_processes TEXT DEFAULT '[]',
      default_abilities TEXT DEFAULT '[]',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
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

    CREATE TABLE frames (
      id TEXT PRIMARY KEY,
      session_id INTEGER NOT NULL,
      parent_id TEXT,
      target_ids TEXT,
      timestamp TEXT NOT NULL,
      type TEXT NOT NULL,
      author_type TEXT NOT NULL,
      author_id INTEGER,
      payload TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );

    CREATE INDEX idx_frames_session ON frames(session_id, timestamp);
  `);

  // Seed users
  db.prepare("INSERT INTO users (id, username) VALUES (1, 'alice')").run();
  db.prepare("INSERT INTO users (id, username) VALUES (2, 'bob')").run();

  // Seed agents for user 1
  db.prepare(`
    INSERT INTO agents (id, user_id, name, type, api_url, encrypted_api_key, encrypted_config, default_processes)
    VALUES (1, 1, 'AliceAgent', 'claude', 'https://api.anthropic.com', 'enc-key-1', '{"model":"claude-3"}', '["search"]')
  `).run();
  db.prepare(`
    INSERT INTO agents (id, user_id, name, type)
    VALUES (2, 1, 'AliceBeta', 'claude')
  `).run();
  db.prepare(`
    INSERT INTO agents (id, user_id, name, type)
    VALUES (3, 1, 'AliceGamma', 'openai')
  `).run();

  // Seed agent for user 2
  db.prepare(`
    INSERT INTO agents (id, user_id, name, type)
    VALUES (4, 2, 'BobAgent', 'claude')
  `).run();

  return db;
}

// ============================================================================
// Helper: insert a session directly (without participants)
// ============================================================================

function insertSession(fields) {
  let {
    userId,
    agentId = null,
    name,
    systemPrompt = null,
    status = null,
    parentSessionId = null,
    updatedAt = null,
  } = fields;

  let result;

  if (updatedAt) {
    result = db.prepare(`
      INSERT INTO sessions (user_id, agent_id, name, system_prompt, status, parent_session_id, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(userId, agentId, name, systemPrompt, status, parentSessionId, updatedAt);
  } else {
    result = db.prepare(`
      INSERT INTO sessions (user_id, agent_id, name, system_prompt, status, parent_session_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(userId, agentId, name, systemPrompt, status, parentSessionId);
  }

  return result.lastInsertRowid;
}

// ============================================================================
// Helper: insert a message frame directly
// ============================================================================

let frameCounter = 0;

function insertMessageFrame(sessionId, content, authorType = 'user', timestamp = null) {
  frameCounter++;
  let id = `msg-${frameCounter}`;
  let ts = timestamp || new Date(Date.now() + frameCounter).toISOString();
  let payload = JSON.stringify(content);

  db.prepare(`
    INSERT INTO frames (id, session_id, timestamp, type, author_type, payload)
    VALUES (?, ?, ?, 'message', ?, ?)
  `).run(id, sessionId, ts, authorType, payload);

  return id;
}

// ============================================================================
// Helper: simulate POST / create session (mirrors route handler logic)
// ============================================================================

function createSessionRoute(userId, body) {
  let { name, agentId, agentIds, systemPrompt, status, parentSessionId } = body;

  // Normalize to agentIds array (same as route handler)
  let resolvedAgentIds = agentIds || (agentId ? [agentId] : []);

  if (!name || resolvedAgentIds.length === 0)
    return { status: 400, body: { error: 'Name and at least one agentId are required' } };

  // Verify all agents exist and belong to user
  let agents = [];
  for (let id of resolvedAgentIds) {
    let agent = db.prepare('SELECT id, name, type FROM agents WHERE id = ? AND user_id = ?').get(id, userId);
    if (!agent)
      return { status: 404, body: { error: `Agent ${id} not found` } };
    agents.push(agent);
  }

  // Verify parent session exists if provided
  if (parentSessionId) {
    let parent = db.prepare('SELECT id FROM sessions WHERE id = ? AND user_id = ?').get(parentSessionId, userId);
    if (!parent)
      return { status: 404, body: { error: 'Parent session not found' } };
  }

  try {
    let session = createSessionWithParticipants({
      userId,
      name,
      agentIds: resolvedAgentIds,
      systemPrompt,
      status,
      parentSessionId,
    }, db);

    let primaryAgent = agents[0];

    return {
      status: 201,
      body: {
        id:              session.id,
        name:            name,
        systemPrompt:    systemPrompt || null,
        status:          status || null,
        parentSessionId: parentSessionId || null,
        depth:           0,
        archived:        status === 'archived',
        agent:           {
          id:   primaryAgent.id,
          name: primaryAgent.name,
          type: primaryAgent.type,
        },
        participants: session.participants.map((p) => ({
          id:              p.id,
          participantType: p.participantType,
          participantId:   p.participantId,
          role:            p.role,
        })),
        messageCount: 0,
      },
    };
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE')
      return { status: 409, body: { error: 'A session with this name already exists' } };

    return { status: 500, body: { error: 'Failed to create session' } };
  }
}

// ============================================================================
// Helper: simulate GET / list sessions (mirrors route handler logic)
// ============================================================================

function listSessions(userId, searchQuery = '') {
  let params = [userId];
  let whereClause = 's.user_id = ?';

  if (searchQuery) {
    whereClause += ` AND (
      s.name LIKE ?
      OR EXISTS (
        SELECT 1 FROM frames f
        WHERE f.session_id = s.id AND f.type = 'message' AND f.payload LIKE ?
      )
    )`;
    let searchPattern = `%${searchQuery}%`;
    params.push(searchPattern, searchPattern);
  }

  let sessions = db.prepare(`
    SELECT
      s.id,
      s.name,
      s.system_prompt,
      s.status,
      s.agent_id,
      s.parent_session_id,
      s.created_at,
      s.updated_at,
      (SELECT COUNT(*) FROM frames WHERE session_id = s.id AND type = 'message') as message_count,
      (SELECT payload FROM frames WHERE session_id = s.id AND type = 'message' ORDER BY timestamp DESC LIMIT 1) as last_message
    FROM sessions s
    WHERE ${whereClause}
    ORDER BY s.updated_at DESC
  `).all(...params);

  // Build hierarchy
  let rootSessions = [];
  let childSessions = new Map();

  for (let s of sessions) {
    if (s.parent_session_id) {
      if (!childSessions.has(s.parent_session_id))
        childSessions.set(s.parent_session_id, []);
      childSessions.get(s.parent_session_id).push(s);
    } else {
      rootSessions.push(s);
    }
  }

  let orderedSessions = [];

  function addWithChildren(session, depth = 0) {
    session._depth = depth;
    orderedSessions.push(session);

    let children = childSessions.get(session.id) || [];
    children.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));

    for (let child of children)
      addWithChildren(child, depth + 1);
  }

  for (let root of rootSessions)
    addWithChildren(root);

  return orderedSessions.map((s) => {
    let preview = '';
    if (s.last_message) {
      try {
        let content = JSON.parse(s.last_message);
        if (typeof content === 'string') {
          preview = content.substring(0, 100);
        } else if (Array.isArray(content)) {
          let textBlock = content.find((b) => b.type === 'text');
          if (textBlock)
            preview = textBlock.text.substring(0, 100);
        }
      } catch (e) {
        preview = '';
      }
    }

    // Load participants (same as route handler)
    let participants = getSessionParticipants(s.id, db);
    let coordinatorParticipant = participants.find((p) => p.participantType === 'agent' && p.role === 'coordinator');
    let agentInfo = null;

    if (coordinatorParticipant) {
      let agent = db.prepare('SELECT id, name, type FROM agents WHERE id = ?').get(coordinatorParticipant.participantId);
      if (agent)
        agentInfo = { id: agent.id, name: agent.name, type: agent.type };
    }

    // Fall back to legacy agent_id if no participants
    if (!agentInfo && s.agent_id) {
      let agent = db.prepare('SELECT id, name, type FROM agents WHERE id = ?').get(s.agent_id);
      if (agent)
        agentInfo = { id: agent.id, name: agent.name, type: agent.type };
    }

    return {
      id:              s.id,
      name:            s.name,
      systemPrompt:    s.system_prompt,
      status:          s.status,
      parentSessionId: s.parent_session_id,
      depth:           s._depth || 0,
      archived:        s.status === 'archived',
      agent:           agentInfo || { id: null, name: null, type: null },
      participants:    participants.map((p) => ({
        id:              p.id,
        participantType: p.participantType,
        participantId:   p.participantId,
        role:            p.role,
      })),
      messageCount: s.message_count,
      preview:      preview,
      createdAt:    s.created_at,
      updatedAt:    s.updated_at,
    };
  });
}

// ============================================================================
// Helper: simulate GET /:id get session (mirrors route handler logic)
// ============================================================================

function getSessionRoute(userId, sessionId) {
  let session = loadSessionWithAgent(sessionId, userId, db);

  if (!session)
    return { status: 404, body: { error: 'Session not found' } };

  // Get message frames
  let frames = db.prepare(`
    SELECT id, type, author_type, payload, timestamp
    FROM frames
    WHERE session_id = ? AND type = 'message'
    ORDER BY timestamp ASC
  `).all(sessionId);

  let messages = frames.map((f) => {
    let payload = JSON.parse(f.payload);
    let role = payload.role || ((f.author_type === 'agent') ? 'assistant' : 'user');
    return {
      id:        f.id,
      role:      role,
      content:   payload.content,
      hidden:    !!payload.hidden,
      type:      f.type,
      createdAt: f.timestamp,
      updatedAt: f.timestamp,
    };
  });

  // Load participants
  let participants = getSessionParticipants(session.id, db);

  return {
    status: 200,
    body: {
      id:              session.id,
      name:            session.session_name,
      systemPrompt:    session.system_prompt,
      status:          session.status,
      parentSessionId: session.parent_session_id,
      archived:        session.status === 'archived',
      agent:           {
        id:   session.agent_id,
        name: session.agent_name,
        type: session.agent_type,
      },
      participants: participants.map((p) => ({
        id:              p.id,
        participantType: p.participantType,
        participantId:   p.participantId,
        role:            p.role,
      })),
      cost: {
        inputTokens:  session.input_tokens || 0,
        outputTokens: session.output_tokens || 0,
      },
      messages:  messages,
      createdAt: session.created_at,
      updatedAt: session.updated_at,
    },
  };
}

// ============================================================================
// Helper: simulate POST /:id/participants (mirrors route handler logic)
// ============================================================================

function addParticipantRoute(userId, sessionId, body) {
  let { participantType, participantId, role } = body;

  if (!participantType || !participantId)
    return { status: 400, body: { error: 'participantType and participantId are required' } };

  let session = db.prepare('SELECT id FROM sessions WHERE id = ? AND user_id = ?').get(sessionId, userId);
  if (!session)
    return { status: 404, body: { error: 'Session not found' } };

  try {
    let participant = addParticipant(
      sessionId,
      participantType,
      participantId,
      role || 'member',
      db
    );

    return { status: 201, body: { participant } };
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE')
      return { status: 409, body: { error: 'Participant already exists in this session' } };

    return { status: 500, body: { error: 'Failed to add participant' } };
  }
}

// ============================================================================
// Helper: simulate DELETE /:id/participants/:type/:id (mirrors route handler)
// ============================================================================

function removeParticipantRoute(userId, sessionId, participantType, participantId) {
  let session = db.prepare('SELECT id FROM sessions WHERE id = ? AND user_id = ?').get(sessionId, userId);
  if (!session)
    return { status: 404, body: { error: 'Session not found' } };

  let removed = removeParticipant(sessionId, participantType, participantId, db);

  if (!removed)
    return { status: 404, body: { error: 'Participant not found' } };

  return { status: 200, body: { success: true } };
}

// ============================================================================
// Helper: simulate PUT /:id (mirrors route handler logic)
// ============================================================================

function updateSession(userId, sessionId, body) {
  let { name, systemPrompt, agentId } = body;

  let session = db.prepare('SELECT id FROM sessions WHERE id = ? AND user_id = ?').get(sessionId, userId);
  if (!session)
    return { status: 404, body: { error: 'Session not found' } };

  let updates = [];
  let values  = [];

  if (name !== undefined) {
    updates.push('name = ?');
    values.push(name);
  }

  if (systemPrompt !== undefined) {
    updates.push('system_prompt = ?');
    values.push(systemPrompt || null);
  }

  if (agentId !== undefined) {
    let agent = db.prepare('SELECT id FROM agents WHERE id = ? AND user_id = ?').get(agentId, userId);
    if (!agent)
      return { status: 404, body: { error: 'Agent not found' } };

    updates.push('agent_id = ?');
    values.push(agentId);
  }

  if (updates.length === 0)
    return { status: 400, body: { error: 'No fields to update' } };

  updates.push('updated_at = CURRENT_TIMESTAMP');
  values.push(sessionId);
  values.push(userId);

  db.prepare(`
    UPDATE sessions
    SET ${updates.join(', ')}
    WHERE id = ? AND user_id = ?
  `).run(...values);

  return { status: 200, body: { success: true } };
}

// ============================================================================
// Helper: simulate DELETE /:id (mirrors route handler logic)
// ============================================================================

function deleteSession(userId, sessionId) {
  let result = db.prepare('DELETE FROM sessions WHERE id = ? AND user_id = ?').run(sessionId, userId);

  if (result.changes === 0)
    return { status: 404, body: { error: 'Session not found' } };

  return { status: 200, body: { success: true } };
}

// ============================================================================
// Helper: simulate POST /:id/archive (mirrors route handler logic)
// ============================================================================

function archiveSession(userId, sessionId) {
  let session = db.prepare('SELECT id, status FROM sessions WHERE id = ? AND user_id = ?').get(sessionId, userId);
  if (!session)
    return { status: 404, body: { error: 'Session not found' } };

  db.prepare(`
    UPDATE sessions
    SET status = 'archived', updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND user_id = ?
  `).run(sessionId, userId);

  return { status: 200, body: { success: true, status: 'archived', archived: true } };
}

// ============================================================================
// Helper: simulate POST /:id/unarchive (mirrors route handler logic)
// ============================================================================

function unarchiveSession(userId, sessionId) {
  let session = db.prepare('SELECT id, status FROM sessions WHERE id = ? AND user_id = ?').get(sessionId, userId);
  if (!session)
    return { status: 404, body: { error: 'Session not found' } };

  db.prepare(`
    UPDATE sessions
    SET status = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND user_id = ?
  `).run(sessionId, userId);

  return { status: 200, body: { success: true, status: null, archived: false } };
}

// ============================================================================
// Helper: simulate PUT /:id/status (mirrors route handler logic)
// ============================================================================

function updateSessionStatus(userId, sessionId, status) {
  let session = db.prepare('SELECT id FROM sessions WHERE id = ? AND user_id = ?').get(sessionId, userId);
  if (!session)
    return { status: 404, body: { error: 'Session not found' } };

  db.prepare(`
    UPDATE sessions
    SET status = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND user_id = ?
  `).run(status || null, sessionId, userId);

  return { status: 200, body: { success: true, status: status || null } };
}

// ============================================================================
// Tests
// ============================================================================

describe('Sessions API (Database Operations)', () => {
  beforeEach(() => {
    frameCounter = 0;
    createTestDatabase();
  });

  afterEach(() => {
    if (db) {
      db.close();
      db = null;
    }
  });

  // ==========================================================================
  // Create Session with Participants (POST /)
  // ==========================================================================

  describe('Create Session with Participants (POST /)', () => {
    it('should create a session with agentIds array and multiple participants', () => {
      let response = createSessionRoute(1, {
        name:     'Multi-Agent Chat',
        agentIds: [1, 2],
      });

      assert.equal(response.status, 201);
      assert.equal(response.body.name, 'Multi-Agent Chat');
      assert.ok(response.body.id);

      // Should have 3 participants: 1 owner user + 2 agents
      assert.equal(response.body.participants.length, 3);

      let owner = response.body.participants.find((p) => p.role === 'owner');
      assert.equal(owner.participantType, 'user');
      assert.equal(owner.participantId, 1);

      let coordinator = response.body.participants.find((p) => p.role === 'coordinator');
      assert.equal(coordinator.participantType, 'agent');
      assert.equal(coordinator.participantId, 1);

      let member = response.body.participants.find((p) => p.role === 'member');
      assert.equal(member.participantType, 'agent');
      assert.equal(member.participantId, 2);
    });

    it('should create a session with single agentIds entry', () => {
      let response = createSessionRoute(1, {
        name:     'Single Agent Chat',
        agentIds: [1],
      });

      assert.equal(response.status, 201);

      // Should have 2 participants: 1 owner user + 1 coordinator agent
      assert.equal(response.body.participants.length, 2);

      let coordinator = response.body.participants.find((p) => p.role === 'coordinator');
      assert.equal(coordinator.participantType, 'agent');
      assert.equal(coordinator.participantId, 1);
    });

    it('should support legacy agentId field (backwards compat)', () => {
      let response = createSessionRoute(1, {
        name:    'Legacy Chat',
        agentId: 1,
      });

      assert.equal(response.status, 201);
      assert.equal(response.body.name, 'Legacy Chat');

      // Should still create participants
      assert.equal(response.body.participants.length, 2);

      let coordinator = response.body.participants.find((p) => p.role === 'coordinator');
      assert.equal(coordinator.participantType, 'agent');
      assert.equal(coordinator.participantId, 1);
    });

    it('should populate legacy agent_id column for backwards compat', () => {
      let response = createSessionRoute(1, {
        name:     'Compat Check',
        agentIds: [2],
      });

      assert.equal(response.status, 201);

      let row = db.prepare('SELECT agent_id FROM sessions WHERE id = ?').get(response.body.id);
      assert.equal(row.agent_id, 2);
    });

    it('should set first agent as coordinator and rest as members', () => {
      let response = createSessionRoute(1, {
        name:     'Three Agent Chat',
        agentIds: [1, 2, 3],
      });

      assert.equal(response.status, 201);

      let agents = response.body.participants.filter((p) => p.participantType === 'agent');
      assert.equal(agents.length, 3);

      let coordinator = agents.find((p) => p.role === 'coordinator');
      assert.equal(coordinator.participantId, 1);

      let members = agents.filter((p) => p.role === 'member');
      assert.equal(members.length, 2);
      let memberIds = members.map((p) => p.participantId).sort();
      assert.deepEqual(memberIds, [2, 3]);
    });

    it('should set creating user as owner', () => {
      let response = createSessionRoute(1, {
        name:     'Ownership Test',
        agentIds: [1],
      });

      assert.equal(response.status, 201);

      let owner = response.body.participants.find((p) => p.role === 'owner');
      assert.equal(owner.participantType, 'user');
      assert.equal(owner.participantId, 1);
    });

    it('should return agent info for primary (first) agent', () => {
      let response = createSessionRoute(1, {
        name:     'Agent Info Test',
        agentIds: [2, 1],
      });

      assert.equal(response.status, 201);
      assert.equal(response.body.agent.id, 2);
      assert.equal(response.body.agent.name, 'AliceBeta');
      assert.equal(response.body.agent.type, 'claude');
    });

    it('should return 400 if name is missing', () => {
      let response = createSessionRoute(1, { agentIds: [1] });

      assert.equal(response.status, 400);
      assert.match(response.body.error, /Name and at least one agentId/);
    });

    it('should return 400 if no agents provided', () => {
      let response = createSessionRoute(1, { name: 'No Agent' });

      assert.equal(response.status, 400);
      assert.match(response.body.error, /Name and at least one agentId/);
    });

    it('should return 400 if agentIds is empty array', () => {
      let response = createSessionRoute(1, { name: 'Empty', agentIds: [] });

      assert.equal(response.status, 400);
      assert.match(response.body.error, /Name and at least one agentId/);
    });

    it('should return 404 if any agent does not exist', () => {
      let response = createSessionRoute(1, {
        name:     'Missing Agent',
        agentIds: [1, 999],
      });

      assert.equal(response.status, 404);
      assert.match(response.body.error, /Agent 999 not found/);
    });

    it('should return 404 if agent belongs to a different user', () => {
      // Agent 4 belongs to Bob (user 2)
      let response = createSessionRoute(1, {
        name:     'Wrong User Agent',
        agentIds: [4],
      });

      assert.equal(response.status, 404);
      assert.match(response.body.error, /Agent 4 not found/);
    });

    it('should support system prompt', () => {
      let response = createSessionRoute(1, {
        name:         'Custom Prompt',
        agentIds:     [1],
        systemPrompt: 'You are a helpful pirate.',
      });

      assert.equal(response.status, 201);
      assert.equal(response.body.systemPrompt, 'You are a helpful pirate.');

      let row = db.prepare('SELECT system_prompt FROM sessions WHERE id = ?').get(response.body.id);
      assert.equal(row.system_prompt, 'You are a helpful pirate.');
    });

    it('should support status', () => {
      let response = createSessionRoute(1, {
        name:     'Archived Chat',
        agentIds: [1],
        status:   'archived',
      });

      assert.equal(response.status, 201);
      assert.equal(response.body.status, 'archived');
      assert.equal(response.body.archived, true);
    });

    it('should support parent session', () => {
      let parentId = insertSession({ userId: 1, agentId: 1, name: 'Parent' });

      let response = createSessionRoute(1, {
        name:            'Child Chat',
        agentIds:        [1],
        parentSessionId: parentId,
      });

      assert.equal(response.status, 201);
      assert.equal(response.body.parentSessionId, parentId);
    });

    it('should return 404 if parent session does not exist', () => {
      let response = createSessionRoute(1, {
        name:            'Orphan',
        agentIds:        [1],
        parentSessionId: 999,
      });

      assert.equal(response.status, 404);
      assert.match(response.body.error, /Parent session not found/);
    });
  });

  // ==========================================================================
  // List Sessions with Participants (GET /)
  // ==========================================================================

  describe('List Sessions with Participants (GET /)', () => {
    it('should return participants array in session list', () => {
      createSessionRoute(1, { name: 'Chat A', agentIds: [1] });

      let sessions = listSessions(1);

      assert.equal(sessions.length, 1);
      assert.ok(Array.isArray(sessions[0].participants));
      assert.equal(sessions[0].participants.length, 2); // owner + coordinator
    });

    it('should return correct participant roles in listing', () => {
      createSessionRoute(1, { name: 'Multi-Chat', agentIds: [1, 2] });

      let sessions = listSessions(1);
      let participants = sessions[0].participants;

      let owner = participants.find((p) => p.role === 'owner');
      assert.ok(owner);
      assert.equal(owner.participantType, 'user');

      let coordinator = participants.find((p) => p.role === 'coordinator');
      assert.ok(coordinator);
      assert.equal(coordinator.participantType, 'agent');
      assert.equal(coordinator.participantId, 1);

      let member = participants.find((p) => p.role === 'member');
      assert.ok(member);
      assert.equal(member.participantType, 'agent');
      assert.equal(member.participantId, 2);
    });

    it('should resolve agent info from coordinator participant', () => {
      createSessionRoute(1, { name: 'Coord Test', agentIds: [2] });

      let sessions = listSessions(1);

      assert.equal(sessions[0].agent.id, 2);
      assert.equal(sessions[0].agent.name, 'AliceBeta');
      assert.equal(sessions[0].agent.type, 'claude');
    });

    it('should fall back to legacy agent_id when no participants exist', () => {
      // Insert session directly with agent_id but no participants
      insertSession({ userId: 1, agentId: 1, name: 'Legacy Session' });

      let sessions = listSessions(1);

      assert.equal(sessions[0].agent.id, 1);
      assert.equal(sessions[0].agent.name, 'AliceAgent');
      assert.equal(sessions[0].participants.length, 0);
    });

    it('should return empty participants for session with no participants', () => {
      insertSession({ userId: 1, agentId: 1, name: 'No Participants' });

      let sessions = listSessions(1);

      assert.deepEqual(sessions[0].participants, []);
    });

    it('should return all sessions for a user', () => {
      createSessionRoute(1, { name: 'Session A', agentIds: [1] });
      createSessionRoute(1, { name: 'Session B', agentIds: [2] });

      let sessions = listSessions(1);

      assert.equal(sessions.length, 2);
      let names = sessions.map((s) => s.name);
      assert.ok(names.includes('Session A'));
      assert.ok(names.includes('Session B'));
    });

    it('should only return sessions for the requesting user (isolation)', () => {
      createSessionRoute(1, { name: 'Alice Session', agentIds: [1] });
      createSessionRoute(2, { name: 'Bob Session', agentIds: [4] });

      let aliceSessions = listSessions(1);
      let bobSessions = listSessions(2);

      assert.equal(aliceSessions.length, 1);
      assert.equal(aliceSessions[0].name, 'Alice Session');
      assert.equal(bobSessions.length, 1);
      assert.equal(bobSessions[0].name, 'Bob Session');
    });

    it('should include message count', () => {
      let response = createSessionRoute(1, { name: 'Chat', agentIds: [1] });
      insertMessageFrame(response.body.id, 'Hello');
      insertMessageFrame(response.body.id, 'World');

      let sessions = listSessions(1);

      assert.equal(sessions[0].messageCount, 2);
    });

    it('should support search by session name', () => {
      createSessionRoute(1, { name: 'Planning meeting', agentIds: [1] });
      createSessionRoute(1, { name: 'Code review', agentIds: [1] });

      let sessions = listSessions(1, 'Planning');

      assert.equal(sessions.length, 1);
      assert.equal(sessions[0].name, 'Planning meeting');
    });

    it('should build parent-child hierarchy correctly', () => {
      let parentResp = createSessionRoute(1, { name: 'Parent', agentIds: [1] });
      // Update parent to have known timestamp
      db.prepare("UPDATE sessions SET updated_at = '2024-01-01T00:00:03Z' WHERE id = ?").run(parentResp.body.id);

      let childResp = createSessionRoute(1, {
        name:            'Child',
        agentIds:        [1],
        parentSessionId: parentResp.body.id,
      });
      db.prepare("UPDATE sessions SET updated_at = '2024-01-01T00:00:02Z' WHERE id = ?").run(childResp.body.id);

      let otherResp = createSessionRoute(1, { name: 'Other Root', agentIds: [1] });
      db.prepare("UPDATE sessions SET updated_at = '2024-01-01T00:00:01Z' WHERE id = ?").run(otherResp.body.id);

      let sessions = listSessions(1);

      assert.equal(sessions[0].name, 'Parent');
      assert.equal(sessions[0].depth, 0);
      assert.equal(sessions[1].name, 'Child');
      assert.equal(sessions[1].depth, 1);
      assert.equal(sessions[2].name, 'Other Root');
      assert.equal(sessions[2].depth, 0);
    });
  });

  // ==========================================================================
  // Get Session with Participants (GET /:id)
  // ==========================================================================

  describe('Get Session with Participants (GET /:id)', () => {
    it('should return participants array for a session', () => {
      let created = createSessionRoute(1, { name: 'Chat', agentIds: [1, 2] });

      let response = getSessionRoute(1, created.body.id);

      assert.equal(response.status, 200);
      assert.ok(Array.isArray(response.body.participants));
      assert.equal(response.body.participants.length, 3);
    });

    it('should return correct participant structure in session detail', () => {
      let created = createSessionRoute(1, { name: 'Chat', agentIds: [1] });

      let response = getSessionRoute(1, created.body.id);

      let participant = response.body.participants[0];
      assert.ok('id' in participant);
      assert.ok('participantType' in participant);
      assert.ok('participantId' in participant);
      assert.ok('role' in participant);
    });

    it('should resolve agent from coordinator participant', () => {
      let created = createSessionRoute(1, { name: 'Chat', agentIds: [2] });

      let response = getSessionRoute(1, created.body.id);

      assert.equal(response.body.agent.id, 2);
      assert.equal(response.body.agent.name, 'AliceBeta');
    });

    it('should fall back to legacy agent_id when no participants exist', () => {
      // Insert session directly (old-style, no participants)
      let sessionId = insertSession({ userId: 1, agentId: 1, name: 'Legacy Chat' });

      let response = getSessionRoute(1, sessionId);

      assert.equal(response.status, 200);
      assert.equal(response.body.agent.id, 1);
      assert.equal(response.body.agent.name, 'AliceAgent');
      assert.equal(response.body.participants.length, 0);
    });

    it('should return session with messages from frames', () => {
      let created = createSessionRoute(1, { name: 'Chat', agentIds: [1] });
      insertMessageFrame(created.body.id, { role: 'user', content: 'Hello' }, 'user', '2024-01-01T00:00:01Z');
      insertMessageFrame(created.body.id, { role: 'assistant', content: 'Hi back' }, 'agent', '2024-01-01T00:00:02Z');

      let response = getSessionRoute(1, created.body.id);

      assert.equal(response.body.messages.length, 2);
      assert.equal(response.body.messages[0].role, 'user');
      assert.equal(response.body.messages[0].content, 'Hello');
      assert.equal(response.body.messages[1].role, 'assistant');
      assert.equal(response.body.messages[1].content, 'Hi back');
    });

    it('should return 404 for non-existent session', () => {
      let response = getSessionRoute(1, 999);

      assert.equal(response.status, 404);
      assert.equal(response.body.error, 'Session not found');
    });

    it('should return 404 for session belonging to a different user', () => {
      let created = createSessionRoute(2, { name: 'Bob Chat', agentIds: [4] });

      let response = getSessionRoute(1, created.body.id);

      assert.equal(response.status, 404);
    });

    it('should include cost information', () => {
      let created = createSessionRoute(1, { name: 'Chat', agentIds: [1] });
      db.prepare('UPDATE sessions SET input_tokens = 500, output_tokens = 200 WHERE id = ?').run(created.body.id);

      let response = getSessionRoute(1, created.body.id);

      assert.equal(response.body.cost.inputTokens, 500);
      assert.equal(response.body.cost.outputTokens, 200);
    });

    it('should default cost tokens to zero', () => {
      let created = createSessionRoute(1, { name: 'Chat', agentIds: [1] });

      let response = getSessionRoute(1, created.body.id);

      assert.equal(response.body.cost.inputTokens, 0);
      assert.equal(response.body.cost.outputTokens, 0);
    });
  });

  // ==========================================================================
  // Add Participant (POST /:id/participants)
  // ==========================================================================

  describe('Add Participant (POST /:id/participants)', () => {
    it('should add a participant to a session', () => {
      let created = createSessionRoute(1, { name: 'Chat', agentIds: [1] });

      let response = addParticipantRoute(1, created.body.id, {
        participantType: 'agent',
        participantId:   2,
        role:            'member',
      });

      assert.equal(response.status, 201);
      assert.ok(response.body.participant);
      assert.equal(response.body.participant.participantType, 'agent');
      assert.equal(response.body.participant.participantId, 2);
      assert.equal(response.body.participant.role, 'member');
    });

    it('should default role to member when not specified', () => {
      let created = createSessionRoute(1, { name: 'Chat', agentIds: [1] });

      let response = addParticipantRoute(1, created.body.id, {
        participantType: 'agent',
        participantId:   2,
      });

      assert.equal(response.status, 201);
      assert.equal(response.body.participant.role, 'member');
    });

    it('should add a user participant', () => {
      let created = createSessionRoute(1, { name: 'Chat', agentIds: [1] });

      let response = addParticipantRoute(1, created.body.id, {
        participantType: 'user',
        participantId:   2,
        role:            'member',
      });

      assert.equal(response.status, 201);
      assert.equal(response.body.participant.participantType, 'user');
      assert.equal(response.body.participant.participantId, 2);
    });

    it('should persist participant in database', () => {
      let created = createSessionRoute(1, { name: 'Chat', agentIds: [1] });

      addParticipantRoute(1, created.body.id, {
        participantType: 'agent',
        participantId:   3,
        role:            'member',
      });

      let participants = getSessionParticipants(created.body.id, db);
      let added = participants.find((p) => p.participantType === 'agent' && p.participantId === 3);
      assert.ok(added);
      assert.equal(added.role, 'member');
    });

    it('should return 400 when participantType is missing', () => {
      let created = createSessionRoute(1, { name: 'Chat', agentIds: [1] });

      let response = addParticipantRoute(1, created.body.id, {
        participantId: 2,
      });

      assert.equal(response.status, 400);
      assert.match(response.body.error, /participantType and participantId are required/);
    });

    it('should return 400 when participantId is missing', () => {
      let created = createSessionRoute(1, { name: 'Chat', agentIds: [1] });

      let response = addParticipantRoute(1, created.body.id, {
        participantType: 'agent',
      });

      assert.equal(response.status, 400);
      assert.match(response.body.error, /participantType and participantId are required/);
    });

    it('should return 404 for non-existent session', () => {
      let response = addParticipantRoute(1, 999, {
        participantType: 'agent',
        participantId:   1,
      });

      assert.equal(response.status, 404);
      assert.match(response.body.error, /Session not found/);
    });

    it('should return 404 for session belonging to different user', () => {
      let created = createSessionRoute(2, { name: 'Bob Chat', agentIds: [4] });

      let response = addParticipantRoute(1, created.body.id, {
        participantType: 'agent',
        participantId:   1,
      });

      assert.equal(response.status, 404);
      assert.match(response.body.error, /Session not found/);
    });

    it('should return 409 for duplicate participant', () => {
      let created = createSessionRoute(1, { name: 'Chat', agentIds: [1] });

      // Agent 1 is already a coordinator participant
      let response = addParticipantRoute(1, created.body.id, {
        participantType: 'agent',
        participantId:   1,
        role:            'member',
      });

      assert.equal(response.status, 409);
      assert.match(response.body.error, /Participant already exists/);
    });

    it('should be visible in session detail after adding', () => {
      let created = createSessionRoute(1, { name: 'Chat', agentIds: [1] });

      addParticipantRoute(1, created.body.id, {
        participantType: 'agent',
        participantId:   2,
        role:            'member',
      });

      let response = getSessionRoute(1, created.body.id);

      // Should now have owner + coordinator + new member = 3
      assert.equal(response.body.participants.length, 3);
      let newMember = response.body.participants.find(
        (p) => p.participantType === 'agent' && p.participantId === 2
      );
      assert.ok(newMember);
      assert.equal(newMember.role, 'member');
    });
  });

  // ==========================================================================
  // Remove Participant (DELETE /:id/participants/:type/:id)
  // ==========================================================================

  describe('Remove Participant (DELETE /:id/participants/:type/:id)', () => {
    it('should remove a participant from a session', () => {
      let created = createSessionRoute(1, { name: 'Chat', agentIds: [1, 2] });

      let response = removeParticipantRoute(1, created.body.id, 'agent', 2);

      assert.equal(response.status, 200);
      assert.equal(response.body.success, true);

      // Verify removal
      assert.equal(isParticipant(created.body.id, 'agent', 2, db), false);
    });

    it('should not affect other participants when removing one', () => {
      let created = createSessionRoute(1, { name: 'Chat', agentIds: [1, 2] });

      removeParticipantRoute(1, created.body.id, 'agent', 2);

      // Owner and coordinator should remain
      assert.equal(isParticipant(created.body.id, 'user', 1, db), true);
      assert.equal(isParticipant(created.body.id, 'agent', 1, db), true);
    });

    it('should return 404 for non-existent participant', () => {
      let created = createSessionRoute(1, { name: 'Chat', agentIds: [1] });

      let response = removeParticipantRoute(1, created.body.id, 'agent', 99);

      assert.equal(response.status, 404);
      assert.match(response.body.error, /Participant not found/);
    });

    it('should return 404 for non-existent session', () => {
      let response = removeParticipantRoute(1, 999, 'agent', 1);

      assert.equal(response.status, 404);
      assert.match(response.body.error, /Session not found/);
    });

    it('should return 404 for session belonging to different user', () => {
      let created = createSessionRoute(2, { name: 'Bob Chat', agentIds: [4] });

      let response = removeParticipantRoute(1, created.body.id, 'agent', 4);

      assert.equal(response.status, 404);
      assert.match(response.body.error, /Session not found/);
    });

    it('should be reflected in session detail after removing', () => {
      let created = createSessionRoute(1, { name: 'Chat', agentIds: [1, 2] });

      // Starts with 3 participants (owner + 2 agents)
      let before = getSessionRoute(1, created.body.id);
      assert.equal(before.body.participants.length, 3);

      removeParticipantRoute(1, created.body.id, 'agent', 2);

      let after = getSessionRoute(1, created.body.id);
      assert.equal(after.body.participants.length, 2);
    });

    it('should be reflected in session list after removing', () => {
      let created = createSessionRoute(1, { name: 'Chat', agentIds: [1, 2] });

      removeParticipantRoute(1, created.body.id, 'agent', 2);

      let sessions = listSessions(1);
      assert.equal(sessions[0].participants.length, 2);
    });
  });

  // ==========================================================================
  // Session Creation Populates Coordinator and Owner Correctly
  // ==========================================================================

  describe('Session Creation Participant Roles', () => {
    it('should always have exactly one owner (the creating user)', () => {
      let response = createSessionRoute(1, {
        name:     'Ownership Test',
        agentIds: [1, 2, 3],
      });

      let owners = response.body.participants.filter((p) => p.role === 'owner');
      assert.equal(owners.length, 1);
      assert.equal(owners[0].participantType, 'user');
      assert.equal(owners[0].participantId, 1);
    });

    it('should always have exactly one coordinator (the first agent)', () => {
      let response = createSessionRoute(1, {
        name:     'Coordinator Test',
        agentIds: [2, 1, 3],
      });

      let coordinators = response.body.participants.filter((p) => p.role === 'coordinator');
      assert.equal(coordinators.length, 1);
      assert.equal(coordinators[0].participantType, 'agent');
      assert.equal(coordinators[0].participantId, 2);
    });

    it('coordinator agent should be resolvable via getCoordinator', () => {
      let response = createSessionRoute(1, {
        name:     'Coordinator Lookup',
        agentIds: [1, 2],
      });

      let coordinator = getCoordinator(response.body.id, db);
      assert.ok(coordinator);
      assert.equal(coordinator.participantType, 'agent');
      assert.equal(coordinator.participantId, 1);
      assert.equal(coordinator.role, 'coordinator');
    });

    it('loadSessionWithAgent should prefer coordinator over legacy agent_id', () => {
      // Create session with agent 1 as coordinator
      let response = createSessionRoute(1, {
        name:     'Coordinator Preference',
        agentIds: [1],
      });

      // Manually update legacy agent_id to a different agent
      db.prepare('UPDATE sessions SET agent_id = ? WHERE id = ?').run(2, response.body.id);

      // loadSessionWithAgent should still use coordinator (agent 1)
      let session = loadSessionWithAgent(response.body.id, 1, db);
      assert.equal(session.agent_id, 1);
      assert.equal(session.agent_name, 'AliceAgent');
    });
  });

  // ==========================================================================
  // Cascade Behavior with Participants
  // ==========================================================================

  describe('Cascade Behavior', () => {
    it('should delete participants when session is deleted', () => {
      let created = createSessionRoute(1, { name: 'Doomed', agentIds: [1, 2] });
      let sessionId = created.body.id;

      // Verify participants exist
      assert.equal(getSessionParticipants(sessionId, db).length, 3);

      deleteSession(1, sessionId);

      // Participants should be gone
      assert.equal(getSessionParticipants(sessionId, db).length, 0);
    });

    it('should delete frames when session is deleted', () => {
      let created = createSessionRoute(1, { name: 'Chat', agentIds: [1] });
      let sessionId = created.body.id;

      insertMessageFrame(sessionId, 'Hello');
      insertMessageFrame(sessionId, 'World');

      let framesBefore = db.prepare('SELECT COUNT(*) as count FROM frames WHERE session_id = ?').get(sessionId);
      assert.equal(framesBefore.count, 2);

      deleteSession(1, sessionId);

      let framesAfter = db.prepare('SELECT COUNT(*) as count FROM frames WHERE session_id = ?').get(sessionId);
      assert.equal(framesAfter.count, 0);
    });
  });

  // ==========================================================================
  // Update Session (PUT /:id)
  // ==========================================================================

  describe('Update Session (PUT /:id)', () => {
    it('should update session name', () => {
      let created = createSessionRoute(1, { name: 'Old Name', agentIds: [1] });

      let response = updateSession(1, created.body.id, { name: 'New Name' });

      assert.equal(response.status, 200);
      assert.equal(response.body.success, true);

      let row = db.prepare('SELECT name FROM sessions WHERE id = ?').get(created.body.id);
      assert.equal(row.name, 'New Name');
    });

    it('should update system prompt', () => {
      let created = createSessionRoute(1, { name: 'Chat', agentIds: [1] });

      updateSession(1, created.body.id, { systemPrompt: 'Be concise.' });

      let row = db.prepare('SELECT system_prompt FROM sessions WHERE id = ?').get(created.body.id);
      assert.equal(row.system_prompt, 'Be concise.');
    });

    it('should return 400 with no fields to update', () => {
      let created = createSessionRoute(1, { name: 'Chat', agentIds: [1] });

      let response = updateSession(1, created.body.id, {});

      assert.equal(response.status, 400);
      assert.match(response.body.error, /No fields to update/);
    });

    it('should return 404 for non-existent session', () => {
      let response = updateSession(1, 999, { name: 'Updated' });

      assert.equal(response.status, 404);
    });
  });

  // ==========================================================================
  // Archive / Unarchive
  // ==========================================================================

  describe('Archive / Unarchive', () => {
    it('should archive a session', () => {
      let created = createSessionRoute(1, { name: 'Active Chat', agentIds: [1] });

      let response = archiveSession(1, created.body.id);

      assert.equal(response.status, 200);
      assert.equal(response.body.status, 'archived');
      assert.equal(response.body.archived, true);

      let row = db.prepare('SELECT status FROM sessions WHERE id = ?').get(created.body.id);
      assert.equal(row.status, 'archived');
    });

    it('should unarchive a session', () => {
      let created = createSessionRoute(1, { name: 'Chat', agentIds: [1], status: 'archived' });

      let response = unarchiveSession(1, created.body.id);

      assert.equal(response.status, 200);
      assert.equal(response.body.status, null);
      assert.equal(response.body.archived, false);
    });

    it('should return 404 when archiving non-existent session', () => {
      let response = archiveSession(1, 999);
      assert.equal(response.status, 404);
    });
  });

  // ==========================================================================
  // Status Update (PUT /:id/status)
  // ==========================================================================

  describe('Status Update (PUT /:id/status)', () => {
    it('should set status', () => {
      let created = createSessionRoute(1, { name: 'Chat', agentIds: [1] });

      let response = updateSessionStatus(1, created.body.id, 'processing');

      assert.equal(response.status, 200);
      assert.equal(response.body.status, 'processing');
    });

    it('should clear status with null', () => {
      let created = createSessionRoute(1, { name: 'Chat', agentIds: [1], status: 'processing' });

      let response = updateSessionStatus(1, created.body.id, null);

      assert.equal(response.status, 200);
      assert.equal(response.body.status, null);
    });

    it('should return 404 for non-existent session', () => {
      let response = updateSessionStatus(1, 999, 'active');
      assert.equal(response.status, 404);
    });
  });
});
