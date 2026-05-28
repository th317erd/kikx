'use strict';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs     from 'node:fs';
import path   from 'node:path';
import os     from 'node:os';

import XID                       from 'xid-js';
import { KikxCore }              from '../../../src/core/kikx-core.mjs';
import { Keystore }              from '../../../src/core/crypto/keystore.mjs';
import { AuthService }           from '../../../src/server/auth/index.mjs';
import { InteractionController } from '../../../src/server/controllers/interaction-controller.mjs';

// =============================================================================
// Step 3.1 — Controller permission approval (frame-based)
// =============================================================================
// Tests that the approve/deny endpoints:
//   - Approve: create permission rules + set frame processed=true
//   - Deny: set frame processed=true + content.denied=true
//   - Handle edge cases: non-existent frame, already processed, etc.
//
// The controller now operates directly on Frame records. The FrameRouter +
// PermissionApprovalPlugin handle re-execution / denial after frame save.
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

// =============================================================================
// Tests
// =============================================================================

describe('InteractionController — permission approval (Step 3.1, frame-based)', () => {
  let core, keystore, tempDir;
  let testUser, testOrg, testSession;
  let Frame, Session;

  before(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kikx-perm-approval-test-'));
    core    = new KikxCore({ database: { filename: ':memory:' } });
    await core.start();

    keystore = new Keystore({ devMode: true, devSeed: 'perm-approval-test-seed' });
    keystore.initialize();
    keystore.loadServerMasterKey(tempDir);

    let context = core.getContext();
    context.setProperty('keystore', keystore);

    let authService = new AuthService({ context, keystore });
    let regResult   = await authService.register('perm-approval@test.com', 'password123', {
      organizationName: 'Perm Approval Test Org',
      firstName:        'Test',
      lastName:         'User',
    });

    testUser = regResult.user;
    testOrg  = regResult.organization;

    let models = core.getModels();
    Frame   = models.Frame;
    Session = models.Session;

    // Create a test session for frame creation
    testSession = await Session.create({
      id:             `ses_${XID.next()}`,
      organizationID: testOrg.id,
      name:           'Permission Approval Test Session',
    });
  });

  after(async () => {
    keystore.destroy();
    await core.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // Helper: create a permission-request frame in the DB
  // ---------------------------------------------------------------------------

  async function createPermissionRequestFrame(overrides = {}) {
    let frameID = overrides.id || `frm_${XID.next()}`;

    await Frame.create({
      id:            frameID,
      sessionID:     overrides.sessionID || testSession.id,
      type:          'PermissionRequest',
      content:       JSON.stringify({ toolName: 'shell:execute', arguments: { command: 'ls' }, toolUseID: 'tu_1' }),
      timestamp:     Date.now(),
      order:         Date.now() + 1,
      interactionID: `int_${XID.next()}`,
      authorType:    'system',
      hidden:        false,
      deleted:       false,
      processed:     overrides.processed || false,
    });

    return { frameID };
  }

  // ---------------------------------------------------------------------------
  // Helper: build a controller with mocked dependencies
  // ---------------------------------------------------------------------------

  function buildController(overrides = {}) {
    let interactionLoop = overrides.interactionLoop || {
      async startInteraction() { return 'int_new'; },
      async postMessage() { return { interactionID: 'int_post', frameID: 'frm_post' }; },
      requestPrimerRefresh() {},
      async cancelInteraction() { return null; },
      isActive() { return false; },
      async updateFrame(sessionID, updates) {
        // Simulate what InteractionLoop.updateFrame() does: persist to DB
        let updateArr = Array.isArray(updates) ? updates : [updates];
        for (let update of updateArr) {
          if (!update.id) continue;
          let existing = await Frame.where.id.EQ(update.id).first();
          if (existing) {
            for (let key of Object.keys(update)) {
              if (key === 'id') continue;
              let val = update[key];
              if (key === 'content' && typeof val === 'object') val = JSON.stringify(val);
              existing[key] = val;
            }
            await existing.save();
          }
        }
        return updateArr;
      },
      async _createFrame(_sessionID, _frameData, _fm) { return _frameData; },
    };

    let models = core.getModels();

    // Permissions.createRule() uses `new PermissionRule()` (the actual ORM model
    // constructor). We must pass the real models object — not a spread copy — so
    // the constructor is available. We track created rules by querying the DB
    // after the controller call instead of wrapping create().
    let ruleSnapshotBefore = null;

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
                if (name === 'models')           return models;
                if (name === 'keystore')         return keystore;
                return null;
              },
            };
          },
          getModels() { return core.getModels(); },
          getPluginRegistry() { return core.getPluginRegistry(); },
          getPermissions() { return null; },
          getFrameRouter() { return null; },
          getAgentType() { return null; },
        };
      },
      getKeystore() { return keystore; },
    };

    let req = createMockReq({
      params:         { sessionID: testSession.id, frameID: overrides.frameID || 'frm_1' },
      userID:         testUser.id,
      organizationID: testOrg.id,
    });
    let res = createMockRes();

    let controller = createController(InteractionController, { mockApp, req, res });

    // Helper to snapshot existing rules before the test action
    let snapshotRules = async () => {
      let existing = await models.PermissionRule.where.organizationID.EQ(testOrg.id).all();
      ruleSnapshotBefore = new Set(existing.map((r) => r.id));
    };

    // Helper to get newly created rules since the snapshot
    let getNewRules = async () => {
      let all = await models.PermissionRule.where.organizationID.EQ(testOrg.id).all();
      return all.filter((r) => !ruleSnapshotBefore.has(r.id));
    };

    return { controller, interactionLoop, snapshotRules, getNewRules, req, res };
  }

  // ---------------------------------------------------------------------------
  // Happy paths — Approve
  // ---------------------------------------------------------------------------

  describe('approve — happy paths', () => {

    it('marks the permission-request frame as processed', async () => {
      let { frameID } = await createPermissionRequestFrame();
      let { controller } = buildController({ frameID });

      let result = await controller.approve({
        params: { sessionID: 'ses_1', frameID },
        body:   {},
      });

      assert.equal(result.data.approved, true);

      // Verify frame is now processed
      let frame = await Frame.where.id.EQ(frameID).first();
      assert.equal(frame.processed, true, 'frame should be marked processed');
    });

    it('creates permission rules for "allow-forever" decisions', async () => {
      let { frameID } = await createPermissionRequestFrame();
      let { controller, snapshotRules, getNewRules } = buildController({ frameID });

      await snapshotRules();
      await controller.approve({
        params: { sessionID: 'ses_1', frameID },
        body: {
          decisions: [
            { command: 'ls', decision: 'allow-forever' },
          ],
        },
      });

      let createdRules = await getNewRules();
      assert.ok(createdRules.length >= 1, 'should create at least one rule');
      let foreverRule = createdRules.find((r) => r.featureName === 'shell:ls');
      assert.ok(foreverRule, 'should create a shell:ls rule');
      assert.equal(foreverRule.effect, 'allow');
      assert.equal(foreverRule.scope, 'session');
      assert.equal(foreverRule.scopeID, 'ses_1');
    });

    it('creates permission rules for "deny-forever" decisions', async () => {
      let { frameID } = await createPermissionRequestFrame();
      let { controller, snapshotRules, getNewRules } = buildController({ frameID });

      await snapshotRules();
      await controller.approve({
        params: { sessionID: 'ses_1', frameID },
        body: {
          decisions: [
            { command: 'rm', decision: 'deny-forever' },
          ],
        },
      });

      let createdRules = await getNewRules();
      assert.ok(createdRules.length >= 1, 'should create at least one deny rule');
      let denyRule = createdRules.find((r) => r.featureName === 'shell:rm');
      assert.ok(denyRule, 'should create a shell:rm rule');
      assert.equal(denyRule.effect, 'deny');
    });

    it('does not create rules for "allow-once" decisions', async () => {
      let { frameID } = await createPermissionRequestFrame();
      let { controller, snapshotRules, getNewRules } = buildController({ frameID });

      await snapshotRules();
      await controller.approve({
        params: { sessionID: 'ses_1', frameID },
        body: {
          decisions: [
            { command: 'ls', decision: 'allow-once' },
          ],
        },
      });

      let createdRules = await getNewRules();
      // allow-once creates no rules at all — the controller only creates rules
      // for "forever" decisions. The tool is executed directly on approval.
      assert.equal(createdRules.length, 0, 'should not create any rules for allow-once');
    });
  });

  // ---------------------------------------------------------------------------
  // Happy paths — Deny
  // ---------------------------------------------------------------------------

  describe('deny — happy paths', () => {

    it('marks the frame as processed with denied=true', async () => {
      let { frameID } = await createPermissionRequestFrame();
      let { controller } = buildController({ frameID });

      let result = await controller.deny({
        params: { sessionID: 'ses_1', frameID },
      });

      assert.equal(result.data.denied, true);

      let frame = await Frame.where.id.EQ(frameID).first();
      assert.equal(frame.processed, true, 'frame should be marked processed');

      let content = (typeof frame.getContent === 'function') ? frame.getContent() : frame.content;
      assert.equal(content.denied, true, 'content should have denied=true');
    });

    it('deny-once in approve body sets denied marker on frame', async () => {
      let { frameID } = await createPermissionRequestFrame();
      let { controller } = buildController({ frameID });

      let result = await controller.approve({
        params: { sessionID: 'ses_1', frameID },
        body: {
          decisions: [
            { command: 'rm', decision: 'deny-once' },
          ],
        },
      });

      assert.equal(result.data.denied, true);

      let frame = await Frame.where.id.EQ(frameID).first();
      let content = (typeof frame.getContent === 'function') ? frame.getContent() : frame.content;
      assert.equal(content.denied, true, 'content should have denied=true');
    });

  });

  // ---------------------------------------------------------------------------
  // Sad paths
  // ---------------------------------------------------------------------------

  describe('sad paths', () => {

    it('returns 410 when frame does not exist', async () => {
      let { controller, res } = buildController({ frameID: 'frm_nonexistent' });

      let result = await controller.approve({
        params: { sessionID: 'ses_1', frameID: 'frm_nonexistent' },
        body:   {},
      });

      assert.equal(result.data.error, 'expired');
      assert.ok(result.data.message.includes('expired'));
    });

    it('returns 410 for deny when frame does not exist', async () => {
      let { controller, res } = buildController({ frameID: 'frm_nonexistent' });

      let result = await controller.deny({
        params: { sessionID: 'ses_1', frameID: 'frm_nonexistent' },
      });

      assert.equal(result.data.error, 'expired');
    });

    it('idempotent: approve on already-processed frame returns approved', async () => {
      let { frameID } = await createPermissionRequestFrame({ processed: true });
      let { controller } = buildController({ frameID });

      let result = await controller.approve({
        params: { sessionID: 'ses_1', frameID },
        body:   {},
      });

      assert.equal(result.data.approved, true);
    });

    it('idempotent: deny on already-processed frame returns denied', async () => {
      let { frameID } = await createPermissionRequestFrame({ processed: true });
      let { controller } = buildController({ frameID });

      let result = await controller.deny({
        params: { sessionID: 'ses_1', frameID },
      });

      assert.equal(result.data.denied, true);
    });

    it('backward compat: no body / empty decisions is approve-all', async () => {
      let { frameID } = await createPermissionRequestFrame();
      let { controller, snapshotRules, getNewRules } = buildController({ frameID });

      await snapshotRules();
      let result = await controller.approve({
        params: { sessionID: 'ses_1', frameID },
        body:   null,
      });

      let createdRules = await getNewRules();
      // No "forever" decisions and no body — no rules created at all.
      // The tool is executed directly on approval.
      assert.equal(createdRules.length, 0, 'no rules created with empty body');
      assert.equal(result.data.approved, true);
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  describe('edge cases', () => {

    it('handles mixed allow-forever and deny-once decisions', async () => {
      let { frameID } = await createPermissionRequestFrame();
      let { controller, snapshotRules, getNewRules } = buildController({ frameID });

      await snapshotRules();
      let result = await controller.approve({
        params: { sessionID: 'ses_1', frameID },
        body: {
          decisions: [
            { command: 'ls', decision: 'allow-forever' },
            { command: 'rm', decision: 'deny-once' },
          ],
        },
      });

      let createdRules = await getNewRules();
      // allow-forever creates a rule (deny-once does not create any rule)
      assert.ok(createdRules.length >= 1, 'should create at least one rule (allow-forever)');
      assert.equal(createdRules[0].effect, 'allow');

      // deny-once triggers denial
      assert.equal(result.data.denied, true);

      // Frame should have denied marker
      let frame = await Frame.where.id.EQ(frameID).first();
      let content = (typeof frame.getContent === 'function') ? frame.getContent() : frame.content;
      assert.equal(content.denied, true, 'frame content should have denied=true');
    });

    it('featureName includes colon prefix for bare commands', async () => {
      let { frameID } = await createPermissionRequestFrame();
      let { controller, snapshotRules, getNewRules } = buildController({ frameID });

      await snapshotRules();
      await controller.approve({
        params: { sessionID: 'ses_1', frameID },
        body: {
          decisions: [
            { command: 'ls', decision: 'allow-forever' },
          ],
        },
      });

      let createdRules = await getNewRules();
      let foreverRule = createdRules.find((r) => r.featureName === 'shell:ls');
      assert.ok(foreverRule, 'should create a rule with featureName shell:ls');
      assert.equal(foreverRule.featureName, 'shell:ls');
    });

    it('featureName preserved when command already has colon', async () => {
      let { frameID } = await createPermissionRequestFrame();
      let { controller, snapshotRules, getNewRules } = buildController({ frameID });

      await snapshotRules();
      await controller.approve({
        params: { sessionID: 'ses_1', frameID },
        body: {
          decisions: [
            { command: 'memory:store', decision: 'allow-forever' },
          ],
        },
      });

      let createdRules = await getNewRules();
      let foreverRule = createdRules.find((r) => r.featureName === 'memory:store');
      assert.ok(foreverRule, 'should create a rule with featureName memory:store');
      assert.equal(foreverRule.featureName, 'memory:store');
    });
  });
});
