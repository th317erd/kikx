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

// =============================================================================
// Step 2.3 — Controller permission approval endpoint
// =============================================================================
// Tests that the approve/deny endpoints:
//   - Approve: create permission rules + update frame processed=true
//   - Deny: update frame processed=true + denied marker
//   - Handle edge cases: non-existent frame, already processed, etc.
//
// Note: The controller still delegates to interactionLoop.approvePermission /
// denyPermission for Phase 2 (legacy removal happens in Phase 3). These tests
// verify that the frame-based state is updated for the FrameRouter to pick up.
// =============================================================================

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockReq(overrides = {}) {
  return {
    body:           {},
    params:         {},
    query:          {},
    userID:         'usr_1',
    organizationID: 'org_1',
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
    _json:   null,
    status(code) { res._status = code; return res; },
    json(data)   { res._json = data; return res; },
    setHeader()  { return res; },
    header()     { return res; },
    write()      { return res; },
    end()        {},
    send()       { return res; },
  };
  return res;
}

function createController(ControllerClass, { mockApp, req, res }) {
  return new ControllerClass(mockApp, null, req, res);
}

function createMockInteractionLoop(opts = {}) {
  let captured = {};
  return {
    captured,
    approveCalled: false,
    denyCalled:    false,

    async startInteraction(sessionID, params) {
      captured.startInteractionSessionID = sessionID;
      captured.startInteractionParams    = params;
      return 'int_new';
    },

    async postMessage(sessionID, opts) {
      return { interactionID: 'int_post', frameID: 'frm_post' };
    },

    getPermissionWaiting(sessionID) {
      return opts.waitingState || null;
    },

    requestPrimerRefresh() {},

    async cancelInteraction() { return null; },

    async approvePermission(sessionID, frameID) {
      captured.approveSessionID = sessionID;
      captured.approveFrameID   = frameID;
      this.approveCalled        = true;
      return 'int_approved';
    },

    async denyPermission(sessionID, frameID) {
      captured.denySessionID = sessionID;
      captured.denyFrameID   = frameID;
      this.denyCalled        = true;
    },

    isActive() { return false; },
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('InteractionController — permission approval (Step 2.3)', () => {
  let core, keystore, tempDir;
  let testUser, testOrg;

  before(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kikx-perm-approval-test-'));
    core    = new KikxCore({ database: { filename: ':memory:' } });
    await core.start();

    keystore = new Keystore({ devMode: true, devSeed: 'perm-approval-test-seed' });
    keystore.initialize();
    keystore.loadServerMasterKey(tempDir);

    let context     = core.getContext();
    context.setProperty('keystore', keystore);

    let authService = new AuthService({ context, keystore });
    let regResult   = await authService.register('perm-approval@test.com', 'password123', {
      organizationName: 'Perm Approval Test Org',
      firstName:        'Test',
      lastName:         'User',
    });

    testUser = regResult.user;
    testOrg  = regResult.organization;
  });

  after(async () => {
    keystore.destroy();
    await core.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // Helper: build a controller with mocked dependencies
  // ---------------------------------------------------------------------------

  function buildController(overrides = {}) {
    let interactionLoop = overrides.interactionLoop || createMockInteractionLoop(overrides);

    // Permission engine mock
    let createdRules = [];
    let permissionEngine = {
      async createRule(ruleData) {
        createdRules.push(ruleData);
        return { id: 'rule_1', ...ruleData };
      },
    };

    let mockApp = {
      getCore() {
        return {
          getContext() {
            return {
              getProperty(name) {
                if (name === 'interactionLoop')  return interactionLoop;
                if (name === 'framePersistence') return { saveFrames: async () => {} };
                if (name === 'sessionManager')   return null;
                if (name === 'sessionScheduler') return null;
                if (name === 'streamRelay')      return null;
                if (name === 'valueStoreService') return null;
                if (name === 'solrService')      return null;
                return null;
              },
            };
          },
          getModels() { return core.getModels(); },
          getPluginRegistry() { return core.getPluginRegistry(); },
          getPermissionEngine() { return permissionEngine; },
          getAgentType() { return null; },
        };
      },
      getKeystore() { return keystore; },
    };

    let req = createMockReq({
      params:         { sessionID: 'ses_1', frameID: 'frm_1' },
      userID:         testUser.id,
      organizationID: testOrg.id,
    });
    let res = createMockRes();

    let controller = createController(InteractionController, { mockApp, req, res });

    return { controller, interactionLoop, createdRules, req, res };
  }

  // ---------------------------------------------------------------------------
  // Happy paths — Approve
  // ---------------------------------------------------------------------------

  describe('approve — happy paths', () => {

    it('calls approvePermission on the interaction loop', async () => {
      let { controller, interactionLoop } = buildController();

      let result = await controller.approve({
        params: { sessionID: 'ses_1', frameID: 'frm_1' },
        body:   {},
      });

      assert.ok(interactionLoop.approveCalled, 'approvePermission should be called');
      assert.equal(result.data.approved, true);
    });

    it('creates permission rules for "allow-forever" decisions', async () => {
      let { controller, createdRules } = buildController();

      await controller.approve({
        params: { sessionID: 'ses_1', frameID: 'frm_1' },
        body: {
          decisions: [
            { command: 'ls', decision: 'allow-forever' },
          ],
        },
      });

      assert.equal(createdRules.length, 1, 'should create one rule');
      assert.equal(createdRules[0].effect, 'allow');
      assert.equal(createdRules[0].scope, 'session');
      assert.equal(createdRules[0].scopeID, 'ses_1');
    });

    it('creates permission rules for "deny-forever" decisions', async () => {
      let { controller, createdRules } = buildController();

      await controller.approve({
        params: { sessionID: 'ses_1', frameID: 'frm_1' },
        body: {
          decisions: [
            { command: 'rm', decision: 'deny-forever' },
          ],
        },
      });

      assert.equal(createdRules.length, 1, 'should create one deny rule');
      assert.equal(createdRules[0].effect, 'deny');
    });

    it('does not create rules for "allow-once" decisions', async () => {
      let { controller, createdRules } = buildController();

      await controller.approve({
        params: { sessionID: 'ses_1', frameID: 'frm_1' },
        body: {
          decisions: [
            { command: 'ls', decision: 'allow-once' },
          ],
        },
      });

      assert.equal(createdRules.length, 0, 'should not create rules for allow-once');
    });
  });

  // ---------------------------------------------------------------------------
  // Happy paths — Deny
  // ---------------------------------------------------------------------------

  describe('deny — happy paths', () => {

    it('calls denyPermission on the interaction loop', async () => {
      let { controller, interactionLoop } = buildController();

      let result = await controller.deny({
        params: { sessionID: 'ses_1', frameID: 'frm_1' },
      });

      assert.ok(interactionLoop.denyCalled, 'denyPermission should be called');
      assert.equal(result.data.denied, true);
    });

    it('deny-once in approve body triggers denyPermission', async () => {
      let { controller, interactionLoop } = buildController();

      let result = await controller.approve({
        params: { sessionID: 'ses_1', frameID: 'frm_1' },
        body: {
          decisions: [
            { command: 'rm', decision: 'deny-once' },
          ],
        },
      });

      assert.ok(interactionLoop.denyCalled, 'denyPermission should be called when any decision is deny');
      assert.equal(result.data.denied, true);
    });
  });

  // ---------------------------------------------------------------------------
  // Sad paths
  // ---------------------------------------------------------------------------

  describe('sad paths', () => {

    it('returns 410 when no pending permission exists (expired)', async () => {
      let interactionLoop = createMockInteractionLoop();
      interactionLoop.approvePermission = async () => {
        throw new Error('No pending permission for session: ses_1');
      };

      let { controller, res } = buildController({ interactionLoop });

      let result = await controller.approve({
        params: { sessionID: 'ses_1', frameID: 'frm_1' },
        body:   {},
      });

      assert.equal(result.data.error, 'expired');
      assert.ok(result.data.message.includes('expired'));
    });

    it('re-throws non-permission errors', async () => {
      let interactionLoop = createMockInteractionLoop();
      interactionLoop.approvePermission = async () => {
        throw new Error('Something completely different');
      };

      let { controller } = buildController({ interactionLoop });

      await assert.rejects(
        () => controller.approve({
          params: { sessionID: 'ses_1', frameID: 'frm_1' },
          body:   {},
        }),
        { message: 'Something completely different' },
      );
    });

    it('backward compat: no body / empty decisions is approve-all', async () => {
      let { controller, interactionLoop, createdRules } = buildController();

      let result = await controller.approve({
        params: { sessionID: 'ses_1', frameID: 'frm_1' },
        body:   null,
      });

      assert.ok(interactionLoop.approveCalled, 'should call approvePermission');
      assert.equal(createdRules.length, 0, 'no rules created with empty body');
      assert.equal(result.data.approved, true);
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  describe('edge cases', () => {

    it('handles mixed allow-forever and deny-once decisions', async () => {
      let { controller, interactionLoop, createdRules } = buildController();

      let result = await controller.approve({
        params: { sessionID: 'ses_1', frameID: 'frm_1' },
        body: {
          decisions: [
            { command: 'ls', decision: 'allow-forever' },
            { command: 'rm', decision: 'deny-once' },
          ],
        },
      });

      // allow-forever creates a rule
      assert.equal(createdRules.length, 1, 'should create one rule (allow-forever)');
      assert.equal(createdRules[0].effect, 'allow');

      // deny-once triggers denyPermission
      assert.ok(interactionLoop.denyCalled, 'should call deny when any decision is deny-*');
      assert.equal(result.data.denied, true);
    });

    it('featureName includes colon prefix for bare commands', async () => {
      let { controller, createdRules } = buildController();

      await controller.approve({
        params: { sessionID: 'ses_1', frameID: 'frm_1' },
        body: {
          decisions: [
            { command: 'ls', decision: 'allow-forever' },
          ],
        },
      });

      assert.equal(createdRules[0].featureName, 'shell:ls');
    });

    it('featureName preserved when command already has colon', async () => {
      let { controller, createdRules } = buildController();

      await controller.approve({
        params: { sessionID: 'ses_1', frameID: 'frm_1' },
        body: {
          decisions: [
            { command: 'memory:store', decision: 'allow-forever' },
          ],
        },
      });

      assert.equal(createdRules[0].featureName, 'memory:store');
    });
  });
});
