'use strict';

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createKikxCore } from '../../../src/core/index.mjs';
import { PermissionEngine } from '../../../src/core/permissions/index.mjs';
import { Keystore } from '../../../src/core/crypto/keystore.mjs';

// =============================================================================
// PermissionEngine
// =============================================================================

describe('PermissionEngine', () => {
  let core;
  let engine;

  beforeEach(async () => {
    core = createKikxCore();
    await core.start();
    engine = core.getPermissionEngine();
  });

  afterEach(async () => {
    if (core && core.isStarted())
      await core.stop();
  });

  // Helper: create org with auto-generated ID
  async function createOrg(name) {
    let { Organization } = core.getModels();
    return await Organization.create({ name: name || 'Test Org' });
  }

  // -------------------------------------------------------------------------
  // Construction
  // -------------------------------------------------------------------------

  describe('construction', () => {
    it('should be available on core after start', () => {
      assert.ok(engine);
      assert.ok(engine instanceof PermissionEngine);
    });

    it('should be available on context after start', () => {
      let context = core.getContext();
      assert.ok(context.getProperty('permissionEngine'));
    });

    it('should throw if constructed without context', () => {
      assert.throws(
        () => new PermissionEngine(),
        { message: 'PermissionEngine requires a CascadingContext' },
      );
    });

    it('should be accessible via getPermissionEngine()', () => {
      assert.equal(core.getPermissionEngine(), engine);
    });
  });

  // -------------------------------------------------------------------------
  // createRule
  // -------------------------------------------------------------------------

  describe('createRule', () => {
    it('should create a permission rule', async () => {
      let org = await createOrg('Test Org');

      let rule = await engine.createRule({
        organizationID: org.id,
        featureName:    'shell:execute',
        effect:         'allow',
        createdBy:      'usr_test',
      });

      assert.ok(rule);
      assert.ok(rule.id.startsWith('prm_'));
      assert.equal(rule.featureName, 'shell:execute');
      assert.equal(rule.effect, 'allow');
      assert.equal(rule.scope, 'global');
    });

    it('should create rule with session scope', async () => {
      let org = await createOrg('Scope Org');

      let rule = await engine.createRule({
        organizationID: org.id,
        featureName:    'websearch:fetch',
        effect:         'deny',
        scope:          'session',
        scopeID:        'ses_123',
        createdBy:      'usr_test',
      });

      assert.equal(rule.scope, 'session');
      assert.equal(rule.scopeID, 'ses_123');
    });

    it('should create rule with metadata', async () => {
      let org = await createOrg('Meta Org');

      let rule = await engine.createRule({
        organizationID: org.id,
        featureName:    'shell:execute',
        effect:         'allow',
        metadata:       { allowedCommands: ['ls', 'cat'] },
        createdBy:      'usr_test',
      });

      assert.ok(rule.metadata);
      let parsed = JSON.parse(rule.metadata);
      assert.deepEqual(parsed.allowedCommands, ['ls', 'cat']);
    });

    it('should create rule with priority', async () => {
      let org = await createOrg('Priority Org');

      let rule = await engine.createRule({
        organizationID: org.id,
        featureName:    'shell:execute',
        effect:         'allow',
        priority:       100,
        createdBy:      'usr_test',
      });

      assert.equal(rule.priority, 100);
    });

    it('should create rule with expiration', async () => {
      let org = await createOrg('Expiry Org');

      let future = new Date(Date.now() + 60000);
      let rule = await engine.createRule({
        organizationID: org.id,
        featureName:    'shell:execute',
        effect:         'allow',
        expiresAt:      future,
        createdBy:      'usr_test',
      });

      assert.ok(rule.expiresAt);
    });
  });

  // -------------------------------------------------------------------------
  // checkPermission — basic evaluation
  // -------------------------------------------------------------------------

  describe('checkPermission', () => {
    let orgID;

    beforeEach(async () => {
      let org = await createOrg('Check Org');
      orgID   = org.id;
    });

    it('should return true (needs permission) when no rules exist', async () => {
      let result = await engine.checkPermission('shell:execute', {}, {
        organizationID: orgID,
      });

      assert.equal(result, true);
    });

    it('should return false (no permission needed) when allow rule exists', async () => {
      await engine.createRule({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'allow',
        createdBy:      'usr_test',
      });

      let result = await engine.checkPermission('shell:execute', {}, {
        organizationID: orgID,
      });

      assert.equal(result, false);
    });

    it('should throw PermissionDeniedError when deny rule exists', async () => {
      await engine.createRule({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'deny',
        createdBy:      'usr_test',
      });

      await assert.rejects(
        () => engine.checkPermission('shell:execute', {}, { organizationID: orgID }),
        (error) => error.name === 'PermissionDeniedError',
      );
    });

    it('should not match rules from other organizations', async () => {
      let otherOrg = await createOrg('Other Org');

      await engine.createRule({
        organizationID: otherOrg.id,
        featureName:    'shell:execute',
        effect:         'allow',
        createdBy:      'usr_test',
      });

      let result = await engine.checkPermission('shell:execute', {}, {
        organizationID: orgID,
      });

      assert.equal(result, true); // No matching rule for orgID
    });

    it('should not match rules for different features', async () => {
      await engine.createRule({
        organizationID: orgID,
        featureName:    'websearch:fetch',
        effect:         'allow',
        createdBy:      'usr_test',
      });

      let result = await engine.checkPermission('shell:execute', {}, {
        organizationID: orgID,
      });

      assert.equal(result, true); // Wrong feature name
    });
  });

  // -------------------------------------------------------------------------
  // checkPermission — priority ordering
  // -------------------------------------------------------------------------

  describe('checkPermission — priority', () => {
    let orgID;

    beforeEach(async () => {
      let org = await createOrg('Priority Org');
      orgID   = org.id;
    });

    it('should evaluate higher priority rules first', async () => {
      await engine.createRule({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'deny',
        priority:       1,
        createdBy:      'usr_test',
      });

      await engine.createRule({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'allow',
        priority:       10,
        createdBy:      'usr_test',
      });

      let result = await engine.checkPermission('shell:execute', {}, {
        organizationID: orgID,
      });

      assert.equal(result, false); // Allow wins (higher priority)
    });

    it('should throw PermissionDeniedError when higher priority deny rule exists', async () => {
      await engine.createRule({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'allow',
        priority:       1,
        createdBy:      'usr_test',
      });

      await engine.createRule({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'deny',
        priority:       10,
        createdBy:      'usr_test',
      });

      await assert.rejects(
        () => engine.checkPermission('shell:execute', {}, { organizationID: orgID }),
        (error) => error.name === 'PermissionDeniedError',
      );
    });
  });

  // -------------------------------------------------------------------------
  // checkPermission — scope filtering
  // -------------------------------------------------------------------------

  describe('checkPermission — scope', () => {
    let orgID;

    beforeEach(async () => {
      let org = await createOrg('Scope Org');
      orgID   = org.id;
    });

    it('should apply global rules when checking at session scope', async () => {
      await engine.createRule({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'allow',
        scope:          'global',
        createdBy:      'usr_test',
      });

      let result = await engine.checkPermission('shell:execute', {}, {
        organizationID: orgID,
        scope:          'session',
        scopeID:        'ses_123',
      });

      assert.equal(result, false);
    });

    it('should apply session rules when scopeID matches', async () => {
      await engine.createRule({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'allow',
        scope:          'session',
        scopeID:        'ses_abc',
        createdBy:      'usr_test',
      });

      let result = await engine.checkPermission('shell:execute', {}, {
        organizationID: orgID,
        scope:          'session',
        scopeID:        'ses_abc',
      });

      assert.equal(result, false);
    });

    it('should NOT apply session rules when scopeID does not match', async () => {
      await engine.createRule({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'allow',
        scope:          'session',
        scopeID:        'ses_abc',
        createdBy:      'usr_test',
      });

      let result = await engine.checkPermission('shell:execute', {}, {
        organizationID: orgID,
        scope:          'session',
        scopeID:        'ses_xyz',
      });

      assert.equal(result, true);
    });

    it('should apply frame-scoped rules at frame level', async () => {
      await engine.createRule({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'allow',
        scope:          'frame',
        scopeID:        'frm_123',
        createdBy:      'usr_test',
      });

      let result = await engine.checkPermission('shell:execute', {}, {
        organizationID: orgID,
        scope:          'frame',
        scopeID:        'frm_123',
      });

      assert.equal(result, false);
    });
  });

  // -------------------------------------------------------------------------
  // checkPermission — expired rules
  // -------------------------------------------------------------------------

  describe('checkPermission — expiration', () => {
    let orgID;

    beforeEach(async () => {
      let org = await createOrg('Expiry Org');
      orgID   = org.id;
    });

    it('should ignore expired rules', async () => {
      let past = new Date(Date.now() - 60000);

      await engine.createRule({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'allow',
        expiresAt:      past,
        createdBy:      'usr_test',
      });

      let result = await engine.checkPermission('shell:execute', {}, {
        organizationID: orgID,
      });

      assert.equal(result, true);
    });

    it('should apply non-expired rules', async () => {
      let future = new Date(Date.now() + 60000);

      await engine.createRule({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'allow',
        expiresAt:      future,
        createdBy:      'usr_test',
      });

      let result = await engine.checkPermission('shell:execute', {}, {
        organizationID: orgID,
      });

      assert.equal(result, false);
    });
  });

  // -------------------------------------------------------------------------
  // deleteRule
  // -------------------------------------------------------------------------

  describe('deleteRule', () => {
    it('should delete an existing rule', async () => {
      let org = await createOrg('Del Org');

      let rule = await engine.createRule({
        organizationID: org.id,
        featureName:    'shell:execute',
        effect:         'allow',
        createdBy:      'usr_test',
      });

      let deleted = await engine.deleteRule(rule.id);
      assert.equal(deleted, true);

      let result = await engine.checkPermission('shell:execute', {}, {
        organizationID: org.id,
      });

      assert.equal(result, true);
    });

    it('should return false for non-existent rule', async () => {
      let deleted = await engine.deleteRule('prm_nonexistent');
      assert.equal(deleted, false);
    });
  });

  // -------------------------------------------------------------------------
  // pruneExpired
  // -------------------------------------------------------------------------

  describe('pruneExpired', () => {
    it('should delete expired rules', async () => {
      let { PermissionRule } = core.getModels();
      let org  = await createOrg('Prune Org');
      let past = new Date(Date.now() - 60000);

      await engine.createRule({
        organizationID: org.id,
        featureName:    'shell:execute',
        effect:         'allow',
        expiresAt:      past,
        createdBy:      'usr_test',
      });

      let count = await engine.pruneExpired();
      assert.equal(count, 1);

      let rules = await PermissionRule.where.organizationID.EQ(org.id).all();
      assert.equal(rules.length, 0);
    });

    it('should not delete non-expired rules', async () => {
      let { PermissionRule } = core.getModels();
      let org    = await createOrg('Keep Org');
      let future = new Date(Date.now() + 60000);

      await engine.createRule({
        organizationID: org.id,
        featureName:    'shell:execute',
        effect:         'allow',
        expiresAt:      future,
        createdBy:      'usr_test',
      });

      let count = await engine.pruneExpired();
      assert.equal(count, 0);

      let rules = await PermissionRule.where.organizationID.EQ(org.id).all();
      assert.equal(rules.length, 1);
    });
  });

  // -------------------------------------------------------------------------
  // getRules
  // -------------------------------------------------------------------------

  describe('getRules', () => {
    it('should return all rules for an organization', async () => {
      let org = await createOrg('Get Rules Org');

      await engine.createRule({
        organizationID: org.id,
        featureName:    'shell:execute',
        effect:         'allow',
        createdBy:      'usr_test',
      });

      await engine.createRule({
        organizationID: org.id,
        featureName:    'websearch:fetch',
        effect:         'deny',
        createdBy:      'usr_test',
      });

      let rules = await engine.getRules(org.id);
      assert.equal(rules.length, 2);
    });

    it('should filter by featureName', async () => {
      let org = await createOrg('Filter Org');

      await engine.createRule({
        organizationID: org.id,
        featureName:    'shell:execute',
        effect:         'allow',
        createdBy:      'usr_test',
      });

      await engine.createRule({
        organizationID: org.id,
        featureName:    'websearch:fetch',
        effect:         'deny',
        createdBy:      'usr_test',
      });

      let rules = await engine.getRules(org.id, { featureName: 'shell:execute' });
      assert.equal(rules.length, 1);
      assert.equal(rules[0].featureName, 'shell:execute');
    });
  });

  // ===========================================================================
  // Phase 3: PermissionDeniedError on deny rules
  // ===========================================================================

  describe('deny rules — PermissionDeniedError', () => {
    it('should throw PermissionDeniedError when deny rule matches', async () => {
      let { PermissionDeniedError } = await import('../../../src/core/permissions/permission-denied-error.mjs');
      let org = await createOrg('Deny Org');

      await engine.createRule({
        organizationID: org.id,
        featureName:    'shell:rm',
        effect:         'deny',
        createdBy:      'usr_test',
      });

      await assert.rejects(
        () => engine.checkPermission('shell:rm', {}, { organizationID: org.id }),
        (error) => {
          assert.equal(error.name, 'PermissionDeniedError');
          assert.equal(error.featureName, 'shell:rm');
          return true;
        },
      );
    });

    it('should throw PermissionDeniedError before checking allow rules', async () => {
      let org = await createOrg('Deny First Org');

      await engine.createRule({
        organizationID: org.id,
        featureName:    'shell:execute',
        effect:         'deny',
        priority:       100,
        createdBy:      'usr_test',
      });

      await engine.createRule({
        organizationID: org.id,
        featureName:    'shell:execute',
        effect:         'allow',
        priority:       50,
        createdBy:      'usr_test',
      });

      await assert.rejects(
        () => engine.checkPermission('shell:execute', {}, { organizationID: org.id }),
        (error) => error.name === 'PermissionDeniedError',
      );
    });
  });

  // ===========================================================================
  // Phase 3: Safety net for critical risk level
  // ===========================================================================

  describe('safety net — critical riskLevel', () => {
    it('should always require approval when toolClass.riskLevel is critical', async () => {
      let org = await createOrg('Critical Org');

      await engine.createRule({
        organizationID: org.id,
        featureName:    'nuclear:launch',
        effect:         'allow',
        createdBy:      'usr_test',
      });

      let { PluginInterface } = await import('../../../src/core/plugin-loader/plugin-interface.mjs');

      class CriticalTool extends PluginInterface {
        static riskLevel = 'critical';
        async _execute() { return 'boom'; }
      }

      let result = await engine.checkPermission('nuclear:launch', {}, {
        organizationID: org.id,
        toolClass:      CriticalTool,
      });

      assert.equal(result, true);
    });

    it('should respect allow rules when riskLevel is low', async () => {
      let org = await createOrg('Low Risk Org');

      await engine.createRule({
        organizationID: org.id,
        featureName:    'help:search',
        effect:         'allow',
        createdBy:      'usr_test',
      });

      let { PluginInterface } = await import('../../../src/core/plugin-loader/plugin-interface.mjs');

      class LowRiskTool extends PluginInterface {
        static riskLevel = 'low';
        async _execute() { return 'safe'; }
      }

      let result = await engine.checkPermission('help:search', {}, {
        organizationID: org.id,
        toolClass:      LowRiskTool,
      });

      assert.equal(result, false);
    });

    it('should respect allow rules when riskLevel is high (default)', async () => {
      let org = await createOrg('High Risk Org');

      await engine.createRule({
        organizationID: org.id,
        featureName:    'shell:execute',
        effect:         'allow',
        createdBy:      'usr_test',
      });

      let { PluginInterface } = await import('../../../src/core/plugin-loader/plugin-interface.mjs');

      class HighRiskTool extends PluginInterface {
        static riskLevel = 'high';
        async _execute() { return 'ok'; }
      }

      let result = await engine.checkPermission('shell:execute', {}, {
        organizationID: org.id,
        toolClass:      HighRiskTool,
      });

      assert.equal(result, false);
    });
  });

  // ===========================================================================
  // Phase 3: Custom Permissions class matching
  // ===========================================================================

  describe('custom Permissions class matching', () => {
    it('should skip rule when custom matchesRule returns false', async () => {
      let { Permissions }    = await import('../../../src/core/permissions/permissions-base.mjs');
      let { PluginInterface } = await import('../../../src/core/plugin-loader/plugin-interface.mjs');

      class SelectivePermissions extends Permissions {
        matchesRule(_rule, args, metadata) {
          if (metadata && metadata.allowedCommands && args && args.command) {
            let baseCommand = args.command.split(/\s+/)[0];
            return { matches: metadata.allowedCommands.includes(baseCommand) };
          }
          return { matches: true };
        }
      }

      class ToolWithPerms extends PluginInterface {
        async _execute() { return 'ok'; }
        getPermissionsClass() { return SelectivePermissions; }
      }

      let org = await createOrg('Custom Match Org');

      await engine.createRule({
        organizationID: org.id,
        featureName:    'shell:execute',
        effect:         'allow',
        metadata:       { allowedCommands: ['ls'] },
        createdBy:      'usr_test',
      });

      let result = await engine.checkPermission('shell:execute', { command: 'ls -la' }, {
        organizationID: org.id,
        toolClass:      ToolWithPerms,
      });
      assert.equal(result, false);

      result = await engine.checkPermission('shell:execute', { command: 'rm -rf /' }, {
        organizationID: org.id,
        toolClass:      ToolWithPerms,
      });
      assert.equal(result, true);
    });

    it('should work normally when toolClass has no Permissions class', async () => {
      let org = await createOrg('No Perms Org');

      await engine.createRule({
        organizationID: org.id,
        featureName:    'test:feature',
        effect:         'allow',
        createdBy:      'usr_test',
      });

      let { PluginInterface } = await import('../../../src/core/plugin-loader/plugin-interface.mjs');

      class SimpleTool extends PluginInterface {
        async _execute() { return 'ok'; }
      }

      let result = await engine.checkPermission('test:feature', {}, {
        organizationID: org.id,
        toolClass:      SimpleTool,
      });

      assert.equal(result, false);
    });
  });

  // ===========================================================================
  // Failure & adversarial tests
  // ===========================================================================

  describe('PermissionDeniedError — properties', () => {
    it('should have correct name, featureName, reason, and message', async () => {
      let { PermissionDeniedError } = await import('../../../src/core/permissions/permission-denied-error.mjs');
      let error = new PermissionDeniedError('shell:rm', 'blocked by policy');

      assert.equal(error.name, 'PermissionDeniedError');
      assert.equal(error.featureName, 'shell:rm');
      assert.equal(error.reason, 'blocked by policy');
      assert.equal(error.message, 'Permission denied for "shell:rm": blocked by policy');
      assert.ok(error instanceof Error);
    });

    it('should default reason to "explicit deny" when not provided', async () => {
      let { PermissionDeniedError } = await import('../../../src/core/permissions/permission-denied-error.mjs');
      let error = new PermissionDeniedError('websearch:fetch');

      assert.equal(error.reason, 'explicit deny');
      assert.match(error.message, /explicit deny/);
    });

    it('should handle undefined featureName', async () => {
      let { PermissionDeniedError } = await import('../../../src/core/permissions/permission-denied-error.mjs');
      let error = new PermissionDeniedError(undefined, 'some reason');

      assert.equal(error.featureName, undefined);
      assert.match(error.message, /undefined/);
    });
  });

  describe('checkPermission — adversarial inputs', () => {
    let orgID;

    beforeEach(async () => {
      let org = await createOrg('Adversarial Org');
      orgID   = org.id;
    });

    it('should default to needs-permission when organizationID is undefined', async () => {
      let result = await engine.checkPermission('shell:execute', {}, {});
      assert.equal(result, true);
    });

    it('should default to needs-permission when featureName is empty string', async () => {
      await engine.createRule({
        organizationID: orgID,
        featureName:    '',
        effect:         'allow',
        createdBy:      'usr_test',
      });

      let result = await engine.checkPermission('shell:execute', {}, {
        organizationID: orgID,
      });
      assert.equal(result, true);
    });

    it('should match empty-string featureName rule against empty-string check', async () => {
      await engine.createRule({
        organizationID: orgID,
        featureName:    '',
        effect:         'allow',
        createdBy:      'usr_test',
      });

      let result = await engine.checkPermission('', {}, {
        organizationID: orgID,
      });
      assert.equal(result, false);
    });

    it('should handle args being null without crashing', async () => {
      await engine.createRule({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'allow',
        createdBy:      'usr_test',
      });

      let result = await engine.checkPermission('shell:execute', null, {
        organizationID: orgID,
      });
      assert.equal(result, false);
    });

    it('should handle options being undefined (default param)', async () => {
      let result = await engine.checkPermission('shell:execute', {});
      assert.equal(result, true);
    });

    it('should not match rules across organizations (cross-org isolation)', async () => {
      let victimOrg   = await createOrg('Victim Org');
      let attackerOrg = await createOrg('Attacker Org');

      await engine.createRule({
        organizationID: attackerOrg.id,
        featureName:    '*',
        effect:         'allow',
        createdBy:      'usr_attacker',
      });

      let result = await engine.checkPermission('*', {}, {
        organizationID: victimOrg.id,
      });
      assert.equal(result, true);
    });
  });

  describe('createRule — edge cases', () => {
    it('should default scope to global when not specified', async () => {
      let org = await createOrg('Default Scope Org');

      let rule = await engine.createRule({
        organizationID: org.id,
        featureName:    'test:thing',
        effect:         'allow',
        createdBy:      'usr_test',
      });

      assert.equal(rule.scope, 'global');
    });

    it('should default priority to 0 when not specified', async () => {
      let org = await createOrg('Default Prio Org');

      let rule = await engine.createRule({
        organizationID: org.id,
        featureName:    'test:thing',
        effect:         'allow',
        createdBy:      'usr_test',
      });

      assert.equal(rule.priority, 0);
    });

    it('should store null metadata when not provided', async () => {
      let org = await createOrg('Null Meta Org');

      let rule = await engine.createRule({
        organizationID: org.id,
        featureName:    'test:thing',
        effect:         'allow',
        createdBy:      'usr_test',
      });

      assert.equal(rule.metadata, null);
    });

    it('should serialize complex metadata to JSON', async () => {
      let org = await createOrg('Complex Meta Org');

      let rule = await engine.createRule({
        organizationID: org.id,
        featureName:    'test:thing',
        effect:         'allow',
        metadata:       { nested: { deep: true }, list: [1, 2, 3] },
        createdBy:      'usr_test',
      });

      let parsed = JSON.parse(rule.metadata);
      assert.deepEqual(parsed.nested, { deep: true });
      assert.deepEqual(parsed.list, [1, 2, 3]);
    });
  });

  describe('getRules — edge cases', () => {
    it('should return empty array for non-existent organization', async () => {
      let rules = await engine.getRules('org_does_not_exist');
      assert.deepEqual(rules, []);
    });

    it('should return empty array when featureName filter has no matches', async () => {
      let org = await createOrg('No Match Org');

      await engine.createRule({
        organizationID: org.id,
        featureName:    'shell:execute',
        effect:         'allow',
        createdBy:      'usr_test',
      });

      let rules = await engine.getRules(org.id, { featureName: 'websearch:fetch' });
      assert.equal(rules.length, 0);
    });

    it('should filter by scope', async () => {
      let org = await createOrg('Scope Filter Org');

      await engine.createRule({
        organizationID: org.id,
        featureName:    'shell:execute',
        effect:         'allow',
        scope:          'global',
        createdBy:      'usr_test',
      });

      await engine.createRule({
        organizationID: org.id,
        featureName:    'shell:execute',
        effect:         'allow',
        scope:          'session',
        scopeID:        'ses_abc',
        createdBy:      'usr_test',
      });

      let rules = await engine.getRules(org.id, { scope: 'session' });
      assert.equal(rules.length, 1);
      assert.equal(rules[0].scope, 'session');
    });
  });

  describe('deleteRule — edge cases', () => {
    it('should return false for empty string ID', async () => {
      let deleted = await engine.deleteRule('');
      assert.equal(deleted, false);
    });

    it('should return false for null ID', async () => {
      let deleted = await engine.deleteRule(null);
      assert.equal(deleted, false);
    });

    it('should not affect other rules when deleting one', async () => {
      let org = await createOrg('Del Isolation Org');

      let rule1 = await engine.createRule({
        organizationID: org.id,
        featureName:    'shell:execute',
        effect:         'allow',
        createdBy:      'usr_test',
      });

      await engine.createRule({
        organizationID: org.id,
        featureName:    'websearch:fetch',
        effect:         'deny',
        createdBy:      'usr_test',
      });

      await engine.deleteRule(rule1.id);

      let rules = await engine.getRules(org.id);
      assert.equal(rules.length, 1);
      assert.equal(rules[0].featureName, 'websearch:fetch');
    });
  });

  describe('scope filtering — adversarial', () => {
    let orgID;

    beforeEach(async () => {
      let org = await createOrg('Scope Adv Org');
      orgID   = org.id;
    });

    it('should not apply frame rules at session scope', async () => {
      await engine.createRule({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'allow',
        scope:          'frame',
        scopeID:        'frm_123',
        createdBy:      'usr_test',
      });

      let result = await engine.checkPermission('shell:execute', {}, {
        organizationID: orgID,
        scope:          'session',
        scopeID:        'ses_456',
      });

      assert.equal(result, true);
    });

    it('should handle unknown scope value gracefully', async () => {
      await engine.createRule({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'allow',
        scope:          'global',
        createdBy:      'usr_test',
      });

      let result = await engine.checkPermission('shell:execute', {}, {
        organizationID: orgID,
        scope:          'bogus_scope',
      });

      assert.equal(result, false);
    });

    it('should apply global rules even when checking at frame scope', async () => {
      await engine.createRule({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'allow',
        scope:          'global',
        createdBy:      'usr_test',
      });

      let result = await engine.checkPermission('shell:execute', {}, {
        organizationID: orgID,
        scope:          'frame',
        scopeID:        'frm_789',
      });

      assert.equal(result, false);
    });
  });

  describe('deny + safety net combinations', () => {
    it('should return true for critical riskLevel even with deny rule (safety net first)', async () => {
      let org = await createOrg('Crit Deny Org');

      await engine.createRule({
        organizationID: org.id,
        featureName:    'nuclear:launch',
        effect:         'deny',
        createdBy:      'usr_test',
      });

      let { PluginInterface } = await import('../../../src/core/plugin-loader/plugin-interface.mjs');

      class CriticalTool extends PluginInterface {
        static riskLevel = 'critical';
        async _execute() { return 'boom'; }
      }

      let result = await engine.checkPermission('nuclear:launch', {}, {
        organizationID: org.id,
        toolClass:      CriticalTool,
      });

      assert.equal(result, true);
    });

    it('should throw PermissionDeniedError for deny with metadata', async () => {
      let org = await createOrg('Deny Meta Org');

      await engine.createRule({
        organizationID: org.id,
        featureName:    'shell:execute',
        effect:         'deny',
        metadata:       { reason: 'company policy' },
        createdBy:      'usr_test',
      });

      await assert.rejects(
        () => engine.checkPermission('shell:execute', {}, { organizationID: org.id }),
        (error) => {
          assert.equal(error.name, 'PermissionDeniedError');
          return true;
        },
      );
    });

    it('should deny wins over lower-priority allow (deny at priority 10, allow at 5)', async () => {
      let org = await createOrg('Deny Wins Org');

      await engine.createRule({
        organizationID: org.id,
        featureName:    'shell:execute',
        effect:         'deny',
        priority:       10,
        createdBy:      'usr_test',
      });

      await engine.createRule({
        organizationID: org.id,
        featureName:    'shell:execute',
        effect:         'allow',
        priority:       5,
        createdBy:      'usr_test',
      });

      await assert.rejects(
        () => engine.checkPermission('shell:execute', {}, { organizationID: org.id }),
        (error) => error.name === 'PermissionDeniedError',
      );
    });

    it('should allow wins when allow has higher priority than deny', async () => {
      let org = await createOrg('Allow Wins Org');

      await engine.createRule({
        organizationID: org.id,
        featureName:    'shell:execute',
        effect:         'allow',
        priority:       10,
        createdBy:      'usr_test',
      });

      await engine.createRule({
        organizationID: org.id,
        featureName:    'shell:execute',
        effect:         'deny',
        priority:       5,
        createdBy:      'usr_test',
      });

      let result = await engine.checkPermission('shell:execute', {}, {
        organizationID: org.id,
      });
      assert.equal(result, false);
    });
  });

  describe('custom Permissions class — failure paths', () => {
    it('should handle custom matchesRule that throws', async () => {
      let { Permissions }    = await import('../../../src/core/permissions/permissions-base.mjs');
      let { PluginInterface } = await import('../../../src/core/plugin-loader/plugin-interface.mjs');

      class BrokenPermissions extends Permissions {
        matchesRule() { throw new Error('matchesRule exploded'); }
      }

      class BrokenTool extends PluginInterface {
        async _execute() { return 'ok'; }
        getPermissionsClass() { return BrokenPermissions; }
      }

      let org = await createOrg('Broken Perm Org');

      await engine.createRule({
        organizationID: org.id,
        featureName:    'test:feature',
        effect:         'allow',
        createdBy:      'usr_test',
      });

      await assert.rejects(
        () => engine.checkPermission('test:feature', {}, {
          organizationID: org.id,
          toolClass:      BrokenTool,
        }),
        { message: 'matchesRule exploded' },
      );
    });

    it('should handle custom matchesRule returning non-object', async () => {
      let { Permissions }    = await import('../../../src/core/permissions/permissions-base.mjs');
      let { PluginInterface } = await import('../../../src/core/plugin-loader/plugin-interface.mjs');

      class WeirdPermissions extends Permissions {
        matchesRule() { return 'yes'; }
      }

      class WeirdTool extends PluginInterface {
        async _execute() { return 'ok'; }
        getPermissionsClass() { return WeirdPermissions; }
      }

      let org = await createOrg('Weird Perm Org');

      await engine.createRule({
        organizationID: org.id,
        featureName:    'test:feature',
        effect:         'allow',
        createdBy:      'usr_test',
      });

      let result = await engine.checkPermission('test:feature', {}, {
        organizationID: org.id,
        toolClass:      WeirdTool,
      });
      assert.equal(result, false);
    });

    it('should handle custom matchesRule returning null', async () => {
      let { Permissions }    = await import('../../../src/core/permissions/permissions-base.mjs');
      let { PluginInterface } = await import('../../../src/core/plugin-loader/plugin-interface.mjs');

      class NullPermissions extends Permissions {
        matchesRule() { return null; }
      }

      class NullTool extends PluginInterface {
        async _execute() { return 'ok'; }
        getPermissionsClass() { return NullPermissions; }
      }

      let org = await createOrg('Null Perm Org');

      await engine.createRule({
        organizationID: org.id,
        featureName:    'test:feature',
        effect:         'allow',
        createdBy:      'usr_test',
      });

      let result = await engine.checkPermission('test:feature', {}, {
        organizationID: org.id,
        toolClass:      NullTool,
      });
      assert.equal(result, false);
    });
  });

  describe('pruneExpired — edge cases', () => {
    it('should return 0 when no rules exist at all', async () => {
      let count = await engine.pruneExpired();
      assert.equal(count, 0);
    });

    it('should only prune expired, leaving active and no-expiry rules', async () => {
      let { PermissionRule } = core.getModels();
      let org    = await createOrg('Prune Mixed Org');
      let past   = new Date(Date.now() - 60000);
      let future = new Date(Date.now() + 60000);

      await engine.createRule({
        organizationID: org.id,
        featureName:    'shell:execute',
        effect:         'allow',
        expiresAt:      past,
        createdBy:      'usr_test',
      });

      await engine.createRule({
        organizationID: org.id,
        featureName:    'shell:execute',
        effect:         'allow',
        expiresAt:      future,
        createdBy:      'usr_test',
      });

      await engine.createRule({
        organizationID: org.id,
        featureName:    'websearch:fetch',
        effect:         'deny',
        createdBy:      'usr_test',
      });

      let count = await engine.pruneExpired();
      assert.equal(count, 1);

      let remaining = await PermissionRule.where.organizationID.EQ(org.id).all();
      assert.equal(remaining.length, 2);
    });
  });
});
