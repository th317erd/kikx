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
import { AuthController }  from '../../../src/server/controllers/auth-controller.mjs';

// =============================================================================
// Helpers
// =============================================================================

function createMockApp({ core, authService, keystore }) {
  return {
    getCore:        () => core,
    getAuthService: () => authService,
    getKeystore:    () => keystore,
  };
}

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
    _written: '',
    _ended:   false,
    status(code) { res._status = code; return res; },
    json(data)   { res._json = data; return res; },
    setHeader(key, val) { res._headers[key] = val; return res; },
    header(key, val) { res._headers[key] = val; return res; },
    write(data)  { res._written = (res._written || '') + data; return res; },
    end()        { res._ended = true; },
    send(data)   { res._sent = data; return res; },
  };

  return res;
}

function createController(ControllerClass, { mockApp, req, res }) {
  return new ControllerClass(mockApp, null, req, res);
}

// =============================================================================
// Shared Setup
// =============================================================================

let core, keystore, authService, mockApp;
let testUser, testToken, testOrg, testUMK;
let tempDir;

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kikx-risklevel-test-'));

  core = new KikxCore({ database: { filename: ':memory:' } });
  await core.start();

  keystore = new Keystore({ devMode: true, devSeed: 'test-risklevel-seed' });
  keystore.initialize();
  keystore.loadServerMasterKey(tempDir);

  let context = core.getContext();
  context.setProperty('keystore', keystore);

  authService = new AuthService({ context, keystore });
  mockApp     = createMockApp({ core, authService, keystore });

  // Create a test user for authenticated routes
  let regResult = await authService.register('risklevel@test.com', 'password123', {
    organizationName: 'RiskLevel Test Org',
    firstName:        'Risk',
    lastName:         'Tester',
  });

  testUser  = regResult.user;
  testToken = regResult.token;
  testOrg   = regResult.organization;

  let decoded = authService.verifyToken(testToken);
  testUMK     = authService.getUMK(decoded);
});

after(async () => {
  keystore.destroy();
  await core.stop();

  if (tempDir && fs.existsSync(tempDir))
    fs.rmSync(tempDir, { recursive: true, force: true });
});

// =============================================================================
// Agent riskLevel via Controller
// =============================================================================

describe('AgentController: create with riskLevel', () => {
  it('should create agent with riskLevel "strict"', async () => {
    let req = createMockReq({
      organizationID: testOrg.id,
      userID:         testUser.id,
      getUMK:         () => testUMK,
    });
    let res        = createMockRes();
    let controller = createController(AgentController, { mockApp, req, res });
    let result     = await controller.create({
      body: { name: 'test-rl-strict', pluginID: 'claude-agent', riskLevel: 'strict' },
    });

    assert.equal(controller.responseStatusCode, 201);
    assert.ok(result.data.agent);
    assert.equal(result.data.riskLevel, 'strict');
  });

  it('should create agent with riskLevel "normal"', async () => {
    let req = createMockReq({
      organizationID: testOrg.id,
      userID:         testUser.id,
      getUMK:         () => testUMK,
    });
    let res        = createMockRes();
    let controller = createController(AgentController, { mockApp, req, res });
    let result     = await controller.create({
      body: { name: 'test-rl-normal', pluginID: 'claude-agent', riskLevel: 'normal' },
    });

    assert.equal(controller.responseStatusCode, 201);
    assert.equal(result.data.riskLevel, 'normal');
  });

  it('should create agent with riskLevel "permissive"', async () => {
    let req = createMockReq({
      organizationID: testOrg.id,
      userID:         testUser.id,
      getUMK:         () => testUMK,
    });
    let res        = createMockRes();
    let controller = createController(AgentController, { mockApp, req, res });
    let result     = await controller.create({
      body: { name: 'test-rl-permissive', pluginID: 'claude-agent', riskLevel: 'permissive' },
    });

    assert.equal(controller.responseStatusCode, 201);
    assert.equal(result.data.riskLevel, 'permissive');
  });

  it('should create agent without riskLevel (default null)', async () => {
    let req = createMockReq({
      organizationID: testOrg.id,
      userID:         testUser.id,
      getUMK:         () => testUMK,
    });
    let res        = createMockRes();
    let controller = createController(AgentController, { mockApp, req, res });
    let result     = await controller.create({
      body: { name: 'test-rl-none', pluginID: 'claude-agent' },
    });

    assert.equal(controller.responseStatusCode, 201);
    assert.equal(result.data.riskLevel, null);
  });

  it('should throw 400 for invalid riskLevel on create', async () => {
    let req = createMockReq({
      organizationID: testOrg.id,
      userID:         testUser.id,
      getUMK:         () => testUMK,
    });
    let res        = createMockRes();
    let controller = createController(AgentController, { mockApp, req, res });

    await assert.rejects(
      () => controller.create({
        body: { name: 'test-rl-bad', pluginID: 'claude-agent', riskLevel: 'dangerous' },
      }),
      (error) => error.message.includes('Invalid riskLevel'),
    );
  });

  it('should throw 400 for numeric riskLevel on create', async () => {
    let req = createMockReq({
      organizationID: testOrg.id,
      userID:         testUser.id,
      getUMK:         () => testUMK,
    });
    let res        = createMockRes();
    let controller = createController(AgentController, { mockApp, req, res });

    await assert.rejects(
      () => controller.create({
        body: { name: 'test-rl-number', pluginID: 'claude-agent', riskLevel: 42 },
      }),
      (error) => error.message.includes('Invalid riskLevel'),
    );
  });
});

describe('AgentController: update with riskLevel', () => {
  it('should update agent riskLevel', async () => {
    let { Agent } = core.getModels();
    let agent     = await Agent.create({
      organizationID: testOrg.id,
      name:           'test-rl-update',
      pluginID:       'claude-agent',
    });

    let req        = createMockReq();
    let res        = createMockRes();
    let controller = createController(AgentController, { mockApp, req, res });
    let result     = await controller.update({
      params: { agentID: agent.id },
      body:   { riskLevel: 'permissive' },
    });

    assert.equal(result.data.riskLevel, 'permissive');
  });

  it('should clear riskLevel when set to null', async () => {
    let { Agent } = core.getModels();
    let agent     = await Agent.create({
      organizationID: testOrg.id,
      name:           'test-rl-clear',
      pluginID:       'claude-agent',
    });

    // Set riskLevel first
    await agent.updateConfig({ riskLevel: 'strict' });

    let req        = createMockReq();
    let res        = createMockRes();
    let controller = createController(AgentController, { mockApp, req, res });
    let result     = await controller.update({
      params: { agentID: agent.id },
      body:   { riskLevel: null },
    });

    assert.equal(result.data.riskLevel, null);
  });

  it('should clear riskLevel when set to empty string', async () => {
    let { Agent } = core.getModels();
    let agent     = await Agent.create({
      organizationID: testOrg.id,
      name:           'test-rl-empty',
      pluginID:       'claude-agent',
    });

    // Set riskLevel first
    await agent.updateConfig({ riskLevel: 'normal' });

    let req        = createMockReq();
    let res        = createMockRes();
    let controller = createController(AgentController, { mockApp, req, res });
    let result     = await controller.update({
      params: { agentID: agent.id },
      body:   { riskLevel: '' },
    });

    assert.equal(result.data.riskLevel, null);
  });

  it('should not change riskLevel when undefined', async () => {
    let { Agent } = core.getModels();
    let agent     = await Agent.create({
      organizationID: testOrg.id,
      name:           'test-rl-undef',
      pluginID:       'claude-agent',
    });

    // Set riskLevel first
    await agent.updateConfig({ riskLevel: 'strict' });

    let req        = createMockReq();
    let res        = createMockRes();
    let controller = createController(AgentController, { mockApp, req, res });
    let result     = await controller.update({
      params: { agentID: agent.id },
      body:   { name: 'test-rl-undef-renamed' },
    });

    // riskLevel should remain unchanged
    assert.equal(result.data.riskLevel, 'strict');
    assert.equal(result.data.agent.name, 'test-rl-undef-renamed');
  });

  it('should throw 400 for invalid riskLevel on update', async () => {
    let { Agent } = core.getModels();
    let agent     = await Agent.create({
      organizationID: testOrg.id,
      name:           'test-rl-bad-update',
      pluginID:       'claude-agent',
    });

    let req        = createMockReq();
    let res        = createMockRes();
    let controller = createController(AgentController, { mockApp, req, res });

    await assert.rejects(
      () => controller.update({
        params: { agentID: agent.id },
        body:   { riskLevel: 'yolo' },
      }),
      (error) => error.message.includes('Invalid riskLevel'),
    );
  });

  it('should preserve other config when updating riskLevel', async () => {
    let { Agent } = core.getModels();
    let agent     = await Agent.create({
      organizationID: testOrg.id,
      name:           'test-rl-preserve',
      pluginID:       'claude-agent',
    });

    // Set some other config alongside riskLevel
    await agent.updateConfig({ riskLevel: 'normal', abilities: 'can do stuff' });

    let req        = createMockReq();
    let res        = createMockRes();
    let controller = createController(AgentController, { mockApp, req, res });
    await controller.update({
      params: { agentID: agent.id },
      body:   { riskLevel: 'permissive' },
    });

    // Verify abilities weren't wiped
    let config = await agent.getConfig();
    assert.equal(config.riskLevel, 'permissive');
    assert.equal(config.abilities, 'can do stuff');
  });
});

describe('AgentController: show with riskLevel', () => {
  it('should return riskLevel in show response', async () => {
    let { Agent } = core.getModels();
    let agent     = await Agent.create({
      organizationID: testOrg.id,
      name:           'test-rl-show',
      pluginID:       'claude-agent',
    });

    await agent.updateConfig({ riskLevel: 'strict' });

    let req        = createMockReq();
    let res        = createMockRes();
    let controller = createController(AgentController, { mockApp, req, res });
    let result     = await controller.show({ params: { agentID: agent.id } });

    assert.ok(result.data.agent);
    assert.equal(result.data.riskLevel, 'strict');
  });

  it('should return null riskLevel when not set', async () => {
    let { Agent } = core.getModels();
    let agent     = await Agent.create({
      organizationID: testOrg.id,
      name:           'test-rl-show-none',
      pluginID:       'claude-agent',
    });

    let req        = createMockReq();
    let res        = createMockRes();
    let controller = createController(AgentController, { mockApp, req, res });
    let result     = await controller.show({ params: { agentID: agent.id } });

    assert.equal(result.data.riskLevel, null);
  });
});

describe('AgentController: list with riskLevel', () => {
  it('should return riskLevel for each agent in list', async () => {
    // Create a fresh org so we have a clean list
    let { Agent, Organization } = core.getModels();
    let org = await Organization.create({ name: 'RiskLevel List Org' });

    let agent1 = await Agent.create({ organizationID: org.id, name: 'test-rl-list-1', pluginID: 'claude-agent' });
    let agent2 = await Agent.create({ organizationID: org.id, name: 'test-rl-list-2', pluginID: 'claude-agent' });

    await agent1.updateConfig({ riskLevel: 'strict' });
    // agent2 has no riskLevel

    let req        = createMockReq({ organizationID: org.id });
    let res        = createMockRes();
    let controller = createController(AgentController, { mockApp, req, res });
    let result     = await controller.list();

    assert.ok(Array.isArray(result.data.agents));
    assert.equal(result.data.agents.length, 2);

    let agent1Entry = result.data.agents.find((entry) => entry.agent.id === agent1.id);
    let agent2Entry = result.data.agents.find((entry) => entry.agent.id === agent2.id);

    assert.equal(agent1Entry.riskLevel, 'strict');
    assert.equal(agent2Entry.riskLevel, null);
  });
});

// =============================================================================
// User riskLevel via AuthController
// =============================================================================

describe('AuthController: me with riskLevel', () => {
  it('should return default riskLevel "normal" in me response', async () => {
    let req        = createMockReq({ userID: testUser.id, organizationID: testOrg.id });
    let res        = createMockRes();
    let controller = createController(AuthController, { mockApp, req, res });
    let result     = await controller.me();

    assert.equal(result.data.id, testUser.id);
    assert.equal(result.data.riskLevel, 'normal');
  });
});

describe('AuthController: updateProfile with riskLevel', () => {
  it('should update riskLevel to "strict"', async () => {
    let req = createMockReq({
      userID:         testUser.id,
      organizationID: testOrg.id,
      getUMK:         () => testUMK,
    });
    let res        = createMockRes();
    let controller = createController(AuthController, { mockApp, req, res });
    let result     = await controller.updateProfile({
      body: { riskLevel: 'strict' },
    });

    assert.equal(result.data.riskLevel, 'strict');
  });

  it('should update riskLevel to "permissive"', async () => {
    let req = createMockReq({
      userID:         testUser.id,
      organizationID: testOrg.id,
      getUMK:         () => testUMK,
    });
    let res        = createMockRes();
    let controller = createController(AuthController, { mockApp, req, res });
    let result     = await controller.updateProfile({
      body: { riskLevel: 'permissive' },
    });

    assert.equal(result.data.riskLevel, 'permissive');
  });

  it('should update riskLevel to "normal"', async () => {
    let req = createMockReq({
      userID:         testUser.id,
      organizationID: testOrg.id,
      getUMK:         () => testUMK,
    });
    let res        = createMockRes();
    let controller = createController(AuthController, { mockApp, req, res });
    let result     = await controller.updateProfile({
      body: { riskLevel: 'normal' },
    });

    assert.equal(result.data.riskLevel, 'normal');
  });

  it('should throw for invalid riskLevel in updateProfile', async () => {
    let req = createMockReq({
      userID:         testUser.id,
      organizationID: testOrg.id,
      getUMK:         () => testUMK,
    });
    let res        = createMockRes();
    let controller = createController(AuthController, { mockApp, req, res });

    await assert.rejects(
      () => controller.updateProfile({
        body: { riskLevel: 'maximum' },
      }),
      (error) => error.message.includes('Invalid riskLevel'),
    );
  });

  it('should not change riskLevel when undefined in body', async () => {
    // First set a known value
    let req1 = createMockReq({
      userID:         testUser.id,
      organizationID: testOrg.id,
      getUMK:         () => testUMK,
    });
    let res1        = createMockRes();
    let controller1 = createController(AuthController, { mockApp, req: req1, res: res1 });
    await controller1.updateProfile({ body: { riskLevel: 'strict' } });

    // Now update profile without riskLevel
    let req2 = createMockReq({
      userID:         testUser.id,
      organizationID: testOrg.id,
      getUMK:         () => testUMK,
    });
    let res2        = createMockRes();
    let controller2 = createController(AuthController, { mockApp, req: req2, res: res2 });
    let result      = await controller2.updateProfile({
      body: { firstName: 'Updated' },
    });

    // riskLevel should remain "strict" since it wasn't in the body
    assert.equal(result.data.riskLevel, 'strict');
    assert.equal(result.data.firstName, 'Updated');
  });

  it('should clear riskLevel when set to null (falls back to default)', async () => {
    // First set a known value
    let req1 = createMockReq({
      userID:         testUser.id,
      organizationID: testOrg.id,
      getUMK:         () => testUMK,
    });
    let res1        = createMockRes();
    let controller1 = createController(AuthController, { mockApp, req: req1, res: res1 });
    await controller1.updateProfile({ body: { riskLevel: 'permissive' } });

    // Now clear it
    let req2 = createMockReq({
      userID:         testUser.id,
      organizationID: testOrg.id,
      getUMK:         () => testUMK,
    });
    let res2        = createMockRes();
    let controller2 = createController(AuthController, { mockApp, req: req2, res: res2 });
    let result      = await controller2.updateProfile({
      body: { riskLevel: null },
    });

    // Should fall back to default "normal"
    assert.equal(result.data.riskLevel, 'normal');
  });

  it('should update profile fields alongside riskLevel', async () => {
    let req = createMockReq({
      userID:         testUser.id,
      organizationID: testOrg.id,
      getUMK:         () => testUMK,
    });
    let res        = createMockRes();
    let controller = createController(AuthController, { mockApp, req, res });
    let result     = await controller.updateProfile({
      body: { firstName: 'NewName', riskLevel: 'strict' },
    });

    assert.equal(result.data.firstName, 'NewName');
    assert.equal(result.data.riskLevel, 'strict');
  });
});

// =============================================================================
// Model-level integration: Agent riskLevel
// =============================================================================

describe('Agent model: riskLevel via config', () => {
  it('should store and retrieve riskLevel via updateConfig/getConfig', async () => {
    let { Agent } = core.getModels();
    let agent     = await Agent.create({
      organizationID: testOrg.id,
      name:           'test-rl-model',
      pluginID:       'claude-agent',
    });

    await agent.updateConfig({ riskLevel: 'strict' });
    let config = await agent.getConfig();

    assert.equal(config.riskLevel, 'strict');
  });

  it('should clear riskLevel via updateConfig with null', async () => {
    let { Agent } = core.getModels();
    let agent     = await Agent.create({
      organizationID: testOrg.id,
      name:           'test-rl-model-clear',
      pluginID:       'claude-agent',
    });

    await agent.updateConfig({ riskLevel: 'permissive' });
    await agent.updateConfig({ riskLevel: null });

    let config = await agent.getConfig();
    assert.equal(config.riskLevel, undefined);
  });

  it('should not expose riskLevel in getSafeConfig', async () => {
    let { Agent } = core.getModels();
    let agent     = await Agent.create({
      organizationID: testOrg.id,
      name:           'test-rl-safe',
      pluginID:       'claude-agent',
    });

    await agent.updateConfig({ riskLevel: 'strict', abilities: 'test abilities' });
    let safeConfig = await agent.getSafeConfig();

    assert.equal(safeConfig.riskLevel, undefined);
    assert.equal(safeConfig.abilities, 'test abilities');
  });
});

// =============================================================================
// Model-level integration: User riskLevel
// =============================================================================

describe('User model: riskLevel via settings', () => {
  it('should return default riskLevel "normal" when no settings exist', async () => {
    // Create a fresh user to test defaults
    let regResult = await authService.register('default-rl@test.com', 'password123', {
      organizationName: 'Default RL Org',
      firstName:        'Default',
      lastName:         'User',
    });

    let settings = await regResult.user.getSettings();
    assert.equal(settings.riskLevel, 'normal');
  });

  it('should store and retrieve riskLevel via updateSettings', async () => {
    let regResult = await authService.register('store-rl@test.com', 'password123', {
      organizationName: 'Store RL Org',
      firstName:        'Store',
      lastName:         'User',
    });

    let user    = regResult.user;
    let decoded = authService.verifyToken(regResult.token);
    let umk     = authService.getUMK(decoded);

    let privateKeyPEM = keystore.decryptUserPrivateKey(
      JSON.parse(user.encryptedPrivateKey),
      umk,
      user.id,
    );

    await user.updateSettings({ riskLevel: 'permissive' }, keystore, privateKeyPEM);

    let settings = await user.getSettings();
    assert.equal(settings.riskLevel, 'permissive');
  });

  it('should reject invalid riskLevel in updateSettings', async () => {
    let regResult = await authService.register('invalid-rl@test.com', 'password123', {
      organizationName: 'Invalid RL Org',
      firstName:        'Invalid',
      lastName:         'User',
    });

    let user    = regResult.user;
    let decoded = authService.verifyToken(regResult.token);
    let umk     = authService.getUMK(decoded);

    let privateKeyPEM = keystore.decryptUserPrivateKey(
      JSON.parse(user.encryptedPrivateKey),
      umk,
      user.id,
    );

    await assert.rejects(
      () => user.updateSettings({ riskLevel: 'extreme' }, keystore, privateKeyPEM),
      (error) => error.message.includes('Invalid riskLevel'),
    );
  });

  it('should require privateKeyPEM when updating riskLevel', async () => {
    let regResult = await authService.register('nokey-rl@test.com', 'password123', {
      organizationName: 'NoKey RL Org',
      firstName:        'NoKey',
      lastName:         'User',
    });

    let user = regResult.user;

    await assert.rejects(
      () => user.updateSettings({ riskLevel: 'strict' }),
      (error) => error.message.includes('privateKeyPEM is required'),
    );
  });
});

// =============================================================================
// Edge cases
// =============================================================================

describe('riskLevel edge cases', () => {
  it('should reject empty string riskLevel on agent create', async () => {
    let req = createMockReq({
      organizationID: testOrg.id,
      userID:         testUser.id,
      getUMK:         () => testUMK,
    });
    let res        = createMockRes();
    let controller = createController(AgentController, { mockApp, req, res });

    // Empty string on create should just be treated as not provided (falsy)
    let result = await controller.create({
      body: { name: 'test-rl-empty-create', pluginID: 'claude-agent', riskLevel: '' },
    });

    // Empty string is falsy, so riskLevel is not set
    assert.equal(result.data.riskLevel, null);
  });

  it('should reject boolean riskLevel on agent create', async () => {
    let req = createMockReq({
      organizationID: testOrg.id,
      userID:         testUser.id,
      getUMK:         () => testUMK,
    });
    let res        = createMockRes();
    let controller = createController(AgentController, { mockApp, req, res });

    await assert.rejects(
      () => controller.create({
        body: { name: 'test-rl-bool', pluginID: 'claude-agent', riskLevel: true },
      }),
      (error) => error.message.includes('Invalid riskLevel'),
    );
  });

  it('should reject object riskLevel on agent create', async () => {
    let req = createMockReq({
      organizationID: testOrg.id,
      userID:         testUser.id,
      getUMK:         () => testUMK,
    });
    let res        = createMockRes();
    let controller = createController(AgentController, { mockApp, req, res });

    await assert.rejects(
      () => controller.create({
        body: { name: 'test-rl-obj', pluginID: 'claude-agent', riskLevel: { level: 'strict' } },
      }),
      (error) => error.message.includes('Invalid riskLevel'),
    );
  });

  it('should reject boolean riskLevel on agent update', async () => {
    let { Agent } = core.getModels();
    let agent     = await Agent.create({
      organizationID: testOrg.id,
      name:           'test-rl-bool-update',
      pluginID:       'claude-agent',
    });

    let req        = createMockReq();
    let res        = createMockRes();
    let controller = createController(AgentController, { mockApp, req, res });

    await assert.rejects(
      () => controller.update({
        params: { agentID: agent.id },
        body:   { riskLevel: false },
      }),
      (error) => error.message.includes('Invalid riskLevel'),
    );
  });

  it('should handle me() for user that has custom riskLevel', async () => {
    // Set riskLevel first
    let req1 = createMockReq({
      userID:         testUser.id,
      organizationID: testOrg.id,
      getUMK:         () => testUMK,
    });
    let res1        = createMockRes();
    let controller1 = createController(AuthController, { mockApp, req: req1, res: res1 });
    await controller1.updateProfile({ body: { riskLevel: 'permissive' } });

    // Now verify me() returns it
    let req2 = createMockReq({
      userID:         testUser.id,
      organizationID: testOrg.id,
    });
    let res2        = createMockRes();
    let controller2 = createController(AuthController, { mockApp, req: req2, res: res2 });
    let result      = await controller2.me();

    assert.equal(result.data.riskLevel, 'permissive');
  });

  it('should handle case-sensitive riskLevel values (reject uppercase)', async () => {
    let req = createMockReq({
      organizationID: testOrg.id,
      userID:         testUser.id,
      getUMK:         () => testUMK,
    });
    let res        = createMockRes();
    let controller = createController(AgentController, { mockApp, req, res });

    await assert.rejects(
      () => controller.create({
        body: { name: 'test-rl-uppercase', pluginID: 'claude-agent', riskLevel: 'Strict' },
      }),
      (error) => error.message.includes('Invalid riskLevel'),
    );
  });

  it('should handle case-sensitive riskLevel "NORMAL" (reject)', async () => {
    let req = createMockReq({
      organizationID: testOrg.id,
      userID:         testUser.id,
      getUMK:         () => testUMK,
    });
    let res        = createMockRes();
    let controller = createController(AgentController, { mockApp, req, res });

    await assert.rejects(
      () => controller.create({
        body: { name: 'test-rl-allcaps', pluginID: 'claude-agent', riskLevel: 'NORMAL' },
      }),
      (error) => error.message.includes('Invalid riskLevel'),
    );
  });
});
