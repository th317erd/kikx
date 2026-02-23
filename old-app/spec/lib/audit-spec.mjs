'use strict';

// ============================================================================
// X2: Audit Logging Tests (AUDIT-001 through AUDIT-006)
// ============================================================================
// Tests for the audit module and all integration points.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  audit,
  AuditEvent,
  getAuditLogs,
  _enableTestMode,
  _disableTestMode,
  _getTestBuffer,
} from '../../server/lib/audit.mjs';

// ============================================================================
// AUDIT-001: AuditEvent enum
// ============================================================================

describe('X2: AuditEvent enum', () => {
  it('should export all expected event types', () => {
    assert.equal(AuditEvent.LOGIN_SUCCESS,    'login_success');
    assert.equal(AuditEvent.LOGIN_FAILURE,    'login_failure');
    assert.equal(AuditEvent.PERMISSION_ALLOW, 'permission_allow');
    assert.equal(AuditEvent.PERMISSION_DENY,  'permission_deny');
    assert.equal(AuditEvent.PERMISSION_PROMPT, 'permission_prompt');
    assert.equal(AuditEvent.API_KEY_CREATE,   'api_key_create');
    assert.equal(AuditEvent.API_KEY_REVOKE,   'api_key_revoke');
    assert.equal(AuditEvent.API_KEY_USE,      'api_key_use');
    assert.equal(AuditEvent.APPROVAL_GRANT,   'approval_grant');
    assert.equal(AuditEvent.APPROVAL_DENY,    'approval_deny');
  });

  it('should be frozen (immutable)', () => {
    assert.throws(() => { AuditEvent.NEW_EVENT = 'new'; }, TypeError);
  });

  it('should have exactly 10 event types', () => {
    assert.equal(Object.keys(AuditEvent).length, 10);
  });
});

// ============================================================================
// AUDIT-002: Test mode buffer
// ============================================================================

describe('X2: Test mode', () => {
  afterEach(() => {
    _disableTestMode();
  });

  it('should return a buffer array when enabled', () => {
    let buffer = _enableTestMode();
    assert.ok(Array.isArray(buffer));
    assert.equal(buffer.length, 0);
  });

  it('should capture audit entries in the buffer', () => {
    let buffer = _enableTestMode();
    audit('test_event', { foo: 'bar' });
    assert.equal(buffer.length, 1);
    assert.equal(buffer[0].event, 'test_event');
    assert.equal(buffer[0].foo, 'bar');
    assert.equal(buffer[0].audit, true);
    assert.ok(buffer[0].timestamp);
  });

  it('should capture multiple entries', () => {
    let buffer = _enableTestMode();
    audit('event_a', { a: 1 });
    audit('event_b', { b: 2 });
    audit('event_c', { c: 3 });
    assert.equal(buffer.length, 3);
    assert.equal(buffer[0].event, 'event_a');
    assert.equal(buffer[1].event, 'event_b');
    assert.equal(buffer[2].event, 'event_c');
  });

  it('should stop capturing after disable', () => {
    let buffer = _enableTestMode();
    audit('during_test', {});
    assert.equal(buffer.length, 1);
    _disableTestMode();
    // This goes to stdout, not buffer
    audit('after_test', {});
    assert.equal(buffer.length, 1);
  });

  it('should return null buffer when not in test mode', () => {
    assert.equal(_getTestBuffer(), null);
  });

  it('should return the buffer via _getTestBuffer', () => {
    _enableTestMode();
    assert.ok(Array.isArray(_getTestBuffer()));
    assert.strictEqual(_getTestBuffer(), _getTestBuffer());
  });

  it('should reset buffer on re-enable', () => {
    let buffer1 = _enableTestMode();
    audit('first', {});
    assert.equal(buffer1.length, 1);
    let buffer2 = _enableTestMode();
    assert.equal(buffer2.length, 0);
    assert.notStrictEqual(buffer1, buffer2);
  });
});

// ============================================================================
// AUDIT-003: audit() function structure
// ============================================================================

describe('X2: audit() entry structure', () => {
  let buffer;

  beforeEach(() => {
    buffer = _enableTestMode();
  });

  afterEach(() => {
    _disableTestMode();
  });

  it('should always include audit: true flag', () => {
    audit(AuditEvent.LOGIN_SUCCESS, {});
    assert.equal(buffer[0].audit, true);
  });

  it('should include the event type', () => {
    audit(AuditEvent.LOGIN_FAILURE, {});
    assert.equal(buffer[0].event, 'login_failure');
  });

  it('should include ISO timestamp', () => {
    audit(AuditEvent.API_KEY_CREATE, {});
    let ts = buffer[0].timestamp;
    assert.ok(ts);
    assert.ok(!isNaN(Date.parse(ts)), 'timestamp should be valid ISO date');
  });

  it('should spread details into the entry', () => {
    audit(AuditEvent.LOGIN_SUCCESS, {
      userId:   42,
      username: 'claude',
      ip:       '127.0.0.1',
    });
    assert.equal(buffer[0].userId, 42);
    assert.equal(buffer[0].username, 'claude');
    assert.equal(buffer[0].ip, '127.0.0.1');
  });

  it('should work with empty details', () => {
    audit(AuditEvent.PERMISSION_ALLOW);
    assert.equal(buffer[0].event, 'permission_allow');
    assert.equal(buffer[0].audit, true);
  });

  it('should handle nested objects in details', () => {
    audit(AuditEvent.PERMISSION_DENY, {
      subject:  { type: 'agent', id: 5 },
      resource: { type: 'command', name: 'shell' },
    });
    assert.deepStrictEqual(buffer[0].subject, { type: 'agent', id: 5 });
    assert.deepStrictEqual(buffer[0].resource, { type: 'command', name: 'shell' });
  });
});

// ============================================================================
// AUDIT-004: DB persistence
// ============================================================================

describe('X2: audit() DB persistence', () => {
  let db;

  beforeEach(async () => {
    // Import dynamically to get a fresh in-memory DB
    let Database = (await import('better-sqlite3')).default;
    db = new Database(':memory:');

    // Create the audit_logs table
    db.exec(`
      CREATE TABLE audit_logs (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp   TEXT DEFAULT CURRENT_TIMESTAMP,
        event_type  TEXT NOT NULL,
        user_id     INTEGER,
        agent_id    INTEGER,
        session_id  INTEGER,
        ip_address  TEXT,
        details     TEXT
      );
    `);
  });

  afterEach(() => {
    _disableTestMode();
    if (db) db.close();
  });

  it('should persist audit entry to database', () => {
    // Not in test mode — audit writes to DB
    _disableTestMode();
    audit(AuditEvent.LOGIN_SUCCESS, {
      userId:    1,
      agentId:   null,
      sessionId: 10,
      ipAddress: '192.168.1.1',
    }, db);

    let rows = db.prepare('SELECT * FROM audit_logs').all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].event_type, 'login_success');
    assert.equal(rows[0].user_id, 1);
    assert.equal(rows[0].session_id, 10);
    assert.equal(rows[0].ip_address, '192.168.1.1');
  });

  it('should store details as JSON', () => {
    _disableTestMode();
    audit(AuditEvent.PERMISSION_DENY, {
      userId:  2,
      subject: { type: 'agent', id: 5 },
    }, db);

    let row = db.prepare('SELECT details FROM audit_logs').get();
    let details = JSON.parse(row.details);
    assert.equal(details.userId, 2);
    assert.deepStrictEqual(details.subject, { type: 'agent', id: 5 });
  });

  it('should handle null optional fields', () => {
    _disableTestMode();
    audit(AuditEvent.API_KEY_CREATE, { userId: 3 }, db);

    let row = db.prepare('SELECT * FROM audit_logs').get();
    assert.equal(row.user_id, 3);
    assert.equal(row.agent_id, null);
    assert.equal(row.session_id, null);
    assert.equal(row.ip_address, null);
  });

  it('should not throw when DB write fails', () => {
    _disableTestMode();
    // Close DB to force an error
    db.close();
    // Should not throw
    assert.doesNotThrow(() => {
      audit(AuditEvent.LOGIN_FAILURE, { userId: 1 }, db);
    });
    db = null; // Prevent afterEach from closing again
  });
});

// ============================================================================
// AUDIT-005: getAuditLogs() query helper
// ============================================================================

describe('X2: getAuditLogs()', () => {
  let db;

  beforeEach(async () => {
    let Database = (await import('better-sqlite3')).default;
    db = new Database(':memory:');

    db.exec(`
      CREATE TABLE audit_logs (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp   TEXT DEFAULT CURRENT_TIMESTAMP,
        event_type  TEXT NOT NULL,
        user_id     INTEGER,
        agent_id    INTEGER,
        session_id  INTEGER,
        ip_address  TEXT,
        details     TEXT
      );
    `);

    // Seed some entries
    let insert = db.prepare(`
      INSERT INTO audit_logs (event_type, user_id, agent_id, session_id, ip_address, details)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    insert.run('login_success',    1, null, null, '127.0.0.1', '{"username":"claude"}');
    insert.run('login_failure',    null, null, null, '10.0.0.1', '{"username":"hacker"}');
    insert.run('permission_allow', 1, 5, 10, null, '{"ruleId":42}');
    insert.run('permission_deny',  1, 5, 10, null, '{"ruleId":43}');
    insert.run('api_key_create',   2, null, null, null, '{"keyId":7,"name":"my-key"}');
  });

  afterEach(() => {
    if (db) db.close();
  });

  it('should return all entries with no filters', () => {
    let logs = getAuditLogs({}, db);
    assert.equal(logs.length, 5);
  });

  it('should return entries in reverse chronological order (newest first)', () => {
    let logs = getAuditLogs({}, db);
    assert.ok(logs[0].id > logs[1].id);
  });

  it('should filter by eventType', () => {
    let logs = getAuditLogs({ eventType: 'login_success' }, db);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].eventType, 'login_success');
  });

  it('should filter by userId', () => {
    let logs = getAuditLogs({ userId: 2 }, db);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].eventType, 'api_key_create');
  });

  it('should filter by both eventType and userId', () => {
    let logs = getAuditLogs({ eventType: 'permission_allow', userId: 1 }, db);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].eventType, 'permission_allow');
  });

  it('should respect limit', () => {
    let logs = getAuditLogs({ limit: 2 }, db);
    assert.equal(logs.length, 2);
  });

  it('should default limit to 100', () => {
    let logs = getAuditLogs({}, db);
    assert.ok(logs.length <= 100);
  });

  it('should deserialize details JSON', () => {
    let logs = getAuditLogs({ eventType: 'api_key_create' }, db);
    assert.equal(logs[0].details.keyId, 7);
    assert.equal(logs[0].details.name, 'my-key');
  });

  it('should return camelCase field names', () => {
    let logs = getAuditLogs({ limit: 1 }, db);
    let entry = logs[0];
    assert.ok('id' in entry);
    assert.ok('timestamp' in entry);
    assert.ok('eventType' in entry);
    assert.ok('userId' in entry);
    assert.ok('agentId' in entry);
    assert.ok('sessionId' in entry);
    assert.ok('ipAddress' in entry);
    assert.ok('details' in entry);
  });

  it('should return empty array for no matches', () => {
    let logs = getAuditLogs({ eventType: 'nonexistent' }, db);
    assert.equal(logs.length, 0);
  });
});

// ============================================================================
// AUDIT-006: Integration point verification
// ============================================================================
// Structural tests to verify audit calls are wired in integration points.
// These import the source modules and check that audit is called correctly.

describe('X2: Integration points', () => {
  let buffer;

  beforeEach(() => {
    buffer = _enableTestMode();
  });

  afterEach(() => {
    _disableTestMode();
  });

  describe('permissions/index.mjs wiring', async () => {
    let evaluate, createRule;
    let db;

    beforeEach(async () => {
      let Database = (await import('better-sqlite3')).default;
      db = new Database(':memory:');

      // Create the permission_rules table
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

      let perms = await import('../../server/lib/permissions/index.mjs');
      evaluate   = perms.evaluate;
      createRule = perms.createRule;
    });

    afterEach(() => {
      if (db) db.close();
    });

    it('should audit PERMISSION_PROMPT when no rules match', () => {
      evaluate(
        { type: 'agent', id: 1 },
        { type: 'command', name: 'shell' },
        {},
        db,
      );

      let events = buffer.filter((e) => e.event === 'permission_prompt');
      assert.equal(events.length, 1);
      assert.equal(events[0].reason, 'no matching rules');
    });

    it('should audit PERMISSION_ALLOW when allow rule matches', () => {
      createRule({
        subjectType:  'agent',
        subjectId:    1,
        resourceType: 'command',
        resourceName: 'shell',
        action:       'allow',
      }, db);

      evaluate(
        { type: 'agent', id: 1 },
        { type: 'command', name: 'shell' },
        {},
        db,
      );

      let events = buffer.filter((e) => e.event === 'permission_allow');
      assert.equal(events.length, 1);
      assert.ok(events[0].ruleId);
    });

    it('should audit PERMISSION_DENY when deny rule matches', () => {
      createRule({
        subjectType:  'agent',
        subjectId:    2,
        resourceType: 'command',
        resourceName: 'rm',
        action:       'deny',
      }, db);

      evaluate(
        { type: 'agent', id: 2 },
        { type: 'command', name: 'rm' },
        {},
        db,
      );

      let events = buffer.filter((e) => e.event === 'permission_deny');
      assert.equal(events.length, 1);
    });
  });

  describe('abilities/approval.mjs wiring', () => {
    it('should audit APPROVAL_GRANT on approved response', async () => {
      let { handleApprovalResponse, _addPendingApproval } = await import('../../server/lib/abilities/approval.mjs');

      let executionId = 'test-audit-approve-' + Date.now();
      let resolved    = false;

      _addPendingApproval(executionId, {
        resolve:     () => { resolved = true; },
        ability:     { name: 'test-ability' },
        context:     { sessionId: 10 },
        userId:      1,
        agentId:     5,
        requestHash: 'abc123',
      });

      handleApprovalResponse(executionId, true, null, false, { userId: 1 });

      let events = buffer.filter((e) => e.event === 'approval_grant');
      assert.equal(events.length, 1);
      assert.equal(events[0].userId, 1);
      assert.equal(events[0].agentId, 5);
      assert.equal(events[0].abilityName, 'test-ability');
      assert.equal(events[0].executionId, executionId);
      assert.ok(resolved);
    });

    it('should audit APPROVAL_DENY on denied response', async () => {
      let { handleApprovalResponse, _addPendingApproval } = await import('../../server/lib/abilities/approval.mjs');

      let executionId = 'test-audit-deny-' + Date.now();
      let resolved    = false;

      _addPendingApproval(executionId, {
        resolve:     () => { resolved = true; },
        ability:     { name: 'test-ability-2' },
        context:     { sessionId: 20 },
        userId:      3,
        agentId:     7,
        requestHash: 'def456',
      });

      handleApprovalResponse(executionId, false, 'Too risky', false, { userId: 3 });

      let events = buffer.filter((e) => e.event === 'approval_deny');
      assert.equal(events.length, 1);
      assert.equal(events[0].userId, 3);
      assert.equal(events[0].agentId, 7);
      assert.equal(events[0].abilityName, 'test-ability-2');
      assert.equal(events[0].reason, 'Too risky');
      assert.ok(resolved);
    });

    it('should not audit when execution ID is unknown', async () => {
      let { handleApprovalResponse } = await import('../../server/lib/abilities/approval.mjs');

      handleApprovalResponse('nonexistent-id', true);

      let events = buffer.filter((e) =>
        e.event === 'approval_grant' || e.event === 'approval_deny',
      );
      assert.equal(events.length, 0);
    });
  });
});
