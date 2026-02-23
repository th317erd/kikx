'use strict';

// ============================================================================
// Permission Engine Tests
// ============================================================================
// Exhaustive tests for the default-deny permission engine.
// Covers: CRUD, specificity resolution, scope behavior, conditions,
// deny-beats-allow, and edge cases.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import {
  createRule,
  deleteRule,
  getRule,
  listRules,
  evaluate,
  computeSpecificity,
  SubjectType,
  ResourceType,
  Action,
  Scope,
  DEFAULT_ACTION,
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
      archived INTEGER DEFAULT 0,
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
  `);

  // Seed data
  db.prepare('INSERT INTO users (username) VALUES (?)').run('alice');
  db.prepare('INSERT INTO users (username) VALUES (?)').run('bob');
  db.prepare('INSERT INTO agents (user_id, name, type) VALUES (?, ?, ?)').run(1, 'agent-alpha', 'claude');
  db.prepare('INSERT INTO agents (user_id, name, type) VALUES (?, ?, ?)').run(1, 'agent-beta', 'claude');
  db.prepare("INSERT INTO sessions (user_id, name) VALUES (?, ?)").run(1, 'test-session');
  db.prepare("INSERT INTO sessions (user_id, name) VALUES (?, ?)").run(1, 'other-session');

  return db;
}

// ============================================================================
// Constants Tests
// ============================================================================

describe('Permission Constants', () => {
  it('should define subject types', () => {
    assert.equal(SubjectType.USER, 'user');
    assert.equal(SubjectType.AGENT, 'agent');
    assert.equal(SubjectType.PLUGIN, 'plugin');
    assert.equal(SubjectType.ANY, '*');
  });

  it('should define resource types', () => {
    assert.equal(ResourceType.COMMAND, 'command');
    assert.equal(ResourceType.TOOL, 'tool');
    assert.equal(ResourceType.ABILITY, 'ability');
    assert.equal(ResourceType.ANY, '*');
  });

  it('should define actions', () => {
    assert.equal(Action.ALLOW, 'allow');
    assert.equal(Action.DENY, 'deny');
    assert.equal(Action.PROMPT, 'prompt');
  });

  it('should define scopes', () => {
    assert.equal(Scope.ONCE, 'once');
    assert.equal(Scope.SESSION, 'session');
    assert.equal(Scope.PERMANENT, 'permanent');
  });

  it('should default to prompt when no rules match', () => {
    assert.equal(DEFAULT_ACTION, 'prompt');
  });
});

// ============================================================================
// CRUD Tests
// ============================================================================

describe('Permission Rule CRUD', () => {
  beforeEach(() => createTestDatabase());
  afterEach(() => db.close());

  describe('createRule', () => {
    it('should create a rule with all fields', () => {
      let rule = createRule({
        ownerId:      1,
        sessionId:    1,
        subjectType:  SubjectType.AGENT,
        subjectId:    1,
        resourceType: ResourceType.COMMAND,
        resourceName: 'shell',
        action:       Action.ALLOW,
        scope:        Scope.SESSION,
        conditions:   { dangerous: false },
        priority:     10,
      }, db);

      assert.ok(rule.id);
      assert.equal(rule.ownerId, 1);
      assert.equal(rule.sessionId, 1);
      assert.equal(rule.subjectType, 'agent');
      assert.equal(rule.subjectId, 1);
      assert.equal(rule.resourceType, 'command');
      assert.equal(rule.resourceName, 'shell');
      assert.equal(rule.action, 'allow');
      assert.equal(rule.scope, 'session');
      assert.deepEqual(rule.conditions, { dangerous: false });
      assert.equal(rule.priority, 10);
    });

    it('should create a rule with minimal fields', () => {
      let rule = createRule({
        subjectType:  SubjectType.ANY,
        resourceType: ResourceType.ANY,
        action:       Action.PROMPT,
      }, db);

      assert.ok(rule.id);
      assert.equal(rule.ownerId, null);
      assert.equal(rule.sessionId, null);
      assert.equal(rule.subjectId, null);
      assert.equal(rule.resourceName, null);
      assert.equal(rule.scope, 'permanent');
      assert.equal(rule.conditions, null);
      assert.equal(rule.priority, 0);
    });

    it('should reject missing subjectType', () => {
      assert.throws(() => {
        createRule({ resourceType: ResourceType.ANY, action: Action.ALLOW }, db);
      }, /subjectType is required/);
    });

    it('should reject missing resourceType', () => {
      assert.throws(() => {
        createRule({ subjectType: SubjectType.ANY, action: Action.ALLOW }, db);
      }, /resourceType is required/);
    });

    it('should reject missing action', () => {
      assert.throws(() => {
        createRule({ subjectType: SubjectType.ANY, resourceType: ResourceType.ANY }, db);
      }, /action is required/);
    });

    it('should reject invalid subject type via CHECK constraint', () => {
      assert.throws(() => {
        createRule({
          subjectType:  'invalid',
          resourceType: ResourceType.ANY,
          action:       Action.ALLOW,
        }, db);
      });
    });

    it('should reject invalid action via CHECK constraint', () => {
      assert.throws(() => {
        createRule({
          subjectType:  SubjectType.ANY,
          resourceType: ResourceType.ANY,
          action:       'invalid',
        }, db);
      });
    });

    it('should store conditions as JSON', () => {
      let rule = createRule({
        subjectType:  SubjectType.AGENT,
        resourceType: ResourceType.COMMAND,
        action:       Action.ALLOW,
        conditions:   { args: ['--verbose'], directory: '/tmp' },
      }, db);

      let stored = getRule(rule.id, db);
      assert.deepEqual(stored.conditions, { args: ['--verbose'], directory: '/tmp' });
    });
  });

  describe('getRule', () => {
    it('should retrieve a rule by ID', () => {
      let created = createRule({
        subjectType:  SubjectType.AGENT,
        subjectId:    1,
        resourceType: ResourceType.COMMAND,
        resourceName: 'grep',
        action:       Action.ALLOW,
      }, db);

      let rule = getRule(created.id, db);
      assert.equal(rule.id, created.id);
      assert.equal(rule.subjectType, 'agent');
      assert.equal(rule.subjectId, 1);
      assert.equal(rule.resourceName, 'grep');
      assert.equal(rule.action, 'allow');
    });

    it('should return null for nonexistent rule', () => {
      let rule = getRule(999, db);
      assert.equal(rule, null);
    });
  });

  describe('deleteRule', () => {
    it('should delete a rule', () => {
      let rule = createRule({
        subjectType:  SubjectType.ANY,
        resourceType: ResourceType.ANY,
        action:       Action.DENY,
      }, db);

      let deleted = deleteRule(rule.id, db);
      assert.equal(deleted, true);
      assert.equal(getRule(rule.id, db), null);
    });

    it('should return false for nonexistent rule', () => {
      let deleted = deleteRule(999, db);
      assert.equal(deleted, false);
    });
  });

  describe('listRules', () => {
    it('should list all rules', () => {
      createRule({ subjectType: SubjectType.AGENT, resourceType: ResourceType.COMMAND, action: Action.ALLOW }, db);
      createRule({ subjectType: SubjectType.USER, resourceType: ResourceType.TOOL, action: Action.DENY }, db);
      createRule({ subjectType: SubjectType.ANY, resourceType: ResourceType.ANY, action: Action.PROMPT }, db);

      let rules = listRules({}, db);
      assert.equal(rules.length, 3);
    });

    it('should filter by ownerId', () => {
      createRule({ ownerId: 1, subjectType: SubjectType.AGENT, resourceType: ResourceType.COMMAND, action: Action.ALLOW }, db);
      createRule({ ownerId: 2, subjectType: SubjectType.AGENT, resourceType: ResourceType.COMMAND, action: Action.DENY }, db);

      let rules = listRules({ ownerId: 1 }, db);
      assert.equal(rules.length, 1);
      assert.equal(rules[0].action, 'allow');
    });

    it('should filter by subjectType', () => {
      createRule({ subjectType: SubjectType.AGENT, resourceType: ResourceType.ANY, action: Action.ALLOW }, db);
      createRule({ subjectType: SubjectType.USER, resourceType: ResourceType.ANY, action: Action.DENY }, db);

      let rules = listRules({ subjectType: SubjectType.AGENT }, db);
      assert.equal(rules.length, 1);
      assert.equal(rules[0].subjectType, 'agent');
    });

    it('should filter by resourceType and resourceName', () => {
      createRule({ subjectType: SubjectType.ANY, resourceType: ResourceType.COMMAND, resourceName: 'shell', action: Action.ALLOW }, db);
      createRule({ subjectType: SubjectType.ANY, resourceType: ResourceType.COMMAND, resourceName: 'grep', action: Action.DENY }, db);
      createRule({ subjectType: SubjectType.ANY, resourceType: ResourceType.TOOL, resourceName: 'shell', action: Action.PROMPT }, db);

      let rules = listRules({ resourceType: ResourceType.COMMAND, resourceName: 'shell' }, db);
      assert.equal(rules.length, 1);
      assert.equal(rules[0].action, 'allow');
    });

    it('should order by priority descending', () => {
      createRule({ subjectType: SubjectType.ANY, resourceType: ResourceType.ANY, action: Action.ALLOW, priority: 1 }, db);
      createRule({ subjectType: SubjectType.ANY, resourceType: ResourceType.ANY, action: Action.DENY, priority: 10 }, db);
      createRule({ subjectType: SubjectType.ANY, resourceType: ResourceType.ANY, action: Action.PROMPT, priority: 5 }, db);

      let rules = listRules({}, db);
      assert.equal(rules[0].priority, 10);
      assert.equal(rules[1].priority, 5);
      assert.equal(rules[2].priority, 1);
    });
  });
});

// ============================================================================
// Specificity Tests
// ============================================================================

describe('Specificity Computation', () => {
  let subject  = { type: 'agent', id: 1 };
  let resource = { type: 'command', name: 'shell' };

  it('should score 0 for wildcard subject + wildcard resource', () => {
    let rule = { subjectType: '*', subjectId: null, resourceType: '*', resourceName: null, sessionId: null };
    assert.equal(computeSpecificity(rule, subject, resource, {}), 0);
  });

  it('should score 1 for wildcard subject + exact resource', () => {
    let rule = { subjectType: '*', subjectId: null, resourceType: 'command', resourceName: 'shell', sessionId: null };
    assert.equal(computeSpecificity(rule, subject, resource, {}), 1);
  });

  it('should score 2 for exact subject type + wildcard resource', () => {
    let rule = { subjectType: 'agent', subjectId: null, resourceType: '*', resourceName: null, sessionId: null };
    assert.equal(computeSpecificity(rule, subject, resource, {}), 2);
  });

  it('should score 3 for exact subject type + exact resource', () => {
    let rule = { subjectType: 'agent', subjectId: null, resourceType: 'command', resourceName: 'shell', sessionId: null };
    assert.equal(computeSpecificity(rule, subject, resource, {}), 3);
  });

  it('should score 4 for exact subject + wildcard resource', () => {
    let rule = { subjectType: 'agent', subjectId: 1, resourceType: '*', resourceName: null, sessionId: null };
    assert.equal(computeSpecificity(rule, subject, resource, {}), 4);
  });

  it('should score 5 for exact subject + exact resource', () => {
    let rule = { subjectType: 'agent', subjectId: 1, resourceType: 'command', resourceName: 'shell', sessionId: null };
    assert.equal(computeSpecificity(rule, subject, resource, {}), 5);
  });

  it('should add 8 for session-scoped rules', () => {
    let rule = { subjectType: '*', subjectId: null, resourceType: '*', resourceName: null, sessionId: 1 };
    assert.equal(computeSpecificity(rule, subject, resource, { sessionId: 1 }), 8);
  });

  it('should not add session score for mismatched session', () => {
    let rule = { subjectType: '*', subjectId: null, resourceType: '*', resourceName: null, sessionId: 2 };
    assert.equal(computeSpecificity(rule, subject, resource, { sessionId: 1 }), 0);
  });

  it('should score 13 for session + exact subject + exact resource', () => {
    let rule = { subjectType: 'agent', subjectId: 1, resourceType: 'command', resourceName: 'shell', sessionId: 1 };
    assert.equal(computeSpecificity(rule, subject, resource, { sessionId: 1 }), 13);
  });
});

// ============================================================================
// Evaluation Tests
// ============================================================================

describe('Permission Evaluation', () => {
  beforeEach(() => createTestDatabase());
  afterEach(() => db.close());

  let agentSubject  = { type: 'agent', id: 1 };
  let userSubject   = { type: 'user', id: 1 };
  let shellResource = { type: 'command', name: 'shell' };
  let grepResource  = { type: 'command', name: 'grep' };
  let toolResource  = { type: 'tool', name: 'read_file' };

  describe('Default behavior', () => {
    it('should return prompt when no rules exist', () => {
      let result = evaluate(agentSubject, shellResource, {}, db);
      assert.equal(result.action, 'prompt');
      assert.equal(result.rule, null);
    });
  });

  describe('Simple matching', () => {
    it('should match exact subject + exact resource', () => {
      createRule({
        subjectType:  SubjectType.AGENT,
        subjectId:    1,
        resourceType: ResourceType.COMMAND,
        resourceName: 'shell',
        action:       Action.ALLOW,
      }, db);

      let result = evaluate(agentSubject, shellResource, {}, db);
      assert.equal(result.action, 'allow');
      assert.ok(result.rule);
    });

    it('should match wildcard subject', () => {
      createRule({
        subjectType:  SubjectType.ANY,
        resourceType: ResourceType.COMMAND,
        resourceName: 'shell',
        action:       Action.DENY,
      }, db);

      let result = evaluate(agentSubject, shellResource, {}, db);
      assert.equal(result.action, 'deny');
    });

    it('should match wildcard resource', () => {
      createRule({
        subjectType:  SubjectType.AGENT,
        subjectId:    1,
        resourceType: ResourceType.ANY,
        action:       Action.ALLOW,
      }, db);

      let result = evaluate(agentSubject, shellResource, {}, db);
      assert.equal(result.action, 'allow');
    });

    it('should match global wildcard rule', () => {
      createRule({
        subjectType:  SubjectType.ANY,
        resourceType: ResourceType.ANY,
        action:       Action.DENY,
      }, db);

      let result = evaluate(agentSubject, shellResource, {}, db);
      assert.equal(result.action, 'deny');
    });

    it('should not match different subject id', () => {
      createRule({
        subjectType:  SubjectType.AGENT,
        subjectId:    2,
        resourceType: ResourceType.COMMAND,
        resourceName: 'shell',
        action:       Action.ALLOW,
      }, db);

      let result = evaluate(agentSubject, shellResource, {}, db);
      assert.equal(result.action, 'prompt'); // No match, falls through to default
    });

    it('should not match different resource name', () => {
      createRule({
        subjectType:  SubjectType.AGENT,
        subjectId:    1,
        resourceType: ResourceType.COMMAND,
        resourceName: 'compact',
        action:       Action.ALLOW,
      }, db);

      let result = evaluate(agentSubject, shellResource, {}, db);
      assert.equal(result.action, 'prompt');
    });

    it('should not match different subject type', () => {
      createRule({
        subjectType:  SubjectType.USER,
        subjectId:    1,
        resourceType: ResourceType.COMMAND,
        resourceName: 'shell',
        action:       Action.ALLOW,
      }, db);

      let result = evaluate(agentSubject, shellResource, {}, db);
      assert.equal(result.action, 'prompt');
    });

    it('should not match different resource type', () => {
      createRule({
        subjectType:  SubjectType.AGENT,
        subjectId:    1,
        resourceType: ResourceType.TOOL,
        resourceName: 'shell',
        action:       Action.ALLOW,
      }, db);

      let result = evaluate(agentSubject, shellResource, {}, db);
      assert.equal(result.action, 'prompt');
    });
  });

  describe('Specificity resolution', () => {
    it('should prefer exact subject over wildcard subject', () => {
      // Wildcard: deny all agents from shell
      createRule({
        subjectType:  SubjectType.AGENT,
        resourceType: ResourceType.COMMAND,
        resourceName: 'shell',
        action:       Action.DENY,
      }, db);

      // Exact: allow agent 1 to use shell
      createRule({
        subjectType:  SubjectType.AGENT,
        subjectId:    1,
        resourceType: ResourceType.COMMAND,
        resourceName: 'shell',
        action:       Action.ALLOW,
      }, db);

      let result = evaluate(agentSubject, shellResource, {}, db);
      assert.equal(result.action, 'allow');
    });

    it('should prefer exact resource over wildcard resource', () => {
      // Wildcard: allow agent for all commands
      createRule({
        subjectType:  SubjectType.AGENT,
        subjectId:    1,
        resourceType: ResourceType.COMMAND,
        action:       Action.ALLOW,
      }, db);

      // Exact: deny agent from shell specifically
      createRule({
        subjectType:  SubjectType.AGENT,
        subjectId:    1,
        resourceType: ResourceType.COMMAND,
        resourceName: 'shell',
        action:       Action.DENY,
      }, db);

      let result = evaluate(agentSubject, shellResource, {}, db);
      assert.equal(result.action, 'deny');

      // But grep should still be allowed (only wildcard rule matches)
      let grepResult = evaluate(agentSubject, grepResource, {}, db);
      assert.equal(grepResult.action, 'allow');
    });

    it('should prefer session-scoped rule over global rule', () => {
      // Global: allow agent to use shell
      createRule({
        subjectType:  SubjectType.AGENT,
        subjectId:    1,
        resourceType: ResourceType.COMMAND,
        resourceName: 'shell',
        action:       Action.ALLOW,
      }, db);

      // Session-scoped: deny agent from shell in session 1
      createRule({
        subjectType:  SubjectType.AGENT,
        subjectId:    1,
        sessionId:    1,
        resourceType: ResourceType.COMMAND,
        resourceName: 'shell',
        action:       Action.DENY,
      }, db);

      // In session 1: denied
      let result1 = evaluate(agentSubject, shellResource, { sessionId: 1 }, db);
      assert.equal(result1.action, 'deny');

      // In session 2: allowed (session rule doesn't match)
      let result2 = evaluate(agentSubject, shellResource, { sessionId: 2 }, db);
      assert.equal(result2.action, 'allow');
    });

    it('should handle complex multi-rule specificity', () => {
      // Global default: prompt for everything
      createRule({
        subjectType:  SubjectType.ANY,
        resourceType: ResourceType.ANY,
        action:       Action.PROMPT,
      }, db);

      // All agents: deny commands
      createRule({
        subjectType:  SubjectType.AGENT,
        resourceType: ResourceType.COMMAND,
        action:       Action.DENY,
      }, db);

      // Agent 1: allow commands
      createRule({
        subjectType:  SubjectType.AGENT,
        subjectId:    1,
        resourceType: ResourceType.COMMAND,
        action:       Action.ALLOW,
      }, db);

      // Agent 1 in session 1: deny shell specifically
      createRule({
        subjectType:  SubjectType.AGENT,
        subjectId:    1,
        sessionId:    1,
        resourceType: ResourceType.COMMAND,
        resourceName: 'shell',
        action:       Action.DENY,
      }, db);

      // Agent 1 + shell + session 1 = deny (most specific)
      assert.equal(evaluate(agentSubject, shellResource, { sessionId: 1 }, db).action, 'deny');

      // Agent 1 + grep + session 1 = allow (agent 1 allowed for commands)
      assert.equal(evaluate(agentSubject, grepResource, { sessionId: 1 }, db).action, 'allow');

      // Agent 2 + shell = deny (all agents denied from commands)
      assert.equal(evaluate({ type: 'agent', id: 2 }, shellResource, {}, db).action, 'deny');

      // User 1 + tool = prompt (only global wildcard matches)
      assert.equal(evaluate(userSubject, toolResource, {}, db).action, 'prompt');
    });
  });

  describe('Deny beats allow at equal specificity', () => {
    it('should prefer deny over allow at same specificity and priority', () => {
      createRule({
        subjectType:  SubjectType.AGENT,
        subjectId:    1,
        resourceType: ResourceType.COMMAND,
        resourceName: 'shell',
        action:       Action.ALLOW,
      }, db);

      createRule({
        subjectType:  SubjectType.AGENT,
        subjectId:    1,
        resourceType: ResourceType.COMMAND,
        resourceName: 'shell',
        action:       Action.DENY,
      }, db);

      let result = evaluate(agentSubject, shellResource, {}, db);
      assert.equal(result.action, 'deny');
    });

    it('should respect priority as tiebreaker at equal specificity', () => {
      createRule({
        subjectType:  SubjectType.AGENT,
        subjectId:    1,
        resourceType: ResourceType.COMMAND,
        resourceName: 'shell',
        action:       Action.DENY,
        priority:     1,
      }, db);

      createRule({
        subjectType:  SubjectType.AGENT,
        subjectId:    1,
        resourceType: ResourceType.COMMAND,
        resourceName: 'shell',
        action:       Action.ALLOW,
        priority:     10,
      }, db);

      // Higher priority allow should beat lower priority deny
      let result = evaluate(agentSubject, shellResource, {}, db);
      assert.equal(result.action, 'allow');
    });
  });

  describe('Scope behavior', () => {
    it('should consume once-scoped rules after evaluation', () => {
      let rule = createRule({
        subjectType:  SubjectType.AGENT,
        subjectId:    1,
        resourceType: ResourceType.COMMAND,
        resourceName: 'shell',
        action:       Action.ALLOW,
        scope:        Scope.ONCE,
      }, db);

      // First evaluation: allowed
      let result1 = evaluate(agentSubject, shellResource, {}, db);
      assert.equal(result1.action, 'allow');

      // Rule should be deleted
      assert.equal(getRule(rule.id, db), null);

      // Second evaluation: no rules, falls back to default
      let result2 = evaluate(agentSubject, shellResource, {}, db);
      assert.equal(result2.action, 'prompt');
    });

    it('should not consume session-scoped rules', () => {
      let rule = createRule({
        subjectType:  SubjectType.AGENT,
        subjectId:    1,
        sessionId:    1,
        resourceType: ResourceType.COMMAND,
        resourceName: 'shell',
        action:       Action.ALLOW,
        scope:        Scope.SESSION,
      }, db);

      // Evaluate twice
      evaluate(agentSubject, shellResource, { sessionId: 1 }, db);
      evaluate(agentSubject, shellResource, { sessionId: 1 }, db);

      // Rule should still exist
      assert.ok(getRule(rule.id, db));
    });

    it('should not consume permanent rules', () => {
      let rule = createRule({
        subjectType:  SubjectType.AGENT,
        subjectId:    1,
        resourceType: ResourceType.COMMAND,
        resourceName: 'shell',
        action:       Action.ALLOW,
        scope:        Scope.PERMANENT,
      }, db);

      evaluate(agentSubject, shellResource, {}, db);
      evaluate(agentSubject, shellResource, {}, db);
      evaluate(agentSubject, shellResource, {}, db);

      assert.ok(getRule(rule.id, db));
    });
  });

  describe('Conditions matching', () => {
    it('should match when conditions are satisfied', () => {
      createRule({
        subjectType:  SubjectType.AGENT,
        subjectId:    1,
        resourceType: ResourceType.COMMAND,
        resourceName: 'shell',
        action:       Action.ALLOW,
        conditions:   { dangerous: false },
      }, db);

      let result = evaluate(agentSubject, shellResource, { dangerous: false }, db);
      assert.equal(result.action, 'allow');
    });

    it('should not match when conditions are not satisfied', () => {
      createRule({
        subjectType:  SubjectType.AGENT,
        subjectId:    1,
        resourceType: ResourceType.COMMAND,
        resourceName: 'shell',
        action:       Action.ALLOW,
        conditions:   { dangerous: false },
      }, db);

      let result = evaluate(agentSubject, shellResource, { dangerous: true }, db);
      assert.equal(result.action, 'prompt'); // Condition mismatch, rule ignored
    });

    it('should not match when condition key is missing from context', () => {
      createRule({
        subjectType:  SubjectType.AGENT,
        subjectId:    1,
        resourceType: ResourceType.COMMAND,
        resourceName: 'shell',
        action:       Action.ALLOW,
        conditions:   { dangerous: false },
      }, db);

      // Context has no 'dangerous' key
      let result = evaluate(agentSubject, shellResource, {}, db);
      assert.equal(result.action, 'prompt');
    });

    it('should match rules with null conditions always', () => {
      createRule({
        subjectType:  SubjectType.AGENT,
        subjectId:    1,
        resourceType: ResourceType.COMMAND,
        resourceName: 'shell',
        action:       Action.ALLOW,
        conditions:   null,
      }, db);

      let result = evaluate(agentSubject, shellResource, { anything: 'here' }, db);
      assert.equal(result.action, 'allow');
    });

    it('should support multi-key conditions', () => {
      createRule({
        subjectType:  SubjectType.AGENT,
        subjectId:    1,
        resourceType: ResourceType.COMMAND,
        resourceName: 'shell',
        action:       Action.ALLOW,
        conditions:   { dangerous: false, directory: '/tmp' },
      }, db);

      // Both conditions met
      let result1 = evaluate(agentSubject, shellResource, { dangerous: false, directory: '/tmp' }, db);
      assert.equal(result1.action, 'allow');

      // One condition missing
      let result2 = evaluate(agentSubject, shellResource, { dangerous: false }, db);
      assert.equal(result2.action, 'prompt');
    });
  });

  describe('Owner-scoped rules', () => {
    it('should match rules owned by the context owner', () => {
      createRule({
        ownerId:      1,
        subjectType:  SubjectType.AGENT,
        subjectId:    1,
        resourceType: ResourceType.COMMAND,
        resourceName: 'shell',
        action:       Action.ALLOW,
      }, db);

      let result = evaluate(agentSubject, shellResource, { ownerId: 1 }, db);
      assert.equal(result.action, 'allow');
    });

    it('should not match rules owned by a different user', () => {
      createRule({
        ownerId:      2,
        subjectType:  SubjectType.AGENT,
        subjectId:    1,
        resourceType: ResourceType.COMMAND,
        resourceName: 'shell',
        action:       Action.ALLOW,
      }, db);

      let result = evaluate(agentSubject, shellResource, { ownerId: 1 }, db);
      assert.equal(result.action, 'prompt');
    });

    it('should match system-wide rules (null owner) for any user', () => {
      createRule({
        ownerId:      null,
        subjectType:  SubjectType.AGENT,
        subjectId:    1,
        resourceType: ResourceType.COMMAND,
        resourceName: 'shell',
        action:       Action.ALLOW,
      }, db);

      let result = evaluate(agentSubject, shellResource, { ownerId: 1 }, db);
      assert.equal(result.action, 'allow');
    });
  });

  describe('Cross-type evaluation', () => {
    it('should evaluate tool permissions', () => {
      createRule({
        subjectType:  SubjectType.AGENT,
        subjectId:    1,
        resourceType: ResourceType.TOOL,
        resourceName: 'read_file',
        action:       Action.ALLOW,
      }, db);

      let result = evaluate(agentSubject, toolResource, {}, db);
      assert.equal(result.action, 'allow');
    });

    it('should evaluate ability permissions', () => {
      createRule({
        subjectType:  SubjectType.AGENT,
        subjectId:    1,
        resourceType: ResourceType.ABILITY,
        resourceName: 'web_search',
        action:       Action.DENY,
      }, db);

      let result = evaluate(agentSubject, { type: 'ability', name: 'web_search' }, {}, db);
      assert.equal(result.action, 'deny');
    });

    it('should evaluate plugin subject permissions', () => {
      createRule({
        subjectType:  SubjectType.PLUGIN,
        subjectId:    5,
        resourceType: ResourceType.COMMAND,
        resourceName: 'reload',
        action:       Action.ALLOW,
      }, db);

      let result = evaluate({ type: 'plugin', id: 5 }, { type: 'command', name: 'reload' }, {}, db);
      assert.equal(result.action, 'allow');
    });
  });

  describe('Edge cases', () => {
    it('should handle many rules efficiently', () => {
      // Create 100 rules
      for (let i = 0; i < 100; i++) {
        createRule({
          subjectType:  SubjectType.AGENT,
          subjectId:    i,
          resourceType: ResourceType.COMMAND,
          resourceName: `command_${i}`,
          action:       (i % 2 === 0) ? Action.ALLOW : Action.DENY,
        }, db);
      }

      // Evaluate for a specific agent/command
      let result = evaluate({ type: 'agent', id: 50 }, { type: 'command', name: 'command_50' }, {}, db);
      assert.equal(result.action, 'allow');
    });

    it('should handle evaluate with empty context', () => {
      createRule({
        subjectType:  SubjectType.ANY,
        resourceType: ResourceType.ANY,
        action:       Action.DENY,
      }, db);

      let result = evaluate(agentSubject, shellResource, {}, db);
      assert.equal(result.action, 'deny');
    });

    it('should handle subject with null id matching wildcard subject_id rules', () => {
      createRule({
        subjectType:  SubjectType.AGENT,
        resourceType: ResourceType.COMMAND,
        resourceName: 'shell',
        action:       Action.ALLOW,
      }, db);

      // Subject with id=null should still match rules where subject_id IS NULL
      let result = evaluate({ type: 'agent', id: null }, shellResource, {}, db);
      assert.equal(result.action, 'allow');
    });
  });
});

// ============================================================================
// Determinism Tests (Property-based)
// ============================================================================

describe('Permission Evaluation Determinism', () => {
  beforeEach(() => createTestDatabase());
  afterEach(() => db.close());

  it('should produce the same result for the same input (10 iterations)', () => {
    // Create a complex rule set
    createRule({ subjectType: '*', resourceType: '*', action: 'prompt', priority: 0 }, db);
    createRule({ subjectType: 'agent', resourceType: 'command', action: 'deny', priority: 1 }, db);
    createRule({ subjectType: 'agent', subjectId: 1, resourceType: 'command', action: 'allow', priority: 2 }, db);
    createRule({ subjectType: 'agent', subjectId: 1, resourceType: 'command', resourceName: 'shell', action: 'deny', priority: 3 }, db);

    let subject  = { type: 'agent', id: 1 };
    let resource = { type: 'command', name: 'grep' };
    let context  = { sessionId: 1 };

    let firstResult = evaluate(subject, resource, context, db);

    for (let i = 0; i < 10; i++) {
      let result = evaluate(subject, resource, context, db);
      assert.equal(result.action, firstResult.action, `Iteration ${i} produced different result`);
    }
  });

  it('should always resolve to allow, deny, or prompt (never null/undefined)', () => {
    let subjects = [
      { type: 'agent', id: 1 },
      { type: 'user', id: 1 },
      { type: 'plugin', id: 1 },
      { type: 'agent', id: 999 },
    ];
    let resources = [
      { type: 'command', name: 'shell' },
      { type: 'tool', name: 'read_file' },
      { type: 'ability', name: 'web_search' },
      { type: 'command', name: 'nonexistent' },
    ];

    // With no rules at all
    for (let subject of subjects) {
      for (let resource of resources) {
        let result = evaluate(subject, resource, {}, db);
        assert.ok(
          ['allow', 'deny', 'prompt'].includes(result.action),
          `Got unexpected action: ${result.action}`,
        );
      }
    }

    // With rules
    createRule({ subjectType: '*', resourceType: '*', action: 'deny' }, db);
    for (let subject of subjects) {
      for (let resource of resources) {
        let result = evaluate(subject, resource, {}, db);
        assert.ok(
          ['allow', 'deny', 'prompt'].includes(result.action),
          `Got unexpected action: ${result.action}`,
        );
      }
    }
  });
});
