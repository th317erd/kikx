'use strict';

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createKikxCore } from '../../../src/core/index.mjs';
import { Keystore }       from '../../../src/core/crypto/keystore.mjs';

// =============================================================================
// Permission Fingerprinting — Ed25519
// =============================================================================
// Verifies that permission rules can be fingerprinted with Ed25519 signatures
// and that checkPermission validates them using the corresponding public key.
// Also verifies backward compatibility with HMAC fingerprints.
// =============================================================================

describe('Permission Fingerprinting — Ed25519', () => {
  let core;
  let engine;
  let keystore;
  let orgID;
  let publicKey;
  let privateKey;

  beforeEach(async () => {
    core = createKikxCore();
    await core.start();

    engine = core.getPermissionEngine();

    // Set up keystore on context
    keystore = new Keystore({ devMode: true, devSeed: 'ed25519-fingerprint-test' });
    keystore.initialize();
    core.getContext().setProperty('keystore', keystore);

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
      let rule = await engine.createRule({
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
      let rule = await engine.createRule({
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
      let rule = await engine.createRule({
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
      let rule = await engine.createRule({
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

      let rule = await engine.createRule({
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
  // _filterByFingerprint with Ed25519
  // ---------------------------------------------------------------------------

  describe('_filterByFingerprint with Ed25519', () => {
    it('should accept rule with matching publicKeyPEM', async () => {
      await engine.createRule({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'allow',
        createdBy:      'usr_ed25519_test',
        privateKeyPEM:  privateKey,
      });

      let result = await engine.checkPermission('shell:execute', {}, {
        organizationID:    orgID,
        verifyFingerprint: true,
        publicKeyPEM:      publicKey,
      });

      assert.equal(result, false); // Allow rule trusted
    });

    it('should reject rule with wrong publicKeyPEM', async () => {
      await engine.createRule({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'allow',
        createdBy:      'usr_ed25519_test',
        privateKeyPEM:  privateKey,
      });

      // Generate a different key pair
      let otherKeyPair = keystore.generateSigningKeyPair();

      let result = await engine.checkPermission('shell:execute', {}, {
        organizationID:    orgID,
        verifyFingerprint: true,
        publicKeyPEM:      otherKeyPair.publicKey,
      });

      assert.equal(result, true); // Rejected — wrong public key, default deny
    });

    it('should reject rule with no fingerprint', async () => {
      await engine.createRule({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'allow',
        createdBy:      'usr_ed25519_test',
        // No privateKeyPEM, no userKey
      });

      let result = await engine.checkPermission('shell:execute', {}, {
        organizationID:    orgID,
        verifyFingerprint: true,
        publicKeyPEM:      publicKey,
      });

      assert.equal(result, true); // Rejected — no fingerprint, default deny
    });

    it('should reject tampered rule data during Ed25519 verification', async () => {
      let rule = await engine.createRule({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'allow',
        createdBy:      'usr_ed25519_test',
        privateKeyPEM:  privateKey,
      });

      // Tamper with the rule: change effect from 'allow' to 'deny'
      // The fingerprint was computed over 'allow' so verification should fail
      let { PermissionRule } = core.getModels();
      let loadedRule         = await PermissionRule.where.id.EQ(rule.id).first();
      loadedRule.effect      = 'deny';
      await loadedRule.save();

      // Now verify — the fingerprint data includes 'deny' but was signed with 'allow'
      // Since effect is 'deny' and it would throw PermissionDeniedError if the rule
      // passes fingerprint check, but the tampered data should fail verification.
      // With verification on, the rule is filtered out, so we get default deny (true).
      let result = await engine.checkPermission('shell:execute', {}, {
        organizationID:    orgID,
        verifyFingerprint: true,
        publicKeyPEM:      publicKey,
      });

      assert.equal(result, true); // Tampered rule filtered out, default deny
    });
  });

  // ---------------------------------------------------------------------------
  // Backward compatibility: HMAC fingerprints still work
  // ---------------------------------------------------------------------------

  describe('backward compatibility — HMAC fingerprints', () => {
    it('should create rule with HMAC fingerprint when userKey provided (no privateKeyPEM)', async () => {
      let umk     = keystore.generateUMK();
      let userKey = keystore.deriveUserKey(umk, 'usr_hmac_compat');

      let rule = await engine.createRule({
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

    it('should accept HMAC-fingerprinted rule with userKey verification', async () => {
      let umk     = keystore.generateUMK();
      let userKey = keystore.deriveUserKey(umk, 'usr_hmac_compat');

      await engine.createRule({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'allow',
        createdBy:      'usr_hmac_compat',
        userKey,
      });

      let result = await engine.checkPermission('shell:execute', {}, {
        organizationID:    orgID,
        verifyFingerprint: true,
        userKey,
      });

      assert.equal(result, false); // HMAC fingerprint valid, allow rule trusted
    });

    it('should reject HMAC-fingerprinted rule with wrong userKey', async () => {
      let umk     = keystore.generateUMK();
      let userKey = keystore.deriveUserKey(umk, 'usr_hmac_compat');

      await engine.createRule({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'allow',
        createdBy:      'usr_hmac_compat',
        userKey,
      });

      let umk2         = keystore.generateUMK();
      let differentKey = keystore.deriveUserKey(umk2, 'usr_different');

      let result = await engine.checkPermission('shell:execute', {}, {
        organizationID:    orgID,
        verifyFingerprint: true,
        userKey:           differentKey,
      });

      assert.equal(result, true); // HMAC mismatch, default deny
    });
  });

  // ---------------------------------------------------------------------------
  // Mixed verification: publicKeyPEM + userKey fallback
  // ---------------------------------------------------------------------------

  describe('mixed verification — Ed25519 with HMAC fallback', () => {
    it('should accept Ed25519 rule when both publicKeyPEM and userKey provided', async () => {
      let umk     = keystore.generateUMK();
      let userKey = keystore.deriveUserKey(umk, 'usr_mixed');

      await engine.createRule({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'allow',
        createdBy:      'usr_mixed',
        privateKeyPEM:  privateKey,
      });

      let result = await engine.checkPermission('shell:execute', {}, {
        organizationID:    orgID,
        verifyFingerprint: true,
        publicKeyPEM:      publicKey,
        userKey,
      });

      assert.equal(result, false); // Ed25519 verification succeeds
    });

    it('should fall back to HMAC when Ed25519 verification fails but HMAC matches', async () => {
      let umk     = keystore.generateUMK();
      let userKey = keystore.deriveUserKey(umk, 'usr_fallback');

      // Create rule with HMAC fingerprint
      await engine.createRule({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'allow',
        createdBy:      'usr_fallback',
        userKey,
      });

      // Verify with a publicKeyPEM that won't match (wrong key for HMAC rule)
      // but also provide userKey which should match
      let result = await engine.checkPermission('shell:execute', {}, {
        organizationID:    orgID,
        verifyFingerprint: true,
        publicKeyPEM:      publicKey, // Won't match HMAC fingerprint
        userKey,                      // Will match HMAC fingerprint
      });

      assert.equal(result, false); // HMAC fallback succeeds
    });

    it('should reject when neither Ed25519 nor HMAC matches', async () => {
      let umk     = keystore.generateUMK();
      let userKey = keystore.deriveUserKey(umk, 'usr_neither');

      // Create rule with HMAC fingerprint
      await engine.createRule({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'allow',
        createdBy:      'usr_neither',
        userKey,
      });

      // Verify with wrong public key AND wrong user key
      let otherKeyPair = keystore.generateSigningKeyPair();
      let umk2         = keystore.generateUMK();
      let wrongUserKey = keystore.deriveUserKey(umk2, 'usr_wrong');

      let result = await engine.checkPermission('shell:execute', {}, {
        organizationID:    orgID,
        verifyFingerprint: true,
        publicKeyPEM:      otherKeyPair.publicKey,
        userKey:           wrongUserKey,
      });

      assert.equal(result, true); // Both fail, default deny
    });
  });

  // ---------------------------------------------------------------------------
  // Round trip: create with private key, filter with public key
  // ---------------------------------------------------------------------------

  describe('round trip', () => {
    it('should complete full cycle: create with privateKeyPEM, verify with publicKeyPEM', async () => {
      // Step 1: Create rule signed with private key
      let rule = await engine.createRule({
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

      // Step 2: Check permission with public key
      let result = await engine.checkPermission('websearch:fetch', {}, {
        organizationID:    orgID,
        scope:             'session',
        scopeID:           'ses_roundtrip',
        verifyFingerprint: true,
        publicKeyPEM:      publicKey,
      });

      assert.equal(result, false); // Allow rule passes verification
    });

    it('should produce different signatures for different features', async () => {
      let rule1 = await engine.createRule({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'allow',
        createdBy:      'usr_diff_features',
        privateKeyPEM:  privateKey,
      });

      let rule2 = await engine.createRule({
        organizationID: orgID,
        featureName:    'websearch:fetch',
        effect:         'allow',
        createdBy:      'usr_diff_features',
        privateKeyPEM:  privateKey,
      });

      assert.notEqual(rule1.fingerprint, rule2.fingerprint);
    });

    it('should produce different signatures for different effects', async () => {
      let rule1 = await engine.createRule({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'allow',
        createdBy:      'usr_diff_effects',
        privateKeyPEM:  privateKey,
      });

      let rule2 = await engine.createRule({
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

      let rule = await engine.createRule({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'allow',
        createdBy:      'usr_no_keystore',
        privateKeyPEM:  privateKey,
      });

      assert.equal(rule.fingerprint == null, true);
    });

    it('should return all rules when keystore is null during fingerprint filtering', async () => {
      // Create rule with fingerprint first (keystore present)
      await engine.createRule({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'allow',
        createdBy:      'usr_no_keystore_filter',
        privateKeyPEM:  privateKey,
      });

      // Remove keystore, then check — _filterByFingerprint should return all rules
      core.getContext().setProperty('keystore', null);

      let result = await engine.checkPermission('shell:execute', {}, {
        organizationID:    orgID,
        verifyFingerprint: true,
        publicKeyPEM:      publicKey,
      });

      // Without keystore, _filterByFingerprint returns rules unfiltered.
      // The allow rule passes through, so permission is not needed.
      assert.equal(result, false);
    });

    it('should not trigger fingerprint verification when verifyFingerprint is false', async () => {
      // Create rule without any fingerprint
      await engine.createRule({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'allow',
        createdBy:      'usr_no_verify',
      });

      let result = await engine.checkPermission('shell:execute', {}, {
        organizationID:    orgID,
        verifyFingerprint: false,
        publicKeyPEM:      publicKey,
      });

      assert.equal(result, false); // Allow rule applies (no verification)
    });

    it('should not trigger fingerprint verification when neither userKey nor publicKeyPEM provided', async () => {
      // Create rule without fingerprint
      await engine.createRule({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'allow',
        createdBy:      'usr_no_keys',
      });

      let result = await engine.checkPermission('shell:execute', {}, {
        organizationID:    orgID,
        verifyFingerprint: true,
        // No userKey, no publicKeyPEM
      });

      // verifyFingerprint is true but no keys — condition (userKey || publicKeyPEM) is false
      // So fingerprint filtering is skipped entirely
      assert.equal(result, false); // Allow rule applies
    });
  });
});
