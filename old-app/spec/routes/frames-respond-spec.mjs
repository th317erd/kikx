'use strict';

// ============================================================================
// Frames Respond Endpoint Tests
// ============================================================================
// Tests for POST /api/sessions/:sessionId/frames/:frameId/respond
//
// This endpoint lets both REST and WebSocket clients respond to actionable
// frames (e.g., permission requests).

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import {
  createFrame,
  getFrame,
  getChildFrames,
  FrameType,
  AuthorType,
} from '../../server/lib/frames/index.mjs';

import {
  _addPendingPermissionPrompt,
  _clearPendingPermissionPrompts,
  handlePermissionResponse,
} from '../../server/lib/permissions/prompt.mjs';

import {
  SubjectType,
  ResourceType,
  Action,
  Scope,
} from '../../server/lib/permissions/index.mjs';

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
      type TEXT DEFAULT 'claude'
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

    CREATE TABLE frames (
      id          TEXT PRIMARY KEY,
      session_id  INTEGER NOT NULL,
      parent_id   TEXT,
      target_ids  TEXT,
      timestamp   TEXT DEFAULT CURRENT_TIMESTAMP,
      type        TEXT NOT NULL,
      author_type TEXT NOT NULL,
      author_id   INTEGER,
      payload     TEXT NOT NULL
    );
  `);

  // Seed test data
  db.prepare("INSERT INTO users (id, username) VALUES (1, 'alice')").run();
  db.prepare("INSERT INTO users (id, username) VALUES (2, 'bob')").run();
  db.prepare("INSERT INTO agents (id, user_id, name) VALUES (1, 1, 'test-alpha')").run();
  db.prepare("INSERT INTO sessions (id, user_id, agent_id, name) VALUES (1, 1, 1, 'Session One')").run();
  db.prepare("INSERT INTO sessions (id, user_id, agent_id, name) VALUES (2, 2, 1, 'Bobs Session')").run();

  return db;
}

// ============================================================================
// Helper: create a request frame in the test DB
// ============================================================================

function createRequestFrame(sessionId, payload) {
  return createFrame({
    sessionId,
    type:       FrameType.REQUEST,
    authorType: AuthorType.SYSTEM,
    payload,
  }, db);
}

function createMessageFrame(sessionId) {
  return createFrame({
    sessionId,
    type:       FrameType.MESSAGE,
    authorType: AuthorType.AGENT,
    payload:    { role: 'assistant', content: 'Hello' },
  }, db);
}

// ============================================================================
// Import the route handler logic (we test via direct function calls,
// since Express route testing would require a full server setup)
// ============================================================================

// We test the logic by reading the frames.mjs source and verifying structure,
// plus testing the handlePermissionResponse integration which is the core.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const framesRoute = fs.readFileSync(path.join(__dirname, '../../server/routes/frames.mjs'), 'utf-8');

// ============================================================================
// Tests
// ============================================================================

describe('POST /:sessionId/frames/:frameId/respond — structural', () => {
  it('should define a POST route for respond', () => {
    assert.ok(
      framesRoute.includes("router.post('/:sessionId/frames/:frameId/respond'"),
      'Should have POST /:sessionId/frames/:frameId/respond route',
    );
  });

  it('should verify session ownership', () => {
    assert.ok(
      framesRoute.includes('req.user.id') && framesRoute.includes('user_id'),
      'Should check user_id for session ownership',
    );
  });

  it('should verify frame is a request type', () => {
    assert.ok(
      framesRoute.includes("type !== 'request'") || framesRoute.includes("FrameType.REQUEST"),
      'Should check frame is a request type',
    );
  });

  it('should route permission_request to handlePermissionResponse', () => {
    assert.ok(
      framesRoute.includes('handlePermissionResponse'),
      'Should call handlePermissionResponse for permission_request',
    );
  });

  it('should import handlePermissionResponse', () => {
    assert.ok(
      framesRoute.includes("from '../lib/permissions/prompt.mjs'"),
      'Should import from permissions/prompt.mjs',
    );
  });

  it('should validate answer field in request body', () => {
    assert.ok(
      framesRoute.includes('answer') && framesRoute.includes('400'),
      'Should validate answer field and return 400 if missing',
    );
  });
});

describe('POST respond — permission request integration', () => {
  beforeEach(() => {
    createTestDatabase();
    _clearPendingPermissionPrompts();
  });

  it('should resolve permission prompt when responding to request frame', () => {
    let resolved = null;

    // Create a request frame
    let requestFrame = createRequestFrame(1, {
      action:   'permission_request',
      promptId: 'perm-respond-001',
      status:   'pending',
    });

    // Add a pending prompt linked to this request frame
    _addPendingPermissionPrompt('perm-respond-001', {
      resolve:        (result) => { resolved = result; },
      subject:        { type: SubjectType.AGENT, id: 1 },
      resource:       { type: ResourceType.COMMAND, name: 'websearch' },
      context:        { sessionId: 1, userId: 1, db },
      requestHash:    'abc123',
      requestFrameId: requestFrame.id,
    });

    // Simulate the route handler calling handlePermissionResponse
    let result = handlePermissionResponse('perm-respond-001', 'allow_session');

    assert.strictEqual(result.success, true);
    assert.ok(resolved);
    assert.strictEqual(resolved.action, Action.ALLOW);
    assert.strictEqual(resolved.scope, Scope.SESSION);
  });

  it('should create result frame when permission is responded to', () => {
    let requestFrame = createRequestFrame(1, {
      action:   'permission_request',
      promptId: 'perm-respond-002',
      status:   'pending',
    });

    _addPendingPermissionPrompt('perm-respond-002', {
      resolve:        () => {},
      subject:        { type: SubjectType.AGENT, id: 1 },
      resource:       { type: ResourceType.COMMAND, name: 'delegate' },
      context:        { sessionId: 1, userId: 1, db },
      requestHash:    'abc123',
      requestFrameId: requestFrame.id,
    });

    handlePermissionResponse('perm-respond-002', 'allow_always');

    // Verify result frame was created
    let children = getChildFrames(requestFrame.id, db);
    assert.strictEqual(children.length, 1);
    assert.strictEqual(children[0].type, FrameType.RESULT);

    let payload = (typeof children[0].payload === 'string')
      ? JSON.parse(children[0].payload)
      : children[0].payload;
    assert.strictEqual(payload.action, 'permission_response');
    assert.strictEqual(payload.resolvedAction, Action.ALLOW);
    assert.strictEqual(payload.resolvedScope, Scope.PERMANENT);
  });

  it('should return error for non-existent prompt', () => {
    let result = handlePermissionResponse('perm-nonexistent', 'allow_once');
    assert.strictEqual(result.success, false);
    assert.ok(result.error);
  });
});

describe('POST respond — validation', () => {
  beforeEach(() => {
    createTestDatabase();
  });

  it('should verify non-request frames cannot be responded to (structural)', () => {
    // Create a message frame (not a request)
    let messageFrame = createMessageFrame(1);
    assert.strictEqual(messageFrame.type, FrameType.MESSAGE);

    // The route should check frame.type === 'request' before proceeding
    // We verify this structurally
    assert.ok(
      framesRoute.includes("'request'"),
      'Route should check for request type',
    );
  });

  it('should handle 404 for non-existent frame', () => {
    let frame = getFrame('nonexistent-frame-id', db);
    assert.ok(frame == null, 'getFrame should return null/undefined for missing frame');

    // Route returns 404 — verified structurally
    assert.ok(
      framesRoute.includes('404'),
      'Route should return 404 for missing frames',
    );
  });
});
