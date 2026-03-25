'use strict';

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createKikxCore }        from '../../../src/core/index.mjs';
import { Keystore }              from '../../../src/core/crypto/keystore.mjs';
import { PermissionEngine }      from '../../../src/core/permissions/permission-engine.mjs';
import { PermissionService }     from '../../../src/core/permissions/permission-service.mjs';

// =============================================================================
// PermissionService Ed25519 Signing Tests (C2)
// =============================================================================
// Verifies that PermissionService can sign/verify approvals with Ed25519
// asymmetric keys while maintaining backward-compatible HMAC fallback.
// =============================================================================

describe('PermissionService Ed25519 (C2)', () => {
  let core;
  let models;
  let context;
  let keystore;
  let permissionEngine;
  let keyPair;
  let otherKeyPair;

  before(async () => {
    core = createKikxCore();
    await core.start();
    models  = core.getModels();
    context = core.getContext();

    keystore = new Keystore({ devMode: true, devSeed: 'permission-service-ed25519-test' });
    keystore.initialize();
    context.setProperty('keystore', keystore);

    permissionEngine = new PermissionEngine(context);

    // Generate key pairs for Ed25519 testing
    keyPair      = keystore.generateSigningKeyPair();
    otherKeyPair = keystore.generateSigningKeyPair();
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
      permissionEngine,
      keystore,
    });
  }

  async function createTestOrg() {
    return models.Organization.create({ name: 'Ed25519 Perm Org' });
  }

  // ---------------------------------------------------------------------------
  // signApproval with Ed25519
  // ---------------------------------------------------------------------------

  describe('signApproval with Ed25519', () => {
    it('should return a hex signature when given a private key', () => {
      let service   = createService();
      let signature = service.signApproval('approve', 'frm_1', 'shell:execute', { command: 'ls' }, null, keyPair.privateKey);

      assert.equal(typeof signature, 'string');
      assert.match(signature, /^[0-9a-f]+$/, 'Signature should be hex');
    });

    it('should return a 128-character hex string (64-byte Ed25519 signature)', () => {
      let service   = createService();
      let signature = service.signApproval('approve', 'frm_2', 'shell:execute', { command: 'ls' }, null, keyPair.privateKey);

      assert.equal(signature.length, 128, 'Ed25519 signature should be 64 bytes = 128 hex chars');
    });

    it('should produce deterministic signatures for identical data', () => {
      let service = createService();
      let sig1    = service.signApproval('approve', 'frm_3', 'test:tool', { a: 1, b: 2 }, null, keyPair.privateKey);
      let sig2    = service.signApproval('approve', 'frm_3', 'test:tool', { a: 1, b: 2 }, null, keyPair.privateKey);

      assert.equal(sig1, sig2);
    });

    it('should produce deterministic signatures regardless of arg key order', () => {
      let service = createService();
      let sig1    = service.signApproval('approve', 'frm_4', 'test:tool', { a: 1, b: 2 }, null, keyPair.privateKey);
      let sig2    = service.signApproval('approve', 'frm_4', 'test:tool', { b: 2, a: 1 }, null, keyPair.privateKey);

      assert.equal(sig1, sig2);
    });

    it('should produce different signatures for different feature names', () => {
      let service = createService();
      let sig1    = service.signApproval('approve', 'frm_5', 'tool:a', { x: 1 }, null, keyPair.privateKey);
      let sig2    = service.signApproval('approve', 'frm_5', 'tool:b', { x: 1 }, null, keyPair.privateKey);

      assert.notEqual(sig1, sig2);
    });

    it('should produce different signatures for different args', () => {
      let service = createService();
      let sig1    = service.signApproval('approve', 'frm_6', 'test:tool', { command: 'ls' }, null, keyPair.privateKey);
      let sig2    = service.signApproval('approve', 'frm_6', 'test:tool', { command: 'rm' }, null, keyPair.privateKey);

      assert.notEqual(sig1, sig2);
    });

    it('should produce different signatures for different session IDs', () => {
      let service = createService();
      let sig1    = service.signApproval('approve', 'frm_7', 'test:tool', {}, 'ses_1', keyPair.privateKey);
      let sig2    = service.signApproval('approve', 'frm_7', 'test:tool', {}, 'ses_2', keyPair.privateKey);

      assert.notEqual(sig1, sig2);
    });

    it('should produce different signatures with different private keys', () => {
      let service = createService();
      let sig1    = service.signApproval('approve', 'frm_8', 'test:tool', { a: 1 }, null, keyPair.privateKey);
      let sig2    = service.signApproval('approve', 'frm_8', 'test:tool', { a: 1 }, null, otherKeyPair.privateKey);

      assert.notEqual(sig1, sig2);
    });
  });

  // ---------------------------------------------------------------------------
  // verifyApproval with Ed25519
  // ---------------------------------------------------------------------------

  describe('verifyApproval with Ed25519', () => {
    it('should return true with matching public key', () => {
      let service   = createService();
      let signature = service.signApproval('approve', 'frm_v1', 'shell:execute', { command: 'ls' }, null, keyPair.privateKey);

      let valid = service.verifyApproval('approve', 'frm_v1', 'shell:execute', { command: 'ls' }, signature, null, keyPair.publicKey);
      assert.equal(valid, true);
    });

    it('should return false with wrong public key', () => {
      let service   = createService();
      let signature = service.signApproval('approve', 'frm_v2', 'shell:execute', { command: 'ls' }, null, keyPair.privateKey);

      let valid = service.verifyApproval('approve', 'frm_v2', 'shell:execute', { command: 'ls' }, signature, null, otherKeyPair.publicKey);
      assert.equal(valid, false);
    });

    it('should return false with tampered feature name', () => {
      let service   = createService();
      let signature = service.signApproval('approve', 'frm_v3', 'shell:execute', { command: 'ls' }, null, keyPair.privateKey);

      let valid = service.verifyApproval('approve', 'frm_v3', 'shell:malicious', { command: 'ls' }, signature, null, keyPair.publicKey);
      assert.equal(valid, false);
    });

    it('should return false with tampered args', () => {
      let service   = createService();
      let signature = service.signApproval('approve', 'frm_v4', 'shell:execute', { command: 'ls' }, null, keyPair.privateKey);

      let valid = service.verifyApproval('approve', 'frm_v4', 'shell:execute', { command: 'rm -rf /' }, signature, null, keyPair.publicKey);
      assert.equal(valid, false);
    });

    it('should return false with tampered session ID', () => {
      let service   = createService();
      let signature = service.signApproval('approve', 'frm_v5', 'test:tool', {}, 'ses_original', keyPair.privateKey);

      let valid = service.verifyApproval('approve', 'frm_v5', 'test:tool', {}, signature, 'ses_tampered', keyPair.publicKey);
      assert.equal(valid, false);
    });

    it('should return false with tampered signature', () => {
      let service   = createService();
      let signature = service.signApproval('approve', 'frm_v6', 'test:tool', {}, null, keyPair.privateKey);

      // Flip a character in the hex signature
      let tampered = signature.slice(0, -2) + ((signature.slice(-2) === 'ff') ? '00' : 'ff');

      let valid = service.verifyApproval('approve', 'frm_v6', 'test:tool', {}, tampered, null, keyPair.publicKey);
      assert.equal(valid, false);
    });

    it('should return false with completely invalid signature', () => {
      let service = createService();
      let valid   = service.verifyApproval('approve', 'frm_v7', 'test:tool', {}, 'not-a-valid-hex-signature', null, keyPair.publicKey);
      assert.equal(valid, false);
    });

    it('should return false with empty signature', () => {
      let service = createService();
      let valid   = service.verifyApproval('approve', 'frm_v8', 'test:tool', {}, '', null, keyPair.publicKey);
      assert.equal(valid, false);
    });

    it('should verify with session ID when it was included in signing', () => {
      let service   = createService();
      let signature = service.signApproval('approve', 'frm_v9', 'test:tool', { x: 1 }, 'ses_abc', keyPair.privateKey);

      let valid = service.verifyApproval('approve', 'frm_v9', 'test:tool', { x: 1 }, signature, 'ses_abc', keyPair.publicKey);
      assert.equal(valid, true);
    });
  });

  // ---------------------------------------------------------------------------
  // HMAC fallback (backward compatibility)
  // ---------------------------------------------------------------------------

  describe('HMAC fallback', () => {
    it('should sign with HMAC when no private key provided', () => {
      let service   = createService();
      let signature = service.signApproval('approve', 'frm_h1', 'test:tool', { a: 1 });

      assert.equal(typeof signature, 'string');
      assert.match(signature, /^[0-9a-f]{64}$/, 'HMAC-SHA256 produces 64-char hex');
    });

    it('should verify HMAC signature when no public key provided', () => {
      let service   = createService();
      let signature = service.signApproval('approve', 'frm_h2', 'test:tool', { a: 1 });

      let valid = service.verifyApproval('approve', 'frm_h2', 'test:tool', { a: 1 }, signature);
      assert.equal(valid, true);
    });

    it('should not verify HMAC signature with Ed25519 public key', () => {
      let service       = createService();
      let hmacSignature = service.signApproval('approve', 'frm_h3', 'test:tool', { a: 1 });

      let valid = service.verifyApproval('approve', 'frm_h3', 'test:tool', { a: 1 }, hmacSignature, null, keyPair.publicKey);
      assert.equal(valid, false);
    });

    it('should not verify Ed25519 signature with HMAC (no public key)', () => {
      let service          = createService();
      let ed25519Signature = service.signApproval('approve', 'frm_h4', 'test:tool', { a: 1 }, null, keyPair.privateKey);

      // Try to verify Ed25519 signature with HMAC path (no publicKeyPEM)
      let valid = service.verifyApproval('approve', 'frm_h4', 'test:tool', { a: 1 }, ed25519Signature);
      assert.equal(valid, false);
    });
  });

  // ---------------------------------------------------------------------------
  // Ed25519 vs HMAC signature comparison
  // ---------------------------------------------------------------------------

  describe('Ed25519 vs HMAC signatures', () => {
    it('should produce different signatures for the same data', () => {
      let service      = createService();
      let hmacSig      = service.signApproval('approve', 'frm_c1', 'test:tool', { a: 1 });
      let ed25519Sig   = service.signApproval('approve', 'frm_c1', 'test:tool', { a: 1 }, null, keyPair.privateKey);

      assert.notEqual(hmacSig, ed25519Sig);
    });

    it('should produce different-length signatures (HMAC=64 hex, Ed25519=128 hex)', () => {
      let service    = createService();
      let hmacSig    = service.signApproval('approve', 'frm_c2', 'test:tool', {});
      let ed25519Sig = service.signApproval('approve', 'frm_c2', 'test:tool', {}, null, keyPair.privateKey);

      assert.equal(hmacSig.length, 64, 'HMAC-SHA256 = 32 bytes = 64 hex chars');
      assert.equal(ed25519Sig.length, 128, 'Ed25519 = 64 bytes = 128 hex chars');
    });
  });

  // ---------------------------------------------------------------------------
  // check() with Ed25519
  // ---------------------------------------------------------------------------

  describe('check() with Ed25519', () => {
    it('should sign approval with Ed25519 when privateKeyPEM is provided', async () => {
      let org     = await createTestOrg();
      let service = createService();

      // Create an allow rule
      await permissionEngine.createRule({
        organizationID: org.id,
        featureName:    'test:ed25519-check',
        effect:         'allow',
        scope:          'global',
        createdBy:      'usr_test',
      });

      let result = await service.check('test:ed25519-check', {}, {
        organizationID: org.id,
        privateKeyPEM:  keyPair.privateKey,
      });

      assert.equal(result.decision, 'allow');
      assert.ok(result.signature);
      assert.equal(result.signature.length, 128, 'Should be Ed25519 signature');

      // Verify the signature with Ed25519 (check() uses null frameID)
      let valid = service.verifyApproval('approve', null, 'test:ed25519-check', {}, result.signature, null, keyPair.publicKey);
      assert.equal(valid, true);
    });

    it('should sign with HMAC when no privateKeyPEM in options (backward compat)', async () => {
      let org     = await createTestOrg();
      let service = createService();

      await permissionEngine.createRule({
        organizationID: org.id,
        featureName:    'test:hmac-check',
        effect:         'allow',
        scope:          'global',
        createdBy:      'usr_test',
      });

      let result = await service.check('test:hmac-check', {}, {
        organizationID: org.id,
      });

      assert.equal(result.decision, 'allow');
      assert.ok(result.signature);
      assert.equal(result.signature.length, 64, 'Should be HMAC signature');

      // Verify the signature with HMAC
      let valid = service.verifyApproval('approve', null, 'test:hmac-check', {}, result.signature);
      assert.equal(valid, true);
    });

    it('should include sessionID in Ed25519-signed check', async () => {
      let org     = await createTestOrg();
      let service = createService();

      await permissionEngine.createRule({
        organizationID: org.id,
        featureName:    'test:ed25519-session',
        effect:         'allow',
        scope:          'session',
        scopeID:        'ses_ed25519_check',
        createdBy:      'usr_test',
      });

      let result = await service.check('test:ed25519-session', {}, {
        organizationID: org.id,
        sessionID:      'ses_ed25519_check',
        privateKeyPEM:  keyPair.privateKey,
      });

      assert.equal(result.decision, 'allow');
      assert.equal(result.signature.length, 128);

      // Verify with correct sessionID
      let valid = service.verifyApproval('approve', null, 'test:ed25519-session', {}, result.signature, 'ses_ed25519_check', keyPair.publicKey);
      assert.equal(valid, true);

      // Should fail with wrong sessionID
      let invalid = service.verifyApproval('approve', null, 'test:ed25519-session', {}, result.signature, 'ses_wrong', keyPair.publicKey);
      assert.equal(invalid, false);
    });
  });

  // ---------------------------------------------------------------------------
  // createStandingApproval with Ed25519
  // ---------------------------------------------------------------------------

  describe('createStandingApproval with Ed25519', () => {
    it('should sign standing approval with Ed25519 when privateKeyPEM is provided', async () => {
      let org     = await createTestOrg();
      let service = createService();

      let rule = await service.createStandingApproval({
        organizationID: org.id,
        sessionID:      'ses_ed25519_standing',
        featureName:    'shell:execute',
        createdBy:      'usr_test',
        privateKeyPEM:  keyPair.privateKey,
      });

      assert.ok(rule);
      let metadata = JSON.parse(rule.metadata);
      assert.equal(metadata.standing, true);
      assert.ok(metadata.signature);
      assert.equal(metadata.signature.length, 128, 'Should be Ed25519 signature');
    });

    it('should sign standing approval with HMAC when no privateKeyPEM (backward compat)', async () => {
      let org     = await createTestOrg();
      let service = createService();

      let rule = await service.createStandingApproval({
        organizationID: org.id,
        sessionID:      'ses_hmac_standing',
        featureName:    'shell:execute',
        createdBy:      'usr_test',
      });

      assert.ok(rule);
      let metadata = JSON.parse(rule.metadata);
      assert.equal(metadata.standing, true);
      assert.ok(metadata.signature);
      assert.equal(metadata.signature.length, 64, 'Should be HMAC signature');
    });

    it('should produce verifiable Ed25519 standing approval signature', async () => {
      let org     = await createTestOrg();
      let service = createService();

      let rule = await service.createStandingApproval({
        organizationID: org.id,
        sessionID:      'ses_verify_standing',
        featureName:    'file:read',
        createdBy:      'usr_test',
        privateKeyPEM:  keyPair.privateKey,
      });

      let metadata = JSON.parse(rule.metadata);

      // Verify the standing approval signature (standing approvals use null frameID)
      let valid = service.verifyApproval(
        'approve',
        null,
        'file:read',
        { standing: true, sessionID: 'ses_verify_standing' },
        metadata.signature,
        'ses_verify_standing',
        keyPair.publicKey,
      );

      assert.equal(valid, true);
    });
  });

  // ---------------------------------------------------------------------------
  // Round-trip: sign → verify
  // ---------------------------------------------------------------------------

  describe('round-trip Ed25519 sign/verify', () => {
    it('should round-trip with minimal data', () => {
      let service   = createService();
      let signature = service.signApproval('approve', 'frm_r1', 'test:min', {}, null, keyPair.privateKey);

      assert.equal(
        service.verifyApproval('approve', 'frm_r1', 'test:min', {}, signature, null, keyPair.publicKey),
        true,
      );
    });

    it('should round-trip with complex nested args', () => {
      let service = createService();
      let args    = {
        nested: { deep: { value: 42 } },
        list:   [1, 2, 3],
        empty:  {},
      };

      let signature = service.signApproval('approve', 'frm_r2', 'test:complex', args, 'ses_complex', keyPair.privateKey);

      assert.equal(
        service.verifyApproval('approve', 'frm_r2', 'test:complex', args, signature, 'ses_complex', keyPair.publicKey),
        true,
      );
    });

    it('should round-trip with special characters in feature name', () => {
      let service   = createService();
      let signature = service.signApproval('approve', 'frm_r3', 'ns:tool/sub-tool', { path: '/usr/local' }, null, keyPair.privateKey);

      assert.equal(
        service.verifyApproval('approve', 'frm_r3', 'ns:tool/sub-tool', { path: '/usr/local' }, signature, null, keyPair.publicKey),
        true,
      );
    });

    it('should round-trip with null sessionID', () => {
      let service   = createService();
      let signature = service.signApproval('approve', 'frm_r4', 'test:null-session', { a: 1 }, null, keyPair.privateKey);

      assert.equal(
        service.verifyApproval('approve', 'frm_r4', 'test:null-session', { a: 1 }, signature, null, keyPair.publicKey),
        true,
      );
    });

    it('should round-trip with explicit sessionID', () => {
      let service   = createService();
      let signature = service.signApproval('approve', 'frm_r5', 'test:with-session', { a: 1 }, 'ses_roundtrip', keyPair.privateKey);

      assert.equal(
        service.verifyApproval('approve', 'frm_r5', 'test:with-session', { a: 1 }, signature, 'ses_roundtrip', keyPair.publicKey),
        true,
      );
    });
  });
});
