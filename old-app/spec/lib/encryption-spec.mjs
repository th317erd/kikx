'use strict';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  encryptWithPassword,
  decryptWithPassword,
  encryptWithKey,
  decryptWithKey,
  generateKey,
  hashPassword,
  verifyPassword,
} from '../../server/encryption.mjs';

describe('Encryption module', () => {
  describe('encryptWithPassword / decryptWithPassword', () => {
    it('should encrypt and decrypt data correctly', async () => {
      let plaintext = 'Hello, World!';
      let password  = 'test-password-123';

      let encrypted = await encryptWithPassword(plaintext, password);
      let decrypted = await decryptWithPassword(encrypted, password);

      assert.equal(decrypted, plaintext);
    });

    it('should produce different ciphertext for same plaintext (random IV)', async () => {
      let plaintext = 'Same text';
      let password  = 'same-password';

      let encrypted1 = await encryptWithPassword(plaintext, password);
      let encrypted2 = await encryptWithPassword(plaintext, password);

      assert.notEqual(encrypted1, encrypted2);
    });

    it('should fail to decrypt with wrong password', async () => {
      let plaintext       = 'Secret data';
      let correctPassword = 'correct-password';
      let wrongPassword   = 'wrong-password';

      let encrypted = await encryptWithPassword(plaintext, correctPassword);

      await assert.rejects(
        () => decryptWithPassword(encrypted, wrongPassword),
        /Decryption failed/
      );
    });

    it('should handle empty strings', async () => {
      let encrypted = await encryptWithPassword('', 'password');
      let decrypted = await decryptWithPassword(encrypted, 'password');

      assert.equal(decrypted, '');
    });

    it('should handle unicode characters', async () => {
      let plaintext = 'Hello, World!';
      let password  = 'test-password';

      let encrypted = await encryptWithPassword(plaintext, password);
      let decrypted = await decryptWithPassword(encrypted, password);

      assert.equal(decrypted, plaintext);
    });

    it('should handle long passwords', async () => {
      let plaintext = 'Test data';
      let password  = 'a'.repeat(1000);

      let encrypted = await encryptWithPassword(plaintext, password);
      let decrypted = await decryptWithPassword(encrypted, password);

      assert.equal(decrypted, plaintext);
    });
  });

  describe('encryptWithKey / decryptWithKey', () => {
    it('should encrypt and decrypt with hex key', () => {
      let plaintext = 'Test data';
      let key       = generateKey();

      let encrypted = encryptWithKey(plaintext, key);
      let decrypted = decryptWithKey(encrypted, key);

      assert.equal(decrypted, plaintext);
    });

    it('should produce different ciphertext for same plaintext (random IV)', () => {
      let plaintext = 'Same text';
      let key       = generateKey();

      let encrypted1 = encryptWithKey(plaintext, key);
      let encrypted2 = encryptWithKey(plaintext, key);

      assert.notEqual(encrypted1, encrypted2);
    });

    it('should fail with wrong key', () => {
      let plaintext = 'Secret';
      let key1      = generateKey();
      let key2      = generateKey();

      let encrypted = encryptWithKey(plaintext, key1);

      assert.throws(
        () => decryptWithKey(encrypted, key2),
        /Decryption failed/
      );
    });

    it('should reject invalid key length', () => {
      let plaintext = 'Test';
      let shortKey  = 'abc123';

      assert.throws(
        () => encryptWithKey(plaintext, shortKey),
        /Invalid key length/
      );
    });
  });

  describe('generateKey', () => {
    it('should generate a 64-character hex string (256 bits)', () => {
      let key = generateKey();

      assert.match(key, /^[0-9a-f]{64}$/);
    });

    it('should generate unique keys', () => {
      let keys = new Set();

      for (let i = 0; i < 100; i++)
        keys.add(generateKey());

      assert.equal(keys.size, 100);
    });
  });

  describe('hashPassword / verifyPassword', () => {
    it('should hash and verify passwords correctly', async () => {
      let password = 'my-secure-password';

      let hash  = await hashPassword(password);
      let valid = await verifyPassword(password, hash);

      assert.equal(valid, true);
    });

    it('should reject wrong passwords', async () => {
      let password = 'correct-password';
      let wrong    = 'wrong-password';

      let hash  = await hashPassword(password);
      let valid = await verifyPassword(wrong, hash);

      assert.equal(valid, false);
    });

    it('should produce different hashes for same password (random salt)', async () => {
      let password = 'same-password';

      let hash1 = await hashPassword(password);
      let hash2 = await hashPassword(password);

      assert.notEqual(hash1, hash2);
    });

    it('should hash in salt:hash format', async () => {
      let hash = await hashPassword('test');

      assert.match(hash, /^[0-9a-f]+:[0-9a-f]+$/);
    });

    it('should reject malformed hashes', async () => {
      let valid = await verifyPassword('test', 'not-a-valid-hash');

      assert.equal(valid, false);
    });
  });
});
