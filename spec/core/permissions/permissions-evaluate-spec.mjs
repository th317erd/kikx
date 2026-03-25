'use strict';

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createKikxCore }       from '../../../src/core/index.mjs';
import { Permissions }          from '../../../src/core/permissions/permissions-base.mjs';
import { PermissionDeniedError } from '../../../src/core/permissions/permission-denied-error.mjs';
import { SessionManager }       from '../../../src/core/session/index.mjs';

// =============================================================================
// Permissions.evaluate() — Rule Evaluation in Base Class
// =============================================================================
// Tests for the new evaluate() method on the Permissions base class.
// This method ports the rule evaluation logic from PermissionEngine.checkPermission()
// directly into the Permissions base class, so each PermissionsClass can
// evaluate rules without going through the engine.
//
// Semantics:
//   evaluate() returns true  = needs approval (no matching allow rule)
//   evaluate() returns false = auto-approved (matching allow rule, or auto-allow)
//   evaluate() throws PermissionDeniedError = explicit deny
// =============================================================================

describe('Permissions.evaluate()', () => {
  let core;
  let models;
  let org;
  let orgID;
  let sessionManager;

  before(async () => {
    core = createKikxCore();
    await core.start();
    models = core.getModels();
  });

  after(async () => {
    if (core && core.isStarted())
      await core.stop();
  });

  beforeEach(async () => {
    org   = await models.Organization.create({ name: 'Evaluate Test Org' });
    orgID = org.id;

    // Fresh SessionManager per test
    sessionManager = new SessionManager(core.getContext());
    core.getContext().setProperty('sessionManager', sessionManager);
  });

  // Helper: create a Permissions instance backed by the real context
  function createPermissions() {
    return new Permissions(core.getContext());
  }

  // Helper: create a subclass with custom matchesRule
  function createCustomPermissions(matchFn) {
    class CustomPermissions extends Permissions {
      matchesRule(rule, args, metadata) {
        return matchFn(rule, args, metadata);
      }
    }

    return new CustomPermissions(core.getContext());
  }

  // Helper: create a session chain [grandparent, parent, child, ...]
  async function createSessionChain(depth) {
    let sessions = [];
    let previous = null;

    for (let index = 0; index < depth; index++) {
      let options = { name: `Level ${index}` };

      if (previous)
        options.parentSessionID = previous.id;

      let session = await sessionManager.createSession(orgID, options);
      sessions.push(session);
      previous = session;
    }

    return sessions;
  }

  // ===========================================================================
  // 1. No rules — risk level behaviors
  // ===========================================================================

  describe('no rules', () => {
    it('should return true (needs approval) for strict risk level', async () => {
      let perms  = createPermissions();
      let result = await perms.evaluate('shell:execute', {}, {
        organizationID: orgID,
        riskLevel:      'strict',
      });

      assert.equal(result, true);
    });

    it('should return false (auto-allow) for permissive risk level', async () => {
      let perms  = createPermissions();
      let result = await perms.evaluate('shell:execute', {}, {
        organizationID: orgID,
        riskLevel:      'permissive',
      });

      assert.equal(result, false);
    });

    it('should return true (needs approval) for normal risk level', async () => {
      let perms  = createPermissions();
      let result = await perms.evaluate('shell:execute', {}, {
        organizationID: orgID,
        riskLevel:      'normal',
      });

      assert.equal(result, true);
    });
  });

  // ===========================================================================
  // 2. Allow and deny rules
  // ===========================================================================

  describe('allow and deny rules', () => {
    it('should return false (approved) when allow rule matches', async () => {
      await models.PermissionRule.create({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'allow',
        scope:          'global',
        priority:       10,
        createdBy:      'usr_test',
      });

      let perms  = createPermissions();
      let result = await perms.evaluate('shell:execute', {}, {
        organizationID: orgID,
        riskLevel:      'strict',
      });

      assert.equal(result, false);
    });

    it('should throw PermissionDeniedError when deny rule matches', async () => {
      await models.PermissionRule.create({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'deny',
        scope:          'global',
        priority:       10,
        createdBy:      'usr_test',
      });

      let perms = createPermissions();
      await assert.rejects(
        () => perms.evaluate('shell:execute', {}, {
          organizationID: orgID,
          riskLevel:      'strict',
        }),
        (error) => {
          assert.ok(error instanceof PermissionDeniedError);
          assert.equal(error.featureName, 'shell:execute');
          return true;
        },
      );
    });
  });

  // ===========================================================================
  // 3. Expired rules
  // ===========================================================================

  describe('expired rules', () => {
    it('should ignore expired rules', async () => {
      let pastDate = new Date(Date.now() - 60000); // 1 minute ago

      await models.PermissionRule.create({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'allow',
        scope:          'global',
        priority:       10,
        createdBy:      'usr_test',
        expiresAt:      pastDate,
      });

      let perms  = createPermissions();
      let result = await perms.evaluate('shell:execute', {}, {
        organizationID: orgID,
        riskLevel:      'strict',
      });

      // Expired rule ignored, no match => needs approval
      assert.equal(result, true);
    });

    it('should apply non-expired rules', async () => {
      let futureDate = new Date(Date.now() + 3600000); // 1 hour from now

      await models.PermissionRule.create({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'allow',
        scope:          'global',
        priority:       10,
        createdBy:      'usr_test',
        expiresAt:      futureDate,
      });

      let perms  = createPermissions();
      let result = await perms.evaluate('shell:execute', {}, {
        organizationID: orgID,
        riskLevel:      'strict',
      });

      assert.equal(result, false);
    });
  });

  // ===========================================================================
  // 4. Session-scoped rules
  // ===========================================================================

  describe('session-scoped rules', () => {
    it('should match rule scoped to current session', async () => {
      let [session] = await createSessionChain(1);

      await models.PermissionRule.create({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'allow',
        scope:          'session',
        scopeID:        session.id,
        priority:       10,
        createdBy:      'usr_test',
      });

      let perms  = createPermissions();
      let result = await perms.evaluate('shell:execute', {}, {
        organizationID: orgID,
        scope:          'session',
        scopeID:        session.id,
        riskLevel:      'strict',
      });

      assert.equal(result, false);
    });

    it('should NOT match rule scoped to a different session', async () => {
      let sessions = await createSessionChain(1);
      let session  = sessions[0];

      // Create another independent session
      let otherSession = await sessionManager.createSession(orgID, { name: 'Other Session' });

      await models.PermissionRule.create({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'allow',
        scope:          'session',
        scopeID:        otherSession.id,
        priority:       10,
        createdBy:      'usr_test',
      });

      let perms  = createPermissions();
      let result = await perms.evaluate('shell:execute', {}, {
        organizationID: orgID,
        scope:          'session',
        scopeID:        session.id,
        riskLevel:      'strict',
      });

      // Rule is for a different session, should not match
      assert.equal(result, true);
    });

    it('should match global-scoped rule regardless of session', async () => {
      let [session] = await createSessionChain(1);

      await models.PermissionRule.create({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'allow',
        scope:          'global',
        priority:       10,
        createdBy:      'usr_test',
      });

      let perms  = createPermissions();
      let result = await perms.evaluate('shell:execute', {}, {
        organizationID: orgID,
        scope:          'session',
        scopeID:        session.id,
        riskLevel:      'strict',
      });

      assert.equal(result, false);
    });
  });

  // ===========================================================================
  // 5. Priority ordering
  // ===========================================================================

  describe('priority ordering', () => {
    it('should apply higher priority rule over lower priority', async () => {
      // Lower priority allow
      await models.PermissionRule.create({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'allow',
        scope:          'global',
        priority:       1,
        createdBy:      'usr_test',
      });

      // Higher priority deny
      await models.PermissionRule.create({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'deny',
        scope:          'global',
        priority:       10,
        createdBy:      'usr_test',
      });

      let perms = createPermissions();

      await assert.rejects(
        () => perms.evaluate('shell:execute', {}, {
          organizationID: orgID,
          riskLevel:      'strict',
        }),
        (error) => {
          assert.ok(error instanceof PermissionDeniedError);
          return true;
        },
      );
    });

    it('should apply higher priority allow over lower priority deny', async () => {
      // Lower priority deny
      await models.PermissionRule.create({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'deny',
        scope:          'global',
        priority:       1,
        createdBy:      'usr_test',
      });

      // Higher priority allow
      await models.PermissionRule.create({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'allow',
        scope:          'global',
        priority:       10,
        createdBy:      'usr_test',
      });

      let perms  = createPermissions();
      let result = await perms.evaluate('shell:execute', {}, {
        organizationID: orgID,
        riskLevel:      'strict',
      });

      assert.equal(result, false); // Higher-priority allow wins
    });
  });

  // ===========================================================================
  // 6. Tool risk level: 'critical' and 'none'
  // ===========================================================================

  describe('tool risk level overrides', () => {
    it('should always return true for critical riskLevel (ignores allow rules)', async () => {
      await models.PermissionRule.create({
        organizationID: orgID,
        featureName:    'nuclear:launch',
        effect:         'allow',
        scope:          'global',
        priority:       100,
        createdBy:      'usr_test',
      });

      let perms  = createPermissions();
      let result = await perms.evaluate('nuclear:launch', {}, {
        organizationID: orgID,
        riskLevel:      'strict',
        toolClass:      { riskLevel: 'critical' },
      });

      assert.equal(result, true);
    });

    it('should return false (auto-allow) for none riskLevel', async () => {
      let perms  = createPermissions();
      let result = await perms.evaluate('safe:tool', {}, {
        organizationID: orgID,
        riskLevel:      'strict',
        toolClass:      { riskLevel: 'none' },
      });

      assert.equal(result, false);
    });

    it('should return false for none riskLevel even without any rules', async () => {
      let perms  = createPermissions();
      let result = await perms.evaluate('safe:tool', {}, {
        organizationID: orgID,
        toolClass:      { riskLevel: 'none' },
      });

      assert.equal(result, false);
    });
  });

  // ===========================================================================
  // 7. Custom matchesRule() via subclass
  // ===========================================================================

  describe('custom matchesRule()', () => {
    it('should skip rule when matchesRule returns { matches: false }', async () => {
      await models.PermissionRule.create({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'allow',
        scope:          'global',
        priority:       10,
        createdBy:      'usr_test',
      });

      // Custom logic: always rejects
      let perms  = createCustomPermissions(() => ({ matches: false }));
      let result = await perms.evaluate('shell:execute', {}, {
        organizationID: orgID,
        riskLevel:      'strict',
      });

      // Rule skipped, no match => needs approval
      assert.equal(result, true);
    });

    it('should apply rule when matchesRule returns { matches: true }', async () => {
      await models.PermissionRule.create({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'allow',
        scope:          'global',
        priority:       10,
        createdBy:      'usr_test',
      });

      let perms  = createCustomPermissions(() => ({ matches: true }));
      let result = await perms.evaluate('shell:execute', {}, {
        organizationID: orgID,
        riskLevel:      'strict',
      });

      assert.equal(result, false);
    });

    it('should pass args and parsed metadata to matchesRule', async () => {
      let capturedArgs     = null;
      let capturedMetadata = null;

      await models.PermissionRule.create({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'allow',
        scope:          'global',
        priority:       10,
        createdBy:      'usr_test',
        metadata:       JSON.stringify({ allowedCommands: ['ls'] }),
      });

      let perms = createCustomPermissions((_rule, args, metadata) => {
        capturedArgs     = args;
        capturedMetadata = metadata;
        return { matches: true };
      });

      await perms.evaluate('shell:execute', { command: 'ls' }, {
        organizationID: orgID,
        riskLevel:      'strict',
      });

      assert.deepEqual(capturedArgs, { command: 'ls' });
      assert.deepEqual(capturedMetadata, { allowedCommands: ['ls'] });
    });
  });

  // ===========================================================================
  // 8. Ancestry walk-up
  // ===========================================================================

  describe('ancestry walk-up', () => {
    it('should match parent session rule for child (normal mode)', async () => {
      let sessions = await createSessionChain(2);
      let parent   = sessions[0];
      let child    = sessions[1];

      await models.PermissionRule.create({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'allow',
        scope:          'session',
        scopeID:        parent.id,
        priority:       10,
        createdBy:      'usr_test',
      });

      let perms  = createPermissions();
      let result = await perms.evaluate('shell:execute', {}, {
        organizationID: orgID,
        scope:          'session',
        scopeID:        child.id,
        riskLevel:      'normal',
      });

      assert.equal(result, false); // Parent rule visible via walk-up
    });

    it('should NOT walk up ancestors in strict mode', async () => {
      let sessions = await createSessionChain(2);
      let parent   = sessions[0];
      let child    = sessions[1];

      await models.PermissionRule.create({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'allow',
        scope:          'session',
        scopeID:        parent.id,
        priority:       10,
        createdBy:      'usr_test',
      });

      let perms  = createPermissions();
      let result = await perms.evaluate('shell:execute', {}, {
        organizationID: orgID,
        scope:          'session',
        scopeID:        child.id,
        riskLevel:      'strict',
      });

      assert.equal(result, true); // Parent rule invisible in strict
    });

    it('should walk up to grandparent in normal mode', async () => {
      let sessions    = await createSessionChain(3);
      let grandparent = sessions[0];
      let grandchild  = sessions[2];

      await models.PermissionRule.create({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'allow',
        scope:          'session',
        scopeID:        grandparent.id,
        priority:       10,
        createdBy:      'usr_test',
      });

      let perms  = createPermissions();
      let result = await perms.evaluate('shell:execute', {}, {
        organizationID: orgID,
        scope:          'session',
        scopeID:        grandchild.id,
        riskLevel:      'normal',
      });

      assert.equal(result, false); // Grandparent rule visible
    });
  });

  // ===========================================================================
  // 9. Risk level resolution chain
  // ===========================================================================

  describe('_resolveRiskLevel()', () => {
    it('should use explicit riskLevel option', async () => {
      let perms  = createPermissions();
      let result = await perms._resolveRiskLevel({ riskLevel: 'permissive' });
      assert.equal(result, 'permissive');
    });

    it('should fall back to agent config', async () => {
      let perms  = createPermissions();
      let agent  = { getConfig: async () => ({ riskLevel: 'normal' }) };
      let result = await perms._resolveRiskLevel({ agent });
      assert.equal(result, 'normal');
    });

    it('should fall back to user settings', async () => {
      let perms  = createPermissions();
      let user   = { getSettings: async () => ({ riskLevel: 'permissive' }) };
      let result = await perms._resolveRiskLevel({ user });
      assert.equal(result, 'permissive');
    });

    it('should default to strict', async () => {
      let perms  = createPermissions();
      let result = await perms._resolveRiskLevel({});
      assert.equal(result, 'strict');
    });

    it('should treat medium as normal (backward compat)', async () => {
      let perms  = createPermissions();
      let result = await perms._resolveRiskLevel({ riskLevel: 'medium' });
      assert.equal(result, 'normal');
    });

    it('should throw for invalid risk level', async () => {
      let perms = createPermissions();
      await assert.rejects(
        () => perms._resolveRiskLevel({ riskLevel: 'yolo' }),
        { message: 'Invalid risk level: yolo' },
      );
    });
  });

  // ===========================================================================
  // 10. CRUD helpers
  // ===========================================================================

  describe('createRule()', () => {
    it('should create a PermissionRule record', async () => {
      let perms = createPermissions();
      let rule  = await perms.createRule({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'allow',
        scope:          'global',
        priority:       5,
        createdBy:      'usr_test',
      });

      assert.ok(rule.id);
      assert.equal(rule.featureName, 'shell:execute');
      assert.equal(rule.effect, 'allow');
      assert.equal(rule.scope, 'global');
      assert.equal(rule.priority, 5);
    });

    it('should default scope to global', async () => {
      let perms = createPermissions();
      let rule  = await perms.createRule({
        organizationID: orgID,
        featureName:    'test:feature',
        effect:         'allow',
        createdBy:      'usr_test',
      });

      assert.equal(rule.scope, 'global');
    });
  });

  describe('deleteRule()', () => {
    it('should delete a rule by ID', async () => {
      let perms = createPermissions();
      let rule  = await perms.createRule({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'allow',
        createdBy:      'usr_test',
      });

      let deleted = await perms.deleteRule(rule.id);
      assert.equal(deleted, true);

      // Verify it's gone
      let found = await models.PermissionRule.where.id.EQ(rule.id).first();
      assert.ok(!found, 'deleted rule should not be found');
    });

    it('should return false for non-existent rule', async () => {
      let perms   = createPermissions();
      let deleted = await perms.deleteRule('prm_nonexistent');
      assert.equal(deleted, false);
    });
  });

  describe('getRules()', () => {
    it('should return rules for an organization', async () => {
      let perms = createPermissions();
      await perms.createRule({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'allow',
        createdBy:      'usr_test',
      });

      await perms.createRule({
        organizationID: orgID,
        featureName:    'websearch:fetch',
        effect:         'deny',
        createdBy:      'usr_test',
      });

      let rules = await perms.getRules(orgID);
      assert.ok(rules.length >= 2);
    });

    it('should filter by featureName', async () => {
      let perms = createPermissions();
      await perms.createRule({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'allow',
        createdBy:      'usr_test',
      });

      await perms.createRule({
        organizationID: orgID,
        featureName:    'websearch:fetch',
        effect:         'deny',
        createdBy:      'usr_test',
      });

      let rules = await perms.getRules(orgID, { featureName: 'shell:execute' });
      assert.ok(rules.length >= 1);
      assert.ok(rules.every((r) => r.featureName === 'shell:execute'));
    });
  });

  describe('pruneExpired()', () => {
    it('should delete expired rules and return count', async () => {
      let perms    = createPermissions();
      let pastDate = new Date(Date.now() - 60000);

      await perms.createRule({
        organizationID: orgID,
        featureName:    'old:rule',
        effect:         'allow',
        createdBy:      'usr_test',
        expiresAt:      pastDate,
      });

      let count = await perms.pruneExpired();
      assert.ok(count >= 1);
    });

    it('should NOT delete non-expired rules', async () => {
      let perms      = createPermissions();
      let futureDate = new Date(Date.now() + 3600000);

      let rule = await perms.createRule({
        organizationID: orgID,
        featureName:    'future:rule',
        effect:         'allow',
        createdBy:      'usr_test',
        expiresAt:      futureDate,
      });

      await perms.pruneExpired();

      // Rule should still exist
      let found = await models.PermissionRule.where.id.EQ(rule.id).first();
      assert.ok(found);
    });
  });

  // ===========================================================================
  // 11. Edge cases and failure paths
  // ===========================================================================

  describe('edge cases', () => {
    it('should handle missing organizationID gracefully (no rules found)', async () => {
      let perms  = createPermissions();
      let result = await perms.evaluate('shell:execute', {}, {
        organizationID: 'org_nonexistent',
        riskLevel:      'strict',
      });

      // No org => no rules => needs approval in strict
      assert.equal(result, true);
    });

    it('should handle null args', async () => {
      await models.PermissionRule.create({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'allow',
        scope:          'global',
        priority:       10,
        createdBy:      'usr_test',
      });

      let perms  = createPermissions();
      let result = await perms.evaluate('shell:execute', null, {
        organizationID: orgID,
        riskLevel:      'strict',
      });

      assert.equal(result, false);
    });

    it('should handle rules with no scopeID on session scope (matches all sessions)', async () => {
      let [session] = await createSessionChain(1);

      await models.PermissionRule.create({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'allow',
        scope:          'session',
        scopeID:        null,
        priority:       10,
        createdBy:      'usr_test',
      });

      let perms  = createPermissions();
      let result = await perms.evaluate('shell:execute', {}, {
        organizationID: orgID,
        scope:          'session',
        scopeID:        session.id,
        riskLevel:      'strict',
      });

      assert.equal(result, false); // Session rule with no scopeID matches all
    });

    it('should handle evaluate() with no options (defaults)', async () => {
      let perms  = createPermissions();
      // No organizationID => no rules => strict default => needs approval
      let result = await perms.evaluate('shell:execute', {});
      assert.equal(result, true);
    });
  });
});
