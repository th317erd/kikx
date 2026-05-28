'use strict';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs     from 'node:fs';
import os     from 'node:os';
import path   from 'node:path';

import { Keystore } from '../../../src/core/crypto/keystore.mjs';
import {
  computeKeyFingerprint,
  buildSigningPayload,
  signValue,
  verifyValue,
} from '../../../src/core/crypto/value-signing.mjs';

// =============================================================================
// Value Signing Utilities Tests
// =============================================================================

describe('Value Signing Utilities', () => {
  let keystore;
  let tempDir;

  before(() => {
    tempDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'kikx-vs-sign-'));
    keystore = new Keystore();
    keystore.initialize();
    keystore.loadServerMasterKey(tempDir);
  });

  after(() => {
    if (keystore)
      keystore.destroy();

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // computeKeyFingerprint
  // ---------------------------------------------------------------------------

  describe('computeKeyFingerprint', () => {
    it('returns 32-char hex string for a valid public key', () => {
      let { publicKey } = keystore.generateSigningKeyPair();
      let fp = computeKeyFingerprint(publicKey);

      assert.ok(fp);
      assert.equal(fp.length, 32);
      assert.match(fp, /^[0-9a-f]{32}$/);
    });

    it('returns different fingerprints for different keys', () => {
      let key1 = keystore.generateSigningKeyPair();
      let key2 = keystore.generateSigningKeyPair();

      let fp1 = computeKeyFingerprint(key1.publicKey);
      let fp2 = computeKeyFingerprint(key2.publicKey);

      assert.notEqual(fp1, fp2);
    });

    it('returns same fingerprint for same key', () => {
      let { publicKey } = keystore.generateSigningKeyPair();

      let fp1 = computeKeyFingerprint(publicKey);
      let fp2 = computeKeyFingerprint(publicKey);

      assert.equal(fp1, fp2);
    });

    it('returns null for null input', () => {
      assert.equal(computeKeyFingerprint(null), null);
    });

    it('returns null for undefined input', () => {
      assert.equal(computeKeyFingerprint(undefined), null);
    });

    it('returns null for empty string', () => {
      assert.equal(computeKeyFingerprint(''), null);
    });
  });

  // ---------------------------------------------------------------------------
  // buildSigningPayload
  // ---------------------------------------------------------------------------

  describe('buildSigningPayload', () => {
    it('builds pipe-delimited string from all components', () => {
      let payload = buildSigningPayload('Agent', 'agt_123', 'memory', 'ses_456', 'myKey', '"hello"');

      assert.equal(payload, 'Agent|agt_123|memory|ses_456|myKey|"hello"');
    });

    it('handles empty scopeID', () => {
      let payload = buildSigningPayload('Agent', 'agt_1', 'config', '', 'key', '"val"');

      assert.equal(payload, 'Agent|agt_1|config||key|"val"');
    });

    it('includes complex JSON values', () => {
      let jsonValue = JSON.stringify({ nested: { deep: true } });
      let payload   = buildSigningPayload('User', 'usr_1', 'settings', '', 'prefs', jsonValue);

      assert.ok(payload.includes(jsonValue));
    });

    it('different keys produce different payloads', () => {
      let p1 = buildSigningPayload('Agent', 'agt_1', 'memory', '', 'key_a', '"val"');
      let p2 = buildSigningPayload('Agent', 'agt_1', 'memory', '', 'key_b', '"val"');

      assert.notEqual(p1, p2);
    });

    it('different scopes produce different payloads', () => {
      let p1 = buildSigningPayload('Agent', 'agt_1', 'memory', 'scope_a', 'key', '"val"');
      let p2 = buildSigningPayload('Agent', 'agt_1', 'memory', 'scope_b', 'key', '"val"');

      assert.notEqual(p1, p2);
    });

    it('different owners produce different payloads', () => {
      let p1 = buildSigningPayload('Agent', 'agt_1', 'memory', '', 'key', '"val"');
      let p2 = buildSigningPayload('Agent', 'agt_2', 'memory', '', 'key', '"val"');

      assert.notEqual(p1, p2);
    });
  });

  // ---------------------------------------------------------------------------
  // signValue
  // ---------------------------------------------------------------------------

  describe('signValue', () => {
    it('returns { signature, fingerprint } for valid inputs', () => {
      let { publicKey, privateKey } = keystore.generateSigningKeyPair();

      let result = signValue(
        keystore, privateKey, publicKey,
        'Agent', 'agt_1', 'memory', '', 'key',
        '"hello"',
      );

      assert.ok(result);
      assert.ok(result.signature);
      assert.ok(result.fingerprint);
      assert.equal(result.fingerprint.length, 32);
    });

    it('returns null when keystore is null', () => {
      let { publicKey, privateKey } = keystore.generateSigningKeyPair();

      let result = signValue(
        null, privateKey, publicKey,
        'Agent', 'agt_1', 'memory', '', 'key',
        '"hello"',
      );

      assert.equal(result, null);
    });

    it('returns null when privateKey is null', () => {
      let { publicKey } = keystore.generateSigningKeyPair();

      let result = signValue(
        keystore, null, publicKey,
        'Agent', 'agt_1', 'memory', '', 'key',
        '"hello"',
      );

      assert.equal(result, null);
    });

    it('returns null when publicKey is null', () => {
      let { privateKey } = keystore.generateSigningKeyPair();

      let result = signValue(
        keystore, privateKey, null,
        'Agent', 'agt_1', 'memory', '', 'key',
        '"hello"',
      );

      assert.equal(result, null);
    });

    it('returns null for invalid private key', () => {
      let { publicKey } = keystore.generateSigningKeyPair();

      let result = signValue(
        keystore, 'not-a-real-private-key', publicKey,
        'Agent', 'agt_1', 'memory', '', 'key',
        '"hello"',
      );

      assert.equal(result, null);
    });

    it('same inputs produce same signature', () => {
      let { publicKey, privateKey } = keystore.generateSigningKeyPair();
      let args = [keystore, privateKey, publicKey, 'Agent', 'agt_1', 'memory', '', 'key', '"hello"'];

      let r1 = signValue(...args);
      let r2 = signValue(...args);

      assert.equal(r1.signature, r2.signature);
      assert.equal(r1.fingerprint, r2.fingerprint);
    });

    it('different values produce different signatures', () => {
      let { publicKey, privateKey } = keystore.generateSigningKeyPair();

      let r1 = signValue(keystore, privateKey, publicKey, 'Agent', 'agt_1', 'memory', '', 'key', '"hello"');
      let r2 = signValue(keystore, privateKey, publicKey, 'Agent', 'agt_1', 'memory', '', 'key', '"world"');

      assert.notEqual(r1.signature, r2.signature);
    });
  });

  // ---------------------------------------------------------------------------
  // verifyValue
  // ---------------------------------------------------------------------------

  describe('verifyValue', () => {
    it('returns true for valid signature', () => {
      let { publicKey, privateKey } = keystore.generateSigningKeyPair();
      let signed = signValue(keystore, privateKey, publicKey, 'Agent', 'agt_1', 'memory', '', 'key', '"hello"');

      let valid = verifyValue(
        keystore, publicKey,
        'Agent', 'agt_1', 'memory', '', 'key',
        '"hello"', signed.signature,
      );

      assert.equal(valid, true);
    });

    it('returns false for tampered value', () => {
      let { publicKey, privateKey } = keystore.generateSigningKeyPair();
      let signed = signValue(keystore, privateKey, publicKey, 'Agent', 'agt_1', 'memory', '', 'key', '"hello"');

      let valid = verifyValue(
        keystore, publicKey,
        'Agent', 'agt_1', 'memory', '', 'key',
        '"tampered"', signed.signature,
      );

      assert.equal(valid, false);
    });

    it('returns false for tampered key name', () => {
      let { publicKey, privateKey } = keystore.generateSigningKeyPair();
      let signed = signValue(keystore, privateKey, publicKey, 'Agent', 'agt_1', 'memory', '', 'key', '"hello"');

      let valid = verifyValue(
        keystore, publicKey,
        'Agent', 'agt_1', 'memory', '', 'different_key',
        '"hello"', signed.signature,
      );

      assert.equal(valid, false);
    });

    it('returns false for tampered scopeID (cross-scope replay)', () => {
      let { publicKey, privateKey } = keystore.generateSigningKeyPair();
      let signed = signValue(keystore, privateKey, publicKey, 'Agent', 'agt_1', 'memory', 'scope_a', 'key', '"hello"');

      let valid = verifyValue(
        keystore, publicKey,
        'Agent', 'agt_1', 'memory', 'scope_b', 'key',
        '"hello"', signed.signature,
      );

      assert.equal(valid, false);
    });

    it('returns false for tampered ownerID (cross-owner replay)', () => {
      let { publicKey, privateKey } = keystore.generateSigningKeyPair();
      let signed = signValue(keystore, privateKey, publicKey, 'Agent', 'agt_1', 'memory', '', 'key', '"hello"');

      let valid = verifyValue(
        keystore, publicKey,
        'Agent', 'agt_2', 'memory', '', 'key',
        '"hello"', signed.signature,
      );

      assert.equal(valid, false);
    });

    it('returns false for wrong public key', () => {
      let kp1 = keystore.generateSigningKeyPair();
      let kp2 = keystore.generateSigningKeyPair();

      let signed = signValue(keystore, kp1.privateKey, kp1.publicKey, 'Agent', 'agt_1', 'memory', '', 'key', '"hello"');

      let valid = verifyValue(
        keystore, kp2.publicKey,
        'Agent', 'agt_1', 'memory', '', 'key',
        '"hello"', signed.signature,
      );

      assert.equal(valid, false);
    });

    it('returns false for corrupted signature', () => {
      let { publicKey } = keystore.generateSigningKeyPair();

      let valid = verifyValue(
        keystore, publicKey,
        'Agent', 'agt_1', 'memory', '', 'key',
        '"hello"', 'deadbeef00112233',
      );

      assert.equal(valid, false);
    });

    it('returns false for empty signature', () => {
      let { publicKey } = keystore.generateSigningKeyPair();

      let valid = verifyValue(
        keystore, publicKey,
        'Agent', 'agt_1', 'memory', '', 'key',
        '"hello"', '',
      );

      assert.equal(valid, false);
    });

    it('returns false for null signature', () => {
      let { publicKey } = keystore.generateSigningKeyPair();

      let valid = verifyValue(
        keystore, publicKey,
        'Agent', 'agt_1', 'memory', '', 'key',
        '"hello"', null,
      );

      assert.equal(valid, false);
    });

    it('returns false for null keystore', () => {
      let valid = verifyValue(
        null, 'fake-public-key',
        'Agent', 'agt_1', 'memory', '', 'key',
        '"hello"', 'fake-signature',
      );

      assert.equal(valid, false);
    });

    it('returns false for null public key', () => {
      let valid = verifyValue(
        keystore, null,
        'Agent', 'agt_1', 'memory', '', 'key',
        '"hello"', 'fake-signature',
      );

      assert.equal(valid, false);
    });

    it('returns false for invalid public key (not crash)', () => {
      let valid = verifyValue(
        keystore, 'totally-not-a-key',
        'Agent', 'agt_1', 'memory', '', 'key',
        '"hello"', 'deadbeef',
      );

      assert.equal(valid, false);
    });
  });

  // ---------------------------------------------------------------------------
  // Integration: sign + verify round trip
  // ---------------------------------------------------------------------------

  describe('sign + verify round trip', () => {
    it('sign then verify with same parameters succeeds', () => {
      let { publicKey, privateKey } = keystore.generateSigningKeyPair();
      let args = ['Agent', 'agt_1', 'memory', 'ses_123', 'email', JSON.stringify('user@example.com')];

      let signed = signValue(keystore, privateKey, publicKey, ...args);
      let valid  = verifyValue(keystore, publicKey, ...args, signed.signature);

      assert.equal(valid, true);
    });

    it('sign with complex JSON object value', () => {
      let { publicKey, privateKey } = keystore.generateSigningKeyPair();
      let value = JSON.stringify({ preferences: { theme: 'dark', fontSize: 14 }, tags: ['admin', 'beta'] });

      let signed = signValue(keystore, privateKey, publicKey, 'Agent', 'agt_1', 'config', '', 'prefs', value);
      let valid  = verifyValue(keystore, publicKey, 'Agent', 'agt_1', 'config', '', 'prefs', value, signed.signature);

      assert.equal(valid, true);
    });

    it('sign with number value', () => {
      let { publicKey, privateKey } = keystore.generateSigningKeyPair();
      let value = JSON.stringify(42);

      let signed = signValue(keystore, privateKey, publicKey, 'Agent', 'agt_1', 'memory', '', 'count', value);
      let valid  = verifyValue(keystore, publicKey, 'Agent', 'agt_1', 'memory', '', 'count', value, signed.signature);

      assert.equal(valid, true);
    });

    it('sign with boolean value', () => {
      let { publicKey, privateKey } = keystore.generateSigningKeyPair();
      let value = JSON.stringify(true);

      let signed = signValue(keystore, privateKey, publicKey, 'Agent', 'agt_1', 'memory', '', 'flag', value);
      let valid  = verifyValue(keystore, publicKey, 'Agent', 'agt_1', 'memory', '', 'flag', value, signed.signature);

      assert.equal(valid, true);
    });

    it('sign with null JSON value', () => {
      let { publicKey, privateKey } = keystore.generateSigningKeyPair();
      let value = JSON.stringify(null);

      let signed = signValue(keystore, privateKey, publicKey, 'Agent', 'agt_1', 'memory', '', 'nothing', value);
      let valid  = verifyValue(keystore, publicKey, 'Agent', 'agt_1', 'memory', '', 'nothing', value, signed.signature);

      assert.equal(valid, true);
    });

    it('sign with empty string value', () => {
      let { publicKey, privateKey } = keystore.generateSigningKeyPair();
      let value = JSON.stringify('');

      let signed = signValue(keystore, privateKey, publicKey, 'Agent', 'agt_1', 'memory', '', 'blank', value);
      let valid  = verifyValue(keystore, publicKey, 'Agent', 'agt_1', 'memory', '', 'blank', value, signed.signature);

      assert.equal(valid, true);
    });
  });
});
