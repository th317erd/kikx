'use strict';

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs     from 'node:fs';
import path   from 'node:path';
import os     from 'node:os';

import { Keystore } from '../../../src/core/crypto/keystore.mjs';

// =============================================================================
// Key Encryption Tests (Actor + User)
// =============================================================================

describe('Keystore key encryption', () => {
  let keystore;
  let tempDir;
  let samplePrivateKeyPEM;

  before(() => {
    tempDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'kikx-keyenc-test-'));
    keystore = new Keystore();
    keystore.initialize();
    keystore.loadServerMasterKey(tempDir);

    // Generate a sample key pair for testing
    let pair          = keystore.generateSigningKeyPair();
    samplePrivateKeyPEM = pair.privateKey;
  });

  after(() => {
    keystore.destroy();

    if (tempDir && fs.existsSync(tempDir))
      fs.rmSync(tempDir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // Actor key encryption (SMK-derived)
  // ---------------------------------------------------------------------------

  describe('encryptActorPrivateKey / decryptActorPrivateKey', () => {
    it('should round-trip encrypt and decrypt an actor private key', () => {
      let encrypted = keystore.encryptActorPrivateKey(samplePrivateKeyPEM, 'actor-123');
      let decrypted = keystore.decryptActorPrivateKey(encrypted, 'actor-123');

      assert.equal(decrypted, samplePrivateKeyPEM);
    });

    it('should return an object with ciphertext, iv, and authTag', () => {
      let encrypted = keystore.encryptActorPrivateKey(samplePrivateKeyPEM, 'actor-456');

      assert.equal(typeof encrypted.ciphertext, 'string');
      assert.equal(typeof encrypted.iv, 'string');
      assert.equal(typeof encrypted.authTag, 'string');
      assert.match(encrypted.ciphertext, /^[0-9a-f]+$/);
      assert.match(encrypted.iv, /^[0-9a-f]+$/);
      assert.match(encrypted.authTag, /^[0-9a-f]+$/);
    });

    it('should not cross-decrypt with different actorIDs', () => {
      let encrypted = keystore.encryptActorPrivateKey(samplePrivateKeyPEM, 'actor-aaa');

      assert.throws(
        () => keystore.decryptActorPrivateKey(encrypted, 'actor-bbb'),
        /Unsupported state|error/i,
      );
    });

    it('should throw if SMK is not loaded', () => {
      let noSmkKeystore = new Keystore();
      noSmkKeystore.initialize();

      try {
        assert.throws(
          () => noSmkKeystore.encryptActorPrivateKey(samplePrivateKeyPEM, 'actor-1'),
          /Server Master Key not loaded/,
        );

        assert.throws(
          () => noSmkKeystore.decryptActorPrivateKey({ ciphertext: 'aa', iv: 'bb', authTag: 'cc' }, 'actor-1'),
          /Server Master Key not loaded/,
        );
      } finally {
        noSmkKeystore.destroy();
      }
    });

    it('should throw if privateKeyPEM is null for encrypt', () => {
      assert.throws(
        () => keystore.encryptActorPrivateKey(null, 'actor-1'),
        /Private key PEM is required/,
      );
    });

    it('should throw if actorID is null for encrypt', () => {
      assert.throws(
        () => keystore.encryptActorPrivateKey(samplePrivateKeyPEM, null),
        /Actor ID is required/,
      );
    });

    it('should throw if encryptedData is null for decrypt', () => {
      assert.throws(
        () => keystore.decryptActorPrivateKey(null, 'actor-1'),
        /Encrypted data is required/,
      );
    });

    it('should throw if actorID is null for decrypt', () => {
      assert.throws(
        () => keystore.decryptActorPrivateKey({ ciphertext: 'aa', iv: 'bb', authTag: 'cc' }, null),
        /Actor ID is required/,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // User key encryption (UMK-derived)
  // ---------------------------------------------------------------------------

  describe('encryptUserPrivateKey / decryptUserPrivateKey', () => {
    it('should round-trip encrypt and decrypt a user private key', () => {
      let umk       = keystore.generateUMK();
      let encrypted = keystore.encryptUserPrivateKey(samplePrivateKeyPEM, umk, 'user-123');
      let decrypted = keystore.decryptUserPrivateKey(encrypted, umk, 'user-123');

      assert.equal(decrypted, samplePrivateKeyPEM);
    });

    it('should return an object with ciphertext, iv, and authTag', () => {
      let umk       = keystore.generateUMK();
      let encrypted = keystore.encryptUserPrivateKey(samplePrivateKeyPEM, umk, 'user-456');

      assert.equal(typeof encrypted.ciphertext, 'string');
      assert.equal(typeof encrypted.iv, 'string');
      assert.equal(typeof encrypted.authTag, 'string');
      assert.match(encrypted.ciphertext, /^[0-9a-f]+$/);
      assert.match(encrypted.iv, /^[0-9a-f]+$/);
      assert.match(encrypted.authTag, /^[0-9a-f]+$/);
    });

    it('should not cross-decrypt with different userIDs', () => {
      let umk       = keystore.generateUMK();
      let encrypted = keystore.encryptUserPrivateKey(samplePrivateKeyPEM, umk, 'user-aaa');

      assert.throws(
        () => keystore.decryptUserPrivateKey(encrypted, umk, 'user-bbb'),
        /Unsupported state|error/i,
      );
    });

    it('should not cross-decrypt with different UMKs', () => {
      let umk1      = keystore.generateUMK();
      let umk2      = keystore.generateUMK();
      let encrypted = keystore.encryptUserPrivateKey(samplePrivateKeyPEM, umk1, 'user-same');

      assert.throws(
        () => keystore.decryptUserPrivateKey(encrypted, umk2, 'user-same'),
        /Unsupported state|error/i,
      );
    });

    it('should throw if privateKeyPEM is null for encrypt', () => {
      let umk = keystore.generateUMK();

      assert.throws(
        () => keystore.encryptUserPrivateKey(null, umk, 'user-1'),
        /Private key PEM is required/,
      );
    });

    it('should throw if umk is null for encrypt', () => {
      assert.throws(
        () => keystore.encryptUserPrivateKey(samplePrivateKeyPEM, null, 'user-1'),
        /UMK is required/,
      );
    });

    it('should throw if userID is null for encrypt', () => {
      let umk = keystore.generateUMK();

      assert.throws(
        () => keystore.encryptUserPrivateKey(samplePrivateKeyPEM, umk, null),
        /User ID is required/,
      );
    });

    it('should throw if encryptedData is null for decrypt', () => {
      let umk = keystore.generateUMK();

      assert.throws(
        () => keystore.decryptUserPrivateKey(null, umk, 'user-1'),
        /Encrypted data is required/,
      );
    });

    it('should throw if umk is null for decrypt', () => {
      assert.throws(
        () => keystore.decryptUserPrivateKey({ ciphertext: 'aa', iv: 'bb', authTag: 'cc' }, null, 'user-1'),
        /UMK is required/,
      );
    });

    it('should throw if userID is null for decrypt', () => {
      let umk = keystore.generateUMK();

      assert.throws(
        () => keystore.decryptUserPrivateKey({ ciphertext: 'aa', iv: 'bb', authTag: 'cc' }, umk, null),
        /User ID is required/,
      );
    });
  });
});
