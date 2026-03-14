'use strict';

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs     from 'node:fs';
import path   from 'node:path';
import os     from 'node:os';

import { Keystore } from '../../../src/core/crypto/keystore.mjs';

// =============================================================================
// SMK (Server Master Key) Tests
// =============================================================================

describe('Keystore SMK (Server Master Key)', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kikx-smk-test-'));
  });

  after(() => {
    // Clean up all temp dirs created during tests
    // (beforeEach creates new ones, so we just clean at the end)
  });

  function cleanup() {
    if (tempDir && fs.existsSync(tempDir))
      fs.rmSync(tempDir, { recursive: true, force: true });
  }

  // ---------------------------------------------------------------------------
  // First boot: generates server.key
  // ---------------------------------------------------------------------------

  it('should generate server.key on first boot', () => {
    let keystore = new Keystore();

    try {
      keystore.loadServerMasterKey(tempDir);

      let keyPath = path.join(tempDir, 'server.key');
      assert.ok(fs.existsSync(keyPath), 'server.key should exist');

      let hex = fs.readFileSync(keyPath, 'utf8').trim();
      assert.equal(hex.length, 64, 'Key file should contain 64 hex chars');
      assert.match(hex, /^[0-9a-f]{64}$/, 'Key file should be valid hex');
    } finally {
      keystore.destroy();
      cleanup();
    }
  });

  // ---------------------------------------------------------------------------
  // Second boot: loads same key
  // ---------------------------------------------------------------------------

  it('should load the same key on second boot', () => {
    let keystore1 = new Keystore();
    let keystore2 = new Keystore();

    try {
      keystore1.loadServerMasterKey(tempDir);
      keystore2.loadServerMasterKey(tempDir);

      // Both should have the same SMK
      assert.ok(keystore1._smk.equals(keystore2._smk), 'SMK should be identical on second load');
    } finally {
      keystore1.destroy();
      keystore2.destroy();
      cleanup();
    }
  });

  // ---------------------------------------------------------------------------
  // KIKX_SERVER_KEY_FILE env var overrides path
  // ---------------------------------------------------------------------------

  it('should use KIKX_SERVER_KEY_FILE env var when set', () => {
    let customPath = path.join(tempDir, 'custom', 'my-server.key');
    let originalEnv = process.env.KIKX_SERVER_KEY_FILE;

    try {
      process.env.KIKX_SERVER_KEY_FILE = customPath;

      let keystore = new Keystore();
      keystore.loadServerMasterKey(tempDir);

      assert.ok(fs.existsSync(customPath), 'Custom key file path should be used');
      assert.ok(!fs.existsSync(path.join(tempDir, 'server.key')), 'Default path should not exist');

      keystore.destroy();
    } finally {
      if (originalEnv === undefined)
        delete process.env.KIKX_SERVER_KEY_FILE;
      else
        process.env.KIKX_SERVER_KEY_FILE = originalEnv;

      cleanup();
    }
  });

  // ---------------------------------------------------------------------------
  // Empty file throws
  // ---------------------------------------------------------------------------

  it('should throw for an empty key file', () => {
    let keyPath = path.join(tempDir, 'server.key');
    fs.writeFileSync(keyPath, '');

    let keystore = new Keystore();

    try {
      assert.throws(
        () => keystore.loadServerMasterKey(tempDir),
        /empty/i,
      );
    } finally {
      keystore.destroy();
      cleanup();
    }
  });

  // ---------------------------------------------------------------------------
  // Non-hex content throws
  // ---------------------------------------------------------------------------

  it('should throw for non-hex content in key file', () => {
    let keyPath = path.join(tempDir, 'server.key');
    fs.writeFileSync(keyPath, 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz');

    let keystore = new Keystore();

    try {
      assert.throws(
        () => keystore.loadServerMasterKey(tempDir),
        /non-hex/i,
      );
    } finally {
      keystore.destroy();
      cleanup();
    }
  });

  // ---------------------------------------------------------------------------
  // Wrong length: too short
  // ---------------------------------------------------------------------------

  it('should throw for a key file that is too short', () => {
    let keyPath = path.join(tempDir, 'server.key');
    fs.writeFileSync(keyPath, 'aabbccdd');

    let keystore = new Keystore();

    try {
      assert.throws(
        () => keystore.loadServerMasterKey(tempDir),
        /64 hex characters/,
      );
    } finally {
      keystore.destroy();
      cleanup();
    }
  });

  // ---------------------------------------------------------------------------
  // Wrong length: too long
  // ---------------------------------------------------------------------------

  it('should throw for a key file that is too long', () => {
    let keyPath = path.join(tempDir, 'server.key');
    fs.writeFileSync(keyPath, 'a'.repeat(128));

    let keystore = new Keystore();

    try {
      assert.throws(
        () => keystore.loadServerMasterKey(tempDir),
        /64 hex characters/,
      );
    } finally {
      keystore.destroy();
      cleanup();
    }
  });

  // ---------------------------------------------------------------------------
  // Config dir doesn't exist: creates it
  // ---------------------------------------------------------------------------

  it('should create config directory if it does not exist', () => {
    let nestedDir = path.join(tempDir, 'deep', 'nested', 'config');

    let keystore = new Keystore();

    try {
      keystore.loadServerMasterKey(nestedDir);

      assert.ok(fs.existsSync(nestedDir), 'Config directory should be created');
      assert.ok(fs.existsSync(path.join(nestedDir, 'server.key')), 'Key file should be created');
    } finally {
      keystore.destroy();
      cleanup();
    }
  });

  // ---------------------------------------------------------------------------
  // Generated SMK is consistent (load twice -> same bytes)
  // ---------------------------------------------------------------------------

  it('should produce consistent SMK across multiple loads', () => {
    let keystore = new Keystore();

    try {
      keystore.loadServerMasterKey(tempDir);
      let firstSmk = Buffer.from(keystore._smk);

      // Re-create keystore and load again
      keystore.destroy();

      let keystore2 = new Keystore();
      keystore2.loadServerMasterKey(tempDir);

      assert.ok(firstSmk.equals(keystore2._smk), 'SMK should be identical across loads');

      keystore2.destroy();
    } finally {
      cleanup();
    }
  });

  // ---------------------------------------------------------------------------
  // Whitespace trimming
  // ---------------------------------------------------------------------------

  it('should trim whitespace from key file contents', () => {
    let keystore1 = new Keystore();

    try {
      keystore1.loadServerMasterKey(tempDir);
      let smk = Buffer.from(keystore1._smk);
      keystore1.destroy();

      // Add whitespace to the key file
      let keyPath = path.join(tempDir, 'server.key');
      let hex     = fs.readFileSync(keyPath, 'utf8');
      fs.writeFileSync(keyPath, '  ' + hex + '\n  ');

      let keystore2 = new Keystore();
      keystore2.loadServerMasterKey(tempDir);

      assert.ok(smk.equals(keystore2._smk), 'SMK should match despite whitespace');
      keystore2.destroy();
    } finally {
      cleanup();
    }
  });

  // ---------------------------------------------------------------------------
  // Destroy zeros SMK
  // ---------------------------------------------------------------------------

  it('should zero SMK on destroy', () => {
    let keystore = new Keystore();

    try {
      keystore.loadServerMasterKey(tempDir);

      let smkReference = keystore._smk;
      keystore.destroy();

      assert.equal(keystore._smk, null, 'SMK should be null after destroy');
      let allZeros = smkReference.every((byte) => byte === 0);
      assert.ok(allZeros, 'SMK buffer should be zeroed after destroy');
    } finally {
      cleanup();
    }
  });

  // ---------------------------------------------------------------------------
  // configDir required
  // ---------------------------------------------------------------------------

  it('should throw if configDir is not provided', () => {
    let keystore = new Keystore();

    assert.throws(
      () => keystore.loadServerMasterKey(null),
      /configDir is required/,
    );

    assert.throws(
      () => keystore.loadServerMasterKey(undefined),
      /configDir is required/,
    );
  });
});
