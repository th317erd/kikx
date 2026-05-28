'use strict';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs     from 'node:fs';
import path   from 'node:path';
import os     from 'node:os';

import { KikxCore }       from '../../../src/core/kikx-core.mjs';
import { Keystore }       from '../../../src/core/crypto/keystore.mjs';
import { AuthService }    from '../../../src/server/auth/index.mjs';
import { AgentController } from '../../../src/server/controllers/agent-controller.mjs';

// =============================================================================
// AgentController — Ed25519 key pair generation tests (Gap 1)
// =============================================================================
// Verifies that agents created via the controller endpoint automatically
// receive Ed25519 key pairs (publicKey + encryptedPrivateKey).
// =============================================================================

function createMockReq(overrides = {}) {
  return {
    body:           {},
    params:         {},
    query:          {},
    userID:         null,
    organizationID: null,
    getUMK:         () => null,
    headers:        {},
    method:         'GET',
    on:             () => {},
    ...overrides,
  };
}

function createMockRes() {
  let res = {
    _status:  200,
    _json:    null,
    _headers: {},
    status(code) { res._status = code; return res; },
    json(data)   { res._json = data; return res; },
    setHeader(key, val) { res._headers[key] = val; return res; },
    header(key, val) { res._headers[key] = val; return res; },
    write(data)  { return res; },
    end()        {},
    send(data)   { return res; },
  };

  return res;
}

function createController(ControllerClass, { mockApp, req, res }) {
  return new ControllerClass(mockApp, null, req, res);
}

// =============================================================================
// Shared setup
// =============================================================================

let core, keystore, authService, mockApp;
let testUser, testOrg, testUMK;
let tempDir;

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kikx-agent-ctrl-test-'));

  core = new KikxCore({ database: { filename: ':memory:' } });
  await core.start();

  keystore = new Keystore({ devMode: true, devSeed: 'agent-ctrl-key-test-seed' });
  keystore.initialize();
  keystore.loadServerMasterKey(tempDir);

  let context = core.getContext();
  context.setProperty('keystore', keystore);

  authService = new AuthService({ context, keystore });
  mockApp     = {
    getCore:        () => core,
    getAuthService: () => authService,
    getKeystore:    () => keystore,
  };

  let regResult = await authService.register('agent-ctrl@test.com', 'password123', {
    organizationName: 'Agent Controller Test Org',
    firstName:        'Agent',
    lastName:         'Tester',
  });

  testUser  = regResult.user;
  testOrg   = regResult.organization;

  let decoded = authService.verifyToken(regResult.token);
  testUMK     = authService.getUMK(decoded);
});

after(async () => {
  keystore.destroy();
  await core.stop();

  if (tempDir && fs.existsSync(tempDir))
    fs.rmSync(tempDir, { recursive: true, force: true });
});

// =============================================================================
// Gap 1: Agent created via POST has publicKey set
// =============================================================================

describe('AgentController: Ed25519 key pair on create (Gap 1)', () => {
  it('should set publicKey on the created agent', async () => {
    let req = createMockReq({
      organizationID: testOrg.id,
      userID:         testUser.id,
      getUMK:         () => testUMK,
    });
    let res        = createMockRes();
    let controller = createController(AgentController, { mockApp, req, res });
    let result     = await controller.create({
      body: { name: 'test-keypair-pub', pluginID: 'claude-agent' },
    });

    let agent = result.data.agent;
    assert.ok(agent, 'agent should be in response');
    assert.ok(agent.publicKey, 'publicKey should be set');
    assert.ok(agent.publicKey.startsWith('-----BEGIN PUBLIC KEY-----'), 'publicKey should be PEM');
  });

  it('should set encryptedPrivateKey on the created agent', async () => {
    let req = createMockReq({
      organizationID: testOrg.id,
      userID:         testUser.id,
      getUMK:         () => testUMK,
    });
    let res        = createMockRes();
    let controller = createController(AgentController, { mockApp, req, res });
    let result     = await controller.create({
      body: { name: 'test-keypair-enc', pluginID: 'claude-agent' },
    });

    let agent = result.data.agent;
    assert.ok(agent.encryptedPrivateKey, 'encryptedPrivateKey should be set');

    // Should be parseable as JSON envelope
    let envelope = JSON.parse(agent.encryptedPrivateKey);
    assert.ok(envelope.ciphertext, 'envelope should have ciphertext');
    assert.ok(envelope.iv, 'envelope should have iv');
    assert.ok(envelope.authTag, 'envelope should have authTag');
  });

  it('should generate unique key pairs for different agents', async () => {
    let req1 = createMockReq({
      organizationID: testOrg.id,
      userID:         testUser.id,
      getUMK:         () => testUMK,
    });
    let req2 = createMockReq({
      organizationID: testOrg.id,
      userID:         testUser.id,
      getUMK:         () => testUMK,
    });

    let controller1 = createController(AgentController, { mockApp, req: req1, res: createMockRes() });
    let controller2 = createController(AgentController, { mockApp, req: req2, res: createMockRes() });

    let result1 = await controller1.create({ body: { name: 'test-unique-key-1', pluginID: 'claude-agent' } });
    let result2 = await controller2.create({ body: { name: 'test-unique-key-2', pluginID: 'claude-agent' } });

    let agent1 = result1.data.agent;
    let agent2 = result2.data.agent;

    assert.notEqual(agent1.publicKey, agent2.publicKey, 'different agents should have different public keys');
    assert.notEqual(agent1.encryptedPrivateKey, agent2.encryptedPrivateKey, 'different agents should have different encrypted private keys');
  });

  it('should produce a decryptable private key that signs and verifies', async () => {
    let req = createMockReq({
      organizationID: testOrg.id,
      userID:         testUser.id,
      getUMK:         () => testUMK,
    });
    let res        = createMockRes();
    let controller = createController(AgentController, { mockApp, req, res });
    let result     = await controller.create({
      body: { name: 'test-roundtrip-sign', pluginID: 'claude-agent' },
    });

    let agent    = result.data.agent;
    let envelope = JSON.parse(agent.encryptedPrivateKey);

    // Decrypt the private key using the SMK-derived key
    let privateKeyPEM = keystore.decryptActorPrivateKey(envelope, agent.id);
    assert.ok(privateKeyPEM, 'should decrypt private key');
    assert.ok(privateKeyPEM.includes('-----BEGIN PRIVATE KEY-----'), 'should be valid PEM');

    // Sign and verify
    let data      = 'test-payload';
    let signature = keystore.signWithPrivateKey(data, privateKeyPEM);
    let verified  = keystore.verifyWithPublicKey(data, agent.publicKey, signature);
    assert.equal(verified, true, 'should verify signature with public key');
  });

  it('should persist publicKey and encryptedPrivateKey to database', async () => {
    let req = createMockReq({
      organizationID: testOrg.id,
      userID:         testUser.id,
      getUMK:         () => testUMK,
    });
    let res        = createMockRes();
    let controller = createController(AgentController, { mockApp, req, res });
    let result     = await controller.create({
      body: { name: 'test-persist-keys', pluginID: 'claude-agent' },
    });

    let agent = result.data.agent;
    let { Agent } = core.getModels();

    // Re-fetch from DB
    let fetched = await Agent.where.id.EQ(agent.id).first();
    assert.ok(fetched, 'should find agent in DB');
    assert.equal(fetched.publicKey, agent.publicKey, 'publicKey should match DB value');
    assert.equal(fetched.encryptedPrivateKey, agent.encryptedPrivateKey, 'encryptedPrivateKey should match DB value');
  });

  it('should not break create when no apiKey is provided', async () => {
    let req = createMockReq({
      organizationID: testOrg.id,
      userID:         testUser.id,
      getUMK:         () => testUMK,
    });
    let res        = createMockRes();
    let controller = createController(AgentController, { mockApp, req, res });

    // No apiKey — should still generate key pair
    let result = await controller.create({
      body: { name: 'test-noapi-keys', pluginID: 'claude-agent' },
    });

    let agent = result.data.agent;
    assert.ok(agent.publicKey, 'publicKey should be set even without apiKey');
    assert.ok(agent.encryptedPrivateKey, 'encryptedPrivateKey should be set even without apiKey');
  });

  it('should set status 201 on create', async () => {
    let req = createMockReq({
      organizationID: testOrg.id,
      userID:         testUser.id,
      getUMK:         () => testUMK,
    });
    let res        = createMockRes();
    let controller = createController(AgentController, { mockApp, req, res });
    await controller.create({
      body: { name: 'test-status-201', pluginID: 'claude-agent' },
    });

    assert.equal(controller.responseStatusCode, 201);
  });

  it('should throw 400 when name is missing', async () => {
    let req = createMockReq({
      organizationID: testOrg.id,
      userID:         testUser.id,
      getUMK:         () => testUMK,
    });
    let res        = createMockRes();
    let controller = createController(AgentController, { mockApp, req, res });

    await assert.rejects(
      () => controller.create({ body: { pluginID: 'claude-agent' } }),
      (error) => error.message.includes('name is required'),
    );
  });

  it('should throw 400 when pluginID is missing', async () => {
    let req = createMockReq({
      organizationID: testOrg.id,
      userID:         testUser.id,
      getUMK:         () => testUMK,
    });
    let res        = createMockRes();
    let controller = createController(AgentController, { mockApp, req, res });

    await assert.rejects(
      () => controller.create({ body: { name: 'test-no-plugin' } }),
      (error) => error.message.includes('pluginID is required'),
    );
  });

  it('existing agents without keys should not break list/show', async () => {
    // Directly create an agent without keys (simulating old account)
    let { Agent } = core.getModels();
    let agent     = await Agent.create({
      organizationID: testOrg.id,
      name:           'test-legacy-no-keys',
      pluginID:       'claude-agent',
    });

    // publicKey and encryptedPrivateKey should be null/undefined (not set)
    assert.ok(agent.publicKey == null, 'publicKey should be null/undefined on direct create');
    assert.ok(agent.encryptedPrivateKey == null, 'encryptedPrivateKey should be null/undefined on direct create');

    // Show should work without errors
    let req = createMockReq({ organizationID: testOrg.id });
    let res = createMockRes();
    let controller = createController(AgentController, { mockApp, req, res });

    let result = await controller.show({ params: { agentID: agent.id } });
    assert.ok(result.data.agent, 'show should succeed for agent without keys');
    assert.equal(result.data.agent.id, agent.id);
  });
});

// =============================================================================
// AgentController: key generation failure paths
// =============================================================================

describe('AgentController: key generation failure paths', () => {
  it('encryptActorPrivateKey() throws → create rejects (error propagates)', async () => {
    // The impl does not catch errors from encryptActorPrivateKey() —
    // if it throws, the create call will reject. Verify the behavior.
    let brokenKeystore = {
      ...keystore,
      deriveUserKey:            (...args) => keystore.deriveUserKey(...args),
      encrypt:                  (...args) => keystore.encrypt(...args),
      generateSigningKeyPair:   () => keystore.generateSigningKeyPair(),
      encryptActorPrivateKey:   () => { throw new Error('HSM unavailable'); },
    };

    let brokenMockApp = {
      getCore:        () => core,
      getAuthService: () => authService,
      getKeystore:    () => brokenKeystore,
    };

    let req = createMockReq({
      organizationID: testOrg.id,
      userID:         testUser.id,
      getUMK:         () => testUMK,
    });
    let res        = createMockRes();
    let controller = createController(AgentController, { mockApp: brokenMockApp, req, res });

    // The impl does NOT catch encryptActorPrivateKey errors — it propagates
    await assert.rejects(
      () => controller.create({ body: { name: 'test-broken-keystore', pluginID: 'claude-agent' } }),
      (error) => error.message.includes('HSM unavailable'),
      'encryptActorPrivateKey throw should propagate from create',
    );
  });

  it('create rejects when pluginID is null', async () => {
    let req = createMockReq({
      organizationID: testOrg.id,
      userID:         testUser.id,
      getUMK:         () => testUMK,
    });
    let res        = createMockRes();
    let controller = createController(AgentController, { mockApp, req, res });

    await assert.rejects(
      () => controller.create({ body: { name: 'test-null-plugin', pluginID: null } }),
      (error) => error.message.includes('pluginID is required'),
      'null pluginID should be rejected with 400',
    );
  });

  it('create rejects when pluginID is empty string', async () => {
    let req = createMockReq({
      organizationID: testOrg.id,
      userID:         testUser.id,
      getUMK:         () => testUMK,
    });
    let res        = createMockRes();
    let controller = createController(AgentController, { mockApp, req, res });

    await assert.rejects(
      () => controller.create({ body: { name: 'test-empty-plugin', pluginID: '' } }),
      (error) => error.message.includes('pluginID is required'),
      'empty string pluginID should be rejected with 400',
    );
  });

  it('create rejects when no keystore on context (getKeystore returns null)', async () => {
    let noKeystoreMockApp = {
      getCore:        () => core,
      getAuthService: () => authService,
      getKeystore:    () => null,
    };

    let req = createMockReq({
      organizationID: testOrg.id,
      userID:         testUser.id,
      getUMK:         () => testUMK,
    });
    let res        = createMockRes();
    let controller = createController(AgentController, { mockApp: noKeystoreMockApp, req, res });

    // Without a keystore, generateSigningKeyPair() would throw a TypeError
    await assert.rejects(
      () => controller.create({ body: { name: 'test-no-keystore', pluginID: 'claude-agent' } }),
      (error) => error instanceof Error,
      'missing keystore should cause create to reject',
    );
  });
});
