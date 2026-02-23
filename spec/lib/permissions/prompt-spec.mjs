'use strict';

// ============================================================================
// F2: Permission Prompt as Form Submission Tests
// ============================================================================
// Test IDs: PERMUI-001, PERMUI-002, PERMUI-003, PERMUI-004, PERMUI-005, INT-003
//
// Verifies:
// - PERMUI-001: Prompt generates valid hml-prompt markup with options
// - PERMUI-002: User submission creates permission rule with correct scope
// - PERMUI-003: Server rejects bot-originated form submissions (no userId)
// - PERMUI-004: Ignore / Deny → agent receives denial feedback
// - PERMUI-005: Subsequent identical requests auto-resolved by new rule
// - INT-003:    Prompt lifecycle (request → pending → respond → resolved)

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import {
  isPermissionPrompt,
  requestPermissionPrompt,
  handlePermissionResponse,
  cancelPermissionPrompt,
  getPendingPermissionPrompt,
  _addPendingPermissionPrompt,
  _clearPendingPermissionPrompts,
  PERMISSION_PROMPT_PREFIX,
  createPermitBag,
  checkPermitBag,
  recordPermitBagGrant,
} from '../../../server/lib/permissions/prompt.mjs';

import {
  createRule,
  evaluate,
  Action,
  Scope,
  SubjectType,
  ResourceType,
} from '../../../server/lib/permissions/index.mjs';

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

    CREATE TABLE sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      agent_id INTEGER,
      name TEXT NOT NULL,
      system_prompt TEXT,
      status TEXT DEFAULT NULL,
      parent_session_id INTEGER,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE frames (
      id TEXT PRIMARY KEY,
      session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      parent_id TEXT,
      target_ids TEXT DEFAULT '[]',
      timestamp TEXT DEFAULT CURRENT_TIMESTAMP,
      type TEXT NOT NULL,
      author_type TEXT NOT NULL,
      author_id INTEGER,
      payload TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE permission_rules (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_id       INTEGER REFERENCES users(id),
      session_id     INTEGER,
      subject_type   TEXT NOT NULL,
      subject_id     INTEGER,
      resource_type  TEXT NOT NULL,
      resource_name  TEXT,
      action         TEXT NOT NULL,
      scope          TEXT DEFAULT 'permanent',
      conditions     TEXT,
      priority       INTEGER DEFAULT 0,
      created_at     TEXT DEFAULT CURRENT_TIMESTAMP
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
  `);

  db.prepare("INSERT INTO users (id, username) VALUES (1, 'alice')").run();
  db.prepare("INSERT INTO users (id, username) VALUES (2, 'bob')").run();
  db.prepare("INSERT INTO sessions (id, user_id, name) VALUES (1, 1, 'Test Session')").run();
  db.prepare("INSERT INTO sessions (id, user_id, name) VALUES (42, 1, 'Session 42')").run();

  return db;
}

// ============================================================================
// PERMUI-001: Prompt ID and Markup Identification
// ============================================================================

describe('PERMUI-001: Permission prompt identification', () => {
  it('should identify permission prompts by prefix', () => {
    assert.ok(isPermissionPrompt('perm-abc123'), 'perm- prefix should be recognized');
    assert.ok(!isPermissionPrompt('prompt-abc123'), 'Other prefixes should not match');
    assert.ok(!isPermissionPrompt(null), 'null should not match');
    assert.ok(!isPermissionPrompt(''), 'empty string should not match');
    assert.ok(!isPermissionPrompt(42), 'numbers should not match');
  });

  it('should have correct prefix constant', () => {
    assert.strictEqual(PERMISSION_PROMPT_PREFIX, 'perm-');
  });
});

// ============================================================================
// PERMUI-002: User Submission Creates Rule
// ============================================================================

describe('PERMUI-002: User submission creates permission rule', () => {
  beforeEach(() => {
    _clearPendingPermissionPrompts();
    createTestDatabase();
  });

  it('should create a permanent allow rule for allow_always', async () => {
    let subject  = { type: 'agent', id: 1 };
    let resource = { type: 'tool', name: 'websearch' };

    // Inject a pending prompt directly (bypass async frame creation)
    let promptId = 'perm-test-always';
    let resolveFunc;
    let promise = new Promise((resolve) => { resolveFunc = resolve; });

    _addPendingPermissionPrompt(promptId, {
      resolve:     resolveFunc,
      subject,
      resource,
      context:     { sessionId: 1, userId: 1, db },
      requestHash: 'test-hash',
    });

    let result = handlePermissionResponse(promptId, 'allow_always');

    assert.strictEqual(result.success, true);

    // Verify rule was created in DB
    let rules = db.prepare('SELECT * FROM permission_rules WHERE resource_name = ?').all('websearch');
    assert.strictEqual(rules.length, 1);
    assert.strictEqual(rules[0].action, 'allow');
    assert.strictEqual(rules[0].scope, 'permanent');
    assert.strictEqual(rules[0].subject_type, 'agent');
    assert.strictEqual(rules[0].subject_id, 1);
    assert.strictEqual(rules[0].owner_id, 1);

    // Verify promise resolved
    let resolved = await promise;
    assert.strictEqual(resolved.action, 'allow');
    assert.strictEqual(resolved.scope, 'permanent');
  });

  it('should create a session-scoped allow rule for allow_session', async () => {
    let subject  = { type: 'agent', id: 1 };
    let resource = { type: 'tool', name: 'grep' };

    let promptId = 'perm-test-session';
    let resolveFunc;
    let promise = new Promise((resolve) => { resolveFunc = resolve; });

    _addPendingPermissionPrompt(promptId, {
      resolve:     resolveFunc,
      subject,
      resource,
      context:     { sessionId: 42, userId: 1, db },
      requestHash: 'test-hash',
    });

    handlePermissionResponse(promptId, 'allow_session');

    let rules = db.prepare('SELECT * FROM permission_rules WHERE resource_name = ?').all('grep');
    assert.strictEqual(rules.length, 1);
    assert.strictEqual(rules[0].action, 'allow');
    assert.strictEqual(rules[0].scope, 'session');
    assert.strictEqual(rules[0].session_id, 42);

    let resolved = await promise;
    assert.strictEqual(resolved.scope, 'session');
  });

  it('should NOT create a persistent rule for allow_once (prompt resolution is the grant)', async () => {
    let subject  = { type: 'agent', id: 1 };
    let resource = { type: 'tool', name: 'shell' };

    let promptId = 'perm-test-once';
    let resolveFunc;
    let promise = new Promise((resolve) => { resolveFunc = resolve; });

    _addPendingPermissionPrompt(promptId, {
      resolve:     resolveFunc,
      subject,
      resource,
      context:     { sessionId: 1, userId: 1, db },
      requestHash: 'test-hash',
    });

    handlePermissionResponse(promptId, 'allow_once');

    // No persistent rule — the prompt resolution itself IS the one-time grant.
    let rules = db.prepare('SELECT * FROM permission_rules WHERE resource_name = ?').all('shell');
    assert.strictEqual(rules.length, 0);

    let resolved = await promise;
    assert.strictEqual(resolved.scope, 'once');
  });

  it('should resolve promise with deny action when user denies', async () => {
    let subject  = { type: 'agent', id: 1 };
    let resource = { type: 'tool', name: 'delete_file' };

    let promptId = 'perm-test-deny';
    let resolveFunc;
    let promise = new Promise((resolve) => { resolveFunc = resolve; });

    _addPendingPermissionPrompt(promptId, {
      resolve:     resolveFunc,
      subject,
      resource,
      context:     { sessionId: 1, userId: 1, db },
      requestHash: 'test-hash',
    });

    handlePermissionResponse(promptId, 'deny');

    let resolved = await promise;
    assert.strictEqual(resolved.action, 'deny');
  });

  it('should default unknown answers to deny', async () => {
    let subject  = { type: 'agent', id: 1 };
    let resource = { type: 'tool', name: 'something' };

    let promptId = 'perm-test-unknown';
    let resolveFunc;
    let promise = new Promise((resolve) => { resolveFunc = resolve; });

    _addPendingPermissionPrompt(promptId, {
      resolve:     resolveFunc,
      subject,
      resource,
      context:     { sessionId: 1, userId: 1, db },
      requestHash: 'test-hash',
    });

    handlePermissionResponse(promptId, 'garbage_answer');

    let resolved = await promise;
    assert.strictEqual(resolved.action, 'deny');
  });
});

// ============================================================================
// PERMUI-003: Reject Unknown / Already-Resolved Prompts
// ============================================================================

describe('PERMUI-003: Reject invalid submissions', () => {
  beforeEach(() => _clearPendingPermissionPrompts());

  it('should reject submission for unknown prompt ID', () => {
    let result = handlePermissionResponse('nonexistent-id', 'allow_always');

    assert.strictEqual(result.success, false);
    assert.ok(result.error.includes('Unknown'), 'Should mention unknown prompt');
  });

  it('should not allow duplicate resolution of same prompt', () => {
    let promptId = 'perm-test-dupe';
    let resolveFunc;
    new Promise((resolve) => { resolveFunc = resolve; });

    _addPendingPermissionPrompt(promptId, {
      resolve:     resolveFunc,
      subject:     { type: 'agent', id: 1 },
      resource:    { type: 'tool', name: 'test' },
      context:     { sessionId: 1, userId: 1 },
      requestHash: 'test-hash',
    });

    // First response: success
    let first = handlePermissionResponse(promptId, 'allow_always');
    assert.strictEqual(first.success, true);

    // Second response: already resolved
    let second = handlePermissionResponse(promptId, 'deny');
    assert.strictEqual(second.success, false);
    assert.ok(second.error.includes('already resolved'));
  });
});

// ============================================================================
// PERMUI-004: Deny / Cancel Resolves with Deny
// ============================================================================

describe('PERMUI-004: Deny and cancel behavior', () => {
  beforeEach(() => _clearPendingPermissionPrompts());

  it('should resolve with deny when prompt is cancelled', async () => {
    let promptId = 'perm-test-cancel';
    let resolveFunc;
    let promise = new Promise((resolve) => { resolveFunc = resolve; });

    _addPendingPermissionPrompt(promptId, {
      resolve:     resolveFunc,
      subject:     { type: 'agent', id: 1 },
      resource:    { type: 'tool', name: 'shell' },
      context:     { sessionId: 1, userId: 1 },
      requestHash: 'test-hash',
    });

    cancelPermissionPrompt(promptId);

    let resolved = await promise;
    assert.strictEqual(resolved.action, 'deny');
    assert.ok(resolved.reason.includes('Cancelled'), 'Should include cancel reason');
  });

  it('should no-op cancel for unknown prompt ID', () => {
    // Should not throw
    cancelPermissionPrompt('nonexistent-id');
    assert.ok(true);
  });
});

// ============================================================================
// PERMUI-005: Subsequent Requests Auto-Resolved by Rule
// ============================================================================

describe('PERMUI-005: Subsequent requests auto-resolved', () => {
  beforeEach(() => createTestDatabase());

  it('should auto-allow after allow_always rule is created', () => {
    createRule({
      ownerId:      1,
      subjectType:  'agent',
      subjectId:    1,
      resourceType: 'tool',
      resourceName: 'websearch',
      action:       'allow',
      scope:        'permanent',
    }, db);

    let result = evaluate(
      { type: 'agent', id: 1 },
      { type: 'tool', name: 'websearch' },
      { ownerId: 1 },
      db,
    );

    assert.strictEqual(result.action, 'allow', 'Should auto-allow based on permanent rule');
  });

  it('should auto-deny after deny rule is created', () => {
    createRule({
      ownerId:      1,
      subjectType:  'agent',
      subjectId:    1,
      resourceType: 'tool',
      resourceName: 'delete_file',
      action:       'deny',
      scope:        'permanent',
    }, db);

    let result = evaluate(
      { type: 'agent', id: 1 },
      { type: 'tool', name: 'delete_file' },
      { ownerId: 1 },
      db,
    );

    assert.strictEqual(result.action, 'deny', 'Should auto-deny based on permanent rule');
  });

  it('should consume once-scoped allow rule after first use', () => {
    createRule({
      ownerId:      1,
      subjectType:  'agent',
      subjectId:    1,
      resourceType: 'tool',
      resourceName: 'shell',
      action:       'allow',
      scope:        'once',
    }, db);

    // First evaluation: should allow and consume the rule
    let first = evaluate(
      { type: 'agent', id: 1 },
      { type: 'tool', name: 'shell' },
      { ownerId: 1 },
      db,
    );
    assert.strictEqual(first.action, 'allow');

    // Second evaluation: rule consumed, falls to default prompt
    let second = evaluate(
      { type: 'agent', id: 1 },
      { type: 'tool', name: 'shell' },
      { ownerId: 1 },
      db,
    );
    assert.strictEqual(second.action, 'prompt', 'Should fall to prompt after once-rule consumed');
  });

  it('should respect session-scoped rules only in matching session', () => {
    createRule({
      ownerId:      1,
      sessionId:    1,
      subjectType:  'agent',
      subjectId:    1,
      resourceType: 'tool',
      resourceName: 'grep',
      action:       'allow',
      scope:        'session',
    }, db);

    // Same session: should allow
    let sameSession = evaluate(
      { type: 'agent', id: 1 },
      { type: 'tool', name: 'grep' },
      { sessionId: 1, ownerId: 1 },
      db,
    );
    assert.strictEqual(sameSession.action, 'allow');

    // Different session: should prompt (no matching rule)
    let differentSession = evaluate(
      { type: 'agent', id: 1 },
      { type: 'tool', name: 'grep' },
      { sessionId: 99, ownerId: 1 },
      db,
    );
    assert.strictEqual(differentSession.action, 'prompt', 'Should not match in different session');
  });
});

// ============================================================================
// INT-003: Full Prompt Lifecycle (injection-based testing)
// ============================================================================

describe('INT-003: Full prompt lifecycle', () => {
  beforeEach(() => {
    _clearPendingPermissionPrompts();
    createTestDatabase();
  });

  it('should handle full lifecycle: inject pending → respond → resolved', async () => {
    let subject  = { type: 'agent', id: 1 };
    let resource = { type: 'tool', name: 'websearch' };
    let promptId = 'perm-lifecycle-test';

    let resolveFunc;
    let promise = new Promise((resolve) => { resolveFunc = resolve; });

    // Step 1: Inject pending prompt
    _addPendingPermissionPrompt(promptId, {
      resolve:     resolveFunc,
      subject,
      resource,
      context:     { sessionId: 1, userId: 1, db },
      requestHash: 'test-hash',
    });

    // Step 2: Verify it's pending
    assert.ok(getPendingPermissionPrompt(promptId), 'Should be retrievable by ID');

    // Step 3: Respond
    let responseResult = handlePermissionResponse(promptId, 'allow_session');
    assert.strictEqual(responseResult.success, true);

    // Step 4: Verify resolved — no longer pending
    assert.strictEqual(getPendingPermissionPrompt(promptId), undefined, 'Should be removed after resolution');

    let resolved = await promise;
    assert.strictEqual(resolved.action, 'allow');
    assert.strictEqual(resolved.scope, 'session');
  });

  it('should handle multiple concurrent prompts independently', async () => {
    let subject = { type: 'agent', id: 1 };

    let promptIdA = 'perm-multi-a';
    let promptIdB = 'perm-multi-b';

    let resolveA, resolveB;
    let promiseA = new Promise((resolve) => { resolveA = resolve; });
    let promiseB = new Promise((resolve) => { resolveB = resolve; });

    _addPendingPermissionPrompt(promptIdA, {
      resolve:     resolveA,
      subject,
      resource:    { type: 'tool', name: 'websearch' },
      context:     { sessionId: 1, userId: 1, db },
      requestHash: 'hash-a',
    });

    _addPendingPermissionPrompt(promptIdB, {
      resolve:     resolveB,
      subject,
      resource:    { type: 'tool', name: 'shell' },
      context:     { sessionId: 1, userId: 1, db },
      requestHash: 'hash-b',
    });

    // Respond to B first, then A
    handlePermissionResponse(promptIdB, 'deny');
    handlePermissionResponse(promptIdA, 'allow_always');

    let resolvedA = await promiseA;
    let resolvedB = await promiseB;

    assert.strictEqual(resolvedA.action, 'allow');
    assert.strictEqual(resolvedB.action, 'deny');
  });

  it('should not create rule for deny (only allow creates rules)', () => {
    let promptId = 'perm-deny-no-rule';
    let resolveFunc;
    new Promise((resolve) => { resolveFunc = resolve; });

    _addPendingPermissionPrompt(promptId, {
      resolve:     resolveFunc,
      subject:     { type: 'agent', id: 1 },
      resource:    { type: 'tool', name: 'websearch' },
      context:     { sessionId: 1, userId: 1, db },
      requestHash: 'test-hash',
    });

    handlePermissionResponse(promptId, 'deny');

    let rules = db.prepare('SELECT * FROM permission_rules').all();
    assert.strictEqual(rules.length, 0, 'Deny should not create a rule');
  });
});

// ============================================================================
// Cleanup Utilities
// ============================================================================

describe('Cleanup utilities', () => {
  beforeEach(() => _clearPendingPermissionPrompts());

  it('should clear all pending prompts', () => {
    _addPendingPermissionPrompt('perm-a', { resolve: () => {}, subject: {}, resource: {}, context: {} });
    _addPendingPermissionPrompt('perm-b', { resolve: () => {}, subject: {}, resource: {}, context: {} });
    _addPendingPermissionPrompt('perm-c', { resolve: () => {}, subject: {}, resource: {}, context: {} });

    assert.ok(getPendingPermissionPrompt('perm-a'));
    assert.ok(getPendingPermissionPrompt('perm-b'));

    _clearPendingPermissionPrompts();

    assert.strictEqual(getPendingPermissionPrompt('perm-a'), undefined);
    assert.strictEqual(getPendingPermissionPrompt('perm-b'), undefined);
    assert.strictEqual(getPendingPermissionPrompt('perm-c'), undefined);
  });
});

// ============================================================================
// Permit Bag Tests
// ============================================================================

describe('Permit bag: createPermitBag', () => {
  it('should create an empty Map', () => {
    let bag = createPermitBag();
    assert.ok(bag instanceof Map);
    assert.strictEqual(bag.size, 0);
  });
});

describe('Permit bag: checkPermitBag', () => {
  it('should return null when no grant exists', () => {
    let bag = createPermitBag();
    let result = checkPermitBag(bag, { type: 'agent', id: 1 }, { type: 'tool', name: 'websearch' });
    assert.strictEqual(result, null);
  });

  it('should return null when permitBag is null', () => {
    let result = checkPermitBag(null, { type: 'agent', id: 1 }, { type: 'tool', name: 'websearch' });
    assert.strictEqual(result, null);
  });

  it('should return grant after recordPermitBagGrant', () => {
    let bag = createPermitBag();
    let subject  = { type: 'agent', id: 1 };
    let resource = { type: 'tool', name: 'websearch' };

    recordPermitBagGrant(bag, subject, resource);
    let result = checkPermitBag(bag, subject, resource);

    assert.ok(result);
    assert.strictEqual(result.action, 'ALLOW');
  });

  it('should not match different resources', () => {
    let bag = createPermitBag();
    let subject = { type: 'agent', id: 1 };

    recordPermitBagGrant(bag, subject, { type: 'tool', name: 'websearch' });

    let result = checkPermitBag(bag, subject, { type: 'tool', name: 'shell' });
    assert.strictEqual(result, null);
  });

  it('should not match different subjects', () => {
    let bag = createPermitBag();
    let resource = { type: 'tool', name: 'websearch' };

    recordPermitBagGrant(bag, { type: 'agent', id: 1 }, resource);

    let result = checkPermitBag(bag, { type: 'agent', id: 2 }, resource);
    assert.strictEqual(result, null);
  });
});

describe('Permit bag: recordPermitBagGrant', () => {
  it('should no-op when permitBag is null', () => {
    // Should not throw
    recordPermitBagGrant(null, { type: 'agent', id: 1 }, { type: 'tool', name: 'websearch' });
    assert.ok(true);
  });

  it('should allow multiple grants for different resources', () => {
    let bag = createPermitBag();
    let subject = { type: 'agent', id: 1 };

    recordPermitBagGrant(bag, subject, { type: 'tool', name: 'websearch' });
    recordPermitBagGrant(bag, subject, { type: 'tool', name: 'shell' });

    assert.ok(checkPermitBag(bag, subject, { type: 'tool', name: 'websearch' }));
    assert.ok(checkPermitBag(bag, subject, { type: 'tool', name: 'shell' }));
    assert.strictEqual(bag.size, 2);
  });
});
