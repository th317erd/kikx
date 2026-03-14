'use strict';

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs     from 'node:fs';
import path   from 'node:path';
import os     from 'node:os';

import { KikxCore }  from '../../../src/core/kikx-core.mjs';
import { Keystore }  from '../../../src/core/crypto/keystore.mjs';

// =============================================================================
// Agent Key Pair Tests
// =============================================================================
// Verifies that:
//   - Agent model has publicKey and encryptedPrivateKey fields
//   - Agent's publicKey is valid PEM
//   - Agent's encryptedPrivateKey can be decrypted with SMK-derived key
//   - Decrypted private key + public key can sign and verify
//   - Two different agents get different key pairs
//   - Agent key pair fields are null by default (before controller sets them)
// =============================================================================

describe('Agent key pair generation', () => {
  let core;
  let keystore;
  let tempDir;
  let models;
  let organization;

  before(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kikx-agent-keypair-test-'));

    core = new KikxCore({ database: { filename: ':memory:' } });
    await core.start();

    keystore = new Keystore({ devMode: true, devSeed: 'agent-keypair-test-seed' });
    keystore.initialize();
    keystore.loadServerMasterKey(tempDir);

    models = core.getModels();
  });

  after(async () => {
    keystore.destroy();
    await core.stop();

    if (tempDir && fs.existsSync(tempDir))
      fs.rmSync(tempDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    organization = await models.Organization.create({ name: 'Agent Keypair Test Org' });
  });

  async function createAgent(name, extras = {}) {
    return models.Agent.create({
      organizationID: organization.id,
      name:           name,
      pluginID:       'mock-agent',
      ...extras,
    });
  }

  // ---------------------------------------------------------------------------
  // Model field existence
  // ---------------------------------------------------------------------------

  describe('Agent model fields', () => {
    it('Agent model version is 3', () => {
      let { Agent } = models;
      assert.equal(Agent.version, 3);
    });

    it('Agent model has publicKey field defined', () => {
      let { Agent } = models;
      assert.ok(Agent.fields.publicKey, 'publicKey field should exist');
      assert.equal(Agent.fields.publicKey.allowNull, true);
    });

    it('Agent model has encryptedPrivateKey field defined', () => {
      let { Agent } = models;
      assert.ok(Agent.fields.encryptedPrivateKey, 'encryptedPrivateKey field should exist');
      assert.equal(Agent.fields.encryptedPrivateKey.allowNull, true);
    });

    it('publicKey and encryptedPrivateKey are null when agent is created directly', async () => {
      let agent = await createAgent('test-direct-create');

      assert.equal(agent.publicKey == null, true, 'publicKey should be null/undefined');
      assert.equal(agent.encryptedPrivateKey == null, true, 'encryptedPrivateKey should be null/undefined');
    });
  });

  // ---------------------------------------------------------------------------
  // Key pair generation and encryption (simulating controller logic)
  // ---------------------------------------------------------------------------

  describe('Agent key pair with keystore', () => {
    it('generates a valid PEM public key', () => {
      let { publicKey } = keystore.generateSigningKeyPair();

      assert.ok(publicKey.startsWith('-----BEGIN PUBLIC KEY-----'));
      assert.ok(publicKey.trimEnd().endsWith('-----END PUBLIC KEY-----'));
    });

    it('encrypts agent private key with SMK-derived key and can decrypt', async () => {
      let agent = await createAgent('test-encrypt-decrypt');
      let { publicKey, privateKey } = keystore.generateSigningKeyPair();

      let encrypted = keystore.encryptActorPrivateKey(privateKey, agent.id);
      let decrypted = keystore.decryptActorPrivateKey(encrypted, agent.id);

      assert.equal(decrypted, privateKey);
    });

    it('encrypted private key is a valid envelope object', async () => {
      let agent = await createAgent('test-envelope');
      let { privateKey } = keystore.generateSigningKeyPair();

      let encrypted = keystore.encryptActorPrivateKey(privateKey, agent.id);

      assert.equal(typeof encrypted.ciphertext, 'string');
      assert.equal(typeof encrypted.iv, 'string');
      assert.equal(typeof encrypted.authTag, 'string');
      assert.match(encrypted.ciphertext, /^[0-9a-f]+$/);
      assert.match(encrypted.iv, /^[0-9a-f]+$/);
      assert.match(encrypted.authTag, /^[0-9a-f]+$/);
    });

    it('decrypted private key + public key can sign and verify data', async () => {
      let agent = await createAgent('test-sign-verify');
      let { publicKey, privateKey } = keystore.generateSigningKeyPair();

      let encrypted    = keystore.encryptActorPrivateKey(privateKey, agent.id);
      let decryptedKey = keystore.decryptActorPrivateKey(encrypted, agent.id);

      let data      = 'agent signed message';
      let signature = keystore.signWithPrivateKey(data, decryptedKey);
      let verified  = keystore.verifyWithPublicKey(data, publicKey, signature);

      assert.equal(verified, true);
    });

    it('signature verification fails with tampered data', async () => {
      let agent = await createAgent('test-tamper-verify');
      let { publicKey, privateKey } = keystore.generateSigningKeyPair();

      let encrypted    = keystore.encryptActorPrivateKey(privateKey, agent.id);
      let decryptedKey = keystore.decryptActorPrivateKey(encrypted, agent.id);

      let signature = keystore.signWithPrivateKey('original data', decryptedKey);
      let verified  = keystore.verifyWithPublicKey('tampered data', publicKey, signature);

      assert.equal(verified, false);
    });

    it('two different agents get different key pairs', async () => {
      let pair1 = keystore.generateSigningKeyPair();
      let pair2 = keystore.generateSigningKeyPair();

      assert.notEqual(pair1.publicKey, pair2.publicKey);
      assert.notEqual(pair1.privateKey, pair2.privateKey);
    });

    it('cannot decrypt agent private key with wrong agent ID', async () => {
      let agent = await createAgent('test-wrong-id');
      let { privateKey } = keystore.generateSigningKeyPair();

      let encrypted = keystore.encryptActorPrivateKey(privateKey, agent.id);

      assert.throws(
        () => keystore.decryptActorPrivateKey(encrypted, 'agt_wrong_id'),
        /Unsupported state|error/i,
      );
    });

    it('full round-trip: generate, encrypt, store, fetch, decrypt, sign, verify', async () => {
      let agent = await createAgent('test-full-roundtrip');

      // Generate key pair
      let { publicKey, privateKey } = keystore.generateSigningKeyPair();

      // Encrypt and store on agent
      let encrypted = keystore.encryptActorPrivateKey(privateKey, agent.id);
      agent.publicKey           = publicKey;
      agent.encryptedPrivateKey = JSON.stringify(encrypted);
      await agent.save();

      // Fetch from database
      let { Agent } = models;
      let fetched = await Agent.where.id.EQ(agent.id).first();

      assert.equal(fetched.publicKey, publicKey);
      assert.ok(fetched.encryptedPrivateKey);

      // Decrypt the private key
      let envelope     = JSON.parse(fetched.encryptedPrivateKey);
      let decryptedKey = keystore.decryptActorPrivateKey(envelope, fetched.id);

      assert.equal(decryptedKey, privateKey);

      // Sign and verify
      let data      = { action: 'test', agentID: fetched.id };
      let signature = keystore.signWithPrivateKey(data, decryptedKey);
      let verified  = keystore.verifyWithPublicKey(data, fetched.publicKey, signature);

      assert.equal(verified, true);
    });

    it('key pair fields persist independently from other agent fields', async () => {
      let agent = await createAgent('test-independent-fields');

      let { publicKey, privateKey } = keystore.generateSigningKeyPair();
      let encrypted = keystore.encryptActorPrivateKey(privateKey, agent.id);

      agent.publicKey           = publicKey;
      agent.encryptedPrivateKey = JSON.stringify(encrypted);
      agent.instructions        = 'Updated instructions';
      await agent.save();

      let { Agent } = models;
      let fetched = await Agent.where.id.EQ(agent.id).first();

      assert.equal(fetched.publicKey, publicKey);
      assert.equal(fetched.encryptedPrivateKey, JSON.stringify(encrypted));
      assert.equal(fetched.instructions, 'Updated instructions');
    });

    it('cannot decrypt with a different SMK', async () => {
      let agent = await createAgent('test-different-smk');
      let { privateKey } = keystore.generateSigningKeyPair();

      let encrypted = keystore.encryptActorPrivateKey(privateKey, agent.id);

      // Create a new keystore with a different SMK
      let differentTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kikx-diff-smk-'));
      let differentKeystore = new Keystore();
      differentKeystore.initialize();
      differentKeystore.loadServerMasterKey(differentTempDir);

      try {
        assert.throws(
          () => differentKeystore.decryptActorPrivateKey(encrypted, agent.id),
          /Unsupported state|error/i,
        );
      } finally {
        differentKeystore.destroy();
        fs.rmSync(differentTempDir, { recursive: true, force: true });
      }
    });
  });
});
