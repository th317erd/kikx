'use strict';

import Database from 'better-sqlite3';
import { ensureConfigDir, getDatabasePath } from './lib/config-path.mjs';

let db = null;

/**
 * Get the database instance, creating it if necessary.
 *
 * @returns {Database} SQLite database instance
 */
export function getDatabase() {
  if (db)
    return db;

  ensureConfigDir();
  let dbPath = getDatabasePath();

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  runMigrations(db);

  return db;
}

/**
 * Close the database connection.
 */
export function closeDatabase() {
  if (db) {
    db.close();
    db = null;
  }
}

/**
 * Run database migrations.
 *
 * @param {Database} database - SQLite database instance
 */
function runMigrations(database) {
  // Create migrations table if it doesn't exist
  database.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      applied_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  let migrations = getMigrations();

  for (let migration of migrations) {
    let exists = database.prepare('SELECT 1 FROM migrations WHERE name = ?').get(migration.name);

    if (!exists) {
      console.log(`Running migration: ${migration.name}`);
      database.exec(migration.sql);
      database.prepare('INSERT INTO migrations (name) VALUES (?)').run(migration.name);
    }
  }
}

/**
 * Get the list of migrations to apply.
 *
 * @returns {Array<{name: string, sql: string}>}
 */
function getMigrations() {
  return [
    {
      name: '001_initial_schema',
      sql:  `
        -- Users table
        CREATE TABLE users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT UNIQUE NOT NULL,
          password_hash TEXT NOT NULL,
          encrypted_secret TEXT NOT NULL,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX idx_users_username ON users(username);

        -- Agents table (user-scoped)
        CREATE TABLE agents (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          type TEXT NOT NULL,
          api_url TEXT,
          encrypted_api_key TEXT,
          encrypted_config TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(user_id, name)
        );

        CREATE INDEX idx_agents_user_id ON agents(user_id);

        -- Sessions table (user-scoped)
        CREATE TABLE sessions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          system_prompt TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX idx_sessions_user_id ON sessions(user_id);
        CREATE INDEX idx_sessions_agent_id ON sessions(agent_id);

        -- Messages table
        CREATE TABLE messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX idx_messages_session_id ON messages(session_id);

        -- Commands table (user-scoped)
        CREATE TABLE commands (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          description TEXT,
          handler TEXT NOT NULL,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(user_id, name)
        );

        CREATE INDEX idx_commands_user_id ON commands(user_id);

        -- Tools table (user-scoped)
        CREATE TABLE tools (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          description TEXT,
          input_schema TEXT NOT NULL,
          handler TEXT NOT NULL,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(user_id, name)
        );

        CREATE INDEX idx_tools_user_id ON tools(user_id);
      `,
    },
    {
      name: '002_processes_system',
      sql:  `
        -- Processes table (user-scoped, encrypted content)
        CREATE TABLE processes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          description TEXT,
          encrypted_content TEXT NOT NULL,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(user_id, name)
        );

        CREATE INDEX idx_processes_user_id ON processes(user_id);

        -- Add default_processes JSON column to agents table
        ALTER TABLE agents ADD COLUMN default_processes TEXT DEFAULT '[]';
      `,
    },
    {
      name: '003_sessions_archive',
      sql:  `
        -- Add archived flag to sessions for soft-delete
        ALTER TABLE sessions ADD COLUMN archived INTEGER DEFAULT 0;

        -- Index for filtering archived sessions
        CREATE INDEX idx_sessions_archived ON sessions(user_id, archived);
      `,
    },
    {
      name: '004_abilities_system',
      sql:  `
        -- Unified abilities table
        -- Consolidates processes, commands, and functions into one model
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
          auto_approve INTEGER DEFAULT 0,
          auto_approve_policy TEXT DEFAULT 'ask' CHECK(auto_approve_policy IN ('always', 'session', 'never', 'ask')),
          danger_level TEXT DEFAULT 'safe' CHECK(danger_level IN ('safe', 'moderate', 'dangerous')),
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(user_id, name)
        );

        CREATE INDEX idx_abilities_user_id ON abilities(user_id);
        CREATE INDEX idx_abilities_type ON abilities(type);
        CREATE INDEX idx_abilities_source ON abilities(source);
        CREATE INDEX idx_abilities_name ON abilities(name);

        -- Pending ability approvals
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

        CREATE INDEX idx_ability_approvals_user_id ON ability_approvals(user_id);
        CREATE INDEX idx_ability_approvals_status ON ability_approvals(status);
        CREATE INDEX idx_ability_approvals_execution_id ON ability_approvals(execution_id);

        -- Session-scoped auto-approvals
        CREATE TABLE session_approvals (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          ability_name TEXT NOT NULL,
          approved_at TEXT DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(session_id, ability_name)
        );

        CREATE INDEX idx_session_approvals_session ON session_approvals(session_id);

        -- Add default_abilities column to agents
        ALTER TABLE agents ADD COLUMN default_abilities TEXT DEFAULT '[]';
      `,
    },
    {
      name: '005_messages_hidden',
      sql:  `
        -- Add hidden flag to messages for suppressing system messages from UI
        -- Hidden messages are still sent to the AI but not displayed in chat
        ALTER TABLE messages ADD COLUMN hidden INTEGER DEFAULT 0;

        -- Index for efficient filtering
        CREATE INDEX idx_messages_hidden ON messages(session_id, hidden);
      `,
    },
    {
      name: '006_sessions_status_parent',
      sql:  `
        -- Add status column to sessions for flexible state management
        -- Values: NULL (normal), 'archived', 'agent' (auto-spawned by ability), etc.
        ALTER TABLE sessions ADD COLUMN status TEXT DEFAULT NULL;

        -- Add parent_session_id for session hierarchy (e.g., agent sub-sessions)
        ALTER TABLE sessions ADD COLUMN parent_session_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL;

        -- Migrate existing archived flag to status column
        UPDATE sessions SET status = 'archived' WHERE archived = 1;

        -- Index for efficient filtering by status
        CREATE INDEX idx_sessions_status ON sessions(user_id, status);

        -- Index for parent lookups
        CREATE INDEX idx_sessions_parent ON sessions(parent_session_id);
      `,
    },
    {
      name: '007_abilities_applies',
      sql:  `
        -- Add 'applies' field to abilities for conditional auto-application
        -- This is a freeform text field containing a question for the AI to evaluate
        -- Examples:
        --   "Is the user asking about code review?"
        --   "Does this involve file operations?"
        --   "Is the conversation about a specific project?"
        -- The AI interprets this to decide if the ability should auto-apply to context
        ALTER TABLE abilities ADD COLUMN applies TEXT DEFAULT NULL;
      `,
    },
    {
      name: '008_messages_type',
      sql:  `
        -- Add 'type' column to messages for categorizing message types
        -- Types:
        --   'message' - Regular user/assistant messages (default)
        --   'interaction' - Agent interaction requests/responses
        --   'system' - System initialization, startup abilities
        --   'feedback' - Interaction results fed back to agent
        -- This allows filtering in UI while preserving full context for AI
        ALTER TABLE messages ADD COLUMN type TEXT DEFAULT 'message';

        -- Update existing hidden messages to have appropriate types
        UPDATE messages SET type = 'system' WHERE hidden = 1;

        -- Index for efficient filtering by type
        CREATE INDEX idx_messages_type ON messages(session_id, type);
      `,
    },
    {
      name: '009_messages_updated_at',
      sql:  `
        -- Add updated_at column to messages for tracking modifications
        -- SQLite doesn't allow non-constant defaults, so use NULL then update
        ALTER TABLE messages ADD COLUMN updated_at TEXT DEFAULT NULL;

        -- Populate existing rows with created_at value
        UPDATE messages SET updated_at = created_at;
      `,
    },
    {
      name: '010_sessions_cost',
      sql:  `
        -- Add cost tracking columns to sessions
        ALTER TABLE sessions ADD COLUMN input_tokens INTEGER DEFAULT 0;
        ALTER TABLE sessions ADD COLUMN output_tokens INTEGER DEFAULT 0;
      `,
    },
    {
      name: '011_usage_corrections',
      sql:  `
        -- Usage corrections table for adjusting token/cost tracking
        CREATE TABLE usage_corrections (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          input_tokens INTEGER DEFAULT 0,
          output_tokens INTEGER DEFAULT 0,
          reason TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX idx_usage_corrections_user_id ON usage_corrections(user_id);
      `,
    },
    {
      name: '012_token_charges',
      sql:  `
        -- Token charges table for tracking all API usage and corrections
        -- Each row represents tokens consumed in a single API call or a correction
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
        CREATE INDEX idx_token_charges_created_at ON token_charges(created_at);
      `,
    },
    {
      name: '013_messages_private',
      sql:  `
        -- Add private column to messages for user-only messages (not sent to agent)
        ALTER TABLE messages ADD COLUMN private INTEGER DEFAULT 0;
      `,
    },
    {
      name: '014_frames_table',
      sql:  `
        -- Interaction Frames: Event-sourced conversation system
        -- All conversation activity becomes immutable frames
        -- State is derived by replaying frames from a checkpoint

        CREATE TABLE frames (
          id            TEXT PRIMARY KEY,  -- uuid
          session_id    INTEGER NOT NULL,
          parent_id     TEXT,              -- parent frame (nullable, for sub-frames)
          target_ids    TEXT,              -- JSON array: ["agent:123", "user:456", "frame:xyz"]
          timestamp     TEXT NOT NULL,     -- high-resolution UTC, ISO format (ordering is sacred)

          type          TEXT NOT NULL,     -- message | request | result | update | compact
          author_type   TEXT NOT NULL,     -- user | agent | system
          author_id     INTEGER,           -- user.id or agent.id, null for system

          payload       TEXT NOT NULL,     -- JSON content

          FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
        );

        CREATE INDEX idx_frames_session ON frames(session_id, timestamp);
        CREATE INDEX idx_frames_parent ON frames(parent_id);
        CREATE INDEX idx_frames_type ON frames(type);
      `,
    },
    {
      name: '015_drop_messages',
      sql:  `
        -- Remove FK references to messages before dropping
        UPDATE token_charges SET message_id = NULL WHERE message_id IS NOT NULL;

        -- Drop the messages table - replaced by frames
        DROP TABLE IF EXISTS messages;
      `,
    },
    {
      name: '016_remove_ability_permissions',
      sql:  `
        -- Remove permission columns from abilities table
        -- Permissions (auto_approve, danger_level) will only apply to functions/commands, not abilities
        ALTER TABLE abilities DROP COLUMN auto_approve;
        ALTER TABLE abilities DROP COLUMN auto_approve_policy;
        ALTER TABLE abilities DROP COLUMN danger_level;
      `,
    },
    {
      name: '017_fix_token_charges_fk',
      sql:  `
        -- Fix token_charges table: remove FK reference to deleted messages table
        -- SQLite doesn't support ALTER TABLE DROP CONSTRAINT, so recreate the table

        CREATE TABLE token_charges_new (
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

        INSERT INTO token_charges_new SELECT * FROM token_charges;
        DROP TABLE token_charges;
        ALTER TABLE token_charges_new RENAME TO token_charges;

        CREATE INDEX idx_token_charges_agent_id ON token_charges(agent_id);
        CREATE INDEX idx_token_charges_session_id ON token_charges(session_id);
        CREATE INDEX idx_token_charges_created_at ON token_charges(created_at);
      `,
    },
    {
      name: '018_session_participants',
      sql:  `
        -- Multi-party sessions: participants join table
        -- Sessions can have 0-N agents and 0-N users as participants.
        -- Each participant has a role: owner, coordinator, or member.
        --   owner:       The user who created the session
        --   coordinator: The agent that responds to unaddressed messages
        --   member:      A participant addressed via @mention

        CREATE TABLE session_participants (
          id               INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id       INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          participant_type TEXT NOT NULL CHECK(participant_type IN ('user', 'agent')),
          participant_id   INTEGER NOT NULL,
          role             TEXT DEFAULT 'member' CHECK(role IN ('owner', 'coordinator', 'member')),
          joined_at        TEXT DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(session_id, participant_type, participant_id)
        );

        CREATE INDEX idx_session_participants_session ON session_participants(session_id);
        CREATE INDEX idx_session_participants_type ON session_participants(participant_type);
        CREATE INDEX idx_session_participants_role ON session_participants(role);

        -- Populate from existing sessions: user_id becomes owner, agent_id becomes coordinator
        INSERT INTO session_participants (session_id, participant_type, participant_id, role)
        SELECT id, 'user', user_id, 'owner' FROM sessions;

        INSERT INTO session_participants (session_id, participant_type, participant_id, role)
        SELECT id, 'agent', agent_id, 'coordinator' FROM sessions WHERE agent_id IS NOT NULL;

        -- Make agent_id nullable: recreate sessions table without NOT NULL on agent_id
        -- SQLite doesn't support ALTER COLUMN, so we recreate.

        CREATE TABLE sessions_new (
          id                INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          agent_id          INTEGER REFERENCES agents(id) ON DELETE SET NULL,
          name              TEXT NOT NULL,
          system_prompt     TEXT,
          archived          INTEGER DEFAULT 0,
          status            TEXT DEFAULT NULL,
          parent_session_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
          input_tokens      INTEGER DEFAULT 0,
          output_tokens     INTEGER DEFAULT 0,
          created_at        TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at        TEXT DEFAULT CURRENT_TIMESTAMP
        );

        INSERT INTO sessions_new
        SELECT id, user_id, agent_id, name, system_prompt, archived, status,
               parent_session_id, input_tokens, output_tokens, created_at, updated_at
        FROM sessions;

        DROP TABLE sessions;
        ALTER TABLE sessions_new RENAME TO sessions;

        CREATE INDEX idx_sessions_user_id ON sessions(user_id);
        CREATE INDEX idx_sessions_agent_id ON sessions(agent_id);
        CREATE INDEX idx_sessions_archived ON sessions(user_id, archived);
        CREATE INDEX idx_sessions_status ON sessions(user_id, status);
        CREATE INDEX idx_sessions_parent ON sessions(parent_session_id);
      `,
    },
    {
      name: '019_permission_rules',
      sql:  `
        -- Permission rules: default-deny policy engine
        -- Controls what subjects (users, agents, plugins) can do with
        -- what resources (commands, tools, abilities).
        --
        -- Resolution order: most specific rule wins.
        -- Specificity: exact subject+resource > subject wildcard > resource wildcard > global.
        -- At equal specificity, explicit deny beats allow.
        -- When no rule matches, default is 'prompt' (ask the user).
        --
        -- Scopes:
        --   permanent: rule persists until explicitly deleted
        --   session:   rule applies only within a session (requires session_id)
        --   once:      rule consumed after first evaluation

        CREATE TABLE permission_rules (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          owner_id       INTEGER REFERENCES users(id) ON DELETE CASCADE,
          session_id     INTEGER REFERENCES sessions(id) ON DELETE CASCADE,
          subject_type   TEXT NOT NULL CHECK(subject_type IN ('user', 'agent', 'plugin', '*')),
          subject_id     INTEGER,
          resource_type  TEXT NOT NULL CHECK(resource_type IN ('command', 'tool', 'ability', '*')),
          resource_name  TEXT,
          action         TEXT NOT NULL CHECK(action IN ('allow', 'deny', 'prompt')),
          scope          TEXT DEFAULT 'permanent' CHECK(scope IN ('once', 'session', 'permanent')),
          conditions     TEXT,
          priority       INTEGER DEFAULT 0,
          created_at     TEXT DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX idx_permission_rules_owner ON permission_rules(owner_id);
        CREATE INDEX idx_permission_rules_session ON permission_rules(session_id);
        CREATE INDEX idx_permission_rules_subject ON permission_rules(subject_type, subject_id);
        CREATE INDEX idx_permission_rules_resource ON permission_rules(resource_type, resource_name);
      `,
    },

    {
      name: '020_auth_enhancement',
      sql:  `
        -- User profile fields
        ALTER TABLE users ADD COLUMN email TEXT;
        ALTER TABLE users ADD COLUMN display_name TEXT;

        -- Magic link tokens for passwordless auth
        CREATE TABLE magic_link_tokens (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          token      TEXT UNIQUE NOT NULL,
          user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
          email      TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          used_at    TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX idx_magic_link_tokens_token ON magic_link_tokens(token);
        CREATE INDEX idx_magic_link_tokens_email ON magic_link_tokens(email);

        -- API keys for programmatic access
        CREATE TABLE api_keys (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          key_hash     TEXT UNIQUE NOT NULL,
          key_prefix   TEXT NOT NULL,
          user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          name         TEXT NOT NULL,
          scopes       TEXT DEFAULT '[]',
          expires_at   TEXT,
          last_used_at TEXT,
          created_at   TEXT DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX idx_api_keys_hash ON api_keys(key_hash);
        CREATE INDEX idx_api_keys_user ON api_keys(user_id);
      `,
    },

    {
      name: '021_uploads_and_avatars',
      sql:  `
        -- Agent avatars
        ALTER TABLE agents ADD COLUMN avatar_url TEXT;

        -- File uploads
        CREATE TABLE uploads (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          session_id   INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
          filename     TEXT NOT NULL,
          original_name TEXT NOT NULL,
          mime_type    TEXT NOT NULL,
          size_bytes   INTEGER NOT NULL,
          storage_path TEXT NOT NULL,
          created_at   TEXT DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX idx_uploads_user ON uploads(user_id);
        CREATE INDEX idx_uploads_session ON uploads(session_id);
      `,
    },
    {
      name: '022_participant_alias',
      sql:  `
        -- Per-session display alias for agents (e.g. "CodeReviewer" for test-claude)
        ALTER TABLE session_participants ADD COLUMN alias TEXT;
      `,
    },
    {
      name: '023_audit_logs',
      sql:  `
        CREATE TABLE audit_logs (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          event_type  TEXT NOT NULL,
          user_id     INTEGER,
          agent_id    INTEGER,
          session_id  INTEGER,
          ip_address  TEXT,
          details     TEXT,
          created_at  TEXT DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX idx_audit_logs_event_type ON audit_logs(event_type);
        CREATE INDEX idx_audit_logs_user_id    ON audit_logs(user_id);
        CREATE INDEX idx_audit_logs_timestamp  ON audit_logs(timestamp);
      `,
    },
  ];
}

export default {
  getDatabase,
  closeDatabase,
};
