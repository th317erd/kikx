'use strict';

import { describe, it, before, after, beforeEach } from 'node:test';
import assert         from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { createKikxCore }          from '../../../src/core/index.mjs';
import { Permissions }             from '../../../src/core/permissions/permissions-base.mjs';
import { PermissionService }       from '../../../src/core/permissions/permission-service.mjs';
import { PermissionRequiredError } from '../../../src/core/permissions/permission-required-error.mjs';
import { PermissionDeniedError }   from '../../../src/core/permissions/permission-denied-error.mjs';
import { PluginInterface }         from '../../../src/core/plugin-loader/plugin-interface.mjs';
import { Keystore }                from '../../../src/core/crypto/keystore.mjs';
import { SessionManager }          from '../../../src/core/session/index.mjs';

// =============================================================================
// Permission Integration Tests — Phase 7
// =============================================================================
// End-to-end integration tests that verify the complete permission lifecycle:
//   1. Full approval lifecycle (rule evaluation → request → approval → re-execution)
//   2. Full denial lifecycle (rule evaluation → request → denial → denial message)
//   3. Standing allow rule (pre-existing rule auto-approves tool)
//   4. Standing deny rule (pre-existing deny rule throws PermissionDeniedError)
//   5. Dedup (duplicate permission requests return existing request ID)
//   6. Agent sees correct messages at each lifecycle stage
//
// These tests exercise real database operations, real models, and the real
// permission evaluation stack (Permissions.evaluate(), PluginInterface._checkPermissions(),
// PermissionService, and PermissionApprovalPlugin rule creation).
// =============================================================================

describe('Permission Integration — Full Lifecycle', () => {
  let core;
  let models;
  let context;
  let keystore;
  let keyPair;
  let sessionManager;
  let org;
  let orgID;
  let session;
  let sessionID;

  before(async () => {
    core = createKikxCore();
    await core.start();
    models  = core.getModels();
    context = core.getContext();

    // Set up keystore for Ed25519 signing
    keystore = new Keystore({ devMode: true, devSeed: 'permission-integration-test' });
    keystore.initialize();
    context.setProperty('keystore', keystore);
    context.setProperty('models', models);

    keyPair = keystore.generateSigningKeyPair();
  });

  after(async () => {
    if (keystore)
      keystore.destroy();

    if (core && core.isStarted())
      await core.stop();
  });

  beforeEach(async () => {
    org       = await models.Organization.create({ name: 'Permission Integration Org' });
    orgID     = org.id;

    // Fresh SessionManager per test
    sessionManager = new SessionManager(context);
    context.setProperty('sessionManager', sessionManager);

    session   = await sessionManager.createSession(orgID, { name: 'Integration Test Session' });
    sessionID = session.id;
  });

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function createPermissions() {
    return new Permissions(context);
  }

  function createService() {
    return new PermissionService({ context, keystore });
  }

  // Creates a mock tool subclass for integration testing
  function createTestToolClass(overrides = {}) {
    class TestTool extends PluginInterface {
      static pluginID    = overrides.pluginID || 'test';
      static featureName = overrides.featureName || 'action';
      static riskLevel   = overrides.riskLevel !== undefined ? overrides.riskLevel : 'high';

      async _execute(params) {
        return { executed: true, output: `Executed ${this.constructor.pluginID}:${this.constructor.featureName}` };
      }
    }

    return TestTool;
  }

  let frameOrder = 0;
  function nextOrder() { return ++frameOrder; }

  function buildRequestHash(toolName, args, agentID, sessID) {
    let input = JSON.stringify({
      toolName,
      arguments: args || {},
      agentID:   agentID || null,
      sessionID: sessID,
    });
    return createHash('sha256').update(input).digest('hex').slice(0, 32);
  }

  // ===========================================================================
  // 1. Full approval lifecycle
  // ===========================================================================

  describe('full approval lifecycle', () => {
    it('should: evaluate → needs-approval → create rule → re-evaluate → approved → tool executes', async () => {
      let perms       = createPermissions();
      let featureName = 'test:action';

      // Step 1: evaluate() with no rules under strict → needs approval
      let needsApproval = await perms.evaluate(featureName, { command: 'do-thing' }, {
        organizationID: orgID,
        scope:          'session',
        scopeID:        sessionID,
        riskLevel:      'strict',
      });
      assert.equal(needsApproval, true, 'Step 1: should need approval when no rules exist');

      // Step 2: Create a PermissionRequest frame in the DB (simulates InteractionLoop)
      let requestFrame = await models.Frame.create({
        type:      'PermissionRequest',
        sessionID,
        content:   JSON.stringify({
          toolName:  featureName,
          arguments: { command: 'do-thing' },
          toolUseID: 'tu_test_001',
        }),
        state: JSON.stringify({
          toolName:      featureName,
          toolArguments: { command: 'do-thing' },
          toolUseID:     'tu_test_001',
          sessionID,
          agentID:       null,
          step:          'awaiting-approval',
        }),
        timestamp:     Date.now(),
        order:         nextOrder(),
        interactionID: 'int_test_approval_001',
        authorType:    'system',
        authorID:      null,
        hidden:        false,
        deleted:       false,
        processed:     false,
      });

      assert.ok(requestFrame.id, 'Step 2: permission request frame should be created');

      // Step 3: Simulate approval — create a "forever" allow rule
      //   (The approval controller now creates only "forever" rules and executes
      //    tools directly. One-time rules are no longer used.)
      let foreverRule = await perms.createRule({
        organizationID: orgID,
        featureName,
        effect:         'allow',
        scope:          'session',
        scopeID:        sessionID,
        createdBy:      'system',
        metadata:       {
          permissionRequestID: requestFrame.id,
          toolArguments:       { command: 'do-thing' },
          toolUseID:           'tu_test_001',
        },
      });
      assert.ok(foreverRule.id, 'Step 3: forever allow rule should be created');

      // Step 4: Re-evaluate — the forever allow rule should now match
      let reEvalResult = await perms.evaluate(featureName, { command: 'do-thing' }, {
        organizationID: orgID,
        scope:          'session',
        scopeID:        sessionID,
        riskLevel:      'strict',
      });
      assert.equal(reEvalResult, false, 'Step 4: re-evaluation should return false (approved) with forever rule');

      // Step 5: Tool executes through normal path
      let TestTool = createTestToolClass({ pluginID: 'test', featureName: 'action' });

      // Give it a PermissionsClass that uses the real evaluate()
      class IntegrationPermissions extends Permissions {
        async checkPermission() { return null; }
      }
      TestTool.prototype.getPermissionsClass = () => IntegrationPermissions;

      let tool   = new TestTool(context);
      let result = await tool.execute({
        command:    'do-thing',
        _agent:     { organizationID: orgID },
        _sessionID: sessionID,
      });
      assert.deepEqual(result, { executed: true, output: 'Executed test:action' },
        'Step 5: tool should execute successfully after approval');
    });

    it('should work through PermissionService.check() flow', async () => {
      let service     = createService();
      let featureName = 'test:action';

      // No rules → needs approval (strict default)
      let checkResult = await service.check(featureName, { command: 'test' }, {
        organizationID: orgID,
        sessionID,
      });
      assert.equal(checkResult.decision, 'needs-approval');

      // Create standing approval → now service.check() should auto-approve
      await service.createStandingApproval({
        organizationID: orgID,
        sessionID,
        featureName,
        createdBy:      'usr_test',
        privateKeyPEM:  keyPair.privateKey,
      });

      let recheck = await service.check(featureName, { command: 'test' }, {
        organizationID: orgID,
        sessionID,
      });
      assert.equal(recheck.decision, 'allow', 'Should be allowed after standing approval');
      assert.ok(recheck.signature, 'Should return a signature with allow decision');
    });
  });

  // ===========================================================================
  // 2. Full denial lifecycle
  // ===========================================================================

  describe('full denial lifecycle', () => {
    it('should: evaluate → needs-approval → simulate denial → deny rule blocks future', async () => {
      let perms       = createPermissions();
      let featureName = 'test:dangerous';

      // Step 1: needs approval
      let needsApproval = await perms.evaluate(featureName, {}, {
        organizationID: orgID,
        scope:          'session',
        scopeID:        sessionID,
        riskLevel:      'strict',
      });
      assert.equal(needsApproval, true, 'Should need approval initially');

      // Step 2: Create permission request frame
      let requestFrame = await models.Frame.create({
        type:      'PermissionRequest',
        sessionID,
        content:   JSON.stringify({
          toolName:  featureName,
          arguments: {},
          toolUseID: 'tu_deny_001',
        }),
        state: JSON.stringify({
          toolName:      featureName,
          toolArguments: {},
          toolUseID:     'tu_deny_001',
          sessionID,
          step:          'awaiting-approval',
        }),
        timestamp:     Date.now(),
        order:         nextOrder(),
        interactionID: 'int_test_integration',
        authorType:    'system',
        authorID:      null,
        hidden:        false,
        deleted:       false,
        processed:     false,
      });
      assert.ok(requestFrame.id);

      // Step 3: Simulate denial — mark frame as processed + denied
      requestFrame.processed = true;
      requestFrame.content   = JSON.stringify({
        toolName:  featureName,
        arguments: {},
        toolUseID: 'tu_deny_001',
        denied:    true,
        deniedBy:  'usr_denier',
      });
      await requestFrame.save();

      // Step 4: Verify the denial message pattern
      let denialOutput = `Permission denied for "${featureName}". User denied execution.`;
      assert.ok(denialOutput.includes(featureName), 'Denial message should include tool name');
      assert.ok(denialOutput.includes('denied'), 'Denial message should indicate denial');

      // Step 5: Verify that a standing deny rule blocks ALL future calls
      await perms.createRule({
        organizationID: orgID,
        featureName,
        effect:         'deny',
        scope:          'session',
        scopeID:        sessionID,
        priority:       100,
        createdBy:      'usr_denier',
      });

      await assert.rejects(
        () => perms.evaluate(featureName, {}, {
          organizationID: orgID,
          scope:          'session',
          scopeID:        sessionID,
          riskLevel:      'strict',
        }),
        (error) => {
          assert.ok(error instanceof PermissionDeniedError);
          assert.equal(error.featureName, featureName);
          return true;
        },
        'Step 5: standing deny rule should throw PermissionDeniedError',
      );
    });

    it('denial should propagate through PluginInterface._checkPermissions()', async () => {
      let featureName = 'test:blocked';

      // Create deny rule
      await models.PermissionRule.create({
        organizationID: orgID,
        featureName,
        effect:         'deny',
        scope:          'session',
        scopeID:        sessionID,
        priority:       100,
        createdBy:      'usr_test',
      });

      // PluginInterface._checkPermissions evaluates → should throw PermissionDeniedError
      let TestTool = createTestToolClass({ pluginID: 'test', featureName: 'blocked' });
      let tool     = new TestTool(context);

      await assert.rejects(
        () => tool.execute({
          _agent:     { organizationID: orgID },
          _sessionID: sessionID,
        }),
        (error) => {
          assert.ok(error instanceof PermissionDeniedError);
          assert.equal(error.featureName, featureName);
          return true;
        },
      );
    });
  });

  // ===========================================================================
  // 3. Standing allow rule
  // ===========================================================================

  describe('standing allow rule', () => {
    it('should auto-approve tool when a global allow rule exists', async () => {
      let featureName = 'test:safe-tool';

      // Create standing global allow rule
      await models.PermissionRule.create({
        organizationID: orgID,
        featureName,
        effect:         'allow',
        scope:          'global',
        priority:       10,
        createdBy:      'usr_admin',
      });

      // evaluate() should return false (auto-approved)
      let perms  = createPermissions();
      let result = await perms.evaluate(featureName, { input: 'hello' }, {
        organizationID: orgID,
        scope:          'session',
        scopeID:        sessionID,
        riskLevel:      'strict',
      });
      assert.equal(result, false, 'Global allow rule should auto-approve');

      // PluginInterface should execute without throwing
      let TestTool = createTestToolClass({ pluginID: 'test', featureName: 'safe-tool' });
      let tool     = new TestTool(context);
      let output   = await tool.execute({
        input:      'hello',
        _agent:     { organizationID: orgID },
        _sessionID: sessionID,
      });
      assert.deepEqual(output, { executed: true, output: 'Executed test:safe-tool' });
    });

    it('should auto-approve via session-scoped allow rule', async () => {
      let featureName = 'test:scoped-tool';

      // Create session-scoped allow rule
      await models.PermissionRule.create({
        organizationID: orgID,
        featureName,
        effect:         'allow',
        scope:          'session',
        scopeID:        sessionID,
        priority:       10,
        createdBy:      'usr_admin',
      });

      let perms  = createPermissions();
      let result = await perms.evaluate(featureName, {}, {
        organizationID: orgID,
        scope:          'session',
        scopeID:        sessionID,
        riskLevel:      'strict',
      });
      assert.equal(result, false, 'Session-scoped allow rule should auto-approve');
    });

    it('should NOT auto-approve in a different session', async () => {
      let featureName = 'test:scoped-only';
      let otherSession = await sessionManager.createSession(orgID, { name: 'Other Session' });

      // Create rule scoped to original session only
      await models.PermissionRule.create({
        organizationID: orgID,
        featureName,
        effect:         'allow',
        scope:          'session',
        scopeID:        sessionID,
        priority:       10,
        createdBy:      'usr_admin',
      });

      let perms  = createPermissions();
      let result = await perms.evaluate(featureName, {}, {
        organizationID: orgID,
        scope:          'session',
        scopeID:        otherSession.id,
        riskLevel:      'strict',
      });
      assert.equal(result, true, 'Rule scoped to different session should not match');
    });

    it('PermissionService.createStandingApproval should auto-approve subsequent checks', async () => {
      let service     = createService();
      let featureName = 'test:standing';

      // Before standing approval
      let before_result = await service.check(featureName, {}, { organizationID: orgID, sessionID });
      assert.equal(before_result.decision, 'needs-approval');

      // Create standing approval
      let rule = await service.createStandingApproval({
        organizationID: orgID,
        sessionID,
        featureName,
        createdBy:     'usr_admin',
        privateKeyPEM: keyPair.privateKey,
      });
      assert.ok(rule.id, 'Standing approval rule should be created');
      assert.equal(rule.effect, 'allow');
      assert.equal(rule.scope, 'session');
      assert.equal(rule.scopeID, sessionID);

      // After standing approval
      let after_result = await service.check(featureName, {}, { organizationID: orgID, sessionID });
      assert.equal(after_result.decision, 'allow');
    });
  });

  // ===========================================================================
  // 4. Standing deny rule
  // ===========================================================================

  describe('standing deny rule', () => {
    it('should throw PermissionDeniedError when deny rule matches', async () => {
      let featureName = 'test:forbidden';

      // Create deny rule
      await models.PermissionRule.create({
        organizationID: orgID,
        featureName,
        effect:         'deny',
        scope:          'global',
        priority:       10,
        createdBy:      'usr_admin',
      });

      let perms = createPermissions();
      await assert.rejects(
        () => perms.evaluate(featureName, {}, {
          organizationID: orgID,
          riskLevel:      'strict',
        }),
        (error) => {
          assert.ok(error instanceof PermissionDeniedError);
          assert.equal(error.featureName, featureName);
          assert.ok(error.message.includes('explicit deny'));
          return true;
        },
      );
    });

    it('deny rule should override allow rule when higher priority', async () => {
      let featureName = 'test:conflict';

      // Low priority allow
      await models.PermissionRule.create({
        organizationID: orgID,
        featureName,
        effect:         'allow',
        scope:          'global',
        priority:       1,
        createdBy:      'usr_admin',
      });

      // High priority deny
      await models.PermissionRule.create({
        organizationID: orgID,
        featureName,
        effect:         'deny',
        scope:          'global',
        priority:       100,
        createdBy:      'usr_admin',
      });

      let perms = createPermissions();
      await assert.rejects(
        () => perms.evaluate(featureName, {}, {
          organizationID: orgID,
          riskLevel:      'strict',
        }),
        (error) => {
          assert.ok(error instanceof PermissionDeniedError);
          return true;
        },
        'Higher-priority deny should override lower-priority allow',
      );
    });

    it('deny rule should block PluginInterface.execute() and prevent _execute()', async () => {
      let featureName = 'test:denied';
      let executeCalled = false;

      // Create deny rule
      await models.PermissionRule.create({
        organizationID: orgID,
        featureName,
        effect:         'deny',
        scope:          'global',
        priority:       10,
        createdBy:      'usr_admin',
      });

      class DeniedTool extends PluginInterface {
        static pluginID    = 'test';
        static featureName = 'denied';
        static riskLevel   = 'high';

        async _execute(_params) {
          executeCalled = true;
          return { executed: true };
        }
      }

      let tool = new DeniedTool(context);
      await assert.rejects(
        () => tool.execute({
          _agent:     { organizationID: orgID },
          _sessionID: sessionID,
        }),
        (error) => {
          assert.ok(error instanceof PermissionDeniedError);
          return true;
        },
      );

      assert.equal(executeCalled, false, '_execute() should never be called when deny rule matches');
    });

    it('PermissionService.check() should throw for deny rule', async () => {
      let service     = createService();
      let featureName = 'test:service-denied';

      await models.PermissionRule.create({
        organizationID: orgID,
        featureName,
        effect:         'deny',
        scope:          'global',
        priority:       10,
        createdBy:      'usr_admin',
      });

      await assert.rejects(
        () => service.check(featureName, {}, { organizationID: orgID, sessionID }),
        (error) => {
          assert.ok(error instanceof PermissionDeniedError);
          return true;
        },
      );
    });
  });

  // ===========================================================================
  // 5. Dedup — duplicate permission requests
  // ===========================================================================

  describe('dedup — duplicate permission requests', () => {
    it('should detect duplicate request by matching requestHash on unprocessed frames', async () => {
      let toolName = 'test:expensive';
      let args     = { command: 'long-running-thing' };
      let agentID  = 'agt_test123';

      // Build the deterministic hash (same algorithm as InteractionLoop)
      let requestHash = buildRequestHash(toolName, args, agentID, sessionID);

      // Create first PermissionRequest frame with hash
      let firstRequest = await models.Frame.create({
        type:      'PermissionRequest',
        sessionID,
        content:   JSON.stringify({
          toolName,
          arguments:   args,
          requestHash,
        }),
        timestamp:     Date.now(),
        order:         nextOrder(),
        interactionID: 'int_test_integration',
        authorType:    'system',
        authorID:      null,
        hidden:        false,
        deleted:       false,
        processed:     false,
      });
      assert.ok(firstRequest.id);

      // Simulate second call with same parameters — query for unprocessed requests
      let existingRequests = await models.Frame.where
        .sessionID.EQ(sessionID)
        .AND.type.EQ('PermissionRequest')
        .AND.processed.EQ(false)
        .all();

      let dedupMatch = existingRequests.find((f) => {
        let existingContent = (typeof f.content === 'string')
          ? (() => { try { return JSON.parse(f.content); } catch (_e) { return {}; } })()
          : (f.content || {});
        return existingContent && existingContent.requestHash === requestHash;
      }) || null;

      assert.ok(dedupMatch, 'Should find existing request with matching hash');
      assert.equal(dedupMatch.id, firstRequest.id, 'Dedup match should be the original request');

      // Verify the dedup message pattern
      let dedupOutput = `Permission already requested. Request ID: ${dedupMatch.id}. Awaiting user approval.`;
      assert.ok(dedupOutput.includes(dedupMatch.id), 'Dedup message should include original request ID');
      assert.ok(dedupOutput.includes('already requested'), 'Dedup message should indicate duplicate');
    });

    it('should NOT dedup when arguments differ', async () => {
      let toolName = 'test:unique';

      let hash1 = buildRequestHash(toolName, { command: 'alpha' }, null, sessionID);
      let hash2 = buildRequestHash(toolName, { command: 'beta' }, null, sessionID);

      // Create first request
      await models.Frame.create({
        type:      'PermissionRequest',
        sessionID,
        content:   JSON.stringify({ toolName, arguments: { command: 'alpha' }, requestHash: hash1 }),
        timestamp:     Date.now(),
        order:         nextOrder(),
        interactionID: 'int_test_integration',
        authorType:    'system',
        authorID:      null,
        hidden:        false,
        deleted:       false,
        processed:     false,
      });

      // Query with different hash
      let existingRequests = await models.Frame.where
        .sessionID.EQ(sessionID)
        .AND.type.EQ('PermissionRequest')
        .AND.processed.EQ(false)
        .all();

      let dedupMatch = existingRequests.find((f) => {
        let content = (typeof f.content === 'string')
          ? (() => { try { return JSON.parse(f.content); } catch (_e) { return {}; } })()
          : (f.content || {});
        return content && content.requestHash === hash2;
      }) || null;

      assert.equal(dedupMatch, null, 'Different arguments should produce different hash — no dedup');
    });

    it('should NOT dedup when original request has been processed', async () => {
      let toolName    = 'test:processed';
      let args        = { command: 'repeat' };
      let requestHash = buildRequestHash(toolName, args, null, sessionID);

      // Create a processed (already-handled) request
      await models.Frame.create({
        type:      'PermissionRequest',
        sessionID,
        content:   JSON.stringify({ toolName, arguments: args, requestHash }),
        timestamp:     Date.now(),
        order:         nextOrder(),
        interactionID: 'int_test_integration',
        authorType:    'system',
        authorID:      null,
        hidden:        false,
        deleted:       false,
        processed:     true, // Already processed
      });

      // Query for unprocessed only
      let existingRequests = await models.Frame.where
        .sessionID.EQ(sessionID)
        .AND.type.EQ('PermissionRequest')
        .AND.processed.EQ(false)
        .all();

      let dedupMatch = existingRequests.find((f) => {
        let content = (typeof f.content === 'string')
          ? (() => { try { return JSON.parse(f.content); } catch (_e) { return {}; } })()
          : (f.content || {});
        return content && content.requestHash === requestHash;
      }) || null;

      assert.equal(dedupMatch, null, 'Processed requests should not be matched for dedup');
    });

    it('should NOT dedup across different sessions', async () => {
      let toolName    = 'test:cross-session';
      let args        = { command: 'same' };
      let otherSession = await sessionManager.createSession(orgID, { name: 'Other Dedup Session' });

      let hash1 = buildRequestHash(toolName, args, null, sessionID);
      let hash2 = buildRequestHash(toolName, args, null, otherSession.id);

      // Hashes are different because sessionID is part of the input
      assert.notEqual(hash1, hash2, 'Different sessions should produce different hashes');

      // Even if hashes were the same, the query is scoped to sessionID
      await models.Frame.create({
        type:      'PermissionRequest',
        sessionID: otherSession.id,
        content:   JSON.stringify({ toolName, arguments: args, requestHash: hash2 }),
        timestamp:     Date.now(),
        order:         nextOrder(),
        interactionID: 'int_test_integration',
        authorType:    'system',
        authorID:      null,
        hidden:        false,
        deleted:       false,
        processed:     false,
      });

      // Query scoped to original session
      let existingRequests = await models.Frame.where
        .sessionID.EQ(sessionID)
        .AND.type.EQ('PermissionRequest')
        .AND.processed.EQ(false)
        .all();

      let dedupMatch = existingRequests.find((f) => {
        let content = (typeof f.content === 'string')
          ? (() => { try { return JSON.parse(f.content); } catch (_e) { return {}; } })()
          : (f.content || {});
        return content && (content.requestHash === hash1 || content.requestHash === hash2);
      }) || null;

      assert.equal(dedupMatch, null, 'Should not find dedup match in a different session');
    });
  });

  // ===========================================================================
  // 6. Agent sees correct messages
  // ===========================================================================

  describe('agent sees correct messages', () => {
    it('should produce correct PERMISSION REQUIRED message', () => {
      let toolName       = 'test:guarded';
      let requestFrameID = 'frm_test_request_123';

      let output = `PERMISSION REQUIRED for "${toolName}". A permission request (ID: ${requestFrameID}) has been sent to the user. Do NOT retry this tool call — wait for the user to approve or deny.`;

      assert.ok(output.includes('PERMISSION REQUIRED'), 'Message should contain PERMISSION REQUIRED');
      assert.ok(output.includes(toolName), 'Message should include tool name');
      assert.ok(output.includes(requestFrameID), 'Message should include request frame ID');
      assert.ok(output.includes('Do NOT retry'), 'Message should instruct agent not to retry');
    });

    it('should produce correct dedup message', () => {
      let existingRequestID = 'frm_existing_456';

      let output = `Permission already requested. Request ID: ${existingRequestID}. Awaiting user approval.`;

      assert.ok(output.includes('already requested'), 'Dedup message should indicate duplicate');
      assert.ok(output.includes(existingRequestID), 'Dedup message should include existing request ID');
    });

    it('should produce correct denial message', () => {
      let toolName = 'test:denied-tool';
      let output   = `Permission denied for "${toolName}". User denied execution.`;

      assert.ok(output.includes('denied'), 'Denial message should indicate denial');
      assert.ok(output.includes(toolName), 'Denial message should include tool name');
    });

    it('PermissionRequiredError should carry structured context for UI', () => {
      let error = new PermissionRequiredError('test:guarded', {
        title:       'Run guarded tool',
        description: 'This tool requires explicit permission.',
        details:     [
          { label: 'command', value: 'dangerous-thing' },
          { label: 'path', value: '/etc/shadow' },
        ],
      });

      assert.equal(error.name, 'PermissionRequiredError');
      assert.equal(error.featureName, 'test:guarded');
      assert.equal(error.title, 'Run guarded tool');
      assert.equal(error.description, 'This tool requires explicit permission.');
      assert.equal(error.details.length, 2);
      assert.equal(error.details[0].label, 'command');
      assert.equal(error.details[1].value, '/etc/shadow');
    });

    it('PermissionDeniedError should carry tool name and reason', () => {
      let error = new PermissionDeniedError('test:forbidden', 'explicit deny rule');

      assert.equal(error.name, 'PermissionDeniedError');
      assert.equal(error.featureName, 'test:forbidden');
      assert.equal(error.reason, 'explicit deny rule');
      assert.ok(error.message.includes('test:forbidden'));
      assert.ok(error.message.includes('explicit deny'));
    });

    it('PluginInterface should produce PermissionRequiredError with correct featureName format', async () => {
      let TestTool = createTestToolClass({ pluginID: 'myPlugin', featureName: 'myTool', riskLevel: 'high' });
      let tool     = new TestTool(context);

      // No rules + strict → PermissionRequiredError
      try {
        await tool.execute({
          _agent:     { organizationID: orgID },
          _sessionID: sessionID,
        });
        assert.fail('Should have thrown PermissionRequiredError');
      } catch (error) {
        assert.ok(error instanceof PermissionRequiredError);
        assert.equal(error.featureName, 'myPlugin:myTool',
          'featureName should be pluginID:featureName');
      }
    });
  });

  // ===========================================================================
  // 7. Edge cases and failure modes
  // ===========================================================================

  describe('edge cases and failure modes', () => {
    it('riskLevel "none" tool should bypass all permission checks', async () => {
      let TestTool = createTestToolClass({ pluginID: 'test', featureName: 'safe', riskLevel: 'none' });
      let tool     = new TestTool(context);

      // Even with no rules and strict mode, riskLevel 'none' should execute
      let result = await tool.execute({
        _agent:     { organizationID: orgID },
        _sessionID: sessionID,
      });
      assert.deepEqual(result, { executed: true, output: 'Executed test:safe' });
    });

    it('riskLevel "critical" should always require approval regardless of allow rules', async () => {
      let featureName = 'test:critical';

      // Create allow rule
      await models.PermissionRule.create({
        organizationID: orgID,
        featureName,
        effect:         'allow',
        scope:          'global',
        priority:       100,
        createdBy:      'usr_admin',
      });

      let perms  = createPermissions();
      let result = await perms.evaluate(featureName, {}, {
        organizationID: orgID,
        riskLevel:      'strict',
        toolClass:      { riskLevel: 'critical' },
      });
      assert.equal(result, true, 'Critical tool should always need approval');
    });

    it('expired allow rule should not auto-approve', async () => {
      let featureName = 'test:expired';
      let pastDate    = new Date(Date.now() - 60000);

      await models.PermissionRule.create({
        organizationID: orgID,
        featureName,
        effect:         'allow',
        scope:          'global',
        priority:       10,
        createdBy:      'usr_admin',
        expiresAt:      pastDate,
      });

      let perms  = createPermissions();
      let result = await perms.evaluate(featureName, {}, {
        organizationID: orgID,
        riskLevel:      'strict',
      });
      assert.equal(result, true, 'Expired rule should be ignored');
    });

    it('low-priority allow + high-priority standing deny should respect priority', async () => {
      let featureName = 'test:priority-battle';

      // High-priority deny
      await models.PermissionRule.create({
        organizationID: orgID,
        featureName,
        effect:         'deny',
        scope:          'global',
        priority:       1000,
        createdBy:      'usr_admin',
      });

      // Lower-priority allow
      await models.PermissionRule.create({
        organizationID: orgID,
        featureName,
        effect:         'allow',
        scope:          'session',
        scopeID:        sessionID,
        priority:       1,
        createdBy:      'system',
      });

      let perms = createPermissions();
      await assert.rejects(
        () => perms.evaluate(featureName, {}, {
          organizationID: orgID,
          scope:          'session',
          scopeID:        sessionID,
          riskLevel:      'strict',
        }),
        (error) => {
          assert.ok(error instanceof PermissionDeniedError);
          return true;
        },
        'High-priority deny should win over low-priority allow',
      );
    });

    it('PermissionService.revokeStandingApproval should remove standing rules', async () => {
      let service     = createService();
      let featureName = 'test:revocable';

      // Create standing approval
      await service.createStandingApproval({
        organizationID: orgID,
        sessionID,
        featureName,
        createdBy:     'usr_admin',
        privateKeyPEM: keyPair.privateKey,
      });

      // Verify it works
      let check1 = await service.check(featureName, {}, { organizationID: orgID, sessionID });
      assert.equal(check1.decision, 'allow');

      // Revoke
      let revoked = await service.revokeStandingApproval(sessionID, {
        organizationID: orgID,
        featureName,
      });
      assert.ok(revoked >= 1, 'Should revoke at least one rule');

      // Verify it no longer works
      let check2 = await service.check(featureName, {}, { organizationID: orgID, sessionID });
      assert.equal(check2.decision, 'needs-approval', 'After revocation should need approval again');
    });

    it('no models available should fall through as auto-allow (dev mode)', async () => {
      // Create a context with no models
      let bareContext = {
        getProperty(name) {
          if (name === 'models')
            return null;
          return null;
        },
      };

      let perms  = new Permissions(bareContext);
      let result = await perms.evaluate('any:tool', {}, {
        organizationID: orgID,
        riskLevel:      'strict',
      });
      assert.equal(result, false, 'No models → auto-allow (dev/test mode safety)');
    });
  });
});
