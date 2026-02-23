'use strict';

// ============================================================================
// X4: Error Handling End-to-End Tests
// ============================================================================
// Tests for fail-safe behavior across permission, frame, and delegation paths.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// ============================================================================
// ERR-001: Permission engine fail-safe
// ============================================================================

describe('X4: Permission engine fail-safe', () => {
  let db;
  let evaluate, createRule, Action;

  beforeEach(async () => {
    let Database = (await import('better-sqlite3')).default;
    db = new Database(':memory:');

    db.exec(`
      CREATE TABLE permission_rules (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_id       INTEGER,
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
    `);

    // Enable audit test mode to prevent DB writes
    let { _enableTestMode } = await import('../../server/lib/audit.mjs');
    _enableTestMode();

    let perms = await import('../../server/lib/permissions/index.mjs');
    evaluate   = perms.evaluate;
    createRule = perms.createRule;
    Action     = perms.Action;
  });

  afterEach(async () => {
    let { _disableTestMode } = await import('../../server/lib/audit.mjs');
    _disableTestMode();
    if (db) db.close();
  });

  it('should return prompt (default) when no rules match', () => {
    let result = evaluate(
      { type: 'agent', id: 1 },
      { type: 'command', name: 'shell' },
      {},
      db,
    );
    assert.equal(result.action, 'prompt');
  });

  it('should return allow when allow rule matches', () => {
    createRule({
      subjectType:  'agent',
      subjectId:    1,
      resourceType: 'command',
      resourceName: 'grep',
      action:       'allow',
    }, db);

    let result = evaluate(
      { type: 'agent', id: 1 },
      { type: 'command', name: 'grep' },
      {},
      db,
    );
    assert.equal(result.action, 'allow');
  });

  it('should return deny when deny rule matches', () => {
    createRule({
      subjectType:  'agent',
      subjectId:    1,
      resourceType: 'command',
      resourceName: 'rm',
      action:       'deny',
    }, db);

    let result = evaluate(
      { type: 'agent', id: 1 },
      { type: 'command', name: 'rm' },
      {},
      db,
    );
    assert.equal(result.action, 'deny');
  });

  it('should handle malformed conditions JSON gracefully', () => {
    // Insert a rule with invalid JSON conditions directly
    db.prepare(`
      INSERT INTO permission_rules (subject_type, subject_id, resource_type, resource_name, action, conditions)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('agent', 1, 'command', 'test', 'allow', '{invalid json!!!');

    // Should not throw — malformed conditions treated as null (no conditions = match all)
    let result = evaluate(
      { type: 'agent', id: 1 },
      { type: 'command', name: 'test' },
      {},
      db,
    );
    assert.equal(result.action, 'allow');
  });
});

// ============================================================================
// ERR-002: Detector permission fail-safe (structural test)
// ============================================================================

describe('X4: Detector permission fail-safe', () => {
  it('should deny on permission error (not proceed)', async () => {
    let fs = await import('node:fs');
    let code = fs.readFileSync('server/lib/interactions/detector.mjs', 'utf8');

    // Verify the catch block denies instead of continuing
    assert.ok(
      code.includes("Permission check failed — denied for safety"),
      'detector.mjs should fail-safe to deny on permission errors',
    );

    // Verify it creates a denied result
    assert.ok(
      code.includes("status: 'denied'") && code.includes('permError'),
      'detector.mjs should create denied result on permission error',
    );
  });
});

// ============================================================================
// ERR-003: Command handler permission fail-safe
// ============================================================================

describe('X4: Command handler permission fail-safe', () => {
  it('should wrap evaluate() in try/catch', async () => {
    let fs = await import('node:fs');
    let code = fs.readFileSync('server/lib/messaging/command-handler.mjs', 'utf8');

    assert.ok(
      code.includes('permError') && code.includes('Fail-safe to deny'),
      'command-handler.mjs should catch permission errors and fail-safe to deny',
    );
  });
});

// ============================================================================
// ERR-004: Delegation timeout
// ============================================================================

describe('X4: Delegation timeout', () => {
  it('should have a timeout on agent.sendMessage in delegation', async () => {
    let fs = await import('node:fs');
    let code = fs.readFileSync('server/lib/interactions/functions/delegate.mjs', 'utf8');

    assert.ok(
      code.includes('DELEGATION_TIMEOUT_MS'),
      'delegate.mjs should define DELEGATION_TIMEOUT_MS',
    );
    assert.ok(
      code.includes('Promise.race'),
      'delegate.mjs should use Promise.race for timeout',
    );
    assert.ok(
      code.includes('Delegation timed out'),
      'delegate.mjs should have timeout error message',
    );
  });
});

// ============================================================================
// ERR-005: Frame creation resilience
// ============================================================================

describe('X4: Frame creation resilience', () => {
  it('should wrap user message frame creation in try/catch', async () => {
    let fs = await import('node:fs');
    let code = fs.readFileSync('server/routes/messages-stream.mjs', 'utf8');

    // Check that createUserMessageFrame is inside a try block
    let frameCreateIndex = code.indexOf('createUserMessageFrame({');
    let precedingCode    = code.substring(Math.max(0, frameCreateIndex - 100), frameCreateIndex);
    assert.ok(
      precedingCode.includes('try {'),
      'createUserMessageFrame should be wrapped in try/catch',
    );
  });

  it('should wrap session timestamp update in try/catch', async () => {
    let fs = await import('node:fs');
    let code = fs.readFileSync('server/routes/messages-stream.mjs', 'utf8');

    // Check that updated_at query has error handling
    assert.ok(
      code.includes('Failed to update session timestamp'),
      'session timestamp update should have error handling',
    );
  });

  it('should have try/catch around REQUEST frame creation in detector', async () => {
    let fs = await import('node:fs');
    let code = fs.readFileSync('server/lib/interactions/detector.mjs', 'utf8');

    assert.ok(
      code.includes('Failed to create REQUEST frame'),
      'detector should handle REQUEST frame creation errors',
    );
  });

  it('should have try/catch around RESULT frame creation in detector', async () => {
    let fs = await import('node:fs');
    let code = fs.readFileSync('server/lib/interactions/detector.mjs', 'utf8');

    assert.ok(
      code.includes('Failed to create RESULT frame'),
      'detector should handle RESULT frame creation errors',
    );
  });
});

// ============================================================================
// ERR-006: Safe JSON parsing in permissions
// ============================================================================

describe('X4: Safe JSON parsing', () => {
  it('should not throw on malformed conditions in permission rules', async () => {
    let Database = (await import('better-sqlite3')).default;
    let db = new Database(':memory:');

    db.exec(`
      CREATE TABLE permission_rules (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_id       INTEGER,
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
    `);

    // Enable audit test mode
    let { _enableTestMode, _disableTestMode } = await import('../../server/lib/audit.mjs');
    _enableTestMode();

    // Insert rule with corrupt JSON
    db.prepare(`
      INSERT INTO permission_rules (subject_type, resource_type, action, conditions)
      VALUES ('*', '*', 'allow', 'not valid json')
    `).run();

    let { listRules } = await import('../../server/lib/permissions/index.mjs');
    let rules;

    assert.doesNotThrow(() => {
      rules = listRules({}, db);
    });

    // Rule should still be returned, with conditions as null
    assert.equal(rules.length, 1);
    assert.equal(rules[0].conditions, null);

    _disableTestMode();
    db.close();
  });
});

// ============================================================================
// ERR-007: Stream error handling structure
// ============================================================================

describe('X4: Stream error handling structure', () => {
  it('should have outer catch-all error handler', async () => {
    let fs = await import('node:fs');
    let code = fs.readFileSync('server/routes/messages-stream.mjs', 'utf8');

    // The outer try/catch should create an error frame
    assert.ok(
      code.includes('getFriendlyErrorMessage'),
      'Should convert errors to user-friendly messages',
    );
  });

  it('should have aborted flag checked during streaming', async () => {
    let fs = await import('node:fs');
    let code = fs.readFileSync('server/routes/messages-stream.mjs', 'utf8');

    assert.ok(
      code.includes('if (aborted)'),
      'Should check aborted flag during stream loop',
    );
  });
});
