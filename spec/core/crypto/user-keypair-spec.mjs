'use strict';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs     from 'node:fs';
import path   from 'node:path';
import os     from 'node:os';

import { KikxCore }    from '../../../src/core/kikx-core.mjs';
import { Keystore }    from '../../../src/core/crypto/keystore.mjs';
import { AuthService } from '../../../src/server/auth/index.mjs';

// =============================================================================
// User Key Pair Tests
// =============================================================================
// Verifies that:
//   - User model has publicKey and encryptedPrivateKey fields
//   - AuthService.register() generates a key pair for new users
//   - The public key is valid PEM
//   - The encrypted private key can be decrypted with UMK
//   - Decrypted private key can sign data that public key can verify
//   - Two different users get different key pairs
//   - Key pair fields are null when user is created directly (without register)
// =============================================================================

describe('User key pair generation', () => {
  let core;
  let keystore;
  let authService;
  let tempDir;

  before(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kikx-user-keypair-test-'));

    core = new KikxCore({ database: { filename: ':memory:' } });
    await core.start();

    keystore = new Keystore({ devMode: true, devSeed: 'user-keypair-test-seed' });
    keystore.initialize();
    keystore.loadServerMasterKey(tempDir);

    let context = core.getContext();
    context.setProperty('keystore', keystore);

    authService = new AuthService({ context, keystore });
  });

  after(async () => {
    keystore.destroy();
    await core.stop();

    if (tempDir && fs.existsSync(tempDir))
      fs.rmSync(tempDir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // Model field existence
  // ---------------------------------------------------------------------------

  describe('User model fields', () => {
    it('User model version is 2', () => {
      let { User } = core.getModels();
      assert.equal(User.version, 2);
    });

    it('User model has publicKey field defined', () => {
      let { User } = core.getModels();
      assert.ok(User.fields.publicKey, 'publicKey field should exist');
      assert.equal(User.fields.publicKey.allowNull, true);
    });

    it('User model has encryptedPrivateKey field defined', () => {
      let { User } = core.getModels();
      assert.ok(User.fields.encryptedPrivateKey, 'encryptedPrivateKey field should exist');
      assert.equal(User.fields.encryptedPrivateKey.allowNull, true);
    });

    it('publicKey and encryptedPrivateKey are null when user is created directly', async () => {
      let { Organization, User } = core.getModels();
      let organization = await Organization.create({ name: 'Direct Create Org' });
      let user = await User.create({
        organizationID: organization.id,
        email:          'direct@example.com',
      });

      assert.equal(user.publicKey == null, true, 'publicKey should be null/undefined');
      assert.equal(user.encryptedPrivateKey == null, true, 'encryptedPrivateKey should be null/undefined');
    });
  });

  // ---------------------------------------------------------------------------
  // Registration key pair generation
  // ---------------------------------------------------------------------------

  describe('AuthService.register() key pair generation', () => {
    it('should set publicKey on registered user', async () => {
      let result = await authService.register('keypair1@example.com', 'securepass123');

      assert.ok(result.user.publicKey, 'publicKey should be set after registration');
      assert.equal(typeof result.user.publicKey, 'string');
    });

    it('should set encryptedPrivateKey on registered user', async () => {
      let result = await authService.register('keypair2@example.com', 'securepass123');

      assert.ok(result.user.encryptedPrivateKey, 'encryptedPrivateKey should be set after registration');
      assert.equal(typeof result.user.encryptedPrivateKey, 'string');
    });

    it('publicKey should be a valid PEM public key string', async () => {
      let result = await authService.register('keypair3@example.com', 'securepass123');

      assert.ok(result.user.publicKey.startsWith('-----BEGIN PUBLIC KEY-----'));
      assert.ok(result.user.publicKey.trimEnd().endsWith('-----END PUBLIC KEY-----'));
    });

    it('encryptedPrivateKey should be a valid JSON envelope', async () => {
      let result   = await authService.register('keypair4@example.com', 'securepass123');
      let envelope = JSON.parse(result.user.encryptedPrivateKey);

      assert.equal(typeof envelope.ciphertext, 'string');
      assert.equal(typeof envelope.iv, 'string');
      assert.equal(typeof envelope.authTag, 'string');
      assert.match(envelope.ciphertext, /^[0-9a-f]+$/);
      assert.match(envelope.iv, /^[0-9a-f]+$/);
      assert.match(envelope.authTag, /^[0-9a-f]+$/);
    });

    it('encrypted private key can be decrypted with UMK and user ID', async () => {
      let result  = await authService.register('keypair5@example.com', 'securepass123');
      let decoded = authService.verifyToken(result.token);
      let umk     = authService.getUMK(decoded);

      let envelope  = JSON.parse(result.user.encryptedPrivateKey);
      let decrypted = keystore.decryptUserPrivateKey(envelope, umk, result.user.id);

      assert.ok(decrypted.startsWith('-----BEGIN PRIVATE KEY-----'));
      assert.ok(decrypted.trimEnd().endsWith('-----END PRIVATE KEY-----'));
    });

    it('decrypted private key + public key can sign and verify data', async () => {
      let result  = await authService.register('keypair6@example.com', 'securepass123');
      let decoded = authService.verifyToken(result.token);
      let umk     = authService.getUMK(decoded);

      let envelope   = JSON.parse(result.user.encryptedPrivateKey);
      let privateKey = keystore.decryptUserPrivateKey(envelope, umk, result.user.id);
      let publicKey  = result.user.publicKey;

      let data      = 'test message to sign';
      let signature = keystore.signWithPrivateKey(data, privateKey);
      let verified  = keystore.verifyWithPublicKey(data, publicKey, signature);

      assert.equal(verified, true);
    });

    it('signature verification fails with tampered data', async () => {
      let result  = await authService.register('keypair7@example.com', 'securepass123');
      let decoded = authService.verifyToken(result.token);
      let umk     = authService.getUMK(decoded);

      let envelope   = JSON.parse(result.user.encryptedPrivateKey);
      let privateKey = keystore.decryptUserPrivateKey(envelope, umk, result.user.id);
      let publicKey  = result.user.publicKey;

      let signature = keystore.signWithPrivateKey('original data', privateKey);
      let verified  = keystore.verifyWithPublicKey('tampered data', publicKey, signature);

      assert.equal(verified, false);
    });

    it('two different users get different key pairs', async () => {
      let result1 = await authService.register('keypair-diff1@example.com', 'securepass123');
      let result2 = await authService.register('keypair-diff2@example.com', 'securepass123');

      assert.notEqual(result1.user.publicKey, result2.user.publicKey);
      assert.notEqual(result1.user.encryptedPrivateKey, result2.user.encryptedPrivateKey);
    });

    it('key pair persists to database and can be fetched', async () => {
      let result = await authService.register('keypair8@example.com', 'securepass123');

      let { User } = core.getModels();
      let fetched  = await User.where.id.EQ(result.user.id).first();

      assert.equal(fetched.publicKey, result.user.publicKey);
      assert.equal(fetched.encryptedPrivateKey, result.user.encryptedPrivateKey);
    });

    it('cannot decrypt private key with wrong UMK', async () => {
      let result   = await authService.register('keypair9@example.com', 'securepass123');
      let wrongUMK = keystore.generateUMK();
      let envelope = JSON.parse(result.user.encryptedPrivateKey);

      assert.throws(
        () => keystore.decryptUserPrivateKey(envelope, wrongUMK, result.user.id),
        /Unsupported state|error/i,
      );
    });

    it('cannot decrypt private key with wrong user ID', async () => {
      let result  = await authService.register('keypair10@example.com', 'securepass123');
      let decoded = authService.verifyToken(result.token);
      let umk     = authService.getUMK(decoded);

      let envelope = JSON.parse(result.user.encryptedPrivateKey);

      assert.throws(
        () => keystore.decryptUserPrivateKey(envelope, umk, 'usr_wrong_id'),
        /Unsupported state|error/i,
      );
    });

    it('key pair from login matches key pair from registration', async () => {
      let regResult   = await authService.register('keypair-login@example.com', 'securepass123');
      let loginResult = await authService.login('keypair-login@example.com', 'securepass123');

      // The user record should have the same key pair
      let { User } = core.getModels();
      let user     = await User.where.id.EQ(regResult.user.id).first();

      assert.equal(user.publicKey, regResult.user.publicKey);
      assert.equal(user.encryptedPrivateKey, regResult.user.encryptedPrivateKey);

      // And the UMK from login should decrypt it correctly
      let loginDecoded = authService.verifyToken(loginResult.token);
      let loginUMK     = authService.getUMK(loginDecoded);
      let envelope     = JSON.parse(user.encryptedPrivateKey);
      let privateKey   = keystore.decryptUserPrivateKey(envelope, loginUMK, user.id);

      assert.ok(privateKey.startsWith('-----BEGIN PRIVATE KEY-----'));
    });
  });
});
