'use strict';

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs     from 'node:fs';
import os     from 'node:os';
import path   from 'node:path';

import { createKikxCore }  from '../../../src/core/index.mjs';
import { USER_DEFAULTS }   from '../../../src/core/models/user-model.mjs';
import { Keystore }        from '../../../src/core/crypto/keystore.mjs';

// =============================================================================
// User Settings Tests
// =============================================================================
// Verifies the User model's settings methods: getSettings, updateSettings,
// and getVerifiedSettings, backed by ValueStore with Ed25519 signing.
// =============================================================================

describe('User Settings', () => {
  let core;
  let models;
  let keystore;
  let tempDir;
  let organization;
  let user;
  let publicKey;
  let privateKey;

  before(async () => {
    core = createKikxCore();
    await core.start();
    models = core.getModels();

    tempDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'kikx-user-settings-'));
    keystore = new Keystore();
    keystore.initialize();
    keystore.loadServerMasterKey(tempDir);
  });

  after(async () => {
    if (keystore)
      keystore.destroy();

    if (core && core.isStarted())
      await core.stop();

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    organization = await models.Organization.create({ name: 'Settings Test Org' });

    // Generate a key pair for the user
    let keys = keystore.generateSigningKeyPair();
    publicKey  = keys.publicKey;
    privateKey = keys.privateKey;

    user = await models.User.create({
      organizationID: organization.id,
      email:          `test-${Date.now()}@example.com`,
      publicKey,
    });
  });

  // ---------------------------------------------------------------------------
  // getSettings() — happy path
  // ---------------------------------------------------------------------------

  describe('getSettings()', () => {
    it('returns USER_DEFAULTS when no settings exist', async () => {
      let settings = await user.getSettings();
      assert.deepEqual(settings, USER_DEFAULTS);
      assert.equal(settings.riskLevel, 'normal');
    });

    it('returns stored settings merged with defaults', async () => {
      await user.updateSettings({ riskLevel: 'strict' }, keystore, privateKey);

      let settings = await user.getSettings();
      assert.equal(settings.riskLevel, 'strict');
    });

    it('stored values override defaults', async () => {
      await user.updateSettings({ riskLevel: 'permissive' }, keystore, privateKey);

      let settings = await user.getSettings();
      assert.equal(settings.riskLevel, 'permissive');
      assert.notEqual(settings.riskLevel, USER_DEFAULTS.riskLevel);
    });

    it('handles multiple keys', async () => {
      await user.updateSettings({
        riskLevel: 'strict',
        theme:     'dark',
        language:  'en',
      }, keystore, privateKey);

      let settings = await user.getSettings();
      assert.equal(settings.riskLevel, 'strict');
      assert.equal(settings.theme, 'dark');
      assert.equal(settings.language, 'en');
    });

    it('handles corrupted JSON gracefully (skips bad entries)', async () => {
      // Insert a corrupted entry directly into ValueStore
      await models.ValueStore.create({
        organizationID: organization.id,
        ownerType:      'User',
        ownerID:        user.id,
        namespace:      'config',
        scopeID:        '',
        key:            'badEntry',
        value:          '{not valid json!!!',
      });

      // Also insert a good entry
      await user.updateSettings({ riskLevel: 'strict' }, keystore, privateKey);

      let settings = await user.getSettings();
      // Should have the good entry, skip the bad one
      assert.equal(settings.riskLevel, 'strict');
      assert.equal(settings.badEntry, undefined);
    });
  });

  // ---------------------------------------------------------------------------
  // updateSettings() — happy path
  // ---------------------------------------------------------------------------

  describe('updateSettings()', () => {
    it('stores a non-sensitive key without signature', async () => {
      await user.updateSettings({ theme: 'dark' }, keystore, privateKey);

      let entry = await models.ValueStore
        .where.ownerType.EQ('User')
        .ownerID.EQ(user.id)
        .namespace.EQ('config')
        .key.EQ('theme')
        .first();

      assert.ok(entry, 'entry should exist');
      assert.equal(JSON.parse(entry.value), 'dark');
      assert.ok(entry.signature == null, 'non-sensitive key should have no signature');
    });

    it('stores riskLevel with Ed25519 signature', async () => {
      await user.updateSettings({ riskLevel: 'strict' }, keystore, privateKey);

      let entry = await models.ValueStore
        .where.ownerType.EQ('User')
        .ownerID.EQ(user.id)
        .namespace.EQ('config')
        .key.EQ('riskLevel')
        .first();

      assert.ok(entry, 'entry should exist');
      assert.equal(JSON.parse(entry.value), 'strict');
      assert.ok(entry.signature, 'riskLevel should have a signature');
      assert.equal(typeof entry.signature, 'string');
      assert.ok(entry.signature.length > 0, 'signature should be non-empty');

      // Verify the signature is valid
      let valid = keystore.verifyWithPublicKey(entry.value, publicKey, entry.signature);
      assert.ok(valid, 'signature should verify with the user public key');
    });

    it('updates existing setting (upsert)', async () => {
      await user.updateSettings({ riskLevel: 'strict' }, keystore, privateKey);
      await user.updateSettings({ riskLevel: 'permissive' }, keystore, privateKey);

      let settings = await user.getSettings();
      assert.equal(settings.riskLevel, 'permissive');

      // Verify only one entry exists for riskLevel
      let entries = await models.ValueStore
        .where.ownerType.EQ('User')
        .ownerID.EQ(user.id)
        .namespace.EQ('config')
        .key.EQ('riskLevel')
        .all();

      assert.equal(entries.length, 1, 'should have exactly one entry after upsert');
    });

    it('deletes setting when value is null', async () => {
      await user.updateSettings({ theme: 'dark' }, keystore, privateKey);

      let settings = await user.getSettings();
      assert.equal(settings.theme, 'dark');

      await user.updateSettings({ theme: null }, keystore, privateKey);

      settings = await user.getSettings();
      assert.equal(settings.theme, undefined);
    });

    it('deletes setting when value is undefined', async () => {
      await user.updateSettings({ theme: 'light' }, keystore, privateKey);

      let settings = await user.getSettings();
      assert.equal(settings.theme, 'light');

      await user.updateSettings({ theme: undefined }, keystore, privateKey);

      settings = await user.getSettings();
      assert.equal(settings.theme, undefined);
    });

    it('stores multiple keys at once', async () => {
      await user.updateSettings({
        riskLevel: 'strict',
        theme:     'dark',
        timezone:  'UTC',
      }, keystore, privateKey);

      let settings = await user.getSettings();
      assert.equal(settings.riskLevel, 'strict');
      assert.equal(settings.theme, 'dark');
      assert.equal(settings.timezone, 'UTC');
    });
  });

  // ---------------------------------------------------------------------------
  // getVerifiedSettings() — happy path
  // ---------------------------------------------------------------------------

  describe('getVerifiedSettings()', () => {
    it('returns settings when riskLevel signature is valid', async () => {
      await user.updateSettings({ riskLevel: 'strict' }, keystore, privateKey);

      let settings = await user.getVerifiedSettings(keystore, publicKey);
      assert.ok(settings, 'should return settings when signature is valid');
      assert.equal(settings.riskLevel, 'strict');
    });

    it('returns settings with defaults when no settings exist', async () => {
      let settings = await user.getVerifiedSettings(keystore, publicKey);
      assert.ok(settings, 'should return settings even with no stored entries');
      assert.deepEqual(settings, USER_DEFAULTS);
    });

    it('returns settings for non-sensitive keys without checking signature', async () => {
      await user.updateSettings({ theme: 'dark' }, keystore, privateKey);

      let settings = await user.getVerifiedSettings(keystore, publicKey);
      assert.ok(settings, 'should return settings');
      assert.equal(settings.theme, 'dark');
    });
  });

  // ---------------------------------------------------------------------------
  // getVerifiedSettings() — failure paths
  // ---------------------------------------------------------------------------

  describe('getVerifiedSettings() — failure paths', () => {
    it('returns null when riskLevel value is tampered', async () => {
      await user.updateSettings({ riskLevel: 'strict' }, keystore, privateKey);

      // Tamper with the value in the DB
      let entry = await models.ValueStore
        .where.ownerType.EQ('User')
        .ownerID.EQ(user.id)
        .namespace.EQ('config')
        .key.EQ('riskLevel')
        .first();

      entry.value = JSON.stringify('permissive');
      await entry.save();

      let settings = await user.getVerifiedSettings(keystore, publicKey);
      assert.equal(settings, null, 'should return null when value is tampered');
    });

    it('returns null when riskLevel signature is tampered', async () => {
      await user.updateSettings({ riskLevel: 'strict' }, keystore, privateKey);

      // Tamper with the signature in the DB
      let entry = await models.ValueStore
        .where.ownerType.EQ('User')
        .ownerID.EQ(user.id)
        .namespace.EQ('config')
        .key.EQ('riskLevel')
        .first();

      entry.signature = 'deadbeef'.repeat(16);
      await entry.save();

      let settings = await user.getVerifiedSettings(keystore, publicKey);
      assert.equal(settings, null, 'should return null when signature is tampered');
    });

    it('returns null when verified with wrong public key', async () => {
      await user.updateSettings({ riskLevel: 'strict' }, keystore, privateKey);

      // Generate a different key pair
      let otherKeys = keystore.generateSigningKeyPair();

      let settings = await user.getVerifiedSettings(keystore, otherKeys.publicKey);
      assert.equal(settings, null, 'should return null when verified with wrong public key');
    });

    it('returns null when signature is missing for a SIGNED_KEY', async () => {
      // Insert a riskLevel entry directly without a signature
      await models.ValueStore.create({
        organizationID: organization.id,
        ownerType:      'User',
        ownerID:        user.id,
        namespace:      'config',
        scopeID:        '',
        key:            'riskLevel',
        value:          JSON.stringify('strict'),
        signature:      null,
      });

      let settings = await user.getVerifiedSettings(keystore, publicKey);
      assert.equal(settings, null, 'should return null when signature is missing for signed key');
    });
  });

  // ---------------------------------------------------------------------------
  // Validation
  // ---------------------------------------------------------------------------

  describe('Validation', () => {
    it('updateSettings rejects invalid riskLevel values', async () => {
      await assert.rejects(
        () => user.updateSettings({ riskLevel: 'yolo' }, keystore, privateKey),
        (error) => {
          assert.ok(error.message.includes('Invalid riskLevel'));
          assert.ok(error.message.includes('yolo'));
          return true;
        },
      );
    });

    it('updateSettings requires privateKeyPEM when setting riskLevel', async () => {
      await assert.rejects(
        () => user.updateSettings({ riskLevel: 'strict' }, keystore, null),
        (error) => {
          assert.ok(error.message.includes('privateKeyPEM is required'));
          return true;
        },
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Round trip
  // ---------------------------------------------------------------------------

  describe('Round trip', () => {
    it('updateSettings + getVerifiedSettings round trip works', async () => {
      await user.updateSettings({
        riskLevel: 'permissive',
        theme:     'dark',
        language:  'fr',
      }, keystore, privateKey);

      let settings = await user.getVerifiedSettings(keystore, publicKey);
      assert.ok(settings, 'verified settings should not be null');
      assert.equal(settings.riskLevel, 'permissive');
      assert.equal(settings.theme, 'dark');
      assert.equal(settings.language, 'fr');
    });
  });
});
