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
  let testOrgID = 'org_test_perm';

  beforeEach(async () => {
    core = createKikxCore();
    await core.start();
    engine = core.getPermissionEngine();
  });

  afterEach(async () => {
    if (core && core.isStarted())
      await core.stop();
  });

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
      let { Organization } = core.getModels();
      await Organization.create({ id: testOrgID, name: 'Test Org' });

      let rule = await engine.createRule({
        organizationID: testOrgID,
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
      let { Organization } = core.getModels();
      await Organization.create({ id: 'org_scope_test', name: 'Scope Org' });

      let rule = await engine.createRule({
        organizationID: 'org_scope_test',
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
      let { Organization } = core.getModels();
      await Organization.create({ id: 'org_meta_test', name: 'Meta Org' });

      let rule = await engine.createRule({
        organizationID: 'org_meta_test',
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
      let { Organization } = core.getModels();
      await Organization.create({ id: 'org_prio_test', name: 'Priority Org' });

      let rule = await engine.createRule({
        organizationID: 'org_prio_test',
        featureName:    'shell:execute',
        effect:         'allow',
        priority:       100,
        createdBy:      'usr_test',
      });

      assert.equal(rule.priority, 100);
    });

    it('should create rule with expiration', async () => {
      let { Organization } = core.getModels();
      await Organization.create({ id: 'org_exp_test', name: 'Expiry Org' });

      let future = new Date(Date.now() + 60000);
      let rule = await engine.createRule({
        organizationID: 'org_exp_test',
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
    let orgID = 'org_check_test';

    beforeEach(async () => {
      let { Organization } = core.getModels();
      await Organization.create({ id: orgID, name: 'Check Org' });
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

    it('should return true (needs permission) when deny rule exists', async () => {
      await engine.createRule({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'deny',
        createdBy:      'usr_test',
      });

      let result = await engine.checkPermission('shell:execute', {}, {
        organizationID: orgID,
      });

      assert.equal(result, true);
    });

    it('should not match rules from other organizations', async () => {
      let { Organization } = core.getModels();
      await Organization.create({ id: 'org_other', name: 'Other Org' });

      await engine.createRule({
        organizationID: 'org_other',
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
    let orgID = 'org_priority_test';

    beforeEach(async () => {
      let { Organization } = core.getModels();
      await Organization.create({ id: orgID, name: 'Priority Org' });
    });

    it('should evaluate higher priority rules first', async () => {
      // Low priority deny
      await engine.createRule({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'deny',
        priority:       1,
        createdBy:      'usr_test',
      });

      // High priority allow
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

    it('should deny when higher priority deny rule exists', async () => {
      // Low priority allow
      await engine.createRule({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'allow',
        priority:       1,
        createdBy:      'usr_test',
      });

      // High priority deny
      await engine.createRule({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'deny',
        priority:       10,
        createdBy:      'usr_test',
      });

      let result = await engine.checkPermission('shell:execute', {}, {
        organizationID: orgID,
      });

      assert.equal(result, true); // Deny wins (higher priority)
    });
  });

  // -------------------------------------------------------------------------
  // checkPermission — scope filtering
  // -------------------------------------------------------------------------

  describe('checkPermission — scope', () => {
    let orgID = 'org_scope_check';

    beforeEach(async () => {
      let { Organization } = core.getModels();
      await Organization.create({ id: orgID, name: 'Scope Org' });
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

      assert.equal(result, false); // Global allow applies
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

      assert.equal(result, false); // Session allow applies
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

      assert.equal(result, true); // Different session, no match
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
    let orgID = 'org_expiry_check';

    beforeEach(async () => {
      let { Organization } = core.getModels();
      await Organization.create({ id: orgID, name: 'Expiry Org' });
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

      assert.equal(result, true); // Expired rule ignored, default deny
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

      assert.equal(result, false); // Active rule applies
    });
  });

  // -------------------------------------------------------------------------
  // deleteRule
  // -------------------------------------------------------------------------

  describe('deleteRule', () => {
    it('should delete an existing rule', async () => {
      let { Organization } = core.getModels();
      await Organization.create({ id: 'org_del_test', name: 'Del Org' });

      let rule = await engine.createRule({
        organizationID: 'org_del_test',
        featureName:    'shell:execute',
        effect:         'allow',
        createdBy:      'usr_test',
      });

      let deleted = await engine.deleteRule(rule.id);
      assert.equal(deleted, true);

      // Rule should no longer apply
      let result = await engine.checkPermission('shell:execute', {}, {
        organizationID: 'org_del_test',
      });

      assert.equal(result, true); // Default deny
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
      let { Organization, PermissionRule } = core.getModels();
      await Organization.create({ id: 'org_prune_test', name: 'Prune Org' });

      let past = new Date(Date.now() - 60000);

      await engine.createRule({
        organizationID: 'org_prune_test',
        featureName:    'shell:execute',
        effect:         'allow',
        expiresAt:      past,
        createdBy:      'usr_test',
      });

      let count = await engine.pruneExpired();
      assert.equal(count, 1);

      // Verify rule is gone
      let rules = await PermissionRule.where.organizationID.EQ('org_prune_test').all();
      assert.equal(rules.length, 0);
    });

    it('should not delete non-expired rules', async () => {
      let { Organization, PermissionRule } = core.getModels();
      await Organization.create({ id: 'org_prune_keep', name: 'Keep Org' });

      let future = new Date(Date.now() + 60000);

      await engine.createRule({
        organizationID: 'org_prune_keep',
        featureName:    'shell:execute',
        effect:         'allow',
        expiresAt:      future,
        createdBy:      'usr_test',
      });

      let count = await engine.pruneExpired();
      assert.equal(count, 0);

      let rules = await PermissionRule.where.organizationID.EQ('org_prune_keep').all();
      assert.equal(rules.length, 1);
    });
  });

  // -------------------------------------------------------------------------
  // getRules
  // -------------------------------------------------------------------------

  describe('getRules', () => {
    it('should return all rules for an organization', async () => {
      let { Organization } = core.getModels();
      await Organization.create({ id: 'org_get_rules', name: 'Get Rules Org' });

      await engine.createRule({
        organizationID: 'org_get_rules',
        featureName:    'shell:execute',
        effect:         'allow',
        createdBy:      'usr_test',
      });

      await engine.createRule({
        organizationID: 'org_get_rules',
        featureName:    'websearch:fetch',
        effect:         'deny',
        createdBy:      'usr_test',
      });

      let rules = await engine.getRules('org_get_rules');
      assert.equal(rules.length, 2);
    });

    it('should filter by featureName', async () => {
      let { Organization } = core.getModels();
      await Organization.create({ id: 'org_filter_rules', name: 'Filter Org' });

      await engine.createRule({
        organizationID: 'org_filter_rules',
        featureName:    'shell:execute',
        effect:         'allow',
        createdBy:      'usr_test',
      });

      await engine.createRule({
        organizationID: 'org_filter_rules',
        featureName:    'websearch:fetch',
        effect:         'deny',
        createdBy:      'usr_test',
      });

      let rules = await engine.getRules('org_filter_rules', { featureName: 'shell:execute' });
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
      let { Organization } = core.getModels();
      await Organization.create({ id: 'org_deny_throw', name: 'Deny Org' });

      await engine.createRule({
        organizationID: 'org_deny_throw',
        featureName:    'shell:rm',
        effect:         'deny',
        createdBy:      'usr_test',
      });

      await assert.rejects(
        () => engine.checkPermission('shell:rm', {}, { organizationID: 'org_deny_throw' }),
        (error) => {
          assert.equal(error.name, 'PermissionDeniedError');
          assert.equal(error.featureName, 'shell:rm');
          return true;
        },
      );
    });

    it('should throw PermissionDeniedError before checking allow rules', async () => {
      let { Organization } = core.getModels();
      await Organization.create({ id: 'org_deny_first', name: 'Deny First Org' });

      // Higher priority deny
      await engine.createRule({
        organizationID: 'org_deny_first',
        featureName:    'shell:execute',
        effect:         'deny',
        priority:       100,
        createdBy:      'usr_test',
      });

      // Lower priority allow
      await engine.createRule({
        organizationID: 'org_deny_first',
        featureName:    'shell:execute',
        effect:         'allow',
        priority:       50,
        createdBy:      'usr_test',
      });

      await assert.rejects(
        () => engine.checkPermission('shell:execute', {}, { organizationID: 'org_deny_first' }),
        (error) => error.name === 'PermissionDeniedError',
      );
    });
  });

  // ===========================================================================
  // Phase 3: Safety net for critical risk level
  // ===========================================================================

  describe('safety net — critical riskLevel', () => {
    it('should always require approval when toolClass.riskLevel is critical', async () => {
      let { Organization } = core.getModels();
      await Organization.create({ id: 'org_critical', name: 'Critical Org' });

      await engine.createRule({
        organizationID: 'org_critical',
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
        organizationID: 'org_critical',
        toolClass:      CriticalTool,
      });

      assert.equal(result, true); // Needs approval despite allow rule
    });

    it('should respect allow rules when riskLevel is low', async () => {
      let { Organization } = core.getModels();
      await Organization.create({ id: 'org_low_risk', name: 'Low Risk Org' });

      await engine.createRule({
        organizationID: 'org_low_risk',
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
        organizationID: 'org_low_risk',
        toolClass:      LowRiskTool,
      });

      assert.equal(result, false); // Allow rule respected
    });

    it('should respect allow rules when riskLevel is high (default)', async () => {
      let { Organization } = core.getModels();
      await Organization.create({ id: 'org_high_risk', name: 'High Risk Org' });

      await engine.createRule({
        organizationID: 'org_high_risk',
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
        organizationID: 'org_high_risk',
        toolClass:      HighRiskTool,
      });

      assert.equal(result, false); // Allow rule respected
    });
  });

  // ===========================================================================
  // Phase 3: Custom Permissions class matching
  // ===========================================================================

  describe('custom Permissions class matching', () => {
    it('should skip rule when custom matchesRule returns false', async () => {
      let { Permissions }   = await import('../../../src/core/permissions/permissions-base.mjs');
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

      let { Organization } = core.getModels();
      await Organization.create({ id: 'org_custom_match', name: 'Custom Match Org' });

      // Create allow rule that only matches 'ls' command
      await engine.createRule({
        organizationID: 'org_custom_match',
        featureName:    'shell:execute',
        effect:         'allow',
        metadata:       { allowedCommands: ['ls'] },
        createdBy:      'usr_test',
      });

      // Check with 'ls' command — should match allow rule
      let result = await engine.checkPermission('shell:execute', { command: 'ls -la' }, {
        organizationID: 'org_custom_match',
        toolClass:      ToolWithPerms,
      });
      assert.equal(result, false); // Allowed

      // Check with 'rm' command — should NOT match allow rule, default deny
      result = await engine.checkPermission('shell:execute', { command: 'rm -rf /' }, {
        organizationID: 'org_custom_match',
        toolClass:      ToolWithPerms,
      });
      assert.equal(result, true); // Needs approval
    });

    it('should work normally when toolClass has no Permissions class', async () => {
      let { Organization } = core.getModels();
      await Organization.create({ id: 'org_no_perms', name: 'No Perms Org' });

      await engine.createRule({
        organizationID: 'org_no_perms',
        featureName:    'test:feature',
        effect:         'allow',
        createdBy:      'usr_test',
      });

      let { PluginInterface } = await import('../../../src/core/plugin-loader/plugin-interface.mjs');

      class SimpleTool extends PluginInterface {
        async _execute() { return 'ok'; }
        // getPermissionsClass returns null by default
      }

      let result = await engine.checkPermission('test:feature', {}, {
        organizationID: 'org_no_perms',
        toolClass:      SimpleTool,
      });

      assert.equal(result, false); // Allow rule works
    });
  });
});
