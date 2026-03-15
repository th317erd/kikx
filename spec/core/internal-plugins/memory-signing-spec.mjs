'use strict';

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs     from 'node:fs';
import os     from 'node:os';
import path   from 'node:path';

import { createKikxCore }   from '../../../src/core/index.mjs';
import { PluginInterface }  from '../../../src/core/plugin-loader/plugin-interface.mjs';
import { PluginRegistry }   from '../../../src/core/plugin-loader/registry.mjs';
import { Keystore }         from '../../../src/core/crypto/keystore.mjs';
import { setup }            from '../../../src/core/internal-plugins/memory/index.mjs';

// =============================================================================
// Memory Plugin — Signed Values Tests
// =============================================================================
// Tests for the signing feature in memory:setValue, memory:getValue,
// and memory:searchValues. Covers happy path, tamper detection, key
// mismatch, missing keys, and adversarial scenarios.
// =============================================================================

describe('Memory Plugin — Signed Values', () => {
  let core;
  let models;
  let context;
  let registry;
  let keystore;
  let tempDir;
  let organization;

  let GetMemoryValueTool;
  let SetMemoryValueTool;
  let SearchMemoryValuesTool;

  before(async () => {
    core    = createKikxCore();
    await core.start();
    models  = core.getModels();
    context = core.getContext();

    // Set up keystore with SMK for agent key encryption
    tempDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'kikx-mem-sign-'));
    keystore = new Keystore();
    keystore.initialize();
    keystore.loadServerMasterKey(tempDir);

    context.setProperty('keystore', keystore);

    registry = new PluginRegistry();
    setup({
      registerTool: (name, cls) => registry.registerTool(name, cls),
      PluginInterface,
      context,
    });

    GetMemoryValueTool     = registry.getTool('memory:getValue');
    SetMemoryValueTool     = registry.getTool('memory:setValue');
    SearchMemoryValuesTool = registry.getTool('memory:searchValues');
  });

  after(async () => {
    if (keystore)
      keystore.destroy();

    if (core && core.isStarted())
      await core.stop();

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    organization = await models.Organization.create({ name: 'Memory Sign Test Org' });
  });

  // Create an agent with Ed25519 key pair.
  // Must create agent first to get the real XID, then encrypt the key with it.
  async function createSigningAgent(name) {
    let { publicKey, privateKey } = keystore.generateSigningKeyPair();

    let agent = await models.Agent.create({
      organizationID: organization.id,
      name,
      pluginID:       'mock-agent',
      publicKey,
    });

    // Encrypt private key using the real agent ID (XID-based)
    let encryptedPrivateKey = JSON.stringify(
      keystore.encryptActorPrivateKey(privateKey, agent.id),
    );

    agent.encryptedPrivateKey = encryptedPrivateKey;
    await agent.save();

    return agent;
  }

  // Create agent without key pair
  async function createUnsignedAgent(name) {
    return models.Agent.create({
      organizationID: organization.id,
      name,
      pluginID:       'mock-agent',
    });
  }

  function instantiateTool(ToolClass) {
    return new ToolClass({
      getProperty: (key) => context.getProperty(key),
    });
  }

  // ---------------------------------------------------------------------------
  // setValue with sign: true
  // ---------------------------------------------------------------------------

  describe('memory:setValue with sign: true', () => {
    it('stores a signed value and returns signed: true', async () => {
      let agent   = await createSigningAgent('test-sign-set');
      let setTool = instantiateTool(SetMemoryValueTool);

      let result = await setTool.execute({
        agentID: agent.id,
        _agent:  agent,
        key:     'secret',
        value:   'classified',
        scopeID: '',
        sign:    true,
      });

      assert.equal(result.key, 'secret');
      assert.equal(result.value, 'classified');
      assert.equal(result.signed, true);
    });

    it('stores signature and fingerprint in DB', async () => {
      let agent   = await createSigningAgent('test-sign-db');
      let setTool = instantiateTool(SetMemoryValueTool);

      await setTool.execute({
        agentID: agent.id,
        _agent:  agent,
        key:     'db-check',
        value:   'signed-data',
        scopeID: '',
        sign:    true,
      });

      let { ValueStore } = models;
      let entry = await ValueStore
        .where.ownerType.EQ('Agent')
        .ownerID.EQ(agent.id)
        .namespace.EQ('memory')
        .key.EQ('db-check')
        .first();

      assert.ok(entry.signature, 'signature should be stored');
      assert.ok(entry.signingKeyFingerprint, 'fingerprint should be stored');
      assert.equal(entry.signingKeyFingerprint.length, 32);
    });

    it('unsigned set does not include signed flag', async () => {
      let agent   = await createSigningAgent('test-unsigned-set');
      let setTool = instantiateTool(SetMemoryValueTool);

      let result = await setTool.execute({
        agentID: agent.id,
        key:     'not-signed',
        value:   'plain',
        scopeID: '',
      });

      assert.equal(result.key, 'not-signed');
      assert.equal(result.signed, undefined);
    });

    it('unsigned set stores null signature in DB', async () => {
      let agent   = await createSigningAgent('test-unsigned-db');
      let setTool = instantiateTool(SetMemoryValueTool);

      await setTool.execute({
        agentID: agent.id,
        key:     'plain-val',
        value:   'no-sig',
        scopeID: '',
      });

      let { ValueStore } = models;
      let entry = await ValueStore
        .where.ownerType.EQ('Agent')
        .ownerID.EQ(agent.id)
        .namespace.EQ('memory')
        .key.EQ('plain-val')
        .first();

      assert.equal(entry.signature, null);
      assert.equal(entry.signingKeyFingerprint, null);
    });

    it('rejects sign: true for agent without key pair', async () => {
      let agent   = await createUnsignedAgent('test-no-keys');
      let setTool = instantiateTool(SetMemoryValueTool);

      await assert.rejects(
        () => setTool.execute({
          agentID: agent.id,
          _agent:  agent,
          key:     'fail',
          value:   'should-fail',
          scopeID: '',
          sign:    true,
        }),
        (err) => {
          assert.ok(err.message.includes('signing key pair'));
          return true;
        },
      );
    });

    it('overwriting signed value with unsigned clears signature', async () => {
      let agent   = await createSigningAgent('test-overwrite-sig');
      let setTool = instantiateTool(SetMemoryValueTool);

      // Write signed
      await setTool.execute({
        agentID: agent.id,
        _agent:  agent,
        key:     'overwrite-me',
        value:   'signed-v1',
        scopeID: '',
        sign:    true,
      });

      // Overwrite unsigned
      await setTool.execute({
        agentID: agent.id,
        key:     'overwrite-me',
        value:   'unsigned-v2',
        scopeID: '',
      });

      let { ValueStore } = models;
      let entry = await ValueStore
        .where.ownerType.EQ('Agent')
        .ownerID.EQ(agent.id)
        .namespace.EQ('memory')
        .key.EQ('overwrite-me')
        .first();

      assert.equal(entry.signature, null, 'signature should be cleared');
      assert.equal(entry.signingKeyFingerprint, null, 'fingerprint should be cleared');
    });

    it('overwriting signed value with new signed value updates signature', async () => {
      let agent   = await createSigningAgent('test-re-sign');
      let setTool = instantiateTool(SetMemoryValueTool);

      await setTool.execute({
        agentID: agent.id,
        _agent:  agent,
        key:     're-sign-me',
        value:   'v1',
        scopeID: '',
        sign:    true,
      });

      let { ValueStore } = models;
      let entry1 = await ValueStore
        .where.ownerType.EQ('Agent')
        .ownerID.EQ(agent.id)
        .namespace.EQ('memory')
        .key.EQ('re-sign-me')
        .first();

      let sig1 = entry1.signature;

      await setTool.execute({
        agentID: agent.id,
        _agent:  agent,
        key:     're-sign-me',
        value:   'v2',
        scopeID: '',
        sign:    true,
      });

      let entry2 = await ValueStore
        .where.ownerType.EQ('Agent')
        .ownerID.EQ(agent.id)
        .namespace.EQ('memory')
        .key.EQ('re-sign-me')
        .first();

      assert.ok(entry2.signature);
      assert.notEqual(entry2.signature, sig1, 'signature should change with new value');
    });
  });

  // ---------------------------------------------------------------------------
  // getValue with signing verification
  // ---------------------------------------------------------------------------

  describe('memory:getValue with signing verification', () => {
    it('returns signed: true, verified: true for valid signed value', async () => {
      let agent   = await createSigningAgent('test-get-valid');
      let setTool = instantiateTool(SetMemoryValueTool);
      let getTool = instantiateTool(GetMemoryValueTool);

      await setTool.execute({
        agentID: agent.id,
        _agent:  agent,
        key:     'verified-key',
        value:   'trusted',
        scopeID: '',
        sign:    true,
      });

      let result = await getTool.execute({
        agentID: agent.id,
        key:     'verified-key',
        scopeID: '',
      });

      assert.equal(result.value, 'trusted');
      assert.equal(result.signed, true);
      assert.equal(result.verified, true);
    });

    it('returns signed: false for unsigned value', async () => {
      let agent   = await createSigningAgent('test-get-unsigned');
      let setTool = instantiateTool(SetMemoryValueTool);
      let getTool = instantiateTool(GetMemoryValueTool);

      await setTool.execute({
        agentID: agent.id,
        key:     'unsigned-key',
        value:   'plain',
        scopeID: '',
      });

      let result = await getTool.execute({
        agentID: agent.id,
        key:     'unsigned-key',
        scopeID: '',
      });

      assert.equal(result.value, 'plain');
      assert.equal(result.signed, false);
      assert.equal(result.verified, undefined);
    });

    it('detects tampered value (signed: true, verified: false)', async () => {
      let agent   = await createSigningAgent('test-get-tampered');
      let setTool = instantiateTool(SetMemoryValueTool);
      let getTool = instantiateTool(GetMemoryValueTool);

      await setTool.execute({
        agentID: agent.id,
        _agent:  agent,
        key:     'tamper-target',
        value:   'original',
        scopeID: '',
        sign:    true,
      });

      // Tamper with value in DB
      let { ValueStore } = models;
      let entry = await ValueStore
        .where.ownerType.EQ('Agent')
        .ownerID.EQ(agent.id)
        .namespace.EQ('memory')
        .key.EQ('tamper-target')
        .first();

      entry.value = JSON.stringify('evil-replacement');
      await entry.save();

      let result = await getTool.execute({
        agentID: agent.id,
        key:     'tamper-target',
        scopeID: '',
      });

      assert.equal(result.signed, true);
      assert.equal(result.verified, false, 'tampered value should fail verification');
      assert.equal(result.value, 'evil-replacement', 'still returns the current (tampered) value');
    });

    it('detects corrupted signature (signed: true, verified: false)', async () => {
      let agent   = await createSigningAgent('test-get-badsig');
      let setTool = instantiateTool(SetMemoryValueTool);
      let getTool = instantiateTool(GetMemoryValueTool);

      await setTool.execute({
        agentID: agent.id,
        _agent:  agent,
        key:     'badsig-key',
        value:   'good-data',
        scopeID: '',
        sign:    true,
      });

      // Corrupt signature in DB
      let { ValueStore } = models;
      let entry = await ValueStore
        .where.ownerType.EQ('Agent')
        .ownerID.EQ(agent.id)
        .namespace.EQ('memory')
        .key.EQ('badsig-key')
        .first();

      entry.signature = 'aaaa' + entry.signature.slice(4);
      await entry.save();

      let result = await getTool.execute({
        agentID: agent.id,
        key:     'badsig-key',
        scopeID: '',
      });

      assert.equal(result.signed, true);
      assert.equal(result.verified, false, 'corrupted signature should fail verification');
    });

    it('returns null for non-existent key (no signed field)', async () => {
      let agent   = await createSigningAgent('test-get-missing');
      let getTool = instantiateTool(GetMemoryValueTool);

      let result = await getTool.execute({
        agentID: agent.id,
        key:     'ghost-key',
        scopeID: '',
      });

      assert.equal(result.value, null);
      assert.equal(result.signed, undefined);
    });
  });

  // ---------------------------------------------------------------------------
  // searchValues with signing info
  // ---------------------------------------------------------------------------

  describe('memory:searchValues with signing info', () => {
    it('includes signed: true/false for each result', async () => {
      let agent   = await createSigningAgent('test-search-sign');
      let setTool = instantiateTool(SetMemoryValueTool);
      let searchTool = instantiateTool(SearchMemoryValuesTool);

      // Store one signed and one unsigned
      await setTool.execute({
        agentID: agent.id,
        _agent:  agent,
        key:     'signed-item',
        value:   'secure',
        scopeID: '',
        sign:    true,
      });

      await setTool.execute({
        agentID: agent.id,
        key:     'unsigned-item',
        value:   'plain',
        scopeID: '',
      });

      let result = await searchTool.execute({
        agentID: agent.id,
        scopeID: '',
      });

      assert.equal(result.count, 2);

      let signedResult   = result.results.find((r) => r.key === 'signed-item');
      let unsignedResult = result.results.find((r) => r.key === 'unsigned-item');

      assert.ok(signedResult);
      assert.ok(unsignedResult);
      assert.equal(signedResult.signed, true);
      assert.equal(signedResult.verified, true);
      assert.equal(unsignedResult.signed, false);
      assert.equal(unsignedResult.verified, undefined);
    });

    it('detects tampered values in search results', async () => {
      let agent   = await createSigningAgent('test-search-tamper');
      let setTool = instantiateTool(SetMemoryValueTool);
      let searchTool = instantiateTool(SearchMemoryValuesTool);

      await setTool.execute({
        agentID: agent.id,
        _agent:  agent,
        key:     'tamper-search',
        value:   'original-search',
        scopeID: '',
        sign:    true,
      });

      // Tamper
      let { ValueStore } = models;
      let entry = await ValueStore
        .where.ownerType.EQ('Agent')
        .ownerID.EQ(agent.id)
        .namespace.EQ('memory')
        .key.EQ('tamper-search')
        .first();

      entry.value = JSON.stringify('tampered-search');
      await entry.save();

      let result = await searchTool.execute({
        agentID: agent.id,
        scopeID: '',
      });

      let tampered = result.results.find((r) => r.key === 'tamper-search');
      assert.ok(tampered);
      assert.equal(tampered.signed, true);
      assert.equal(tampered.verified, false);
    });
  });

  // ---------------------------------------------------------------------------
  // End-to-end: sign → retrieve → verify
  // ---------------------------------------------------------------------------

  describe('end-to-end: sign → retrieve → verify', () => {
    it('full round trip with string value', async () => {
      let agent   = await createSigningAgent('test-e2e-string');
      let setTool = instantiateTool(SetMemoryValueTool);
      let getTool = instantiateTool(GetMemoryValueTool);

      await setTool.execute({
        agentID: agent.id,
        _agent:  agent,
        key:     'email',
        value:   'user@example.com',
        scopeID: 'ses_e2e',
        sign:    true,
      });

      let result = await getTool.execute({
        agentID: agent.id,
        key:     'email',
        scopeID: 'ses_e2e',
      });

      assert.equal(result.value, 'user@example.com');
      assert.equal(result.signed, true);
      assert.equal(result.verified, true);
    });

    it('full round trip with complex object value', async () => {
      let agent   = await createSigningAgent('test-e2e-object');
      let setTool = instantiateTool(SetMemoryValueTool);
      let getTool = instantiateTool(GetMemoryValueTool);

      let complexValue = {
        preferences: { theme: 'dark', fontSize: 14 },
        permissions: ['read', 'write'],
        metadata:    { version: 3 },
      };

      await setTool.execute({
        agentID: agent.id,
        _agent:  agent,
        key:     'settings',
        value:   complexValue,
        scopeID: '',
        sign:    true,
      });

      let result = await getTool.execute({
        agentID: agent.id,
        key:     'settings',
        scopeID: '',
      });

      assert.deepStrictEqual(result.value, complexValue);
      assert.equal(result.signed, true);
      assert.equal(result.verified, true);
    });

    it('sign in one scope, retrieve from different scope returns null', async () => {
      let agent   = await createSigningAgent('test-e2e-scope');
      let setTool = instantiateTool(SetMemoryValueTool);
      let getTool = instantiateTool(GetMemoryValueTool);

      await setTool.execute({
        agentID: agent.id,
        _agent:  agent,
        key:     'scoped-secret',
        value:   'scope-a-value',
        scopeID: 'scope-a',
        sign:    true,
      });

      let result = await getTool.execute({
        agentID: agent.id,
        key:     'scoped-secret',
        scopeID: 'scope-b',
      });

      assert.equal(result.value, null, 'should not find value in different scope');
    });
  });

  // ---------------------------------------------------------------------------
  // Adversarial scenarios
  // ---------------------------------------------------------------------------

  describe('adversarial scenarios', () => {
    it('moving signed value to different key name fails verification', async () => {
      let agent   = await createSigningAgent('test-adv-key-move');
      let setTool = instantiateTool(SetMemoryValueTool);
      let getTool = instantiateTool(GetMemoryValueTool);

      await setTool.execute({
        agentID: agent.id,
        _agent:  agent,
        key:     'original-key',
        value:   'sensitive',
        scopeID: '',
        sign:    true,
      });

      // Copy the signed value to a different key in the DB
      let { ValueStore } = models;
      let original = await ValueStore
        .where.ownerType.EQ('Agent')
        .ownerID.EQ(agent.id)
        .namespace.EQ('memory')
        .key.EQ('original-key')
        .first();

      await ValueStore.create({
        organizationID:       organization.id,
        ownerType:            'Agent',
        ownerID:              agent.id,
        namespace:            'memory',
        scopeID:              '',
        key:                  'fake-key',
        value:                original.value,
        signature:            original.signature,
        signingKeyFingerprint: original.signingKeyFingerprint,
      });

      // The copied value should fail verification (key name is part of payload)
      let result = await getTool.execute({
        agentID: agent.id,
        key:     'fake-key',
        scopeID: '',
      });

      assert.equal(result.signed, true);
      assert.equal(result.verified, false, 'moved signed value should fail verification');
    });

    it('moving signed value to different scope fails verification', async () => {
      let agent   = await createSigningAgent('test-adv-scope-move');
      let setTool = instantiateTool(SetMemoryValueTool);
      let getTool = instantiateTool(GetMemoryValueTool);

      await setTool.execute({
        agentID: agent.id,
        _agent:  agent,
        key:     'scope-locked',
        value:   'immovable',
        scopeID: 'ses_original',
        sign:    true,
      });

      // Copy to different scope
      let { ValueStore } = models;
      let original = await ValueStore
        .where.ownerType.EQ('Agent')
        .ownerID.EQ(agent.id)
        .namespace.EQ('memory')
        .key.EQ('scope-locked')
        .scopeID.EQ('ses_original')
        .first();

      await ValueStore.create({
        organizationID:       organization.id,
        ownerType:            'Agent',
        ownerID:              agent.id,
        namespace:            'memory',
        scopeID:              'ses_hacked',
        key:                  'scope-locked',
        value:                original.value,
        signature:            original.signature,
        signingKeyFingerprint: original.signingKeyFingerprint,
      });

      let result = await getTool.execute({
        agentID: agent.id,
        key:     'scope-locked',
        scopeID: 'ses_hacked',
      });

      assert.equal(result.signed, true);
      assert.equal(result.verified, false, 'cross-scope replayed value should fail verification');
    });

    it('sign: false (explicit) does not sign', async () => {
      let agent   = await createSigningAgent('test-adv-explicit-false');
      let setTool = instantiateTool(SetMemoryValueTool);
      let getTool = instantiateTool(GetMemoryValueTool);

      await setTool.execute({
        agentID: agent.id,
        _agent:  agent,
        key:     'no-sign',
        value:   'explicit-false',
        scopeID: '',
        sign:    false,
      });

      let result = await getTool.execute({
        agentID: agent.id,
        key:     'no-sign',
        scopeID: '',
      });

      assert.equal(result.signed, false);
    });

    it('sign: true with sign: false overwrite clears signature', async () => {
      let agent   = await createSigningAgent('test-adv-downgrade');
      let setTool = instantiateTool(SetMemoryValueTool);
      let getTool = instantiateTool(GetMemoryValueTool);

      // Sign first
      await setTool.execute({
        agentID: agent.id,
        _agent:  agent,
        key:     'downgrade',
        value:   'signed-first',
        scopeID: '',
        sign:    true,
      });

      // Overwrite without signing
      await setTool.execute({
        agentID: agent.id,
        key:     'downgrade',
        value:   'unsigned-second',
        scopeID: '',
      });

      let result = await getTool.execute({
        agentID: agent.id,
        key:     'downgrade',
        scopeID: '',
      });

      assert.equal(result.value, 'unsigned-second');
      assert.equal(result.signed, false);
    });
  });
});
