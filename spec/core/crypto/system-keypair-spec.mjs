'use strict';

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs     from 'node:fs';
import path   from 'node:path';
import os     from 'node:os';

import { Keystore } from '../../../src/core/crypto/keystore.mjs';

// =============================================================================
// System Key Pair Tests
// =============================================================================

describe('Keystore system key pair', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kikx-syskp-test-'));
  });

  function cleanup() {
    if (tempDir && fs.existsSync(tempDir))
      fs.rmSync(tempDir, { recursive: true, force: true });
  }

  function makeKeystoreWithSmk(dir) {
    let keystore = new Keystore();
    keystore.initialize();
    keystore.loadServerMasterKey(dir || tempDir);

    return keystore;
  }

  // ---------------------------------------------------------------------------
  // First boot: generates .pub and .key.enc files
  // ---------------------------------------------------------------------------

  it('should generate system-signing.pub and system-signing.key.enc on first boot', () => {
    let keystore = makeKeystoreWithSmk();

    try {
      keystore.loadSystemKeyPair(tempDir);

      let pubPath = path.join(tempDir, 'system-signing.pub');
      let encPath = path.join(tempDir, 'system-signing.key.enc');

      assert.ok(fs.existsSync(pubPath), 'system-signing.pub should exist');
      assert.ok(fs.existsSync(encPath), 'system-signing.key.enc should exist');

      // Public key should be PEM
      let pubContent = fs.readFileSync(pubPath, 'utf8');
      assert.ok(pubContent.startsWith('-----BEGIN PUBLIC KEY-----'), 'Public key file should contain PEM');

      // Encrypted key should be valid JSON envelope
      let encContent = JSON.parse(fs.readFileSync(encPath, 'utf8'));
      assert.equal(typeof encContent.ciphertext, 'string');
      assert.equal(typeof encContent.iv, 'string');
      assert.equal(typeof encContent.authTag, 'string');
    } finally {
      keystore.destroy();
      cleanup();
    }
  });

  // ---------------------------------------------------------------------------
  // Second boot: loads existing files
  // ---------------------------------------------------------------------------

  it('should load existing key pair on second boot', () => {
    let keystore1 = makeKeystoreWithSmk();

    try {
      keystore1.loadSystemKeyPair(tempDir);
      let publicKey1  = keystore1.getSystemPublicKey();
      let privateKey1 = keystore1._systemPrivateKey;
      keystore1.destroy();

      // Second load with same SMK
      let keystore2 = makeKeystoreWithSmk();
      keystore2.loadSystemKeyPair(tempDir);

      assert.equal(keystore2.getSystemPublicKey(), publicKey1, 'Public key should match');
      assert.equal(keystore2._systemPrivateKey, privateKey1, 'Private key should match');

      keystore2.destroy();
    } finally {
      cleanup();
    }
  });

  // ---------------------------------------------------------------------------
  // systemSign -> systemVerify round trip
  // ---------------------------------------------------------------------------

  it('should round-trip systemSign and systemVerify', () => {
    let keystore = makeKeystoreWithSmk();

    try {
      keystore.loadSystemKeyPair(tempDir);

      let data      = { action: 'approve', resource: 'tool:shell' };
      let signature = keystore.systemSign(data);

      assert.equal(keystore.systemVerify(data, signature), true);
    } finally {
      keystore.destroy();
      cleanup();
    }
  });

  // ---------------------------------------------------------------------------
  // getSystemPublicKey returns PEM
  // ---------------------------------------------------------------------------

  it('should return PEM from getSystemPublicKey', () => {
    let keystore = makeKeystoreWithSmk();

    try {
      keystore.loadSystemKeyPair(tempDir);
      let publicKey = keystore.getSystemPublicKey();

      assert.equal(typeof publicKey, 'string');
      assert.ok(publicKey.startsWith('-----BEGIN PUBLIC KEY-----'));
    } finally {
      keystore.destroy();
      cleanup();
    }
  });

  // ---------------------------------------------------------------------------
  // systemSign with different data -> different signatures
  // ---------------------------------------------------------------------------

  it('should produce different signatures for different data', () => {
    let keystore = makeKeystoreWithSmk();

    try {
      keystore.loadSystemKeyPair(tempDir);

      let sig1 = keystore.systemSign('data-alpha');
      let sig2 = keystore.systemSign('data-beta');

      assert.notEqual(sig1, sig2);
    } finally {
      keystore.destroy();
      cleanup();
    }
  });

  // ---------------------------------------------------------------------------
  // systemVerify with wrong signature -> false
  // ---------------------------------------------------------------------------

  it('should return false for wrong signature', () => {
    let keystore = makeKeystoreWithSmk();

    try {
      keystore.loadSystemKeyPair(tempDir);

      let signature = keystore.systemSign('correct data');
      let tampered  = signature.slice(0, -2) + ((signature.endsWith('00')) ? '01' : '00');

      assert.equal(keystore.systemVerify('correct data', tampered), false);
    } finally {
      keystore.destroy();
      cleanup();
    }
  });

  // ---------------------------------------------------------------------------
  // SMK not loaded -> throw from loadSystemKeyPair
  // ---------------------------------------------------------------------------

  it('should throw if SMK is not loaded when loading system key pair', () => {
    let keystore = new Keystore();
    keystore.initialize();

    try {
      assert.throws(
        () => keystore.loadSystemKeyPair(tempDir),
        /Server Master Key must be loaded/,
      );
    } finally {
      keystore.destroy();
      cleanup();
    }
  });

  // ---------------------------------------------------------------------------
  // Both files deleted -> regenerates on load
  // ---------------------------------------------------------------------------

  it('should regenerate key pair if both files are deleted', () => {
    let keystore1 = makeKeystoreWithSmk();

    try {
      keystore1.loadSystemKeyPair(tempDir);
      let originalPublicKey = keystore1.getSystemPublicKey();
      keystore1.destroy();

      // Delete both files
      fs.unlinkSync(path.join(tempDir, 'system-signing.pub'));
      fs.unlinkSync(path.join(tempDir, 'system-signing.key.enc'));

      let keystore2 = makeKeystoreWithSmk();
      keystore2.loadSystemKeyPair(tempDir);

      // Should have generated a new key pair
      assert.notEqual(keystore2.getSystemPublicKey(), originalPublicKey, 'New key pair should differ');

      // But it should still work
      let signature = keystore2.systemSign('test');
      assert.equal(keystore2.systemVerify('test', signature), true);

      keystore2.destroy();
    } finally {
      cleanup();
    }
  });

  // ---------------------------------------------------------------------------
  // systemSign throws if system key pair not loaded
  // ---------------------------------------------------------------------------

  it('should throw from systemSign if system key pair is not loaded', () => {
    let keystore = makeKeystoreWithSmk();

    try {
      assert.throws(
        () => keystore.systemSign('data'),
        /System key pair not loaded/,
      );
    } finally {
      keystore.destroy();
      cleanup();
    }
  });

  // ---------------------------------------------------------------------------
  // destroy nulls out system keys
  // ---------------------------------------------------------------------------

  it('should null out system keys on destroy', () => {
    let keystore = makeKeystoreWithSmk();

    try {
      keystore.loadSystemKeyPair(tempDir);

      assert.ok(keystore._systemPublicKey !== null);
      assert.ok(keystore._systemPrivateKey !== null);

      keystore.destroy();

      assert.equal(keystore._systemPublicKey, null);
      assert.equal(keystore._systemPrivateKey, null);
    } finally {
      cleanup();
    }
  });
});
