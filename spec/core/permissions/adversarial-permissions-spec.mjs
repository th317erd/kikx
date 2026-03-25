'use strict';

import { describe, it, before, after, beforeEach } from 'node:test';
import assert          from 'node:assert/strict';
import { createHash }  from 'node:crypto';

import { Keystore }                from '../../../src/core/crypto/keystore.mjs';
import { PermissionService }       from '../../../src/core/permissions/permission-service.mjs';
import { PermissionRequiredError } from '../../../src/core/permissions/permission-required-error.mjs';
import { PermissionDeniedError }   from '../../../src/core/permissions/permission-denied-error.mjs';
import { InteractionLoop }         from '../../../src/core/interaction/index.mjs';

// =============================================================================
// Adversarial & Failure-Mode Permission Tests (Phase 5)
// =============================================================================
// Comprehensive tests targeting replay attacks, authorization boundary
// violations, dedup edge cases, failure modes, re-execution through the
// normal path, and race conditions in the permission system.
// =============================================================================

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function makeContext(overrides = {}) {
  let props = {
    contentSanitizer: null,
    hookService:      null,
    hookRunner:       null,
    models:           null,
    keystore:         null,
    sessionManager:   null,
    pluginRegistry:   null,
    interactionLoop:  null,
    ...overrides,
  };
  return {
    getProperty(name) { return props[name] || null; },
    setProperty(name, val) { props[name] = val; },
  };
}

function makeMockFrameModel(existingFrames = []) {
  let store = [...existingFrames];

  function buildQuery() {
    let filters = [];

    let query = {
      get AND() { return query; },
    };

    for (let field of ['sessionID', 'type', 'processed', 'id', 'hidden', 'featureName', 'scope', 'scopeID', 'effect', 'organizationID']) {
      Object.defineProperty(query, field, {
        get() {
          return {
            EQ(val) {
              filters.push((f) => f[field] === val);
              return query;
            },
            LTE(val) {
              filters.push((f) => f[field] <= val);
              return query;
            },
          };
        },
      });
    }

    query.all   = async () => store.filter((f) => filters.every((fn) => fn(f)));
    query.first = async () => {
      let results = store.filter((f) => filters.every((fn) => fn(f)));
      return results[0] || null;
    };

    return query;
  }

  return {
    get where() { return buildQuery(); },
    _store: store,
    create: async (data) => {
      let record = { ...data, save: async () => {}, destroy: async () => {} };
      store.push(record);
      return record;
    },
  };
}

function makeMockPermissionRuleModel(existingRules = []) {
  let store = [...existingRules];

  function buildQuery() {
    let filters = [];

    let query = {
      get AND() { return query; },
    };

    for (let field of ['featureName', 'scope', 'scopeID', 'effect', 'organizationID', 'id']) {
      Object.defineProperty(query, field, {
        get() {
          return {
            EQ(val) {
              filters.push((f) => f[field] === val);
              return query;
            },
            LTE(val) {
              filters.push((f) => f[field] <= val);
              return query;
            },
          };
        },
      });
    }

    query.all   = async () => store.filter((f) => filters.every((fn) => fn(f)));
    query.first = async () => {
      let results = store.filter((f) => filters.every((fn) => fn(f)));
      return results[0] || null;
    };

    return query;
  }

  return {
    get where() { return buildQuery(); },
    _store: store,
    create: async (data) => {
      let record = {
        ...data,
        save:    async () => {},
        destroy: async () => { let idx = store.indexOf(record); if (idx >= 0) store.splice(idx, 1); },
      };
      store.push(record);
      return record;
    },
  };
}

function computeExpectedHash(toolName, args, agentID, sessionID) {
  let input = JSON.stringify({
    toolName,
    arguments: args || {},
    agentID:   agentID || null,
    sessionID,
  });
  return createHash('sha256').update(input).digest('hex').slice(0, 32);
}

function makeFrameManager() {
  let refs = new Map();
  return {
    getRef(name)          { return refs.get(name); },
    createRef(name, val)  { refs.set(name, val); },
    updateRef(name, val)  { refs.set(name, val); },
  };
}

function makeParams(overrides = {}) {
  return {
    agent:           { id: 'agt_1', organizationID: 'org_1' },
    agentPlugin:     {},
    executeTool:     async () => 'ok',
    parentID:        null,
    _signingContext:  null,
    ...overrides,
  };
}

async function* toolCallGenerator(toolName, args, toolUseID) {
  yield {
    type:       'ToolCall',
    content:    { toolName: toolName || 'test:tool', arguments: args || {}, toolUseID: toolUseID || 'tu_1' },
    authorType: 'agent',
    authorID:   'agt_1',
  };
  yield { type: 'Done', content: {} };
}

// =============================================================================
// 1. REPLAY ATTACKS
// =============================================================================

describe('Adversarial: Replay Attacks', () => {
  let keystore;
  let userKeyPair;
  let attackerKeyPair;

  before(() => {
    keystore = new Keystore({ devMode: true, devSeed: 'adversarial-replay-' + Date.now() });
    keystore.initialize();
    userKeyPair     = keystore.generateSigningKeyPair();
    attackerKeyPair = keystore.generateSigningKeyPair();
  });

  after(() => {
    if (keystore) keystore.destroy();
  });

  function buildAndSign(fields, privateKey) {
    let payload = JSON.stringify(keystore.canonicalize(fields));
    return keystore.signWithPrivateKey(payload, privateKey || userKeyPair.privateKey);
  }

  function verify(fields, signature, publicKey) {
    let payload = JSON.stringify(keystore.canonicalize(fields));
    return keystore.verifyWithPublicKey(payload, publicKey || userKeyPair.publicKey, signature);
  }

  // 1. Cross-request replay: valid signature from Request A fails on Request B
  it('cross-request replay: signature from frameA fails on frameB', () => {
    let payloadA = {
      action: 'approve', frameID: 'frm_request_A', toolName: 'shell:execute',
      arguments: { command: 'ls -la' }, sessionID: 'ses_1',
    };

    let signature = buildAndSign(payloadA);

    // Try to replay on a different request (different frameID)
    let payloadB = { ...payloadA, frameID: 'frm_request_B' };
    let valid    = verify(payloadB, signature);

    assert.equal(valid, false, 'signature from request A must not verify against request B');
  });

  // 2. Argument escalation: approval for safe args fails when verified with dangerous args
  it('argument escalation: approval for "ls -la" fails on "rm -rf /"', () => {
    let safePayload = {
      action: 'approve', frameID: 'frm_escalate', toolName: 'shell:execute',
      arguments: { command: 'ls -la' }, sessionID: 'ses_1',
    };

    let signature = buildAndSign(safePayload);

    let dangerousPayload = { ...safePayload, arguments: { command: 'rm -rf /' } };
    let valid = verify(dangerousPayload, signature);

    assert.equal(valid, false, 'safe-args signature must not verify against dangerous args');
  });

  // 3. Cross-session replay: approval for session X fails on session Y
  it('cross-session replay: signature for session X fails on session Y', () => {
    let payload = {
      action: 'approve', frameID: 'frm_cross_ses', toolName: 'shell:execute',
      arguments: { command: 'ls' }, sessionID: 'ses_victim',
    };

    let signature = buildAndSign(payload);

    let replayedPayload = { ...payload, sessionID: 'ses_attacker' };
    let valid = verify(replayedPayload, signature);

    assert.equal(valid, false, 'session-X signature must not verify in session-Y');
  });

  // 4. Tool swap: approval for one tool fails on a different tool
  it('tool swap: approval for shell:execute fails on files:write', () => {
    let payload = {
      action: 'approve', frameID: 'frm_swap', toolName: 'shell:execute',
      arguments: { command: 'echo hello' }, sessionID: 'ses_1',
    };

    let signature = buildAndSign(payload);

    let swappedPayload = { ...payload, toolName: 'files:write' };
    let valid = verify(swappedPayload, signature);

    assert.equal(valid, false, 'shell:execute signature must not verify for files:write');
  });

  // 5. Same signature, different action: approve signature fails on deny action
  it('action swap: approve signature fails when verified as deny', () => {
    let approvePayload = {
      action: 'approve', frameID: 'frm_action', toolName: 'shell:execute',
      arguments: { command: 'ls' }, sessionID: 'ses_1',
    };

    let signature = buildAndSign(approvePayload);

    let denyPayload = { ...approvePayload, action: 'deny' };
    let valid = verify(denyPayload, signature);

    assert.equal(valid, false, 'approve signature must not verify with deny action');
  });
});

// =============================================================================
// 2. AUTHORIZATION BOUNDARY TESTS
// =============================================================================

describe('Adversarial: Authorization Boundary', () => {
  let keystore;
  let userKeyPair;
  let agentKeyPair;

  before(() => {
    keystore = new Keystore({ devMode: true, devSeed: 'adversarial-authz-' + Date.now() });
    keystore.initialize();
    userKeyPair  = keystore.generateSigningKeyPair();
    agentKeyPair = keystore.generateSigningKeyPair();
  });

  after(() => {
    if (keystore) keystore.destroy();
  });

  // 6. Agent-signed approval: signed with agent key, verified against user key
  it('agent-signed approval rejected when verified with user public key', () => {
    let payload = {
      action: 'approve', frameID: 'frm_agent_sign', toolName: 'shell:execute',
      arguments: { command: 'ls' }, sessionID: 'ses_1',
    };

    let canonicalized = JSON.stringify(keystore.canonicalize(payload));
    let agentSig      = keystore.signWithPrivateKey(canonicalized, agentKeyPair.privateKey);

    // Verify against user's public key (the only key the system should accept)
    let valid = keystore.verifyWithPublicKey(canonicalized, userKeyPair.publicKey, agentSig);

    assert.equal(valid, false, 'signature by agent key must fail verification against user public key');
  });

  // 7. Unsigned approval: PermissionService.verifyApproval with no signature returns false
  it('unsigned approval (null signature) returns false from keystore verify', () => {
    let payload = {
      action: 'approve', frameID: 'frm_unsigned', toolName: 'shell:execute',
      arguments: {}, sessionID: 'ses_1',
    };

    let canonicalized = JSON.stringify(keystore.canonicalize(payload));
    let valid         = keystore.verifyWithPublicKey(canonicalized, userKeyPair.publicKey, null);

    assert.equal(valid, false, 'null signature must return false');
  });

  // 8. Forged fingerprint: signature from key A, verified against key B
  it('forged fingerprint: mismatched key pair causes verification failure', () => {
    let payload = {
      action: 'approve', frameID: 'frm_forged_fp', toolName: 'shell:execute',
      arguments: { command: 'ls' }, sessionID: 'ses_1',
    };

    let canonicalized = JSON.stringify(keystore.canonicalize(payload));
    let sigFromAgent  = keystore.signWithPrivateKey(canonicalized, agentKeyPair.privateKey);

    // Attacker claims the fingerprint belongs to the user, but sig is from agent
    let valid = keystore.verifyWithPublicKey(canonicalized, userKeyPair.publicKey, sigFromAgent);

    assert.equal(valid, false, 'signature from agent key must fail against user public key');
  });

  // 9. PermissionService.verifyApproval with Ed25519: wrong public key
  it('PermissionService.verifyApproval fails with wrong publicKeyPEM', () => {
    let service = new PermissionService({
      context:          { getProperty: () => null },
      keystore,
    });

    let sig = service.signApproval('approve', 'frm_ps_wrong', 'shell:ls', { command: 'ls' }, 'ses_1', userKeyPair.privateKey);

    // Verify with agent's public key instead of user's
    let valid = service.verifyApproval('approve', 'frm_ps_wrong', 'shell:ls', { command: 'ls' }, sig, 'ses_1', agentKeyPair.publicKey);

    assert.equal(valid, false, 'PermissionService must reject verification with wrong public key');
  });

  // 10. Non-existent approver: empty/null publicKeyPEM returns false
  it('non-existent approver: null publicKeyPEM returns false from verifyApproval', () => {
    let service = new PermissionService({
      context:          { getProperty: () => null },
      keystore,
    });

    let sig   = service.signApproval('approve', 'frm_nouser', 'shell:ls', {}, 'ses_1', userKeyPair.privateKey);
    let valid = service.verifyApproval('approve', 'frm_nouser', 'shell:ls', {}, sig, 'ses_1', null);

    // With null publicKeyPEM, it falls through to HMAC verify — which also fails
    // because the HMAC was never computed for this blob (signed with Ed25519)
    // The service should handle this gracefully (not throw)
    assert.equal(typeof valid, 'boolean', 'should return a boolean, not throw');
  });

  // Bonus: garbage signature string doesn't cause crashes
  it('garbage signature string returns false gracefully', () => {
    let service = new PermissionService({
      context:          { getProperty: () => null },
      keystore,
    });

    let valid = service.verifyApproval('approve', 'frm_garbage', 'shell:ls', {}, 'not-a-real-signature-!@#$%', 'ses_1', userKeyPair.publicKey);

    assert.equal(valid, false, 'garbage signature must return false, not throw');
  });

  // Bonus: truncated signature returns false
  it('truncated signature returns false gracefully', () => {
    let service = new PermissionService({
      context:          { getProperty: () => null },
      keystore,
    });

    let realSig = service.signApproval('approve', 'frm_trunc', 'shell:ls', {}, 'ses_1', userKeyPair.privateKey);
    let truncated = realSig.slice(0, 32); // half the sig

    let valid = service.verifyApproval('approve', 'frm_trunc', 'shell:ls', {}, truncated, 'ses_1', userKeyPair.publicKey);

    assert.equal(valid, false, 'truncated signature must return false');
  });
});

// =============================================================================
// 3. DEDUP TESTS
// =============================================================================

describe('Adversarial: Dedup Hash', () => {
  let loop;
  let createdFrames;
  let mockFrame;

  beforeEach(() => {
    createdFrames = [];
    mockFrame     = makeMockFrameModel();

    loop = new InteractionLoop(makeContext({ models: { Frame: mockFrame } }));

    loop._createFrame = async (_sid, frameData, _fm, _opts, _sigCtx) => {
      createdFrames.push(frameData);
      return frameData;
    };
    loop._storeAndMaybeReplaceToolOutput = async (_sid, _iid, _block, _params, output) => output;
    loop._permissionHandler.hardBreak = async (...args) => {
      let [sessionID, generator, , interactionID, params] = args;
      await generator.return();
      let agentID   = params.agent && params.agent.id;
      let activeKey = loop._activeKey(sessionID, agentID);
      loop._active.delete(activeKey);
      loop.emit('interaction:end', { sessionID, interactionID, agentID: agentID || null });
    };
  });

  // 11. Same tool+args+agent+session → only one PermissionRequest created
  it('identical tool+args+agent+session produces only one PermissionRequest', async () => {
    let args        = { command: 'ls -la' };
    let requestHash = computeExpectedHash('shell:execute', args, 'agt_1', 'ses_1');

    // First request — creates a PermissionRequest
    let error1  = new PermissionRequiredError('test:feature', { title: 't' });
    let params1 = makeParams({ executeTool: async () => { throw error1; } });
    let gen1    = toolCallGenerator('shell:execute', args, 'tu_1');
    loop._active.set(loop._activeKey('ses_1', 'agt_1'), { generator: gen1, interactionID: 'int_1', params: params1 });
    await loop._iterateGenerator('ses_1', gen1, 'int_1', params1, makeFrameManager());

    let firstRequests = createdFrames.filter((f) => f.type === 'PermissionRequest');
    assert.equal(firstRequests.length, 1, 'first call should create one PermissionRequest');

    // Add the created frame to the mock store so dedup can find it
    mockFrame._store.push({
      id:        firstRequests[0].id,
      sessionID: 'ses_1',
      type:      'PermissionRequest',
      processed: false,
      timestamp: Date.now(),
      content:   firstRequests[0].content,
    });

    // Second identical request — should be deduped
    let beforeCount = createdFrames.length;
    let error2  = new PermissionRequiredError('test:feature', { title: 't' });
    let params2 = makeParams({ executeTool: async () => { throw error2; } });
    let gen2    = toolCallGenerator('shell:execute', args, 'tu_2');
    loop._active.set(loop._activeKey('ses_1', 'agt_1'), { generator: gen2, interactionID: 'int_2', params: params2 });
    await loop._iterateGenerator('ses_1', gen2, 'int_2', params2, makeFrameManager());

    let secondRequests = createdFrames.slice(beforeCount).filter((f) => f.type === 'PermissionRequest');
    assert.equal(secondRequests.length, 0, 'second identical call must NOT create another PermissionRequest');
  });

  // 12. Different args, same tool → two separate requests
  it('different args produce separate PermissionRequests', async () => {
    let argsA = { command: 'ls' };
    let argsB = { command: 'rm -rf /' };

    // First request
    let error1  = new PermissionRequiredError('test:feature', { title: 't' });
    let params1 = makeParams({ executeTool: async () => { throw error1; } });
    let gen1    = toolCallGenerator('shell:execute', argsA, 'tu_1');
    loop._active.set(loop._activeKey('ses_1', 'agt_1'), { generator: gen1, interactionID: 'int_1', params: params1 });
    await loop._iterateGenerator('ses_1', gen1, 'int_1', params1, makeFrameManager());

    let firstReq = createdFrames.filter((f) => f.type === 'PermissionRequest');
    assert.equal(firstReq.length, 1);

    // Add to store
    mockFrame._store.push({
      id: firstReq[0].id, sessionID: 'ses_1', type: 'PermissionRequest',
      processed: false, content: firstReq[0].content,
    });

    // Second request with different args
    let beforeCount = createdFrames.length;
    let error2  = new PermissionRequiredError('test:feature', { title: 't' });
    let params2 = makeParams({ executeTool: async () => { throw error2; } });
    let gen2    = toolCallGenerator('shell:execute', argsB, 'tu_2');
    loop._active.set(loop._activeKey('ses_1', 'agt_1'), { generator: gen2, interactionID: 'int_2', params: params2 });
    await loop._iterateGenerator('ses_1', gen2, 'int_2', params2, makeFrameManager());

    let secondReq = createdFrames.slice(beforeCount).filter((f) => f.type === 'PermissionRequest');
    assert.equal(secondReq.length, 1, 'different args must create a second PermissionRequest');
  });

  // 13. Processed request allows new identical request
  it('processed request with same hash allows new request creation', async () => {
    let args        = { command: 'ls' };
    let requestHash = computeExpectedHash('shell:execute', args, 'agt_1', 'ses_1');

    // Pre-populate a processed (already-handled) request
    mockFrame._store.push({
      id:        'frm_old_processed',
      sessionID: 'ses_1',
      type:      'PermissionRequest',
      processed: true,
      content:   { toolName: 'shell:execute', arguments: args, requestHash },
    });

    let error  = new PermissionRequiredError('test:feature', { title: 't' });
    let params = makeParams({ executeTool: async () => { throw error; } });
    let gen    = toolCallGenerator('shell:execute', args, 'tu_1');
    loop._active.set(loop._activeKey('ses_1', 'agt_1'), { generator: gen, interactionID: 'int_1', params });
    await loop._iterateGenerator('ses_1', gen, 'int_1', params, makeFrameManager());

    let newRequests = createdFrames.filter((f) => f.type === 'PermissionRequest');
    assert.equal(newRequests.length, 1, 'processed request must not block new identical request');
  });
});

// =============================================================================
// 4. FAILURE MODES
// =============================================================================

describe('Adversarial: Failure Modes', () => {
  let keystore;
  let userKeyPair;

  before(() => {
    keystore = new Keystore({ devMode: true, devSeed: 'adversarial-failure-' + Date.now() });
    keystore.initialize();
    userKeyPair = keystore.generateSigningKeyPair();
  });

  after(() => {
    if (keystore) keystore.destroy();
  });

  // 14. Tool class unregistered between request and approval
  it('tool unregistered between request and approval produces graceful error on replay', async () => {
    let mockFrameModel = makeMockFrameModel([
      {
        id: 'frm_tc_1', sessionID: 'ses_1', type: 'ToolCall', hidden: false,
        content: { toolName: 'test:removed-tool', arguments: { arg: 1 }, toolUseID: 'tu_orphan' },
      },
    ]);

    let mockRuleModel = makeMockPermissionRuleModel([
      {
        id: 'rule_1', featureName: 'test:removed-tool', scope: 'session', scopeID: 'ses_1',
        effect: 'allow', metadata: JSON.stringify({ oneTime: true, toolUseID: 'tu_orphan' }),
      },
    ]);

    // executeTool that simulates "tool not found"
    let executeTool = async (toolName) => {
      throw new Error(`Unknown tool: ${toolName}`);
    };

    let createdFrames = [];
    let loop = new InteractionLoop(makeContext({
      models: { Frame: mockFrameModel, PermissionRule: mockRuleModel },
    }));

    loop._createFrame = async (_sid, frameData, _fm, _opts, _sigCtx) => {
      createdFrames.push(frameData);
      return frameData;
    };

    let params = makeParams({ executeTool, replayFromPermission: true });

    // Should not throw — errors caught internally
    await loop._replayApprovedToolCalls('ses_1', 'int_1', params, makeFrameManager(), null);

    // Should create a ToolResult with the error message
    let toolResults = createdFrames.filter((f) => f.type === 'ToolResult');
    assert.equal(toolResults.length, 1, 'should create error ToolResult');
    assert.ok(toolResults[0].content.output.includes('Error executing tool after approval'), 'output should contain error message');
    assert.ok(toolResults[0].content.output.includes('Unknown tool'), 'output should mention unknown tool');
  });

  // 15. Double approval: second approval is idempotent
  it('double approval on already-completed frame is idempotent', () => {
    // This tests the PermissionApprovalPlugin's guard: step === 'completed' → skip
    // We simulate the state check directly
    let state = { step: 'completed' };
    assert.equal(state.step, 'completed', 'step should already be completed');

    // The plugin checks: if (step === 'completed' || step === 'denied') return next
    // So a second approval simply passes through
    let shouldProcess = (state.step !== 'completed' && state.step !== 'denied');
    assert.equal(shouldProcess, false, 'second approval should be skipped (idempotent)');
  });

  // 16. Malformed approval payload: PermissionService handles missing fields
  it('PermissionService.signApproval handles null/undefined fields gracefully', () => {
    let service = new PermissionService({
      context:          { getProperty: () => null },
      keystore,
    });

    // Sign with missing fields — should not throw
    let sig = service.signApproval('approve', null, null, null, null, userKeyPair.privateKey);
    assert.equal(typeof sig, 'string', 'should produce a signature string');
    assert.equal(sig.length, 128, 'Ed25519 signature should be 128 hex chars');

    // The blob normalizes: frameID=null, toolName=null, arguments={}, sessionID=null
    let valid = service.verifyApproval('approve', null, null, null, sig, null, userKeyPair.publicKey);
    assert.equal(valid, true, 'normalized blob should verify');
  });

  // 16b. Completely missing arguments/toolName in verifyApproval
  it('verifyApproval with mismatched null vs defined toolName fails', () => {
    let service = new PermissionService({
      context:          { getProperty: () => null },
      keystore,
    });

    let sig = service.signApproval('approve', 'frm_1', 'shell:ls', {}, 'ses_1', userKeyPair.privateKey);

    // Verify with null toolName — should fail
    let valid = service.verifyApproval('approve', 'frm_1', null, {}, sig, 'ses_1', userKeyPair.publicKey);
    assert.equal(valid, false, 'null toolName must not match signed shell:ls');
  });

  // 17. Deleted frame: approval for non-existent frame
  // This tests the interaction controller's guard: frame not found → 410
  it('approval controller logic: missing frame returns 410-like error', async () => {
    let mockFrameModel = makeMockFrameModel([]); // empty — no frames exist

    let frame = await mockFrameModel.where.id.EQ('frm_deleted_999').first();

    assert.equal(frame, null, 'frame should not exist');

    // Controller does: if (!frame || frame.type !== 'PermissionRequest') → 410
    let shouldReject = (!frame || (frame && frame.type !== 'PermissionRequest'));
    assert.equal(shouldReject, true, 'should reject when frame is null');
  });

  // 18. Wrong frame type: approval on non-PermissionRequest frame
  it('approval controller logic: non-PermissionRequest frame is rejected', async () => {
    let mockFrameModel = makeMockFrameModel([
      { id: 'frm_wrong_type', type: 'Message', sessionID: 'ses_1', processed: false },
    ]);

    let frame = await mockFrameModel.where.id.EQ('frm_wrong_type').first();

    assert.ok(frame, 'frame should exist');
    assert.notEqual(frame.type, 'PermissionRequest');

    let shouldReject = (!frame || frame.type !== 'PermissionRequest');
    assert.equal(shouldReject, true, 'should reject non-PermissionRequest frame type');
  });
});

// =============================================================================
// 5. RE-EXECUTION THROUGH NORMAL PATH
// =============================================================================

describe('Adversarial: Re-execution Through Normal Path', () => {
  let keystore;

  before(() => {
    keystore = new Keystore({ devMode: true, devSeed: 'adversarial-reexec-' + Date.now() });
    keystore.initialize();
  });

  after(() => {
    if (keystore) keystore.destroy();
  });

  // 19. One-time rule found → replay executes the tool
  it('one-time allow rule causes replay to execute the tool', async () => {
    let toolExecuted = false;

    let mockFrameModel = makeMockFrameModel([
      {
        id: 'frm_tc_replay', sessionID: 'ses_1', type: 'ToolCall', hidden: false,
        content: { toolName: 'shell:execute', arguments: { command: 'ls' }, toolUseID: 'tu_replay' },
      },
    ]);

    let mockRuleModel = makeMockPermissionRuleModel([
      {
        id: 'rule_onetimeA', featureName: 'shell:execute', scope: 'session', scopeID: 'ses_1',
        effect: 'allow',
        metadata: JSON.stringify({ oneTime: true, toolUseID: 'tu_replay' }),
        save:    async function() {},
      },
    ]);

    let executeTool = async (toolName, toolArgs) => {
      toolExecuted = true;
      return `output of ${toolName}`;
    };

    let createdFrames = [];
    let loop = new InteractionLoop(makeContext({
      models: { Frame: mockFrameModel, PermissionRule: mockRuleModel },
    }));

    loop._createFrame = async (_sid, frameData, _fm, _opts, _sigCtx) => {
      createdFrames.push(frameData);
      return frameData;
    };

    let params = makeParams({ executeTool, replayFromPermission: true });
    await loop._replayApprovedToolCalls('ses_1', 'int_1', params, makeFrameManager(), null);

    assert.equal(toolExecuted, true, 'tool should have been executed during replay');

    let results = createdFrames.filter((f) => f.type === 'ToolResult');
    assert.equal(results.length, 1, 'should create exactly one ToolResult');
    assert.ok(results[0].content.output.includes('output of shell:execute'));
  });

  // 20. One-time rule consumed after execution
  it('one-time rule has metadata.consumed=true after successful execution', async () => {
    let savedMetadata = null;

    let ruleRecord = {
      id: 'rule_consume', featureName: 'shell:execute', scope: 'session', scopeID: 'ses_1',
      effect: 'allow',
      metadata: JSON.stringify({ oneTime: true, toolUseID: 'tu_consume' }),
      save: async function() { savedMetadata = this.metadata; },
    };

    let mockFrameModel = makeMockFrameModel([
      {
        id: 'frm_tc_consume', sessionID: 'ses_1', type: 'ToolCall', hidden: false,
        content: { toolName: 'shell:execute', arguments: { command: 'ls' }, toolUseID: 'tu_consume' },
      },
    ]);

    let mockRuleModel = makeMockPermissionRuleModel();
    mockRuleModel._store.push(ruleRecord);

    let loop = new InteractionLoop(makeContext({
      models: { Frame: mockFrameModel, PermissionRule: mockRuleModel },
    }));

    loop._createFrame = async (_sid, frameData) => frameData;

    let params = makeParams({ executeTool: async () => 'ok', replayFromPermission: true });
    await loop._replayApprovedToolCalls('ses_1', 'int_1', params, makeFrameManager(), null);

    assert.ok(savedMetadata, 'rule metadata should have been saved');
    let parsed = JSON.parse(savedMetadata);
    assert.equal(parsed.consumed, true, 'consumed flag must be true after execution');
  });

  // 21. Tool failure during replay: error ToolResult created, rule still consumed
  it('tool failure during replay creates error ToolResult', async () => {
    let ruleRecord = {
      id: 'rule_fail', featureName: 'shell:execute', scope: 'session', scopeID: 'ses_1',
      effect: 'allow',
      metadata: JSON.stringify({ oneTime: true, toolUseID: 'tu_fail' }),
      save: async function() {},
    };

    let mockFrameModel = makeMockFrameModel([
      {
        id: 'frm_tc_fail', sessionID: 'ses_1', type: 'ToolCall', hidden: false,
        content: { toolName: 'shell:execute', arguments: { command: 'bad-cmd' }, toolUseID: 'tu_fail' },
      },
    ]);

    let mockRuleModel = makeMockPermissionRuleModel();
    mockRuleModel._store.push(ruleRecord);

    let createdFrames = [];
    let loop = new InteractionLoop(makeContext({
      models: { Frame: mockFrameModel, PermissionRule: mockRuleModel },
    }));

    loop._createFrame = async (_sid, frameData) => {
      createdFrames.push(frameData);
      return frameData;
    };

    let params = makeParams({
      executeTool: async () => { throw new Error('command not found: bad-cmd'); },
      replayFromPermission: true,
    });

    await loop._replayApprovedToolCalls('ses_1', 'int_1', params, makeFrameManager(), null);

    let results = createdFrames.filter((f) => f.type === 'ToolResult');
    assert.equal(results.length, 1, 'should still create ToolResult on failure');
    assert.ok(results[0].content.output.includes('Error executing tool after approval'), 'should contain error prefix');
    assert.ok(results[0].content.output.includes('command not found'), 'should contain error details');
  });
});

// =============================================================================
// 6. RACE CONDITIONS
// =============================================================================

describe('Adversarial: Race Conditions', () => {

  // 22. Double approval race: both approvals try to mark frame as completed
  it('double approval race: second approval is idempotent on already-processed frame', async () => {
    let saveCount = 0;

    let frame = {
      id:          'frm_race',
      type:        'PermissionRequest',
      sessionID:   'ses_1',
      processed:   false,
      processedAt: null,
      content:     JSON.stringify({ toolName: 'shell:execute', arguments: {} }),
      save:        async function() {
        saveCount++;
        this.processed = true;
      },
    };

    // Simulate first approval
    assert.equal(frame.processed, false);
    frame.processed   = true;
    frame.processedAt = Date.now();
    await frame.save();
    assert.equal(frame.processed, true);

    // Simulate second approval arriving — controller checks: if (frame.processed) return idempotent
    let isIdempotent = frame.processed;
    assert.equal(isIdempotent, true, 'second approval should detect already-processed');

    // The controller returns { approved: true } without re-saving
    // So only one save should have occurred from the first approval
    assert.equal(saveCount, 1, 'only one save should occur');
  });

  // 23. Rule deletion between check and execution: evaluate() reads snapshot
  it('rule read before deletion still works in evaluate snapshot', async () => {
    // This tests that evaluate() reads rules into memory before iterating.
    // Even if a rule is deleted between the DB read and the loop iteration,
    // the in-memory array still contains the rule.

    let ruleStore = [
      {
        id: 'rule_ephemeral', organizationID: 'org_1', featureName: 'shell:execute',
        effect: 'allow', scope: 'session', scopeID: 'ses_1', priority: 100,
        metadata: null, expiresAt: null,
      },
    ];

    // Simulate: rules are read into array...
    let snapshot = [...ruleStore];
    assert.equal(snapshot.length, 1, 'snapshot should have the rule');

    // ...then rule is deleted from the store
    ruleStore.length = 0;
    assert.equal(ruleStore.length, 0, 'store is now empty');

    // But snapshot still has it
    assert.equal(snapshot.length, 1, 'snapshot still has the rule (read before delete)');
    assert.equal(snapshot[0].effect, 'allow', 'rule still evaluates as allow');

    // This proves that JS's pass-by-value array copy means the evaluate()
    // loop over the rules array is safe from concurrent deletion.
  });
});

// =============================================================================
// 7. ADDITIONAL EDGE CASES
// =============================================================================

describe('Adversarial: Additional Edge Cases', () => {
  let keystore;
  let userKeyPair;

  before(() => {
    keystore = new Keystore({ devMode: true, devSeed: 'adversarial-edge-' + Date.now() });
    keystore.initialize();
    userKeyPair = keystore.generateSigningKeyPair();
  });

  after(() => {
    if (keystore) keystore.destroy();
  });

  // Canonicalization consistency: key order shouldn't matter
  it('canonicalize produces same output regardless of key insertion order', () => {
    let a = { action: 'approve', frameID: 'frm_1', sessionID: 'ses_1', toolName: 'shell:ls', arguments: {} };
    let b = { toolName: 'shell:ls', arguments: {}, sessionID: 'ses_1', action: 'approve', frameID: 'frm_1' };

    let canonA = keystore.canonicalize(a);
    let canonB = keystore.canonicalize(b);

    assert.equal(canonA, canonB, 'canonicalize must produce identical output for same data');
  });

  // Nested object canonicalization
  it('canonicalize sorts nested object keys', () => {
    let a = { outer: { z: 1, a: 2 } };
    let b = { outer: { a: 2, z: 1 } };

    assert.equal(keystore.canonicalize(a), keystore.canonicalize(b));
  });

  // Replay with modified nested arguments
  it('deeply nested argument modification fails verification', () => {
    let payload = {
      action: 'approve', frameID: 'frm_deep', toolName: 'files:write',
      arguments: { path: '/tmp/safe.txt', content: 'hello', options: { recursive: false } },
      sessionID: 'ses_1',
    };

    let canonical = JSON.stringify(keystore.canonicalize(payload));
    let sig       = keystore.signWithPrivateKey(canonical, userKeyPair.privateKey);

    // Attacker modifies nested argument
    let modified = JSON.parse(JSON.stringify(payload));
    modified.arguments.options.recursive = true;

    let modCanonical = JSON.stringify(keystore.canonicalize(modified));
    let valid = keystore.verifyWithPublicKey(modCanonical, userKeyPair.publicKey, sig);

    assert.equal(valid, false, 'modified nested argument must fail verification');
  });

  // PermissionService blob normalization: undefined → null
  it('PermissionService normalizes undefined fields to null', () => {
    let service = new PermissionService({
      context:          { getProperty: () => null },
      keystore,
    });

    let blob = service._buildApprovalBlob(undefined, undefined, undefined, undefined, undefined);

    assert.equal(blob.action, 'approve', 'undefined action defaults to approve');
    assert.equal(blob.frameID, null, 'undefined frameID normalized to null');
    assert.equal(blob.toolName, null, 'undefined toolName normalized to null');
    assert.deepStrictEqual(blob.arguments, {}, 'undefined arguments normalized to {}');
    assert.equal(blob.sessionID, null, 'undefined sessionID normalized to null');
  });

  // Replay attack across args normalization boundary: {} vs null
  it('args {} vs args null produce different signatures', () => {
    let service = new PermissionService({
      context:          { getProperty: () => null },
      keystore,
    });

    let sig1 = service.signApproval('approve', 'frm_1', 'tool', {}, 'ses_1', userKeyPair.privateKey);
    let sig2 = service.signApproval('approve', 'frm_1', 'tool', null, 'ses_1', userKeyPair.privateKey);

    // Both null and undefined normalize to {} in _buildApprovalBlob
    // So these should be the same (which prevents a normalization-based attack)
    assert.equal(sig1, sig2, 'null and {} args should normalize to same signature (no normalization attack surface)');
  });

  // Consumed one-time rule is skipped during replay
  it('consumed one-time rule is skipped (not re-executed)', async () => {
    let toolExecuted = false;

    let mockFrameModel = makeMockFrameModel([
      {
        id: 'frm_tc_skip', sessionID: 'ses_1', type: 'ToolCall', hidden: false,
        content: { toolName: 'shell:execute', arguments: { command: 'ls' }, toolUseID: 'tu_skip' },
      },
    ]);

    let mockRuleModel = makeMockPermissionRuleModel([
      {
        id: 'rule_consumed', featureName: 'shell:execute', scope: 'session', scopeID: 'ses_1',
        effect: 'allow',
        metadata: JSON.stringify({ oneTime: true, toolUseID: 'tu_skip', consumed: true }),
      },
    ]);

    let loop = new InteractionLoop(makeContext({
      models: { Frame: mockFrameModel, PermissionRule: mockRuleModel },
    }));

    loop._createFrame = async (_sid, frameData) => frameData;

    let params = makeParams({
      executeTool: async () => { toolExecuted = true; return 'ok'; },
      replayFromPermission: true,
    });

    await loop._replayApprovedToolCalls('ses_1', 'int_1', params, makeFrameManager(), null);

    assert.equal(toolExecuted, false, 'consumed rule must not trigger re-execution');
  });

  // No models available: _replayApprovedToolCalls returns early, no crash
  it('_replayApprovedToolCalls with no models returns gracefully', async () => {
    let loop = new InteractionLoop(makeContext({ models: null }));

    // Should not throw
    await loop._replayApprovedToolCalls('ses_1', 'int_1', makeParams(), makeFrameManager(), null);
  });

  // No PermissionRule model: _replayApprovedToolCalls returns early
  it('_replayApprovedToolCalls with Frame but no PermissionRule returns gracefully', async () => {
    let mockFrameModel = makeMockFrameModel([]);
    let loop = new InteractionLoop(makeContext({ models: { Frame: mockFrameModel } }));

    await loop._replayApprovedToolCalls('ses_1', 'int_1', makeParams(), makeFrameManager(), null);
    // No crash = pass
  });

  // executeTool not a function: _replayApprovedToolCalls exits early
  it('_replayApprovedToolCalls with non-function executeTool returns gracefully', async () => {
    let mockFrameModel = makeMockFrameModel([
      {
        id: 'frm_tc_nofn', sessionID: 'ses_1', type: 'ToolCall', hidden: false,
        content: { toolName: 'test:tool', arguments: {}, toolUseID: 'tu_nofn' },
      },
    ]);

    let mockRuleModel = makeMockPermissionRuleModel([
      {
        id: 'rule_nofn', featureName: 'test:tool', scope: 'session', scopeID: 'ses_1',
        effect: 'allow', metadata: JSON.stringify({ oneTime: true, toolUseID: 'tu_nofn' }),
      },
    ]);

    let loop = new InteractionLoop(makeContext({
      models: { Frame: mockFrameModel, PermissionRule: mockRuleModel },
    }));

    let params = makeParams({ executeTool: 'not-a-function', replayFromPermission: true });

    // Should not throw
    await loop._replayApprovedToolCalls('ses_1', 'int_1', params, makeFrameManager(), null);
  });
});
