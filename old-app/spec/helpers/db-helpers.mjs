'use strict';

/**
 * Database Fixture / Seeder Helpers
 *
 * Provides functions to seed test data into an in-memory SQLite
 * database for server-side route and module testing.
 *
 * Usage:
 *   import Database from 'better-sqlite3';
 *   import { createTestDatabase, seedUser, seedAgent, seedSession } from './db-helpers.mjs';
 *
 *   let db = createTestDatabase();
 *   let user = seedUser(db, { username: 'alice' });
 *   let agent = seedAgent(db, { userId: user.id, name: 'test-bot' });
 *   let session = seedSession(db, user.id, agent.id, { name: 'Chat 1' });
 */

import Database from 'better-sqlite3';

/**
 * Create a fresh in-memory SQLite database with the full Hero schema.
 *
 * Includes: users, agents, sessions, session_participants, frames,
 * abilities, ability_approvals, session_approvals, permission_rules,
 * uploads, token_charges.
 *
 * @returns {Database} In-memory better-sqlite3 database
 */
export function createTestDatabase() {
  let db = new Database(':memory:');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT DEFAULT '',
      encrypted_secret TEXT DEFAULT '',
      email TEXT,
      display_name TEXT,
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
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, name)
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
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      participant_type TEXT NOT NULL CHECK(participant_type IN ('user', 'agent')),
      participant_id INTEGER NOT NULL,
      role TEXT DEFAULT 'member' CHECK(role IN ('owner', 'coordinator', 'member')),
      alias TEXT,
      joined_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(session_id, participant_type, participant_id)
    );

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
    CREATE INDEX idx_frames_parent ON frames(parent_id);
    CREATE INDEX idx_frames_type ON frames(type);

    CREATE TABLE abilities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('function', 'process')),
      source TEXT NOT NULL CHECK(source IN ('builtin', 'system', 'user', 'plugin')),
      plugin_name TEXT,
      description TEXT,
      category TEXT,
      tags TEXT,
      encrypted_content TEXT,
      input_schema TEXT,
      applies TEXT DEFAULT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, name)
    );

    CREATE TABLE ability_approvals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
      ability_name TEXT NOT NULL,
      execution_id TEXT NOT NULL UNIQUE,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'denied', 'timeout')),
      request_data TEXT,
      question_type TEXT,
      question_prompt TEXT,
      answer_value TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      resolved_at TEXT
    );

    CREATE TABLE session_approvals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      ability_name TEXT NOT NULL,
      approved_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(session_id, ability_name)
    );

    CREATE TABLE permission_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      session_id INTEGER REFERENCES sessions(id) ON DELETE CASCADE,
      subject_type TEXT NOT NULL CHECK(subject_type IN ('user', 'agent', 'plugin', '*')),
      subject_id INTEGER,
      resource_type TEXT NOT NULL CHECK(resource_type IN ('command', 'tool', 'ability', '*')),
      resource_name TEXT,
      action TEXT NOT NULL CHECK(action IN ('allow', 'deny', 'prompt')),
      scope TEXT DEFAULT 'permanent' CHECK(scope IN ('once', 'session', 'permanent')),
      conditions TEXT,
      priority INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE uploads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
      filename TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      storage_path TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE token_charges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      session_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
      message_id INTEGER,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cost_cents INTEGER DEFAULT 0,
      charge_type TEXT DEFAULT 'usage',
      description TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);

  return db;
}

let userCounter = 0;

/**
 * Seed a test user into the database.
 *
 * @param {Database} db - Database instance
 * @param {object} [overrides] - Field overrides
 * @param {string} [overrides.username] - Username (default: auto-generated)
 * @param {string} [overrides.passwordHash] - Password hash
 * @param {string} [overrides.encryptedSecret] - Encrypted secret
 * @param {string} [overrides.email] - Email address
 * @param {string} [overrides.displayName] - Display name
 * @returns {{ id: number, username: string, email: string|null, displayName: string|null }}
 */
export function seedUser(db, overrides = {}) {
  userCounter++;
  let username = overrides.username || `test-user-${userCounter}`;
  let passwordHash = overrides.passwordHash || 'hashed-password';
  let encryptedSecret = overrides.encryptedSecret || 'encrypted-secret';
  let email = overrides.email || null;
  let displayName = overrides.displayName || null;

  let result = db.prepare(`
    INSERT INTO users (username, password_hash, encrypted_secret, email, display_name)
    VALUES (?, ?, ?, ?, ?)
  `).run(username, passwordHash, encryptedSecret, email, displayName);

  return {
    id: Number(result.lastInsertRowid),
    username,
    email,
    displayName,
  };
}

let agentCounter = 0;

/**
 * Seed a test agent into the database.
 *
 * IMPORTANT: Agent name MUST start with `test-` to comply with
 * the testing safeguard rule. This function enforces this constraint.
 *
 * @param {Database} db - Database instance
 * @param {object} [overrides] - Field overrides
 * @param {number} overrides.userId - Owner user ID (required)
 * @param {string} [overrides.name] - Agent name (must start with test-, default: auto-generated)
 * @param {string} [overrides.type] - Agent type (default: 'claude')
 * @param {string} [overrides.apiUrl] - API URL
 * @param {string} [overrides.avatarUrl] - Avatar URL
 * @param {string} [overrides.encryptedApiKey] - Encrypted API key
 * @returns {{ id: number, userId: number, name: string, type: string }}
 */
export function seedAgent(db, overrides = {}) {
  agentCounter++;
  let name = overrides.name || `test-agent-${agentCounter}`;

  if (!name.match(/^test-/i)) {
    throw new Error(
      `Agent name must start with "test-" (got "${name}"). ` +
      'This safeguard prevents accidental writes to real agent data.'
    );
  }

  if (!overrides.userId) {
    throw new Error('seedAgent requires overrides.userId');
  }

  let type = overrides.type || 'claude';
  let apiUrl = overrides.apiUrl || null;
  let avatarUrl = overrides.avatarUrl || null;
  let encryptedApiKey = overrides.encryptedApiKey || null;

  let result = db.prepare(`
    INSERT INTO agents (user_id, name, type, api_url, avatar_url, encrypted_api_key)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(overrides.userId, name, type, apiUrl, avatarUrl, encryptedApiKey);

  return {
    id: Number(result.lastInsertRowid),
    userId: overrides.userId,
    name,
    type,
  };
}

let sessionCounter = 0;

/**
 * Seed a test session with participants into the database.
 *
 * Automatically creates session_participants rows:
 * - The user as 'owner'
 * - The agent as 'coordinator'
 *
 * @param {Database} db - Database instance
 * @param {number} userId - Owner user ID
 * @param {number} agentId - Coordinator agent ID
 * @param {object} [overrides] - Field overrides
 * @param {string} [overrides.name] - Session name (default: auto-generated)
 * @param {string} [overrides.systemPrompt] - System prompt
 * @param {string} [overrides.status] - Session status
 * @returns {{ id: number, userId: number, agentId: number, name: string }}
 */
export function seedSession(db, userId, agentId, overrides = {}) {
  sessionCounter++;
  let name = overrides.name || `Test Session ${sessionCounter}`;
  let systemPrompt = overrides.systemPrompt || null;
  let status = overrides.status || null;

  let result = db.prepare(`
    INSERT INTO sessions (user_id, agent_id, name, system_prompt, status)
    VALUES (?, ?, ?, ?, ?)
  `).run(userId, agentId, name, systemPrompt, status);

  let sessionId = Number(result.lastInsertRowid);

  // Add user as owner
  db.prepare(`
    INSERT INTO session_participants (session_id, participant_type, participant_id, role)
    VALUES (?, 'user', ?, 'owner')
  `).run(sessionId, userId);

  // Add agent as coordinator
  db.prepare(`
    INSERT INTO session_participants (session_id, participant_type, participant_id, role)
    VALUES (?, 'agent', ?, 'coordinator')
  `).run(sessionId, agentId);

  return {
    id: sessionId,
    userId,
    agentId,
    name,
  };
}

/**
 * Reset the auto-increment counters.
 * Call this in beforeEach() if you need deterministic IDs across tests.
 */
export function resetCounters() {
  userCounter = 0;
  agentCounter = 0;
  sessionCounter = 0;
}

export default {
  createTestDatabase,
  seedUser,
  seedAgent,
  seedSession,
  resetCounters,
};
