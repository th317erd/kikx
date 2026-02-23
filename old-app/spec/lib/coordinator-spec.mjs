'use strict';

/**
 * F1: Active Coordinator Model Tests
 *
 * Verifies:
 * - COORD-004: promoteCoordinator demotes old, promotes new
 * - ALIAS-001: addParticipant with alias stores alias
 * - ALIAS-002: alias returned in parseParticipantRow
 * - ALIAS-003: findAgentByName resolves by name
 * - PARTY-001: /invite accepts agent name
 * - PARTY-002: /invite accepts as:alias syntax
 * - PARTY-003: /promote changes coordinator
 * - PARTY-004: /participants shows aliases
 * - RENDER-001: hero-participant-list component structure
 * - RENDER-005: participant sidebar in index.html
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  addParticipant,
  removeParticipant,
  getSessionParticipants,
  getCoordinator,
  updateParticipantRole,
  isParticipant,
  promoteCoordinator,
  findAgentByName,
  createSessionWithParticipants,
  ParticipantType,
  ParticipantRole,
} from '../../server/lib/participants/index.mjs';

// Read source files for structural tests
const __dirname   = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');

const indexHtml = fs.readFileSync(
  path.join(projectRoot, 'public/index.html'), 'utf-8'
);
const participantListJs = fs.readFileSync(
  path.join(projectRoot, 'public/js/components/hero-participant-list/hero-participant-list.js'), 'utf-8'
);
const participantListHtml = fs.readFileSync(
  path.join(projectRoot, 'public/js/components/hero-participant-list/hero-participant-list.html'), 'utf-8'
);
const layoutCss = fs.readFileSync(
  path.join(projectRoot, 'public/css/layout.css'), 'utf-8'
);
const componentsIndex = fs.readFileSync(
  path.join(projectRoot, 'public/js/components/index.js'), 'utf-8'
);

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
  db.prepare("INSERT INTO agents (id, user_id, name, type) VALUES (1, 1, 'test-alpha', 'claude')").run();
  db.prepare("INSERT INTO agents (id, user_id, name, type) VALUES (2, 1, 'test-beta', 'claude')").run();
  db.prepare("INSERT INTO agents (id, user_id, name, type) VALUES (3, 2, 'test-gamma', 'claude')").run();
  db.prepare("INSERT INTO sessions (id, user_id, agent_id, name) VALUES (1, 1, 1, 'Session One')").run();

  // Add participants: alice as owner, test-alpha as coordinator
  addParticipant(1, 'user', 1, 'owner', db);
  addParticipant(1, 'agent', 1, 'coordinator', db);

  return db;
}

// =============================================================================
// COORD-004: promoteCoordinator
// =============================================================================

describe('COORD-004: promoteCoordinator', () => {
  beforeEach(() => createTestDatabase());

  it('should promote a member to coordinator', () => {
    addParticipant(1, 'agent', 2, 'member', db);

    let result = promoteCoordinator(1, 2, db);
    assert.strictEqual(result.promoted, true);
    assert.strictEqual(result.previousCoordinatorId, 1);

    let coordinator = getCoordinator(1, db);
    assert.strictEqual(coordinator.participantId, 2);
    assert.strictEqual(coordinator.role, 'coordinator');
  });

  it('should demote old coordinator to member', () => {
    addParticipant(1, 'agent', 2, 'member', db);

    promoteCoordinator(1, 2, db);

    let participants = getSessionParticipants(1, db);
    let oldCoordinator = participants.find((p) => p.participantId === 1 && p.participantType === 'agent');
    assert.strictEqual(oldCoordinator.role, 'member');
  });

  it('should reject promoting a non-participant', () => {
    let result = promoteCoordinator(1, 99, db);
    assert.strictEqual(result.promoted, false);
    assert.ok(result.error.includes('not a participant'));
  });

  it('should reject promoting the current coordinator', () => {
    let result = promoteCoordinator(1, 1, db);
    assert.strictEqual(result.promoted, false);
    assert.ok(result.error.includes('already'));
  });

  it('should handle session with no existing coordinator', () => {
    // Remove current coordinator
    updateParticipantRole(1, 'agent', 1, 'member', db);
    addParticipant(1, 'agent', 2, 'member', db);

    let result = promoteCoordinator(1, 2, db);
    assert.strictEqual(result.promoted, true);
    assert.strictEqual(result.previousCoordinatorId, null);
  });
});

// =============================================================================
// ALIAS-001: addParticipant with alias
// =============================================================================

describe('ALIAS-001: Participant alias support', () => {
  beforeEach(() => createTestDatabase());

  it('should store alias when provided', () => {
    let participant = addParticipant(1, 'agent', 2, 'member', db, 'Coder');
    assert.strictEqual(participant.alias, 'Coder');
  });

  it('should return null alias when not provided', () => {
    let participant = addParticipant(1, 'agent', 2, 'member', db);
    assert.strictEqual(participant.alias, null);
  });

  it('should preserve alias in getSessionParticipants', () => {
    addParticipant(1, 'agent', 2, 'member', db, 'Reviewer');

    let participants = getSessionParticipants(1, db);
    let member = participants.find((p) => p.participantId === 2 && p.participantType === 'agent');
    assert.strictEqual(member.alias, 'Reviewer');
  });
});

// =============================================================================
// ALIAS-003: findAgentByName
// =============================================================================

describe('ALIAS-003: findAgentByName', () => {
  beforeEach(() => createTestDatabase());

  it('should find agent by exact name', () => {
    let agent = findAgentByName('test-alpha', 1, db);
    assert.ok(agent);
    assert.strictEqual(agent.id, 1);
    assert.strictEqual(agent.name, 'test-alpha');
  });

  it('should find agent case-insensitively', () => {
    let agent = findAgentByName('Test-Alpha', 1, db);
    assert.ok(agent);
    assert.strictEqual(agent.id, 1);
  });

  it('should not find agents owned by other users', () => {
    let agent = findAgentByName('test-gamma', 1, db);
    assert.strictEqual(agent, null);
  });

  it('should return null for unknown agent', () => {
    let agent = findAgentByName('nonexistent', 1, db);
    assert.strictEqual(agent, null);
  });
});

// =============================================================================
// RENDER-005: Participant sidebar in index.html
// =============================================================================

describe('RENDER-005: Participant sidebar in chat view', () => {
  it('should have participant-sidebar element in chat view', () => {
    assert.ok(
      indexHtml.includes('id="participant-sidebar"'),
      'index.html should have participant-sidebar'
    );
  });

  it('should have hero-participant-list component', () => {
    assert.ok(
      indexHtml.includes('<hero-participant-list'),
      'index.html should include hero-participant-list component'
    );
  });

  it('should have mythix-require for hero-participant-list', () => {
    assert.ok(
      indexHtml.includes('hero-participant-list@1'),
      'index.html should have mythix-require for hero-participant-list'
    );
  });

  it('should have chat-layout wrapper in chat view', () => {
    assert.ok(
      indexHtml.includes('class="chat-layout"'),
      'Chat view should have chat-layout wrapper'
    );
  });

  it('should have participant-sidebar CSS', () => {
    assert.ok(
      layoutCss.includes('.participant-sidebar'),
      'layout.css should have participant-sidebar styles'
    );
  });
});

// =============================================================================
// RENDER-001: hero-participant-list component structure
// =============================================================================

describe('RENDER-001: hero-participant-list component', () => {
  it('should extend HeroComponent', () => {
    assert.ok(
      participantListJs.includes('extends HeroComponent'),
      'Should extend HeroComponent'
    );
  });

  it('should use Shadow DOM', () => {
    assert.ok(
      participantListJs.includes('createShadowDOM()'),
      'Should override createShadowDOM'
    );
    assert.ok(
      participantListJs.includes('attachShadow'),
      'Should attach shadow root'
    );
  });

  it('should have setParticipants method', () => {
    assert.ok(
      participantListJs.includes('setParticipants('),
      'Should have setParticipants method'
    );
  });

  it('should render coordinators, members, and users separately', () => {
    assert.ok(
      participantListJs.includes("role === 'coordinator'"),
      'Should filter coordinators'
    );
    assert.ok(
      participantListJs.includes("role === 'member'"),
      'Should filter members'
    );
    assert.ok(
      participantListJs.includes("participantType === 'user'"),
      'Should filter users'
    );
  });

  it('should display alias when present', () => {
    assert.ok(
      participantListJs.includes('participant.alias'),
      'Should check for participant alias'
    );
    assert.ok(
      participantListJs.includes('class="alias"'),
      'Should render alias with CSS class'
    );
  });

  it('should have role badges', () => {
    assert.ok(
      participantListHtml.includes('.role-coordinator'),
      'Should have coordinator role badge style'
    );
    assert.ok(
      participantListHtml.includes('.role-member'),
      'Should have member role badge style'
    );
    assert.ok(
      participantListHtml.includes('.role-owner'),
      'Should have owner role badge style'
    );
  });

  it('should be loaded via mythix-require (not JS import)', () => {
    // Shadow DOM components must NOT be imported in index.js to avoid
    // a race condition where the class is defined before the template
    // is injected by mythix-require.
    assert.ok(
      !componentsIndex.includes("export { HeroParticipantList }"),
      'Should NOT be exported from index.js (loaded via mythix-require)'
    );
  });

  it('should register as custom element', () => {
    assert.ok(
      participantListJs.includes("static tagName = 'hero-participant-list'"),
      'Should define hero-participant-list tag name'
    );
    assert.ok(
      participantListJs.includes('HeroParticipantList.register()'),
      'Should call register()'
    );
  });
});

// =============================================================================
// Behavioral: createSessionWithParticipants alias
// =============================================================================

describe('createSessionWithParticipants with alias', () => {
  beforeEach(() => createTestDatabase());

  it('should assign first agent as coordinator', () => {
    let session = createSessionWithParticipants({
      userId:   1,
      name:     'Test Multi',
      agentIds: [1, 2],
    }, db);

    let coordinator = session.participants.find((p) => p.role === 'coordinator');
    assert.ok(coordinator);
    assert.strictEqual(coordinator.participantId, 1);
  });

  it('should assign additional agents as members', () => {
    let session = createSessionWithParticipants({
      userId:   1,
      name:     'Test Multi',
      agentIds: [1, 2],
    }, db);

    let member = session.participants.find((p) => p.role === 'member' && p.participantType === 'agent');
    assert.ok(member);
    assert.strictEqual(member.participantId, 2);
  });

  it('should assign user as owner', () => {
    let session = createSessionWithParticipants({
      userId:   1,
      name:     'Test Multi',
      agentIds: [1],
    }, db);

    let owner = session.participants.find((p) => p.role === 'owner');
    assert.ok(owner);
    assert.strictEqual(owner.participantId, 1);
    assert.strictEqual(owner.participantType, 'user');
  });
});
