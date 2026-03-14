'use strict';

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { Keystore } from '../../../src/core/crypto/keystore.mjs';

// =============================================================================
// Ed25519 Signing Tests
// =============================================================================

describe('Keystore Ed25519 signing', () => {
  let keystore;

  beforeEach(() => {
    keystore = new Keystore({ devMode: true, devSeed: 'ed25519-test-seed' });
    keystore.initialize();
  });

  // ---------------------------------------------------------------------------
  // generateSigningKeyPair
  // ---------------------------------------------------------------------------

  describe('generateSigningKeyPair', () => {
    it('should return PEM strings for public and private keys', () => {
      let { publicKey, privateKey } = keystore.generateSigningKeyPair();

      assert.equal(typeof publicKey, 'string');
      assert.equal(typeof privateKey, 'string');
      assert.ok(publicKey.startsWith('-----BEGIN PUBLIC KEY-----'), 'Public key should be PEM');
      assert.ok(privateKey.startsWith('-----BEGIN PRIVATE KEY-----'), 'Private key should be PEM');
    });

    it('should generate different key pairs each time', () => {
      let pair1 = keystore.generateSigningKeyPair();
      let pair2 = keystore.generateSigningKeyPair();

      assert.notEqual(pair1.publicKey, pair2.publicKey);
      assert.notEqual(pair1.privateKey, pair2.privateKey);
    });
  });

  // ---------------------------------------------------------------------------
  // signWithPrivateKey
  // ---------------------------------------------------------------------------

  describe('signWithPrivateKey', () => {
    it('should return a hex string', () => {
      let { privateKey } = keystore.generateSigningKeyPair();
      let signature      = keystore.signWithPrivateKey('hello world', privateKey);

      assert.equal(typeof signature, 'string');
      assert.match(signature, /^[0-9a-f]+$/, 'Signature should be hex');
    });

    it('should return a 128-character hex string (64 bytes for Ed25519)', () => {
      let { privateKey } = keystore.generateSigningKeyPair();
      let signature      = keystore.signWithPrivateKey('test data', privateKey);

      assert.equal(signature.length, 128, 'Ed25519 signature should be 64 bytes = 128 hex chars');
    });

    it('should produce different signatures for different data', () => {
      let { privateKey } = keystore.generateSigningKeyPair();
      let sig1           = keystore.signWithPrivateKey('data-a', privateKey);
      let sig2           = keystore.signWithPrivateKey('data-b', privateKey);

      assert.notEqual(sig1, sig2);
    });

    it('should produce the same signature for the same data (Ed25519 is deterministic)', () => {
      let { privateKey } = keystore.generateSigningKeyPair();
      let sig1           = keystore.signWithPrivateKey('same data', privateKey);
      let sig2           = keystore.signWithPrivateKey('same data', privateKey);

      assert.equal(sig1, sig2);
    });

    it('should produce different signatures with different key pairs for the same data', () => {
      let pair1 = keystore.generateSigningKeyPair();
      let pair2 = keystore.generateSigningKeyPair();
      let sig1  = keystore.signWithPrivateKey('same data', pair1.privateKey);
      let sig2  = keystore.signWithPrivateKey('same data', pair2.privateKey);

      assert.notEqual(sig1, sig2);
    });

    it('should throw when data is null', () => {
      let { privateKey } = keystore.generateSigningKeyPair();

      assert.throws(
        () => keystore.signWithPrivateKey(null, privateKey),
        /Data is required/,
      );
    });

    it('should throw when data is undefined', () => {
      let { privateKey } = keystore.generateSigningKeyPair();

      assert.throws(
        () => keystore.signWithPrivateKey(undefined, privateKey),
        /Data is required/,
      );
    });

    it('should throw when private key is null', () => {
      assert.throws(
        () => keystore.signWithPrivateKey('data', null),
        /Private key is required/,
      );
    });

    it('should throw when private key is undefined', () => {
      assert.throws(
        () => keystore.signWithPrivateKey('data', undefined),
        /Private key is required/,
      );
    });

    it('should throw when private key is invalid PEM', () => {
      assert.throws(
        () => keystore.signWithPrivateKey('data', 'not-a-valid-pem-key'),
      );
    });

    it('should sign an empty string and produce a valid signature', () => {
      let { publicKey, privateKey } = keystore.generateSigningKeyPair();
      let signature                 = keystore.signWithPrivateKey('', privateKey);

      assert.equal(signature.length, 128);
      assert.ok(keystore.verifyWithPublicKey('', publicKey, signature));
    });

    it('should canonicalize objects so key order does not affect signature', () => {
      let { privateKey } = keystore.generateSigningKeyPair();
      let sig1           = keystore.signWithPrivateKey({ z: 1, a: 2 }, privateKey);
      let sig2           = keystore.signWithPrivateKey({ a: 2, z: 1 }, privateKey);

      assert.equal(sig1, sig2, 'Key order should not affect signature');
    });
  });

  // ---------------------------------------------------------------------------
  // verifyWithPublicKey
  // ---------------------------------------------------------------------------

  describe('verifyWithPublicKey', () => {
    it('should verify a valid signature (sign -> verify round trip)', () => {
      let { publicKey, privateKey } = keystore.generateSigningKeyPair();
      let data                      = 'important data';
      let signature                 = keystore.signWithPrivateKey(data, privateKey);

      assert.equal(keystore.verifyWithPublicKey(data, publicKey, signature), true);
    });

    it('should return false for wrong public key', () => {
      let pair1     = keystore.generateSigningKeyPair();
      let pair2     = keystore.generateSigningKeyPair();
      let signature = keystore.signWithPrivateKey('data', pair1.privateKey);

      assert.equal(keystore.verifyWithPublicKey('data', pair2.publicKey, signature), false);
    });

    it('should return false for tampered data', () => {
      let { publicKey, privateKey } = keystore.generateSigningKeyPair();
      let signature                 = keystore.signWithPrivateKey('original data', privateKey);

      assert.equal(keystore.verifyWithPublicKey('tampered data', publicKey, signature), false);
    });

    it('should return false for tampered signature', () => {
      let { publicKey, privateKey } = keystore.generateSigningKeyPair();
      let signature                 = keystore.signWithPrivateKey('data', privateKey);
      let tampered                  = signature.slice(0, -2) + ((signature.endsWith('00')) ? '01' : '00');

      assert.equal(keystore.verifyWithPublicKey('data', publicKey, tampered), false);
    });

    it('should return false for truncated signature', () => {
      let { publicKey, privateKey } = keystore.generateSigningKeyPair();
      let signature                 = keystore.signWithPrivateKey('data', privateKey);
      let truncated                 = signature.slice(0, 32);

      assert.equal(keystore.verifyWithPublicKey('data', publicKey, truncated), false);
    });

    it('should return false for empty string signature', () => {
      let { publicKey } = keystore.generateSigningKeyPair();

      assert.equal(keystore.verifyWithPublicKey('data', publicKey, ''), false);
    });

    it('should return false for non-hex signature', () => {
      let { publicKey } = keystore.generateSigningKeyPair();

      assert.equal(keystore.verifyWithPublicKey('data', publicKey, 'zzzzzz'), false);
    });

    it('should return false (not throw) for invalid PEM public key', () => {
      let result = keystore.verifyWithPublicKey('data', 'not-a-valid-pem', 'aabb');

      assert.equal(result, false);
    });

    it('should return false for null data', () => {
      let { publicKey } = keystore.generateSigningKeyPair();

      assert.equal(keystore.verifyWithPublicKey(null, publicKey, 'aabb'), false);
    });

    it('should return false for null public key', () => {
      assert.equal(keystore.verifyWithPublicKey('data', null, 'aabb'), false);
    });

    it('should return false for null signature', () => {
      let { publicKey } = keystore.generateSigningKeyPair();

      assert.equal(keystore.verifyWithPublicKey('data', publicKey, null), false);
    });

    it('should verify object data with canonicalization', () => {
      let { publicKey, privateKey } = keystore.generateSigningKeyPair();
      let signature                 = keystore.signWithPrivateKey({ b: 2, a: 1 }, privateKey);

      // Verify with different key order
      assert.equal(keystore.verifyWithPublicKey({ a: 1, b: 2 }, publicKey, signature), true);
    });
  });
});
