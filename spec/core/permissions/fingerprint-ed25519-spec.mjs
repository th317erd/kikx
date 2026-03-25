'use strict';

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createKikxCore } from '../../../src/core/index.mjs';
import { Keystore }       from '../../../src/core/crypto/keystore.mjs';
import { Permissions }    from '../../../src/core/permissions/permissions-base.mjs';

// =============================================================================
// Permission Fingerprinting — Ed25519
// =============================================================================
// Verifies that permission rules can be fingerprinted with Ed25519 signatures
// and that Permissions.evaluate() validates them using the corresponding public key.
// Also verifies backward compatibility with HMAC fingerprints.
//
// These tests verify that createRule correctly produces Ed25519 fingerprints
// via the Permissions base class.
// =============================================================================

describe('Permission Fingerprinting — Ed25519', () => {
  let core;
  let permissions;
  let keystore;
  let orgID;
  let publicKey;
  let privateKey;

  beforeEach(async () => {
    core = createKikxCore();
    await core.start();

    let context = core.getContext();

    // Set up keystore on context
    keystore = new Keystore({ devMode: true, devSeed: 'ed25519-fingerprint-test' });
    keystore.initialize();
    context.setProperty('keystore', keystore);

    permissions = new Permissions(context);

    // Generate Ed25519 key pair for testing
    let keyPair = keystore.generateSigningKeyPair();
    publicKey   = keyPair.publicKey;
    privateKey  = keyPair.privateKey;

    // Create org
    let { Organization } = core.getModels();
    let org = await Organization.create({ name: 'Ed25519 Fingerprint Org' });
    orgID   = org.id;
  });

  afterEach(async () => {
    keystore.destroy();

    if (core && core.isStarted())
      await core.stop();
  });

  // ---------------------------------------------------------------------------
  // createRule with privateKeyPEM
  // ---------------------------------------------------------------------------

  describe('createRule with Ed25519', () => {
    it('should store Ed25519 signature as fingerprint', async () => {
      let rule = await permissions.createRule({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'allow',
        createdBy:      'usr_ed25519_test',
        privateKeyPEM:  privateKey,
      });

      assert.ok(rule.fingerprint);
      assert.equal(typeof rule.fingerprint, 'string');
      assert.ok(rule.fingerprint.length > 0);
    });

    it('should produce a hex string fingerprint', async () => {
      let rule = await permissions.createRule({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'allow',
        createdBy:      'usr_ed25519_test',
        privateKeyPEM:  privateKey,
      });

      // Ed25519 signatures are 64 bytes = 128 hex characters
      assert.match(rule.fingerprint, /^[0-9a-f]+$/);
      assert.equal(rule.fingerprint.length, 128);
    });

    it('should produce verifiable signature matching the fingerprint data', async () => {
      let rule = await permissions.createRule({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'allow',
        scope:          'session',
        scopeID:        'ses_test_123',
        createdBy:      'usr_ed25519_test',
        privateKeyPEM:  privateKey,
      });

      // Manually verify the signature using the public key
      let fingerprintData = `${orgID}:shell:execute:allow:session`;
      let valid           = keystore.verifyWithPublicKey(fingerprintData, publicKey, rule.fingerprint);

      assert.equal(valid, true);
    });

    it('should not store fingerprint when neither privateKeyPEM nor userKey provided', async () => {
      let rule = await permissions.createRule({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'allow',
        createdBy:      'usr_ed25519_test',
      });

      assert.equal(rule.fingerprint == null, true);
    });

    it('should prefer privateKeyPEM over userKey when both are provided', async () => {
      let umk     = keystore.generateUMK();
      let userKey = keystore.deriveUserKey(umk, 'usr_both_test');

      let rule = await permissions.createRule({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'allow',
        createdBy:      'usr_both_test',
        privateKeyPEM:  privateKey,
        userKey,
      });

      // The fingerprint should be an Ed25519 signature (128 hex chars), not HMAC
      assert.equal(rule.fingerprint.length, 128);

      // Should verify with Ed25519
      let fingerprintData = `${orgID}:shell:execute:allow:global`;
      let valid           = keystore.verifyWithPublicKey(fingerprintData, publicKey, rule.fingerprint);
      assert.equal(valid, true);

      // Should NOT match HMAC
      let hmacFingerprint = keystore.fingerprint(fingerprintData, userKey);
      assert.notEqual(rule.fingerprint, hmacFingerprint);
    });
  });

  // ---------------------------------------------------------------------------
  // Backward compatibility: HMAC fingerprints still work
  // ---------------------------------------------------------------------------

  describe('backward compatibility — HMAC fingerprints', () => {
    it('should create rule with HMAC fingerprint when userKey provided (no privateKeyPEM)', async () => {
      let umk     = keystore.generateUMK();
      let userKey = keystore.deriveUserKey(umk, 'usr_hmac_compat');

      let rule = await permissions.createRule({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'allow',
        createdBy:      'usr_hmac_compat',
        userKey,
      });

      assert.ok(rule.fingerprint);

      // Verify it is the expected HMAC
      let fingerprintData = `${orgID}:shell:execute:allow:global`;
      let expected        = keystore.fingerprint(fingerprintData, userKey);
      assert.equal(rule.fingerprint, expected);
    });
  });

  // ---------------------------------------------------------------------------
  // Round trip: create with private key, verify manually
  // ---------------------------------------------------------------------------

  describe('round trip', () => {
    it('should complete full cycle: create with privateKeyPEM, verify with publicKeyPEM', async () => {
      let rule = await permissions.createRule({
        organizationID: orgID,
        featureName:    'websearch:fetch',
        effect:         'allow',
        scope:          'session',
        scopeID:        'ses_roundtrip',
        createdBy:      'usr_roundtrip',
        privateKeyPEM:  privateKey,
      });

      assert.ok(rule.fingerprint);
      assert.equal(rule.fingerprint.length, 128); // Ed25519 = 64 bytes = 128 hex

      // Manually verify with public key
      let fingerprintData = `${orgID}:websearch:fetch:allow:session`;
      let valid           = keystore.verifyWithPublicKey(fingerprintData, publicKey, rule.fingerprint);
      assert.equal(valid, true);
    });

    it('should produce different signatures for different features', async () => {
      let rule1 = await permissions.createRule({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'allow',
        createdBy:      'usr_diff_features',
        privateKeyPEM:  privateKey,
      });

      let rule2 = await permissions.createRule({
        organizationID: orgID,
        featureName:    'websearch:fetch',
        effect:         'allow',
        createdBy:      'usr_diff_features',
        privateKeyPEM:  privateKey,
      });

      assert.notEqual(rule1.fingerprint, rule2.fingerprint);
    });

    it('should produce different signatures for different effects', async () => {
      let rule1 = await permissions.createRule({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'allow',
        createdBy:      'usr_diff_effects',
        privateKeyPEM:  privateKey,
      });

      let rule2 = await permissions.createRule({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'deny',
        createdBy:      'usr_diff_effects',
        privateKeyPEM:  privateKey,
      });

      assert.notEqual(rule1.fingerprint, rule2.fingerprint);
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  describe('edge cases', () => {
    it('should skip fingerprinting when keystore is not available', async () => {
      // Remove keystore from context
      core.getContext().setProperty('keystore', null);

      let rule = await permissions.createRule({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'allow',
        createdBy:      'usr_no_keystore',
        privateKeyPEM:  privateKey,
      });

      assert.equal(rule.fingerprint == null, true);
    });
  });
});
