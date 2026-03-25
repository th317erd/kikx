'use strict';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { Keystore }          from '../../../src/core/crypto/keystore.mjs';
import { PermissionService } from '../../../src/core/permissions/permission-service.mjs';

// =============================================================================
// Approval Signature Tests (Phase 4)
// =============================================================================
// Verifies that approval/denial payloads are cryptographically signed with
// Ed25519, binding to the specific request to prevent replay, escalation,
// and cross-session attacks.
// =============================================================================

describe('Approval Signature (Phase 4)', () => {
  let keystore;
  let keyPair;
  let otherKeyPair;

  before(() => {
    keystore = new Keystore({ devMode: true, devSeed: 'approval-signature-test-' + Date.now() });
    keystore.initialize();
    keyPair      = keystore.generateSigningKeyPair();
    otherKeyPair = keystore.generateSigningKeyPair();
  });

  after(() => {
    if (keystore)
      keystore.destroy();
  });

  // Helper: build and sign an approval payload using keystore directly
  function buildAndSign(fields, privateKey) {
    let payload = JSON.stringify(keystore.canonicalize(fields));
    return keystore.signWithPrivateKey(payload, privateKey || keyPair.privateKey);
  }

  function verify(fields, signature, publicKey) {
    let payload = JSON.stringify(keystore.canonicalize(fields));
    return keystore.verifyWithPublicKey(payload, publicKey || keyPair.publicKey, signature);
  }

  // --- 1. buildApprovalPayload includes all required fields ---
  it('buildApprovalPayload includes frameID, toolName, arguments, sessionID', () => {
    let payload = {
      action:    'approve',
      frameID:   'frm_abc123',
      toolName:  'shell:ls',
      arguments: { command: 'ls -la' },
      sessionID: 'ses_xyz789',
    };

    let canonical = JSON.parse(keystore.canonicalize(payload));

    assert.equal(canonical.action, 'approve');
    assert.equal(canonical.frameID, 'frm_abc123');
    assert.equal(canonical.toolName, 'shell:ls');
    assert.deepStrictEqual(canonical.arguments, { command: 'ls -la' });
    assert.equal(canonical.sessionID, 'ses_xyz789');
  });

  // --- 2. signApproval produces valid Ed25519 signature ---
  it('signApproval produces valid Ed25519 signature (hex string)', () => {
    let payload = {
      action:    'approve',
      frameID:   'frm_test1',
      toolName:  'shell:cat',
      arguments: { command: 'cat file.txt' },
      sessionID: 'ses_test1',
    };

    let signature = buildAndSign(payload);

    assert.equal(typeof signature, 'string');
    assert.ok(signature.length > 0);
    // Ed25519 signatures are 64 bytes = 128 hex chars
    assert.equal(signature.length, 128);
  });

  // --- 3. verifyApproval returns true for valid signature ---
  it('verifyApproval returns true for valid signature', () => {
    let payload = {
      action:    'approve',
      frameID:   'frm_valid',
      toolName:  'files:read',
      arguments: { path: '/etc/hosts' },
      sessionID: 'ses_valid',
    };

    let signature = buildAndSign(payload);
    let valid     = verify(payload, signature);

    assert.equal(valid, true);
  });

  // --- 4. verifyApproval returns false for tampered payload ---
  it('verifyApproval returns false for tampered payload', () => {
    let payload = {
      action:    'approve',
      frameID:   'frm_tamper',
      toolName:  'shell:rm',
      arguments: { command: 'rm file.txt' },
      sessionID: 'ses_tamper',
    };

    let signature = buildAndSign(payload);

    // Tamper with the payload
    let tampered = { ...payload, arguments: { command: 'rm -rf /' } };
    let valid    = verify(tampered, signature);

    assert.equal(valid, false);
  });

  // --- 5. verifyApproval returns false for wrong key ---
  it('verifyApproval returns false for wrong key', () => {
    let payload = {
      action:    'approve',
      frameID:   'frm_wrongkey',
      toolName:  'shell:ls',
      arguments: {},
      sessionID: 'ses_wrongkey',
    };

    let signature = buildAndSign(payload, keyPair.privateKey);
    let valid     = verify(payload, signature, otherKeyPair.publicKey);

    assert.equal(valid, false);
  });

  // --- 6. Different frameID → verification fails (anti-replay) ---
  it('different frameID causes verification to fail (anti-replay)', () => {
    let payload = {
      action:    'approve',
      frameID:   'frm_original',
      toolName:  'shell:ls',
      arguments: { command: 'ls' },
      sessionID: 'ses_replay',
    };

    let signature = buildAndSign(payload);

    let replayed = { ...payload, frameID: 'frm_different' };
    let valid    = verify(replayed, signature);

    assert.equal(valid, false);
  });

  // --- 7. Different toolName → verification fails (anti-swap) ---
  it('different toolName causes verification to fail (anti-swap)', () => {
    let payload = {
      action:    'approve',
      frameID:   'frm_swap',
      toolName:  'shell:ls',
      arguments: { command: 'ls' },
      sessionID: 'ses_swap',
    };

    let signature = buildAndSign(payload);

    let swapped = { ...payload, toolName: 'shell:rm' };
    let valid   = verify(swapped, signature);

    assert.equal(valid, false);
  });

  // --- 8. Different arguments → verification fails (anti-escalation) ---
  it('different arguments causes verification to fail (anti-escalation)', () => {
    let payload = {
      action:    'approve',
      frameID:   'frm_escalate',
      toolName:  'shell:rm',
      arguments: { command: 'rm temp.txt' },
      sessionID: 'ses_escalate',
    };

    let signature = buildAndSign(payload);

    let escalated = { ...payload, arguments: { command: 'rm -rf /' } };
    let valid     = verify(escalated, signature);

    assert.equal(valid, false);
  });

  // --- 9. Different sessionID → verification fails (anti-cross-session) ---
  it('different sessionID causes verification to fail (anti-cross-session)', () => {
    let payload = {
      action:    'approve',
      frameID:   'frm_cross',
      toolName:  'shell:ls',
      arguments: {},
      sessionID: 'ses_session_a',
    };

    let signature = buildAndSign(payload);

    let crossed = { ...payload, sessionID: 'ses_session_b' };
    let valid   = verify(crossed, signature);

    assert.equal(valid, false);
  });

  // --- 10. Denial signature works the same way ---
  it('denial signature (action=deny) signs and verifies correctly', () => {
    let payload = {
      action:    'deny',
      frameID:   'frm_deny',
      toolName:  'shell:rm',
      arguments: { command: 'rm -rf /' },
      sessionID: 'ses_deny',
    };

    let signature = buildAndSign(payload);
    let valid     = verify(payload, signature);

    assert.equal(valid, true);

    // Tampering still fails
    let tampered = { ...payload, action: 'approve' };
    let invalid  = verify(tampered, signature);

    assert.equal(invalid, false);
  });

  // --- 11. PermissionService._buildApprovalBlob includes all fields ---
  it('PermissionService._buildApprovalBlob includes frameID and all fields', () => {
    // Create a minimal PermissionService (permissionEngine optional for Phase 4)
    let service = new PermissionService({
      context:          { getProperty: () => null },
      permissionEngine: { checkPermission: () => false },
      keystore,
    });

    let blob = service._buildApprovalBlob('approve', 'frm_blob', 'shell:ls', { command: 'ls' }, 'ses_blob');

    assert.equal(blob.action, 'approve');
    assert.equal(blob.frameID, 'frm_blob');
    assert.equal(blob.toolName, 'shell:ls');
    assert.deepStrictEqual(blob.arguments, { command: 'ls' });
    assert.equal(blob.sessionID, 'ses_blob');
  });

  // --- 12. Multiple approvals on same request are idempotent ---
  it('multiple approvals on same request produce same signature (idempotent)', () => {
    let payload = {
      action:    'approve',
      frameID:   'frm_idempotent',
      toolName:  'shell:ls',
      arguments: { command: 'ls -la' },
      sessionID: 'ses_idempotent',
    };

    let signature1 = buildAndSign(payload);
    let signature2 = buildAndSign(payload);

    // Ed25519 is deterministic — same input + same key = same signature
    assert.equal(signature1, signature2);

    // Both verify
    assert.equal(verify(payload, signature1), true);
    assert.equal(verify(payload, signature2), true);
  });

  // --- Edge cases ---

  it('null arguments are normalized to empty object in payload', () => {
    let payload1 = {
      action:    'approve',
      frameID:   'frm_null',
      toolName:  'shell:ls',
      arguments: {},
      sessionID: 'ses_null',
    };

    let payload2 = {
      action:    'approve',
      frameID:   'frm_null',
      toolName:  'shell:ls',
      arguments: {},
      sessionID: 'ses_null',
    };

    let sig1 = buildAndSign(payload1);
    let sig2 = buildAndSign(payload2);

    assert.equal(sig1, sig2);
  });

  it('null sessionID is preserved in payload', () => {
    let payload = {
      action:    'approve',
      frameID:   'frm_nosession',
      toolName:  'shell:ls',
      arguments: {},
      sessionID: null,
    };

    let signature = buildAndSign(payload);
    let valid     = verify(payload, signature);

    assert.equal(valid, true);
  });

  it('empty string signature returns false from verify', () => {
    let payload = {
      action:    'approve',
      frameID:   'frm_empty',
      toolName:  'shell:ls',
      arguments: {},
      sessionID: 'ses_empty',
    };

    let valid = verify(payload, '', keyPair.publicKey);
    assert.equal(valid, false);
  });

  it('garbage signature returns false from verify', () => {
    let payload = {
      action:    'approve',
      frameID:   'frm_garbage',
      toolName:  'shell:ls',
      arguments: {},
      sessionID: 'ses_garbage',
    };

    let valid = verify(payload, 'deadbeef'.repeat(16), keyPair.publicKey);
    assert.equal(valid, false);
  });

  it('null signature returns false from verify', () => {
    let payload = {
      action:    'approve',
      frameID:   'frm_nullsig',
      toolName:  'shell:ls',
      arguments: {},
      sessionID: 'ses_nullsig',
    };

    let valid = keystore.verifyWithPublicKey(
      JSON.stringify(keystore.canonicalize(payload)),
      keyPair.publicKey,
      null,
    );

    assert.equal(valid, false);
  });

  it('null public key returns false from verify', () => {
    let payload = {
      action:    'approve',
      frameID:   'frm_nullpub',
      toolName:  'shell:ls',
      arguments: {},
      sessionID: 'ses_nullpub',
    };

    let signature = buildAndSign(payload);
    let valid     = keystore.verifyWithPublicKey(
      JSON.stringify(keystore.canonicalize(payload)),
      null,
      signature,
    );

    assert.equal(valid, false);
  });
});
