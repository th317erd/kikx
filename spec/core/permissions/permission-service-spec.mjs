'use strict';

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createKikxCore }        from '../../../src/core/index.mjs';
import { Keystore }              from '../../../src/core/crypto/keystore.mjs';
import { Permissions }           from '../../../src/core/permissions/permissions-base.mjs';
import { PermissionService }     from '../../../src/core/permissions/permission-service.mjs';
import { PermissionDeniedError } from '../../../src/core/permissions/permission-denied-error.mjs';

// =============================================================================
// Phase C3 — PermissionService Tests
// =============================================================================

describe('PermissionService (C3)', () => {
  let core;
  let models;
  let context;
  let keystore;
  let permissions;

  before(async () => {
    core = createKikxCore();
    await core.start();
    models  = core.getModels();
    context = core.getContext();

    keystore = new Keystore({ devMode: true, devSeed: 'permission-service-test' });
    keystore.initialize();
    context.setProperty('keystore', keystore);

    permissions = new Permissions(context);
  });

  after(async () => {
    if (keystore)
      keystore.destroy();

    if (core && core.isStarted())
      await core.stop();
  });

  function createService() {
    return new PermissionService({
      context,
      keystore,
    });
  }

  async function createTestOrg() {
    return models.Organization.create({ name: 'Perm Service Org' });
  }

  // ---------------------------------------------------------------------------
  // Construction
  // ---------------------------------------------------------------------------

  describe('construction', () => {
    it('should create with required dependencies', () => {
      let service = createService();
      assert.ok(service);
    });

    it('should throw without context', () => {
      assert.throws(
        () => new PermissionService({ keystore }),
        /requires context/,
      );
    });

    it('should throw without keystore', () => {
      assert.throws(
        () => new PermissionService({ context }),
        /requires keystore/,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // check
  // ---------------------------------------------------------------------------

  describe('check', () => {
    it('should return needs-approval when no rules exist', async () => {
      let org     = await createTestOrg();
      let service = createService();

      let result = await service.check('shell:execute', { command: 'ls' }, {
        organizationID: org.id,
      });

      assert.equal(result.decision, 'needs-approval');
      assert.equal(result.signature, undefined);
    });

    it('should return allow with signature when allow rule exists', async () => {
      let org     = await createTestOrg();
      let service = createService();

      // Create an allow rule
      await permissions.createRule({
        organizationID: org.id,
        featureName:    'test:allowed',
        effect:         'allow',
        scope:          'global',
        createdBy:      'usr_test',
      });

      let result = await service.check('test:allowed', {}, {
        organizationID: org.id,
      });

      assert.equal(result.decision, 'allow');
      assert.ok(result.signature);
      assert.match(result.signature, /^[0-9a-f]{64}$/);
    });

    it('should throw PermissionDeniedError when deny rule exists', async () => {
      let org     = await createTestOrg();
      let service = createService();

      // Create a deny rule
      await permissions.createRule({
        organizationID: org.id,
        featureName:    'test:denied',
        effect:         'deny',
        scope:          'global',
        createdBy:      'usr_test',
      });

      await assert.rejects(
        () => service.check('test:denied', {}, { organizationID: org.id }),
        (err) => err.name === 'PermissionDeniedError',
      );
    });

    it('should pass sessionID as scope when provided', async () => {
      let org     = await createTestOrg();
      let service = createService();

      // Create a session-scoped allow rule
      await permissions.createRule({
        organizationID: org.id,
        featureName:    'test:session-scoped',
        effect:         'allow',
        scope:          'session',
        scopeID:        'ses_target',
        createdBy:      'usr_test',
      });

      // Should be allowed for matching session
      let result = await service.check('test:session-scoped', {}, {
        organizationID: org.id,
        sessionID:      'ses_target',
      });

      assert.equal(result.decision, 'allow');
    });
  });

  // ---------------------------------------------------------------------------
  // Standing approvals
  // ---------------------------------------------------------------------------

  describe('standing approvals', () => {
    it('should create a standing approval rule', async () => {
      let org     = await createTestOrg();
      let service = createService();

      let rule = await service.createStandingApproval({
        organizationID: org.id,
        sessionID:      'ses_standing_1',
        featureName:    'shell:execute',
        createdBy:      'usr_test',
      });

      assert.ok(rule);
      assert.equal(rule.effect, 'allow');
      assert.equal(rule.scope, 'session');
      assert.equal(rule.scopeID, 'ses_standing_1');
      assert.equal(rule.featureName, 'shell:execute');

      let metadata = JSON.parse(rule.metadata);
      assert.equal(metadata.standing, true);
      assert.ok(metadata.signature);
    });

    it('should auto-approve matching tool calls when standing approval exists', async () => {
      let org     = await createTestOrg();
      let service = createService();

      // Create standing approval for session
      await service.createStandingApproval({
        organizationID: org.id,
        sessionID:      'ses_auto_approve',
        featureName:    'shell:execute',
        createdBy:      'usr_test',
      });

      // Now check permission — should be approved
      let result = await service.check('shell:execute', { command: 'ls' }, {
        organizationID: org.id,
        sessionID:      'ses_auto_approve',
      });

      assert.equal(result.decision, 'allow');
      assert.ok(result.signature);
    });

    it('should use wildcard standing approval for any tool', async () => {
      let org     = await createTestOrg();
      let service = createService();

      // Create wildcard standing approval
      await service.createStandingApproval({
        organizationID: org.id,
        sessionID:      'ses_wildcard',
        createdBy:      'usr_test',
        // featureName defaults to '*'
      });

      // Check a random tool — should be approved via wildcard
      let result = await service.check('*', { anything: true }, {
        organizationID: org.id,
        sessionID:      'ses_wildcard',
      });

      assert.equal(result.decision, 'allow');
    });

    it('should require organizationID for standing approval', async () => {
      let service = createService();

      await assert.rejects(
        () => service.createStandingApproval({ sessionID: 'ses_1' }),
        /organizationID/,
      );
    });

    it('should require sessionID for standing approval', async () => {
      let service = createService();

      await assert.rejects(
        () => service.createStandingApproval({ organizationID: 'org_1' }),
        /sessionID/,
      );
    });

    it('should revoke standing approvals', async () => {
      let org     = await createTestOrg();
      let service = createService();

      await service.createStandingApproval({
        organizationID: org.id,
        sessionID:      'ses_revoke',
        featureName:    'shell:execute',
        createdBy:      'usr_test',
      });

      let revoked = await service.revokeStandingApproval('ses_revoke', {
        organizationID: org.id,
      });

      assert.equal(revoked, 1);

      // Now check — should need approval again
      let result = await service.check('shell:execute', {}, {
        organizationID: org.id,
        sessionID:      'ses_revoke',
      });

      assert.equal(result.decision, 'needs-approval');
    });
  });

  // ---------------------------------------------------------------------------
  // Envelope signing
  // ---------------------------------------------------------------------------

  describe('envelope signing', () => {
    it('should sign and verify an approval', () => {
      let service   = createService();
      let signature = service.signApproval('approve', 'frm_1', 'shell:execute', { command: 'ls' });

      assert.ok(signature);
      assert.match(signature, /^[0-9a-f]{64}$/);

      let valid = service.verifyApproval('approve', 'frm_1', 'shell:execute', { command: 'ls' }, signature);
      assert.equal(valid, true);
    });

    it('should reject tampered data', () => {
      let service   = createService();
      let signature = service.signApproval('approve', 'frm_2', 'shell:execute', { command: 'ls' });

      let valid = service.verifyApproval('approve', 'frm_2', 'shell:execute', { command: 'rm -rf /' }, signature);
      assert.equal(valid, false);
    });

    it('should reject invalid signatures', () => {
      let service = createService();
      let valid   = service.verifyApproval('approve', 'frm_3', 'test', {}, 'a'.repeat(64));
      assert.equal(valid, false);
    });

    it('should produce deterministic signatures', () => {
      let service = createService();
      let sig1    = service.signApproval('approve', 'frm_4', 'test:tool', { a: 1, b: 2 });
      let sig2    = service.signApproval('approve', 'frm_4', 'test:tool', { b: 2, a: 1 });
      assert.equal(sig1, sig2);
    });
  });
});
