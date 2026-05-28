'use strict';

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import XID from 'xid-js';

import { createKikxCore } from '../../../src/core/index.mjs';

// =============================================================================
// Helper: generate valid frame XIDs with the frm_ prefix
// =============================================================================

function generateFrameID() {
  return `frm_${XID.next()}`;
}

// =============================================================================
// Frame Signature Field Tests (C1)
// =============================================================================
// Verifies that the Frame model and in-memory Frame class both support the
// signature field, that FramePersistence round-trips it, and that
// FrameManager.merge() propagates signature from options.
// =============================================================================

describe('Frame Signature Field (C1)', () => {
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
    organization = await models.Organization.create({ name: 'Sig Test Org' });
    session      = await models.Session.create({ organizationID: organization.id, name: 'Sig Test Session' });
  });

  // ===========================================================================
  // DB Model — Frame.signature field
  // ===========================================================================

  describe('Frame DB model', () => {
    it('should have a signature field defined', () => {
      let fields = models.Frame.fields;
      assert.ok(fields.signature, 'Frame model should have a signature field');
    });

    it('should have signature as STRING(256)', () => {
      let fields    = models.Frame.fields;
      let sigField  = fields.signature;
      assert.ok(sigField.type, 'signature field should have a type');
    });

    it('should allow null for signature', () => {
      let fields   = models.Frame.fields;
      let sigField = fields.signature;
      assert.equal(sigField.allowNull, true, 'signature field should be nullable');
    });

    it('should create a Frame with signature null by default', async () => {
      let frameID = generateFrameID();
      let frame   = await models.Frame.create({
        id:            frameID,
        sessionID:     session.id,
        interactionID: 'int_001',
        type: 'Message',
        order:         1,
        timestamp:     Date.now(),
      });

      assert.ok(frame.signature == null, 'signature should default to null/undefined');
    });

    it('should create a Frame with a signature value', async () => {
      let frameID   = generateFrameID();
      let signature = 'a'.repeat(128); // 128 hex chars — typical Ed25519

      let frame = await models.Frame.create({
        id:            frameID,
        sessionID:     session.id,
        interactionID: 'int_002',
        type: 'Message',
        order:         1,
        timestamp:     Date.now(),
        signature:     signature,
      });

      assert.equal(frame.signature, signature);
    });

    it('should read back a Frame with its signature', async () => {
      let frameID   = generateFrameID();
      let signature = 'deadbeef'.repeat(16); // 128 chars

      await models.Frame.create({
        id:            frameID,
        sessionID:     session.id,
        interactionID: 'int_003',
        type: 'Message',
        order:         1,
        timestamp:     Date.now(),
        signature:     signature,
      });

      let loaded = await models.Frame.where.id.EQ(frameID).first();
      assert.ok(loaded, 'should find the frame');
      assert.equal(loaded.signature, signature);
    });

    it('should accept a signature up to 256 characters', async () => {
      let frameID   = generateFrameID();
      let signature = 'f'.repeat(256);

      let frame = await models.Frame.create({
        id:            frameID,
        sessionID:     session.id,
        interactionID: 'int_004',
        type: 'Message',
        order:         1,
        timestamp:     Date.now(),
        signature:     signature,
      });

      let loaded = await models.Frame.where.id.EQ(frameID).first();
      assert.equal(loaded.signature, signature);
    });

    it('should allow updating signature on an existing Frame', async () => {
      let frameID = generateFrameID();

      let frame = await models.Frame.create({
        id:            frameID,
        sessionID:     session.id,
        interactionID: 'int_005',
        type: 'Message',
        order:         1,
        timestamp:     Date.now(),
        signature:     null,
      });

      assert.equal(frame.signature, null);

      frame.signature = 'updated_sig_value';
      await frame.save();

      let loaded = await models.Frame.where.id.EQ(frameID).first();
      assert.equal(loaded.signature, 'updated_sig_value');
    });
  });

  // ===========================================================================
  // In-memory Frame class
  // ===========================================================================

  describe('In-memory Frame class', () => {
    it('should have a signature property', async () => {
      let { Frame } = await import('../../../src/shared/frame-manager/frame.mjs');
      let frame     = new Frame({ id: 'frm_test', type: 'Message' });
      assert.ok('signature' in frame, 'Frame instance should have a signature property');
    });

    it('should default signature to null', async () => {
      let { Frame } = await import('../../../src/shared/frame-manager/frame.mjs');
      let frame     = new Frame({ id: 'frm_test', type: 'Message' });
      assert.equal(frame.signature, null);
    });

    it('should accept a signature value via constructor', async () => {
      let { Frame } = await import('../../../src/shared/frame-manager/frame.mjs');
      let frame     = new Frame({ id: 'frm_test', type: 'Message', signature: 'sig_abc' });
      assert.equal(frame.signature, 'sig_abc');
    });

    it('should preserve empty string signature', async () => {
      let { Frame } = await import('../../../src/shared/frame-manager/frame.mjs');
      let frame     = new Frame({ id: 'frm_test', type: 'Message', signature: '' });
      assert.equal(frame.signature, '');
    });
  });

  // ===========================================================================
  // FramePersistence round-trip
  // ===========================================================================

  describe('FramePersistence round-trip', () => {
    let persistence;

    before(async () => {
      let { FramePersistence } = await import('../../../src/core/frames/index.mjs');
      persistence = new FramePersistence(core.getContext());
    });

    it('should round-trip a frame with a signature through save and load', async () => {
      let frameID   = generateFrameID();
      let signature = 'abcdef0123456789'.repeat(8); // 128 chars

      await persistence.saveFrames(session.id, [
        {
          id:        frameID,
          type: 'Message',
          content:   { text: 'signed message' },
          order:     1,
          timestamp: Date.now(),
          signature: signature,
        },
      ]);

      let frameManager = await persistence.loadFrames(session.id);
      let frames       = frameManager.toArray();

      assert.equal(frames.length, 1);
      assert.equal(frames[0].signature, signature);
    });

    it('should round-trip a frame with null signature', async () => {
      let frameID = generateFrameID();

      await persistence.saveFrames(session.id, [
        {
          id:        frameID,
          type: 'Message',
          content:   { text: 'unsigned' },
          order:     1,
          timestamp: Date.now(),
        },
      ]);

      let frameManager = await persistence.loadFrames(session.id);
      let frames       = frameManager.toArray();

      assert.equal(frames.length, 1);
      assert.equal(frames[0].signature, null);
    });

    it('should include signature in _frameToRecord output', () => {
      let record = persistence._frameToRecord('ses_001', 'int_001', {
        id:        'frm_test',
        type: 'Message',
        order:     1,
        signature: 'test_sig_hex',
      });

      assert.equal(record.signature, 'test_sig_hex');
    });

    it('should default signature to null in _frameToRecord when not provided', () => {
      let record = persistence._frameToRecord('ses_001', 'int_001', {
        id:    'frm_test',
        type: 'Message',
        order: 1,
      });

      assert.equal(record.signature, null);
    });

    it('should include signature in _recordToFrame output', () => {
      let frame = persistence._recordToFrame({
        id:        'frm_test',
        type: 'Message',
        order:     1,
        timestamp: Date.now(),
        signature: 'record_sig',
      });

      assert.equal(frame.signature, 'record_sig');
    });

    it('should default signature to null in _recordToFrame when not on record', () => {
      let frame = persistence._recordToFrame({
        id:        'frm_test',
        type: 'Message',
        order:     1,
        timestamp: Date.now(),
      });

      assert.equal(frame.signature, null);
    });
  });

  // ===========================================================================
  // FrameManager.merge() signature option
  // ===========================================================================

  describe('FrameManager.merge() with signature option', () => {
    it('should propagate signature from merge options to frames', async () => {
      let { FrameManager } = await import('../../../src/shared/frame-manager/frame-manager.mjs');
      let frameManager     = new FrameManager({ history: true });

      let results = frameManager.merge(
        [{ id: 'frm_sig1', type: 'Message', content: { text: 'hello' } }],
        { signature: 'merge_option_sig' },
      );

      assert.equal(results.length, 1);
      assert.equal(results[0].signature, 'merge_option_sig');
    });

    it('should not overwrite frameData.signature with merge option signature', async () => {
      let { FrameManager } = await import('../../../src/shared/frame-manager/frame-manager.mjs');
      let frameManager     = new FrameManager({ history: true });

      let results = frameManager.merge(
        [{ id: 'frm_sig2', type: 'Message', content: {}, signature: 'frame_level_sig' }],
        { signature: 'merge_option_sig' },
      );

      assert.equal(results.length, 1);
      assert.equal(results[0].signature, 'frame_level_sig');
    });

    it('should leave signature as null when no signature option provided', async () => {
      let { FrameManager } = await import('../../../src/shared/frame-manager/frame-manager.mjs');
      let frameManager     = new FrameManager({ history: true });

      let results = frameManager.merge(
        [{ id: 'frm_sig3', type: 'Message', content: {} }],
        {},
      );

      assert.equal(results.length, 1);
      assert.equal(results[0].signature, null);
    });

    it('should store signature on the frame retrievable via get()', async () => {
      let { FrameManager } = await import('../../../src/shared/frame-manager/frame-manager.mjs');
      let frameManager     = new FrameManager({ history: true });

      frameManager.merge(
        [{ id: 'frm_sig4', type: 'Message', content: {} }],
        { signature: 'retrievable_sig' },
      );

      let frame = frameManager.get('frm_sig4');
      assert.ok(frame, 'should retrieve the frame');
      assert.equal(frame.signature, 'retrievable_sig');
    });

    it('should propagate signature to multiple frames in a single merge', async () => {
      let { FrameManager } = await import('../../../src/shared/frame-manager/frame-manager.mjs');
      let frameManager     = new FrameManager({ history: true });

      let results = frameManager.merge(
        [
          { id: 'frm_multi1', type: 'Message', content: {} },
          { id: 'frm_multi2', type: 'Message', content: {} },
        ],
        { signature: 'batch_sig' },
      );

      assert.equal(results.length, 2);
      assert.equal(results[0].signature, 'batch_sig');
      assert.equal(results[1].signature, 'batch_sig');
    });
  });

  // ===========================================================================
  // Model version
  // ===========================================================================

  describe('Frame model version', () => {
    it('should have model version 4', () => {
      assert.equal(models.Frame.version, 4, 'Frame model version should be 4 after adding state field');
    });
  });
});
