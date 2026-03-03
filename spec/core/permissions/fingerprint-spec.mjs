'use strict';

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createKikxCore } from '../../../src/core/index.mjs';
import { Keystore } from '../../../src/core/crypto/keystore.mjs';

// =============================================================================
// Permission Fingerprinting (Step 19)
// =============================================================================
// Verifies that permission rules can be fingerprinted with a user key
// and that checkPermission validates fingerprints when enabled.
// =============================================================================

describe('Permission Fingerprinting', () => {
  let core;
  let engine;
  let keystore;
  let userKey;
  let orgID;

  beforeEach(async () => {
    core = createKikxCore();
    await core.start();

    engine = core.getPermissionEngine();

    // Set up keystore on context for fingerprinting
    keystore = new Keystore({ devMode: true, devSeed: 'fingerprint-test' });
    keystore.initialize();
    core.getContext().setProperty('keystore', keystore);

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
    let rule = await engine.createRule({
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
    let rule = await engine.createRule({
      organizationID: orgID,
      featureName:    'shell:execute',
      effect:         'allow',
      createdBy:      'usr_fp_test',
    });

    // Nullable fields not explicitly set are undefined in Mythix ORM
    assert.equal(rule.fingerprint == null, true);
  });

  it('should trust rule with valid fingerprint when verification enabled', async () => {
    await engine.createRule({
      organizationID: orgID,
      featureName:    'shell:execute',
      effect:         'allow',
      createdBy:      'usr_fp_test',
      userKey,
    });

    let result = await engine.checkPermission('shell:execute', {}, {
      organizationID:    orgID,
      verifyFingerprint: true,
      userKey,
    });

    assert.equal(result, false); // Allow rule trusted
  });

  it('should reject rule with missing fingerprint when verification enabled', async () => {
    // Create rule WITHOUT fingerprint
    await engine.createRule({
      organizationID: orgID,
      featureName:    'shell:execute',
      effect:         'allow',
      createdBy:      'usr_fp_test',
    });

    let result = await engine.checkPermission('shell:execute', {}, {
      organizationID:    orgID,
      verifyFingerprint: true,
      userKey,
    });

    assert.equal(result, true); // Rule untrusted (no fingerprint), default deny
  });

  it('should reject rule with invalid fingerprint when verification enabled', async () => {
    // Create rule with one user key
    await engine.createRule({
      organizationID: orgID,
      featureName:    'shell:execute',
      effect:         'allow',
      createdBy:      'usr_fp_test',
      userKey,
    });

    // Verify with a DIFFERENT user key
    let umk2          = keystore.generateUMK();
    let differentKey  = keystore.deriveUserKey(umk2, 'usr_different');

    let result = await engine.checkPermission('shell:execute', {}, {
      organizationID:    orgID,
      verifyFingerprint: true,
      userKey:           differentKey,
    });

    assert.equal(result, true); // Fingerprint mismatch, rule rejected
  });

  it('should compute fingerprint from correct fields', async () => {
    let rule = await engine.createRule({
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

  it('should skip fingerprint verification when not requested', async () => {
    // Rule without fingerprint
    await engine.createRule({
      organizationID: orgID,
      featureName:    'shell:execute',
      effect:         'allow',
      createdBy:      'usr_fp_test',
    });

    // Check without verifyFingerprint — should still work
    let result = await engine.checkPermission('shell:execute', {}, {
      organizationID: orgID,
    });

    assert.equal(result, false); // Allow rule applies (no verification)
  });

  it('should produce different fingerprints for different features', async () => {
    let rule1 = await engine.createRule({
      organizationID: orgID,
      featureName:    'shell:execute',
      effect:         'allow',
      createdBy:      'usr_fp_test',
      userKey,
    });

    let rule2 = await engine.createRule({
      organizationID: orgID,
      featureName:    'websearch:fetch',
      effect:         'allow',
      createdBy:      'usr_fp_test',
      userKey,
    });

    assert.notEqual(rule1.fingerprint, rule2.fingerprint);
  });
});
