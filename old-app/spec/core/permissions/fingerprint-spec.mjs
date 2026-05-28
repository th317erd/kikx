'use strict';

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createKikxCore } from '../../../src/core/index.mjs';
import { Keystore } from '../../../src/core/crypto/keystore.mjs';
import { Permissions } from '../../../src/core/permissions/permissions-base.mjs';

// =============================================================================
// Permission Fingerprinting (Step 19)
// =============================================================================
// Verifies that permission rules can be fingerprinted with a user key
// and that Permissions.evaluate() validates fingerprints when enabled.
// =============================================================================

describe('Permission Fingerprinting', () => {
  let core;
  let permissions;
  let keystore;
  let userKey;
  let orgID;

  beforeEach(async () => {
    core = createKikxCore();
    await core.start();

    let context = core.getContext();

    // Set up keystore on context for fingerprinting
    keystore = new Keystore({ devMode: true, devSeed: 'fingerprint-test' });
    keystore.initialize();
    context.setProperty('keystore', keystore);

    permissions = new Permissions(context);

    // Derive a user key
    let umk = keystore.generateUMK();
    userKey = keystore.deriveUserKey(umk, 'usr_fp_test');

    // Create org (let ORM generate valid XID)
    let { Organization } = core.getModels();
    let org = await Organization.create({ name: 'Fingerprint Org' });
    orgID = org.id;
  });

  afterEach(async () => {
    keystore.destroy();
    if (core && core.isStarted())
      await core.stop();
  });

  it('should store fingerprint when userKey is provided to createRule', async () => {
    let rule = await permissions.createRule({
      organizationID: orgID,
      featureName:    'shell:execute',
      effect:         'allow',
      createdBy:      'usr_fp_test',
      userKey,
    });

    assert.ok(rule.fingerprint);
    assert.equal(typeof rule.fingerprint, 'string');
    assert.ok(rule.fingerprint.length > 0);
  });

  it('should NOT store fingerprint when userKey is not provided', async () => {
    let rule = await permissions.createRule({
      organizationID: orgID,
      featureName:    'shell:execute',
      effect:         'allow',
      createdBy:      'usr_fp_test',
    });

    // Nullable fields not explicitly set are undefined in Mythix ORM
    assert.equal(rule.fingerprint == null, true);
  });

  it('should compute fingerprint from correct fields', async () => {
    let rule = await permissions.createRule({
      organizationID: orgID,
      featureName:    'shell:execute',
      effect:         'allow',
      createdBy:      'usr_fp_test',
      userKey,
    });

    // Manually recompute expected fingerprint
    let fingerprintData = `${orgID}:shell:execute:allow:global`;
    let expected        = keystore.fingerprint(fingerprintData, userKey);

    assert.equal(rule.fingerprint, expected);
  });

  it('should produce different fingerprints for different features', async () => {
    let rule1 = await permissions.createRule({
      organizationID: orgID,
      featureName:    'shell:execute',
      effect:         'allow',
      createdBy:      'usr_fp_test',
      userKey,
    });

    let rule2 = await permissions.createRule({
      organizationID: orgID,
      featureName:    'websearch:fetch',
      effect:         'allow',
      createdBy:      'usr_fp_test',
      userKey,
    });

    assert.notEqual(rule1.fingerprint, rule2.fingerprint);
  });
});
