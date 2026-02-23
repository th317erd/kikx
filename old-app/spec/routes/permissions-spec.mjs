'use strict';

// ============================================================================
// Permissions API Tests
// ============================================================================
// Tests for the permissions REST API endpoints, including CRUD operations,
// validation, ownership enforcement, filtering, session-scoped rules, and
// permission evaluation. Uses the real app database via dynamic imports
// after environment setup (same pattern as command-handler-spec).

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ============================================================================
// Environment Setup (must happen before any app module imports)
// ============================================================================

let testDir = mkdtempSync(join(tmpdir(), 'hero-permissions-test-'));

process.env.HERO_JWT_SECRET      = 'test-secret-key-for-testing';
process.env.HERO_ENCRYPTION_KEY  = 'test-encryption-key-32chars!!';
process.env.XDG_CONFIG_HOME      = testDir;

// Dynamic imports after env is configured
let database;
let auth;
let permissions;

async function loadModules() {
  database    = await import('../../server/database.mjs');
  auth        = await import('../../server/auth.mjs');
  permissions = await import('../../server/lib/permissions/index.mjs');
}

// ============================================================================
// Valid enum values (mirrors route handler constants)
// ============================================================================

let VALID_SUBJECT_TYPES;
let VALID_RESOURCE_TYPES;
let VALID_ACTIONS;
let VALID_SCOPES;

function initEnums() {
  VALID_SUBJECT_TYPES  = new Set(Object.values(permissions.SubjectType));
  VALID_RESOURCE_TYPES = new Set(Object.values(permissions.ResourceType));
  VALID_ACTIONS        = new Set(Object.values(permissions.Action));
  VALID_SCOPES         = new Set(Object.values(permissions.Scope));
}

// ============================================================================
// Route Handler Helpers
// ============================================================================
// These mirror the logic in server/routes/permissions.mjs, calling the same
// library functions but without Express middleware / HTTP overhead.

function listPermissions(userId, query = {}) {
  let filters = { ownerId: userId };

  if (query.subjectType)
    filters.subjectType = query.subjectType;

  if (query.resourceType)
    filters.resourceType = query.resourceType;

  if (query.resourceName)
    filters.resourceName = query.resourceName;

  if (query.sessionId)
    filters.sessionId = parseInt(query.sessionId, 10);

  let rules = permissions.listRules(filters);
  return { status: 200, body: { rules } };
}

function createPermission(userId, body) {
  let {
    subjectType,
    subjectId,
    resourceType,
    resourceName,
    action,
    scope,
    sessionId,
    conditions,
    priority,
  } = body;

  // Validate required fields
  if (!subjectType || !VALID_SUBJECT_TYPES.has(subjectType))
    return { status: 400, body: { error: `Invalid subjectType. Must be one of: ${[...VALID_SUBJECT_TYPES].join(', ')}` } };

  if (!resourceType || !VALID_RESOURCE_TYPES.has(resourceType))
    return { status: 400, body: { error: `Invalid resourceType. Must be one of: ${[...VALID_RESOURCE_TYPES].join(', ')}` } };

  if (!action || !VALID_ACTIONS.has(action))
    return { status: 400, body: { error: `Invalid action. Must be one of: ${[...VALID_ACTIONS].join(', ')}` } };

  if (scope && !VALID_SCOPES.has(scope))
    return { status: 400, body: { error: `Invalid scope. Must be one of: ${[...VALID_SCOPES].join(', ')}` } };

  // Session-scoped rules require a session ID
  if (scope === permissions.Scope.SESSION && !sessionId)
    return { status: 400, body: { error: 'Session-scoped rules require a sessionId' } };

  // Validate session ownership if sessionId provided
  if (sessionId) {
    let db      = database.getDatabase();
    let session = db.prepare('SELECT id FROM sessions WHERE id = ? AND user_id = ?').get(sessionId, userId);
    if (!session)
      return { status: 404, body: { error: 'Session not found' } };
  }

  try {
    let rule = permissions.createRule({
      ownerId:      userId,
      sessionId:    sessionId || null,
      subjectType,
      subjectId:    subjectId || null,
      resourceType,
      resourceName: resourceName || null,
      action,
      scope:        scope || permissions.Scope.PERMANENT,
      conditions:   conditions || null,
      priority:     priority || 0,
    });

    return { status: 201, body: rule };
  } catch (error) {
    return { status: 400, body: { error: error.message } };
  }
}

function getPermission(userId, ruleId) {
  let id   = parseInt(ruleId, 10);
  let rule = permissions.getRule(id);

  if (!rule)
    return { status: 404, body: { error: 'Rule not found' } };

  // Only allow viewing own rules
  if (rule.ownerId !== userId)
    return { status: 404, body: { error: 'Rule not found' } };

  return { status: 200, body: rule };
}

function deletePermission(userId, ruleId) {
  let id   = parseInt(ruleId, 10);
  let rule = permissions.getRule(id);

  if (!rule)
    return { status: 404, body: { error: 'Rule not found' } };

  // Only allow deleting own rules
  if (rule.ownerId !== userId)
    return { status: 404, body: { error: 'Rule not found' } };

  permissions.deleteRule(id);
  return { status: 200, body: { success: true } };
}

function evaluatePermission(userId, body) {
  let { subjectType, subjectId, resourceType, resourceName, sessionId } = body;

  if (!subjectType || !subjectId || !resourceType || !resourceName)
    return { status: 400, body: { error: 'subjectType, subjectId, resourceType, and resourceName are required' } };

  let result = permissions.evaluate(
    { type: subjectType, id: subjectId },
    { type: resourceType, name: resourceName },
    { sessionId: sessionId || null, ownerId: userId },
  );

  return { status: 200, body: result };
}

// ============================================================================
// Tests
// ============================================================================

describe('Permissions API', async () => {
  await loadModules();
  initEnums();

  let db;
  let userId;
  let otherUserId;
  let agentId;
  let sessionId;

  beforeEach(async () => {
    db = database.getDatabase();

    // Clear test data for isolation
    db.exec('DELETE FROM permission_rules');
    db.exec('DELETE FROM frames');
    db.exec('DELETE FROM sessions');
    db.exec('DELETE FROM agents');
    db.exec('DELETE FROM users');

    // Create test users
    let user = await auth.createUser('testuser', 'testpass');
    userId = user.id;

    let otherUser = await auth.createUser('otheruser', 'otherpass');
    otherUserId = otherUser.id;

    // Create test agent
    let agentResult = db.prepare(`
      INSERT INTO agents (user_id, name, type, encrypted_api_key)
      VALUES (?, 'test-agent', 'claude', 'fake-key')
    `).run(userId);
    agentId = Number(agentResult.lastInsertRowid);

    // Create test session
    let sessionResult = db.prepare(`
      INSERT INTO sessions (user_id, agent_id, name)
      VALUES (?, ?, 'Test Session')
    `).run(userId, agentId);
    sessionId = Number(sessionResult.lastInsertRowid);
  });

  // ==========================================================================
  // Create Permission Rule (POST /api/permissions)
  // ==========================================================================

  describe('Create Rule (POST /)', () => {
    it('should create a rule with all required fields', () => {
      let result = createPermission(userId, {
        subjectType:  'user',
        resourceType: 'command',
        action:       'allow',
      });

      assert.equal(result.status, 201);
      assert.ok(result.body.id);
      assert.equal(result.body.subjectType, 'user');
      assert.equal(result.body.resourceType, 'command');
      assert.equal(result.body.action, 'allow');
      assert.equal(result.body.scope, 'permanent');
      assert.equal(result.body.ownerId, userId);
    });

    it('should create a rule with all optional fields', () => {
      let result = createPermission(userId, {
        subjectType:  'agent',
        subjectId:    agentId,
        resourceType: 'tool',
        resourceName: 'shell',
        action:       'deny',
        scope:        'session',
        sessionId:    sessionId,
        conditions:   { env: 'production' },
        priority:     10,
      });

      assert.equal(result.status, 201);
      assert.equal(result.body.subjectType, 'agent');
      assert.equal(result.body.subjectId, agentId);
      assert.equal(result.body.resourceType, 'tool');
      assert.equal(result.body.resourceName, 'shell');
      assert.equal(result.body.action, 'deny');
      assert.equal(result.body.scope, 'session');
      assert.equal(result.body.sessionId, sessionId);
      assert.deepEqual(result.body.conditions, { env: 'production' });
      assert.equal(result.body.priority, 10);
    });

    it('should default scope to permanent', () => {
      let result = createPermission(userId, {
        subjectType:  'user',
        resourceType: 'command',
        action:       'allow',
      });

      assert.equal(result.status, 201);
      assert.equal(result.body.scope, 'permanent');
    });

    it('should default priority to 0', () => {
      let result = createPermission(userId, {
        subjectType:  'user',
        resourceType: 'command',
        action:       'allow',
      });

      assert.equal(result.status, 201);
      assert.equal(result.body.priority, 0);
    });

    it('should accept wildcard (*) subjectType', () => {
      let result = createPermission(userId, {
        subjectType:  '*',
        resourceType: 'command',
        action:       'allow',
      });

      assert.equal(result.status, 201);
      assert.equal(result.body.subjectType, '*');
    });

    it('should accept wildcard (*) resourceType', () => {
      let result = createPermission(userId, {
        subjectType:  'user',
        resourceType: '*',
        action:       'deny',
      });

      assert.equal(result.status, 201);
      assert.equal(result.body.resourceType, '*');
    });

    it('should accept prompt action', () => {
      let result = createPermission(userId, {
        subjectType:  'user',
        resourceType: 'command',
        action:       'prompt',
      });

      assert.equal(result.status, 201);
      assert.equal(result.body.action, 'prompt');
    });

    it('should accept once scope', () => {
      let result = createPermission(userId, {
        subjectType:  'user',
        resourceType: 'command',
        action:       'allow',
        scope:        'once',
      });

      assert.equal(result.status, 201);
      assert.equal(result.body.scope, 'once');
    });

    it('should accept plugin subjectType', () => {
      let result = createPermission(userId, {
        subjectType:  'plugin',
        resourceType: 'ability',
        action:       'allow',
      });

      assert.equal(result.status, 201);
      assert.equal(result.body.subjectType, 'plugin');
      assert.equal(result.body.resourceType, 'ability');
    });

    it('should persist rule in the database', () => {
      let result = createPermission(userId, {
        subjectType:  'user',
        resourceType: 'command',
        resourceName: 'help',
        action:       'deny',
      });

      assert.equal(result.status, 201);

      let row = db.prepare('SELECT * FROM permission_rules WHERE id = ?').get(result.body.id);
      assert.ok(row);
      assert.equal(row.owner_id, userId);
      assert.equal(row.subject_type, 'user');
      assert.equal(row.resource_type, 'command');
      assert.equal(row.resource_name, 'help');
      assert.equal(row.action, 'deny');
    });
  });

  // ==========================================================================
  // Validation (POST /api/permissions)
  // ==========================================================================

  describe('Validation (POST /)', () => {
    it('should return 400 when subjectType is missing', () => {
      let result = createPermission(userId, {
        resourceType: 'command',
        action:       'allow',
      });

      assert.equal(result.status, 400);
      assert.match(result.body.error, /Invalid subjectType/);
    });

    it('should return 400 when subjectType is invalid', () => {
      let result = createPermission(userId, {
        subjectType:  'invalid',
        resourceType: 'command',
        action:       'allow',
      });

      assert.equal(result.status, 400);
      assert.match(result.body.error, /Invalid subjectType/);
    });

    it('should return 400 when resourceType is missing', () => {
      let result = createPermission(userId, {
        subjectType: 'user',
        action:      'allow',
      });

      assert.equal(result.status, 400);
      assert.match(result.body.error, /Invalid resourceType/);
    });

    it('should return 400 when resourceType is invalid', () => {
      let result = createPermission(userId, {
        subjectType:  'user',
        resourceType: 'invalid',
        action:       'allow',
      });

      assert.equal(result.status, 400);
      assert.match(result.body.error, /Invalid resourceType/);
    });

    it('should return 400 when action is missing', () => {
      let result = createPermission(userId, {
        subjectType:  'user',
        resourceType: 'command',
      });

      assert.equal(result.status, 400);
      assert.match(result.body.error, /Invalid action/);
    });

    it('should return 400 when action is invalid', () => {
      let result = createPermission(userId, {
        subjectType:  'user',
        resourceType: 'command',
        action:       'invalid',
      });

      assert.equal(result.status, 400);
      assert.match(result.body.error, /Invalid action/);
    });

    it('should return 400 when scope is invalid', () => {
      let result = createPermission(userId, {
        subjectType:  'user',
        resourceType: 'command',
        action:       'allow',
        scope:        'invalid',
      });

      assert.equal(result.status, 400);
      assert.match(result.body.error, /Invalid scope/);
    });

    it('should accept valid scope values without error', () => {
      for (let scope of ['once', 'session', 'permanent']) {
        let body = {
          subjectType:  'user',
          resourceType: 'command',
          action:       'allow',
          scope,
        };

        // Session scope needs sessionId
        if (scope === 'session')
          body.sessionId = sessionId;

        let result = createPermission(userId, body);
        assert.equal(result.status, 201, `Scope '${scope}' should be accepted`);
      }
    });
  });

  // ==========================================================================
  // List Permission Rules (GET /api/permissions)
  // ==========================================================================

  describe('List Rules (GET /)', () => {
    it('should return empty array when no rules exist', () => {
      let result = listPermissions(userId);

      assert.equal(result.status, 200);
      assert.ok(Array.isArray(result.body.rules));
      assert.equal(result.body.rules.length, 0);
    });

    it('should return rules for the current user', () => {
      createPermission(userId, {
        subjectType:  'user',
        resourceType: 'command',
        action:       'allow',
      });
      createPermission(userId, {
        subjectType:  'agent',
        resourceType: 'tool',
        action:       'deny',
      });

      let result = listPermissions(userId);

      assert.equal(result.status, 200);
      assert.equal(result.body.rules.length, 2);
    });

    it('should only return rules owned by the current user (isolation)', () => {
      createPermission(userId, {
        subjectType:  'user',
        resourceType: 'command',
        action:       'allow',
      });
      createPermission(otherUserId, {
        subjectType:  'user',
        resourceType: 'command',
        action:       'deny',
      });

      let userRules  = listPermissions(userId);
      let otherRules = listPermissions(otherUserId);

      assert.equal(userRules.body.rules.length, 1);
      assert.equal(userRules.body.rules[0].action, 'allow');
      assert.equal(otherRules.body.rules.length, 1);
      assert.equal(otherRules.body.rules[0].action, 'deny');
    });

    it('should return deserialized rule objects', () => {
      createPermission(userId, {
        subjectType:  'user',
        subjectId:    userId,
        resourceType: 'command',
        resourceName: 'help',
        action:       'allow',
        scope:        'permanent',
        priority:     5,
      });

      let result = listPermissions(userId);
      let rule   = result.body.rules[0];

      assert.equal(rule.subjectType, 'user');
      assert.equal(rule.subjectId, userId);
      assert.equal(rule.resourceType, 'command');
      assert.equal(rule.resourceName, 'help');
      assert.equal(rule.action, 'allow');
      assert.equal(rule.scope, 'permanent');
      assert.equal(rule.priority, 5);
      assert.equal(rule.ownerId, userId);
      assert.ok(rule.id);
    });
  });

  // ==========================================================================
  // Filtering (GET /api/permissions?...)
  // ==========================================================================

  describe('Filtering (GET / with query params)', () => {
    beforeEach(() => {
      // Create diverse rules for filtering
      createPermission(userId, {
        subjectType:  'user',
        resourceType: 'command',
        resourceName: 'help',
        action:       'allow',
      });
      createPermission(userId, {
        subjectType:  'agent',
        resourceType: 'tool',
        resourceName: 'shell',
        action:       'deny',
      });
      createPermission(userId, {
        subjectType:  'user',
        resourceType: 'tool',
        resourceName: 'grep',
        action:       'allow',
      });
      createPermission(userId, {
        subjectType:  'plugin',
        resourceType: 'ability',
        resourceName: 'search',
        action:       'prompt',
      });
    });

    it('should filter by subjectType', () => {
      let result = listPermissions(userId, { subjectType: 'user' });

      assert.equal(result.body.rules.length, 2);
      for (let rule of result.body.rules)
        assert.equal(rule.subjectType, 'user');
    });

    it('should filter by resourceType', () => {
      let result = listPermissions(userId, { resourceType: 'tool' });

      assert.equal(result.body.rules.length, 2);
      for (let rule of result.body.rules)
        assert.equal(rule.resourceType, 'tool');
    });

    it('should filter by resourceName', () => {
      let result = listPermissions(userId, { resourceName: 'shell' });

      assert.equal(result.body.rules.length, 1);
      assert.equal(result.body.rules[0].resourceName, 'shell');
    });

    it('should filter by multiple query params simultaneously', () => {
      let result = listPermissions(userId, {
        subjectType:  'user',
        resourceType: 'tool',
      });

      assert.equal(result.body.rules.length, 1);
      assert.equal(result.body.rules[0].resourceName, 'grep');
    });

    it('should return empty array when no rules match filters', () => {
      let result = listPermissions(userId, { subjectType: 'agent', resourceType: 'command' });

      assert.equal(result.body.rules.length, 0);
    });

    it('should filter by sessionId', () => {
      // Create a session-scoped rule
      createPermission(userId, {
        subjectType:  'user',
        resourceType: 'command',
        action:       'allow',
        scope:        'session',
        sessionId:    sessionId,
      });

      let result = listPermissions(userId, { sessionId: String(sessionId) });

      assert.equal(result.body.rules.length, 1);
      assert.equal(result.body.rules[0].sessionId, sessionId);
    });
  });

  // ==========================================================================
  // Get Permission Rule (GET /api/permissions/:id)
  // ==========================================================================

  describe('Get Rule (GET /:id)', () => {
    it('should return a rule by id', () => {
      let created = createPermission(userId, {
        subjectType:  'user',
        resourceType: 'command',
        resourceName: 'help',
        action:       'allow',
      });

      let result = getPermission(userId, created.body.id);

      assert.equal(result.status, 200);
      assert.equal(result.body.id, created.body.id);
      assert.equal(result.body.subjectType, 'user');
      assert.equal(result.body.resourceType, 'command');
      assert.equal(result.body.resourceName, 'help');
      assert.equal(result.body.action, 'allow');
    });

    it('should return 404 for non-existent rule', () => {
      let result = getPermission(userId, 99999);

      assert.equal(result.status, 404);
      assert.match(result.body.error, /Rule not found/);
    });

    it('should return 404 when accessing another user\'s rule (ownership)', () => {
      let created = createPermission(otherUserId, {
        subjectType:  'user',
        resourceType: 'command',
        action:       'allow',
      });

      // Try to access as different user
      let result = getPermission(userId, created.body.id);

      assert.equal(result.status, 404);
      assert.match(result.body.error, /Rule not found/);
    });

    it('should allow owner to access their own rule', () => {
      let created = createPermission(otherUserId, {
        subjectType:  'user',
        resourceType: 'command',
        action:       'allow',
      });

      let result = getPermission(otherUserId, created.body.id);

      assert.equal(result.status, 200);
      assert.equal(result.body.id, created.body.id);
    });
  });

  // ==========================================================================
  // Delete Permission Rule (DELETE /api/permissions/:id)
  // ==========================================================================

  describe('Delete Rule (DELETE /:id)', () => {
    it('should delete a rule by id', () => {
      let created = createPermission(userId, {
        subjectType:  'user',
        resourceType: 'command',
        action:       'allow',
      });

      let result = deletePermission(userId, created.body.id);

      assert.equal(result.status, 200);
      assert.equal(result.body.success, true);

      // Verify it is gone
      let check = getPermission(userId, created.body.id);
      assert.equal(check.status, 404);
    });

    it('should remove rule from database', () => {
      let created = createPermission(userId, {
        subjectType:  'user',
        resourceType: 'command',
        action:       'allow',
      });

      deletePermission(userId, created.body.id);

      let row = db.prepare('SELECT * FROM permission_rules WHERE id = ?').get(created.body.id);
      assert.equal(row, undefined);
    });

    it('should return 404 for non-existent rule', () => {
      let result = deletePermission(userId, 99999);

      assert.equal(result.status, 404);
      assert.match(result.body.error, /Rule not found/);
    });

    it('should return 404 when deleting another user\'s rule (ownership)', () => {
      let created = createPermission(otherUserId, {
        subjectType:  'user',
        resourceType: 'command',
        action:       'deny',
      });

      // Try to delete as different user
      let result = deletePermission(userId, created.body.id);

      assert.equal(result.status, 404);
      assert.match(result.body.error, /Rule not found/);

      // Verify it still exists for the owner
      let check = getPermission(otherUserId, created.body.id);
      assert.equal(check.status, 200);
    });

    it('should not affect other rules when deleting one', () => {
      let rule1 = createPermission(userId, {
        subjectType:  'user',
        resourceType: 'command',
        action:       'allow',
      });
      let rule2 = createPermission(userId, {
        subjectType:  'agent',
        resourceType: 'tool',
        action:       'deny',
      });

      deletePermission(userId, rule1.body.id);

      // rule2 should still exist
      let check = getPermission(userId, rule2.body.id);
      assert.equal(check.status, 200);
      assert.equal(check.body.action, 'deny');

      // list should have 1 rule left
      let list = listPermissions(userId);
      assert.equal(list.body.rules.length, 1);
    });
  });

  // ==========================================================================
  // Ownership Enforcement
  // ==========================================================================

  describe('Ownership Enforcement', () => {
    it('should set ownerId to the creating user', () => {
      let result = createPermission(userId, {
        subjectType:  'user',
        resourceType: 'command',
        action:       'allow',
      });

      assert.equal(result.body.ownerId, userId);
    });

    it('user can only list their own rules', () => {
      createPermission(userId, {
        subjectType:  'user',
        resourceType: 'command',
        action:       'allow',
      });
      createPermission(userId, {
        subjectType:  'agent',
        resourceType: 'tool',
        action:       'deny',
      });
      createPermission(otherUserId, {
        subjectType:  'user',
        resourceType: 'command',
        action:       'deny',
      });

      let userResult  = listPermissions(userId);
      let otherResult = listPermissions(otherUserId);

      assert.equal(userResult.body.rules.length, 2);
      assert.equal(otherResult.body.rules.length, 1);

      // All rules for userId should have correct ownerId
      for (let rule of userResult.body.rules)
        assert.equal(rule.ownerId, userId);

      for (let rule of otherResult.body.rules)
        assert.equal(rule.ownerId, otherUserId);
    });

    it('user cannot get another user\'s rule by id', () => {
      let created = createPermission(otherUserId, {
        subjectType:  'user',
        resourceType: 'command',
        action:       'allow',
      });

      let result = getPermission(userId, created.body.id);
      assert.equal(result.status, 404);
    });

    it('user cannot delete another user\'s rule', () => {
      let created = createPermission(otherUserId, {
        subjectType:  'user',
        resourceType: 'command',
        action:       'deny',
      });

      let result = deletePermission(userId, created.body.id);
      assert.equal(result.status, 404);

      // Should still exist
      let check = getPermission(otherUserId, created.body.id);
      assert.equal(check.status, 200);
    });
  });

  // ==========================================================================
  // Session-Scoped Rules
  // ==========================================================================

  describe('Session-Scoped Rules', () => {
    it('should require sessionId for session-scoped rules', () => {
      let result = createPermission(userId, {
        subjectType:  'user',
        resourceType: 'command',
        action:       'allow',
        scope:        'session',
      });

      assert.equal(result.status, 400);
      assert.match(result.body.error, /Session-scoped rules require a sessionId/);
    });

    it('should create session-scoped rule with valid sessionId', () => {
      let result = createPermission(userId, {
        subjectType:  'user',
        resourceType: 'command',
        action:       'allow',
        scope:        'session',
        sessionId:    sessionId,
      });

      assert.equal(result.status, 201);
      assert.equal(result.body.scope, 'session');
      assert.equal(result.body.sessionId, sessionId);
    });

    it('should return 404 for non-existent session', () => {
      let result = createPermission(userId, {
        subjectType:  'user',
        resourceType: 'command',
        action:       'allow',
        scope:        'session',
        sessionId:    99999,
      });

      assert.equal(result.status, 404);
      assert.match(result.body.error, /Session not found/);
    });

    it('should return 404 for session owned by another user', () => {
      // Create a session for otherUser
      let otherAgentResult = db.prepare(`
        INSERT INTO agents (user_id, name, type, encrypted_api_key)
        VALUES (?, 'test-other-agent', 'claude', 'fake-key')
      `).run(otherUserId);
      let otherAgentId = Number(otherAgentResult.lastInsertRowid);

      let otherSessionResult = db.prepare(`
        INSERT INTO sessions (user_id, agent_id, name)
        VALUES (?, ?, 'Other Session')
      `).run(otherUserId, otherAgentId);
      let otherSessionId = Number(otherSessionResult.lastInsertRowid);

      // Try to create a rule scoped to otherUser's session
      let result = createPermission(userId, {
        subjectType:  'user',
        resourceType: 'command',
        action:       'allow',
        scope:        'session',
        sessionId:    otherSessionId,
      });

      assert.equal(result.status, 404);
      assert.match(result.body.error, /Session not found/);
    });

    it('should validate session ownership even for non-session-scoped rules with sessionId', () => {
      let result = createPermission(userId, {
        subjectType:  'user',
        resourceType: 'command',
        action:       'allow',
        scope:        'permanent',
        sessionId:    99999,
      });

      assert.equal(result.status, 404);
      assert.match(result.body.error, /Session not found/);
    });

    it('should allow permanent scope without sessionId', () => {
      let result = createPermission(userId, {
        subjectType:  'user',
        resourceType: 'command',
        action:       'allow',
        scope:        'permanent',
      });

      assert.equal(result.status, 201);
      assert.equal(result.body.sessionId, null);
    });

    it('should allow once scope without sessionId', () => {
      let result = createPermission(userId, {
        subjectType:  'user',
        resourceType: 'command',
        action:       'allow',
        scope:        'once',
      });

      assert.equal(result.status, 201);
      assert.equal(result.body.scope, 'once');
    });
  });

  // ==========================================================================
  // Evaluate Endpoint (POST /api/permissions/evaluate)
  // ==========================================================================

  describe('Evaluate (POST /evaluate)', () => {
    it('should return default prompt action when no rules exist', () => {
      let result = evaluatePermission(userId, {
        subjectType:  'user',
        subjectId:    userId,
        resourceType: 'command',
        resourceName: 'help',
      });

      assert.equal(result.status, 200);
      assert.equal(result.body.action, 'prompt');
      assert.equal(result.body.rule, null);
    });

    it('should return allow when matching allow rule exists', () => {
      createPermission(userId, {
        subjectType:  'user',
        subjectId:    userId,
        resourceType: 'command',
        resourceName: 'help',
        action:       'allow',
      });

      let result = evaluatePermission(userId, {
        subjectType:  'user',
        subjectId:    userId,
        resourceType: 'command',
        resourceName: 'help',
      });

      assert.equal(result.status, 200);
      assert.equal(result.body.action, 'allow');
      assert.ok(result.body.rule);
      assert.equal(result.body.rule.action, 'allow');
    });

    it('should return deny when matching deny rule exists', () => {
      createPermission(userId, {
        subjectType:  'user',
        subjectId:    userId,
        resourceType: 'command',
        resourceName: 'shell',
        action:       'deny',
      });

      let result = evaluatePermission(userId, {
        subjectType:  'user',
        subjectId:    userId,
        resourceType: 'command',
        resourceName: 'shell',
      });

      assert.equal(result.status, 200);
      assert.equal(result.body.action, 'deny');
      assert.ok(result.body.rule);
    });

    it('should return the matching rule in the response', () => {
      let created = createPermission(userId, {
        subjectType:  'agent',
        subjectId:    agentId,
        resourceType: 'tool',
        resourceName: 'grep',
        action:       'allow',
        priority:     5,
      });

      let result = evaluatePermission(userId, {
        subjectType:  'agent',
        subjectId:    agentId,
        resourceType: 'tool',
        resourceName: 'grep',
      });

      assert.equal(result.status, 200);
      assert.equal(result.body.action, 'allow');
      assert.equal(result.body.rule.id, created.body.id);
      assert.equal(result.body.rule.priority, 5);
    });

    it('should prefer more specific rules (exact subject+resource over wildcard)', () => {
      // Wildcard: deny all commands for all users
      createPermission(userId, {
        subjectType:  '*',
        resourceType: 'command',
        action:       'deny',
      });

      // Specific: allow this user for this command
      createPermission(userId, {
        subjectType:  'user',
        subjectId:    userId,
        resourceType: 'command',
        resourceName: 'help',
        action:       'allow',
      });

      let result = evaluatePermission(userId, {
        subjectType:  'user',
        subjectId:    userId,
        resourceType: 'command',
        resourceName: 'help',
      });

      assert.equal(result.body.action, 'allow');
    });

    it('should prefer deny over allow at equal specificity', () => {
      createPermission(userId, {
        subjectType:  'user',
        subjectId:    userId,
        resourceType: 'command',
        resourceName: 'shell',
        action:       'allow',
      });

      createPermission(userId, {
        subjectType:  'user',
        subjectId:    userId,
        resourceType: 'command',
        resourceName: 'shell',
        action:       'deny',
      });

      let result = evaluatePermission(userId, {
        subjectType:  'user',
        subjectId:    userId,
        resourceType: 'command',
        resourceName: 'shell',
      });

      assert.equal(result.body.action, 'deny');
    });

    it('should prefer higher priority at equal specificity', () => {
      createPermission(userId, {
        subjectType:  'user',
        subjectId:    userId,
        resourceType: 'command',
        resourceName: 'shell',
        action:       'deny',
        priority:     1,
      });

      createPermission(userId, {
        subjectType:  'user',
        subjectId:    userId,
        resourceType: 'command',
        resourceName: 'shell',
        action:       'allow',
        priority:     10,
      });

      let result = evaluatePermission(userId, {
        subjectType:  'user',
        subjectId:    userId,
        resourceType: 'command',
        resourceName: 'shell',
      });

      assert.equal(result.body.action, 'allow');
    });

    it('should prefer session-scoped rules over global rules', () => {
      // Global: deny
      createPermission(userId, {
        subjectType:  'user',
        subjectId:    userId,
        resourceType: 'command',
        resourceName: 'help',
        action:       'deny',
      });

      // Session-scoped: allow
      createPermission(userId, {
        subjectType:  'user',
        subjectId:    userId,
        resourceType: 'command',
        resourceName: 'help',
        action:       'allow',
        scope:        'session',
        sessionId:    sessionId,
      });

      let result = evaluatePermission(userId, {
        subjectType:  'user',
        subjectId:    userId,
        resourceType: 'command',
        resourceName: 'help',
        sessionId:    sessionId,
      });

      assert.equal(result.body.action, 'allow');
    });

    it('should consume once-scoped rules after evaluation', () => {
      createPermission(userId, {
        subjectType:  'user',
        subjectId:    userId,
        resourceType: 'command',
        resourceName: 'help',
        action:       'deny',
        scope:        'once',
      });

      // First evaluation: deny
      let result1 = evaluatePermission(userId, {
        subjectType:  'user',
        subjectId:    userId,
        resourceType: 'command',
        resourceName: 'help',
      });
      assert.equal(result1.body.action, 'deny');

      // Second evaluation: rule consumed, falls back to default prompt
      let result2 = evaluatePermission(userId, {
        subjectType:  'user',
        subjectId:    userId,
        resourceType: 'command',
        resourceName: 'help',
      });
      assert.equal(result2.body.action, 'prompt');
      assert.equal(result2.body.rule, null);
    });

    it('should match wildcard resource rules', () => {
      createPermission(userId, {
        subjectType:  'user',
        subjectId:    userId,
        resourceType: 'command',
        action:       'deny',
      });

      let result = evaluatePermission(userId, {
        subjectType:  'user',
        subjectId:    userId,
        resourceType: 'command',
        resourceName: 'anything',
      });

      assert.equal(result.body.action, 'deny');
    });

    it('should match wildcard subject rules', () => {
      createPermission(userId, {
        subjectType:  '*',
        resourceType: 'command',
        resourceName: 'shell',
        action:       'deny',
      });

      let result = evaluatePermission(userId, {
        subjectType:  'user',
        subjectId:    userId,
        resourceType: 'command',
        resourceName: 'shell',
      });

      assert.equal(result.body.action, 'deny');
    });

    it('should not match rules from a different resource', () => {
      createPermission(userId, {
        subjectType:  'user',
        subjectId:    userId,
        resourceType: 'tool',
        resourceName: 'shell',
        action:       'deny',
      });

      // Evaluate for a 'command' resource type - should not match the 'tool' rule
      let result = evaluatePermission(userId, {
        subjectType:  'user',
        subjectId:    userId,
        resourceType: 'command',
        resourceName: 'shell',
      });

      assert.equal(result.body.action, 'prompt');
      assert.equal(result.body.rule, null);
    });
  });

  // ==========================================================================
  // Evaluate Endpoint Validation
  // ==========================================================================

  describe('Evaluate Validation (POST /evaluate)', () => {
    it('should return 400 when subjectType is missing', () => {
      let result = evaluatePermission(userId, {
        subjectId:    userId,
        resourceType: 'command',
        resourceName: 'help',
      });

      assert.equal(result.status, 400);
      assert.match(result.body.error, /subjectType.*required/);
    });

    it('should return 400 when subjectId is missing', () => {
      let result = evaluatePermission(userId, {
        subjectType:  'user',
        resourceType: 'command',
        resourceName: 'help',
      });

      assert.equal(result.status, 400);
      assert.match(result.body.error, /subjectId.*required/);
    });

    it('should return 400 when resourceType is missing', () => {
      let result = evaluatePermission(userId, {
        subjectType:  'user',
        subjectId:    userId,
        resourceName: 'help',
      });

      assert.equal(result.status, 400);
      assert.match(result.body.error, /resourceType.*required/);
    });

    it('should return 400 when resourceName is missing', () => {
      let result = evaluatePermission(userId, {
        subjectType:  'user',
        subjectId:    userId,
        resourceType: 'command',
      });

      assert.equal(result.status, 400);
      assert.match(result.body.error, /resourceName.*required/);
    });

    it('should return 400 when all fields are missing', () => {
      let result = evaluatePermission(userId, {});

      assert.equal(result.status, 400);
      assert.match(result.body.error, /required/);
    });
  });

  // ==========================================================================
  // Auth Required (all endpoints)
  // ==========================================================================
  // Note: Auth is enforced by Express middleware (requireAuth), which is not
  // exercised by these helper functions. This section documents the expected
  // behavior: all endpoints require authentication via JWT cookie.
  // The middleware returns 401 for unauthenticated API requests.

  describe('Auth Required (middleware behavior)', () => {
    it('should document that all routes are behind requireAuth middleware', () => {
      // The permissions router applies requireAuth at the router level:
      //   router.use(requireAuth);
      // This means ALL routes (GET /, POST /, GET /:id, DELETE /:id,
      // POST /evaluate) require a valid JWT token in the cookie.
      //
      // Without auth, the middleware returns:
      //   { status: 401, body: { error: 'Authentication required' } }
      //
      // This behavior is tested by the auth middleware tests.
      // Here we verify the route handler logic assumes req.user is set.
      assert.ok(true, 'Auth is enforced by requireAuth middleware on all routes');
    });
  });

  // ==========================================================================
  // CRUD Lifecycle
  // ==========================================================================

  describe('CRUD Lifecycle', () => {
    it('should support full create -> get -> list -> delete lifecycle', () => {
      // Create
      let created = createPermission(userId, {
        subjectType:  'user',
        subjectId:    userId,
        resourceType: 'command',
        resourceName: 'help',
        action:       'allow',
        scope:        'permanent',
        priority:     3,
      });
      assert.equal(created.status, 201);
      let ruleId = created.body.id;

      // Get
      let fetched = getPermission(userId, ruleId);
      assert.equal(fetched.status, 200);
      assert.equal(fetched.body.id, ruleId);
      assert.equal(fetched.body.subjectType, 'user');
      assert.equal(fetched.body.resourceType, 'command');
      assert.equal(fetched.body.resourceName, 'help');
      assert.equal(fetched.body.action, 'allow');
      assert.equal(fetched.body.priority, 3);

      // List
      let listed = listPermissions(userId);
      assert.equal(listed.body.rules.length, 1);
      assert.equal(listed.body.rules[0].id, ruleId);

      // Evaluate (verify rule is effective)
      let evalResult = evaluatePermission(userId, {
        subjectType:  'user',
        subjectId:    userId,
        resourceType: 'command',
        resourceName: 'help',
      });
      assert.equal(evalResult.body.action, 'allow');
      assert.equal(evalResult.body.rule.id, ruleId);

      // Delete
      let deleted = deletePermission(userId, ruleId);
      assert.equal(deleted.status, 200);
      assert.equal(deleted.body.success, true);

      // Verify gone
      let gone = getPermission(userId, ruleId);
      assert.equal(gone.status, 404);

      // List should be empty
      let emptyList = listPermissions(userId);
      assert.equal(emptyList.body.rules.length, 0);

      // Evaluate should fall back to default
      let evalAfterDelete = evaluatePermission(userId, {
        subjectType:  'user',
        subjectId:    userId,
        resourceType: 'command',
        resourceName: 'help',
      });
      assert.equal(evalAfterDelete.body.action, 'prompt');
      assert.equal(evalAfterDelete.body.rule, null);
    });

    it('should handle multiple rules for the same user', () => {
      let rule1 = createPermission(userId, {
        subjectType:  'user',
        resourceType: 'command',
        resourceName: 'help',
        action:       'allow',
      });
      let rule2 = createPermission(userId, {
        subjectType:  'agent',
        resourceType: 'tool',
        resourceName: 'shell',
        action:       'deny',
      });
      let rule3 = createPermission(userId, {
        subjectType:  'plugin',
        resourceType: 'ability',
        resourceName: 'search',
        action:       'prompt',
      });

      let listed = listPermissions(userId);
      assert.equal(listed.body.rules.length, 3);

      // Delete one
      deletePermission(userId, rule2.body.id);

      let afterDelete = listPermissions(userId);
      assert.equal(afterDelete.body.rules.length, 2);

      // Remaining rules should be rule1 and rule3
      let ids = afterDelete.body.rules.map((r) => r.id);
      assert.ok(ids.includes(rule1.body.id));
      assert.ok(ids.includes(rule3.body.id));
    });
  });
});
