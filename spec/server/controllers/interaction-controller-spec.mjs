'use strict';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs     from 'node:fs';
import path   from 'node:path';
import os     from 'node:os';

import { KikxCore }              from '../../../src/core/kikx-core.mjs';
import { Keystore }              from '../../../src/core/crypto/keystore.mjs';
import { AuthService }           from '../../../src/server/auth/index.mjs';
import { InteractionController } from '../../../src/server/controllers/interaction-controller.mjs';
import { AgentInterface }        from '../../../src/core/plugins/agent-interface.mjs';

// =============================================================================
// InteractionController — user private key wiring tests (Gap 2)
// =============================================================================
// Verifies that:
//   - The controller decrypts the user's private key from their UMK
//   - The decrypted key is passed to interactionLoop.startInteraction()
//   - The decrypted key is passed to interactionLoop.postMessage()
//   - If user has no encryptedPrivateKey, null is passed gracefully
//   - If UMK is unavailable (getUMK returns null), null is passed gracefully
//   - Decryption failure does not crash (best-effort)
// =============================================================================

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockReq(overrides = {}) {
  return {
    body:           {},
    params:         {},
    query:          {},
    userID:         null,
    organizationID: null,
    getUMK:         () => null,
    headers:        {},
    method:         'POST',
    on:             () => {},
    ...overrides,
  };
}

function createMockRes() {
  let res = {
    _status: 200,
    status(code) { res._status = code; return res; },
    json(data)   { res._json = data; return res; },
    setHeader(k, v) { return res; },
    header(k, v)    { return res; },
    write(data)     { return res; },
    end()           {},
    send(data)      { return res; },
  };

  return res;
}

function createController(ControllerClass, { mockApp, req, res }) {
  return new ControllerClass(mockApp, null, req, res);
}

// Capture calls to startInteraction and postMessage
function createMockInteractionLoop(opts = {}) {
  let captured = {};

  return {
    captured,
    startInteractionCalled: false,
    postMessageCalled:      false,

    async startInteraction(sessionID, params) {
      captured.startInteractionSessionID = sessionID;
      captured.startInteractionParams    = params;
      this.startInteractionCalled        = true;
      return 'int_test';
    },

    async postMessage(sessionID, opts) {
      captured.postMessageSessionID = sessionID;
      captured.postMessageOpts      = opts;
      this.postMessageCalled        = true;
      return { interactionID: 'int_post', frameID: 'frm_post' };
    },

    // Stub remaining methods
    requestPrimerRefresh()    {},
    cancelInteraction()       { return null; },
    isActive()                { return false; },
  };
}

// ---------------------------------------------------------------------------
// Mock Agent Plugin — used to satisfy core.getAgentType() lookup
// ---------------------------------------------------------------------------

class MockAgentPlugin extends AgentInterface {
  static pluginID    = 'test-mock-plugin';
  static featureName = 'test-mock';
  static displayName = 'Test Mock Plugin';
  static description = 'Mock plugin for interaction controller tests';
  static agentType   = 'mock';

  async *_createGenerator(_params) {
    yield { type: 'done', content: {} };
  }
}

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

let core, keystore, authService;
let testUser, testOrg, testUMK, testToken;
let tempDir;

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kikx-interaction-ctrl-test-'));

  core = new KikxCore({ database: { filename: ':memory:' } });
  await core.start();

  keystore = new Keystore({ devMode: true, devSeed: 'interaction-ctrl-key-test-seed' });
  keystore.initialize();
  keystore.loadServerMasterKey(tempDir);

  let context = core.getContext();
  context.setProperty('keystore', keystore);

  authService = new AuthService({ context, keystore });

  let regResult = await authService.register('interaction-ctrl@test.com', 'password123', {
    organizationName: 'Interaction Controller Test Org',
    firstName:        'Interaction',
    lastName:         'Tester',
  });

  testUser  = regResult.user;
  testOrg   = regResult.organization;
  testToken = regResult.token;

  let decoded = authService.verifyToken(testToken);
  testUMK     = authService.getUMK(decoded);

  // Register mock agent type so controller can look it up
  let registry = core.getPluginRegistry();
  if (registry && typeof registry.registerAgentType === 'function')
    registry.registerAgentType('test-mock-plugin', MockAgentPlugin);
});

after(async () => {
  keystore.destroy();
  await core.stop();

  if (tempDir && fs.existsSync(tempDir))
    fs.rmSync(tempDir, { recursive: true, force: true });
});

// Helper to create an agent (using test-mock-plugin which is registered)
async function createAgent(name = 'test-interaction-agent') {
  let { Agent } = core.getModels();
  let agent     = await Agent.create({
    organizationID: testOrg.id,
    name:           name,
    pluginID:       'test-mock-plugin',
  });

  return agent;
}

// Helper to create mock app with override interaction loop
function createMockApp(interactionLoop) {
  let context = core.getContext();
  context.setProperty('interactionLoop', interactionLoop);

  // Stub sessionManager so controller's getParticipants doesn't fail
  let stubSessionManager = {
    getParticipants: async () => [],
    getFrameManager: () => null,
  };
  context.setProperty('sessionManager', stubSessionManager);

  // Stub sessionScheduler so controller doesn't fail
  let stubScheduler = {
    setResolveContext: () => {},
    markActive:        () => {},
  };
  context.setProperty('sessionScheduler', stubScheduler);

  return {
    getCore:        () => core,
    getAuthService: () => authService,
    getKeystore:    () => keystore,
  };
}

// =============================================================================
// Gap 2: user private key passed to startInteraction (agent path)
// =============================================================================

describe('InteractionController: user private key to startInteraction (Gap 2)', () => {
  it('passes decrypted userPrivateKey to startInteraction when user has keys', async () => {
    let { Agent } = core.getModels();
    let agent     = await createAgent();

    let mockLoop = createMockInteractionLoop();
    let mockApp  = createMockApp(mockLoop);

    let req = createMockReq({
      organizationID: testOrg.id,
      userID:         testUser.id,
      getUMK:         () => testUMK,
    });
    let res        = createMockRes();
    let controller = createController(InteractionController, { mockApp, req, res });

    await controller.sendMessage({
      params: { sessionID: 'ses_test' },
      body:   { message: 'hello', agentID: agent.id },
    });

    assert.ok(mockLoop.startInteractionCalled, 'startInteraction should have been called');

    let params = mockLoop.captured.startInteractionParams;
    assert.ok(params, 'params should be captured');
    assert.ok(params.userPrivateKey, 'userPrivateKey should be passed to startInteraction');

    // Verify the passed private key is actually valid by verifying against user's public key
    let data      = 'test-payload';
    let signature = keystore.signWithPrivateKey(data, params.userPrivateKey);
    let verified  = keystore.verifyWithPublicKey(data, testUser.publicKey, signature);
    assert.equal(verified, true, 'passed private key should correspond to the user public key');
  });

  it('passes null userPrivateKey when user has no encryptedPrivateKey (legacy account)', async () => {
    // Create a user without keys (simulating legacy account)
    let { User } = core.getModels();
    let legacyUser = await User.create({
      organizationID:     testOrg.id,
      email:              'legacy-user-gap2@test.com',
      firstName:          'Legacy',
      lastName:           'User',
      passwordSlot:       JSON.stringify({ ciphertext: 'fake', iv: '00'.repeat(6), authTag: '00'.repeat(8), salt: '00'.repeat(16) }),
      publicKey:          null,
      encryptedPrivateKey: null,
    });

    let { Agent } = core.getModels();
    let agent     = await createAgent();

    let mockLoop = createMockInteractionLoop();
    let mockApp  = createMockApp(mockLoop);

    let req = createMockReq({
      organizationID: testOrg.id,
      userID:         legacyUser.id,
      getUMK:         () => testUMK,
    });
    let res        = createMockRes();
    let controller = createController(InteractionController, { mockApp, req, res });

    await controller.sendMessage({
      params: { sessionID: 'ses_test2' },
      body:   { message: 'hello from legacy', agentID: agent.id },
    });

    assert.ok(mockLoop.startInteractionCalled, 'startInteraction should have been called');

    let params = mockLoop.captured.startInteractionParams;
    assert.ok(!params.userPrivateKey, 'userPrivateKey should be null/undefined for legacy account');
  });

  it('passes null userPrivateKey when UMK is unavailable (getUMK returns null)', async () => {
    let { Agent } = core.getModels();
    let agent     = await createAgent();

    let mockLoop = createMockInteractionLoop();
    let mockApp  = createMockApp(mockLoop);

    let req = createMockReq({
      organizationID: testOrg.id,
      userID:         testUser.id,
      getUMK:         () => null, // No UMK available
    });
    let res        = createMockRes();
    let controller = createController(InteractionController, { mockApp, req, res });

    await controller.sendMessage({
      params: { sessionID: 'ses_test3' },
      body:   { message: 'hello no umk', agentID: agent.id },
    });

    assert.ok(mockLoop.startInteractionCalled, 'startInteraction should still be called');

    let params = mockLoop.captured.startInteractionParams;
    assert.ok(!params.userPrivateKey, 'userPrivateKey should be null when UMK is unavailable');
  });

  it('does not crash when user is not found in DB', async () => {
    let { Agent } = core.getModels();
    let agent     = await createAgent();

    let mockLoop = createMockInteractionLoop();
    let mockApp  = createMockApp(mockLoop);

    let req = createMockReq({
      organizationID: testOrg.id,
      userID:         'usr_nonexistent_user',
      getUMK:         () => testUMK,
    });
    let res        = createMockRes();
    let controller = createController(InteractionController, { mockApp, req, res });

    // Should not crash — just pass null for userPrivateKey
    await controller.sendMessage({
      params: { sessionID: 'ses_test4' },
      body:   { message: 'hello no user', agentID: agent.id },
    });

    assert.ok(mockLoop.startInteractionCalled, 'startInteraction should still be called');

    let params = mockLoop.captured.startInteractionParams;
    assert.ok(!params.userPrivateKey, 'userPrivateKey should be null when user not found');
  });
});

// =============================================================================
// Gap 2: user private key passed to postMessage (no-agent path)
// =============================================================================

describe('InteractionController: user private key to postMessage (Gap 2)', () => {
  it('passes decrypted userPrivateKey to postMessage when no agentID', async () => {
    let mockLoop = createMockInteractionLoop();
    let mockApp  = createMockApp(mockLoop);

    let req = createMockReq({
      organizationID: testOrg.id,
      userID:         testUser.id,
      getUMK:         () => testUMK,
    });
    let res        = createMockRes();
    let controller = createController(InteractionController, { mockApp, req, res });

    await controller.sendMessage({
      params: { sessionID: 'ses_post_test' },
      body:   { message: 'hello no agent' },  // No agentID → postMessage path
    });

    assert.ok(mockLoop.postMessageCalled, 'postMessage should have been called');

    let opts = mockLoop.captured.postMessageOpts;
    assert.ok(opts, 'postMessage opts should be captured');
    assert.ok(opts.userPrivateKey, 'userPrivateKey should be passed to postMessage');

    // Verify the passed private key is valid
    let data      = 'test-payload';
    let signature = keystore.signWithPrivateKey(data, opts.userPrivateKey);
    let verified  = keystore.verifyWithPublicKey(data, testUser.publicKey, signature);
    assert.equal(verified, true, 'passed private key should correspond to user public key');
  });

  it('passes null userPrivateKey to postMessage when user has no encryptedPrivateKey', async () => {
    let { User } = core.getModels();
    let legacyUser = await User.create({
      organizationID:      testOrg.id,
      email:               'legacy-post@test.com',
      firstName:           'Legacy',
      lastName:            'Post',
      passwordSlot:        JSON.stringify({ ciphertext: 'fake', iv: '00'.repeat(6), authTag: '00'.repeat(8), salt: '00'.repeat(16) }),
      publicKey:           null,
      encryptedPrivateKey: null,
    });

    let mockLoop = createMockInteractionLoop();
    let mockApp  = createMockApp(mockLoop);

    let req = createMockReq({
      organizationID: testOrg.id,
      userID:         legacyUser.id,
      getUMK:         () => testUMK,
    });
    let res        = createMockRes();
    let controller = createController(InteractionController, { mockApp, req, res });

    await controller.sendMessage({
      params: { sessionID: 'ses_post_test2' },
      body:   { message: 'hello legacy no agent' },
    });

    assert.ok(mockLoop.postMessageCalled, 'postMessage should have been called');

    let opts = mockLoop.captured.postMessageOpts;
    assert.ok(!opts.userPrivateKey, 'userPrivateKey should be null for legacy account');
  });

  it('passes null userPrivateKey to postMessage when UMK is null', async () => {
    let mockLoop = createMockInteractionLoop();
    let mockApp  = createMockApp(mockLoop);

    let req = createMockReq({
      organizationID: testOrg.id,
      userID:         testUser.id,
      getUMK:         () => null, // No UMK
    });
    let res        = createMockRes();
    let controller = createController(InteractionController, { mockApp, req, res });

    await controller.sendMessage({
      params: { sessionID: 'ses_post_test3' },
      body:   { message: 'hello no umk no agent' },
    });

    assert.ok(mockLoop.postMessageCalled, 'postMessage should still be called');

    let opts = mockLoop.captured.postMessageOpts;
    assert.ok(!opts.userPrivateKey, 'userPrivateKey should be null when UMK unavailable');
  });
});

// =============================================================================
// InteractionController: _loadUserSigningKeys failure paths
// =============================================================================

describe('InteractionController: _loadUserSigningKeys failure paths', () => {
  it('malformed JSON in encryptedPrivateKey → caught, returns null privateKey with publicKey', async () => {
    // Create a user with malformed JSON in encryptedPrivateKey
    let { User } = core.getModels();
    let malformedUser = await User.create({
      organizationID:      testOrg.id,
      email:               'malformed-json@test.com',
      firstName:           'Malformed',
      lastName:            'JSON',
      passwordSlot:        JSON.stringify({ ciphertext: 'fake', iv: '00'.repeat(6), authTag: '00'.repeat(8), salt: '00'.repeat(16) }),
      publicKey:           testUser.publicKey,
      encryptedPrivateKey: 'not-valid-json{{{',
    });

    let mockLoop = createMockInteractionLoop();
    let mockApp  = createMockApp(mockLoop);

    let req = createMockReq({
      organizationID: testOrg.id,
      userID:         malformedUser.id,
      getUMK:         () => testUMK,
    });
    let res        = createMockRes();
    let controller = createController(InteractionController, { mockApp, req, res });

    // sendMessage → no-agent path (postMessage)
    await controller.sendMessage({
      params: { sessionID: 'ses_malformed_json' },
      body:   { message: 'hello malformed' },
    });

    assert.ok(mockLoop.postMessageCalled, 'postMessage should still be called despite malformed JSON');

    let opts = mockLoop.captured.postMessageOpts;
    // Malformed JSON in encryptedPrivateKey → _loadUserSigningKeys catch block → null privateKey
    assert.ok(!opts.userPrivateKey, 'privateKey should be null when encryptedPrivateKey is malformed JSON');
  });

  it('decryptUserPrivateKey() throws (bad UMK) → caught, returns null keys', async () => {
    let brokenKeystore = {
      ...keystore,
      deriveUserKey:          (...args) => keystore.deriveUserKey(...args),
      decryptUserPrivateKey:  () => { throw new Error('bad UMK: decryption failed'); },
    };

    let context = core.getContext();
    context.setProperty('keystore', brokenKeystore);

    let brokenApp = {
      getCore:        () => core,
      getAuthService: () => authService,
      getKeystore:    () => brokenKeystore,
    };

    let mockLoop = createMockInteractionLoop();

    // Minimal session/scheduler stubs
    context.setProperty('interactionLoop', mockLoop);
    let stubSessionManager = {
      getParticipants: async () => [],
      getFrameManager: () => null,
    };
    context.setProperty('sessionManager', stubSessionManager);
    let stubScheduler = {
      setResolveContext: () => {},
      markActive:        () => {},
    };
    context.setProperty('sessionScheduler', stubScheduler);

    let req = createMockReq({
      organizationID: testOrg.id,
      userID:         testUser.id,
      getUMK:         () => testUMK,
    });
    let res        = createMockRes();
    let controller = createController(InteractionController, { mockApp: brokenApp, req, res });

    await controller.sendMessage({
      params: { sessionID: 'ses_bad_umk' },
      body:   { message: 'hello bad umk' },
    });

    assert.ok(mockLoop.postMessageCalled, 'postMessage should be called despite decryption failure');

    let opts = mockLoop.captured.postMessageOpts;
    assert.ok(!opts.userPrivateKey, 'privateKey should be null when decryptUserPrivateKey throws');

    // Restore real keystore
    context.setProperty('keystore', keystore);
  });

  it('envelope missing iv/ciphertext/authTag fields → decryptUserPrivateKey called with incomplete data, does not crash', async () => {
    // Envelope is valid JSON but missing required fields
    let { User } = core.getModels();
    let incompleteUser = await User.create({
      organizationID:      testOrg.id,
      email:               'incomplete-envelope@test.com',
      firstName:           'Incomplete',
      lastName:            'Envelope',
      passwordSlot:        JSON.stringify({ ciphertext: 'fake', iv: '00'.repeat(6), authTag: '00'.repeat(8), salt: '00'.repeat(16) }),
      publicKey:           testUser.publicKey,
      encryptedPrivateKey: JSON.stringify({ someField: 'value' }), // no iv/ciphertext/authTag
    });

    let mockLoop = createMockInteractionLoop();
    let mockApp  = createMockApp(mockLoop);

    let req = createMockReq({
      organizationID: testOrg.id,
      userID:         incompleteUser.id,
      getUMK:         () => testUMK,
    });
    let res        = createMockRes();
    let controller = createController(InteractionController, { mockApp, req, res });

    // Should not throw — _loadUserSigningKeys has a top-level try/catch
    await controller.sendMessage({
      params: { sessionID: 'ses_incomplete_envelope' },
      body:   { message: 'hello incomplete' },
    });

    assert.ok(mockLoop.postMessageCalled, 'postMessage should still be called');

    let opts = mockLoop.captured.postMessageOpts;
    assert.ok(!opts.userPrivateKey, 'privateKey should be null with incomplete envelope');
  });

  it('request.getUMK() throws → caught, returns null keys, message delivery continues', async () => {
    let mockLoop = createMockInteractionLoop();
    let mockApp  = createMockApp(mockLoop);

    let req = createMockReq({
      organizationID: testOrg.id,
      userID:         testUser.id,
      getUMK:         () => { throw new Error('vault unavailable'); },
    });
    let res        = createMockRes();
    let controller = createController(InteractionController, { mockApp, req, res });

    await controller.sendMessage({
      params: { sessionID: 'ses_getumk_throws' },
      body:   { message: 'hello throwing umk' },
    });

    assert.ok(mockLoop.postMessageCalled, 'postMessage should still be called when getUMK() throws');

    let opts = mockLoop.captured.postMessageOpts;
    assert.ok(!opts.userPrivateKey, 'privateKey should be null when getUMK() throws');
  });

  it('user has empty publicKey → publicKey returned as-is (empty string)', async () => {
    // Create user with empty publicKey but valid encryptedPrivateKey structure
    let { User } = core.getModels();
    let emptyPubKeyUser = await User.create({
      organizationID:      testOrg.id,
      email:               'empty-pubkey@test.com',
      firstName:           'Empty',
      lastName:            'PubKey',
      passwordSlot:        JSON.stringify({ ciphertext: 'fake', iv: '00'.repeat(6), authTag: '00'.repeat(8), salt: '00'.repeat(16) }),
      publicKey:           '',
      encryptedPrivateKey: null, // no private key, so we test the null-key branch
    });

    let mockLoop = createMockInteractionLoop();
    let mockApp  = createMockApp(mockLoop);

    let req = createMockReq({
      organizationID: testOrg.id,
      userID:         emptyPubKeyUser.id,
      getUMK:         () => testUMK,
    });
    let res        = createMockRes();
    let controller = createController(InteractionController, { mockApp, req, res });

    await controller.sendMessage({
      params: { sessionID: 'ses_empty_pubkey' },
      body:   { message: 'hello empty pubkey' },
    });

    assert.ok(mockLoop.postMessageCalled, 'postMessage should be called');

    let opts = mockLoop.captured.postMessageOpts;
    // privateKey is null (no encryptedPrivateKey), publicKey is empty string → returned as-is
    assert.ok(!opts.userPrivateKey, 'privateKey should be null');
    // publicKey is null because '' || null evaluates to null in the impl
    assert.ok(opts.userPublicKey == null, 'empty publicKey should be returned as null (falsy coercion)');
  });
});
