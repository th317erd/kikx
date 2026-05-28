'use strict';

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs     from 'node:fs';
import os     from 'node:os';
import path   from 'node:path';

import XID from 'xid-js';

import { KikxCore }      from '../../../src/core/kikx-core.mjs';
import { Keystore }      from '../../../src/core/crypto/keystore.mjs';
import { InteractionLoop } from '../../../src/core/interaction/index.mjs';
import { SessionManager }  from '../../../src/core/session/index.mjs';
import { FramePersistence } from '../../../src/core/frames/index.mjs';
import { AgentInterface }  from '../../../src/core/plugins/agent-interface.mjs';
import { computeKeyFingerprint } from '../../../src/core/crypto/value-signing.mjs';

// =============================================================================
// Frame signingKeyFingerprint Tests (Gap 3)
// =============================================================================
// Verifies that:
//   - Frame model has signingKeyFingerprint field
//   - signingKeyFingerprint is null by default
//   - When a frame is signed, signingKeyFingerprint is computed and stored
//   - The fingerprint is the first 32 hex chars of SHA-256(publicKeyPEM)
//   - System frames have fingerprint from system public key
//   - Agent frames have fingerprint from agent public key
//   - User frames have fingerprint from user public key
//   - Frames without a private key have null fingerprint
//   - Fingerprint persists to and loads from the database
// =============================================================================

function generateFrameID() {
  return `frm_${XID.next()}`;
}

class MockAgent extends AgentInterface {
  static pluginID    = 'mock-fp-agent';
  static featureName = 'mock-fp';
  static displayName = 'Mock FP Agent';
  static description = 'Mock agent for fingerprint tests';
  static agentType   = 'mock';

  constructor(context, blocks) {
    super(context);
    this._blocks = blocks || [];
  }

  async *_createGenerator(_params) {
    for (let block of this._blocks)
      yield block;

    yield { type: 'Done', content: {} };
  }
}

// =============================================================================
// DB model field tests
// =============================================================================

describe('Frame model — signingKeyFingerprint field (Gap 3)', () => {
  let core;
  let models;
  let organization;
  let session;

  before(async () => {
    core   = createKikxCore();
    await core.start();
    models = core.getModels();
  });

  after(async () => {
    if (core && core.isStarted())
      await core.stop();
  });

  beforeEach(async () => {
    organization = await models.Organization.create({ name: 'FP Test Org' });
    session      = await models.Session.create({ organizationID: organization.id, name: 'FP Test Session' });
  });

  it('Frame model has signingKeyFingerprint field', () => {
    assert.ok(models.Frame.fields.signingKeyFingerprint, 'signingKeyFingerprint field should exist');
  });

  it('signingKeyFingerprint field is nullable', () => {
    let field = models.Frame.fields.signingKeyFingerprint;
    assert.equal(field.allowNull, true);
  });

  it('Frame model version is 4 after adding state field', () => {
    assert.equal(models.Frame.version, 4, 'Frame model version should be 4');
  });

  it('creates a frame with signingKeyFingerprint null by default', async () => {
    let frameID = generateFrameID();
    let frame   = await models.Frame.create({
      id:            frameID,
      sessionID:     session.id,
      interactionID: 'int_001',
      type: 'Message',
      order:         1,
      timestamp:     Date.now(),
    });

    assert.ok(frame.signingKeyFingerprint == null, 'signingKeyFingerprint should default to null');
  });

  it('creates a frame with a signingKeyFingerprint value', async () => {
    let frameID     = generateFrameID();
    let fingerprint = 'abcdef1234567890abcdef1234567890'; // 32 hex chars

    let frame = await models.Frame.create({
      id:                  frameID,
      sessionID:           session.id,
      interactionID:       'int_002',
      type: 'Message',
      order:               1,
      timestamp:           Date.now(),
      signingKeyFingerprint: fingerprint,
    });

    assert.equal(frame.signingKeyFingerprint, fingerprint);
  });

  it('reads back signingKeyFingerprint from DB', async () => {
    let frameID     = generateFrameID();
    let fingerprint = 'deadbeef'.repeat(4); // 32 hex chars

    await models.Frame.create({
      id:                  frameID,
      sessionID:           session.id,
      interactionID:       'int_003',
      type: 'Message',
      order:               1,
      timestamp:           Date.now(),
      signingKeyFingerprint: fingerprint,
    });

    let loaded = await models.Frame.where.id.EQ(frameID).first();
    assert.ok(loaded, 'should find frame');
    assert.equal(loaded.signingKeyFingerprint, fingerprint);
  });

  it('accepts a fingerprint up to 64 chars', async () => {
    let frameID     = generateFrameID();
    let fingerprint = 'f'.repeat(64); // max length

    let frame = await models.Frame.create({
      id:                  frameID,
      sessionID:           session.id,
      interactionID:       'int_004',
      type: 'Message',
      order:               1,
      timestamp:           Date.now(),
      signingKeyFingerprint: fingerprint,
    });

    let loaded = await models.Frame.where.id.EQ(frameID).first();
    assert.equal(loaded.signingKeyFingerprint, fingerprint);
  });
});

// =============================================================================
// computeKeyFingerprint utility
// =============================================================================

describe('computeKeyFingerprint utility', () => {
  let keystore;
  let tempDir;

  before(() => {
    tempDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'kikx-fp-util-test-'));
    keystore = new Keystore({ devMode: true, devSeed: 'fp-util-test-seed' });
    keystore.initialize();
    keystore.loadServerMasterKey(tempDir);
  });

  after(() => {
    keystore.destroy();
    if (tempDir && fs.existsSync(tempDir))
      fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns a 32-char hex string for a valid PEM', () => {
    let { publicKey } = keystore.generateSigningKeyPair();
    let fingerprint   = computeKeyFingerprint(publicKey);

    assert.ok(fingerprint, 'fingerprint should be non-null');
    assert.equal(fingerprint.length, 32);
    assert.match(fingerprint, /^[0-9a-f]{32}$/);
  });

  it('returns null for null input', () => {
    let fingerprint = computeKeyFingerprint(null);
    assert.equal(fingerprint, null);
  });

  it('returns null for undefined input', () => {
    let fingerprint = computeKeyFingerprint(undefined);
    assert.equal(fingerprint, null);
  });

  it('returns null for empty string', () => {
    let fingerprint = computeKeyFingerprint('');
    assert.equal(fingerprint, null);
  });

  it('produces the same fingerprint for the same key', () => {
    let { publicKey } = keystore.generateSigningKeyPair();
    let fp1 = computeKeyFingerprint(publicKey);
    let fp2 = computeKeyFingerprint(publicKey);
    assert.equal(fp1, fp2);
  });

  it('produces different fingerprints for different keys', () => {
    let key1 = keystore.generateSigningKeyPair().publicKey;
    let key2 = keystore.generateSigningKeyPair().publicKey;
    let fp1  = computeKeyFingerprint(key1);
    let fp2  = computeKeyFingerprint(key2);
    assert.notEqual(fp1, fp2);
  });
});

// =============================================================================
// computeKeyFingerprint: invalid inputs
// =============================================================================

describe('computeKeyFingerprint: invalid inputs', () => {
  it("non-PEM string → returns non-null 32-char hex (crypto hashes any string)", () => {
    // Any truthy string is hashed — the impl does not validate PEM format
    let fingerprint = computeKeyFingerprint('not-a-pem-string');
    assert.ok(fingerprint !== null, 'should return non-null for any truthy string');
    assert.equal(fingerprint.length, 32, 'should return 32-char hex');
    assert.match(fingerprint, /^[0-9a-f]{32}$/, 'should be hex');
  });

  it("empty string '' → returns null (falsy guard triggers)", () => {
    // Empty string is falsy in JS → !'' → true → returns null
    let fingerprint = computeKeyFingerprint('');
    assert.equal(fingerprint, null, 'empty string should return null');
  });

  it('number input (123) → throws TypeError (no type guard in impl)', () => {
    // The impl only guards for falsy (!publicKeyPEM). 123 is truthy.
    // crypto.createHash().update(123) throws TypeError for non-string/non-Buffer.
    assert.throws(
      () => computeKeyFingerprint(123),
      (error) => error instanceof TypeError,
      'number input should throw TypeError',
    );
  });

  it('object input ({}) → throws TypeError (no type guard in impl)', () => {
    // {} is truthy → passes falsy guard → crypto.update({}) throws TypeError
    assert.throws(
      () => computeKeyFingerprint({}),
      (error) => error instanceof TypeError,
      'object input should throw TypeError',
    );
  });

  it('agent frame with agent.publicKey = null → signingKeyFingerprint is null, not crash', () => {
    // This tests the calling code pattern: if agent.publicKey is null,
    // computeKeyFingerprint(null) → returns null
    let fingerprint = computeKeyFingerprint(null);
    assert.equal(fingerprint, null, 'null publicKey should produce null fingerprint');
  });

  it("agent frame with agent.publicKey = '' (empty string) → returns null (falsy guard)", () => {
    // Empty string is falsy → !'' → true → returns null
    // Callers should not get a fingerprint for empty-string publicKey
    let fingerprint = computeKeyFingerprint('');
    assert.equal(fingerprint, null, 'empty publicKey should produce null fingerprint');
  });
});

// =============================================================================
// InteractionLoop — frames include signingKeyFingerprint
// =============================================================================

function createKikxCore() {
  return new KikxCore({ database: { filename: ':memory:' } });
}

describe('InteractionLoop — signingKeyFingerprint on frames (Gap 3)', () => {
  let core;
  let keystore;
  let tempDir;
  let models;
  let context;
  let sessionManager;
  let framePersistence;

  before(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kikx-fp-loop-test-'));

    core = createKikxCore();
    await core.start();

    keystore = new Keystore({ devMode: true, devSeed: 'fp-loop-test-seed' });
    keystore.initialize();
    keystore.loadServerMasterKey(tempDir);
    keystore.loadSystemKeyPair(tempDir);

    models           = core.getModels();
    context          = core.getContext();
    sessionManager   = new SessionManager(context);
    framePersistence = new FramePersistence(context);

    context.setProperty('sessionManager', sessionManager);
    context.setProperty('framePersistence', framePersistence);
    context.setProperty('keystore', keystore);
  });

  after(async () => {
    keystore.destroy();

    if (core && core.isStarted())
      await core.stop();

    if (tempDir && fs.existsSync(tempDir))
      fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('agent frames have signingKeyFingerprint when agent has public key', async () => {
    let interactionLoop = new InteractionLoop(context);
    let organization    = await models.Organization.create({ name: 'FP Agent Org' });
    let session         = await sessionManager.createSession(organization.id);

    let agentKeyPair  = keystore.generateSigningKeyPair();
    let agent         = await models.Agent.create({
      organizationID: organization.id,
      name:           'test-fp-agent',
      pluginID:       'mock-fp-agent',
      publicKey:      agentKeyPair.publicKey,
    });

    let encrypted = keystore.encryptActorPrivateKey(agentKeyPair.privateKey, agent.id);
    agent.encryptedPrivateKey = JSON.stringify(encrypted);
    await agent.save();

    let capturedFrames = [];
    interactionLoop.on('frame', (event) => capturedFrames.push(event.frame));

    let mockPlugin = new MockAgent(context, [
      { type: 'Message', content: { html: '<p>hi</p>' }, authorType: 'agent', authorID: agent.id },
    ]);

    await interactionLoop.startInteraction(session.id, {
      agentPlugin: mockPlugin,
      agent:       {
        id:                  agent.id,
        name:                agent.name,
        publicKey:           agent.publicKey,
        encryptedPrivateKey: agent.encryptedPrivateKey,
      },
      userMessage: 'test fingerprint',
    });

    let agentFrames = capturedFrames.filter((f) => f.authorType === 'agent');
    assert.ok(agentFrames.length > 0, 'should have agent frames');

    for (let frame of agentFrames) {
      assert.ok(frame.signingKeyFingerprint, `agent frame "${frame.type}" should have signingKeyFingerprint`);
      assert.equal(frame.signingKeyFingerprint.length, 32, 'fingerprint should be 32 chars');
      assert.match(frame.signingKeyFingerprint, /^[0-9a-f]{32}$/);

      // Verify it matches the agent's public key
      let expected = computeKeyFingerprint(agentKeyPair.publicKey);
      assert.equal(frame.signingKeyFingerprint, expected);
    }
  });

  it('system frames have signingKeyFingerprint from system public key', async () => {
    let interactionLoop = new InteractionLoop(context);
    let organization    = await models.Organization.create({ name: 'FP System Org' });
    let session         = await sessionManager.createSession(organization.id);

    let capturedFrames = [];
    interactionLoop.on('frame', (event) => capturedFrames.push(event.frame));

    let mockPlugin = new MockAgent(context, [
      {
        type:       'ToolCall',
        content:    { toolName: 'test:tool', arguments: {}, toolUseId: 'tu_fp' },
        authorType: 'agent',
        authorID:   'agt_sys_fp',
      },
    ]);

    await interactionLoop.startInteraction(session.id, {
      agentPlugin:  mockPlugin,
      agent:        { id: 'agt_sys_fp', name: 'test-sys-fp' },
      userMessage:  'test system fp',
      executeTool:  async () => 'result',
    });

    let systemFrames = capturedFrames.filter((f) => f.authorType === 'system');
    assert.ok(systemFrames.length > 0, 'should have system frames');

    let systemPublicKey = keystore.getSystemPublicKey();
    let expectedFP      = computeKeyFingerprint(systemPublicKey);

    for (let frame of systemFrames) {
      assert.ok(frame.signingKeyFingerprint, `system frame "${frame.type}" should have signingKeyFingerprint`);
      assert.equal(frame.signingKeyFingerprint, expectedFP, 'system frame fingerprint should match system public key');
    }
  });

  it('user frames have signingKeyFingerprint when userPublicKey is in signingContext', async () => {
    let interactionLoop = new InteractionLoop(context);
    let organization    = await models.Organization.create({ name: 'FP User Org' });
    let session         = await sessionManager.createSession(organization.id);

    let userKeyPair    = keystore.generateSigningKeyPair();
    let capturedFrames = [];
    interactionLoop.on('frame', (event) => capturedFrames.push(event.frame));

    let mockPlugin = new MockAgent(context, [
      { type: 'Message', content: { html: '<p>reply</p>' }, authorType: 'agent', authorID: 'agt_user_fp' },
    ]);

    await interactionLoop.startInteraction(session.id, {
      agentPlugin:    mockPlugin,
      agent:          { id: 'agt_user_fp', name: 'test-user-fp' },
      userMessage:    'hello',
      authorType:     'user',
      authorID:       'usr_fp_test',
      userPrivateKey: userKeyPair.privateKey,
      userPublicKey:  userKeyPair.publicKey,
    });

    let userFrames = capturedFrames.filter((f) => f.authorType === 'user');
    assert.ok(userFrames.length > 0, 'should have user frames');

    let expectedFP = computeKeyFingerprint(userKeyPair.publicKey);

    for (let frame of userFrames) {
      assert.ok(frame.signingKeyFingerprint, 'user frame should have signingKeyFingerprint');
      assert.equal(frame.signingKeyFingerprint, expectedFP, 'user frame fingerprint should match user public key');
    }
  });

  it('frames without signing keys have null signingKeyFingerprint', async () => {
    let interactionLoop = new InteractionLoop(context);
    let organization    = await models.Organization.create({ name: 'FP Null Org' });
    let session         = await sessionManager.createSession(organization.id);

    let capturedFrames = [];
    interactionLoop.on('frame', (event) => capturedFrames.push(event.frame));

    let mockPlugin = new MockAgent(context, [
      { type: 'Message', content: { html: '<p>no sig</p>' }, authorType: 'agent', authorID: 'agt_no_fp' },
    ]);

    // No encryptedPrivateKey on agent, no keystore system key
    await interactionLoop.startInteraction(session.id, {
      agentPlugin: mockPlugin,
      agent:       { id: 'agt_no_fp', name: 'test-no-fp' },
      userMessage: 'no signing',
      authorType:  'user',
      authorID:    'usr_no_fp',
      // No userPrivateKey or userPublicKey
    });

    let agentFrames = capturedFrames.filter((f) => f.authorType === 'agent');
    assert.ok(agentFrames.length > 0, 'should have agent frames');

    for (let frame of agentFrames) {
      assert.ok(!frame.signingKeyFingerprint, 'agent frame without keys should not have signingKeyFingerprint');
    }
  });

  it('signingKeyFingerprint persists to database', async () => {
    let interactionLoop = new InteractionLoop(context);
    let organization    = await models.Organization.create({ name: 'FP Persist Org' });
    let session         = await sessionManager.createSession(organization.id);

    let agentKeyPair = keystore.generateSigningKeyPair();
    let agent        = await models.Agent.create({
      organizationID: organization.id,
      name:           'test-fp-persist',
      pluginID:       'mock-fp-agent',
      publicKey:      agentKeyPair.publicKey,
    });

    let encrypted = keystore.encryptActorPrivateKey(agentKeyPair.privateKey, agent.id);
    agent.encryptedPrivateKey = JSON.stringify(encrypted);
    await agent.save();

    let mockPlugin = new MockAgent(context, [
      { type: 'Message', content: { html: '<p>persist</p>' }, authorType: 'agent', authorID: agent.id },
    ]);

    await interactionLoop.startInteraction(session.id, {
      agentPlugin: mockPlugin,
      agent:       {
        id:                  agent.id,
        name:                agent.name,
        publicKey:           agent.publicKey,
        encryptedPrivateKey: agent.encryptedPrivateKey,
      },
      userMessage: 'persist fingerprint',
    });

    let { Frame } = models;
    let dbFrames  = await Frame.where.sessionID.EQ(session.id).all();

    let agentFrame = dbFrames.find((f) => f.authorType === 'agent');
    assert.ok(agentFrame, 'should have agent frame in DB');
    assert.ok(agentFrame.signingKeyFingerprint, 'signingKeyFingerprint should be persisted to DB');

    let expected = computeKeyFingerprint(agentKeyPair.publicKey);
    assert.equal(agentFrame.signingKeyFingerprint, expected);
  });
});
