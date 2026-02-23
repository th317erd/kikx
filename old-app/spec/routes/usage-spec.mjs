'use strict';

// ============================================================================
// Usage/Token Charges API Tests
// ============================================================================
// Tests for the token charges tracking system including:
// - Cost calculation
// - Global, Service, and Session spend queries
// - Recording charges
// - Usage corrections
// - Charge history

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { randomBytes } from 'crypto';

// ============================================================================
// Test Database Setup
// ============================================================================

/**
 * Create an in-memory test database with all necessary tables.
 */
function createTestDatabase() {
  let db = new Database(':memory:');
  db.pragma('foreign_keys = ON');

  // Create minimal schema for usage tests
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      encrypted_secret TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE agents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      api_key TEXT,
      api_url TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, name)
    );

    CREATE TABLE sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE token_charges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      session_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
      message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cost_cents INTEGER DEFAULT 0,
      charge_type TEXT DEFAULT 'usage',
      description TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX idx_token_charges_agent_id ON token_charges(agent_id);
    CREATE INDEX idx_token_charges_session_id ON token_charges(session_id);

    CREATE TABLE usage_corrections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      reason TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);

  return db;
}

/**
 * Create a test user and return the user object.
 */
function createTestUser(db, username = 'testuser') {
  let result = db.prepare(`
    INSERT INTO users (username, password_hash, encrypted_secret)
    VALUES (?, 'hash', 'secret')
  `).run(username);
  return { id: result.lastInsertRowid, username };
}

/**
 * Create a test agent and return the agent object.
 */
function createTestAgent(db, userId, name = 'Test Agent', apiKey = null) {
  let key = apiKey || randomBytes(16).toString('hex');
  let result = db.prepare(`
    INSERT INTO agents (user_id, name, type, api_key)
    VALUES (?, ?, 'anthropic', ?)
  `).run(userId, name, key);
  return { id: result.lastInsertRowid, userId, name, apiKey: key };
}

/**
 * Create a test session and return the session object.
 */
function createTestSession(db, userId, agentId, name = 'Test Session') {
  let result = db.prepare(`
    INSERT INTO sessions (user_id, agent_id, name)
    VALUES (?, ?, ?)
  `).run(userId, agentId, name);
  return { id: result.lastInsertRowid, userId, agentId, name };
}

/**
 * Create a test message and return the message object.
 */
function createTestMessage(db, sessionId, role = 'user', content = 'Test message') {
  let result = db.prepare(`
    INSERT INTO messages (session_id, role, content)
    VALUES (?, ?, ?)
  `).run(sessionId, role, content);
  return { id: result.lastInsertRowid, sessionId, role, content };
}

/**
 * Insert a token charge into the database.
 */
function insertTokenCharge(db, agentId, sessionId, messageId, inputTokens, outputTokens, costCents, chargeType = 'usage') {
  let result = db.prepare(`
    INSERT INTO token_charges (agent_id, session_id, message_id, input_tokens, output_tokens, cost_cents, charge_type)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(agentId, sessionId, messageId, inputTokens, outputTokens, costCents, chargeType);
  return result.lastInsertRowid;
}

// ============================================================================
// Cost Calculation Tests
// ============================================================================

// Token rates for cost calculation (same as in usage.mjs)
const INPUT_TOKEN_RATE  = 0.003 / 1000;   // $3 per 1M input tokens
const OUTPUT_TOKEN_RATE = 0.015 / 1000;   // $15 per 1M output tokens

function calculateCost(inputTokens, outputTokens) {
  return (inputTokens * INPUT_TOKEN_RATE) + (outputTokens * OUTPUT_TOKEN_RATE);
}

describe('Cost Calculation', () => {
  it('should calculate cost correctly for zero tokens', () => {
    let cost = calculateCost(0, 0);
    assert.equal(cost, 0);
  });

  it('should calculate cost correctly for input tokens only', () => {
    // 1000 input tokens = 0.003 dollars
    let cost = calculateCost(1000, 0);
    assert.equal(cost, 0.003);
  });

  it('should calculate cost correctly for output tokens only', () => {
    // 1000 output tokens = 0.015 dollars
    let cost = calculateCost(0, 1000);
    assert.equal(cost, 0.015);
  });

  it('should calculate cost correctly for both input and output tokens', () => {
    // 1000 input + 1000 output = 0.003 + 0.015 = 0.018
    let cost = calculateCost(1000, 1000);
    assert.equal(cost, 0.018);
  });

  it('should calculate cost correctly for 1 million tokens', () => {
    // 1M input = $3, 1M output = $15
    let cost = calculateCost(1000000, 1000000);
    assert.equal(cost, 18);
  });

  it('should convert cost to cents correctly', () => {
    let cost = calculateCost(1000, 1000);
    let costCents = Math.round(cost * 100);
    assert.equal(costCents, 2); // 0.018 * 100 = 1.8, rounded = 2
  });
});

// ============================================================================
// Global Spend Tests
// ============================================================================

describe('Global Spend Calculation', () => {
  let db;
  let user;

  beforeEach(() => {
    db = createTestDatabase();
    user = createTestUser(db);
  });

  afterEach(() => {
    db.close();
  });

  it('should return zero for user with no charges', () => {
    let globalSpend = db.prepare(`
      SELECT
        COALESCE(SUM(tc.input_tokens), 0) as input_tokens,
        COALESCE(SUM(tc.output_tokens), 0) as output_tokens,
        COALESCE(SUM(tc.cost_cents), 0) as cost_cents
      FROM token_charges tc
      JOIN agents a ON tc.agent_id = a.id
      WHERE a.user_id = ?
    `).get(user.id);

    assert.equal(globalSpend.input_tokens, 0);
    assert.equal(globalSpend.output_tokens, 0);
    assert.equal(globalSpend.cost_cents, 0);
  });

  it('should sum charges from all agents owned by user', () => {
    let agent1 = createTestAgent(db, user.id, 'Agent 1');
    let agent2 = createTestAgent(db, user.id, 'Agent 2');
    let session1 = createTestSession(db, user.id, agent1.id);
    let session2 = createTestSession(db, user.id, agent2.id);

    insertTokenCharge(db, agent1.id, session1.id, null, 1000, 500, 8);
    insertTokenCharge(db, agent2.id, session2.id, null, 2000, 1000, 18);

    let globalSpend = db.prepare(`
      SELECT
        COALESCE(SUM(tc.input_tokens), 0) as input_tokens,
        COALESCE(SUM(tc.output_tokens), 0) as output_tokens,
        COALESCE(SUM(tc.cost_cents), 0) as cost_cents
      FROM token_charges tc
      JOIN agents a ON tc.agent_id = a.id
      WHERE a.user_id = ?
    `).get(user.id);

    assert.equal(globalSpend.input_tokens, 3000);
    assert.equal(globalSpend.output_tokens, 1500);
    assert.equal(globalSpend.cost_cents, 26);
  });

  it('should not include charges from other users', () => {
    let user2 = createTestUser(db, 'otheruser');
    let agent1 = createTestAgent(db, user.id, 'My Agent');
    let agent2 = createTestAgent(db, user2.id, 'Other Agent');
    let session1 = createTestSession(db, user.id, agent1.id);
    let session2 = createTestSession(db, user2.id, agent2.id);

    insertTokenCharge(db, agent1.id, session1.id, null, 1000, 500, 8);
    insertTokenCharge(db, agent2.id, session2.id, null, 5000, 5000, 100);

    let globalSpend = db.prepare(`
      SELECT
        COALESCE(SUM(tc.input_tokens), 0) as input_tokens,
        COALESCE(SUM(tc.output_tokens), 0) as output_tokens,
        COALESCE(SUM(tc.cost_cents), 0) as cost_cents
      FROM token_charges tc
      JOIN agents a ON tc.agent_id = a.id
      WHERE a.user_id = ?
    `).get(user.id);

    assert.equal(globalSpend.input_tokens, 1000);
    assert.equal(globalSpend.output_tokens, 500);
    assert.equal(globalSpend.cost_cents, 8);
  });
});

// ============================================================================
// Service Spend Tests
// ============================================================================

describe('Service Spend Calculation', () => {
  let db;
  let user;

  beforeEach(() => {
    db = createTestDatabase();
    user = createTestUser(db);
  });

  afterEach(() => {
    db.close();
  });

  it('should sum charges only from agents with matching API key', () => {
    let sharedKey = 'shared-api-key-123';
    let differentKey = 'different-api-key-456';

    let agent1 = createTestAgent(db, user.id, 'Agent 1', sharedKey);
    let agent2 = createTestAgent(db, user.id, 'Agent 2', sharedKey);
    let agent3 = createTestAgent(db, user.id, 'Agent 3', differentKey);

    let session1 = createTestSession(db, user.id, agent1.id);
    let session2 = createTestSession(db, user.id, agent2.id);
    let session3 = createTestSession(db, user.id, agent3.id);

    insertTokenCharge(db, agent1.id, session1.id, null, 1000, 500, 8);
    insertTokenCharge(db, agent2.id, session2.id, null, 2000, 1000, 18);
    insertTokenCharge(db, agent3.id, session3.id, null, 5000, 5000, 100);

    // Query service spend for shared key
    let serviceSpend = db.prepare(`
      SELECT
        COALESCE(SUM(tc.input_tokens), 0) as input_tokens,
        COALESCE(SUM(tc.output_tokens), 0) as output_tokens,
        COALESCE(SUM(tc.cost_cents), 0) as cost_cents
      FROM token_charges tc
      JOIN agents a ON tc.agent_id = a.id
      WHERE a.api_key = ? AND a.user_id = ?
    `).get(sharedKey, user.id);

    assert.equal(serviceSpend.input_tokens, 3000);
    assert.equal(serviceSpend.output_tokens, 1500);
    assert.equal(serviceSpend.cost_cents, 26);
  });

  it('should return zero for API key with no charges', () => {
    let agent = createTestAgent(db, user.id, 'Agent 1', 'my-key');

    let serviceSpend = db.prepare(`
      SELECT
        COALESCE(SUM(tc.input_tokens), 0) as input_tokens,
        COALESCE(SUM(tc.output_tokens), 0) as output_tokens,
        COALESCE(SUM(tc.cost_cents), 0) as cost_cents
      FROM token_charges tc
      JOIN agents a ON tc.agent_id = a.id
      WHERE a.api_key = ? AND a.user_id = ?
    `).get('my-key', user.id);

    assert.equal(serviceSpend.input_tokens, 0);
    assert.equal(serviceSpend.output_tokens, 0);
    assert.equal(serviceSpend.cost_cents, 0);
  });

  it('should not include charges from other users even with same API key', () => {
    let sharedKey = 'shared-key';
    let user2 = createTestUser(db, 'otheruser');

    let agent1 = createTestAgent(db, user.id, 'My Agent', sharedKey);
    let agent2 = createTestAgent(db, user2.id, 'Other Agent', sharedKey);

    let session1 = createTestSession(db, user.id, agent1.id);
    let session2 = createTestSession(db, user2.id, agent2.id);

    insertTokenCharge(db, agent1.id, session1.id, null, 1000, 500, 8);
    insertTokenCharge(db, agent2.id, session2.id, null, 5000, 5000, 100);

    let serviceSpend = db.prepare(`
      SELECT
        COALESCE(SUM(tc.input_tokens), 0) as input_tokens,
        COALESCE(SUM(tc.output_tokens), 0) as output_tokens,
        COALESCE(SUM(tc.cost_cents), 0) as cost_cents
      FROM token_charges tc
      JOIN agents a ON tc.agent_id = a.id
      WHERE a.api_key = ? AND a.user_id = ?
    `).get(sharedKey, user.id);

    assert.equal(serviceSpend.input_tokens, 1000);
    assert.equal(serviceSpend.output_tokens, 500);
    assert.equal(serviceSpend.cost_cents, 8);
  });
});

// ============================================================================
// Session Spend Tests
// ============================================================================

describe('Session Spend Calculation', () => {
  let db;
  let user;
  let agent;

  beforeEach(() => {
    db = createTestDatabase();
    user = createTestUser(db);
    agent = createTestAgent(db, user.id);
  });

  afterEach(() => {
    db.close();
  });

  it('should sum charges only for the specific session', () => {
    let session1 = createTestSession(db, user.id, agent.id, 'Session 1');
    let session2 = createTestSession(db, user.id, agent.id, 'Session 2');

    insertTokenCharge(db, agent.id, session1.id, null, 1000, 500, 8);
    insertTokenCharge(db, agent.id, session1.id, null, 500, 250, 4);
    insertTokenCharge(db, agent.id, session2.id, null, 5000, 5000, 100);

    let sessionSpend = db.prepare(`
      SELECT
        COALESCE(SUM(input_tokens), 0) as input_tokens,
        COALESCE(SUM(output_tokens), 0) as output_tokens,
        COALESCE(SUM(cost_cents), 0) as cost_cents
      FROM token_charges
      WHERE session_id = ?
    `).get(session1.id);

    assert.equal(sessionSpend.input_tokens, 1500);
    assert.equal(sessionSpend.output_tokens, 750);
    assert.equal(sessionSpend.cost_cents, 12);
  });

  it('should return zero for session with no charges', () => {
    let session = createTestSession(db, user.id, agent.id);

    let sessionSpend = db.prepare(`
      SELECT
        COALESCE(SUM(input_tokens), 0) as input_tokens,
        COALESCE(SUM(output_tokens), 0) as output_tokens,
        COALESCE(SUM(cost_cents), 0) as cost_cents
      FROM token_charges
      WHERE session_id = ?
    `).get(session.id);

    assert.equal(sessionSpend.input_tokens, 0);
    assert.equal(sessionSpend.output_tokens, 0);
    assert.equal(sessionSpend.cost_cents, 0);
  });

  it('should link charges to messages correctly', () => {
    let session = createTestSession(db, user.id, agent.id);
    let message = createTestMessage(db, session.id, 'assistant', 'Hello!');

    insertTokenCharge(db, agent.id, session.id, message.id, 100, 50, 1);

    let charge = db.prepare(`
      SELECT * FROM token_charges WHERE message_id = ?
    `).get(message.id);

    assert.equal(charge.agent_id, agent.id);
    assert.equal(charge.session_id, session.id);
    assert.equal(charge.message_id, message.id);
    assert.equal(charge.input_tokens, 100);
    assert.equal(charge.output_tokens, 50);
  });
});

// ============================================================================
// Recording Charges Tests
// ============================================================================

describe('Recording Token Charges', () => {
  let db;
  let user;
  let agent;
  let session;

  beforeEach(() => {
    db = createTestDatabase();
    user = createTestUser(db);
    agent = createTestAgent(db, user.id);
    session = createTestSession(db, user.id, agent.id);
  });

  afterEach(() => {
    db.close();
  });

  it('should insert charge with all fields', () => {
    let message = createTestMessage(db, session.id);
    let inputTokens = 1000;
    let outputTokens = 500;
    let costCents = Math.round(calculateCost(inputTokens, outputTokens) * 100);

    let result = db.prepare(`
      INSERT INTO token_charges (agent_id, session_id, message_id, input_tokens, output_tokens, cost_cents, charge_type, description)
      VALUES (?, ?, ?, ?, ?, ?, 'usage', 'API call')
    `).run(agent.id, session.id, message.id, inputTokens, outputTokens, costCents);

    assert.ok(result.lastInsertRowid);

    let charge = db.prepare('SELECT * FROM token_charges WHERE id = ?').get(result.lastInsertRowid);
    assert.equal(charge.agent_id, agent.id);
    assert.equal(charge.session_id, session.id);
    assert.equal(charge.message_id, message.id);
    assert.equal(charge.input_tokens, 1000);
    assert.equal(charge.output_tokens, 500);
    assert.equal(charge.cost_cents, costCents);
    assert.equal(charge.charge_type, 'usage');
    assert.equal(charge.description, 'API call');
  });

  it('should allow null session_id and message_id', () => {
    let result = db.prepare(`
      INSERT INTO token_charges (agent_id, session_id, message_id, input_tokens, output_tokens, cost_cents)
      VALUES (?, NULL, NULL, 100, 50, 1)
    `).run(agent.id);

    assert.ok(result.lastInsertRowid);

    let charge = db.prepare('SELECT * FROM token_charges WHERE id = ?').get(result.lastInsertRowid);
    assert.equal(charge.session_id, null);
    assert.equal(charge.message_id, null);
  });

  it('should support correction charge type', () => {
    let result = db.prepare(`
      INSERT INTO token_charges (agent_id, input_tokens, output_tokens, cost_cents, charge_type, description)
      VALUES (?, 500, 250, 5, 'correction', 'Manual adjustment')
    `).run(agent.id);

    let charge = db.prepare('SELECT * FROM token_charges WHERE id = ?').get(result.lastInsertRowid);
    assert.equal(charge.charge_type, 'correction');
    assert.equal(charge.description, 'Manual adjustment');
  });

  it('should cascade delete when agent is deleted', () => {
    insertTokenCharge(db, agent.id, session.id, null, 1000, 500, 8);

    let countBefore = db.prepare('SELECT COUNT(*) as count FROM token_charges').get().count;
    assert.equal(countBefore, 1);

    db.prepare('DELETE FROM agents WHERE id = ?').run(agent.id);

    let countAfter = db.prepare('SELECT COUNT(*) as count FROM token_charges').get().count;
    assert.equal(countAfter, 0);
  });

  it('should set session_id to NULL when session is deleted', () => {
    let chargeId = insertTokenCharge(db, agent.id, session.id, null, 1000, 500, 8);

    db.prepare('DELETE FROM sessions WHERE id = ?').run(session.id);

    let charge = db.prepare('SELECT * FROM token_charges WHERE id = ?').get(chargeId);
    assert.ok(charge);
    assert.equal(charge.session_id, null);
  });
});

// ============================================================================
// Usage Corrections Tests
// ============================================================================

describe('Usage Corrections', () => {
  let db;
  let user;
  let agent;

  beforeEach(() => {
    db = createTestDatabase();
    user = createTestUser(db);
    agent = createTestAgent(db, user.id);
  });

  afterEach(() => {
    db.close();
  });

  it('should calculate correction amount correctly', () => {
    // Insert some existing charges
    let session = createTestSession(db, user.id, agent.id);
    insertTokenCharge(db, agent.id, session.id, null, 1000, 500, 8);

    // Current total is 8 cents ($0.08)
    let currentSpend = db.prepare(`
      SELECT COALESCE(SUM(cost_cents), 0) as cost_cents
      FROM token_charges tc
      JOIN agents a ON tc.agent_id = a.id
      WHERE a.user_id = ?
    `).get(user.id);

    let currentCost = currentSpend.cost_cents / 100; // $0.08
    let actualCost = 0.50; // User says actual cost is $0.50
    let correctionCost = actualCost - currentCost; // $0.42

    assert.equal(currentCost, 0.08);
    assert.equal(correctionCost, 0.42);
  });

  it('should insert correction charge into token_charges table', () => {
    let session = createTestSession(db, user.id, agent.id);
    insertTokenCharge(db, agent.id, session.id, null, 1000, 500, 8);

    // Add correction
    db.prepare(`
      INSERT INTO token_charges (agent_id, input_tokens, output_tokens, cost_cents, charge_type, description)
      VALUES (?, 1000, 500, 42, 'correction', 'Manual correction')
    `).run(agent.id);

    // Total should now include correction
    let totalSpend = db.prepare(`
      SELECT COALESCE(SUM(cost_cents), 0) as cost_cents
      FROM token_charges tc
      JOIN agents a ON tc.agent_id = a.id
      WHERE a.user_id = ?
    `).get(user.id);

    assert.equal(totalSpend.cost_cents, 50);
  });

  it('should handle negative corrections', () => {
    let session = createTestSession(db, user.id, agent.id);
    insertTokenCharge(db, agent.id, session.id, null, 1000, 500, 100);

    // User says actual is lower, so negative correction
    db.prepare(`
      INSERT INTO token_charges (agent_id, input_tokens, output_tokens, cost_cents, charge_type, description)
      VALUES (?, -500, -250, -50, 'correction', 'Over-counted')
    `).run(agent.id);

    let totalSpend = db.prepare(`
      SELECT COALESCE(SUM(cost_cents), 0) as cost_cents
      FROM token_charges tc
      JOIN agents a ON tc.agent_id = a.id
      WHERE a.user_id = ?
    `).get(user.id);

    assert.equal(totalSpend.cost_cents, 50);
  });
});

// ============================================================================
// Charge History Tests
// ============================================================================

describe('Charge History', () => {
  let db;
  let user;
  let agent;

  beforeEach(() => {
    db = createTestDatabase();
    user = createTestUser(db);
    agent = createTestAgent(db, user.id);
  });

  afterEach(() => {
    db.close();
  });

  it('should return charges in descending order by created_at', () => {
    let session = createTestSession(db, user.id, agent.id);

    // Insert charges with slight delays (use explicit timestamps)
    db.prepare(`
      INSERT INTO token_charges (agent_id, session_id, input_tokens, output_tokens, cost_cents, created_at)
      VALUES (?, ?, 100, 50, 1, '2026-01-01 10:00:00')
    `).run(agent.id, session.id);

    db.prepare(`
      INSERT INTO token_charges (agent_id, session_id, input_tokens, output_tokens, cost_cents, created_at)
      VALUES (?, ?, 200, 100, 2, '2026-01-01 11:00:00')
    `).run(agent.id, session.id);

    db.prepare(`
      INSERT INTO token_charges (agent_id, session_id, input_tokens, output_tokens, cost_cents, created_at)
      VALUES (?, ?, 300, 150, 3, '2026-01-01 12:00:00')
    `).run(agent.id, session.id);

    let charges = db.prepare(`
      SELECT * FROM token_charges
      ORDER BY created_at DESC
    `).all();

    assert.equal(charges.length, 3);
    assert.equal(charges[0].input_tokens, 300);
    assert.equal(charges[1].input_tokens, 200);
    assert.equal(charges[2].input_tokens, 100);
  });

  it('should respect limit parameter', () => {
    let session = createTestSession(db, user.id, agent.id);

    for (let i = 0; i < 10; i++) {
      insertTokenCharge(db, agent.id, session.id, null, 100 * i, 50 * i, i);
    }

    let charges = db.prepare(`
      SELECT * FROM token_charges
      ORDER BY created_at DESC
      LIMIT ?
    `).all(5);

    assert.equal(charges.length, 5);
  });

  it('should include agent name in history', () => {
    let session = createTestSession(db, user.id, agent.id);
    insertTokenCharge(db, agent.id, session.id, null, 1000, 500, 8);

    let charges = db.prepare(`
      SELECT
        tc.*,
        a.name as agent_name
      FROM token_charges tc
      JOIN agents a ON tc.agent_id = a.id
      WHERE a.user_id = ?
    `).all(user.id);

    assert.equal(charges.length, 1);
    assert.equal(charges[0].agent_name, agent.name);
  });

  it('should only return charges for the authenticated user', () => {
    let user2 = createTestUser(db, 'otheruser');
    let agent2 = createTestAgent(db, user2.id, 'Other Agent');
    let session1 = createTestSession(db, user.id, agent.id);
    let session2 = createTestSession(db, user2.id, agent2.id);

    insertTokenCharge(db, agent.id, session1.id, null, 1000, 500, 8);
    insertTokenCharge(db, agent2.id, session2.id, null, 5000, 5000, 100);

    let charges = db.prepare(`
      SELECT tc.*
      FROM token_charges tc
      JOIN agents a ON tc.agent_id = a.id
      WHERE a.user_id = ?
    `).all(user.id);

    assert.equal(charges.length, 1);
    assert.equal(charges[0].input_tokens, 1000);
  });
});

// ============================================================================
// Edge Cases and Error Handling
// ============================================================================

describe('Edge Cases', () => {
  let db;
  let user;

  beforeEach(() => {
    db = createTestDatabase();
    user = createTestUser(db);
  });

  afterEach(() => {
    db.close();
  });

  it('should handle very large token counts', () => {
    let agent = createTestAgent(db, user.id);
    let session = createTestSession(db, user.id, agent.id);

    // 10 million tokens
    let inputTokens = 10000000;
    let outputTokens = 5000000;
    let cost = calculateCost(inputTokens, outputTokens);
    let costCents = Math.round(cost * 100);

    insertTokenCharge(db, agent.id, session.id, null, inputTokens, outputTokens, costCents);

    let charge = db.prepare('SELECT * FROM token_charges WHERE session_id = ?').get(session.id);
    assert.equal(charge.input_tokens, 10000000);
    assert.equal(charge.output_tokens, 5000000);
    // 10M * 0.003/1000 + 5M * 0.015/1000 = 30 + 75 = $105 = 10500 cents
    assert.equal(charge.cost_cents, 10500);
  });

  it('should handle multiple agents with same name but different users', () => {
    let user2 = createTestUser(db, 'user2');
    let agent1 = createTestAgent(db, user.id, 'Shared Name');
    let agent2 = createTestAgent(db, user2.id, 'Shared Name');

    let session1 = createTestSession(db, user.id, agent1.id);
    let session2 = createTestSession(db, user2.id, agent2.id);

    insertTokenCharge(db, agent1.id, session1.id, null, 1000, 500, 8);
    insertTokenCharge(db, agent2.id, session2.id, null, 2000, 1000, 18);

    let user1Spend = db.prepare(`
      SELECT COALESCE(SUM(cost_cents), 0) as cost_cents
      FROM token_charges tc
      JOIN agents a ON tc.agent_id = a.id
      WHERE a.user_id = ?
    `).get(user.id);

    let user2Spend = db.prepare(`
      SELECT COALESCE(SUM(cost_cents), 0) as cost_cents
      FROM token_charges tc
      JOIN agents a ON tc.agent_id = a.id
      WHERE a.user_id = ?
    `).get(user2.id);

    assert.equal(user1Spend.cost_cents, 8);
    assert.equal(user2Spend.cost_cents, 18);
  });

  it('should handle session without any charges in a multi-session query', () => {
    let agent = createTestAgent(db, user.id);
    let session1 = createTestSession(db, user.id, agent.id, 'Session 1');
    let session2 = createTestSession(db, user.id, agent.id, 'Session 2');

    // Only add charges to session1
    insertTokenCharge(db, agent.id, session1.id, null, 1000, 500, 8);

    // Query for session2 should return zeros
    let sessionSpend = db.prepare(`
      SELECT
        COALESCE(SUM(input_tokens), 0) as input_tokens,
        COALESCE(SUM(output_tokens), 0) as output_tokens,
        COALESCE(SUM(cost_cents), 0) as cost_cents
      FROM token_charges
      WHERE session_id = ?
    `).get(session2.id);

    assert.equal(sessionSpend.input_tokens, 0);
    assert.equal(sessionSpend.output_tokens, 0);
    assert.equal(sessionSpend.cost_cents, 0);
  });
});

// ============================================================================
// Run Tests
// ============================================================================

console.log('Running Usage/Token Charges Tests...\n');
