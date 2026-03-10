'use strict';

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Keystore } from '../../src/core/crypto/keystore.mjs';

describe('Keystore', () => {

  // --- REK Lifecycle ---

  describe('REK lifecycle', () => {
    it('should initialize with a random 32-byte REK in production mode', () => {
      let keystore = new Keystore();
      assert.equal(keystore.isInitialized(), false);

      keystore.initialize();
      assert.equal(keystore.isInitialized(), true);

      keystore.destroy();
    });

    it('should initialize with a deterministic REK in dev mode with seed', () => {
      let keystore1 = new Keystore({ devMode: true, devSeed: 'test-seed-alpha' });
      let keystore2 = new Keystore({ devMode: true, devSeed: 'test-seed-alpha' });

      keystore1.initialize();
      keystore2.initialize();

      // Same seed produces the same REK — encrypt something and compare
      let plaintext   = 'deterministic-test';
      let umk         = keystore1.generateUMK();
      let wrapped1    = keystore1.wrapUMK(umk);
      let unwrapped2  = keystore2.unwrapUMK(wrapped1);

      assert.deepEqual(unwrapped2, umk);

      keystore1.destroy();
      keystore2.destroy();
    });

    it('should produce different REKs for different dev seeds', () => {
      let keystoreA = new Keystore({ devMode: true, devSeed: 'seed-one' });
      let keystoreB = new Keystore({ devMode: true, devSeed: 'seed-two' });

      keystoreA.initialize();
      keystoreB.initialize();

      let umk     = keystoreA.generateUMK();
      let wrapped = keystoreA.wrapUMK(umk);

      // keystoreB with a different seed should fail to unwrap
      assert.throws(() => {
        keystoreB.unwrapUMK(wrapped);
      });

      keystoreA.destroy();
      keystoreB.destroy();
    });

    it('should throw on double initialization', () => {
      let keystore = new Keystore();
      keystore.initialize();

      assert.throws(() => {
        keystore.initialize();
      }, { message: 'Keystore already initialized' });

      keystore.destroy();
    });

    it('should zero memory on destroy', () => {
      let keystore = new Keystore();
      keystore.initialize();

      assert.equal(keystore.isInitialized(), true);

      // Grab a reference to the internal buffer before destroy
      let rekReference = keystore._rek;

      keystore.destroy();

      assert.equal(keystore.isInitialized(), false);
      assert.equal(keystore._rek, null);

      // The buffer we captured should be zeroed
      let allZeros = rekReference.every((byte) => byte === 0);
      assert.equal(allZeros, true, 'REK buffer should be zeroed after destroy');
    });

    it('should allow re-initialization after destroy', () => {
      let keystore = new Keystore();
      keystore.initialize();
      keystore.destroy();

      // Should not throw
      keystore.initialize();
      assert.equal(keystore.isInitialized(), true);

      keystore.destroy();
    });

    it('should be a no-op to destroy when not initialized', () => {
      let keystore = new Keystore();

      // Should not throw
      keystore.destroy();
      assert.equal(keystore.isInitialized(), false);
    });

    it('should generate random REK in prod mode (no devMode)', () => {
      let keystore1 = new Keystore();
      let keystore2 = new Keystore();

      keystore1.initialize();
      keystore2.initialize();

      // Two random REKs should differ (astronomically unlikely to collide)
      let umk     = keystore1.generateUMK();
      let wrapped = keystore1.wrapUMK(umk);

      assert.throws(() => {
        keystore2.unwrapUMK(wrapped);
      });

      keystore1.destroy();
      keystore2.destroy();
    });
  });

  // --- AES-256-GCM Encryption ---

  describe('AES-256-GCM encryption', () => {
    let keystore;

    beforeEach(() => {
      keystore = new Keystore({ devMode: true, devSeed: 'encryption-tests' });
      keystore.initialize();
    });

    afterEach(() => {
      keystore.destroy();
    });

    it('should roundtrip encrypt/decrypt a string', () => {
      let plaintext   = 'Hello, zero-knowledge world!';
      let encrypted   = keystore.encrypt(plaintext);
      let decrypted   = keystore.decrypt(encrypted);

      assert.equal(decrypted.toString('utf8'), plaintext);
    });

    it('should roundtrip encrypt/decrypt a Buffer', () => {
      let plainBuffer = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd]);
      let encrypted   = keystore.encrypt(plainBuffer);
      let decrypted   = keystore.decrypt(encrypted);

      assert.deepEqual(decrypted, plainBuffer);
    });

    it('should produce different IVs each time (unique ciphertexts)', () => {
      let plaintext   = 'same input';
      let encrypted1  = keystore.encrypt(plaintext);
      let encrypted2  = keystore.encrypt(plaintext);

      assert.notEqual(encrypted1.iv, encrypted2.iv, 'IVs should differ');
      assert.notEqual(encrypted1.ciphertext, encrypted2.ciphertext, 'Ciphertexts should differ due to different IVs');
    });

    it('should return hex-encoded ciphertext, iv, and authTag', () => {
      let encrypted = keystore.encrypt('test');

      assert.equal(typeof encrypted.ciphertext, 'string');
      assert.equal(typeof encrypted.iv, 'string');
      assert.equal(typeof encrypted.authTag, 'string');

      // All should be valid hex
      assert.match(encrypted.ciphertext, /^[0-9a-f]+$/);
      assert.match(encrypted.iv, /^[0-9a-f]+$/);
      assert.match(encrypted.authTag, /^[0-9a-f]+$/);

      // IV should be 12 bytes = 24 hex chars
      assert.equal(encrypted.iv.length, 24);

      // GCM auth tag is 16 bytes = 32 hex chars
      assert.equal(encrypted.authTag.length, 32);
    });

    it('should fail decryption with tampered authTag', () => {
      let encrypted = keystore.encrypt('sensitive data');

      // Flip a character in the auth tag
      let tampered = {
        ...encrypted,
        authTag: encrypted.authTag.replace(/[0-9a-f]/, (character) => {
          return (character === '0') ? '1' : '0';
        }),
      };

      assert.throws(() => {
        keystore.decrypt(tampered);
      });
    });

    it('should fail decryption with tampered ciphertext', () => {
      let encrypted = keystore.encrypt('sensitive data');

      let tampered = {
        ...encrypted,
        ciphertext: encrypted.ciphertext.replace(/[0-9a-f]/, (character) => {
          return (character === '0') ? '1' : '0';
        }),
      };

      assert.throws(() => {
        keystore.decrypt(tampered);
      });
    });

    it('should fail decryption with wrong key', () => {
      let rightKey  = crypto.randomBytes(32);
      let wrongKey  = crypto.randomBytes(32);
      let encrypted = keystore.encrypt('secret', rightKey);

      assert.throws(() => {
        keystore.decrypt(encrypted, wrongKey);
      });
    });

    it('should encrypt with an explicit key instead of REK', () => {
      let customKey = crypto.randomBytes(32);
      let plaintext = 'custom key test';
      let encrypted = keystore.encrypt(plaintext, customKey);
      let decrypted = keystore.decrypt(encrypted, customKey);

      assert.equal(decrypted.toString('utf8'), plaintext);
    });

    it('should throw when encrypting without REK and no explicit key', () => {
      let uninitialized = new Keystore();

      assert.throws(() => {
        uninitialized.encrypt('test');
      }, { message: 'No encryption key available' });
    });

    it('should throw when decrypting without REK and no explicit key', () => {
      let uninitialized = new Keystore();

      assert.throws(() => {
        uninitialized.decrypt({ ciphertext: 'aa', iv: 'bb', authTag: 'cc' });
      }, { message: 'No encryption key available' });
    });
  });

  // --- UMK Wrapping ---

  describe('UMK wrapping', () => {
    let keystore;

    beforeEach(() => {
      keystore = new Keystore({ devMode: true, devSeed: 'umk-tests' });
      keystore.initialize();
    });

    afterEach(() => {
      keystore.destroy();
    });

    it('should roundtrip wrapUMK/unwrapUMK', () => {
      let umk       = keystore.generateUMK();
      let wrapped   = keystore.wrapUMK(umk);
      let unwrapped = keystore.unwrapUMK(wrapped);

      assert.deepEqual(unwrapped, umk);
    });

    it('should generate 32-byte UMKs', () => {
      let umk = keystore.generateUMK();
      assert.equal(umk.length, 32);
      assert.ok(Buffer.isBuffer(umk));
    });

    it('should generate unique UMKs each time', () => {
      let umk1 = keystore.generateUMK();
      let umk2 = keystore.generateUMK();

      assert.notDeepEqual(umk1, umk2);
    });

    it('should throw wrapUMK when not initialized', () => {
      let uninitialized = new Keystore();

      assert.throws(() => {
        uninitialized.wrapUMK(crypto.randomBytes(32));
      }, { message: 'Keystore not initialized' });
    });

    it('should throw unwrapUMK when not initialized', () => {
      let uninitialized = new Keystore();

      assert.throws(() => {
        uninitialized.unwrapUMK({ ciphertext: 'aa', iv: 'aabbccddee001122', authTag: 'aabbccddee001122aabbccddee001122' });
      }, { message: 'Keystore not initialized' });
    });

    it('should produce different wrapped outputs for the same UMK (random IV)', () => {
      let umk      = keystore.generateUMK();
      let wrapped1 = keystore.wrapUMK(umk);
      let wrapped2 = keystore.wrapUMK(umk);

      assert.notEqual(wrapped1.iv, wrapped2.iv);
      assert.notEqual(wrapped1.ciphertext, wrapped2.ciphertext);

      // Both should unwrap to the same UMK
      assert.deepEqual(keystore.unwrapUMK(wrapped1), umk);
      assert.deepEqual(keystore.unwrapUMK(wrapped2), umk);
    });
  });

  // --- Password Slot ---

  describe('password slot', () => {
    let keystore;

    beforeEach(() => {
      keystore = new Keystore({ devMode: true, devSeed: 'password-slot-tests' });
      keystore.initialize();
    });

    afterEach(() => {
      keystore.destroy();
    });

    it('should roundtrip createPasswordSlot/openPasswordSlot', async () => {
      let umk       = keystore.generateUMK();
      let password  = 'correct-horse-battery-staple';
      let slot      = await keystore.createPasswordSlot(umk, password);
      let recovered = await keystore.openPasswordSlot(slot, password);

      assert.deepEqual(recovered, umk);
    });

    it('should fail with wrong password', async () => {
      let umk  = keystore.generateUMK();
      let slot = await keystore.createPasswordSlot(umk, 'right-password');

      await assert.rejects(async () => {
        await keystore.openPasswordSlot(slot, 'wrong-password');
      });
    });

    it('should produce unique salts each time', async () => {
      let umk   = keystore.generateUMK();
      let slot1 = await keystore.createPasswordSlot(umk, 'password');
      let slot2 = await keystore.createPasswordSlot(umk, 'password');

      assert.notEqual(slot1.salt, slot2.salt, 'Salts should differ between slots');
    });

    it('should include ciphertext, iv, authTag, and salt in slot', async () => {
      let umk  = keystore.generateUMK();
      let slot = await keystore.createPasswordSlot(umk, 'password');

      assert.equal(typeof slot.ciphertext, 'string');
      assert.equal(typeof slot.iv, 'string');
      assert.equal(typeof slot.authTag, 'string');
      assert.equal(typeof slot.salt, 'string');

      // Salt is 32 bytes = 64 hex chars
      assert.equal(slot.salt.length, 64);
    });

    it('should derive consistent key from same password and salt', async () => {
      let salt    = crypto.randomBytes(32);
      let result1 = await keystore.derivePasswordSlotKey('my-password', salt);
      let result2 = await keystore.derivePasswordSlotKey('my-password', salt);

      assert.deepEqual(result1.key, result2.key);
      assert.equal(result1.salt, result2.salt);
    });

    it('should accept salt as hex string', async () => {
      let salt       = crypto.randomBytes(32);
      let saltHex    = salt.toString('hex');
      let fromBuffer = await keystore.derivePasswordSlotKey('password', salt);
      let fromHex    = await keystore.derivePasswordSlotKey('password', saltHex);

      assert.deepEqual(fromBuffer.key, fromHex.key);
    });

    it('should generate a random salt when none is provided', async () => {
      let result1 = await keystore.derivePasswordSlotKey('password');
      let result2 = await keystore.derivePasswordSlotKey('password');

      assert.notEqual(result1.salt, result2.salt, 'Auto-generated salts should differ');
    });
  });

  // --- Per-User Key Derivation ---

  describe('per-user key derivation', () => {
    let keystore;

    beforeEach(() => {
      keystore = new Keystore({ devMode: true, devSeed: 'user-key-tests' });
      keystore.initialize();
    });

    afterEach(() => {
      keystore.destroy();
    });

    it('should produce consistent results for the same UMK and userID', () => {
      let umk  = keystore.generateUMK();
      let key1 = keystore.deriveUserKey(umk, 'user-42');
      let key2 = keystore.deriveUserKey(umk, 'user-42');

      assert.deepEqual(key1, key2);
    });

    it('should produce different keys for different userIds', () => {
      let umk  = keystore.generateUMK();
      let key1 = keystore.deriveUserKey(umk, 'user-1');
      let key2 = keystore.deriveUserKey(umk, 'user-2');

      assert.notDeepEqual(key1, key2);
    });

    it('should produce different keys for different UMKs', () => {
      let umk1 = keystore.generateUMK();
      let umk2 = keystore.generateUMK();
      let key1 = keystore.deriveUserKey(umk1, 'same-user');
      let key2 = keystore.deriveUserKey(umk2, 'same-user');

      assert.notDeepEqual(key1, key2);
    });

    it('should return a 32-byte Buffer', () => {
      let umk = keystore.generateUMK();
      let key = keystore.deriveUserKey(umk, 'user-99');

      assert.ok(Buffer.isBuffer(key));
      assert.equal(key.length, 32);
    });
  });

  // --- Fingerprinting ---

  describe('fingerprinting', () => {
    let keystore;
    let userKey;

    beforeEach(() => {
      keystore = new Keystore({ devMode: true, devSeed: 'fingerprint-tests' });
      keystore.initialize();
      userKey = keystore.deriveUserKey(keystore.generateUMK(), 'user-fp');
    });

    afterEach(() => {
      keystore.destroy();
    });

    it('should produce consistent fingerprints for the same input and key', () => {
      let fingerprint1 = keystore.fingerprint('secret-data', userKey);
      let fingerprint2 = keystore.fingerprint('secret-data', userKey);

      assert.equal(fingerprint1, fingerprint2);
    });

    it('should produce different fingerprints for different input', () => {
      let fingerprint1 = keystore.fingerprint('data-a', userKey);
      let fingerprint2 = keystore.fingerprint('data-b', userKey);

      assert.notEqual(fingerprint1, fingerprint2);
    });

    it('should produce different fingerprints for different keys', () => {
      let otherKey     = keystore.deriveUserKey(keystore.generateUMK(), 'user-other');
      let fingerprint1 = keystore.fingerprint('same-data', userKey);
      let fingerprint2 = keystore.fingerprint('same-data', otherKey);

      assert.notEqual(fingerprint1, fingerprint2);
    });

    it('should return a hex string (64 chars for SHA-256)', () => {
      let result = keystore.fingerprint('test', userKey);

      assert.equal(typeof result, 'string');
      assert.equal(result.length, 64);
      assert.match(result, /^[0-9a-f]{64}$/);
    });

    it('should auto-serialize non-string data to JSON', () => {
      let objectData  = { action: 'read', resource: '/etc/passwd' };
      let fingerprint1 = keystore.fingerprint(objectData, userKey);
      let fingerprint2 = keystore.fingerprint(JSON.stringify(objectData), userKey);

      assert.equal(fingerprint1, fingerprint2);
    });

    it('should produce different fingerprints for different object structures', () => {
      let fingerprint1 = keystore.fingerprint({ a: 1 }, userKey);
      let fingerprint2 = keystore.fingerprint({ b: 1 }, userKey);

      assert.notEqual(fingerprint1, fingerprint2);
    });
  });
});
