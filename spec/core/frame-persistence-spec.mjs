'use strict';

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import XID from 'xid-js';

// =============================================================================
// Helper: generate valid frame XIDs with the frm_ prefix
// =============================================================================

function generateFrameID() {
  return `frm_${XID.next()}`;
}

// =============================================================================
// Frame Persistence Tests
// =============================================================================

describe('FramePersistence', () => {
  let core;
  let persistence;
  let org;
  let session;
  let models;

  beforeEach(async () => {
    let { KikxCore } = await import('../../src/core/kikx-core.mjs');
    core = new KikxCore();
    await core.start();

    let { FramePersistence } = await import('../../src/core/frames/index.mjs');
    persistence = new FramePersistence(core.getContext());

    models = core.getModels();

    org = await models.Organization.create({ name: 'Test Org' });
    session = await models.Session.create({ organizationID: org.id, name: 'Test Session' });
  });

  afterEach(async () => {
    if (core && core.isStarted())
      await core.stop();

    core = null;
  });

  // ===========================================================================
  // Construction
  // ===========================================================================

  describe('construction', () => {
    it('should create with a valid context', () => {
      assert.ok(persistence);
    });

    it('should throw if context is missing', async () => {
      let { FramePersistence } = await import('../../src/core/frames/index.mjs');
      assert.throws(() => new FramePersistence(), /requires a CascadingContext/);
    });

    it('should throw if context has no models', async () => {
      let { FramePersistence } = await import('../../src/core/frames/index.mjs');
      let { CascadingContext } = await import('../../src/core/context/index.mjs');
      let emptyContext = new CascadingContext({});
      assert.throws(() => new FramePersistence(emptyContext), /requires models/);
    });
  });

  // ===========================================================================
  // saveFrames
  // ===========================================================================

  describe('saveFrames', () => {
    it('should save a single frame', async () => {
      let frameID = generateFrameID();
      let frames  = [
        { id: frameID, type: 'message', content: { text: 'hello' }, targets: [], order: 1, timestamp: Date.now() },
      ];

      let results = await persistence.saveFrames(session.id, frames);
      assert.equal(results.length, 1);
      assert.equal(results[0].id, frameID);
      assert.equal(results[0].type, 'message');
      assert.equal(results[0].sessionID, session.id);
    });

    it('should save multiple frames', async () => {
      let now = Date.now();
      let id1 = generateFrameID();
      let id2 = generateFrameID();
      let id3 = generateFrameID();

      let frames = [
        { id: id1, type: 'message', content: { text: 'one' }, order: 1, timestamp: now },
        { id: id2, type: 'message', content: { text: 'two' }, order: 2, timestamp: now + 1 },
        { id: id3, type: 'tool-call', content: { name: 'search' }, order: 3, timestamp: now + 2 },
      ];

      let results = await persistence.saveFrames(session.id, frames);
      assert.equal(results.length, 3);
    });

    it('should update existing frames (upsert)', async () => {
      let frameID = generateFrameID();
      let frames  = [
        { id: frameID, type: 'message', content: { text: 'original' }, order: 1, timestamp: Date.now() },
      ];

      await persistence.saveFrames(session.id, frames);

      // Save again with updated content
      let updatedFrames = [
        { id: frameID, type: 'message', content: { text: 'updated' }, order: 1, timestamp: Date.now() },
      ];

      let results = await persistence.saveFrames(session.id, updatedFrames);
      assert.equal(results.length, 1);

      // Verify only one record exists
      let count = await persistence.getFrameCount(session.id);
      assert.equal(count, 1);

      // Verify content was updated
      let loaded    = await persistence.loadFrames(session.id);
      let loadedArr = loaded.toArray();
      assert.equal(loadedArr.length, 1);
      assert.deepEqual(loadedArr[0].content, { text: 'updated' });
    });

    it('should serialize content object to JSON string', async () => {
      let frameID = generateFrameID();
      let content = { text: 'hello', format: 'html', nested: { a: 1 } };
      let frames  = [
        { id: frameID, type: 'message', content, order: 1, timestamp: Date.now() },
      ];

      await persistence.saveFrames(session.id, frames);

      // The DB record stores content as a string
      let dbFrame = await models.Frame.where.id.EQ(frameID).first();
      assert.equal(typeof dbFrame.content, 'string');
      assert.deepEqual(JSON.parse(dbFrame.content), content);
    });

    it('should serialize targets array to JSON string', async () => {
      let frameID = generateFrameID();
      let targets = ['target_a', 'target_b'];
      let frames  = [
        { id: frameID, type: 'prompt-response', content: {}, targets, order: 1, timestamp: Date.now() },
      ];

      await persistence.saveFrames(session.id, frames);

      let dbFrame = await models.Frame.where.id.EQ(frameID).first();
      assert.equal(typeof dbFrame.targets, 'string');
      assert.deepEqual(JSON.parse(dbFrame.targets), targets);
    });

    it('should handle missing optional fields', async () => {
      let frameID = generateFrameID();
      let frames  = [
        { id: frameID, type: 'message', order: 1, timestamp: Date.now() },
      ];

      let results = await persistence.saveFrames(session.id, frames);
      assert.equal(results.length, 1);

      let dbFrame = await models.Frame.where.id.EQ(frameID).first();
      assert.equal(dbFrame.parentID, null);
      assert.equal(dbFrame.groupID, null);
      assert.equal(dbFrame.authorType, null);
      assert.equal(dbFrame.hidden, true);
      assert.equal(dbFrame.deleted, false);
    });

    it('should default interactionID to frame id when not provided', async () => {
      let frameID = generateFrameID();
      let frames  = [
        { id: frameID, type: 'message', order: 1, timestamp: Date.now() },
      ];

      await persistence.saveFrames(session.id, frames);

      let dbFrame = await models.Frame.where.id.EQ(frameID).first();
      assert.equal(dbFrame.interactionID, frameID);
    });

    it('should use provided interactionID when present', async () => {
      let frameID = generateFrameID();
      let frames  = [
        { id: frameID, type: 'message', interactionID: 'int_root', order: 1, timestamp: Date.now() },
      ];

      await persistence.saveFrames(session.id, frames);

      let dbFrame = await models.Frame.where.id.EQ(frameID).first();
      assert.equal(dbFrame.interactionID, 'int_root');
    });

    it('should return empty array for empty input', async () => {
      let results = await persistence.saveFrames(session.id, []);
      assert.deepEqual(results, []);
    });

    it('should skip frames without an id', async () => {
      let frameID = generateFrameID();
      let frames  = [
        { type: 'message', order: 1, timestamp: Date.now() },
        { id: frameID, type: 'message', order: 2, timestamp: Date.now() },
      ];

      let results = await persistence.saveFrames(session.id, frames);
      assert.equal(results.length, 1);
      assert.equal(results[0].id, frameID);
    });

    it('should throw if sessionID is missing', async () => {
      await assert.rejects(
        () => persistence.saveFrames(null, [{ id: generateFrameID(), type: 'message' }]),
        /sessionID is required/,
      );
    });

    it('should handle content that is already a string', async () => {
      let frameID    = generateFrameID();
      let contentStr = '{"text":"already serialized"}';
      let frames     = [
        { id: frameID, type: 'message', content: contentStr, order: 1, timestamp: Date.now() },
      ];

      await persistence.saveFrames(session.id, frames);

      let dbFrame = await models.Frame.where.id.EQ(frameID).first();
      assert.equal(dbFrame.content, contentStr);
    });
  });

  // ===========================================================================
  // loadFrames
  // ===========================================================================

  describe('loadFrames', () => {
    it('should load all frames for a session', async () => {
      let now = Date.now();
      let id1 = generateFrameID();
      let id2 = generateFrameID();

      await persistence.saveFrames(session.id, [
        { id: id1, type: 'message', content: { text: 'one' }, order: 1, timestamp: now },
        { id: id2, type: 'message', content: { text: 'two' }, order: 2, timestamp: now + 1 },
      ]);

      let frameManager = await persistence.loadFrames(session.id);
      let frames       = frameManager.toArray();

      assert.equal(frames.length, 2);
      assert.equal(frames[0].id, id1);
      assert.equal(frames[1].id, id2);
    });

    it('should return frames sorted by order ascending', async () => {
      let now = Date.now();
      let id1 = generateFrameID();
      let id2 = generateFrameID();
      let id3 = generateFrameID();

      // Save in reverse order
      await persistence.saveFrames(session.id, [
        { id: id3, type: 'message', content: { text: 'three' }, order: 3, timestamp: now + 2 },
        { id: id1, type: 'message', content: { text: 'one' }, order: 1, timestamp: now },
        { id: id2, type: 'message', content: { text: 'two' }, order: 2, timestamp: now + 1 },
      ]);

      let frameManager = await persistence.loadFrames(session.id);
      let frames       = frameManager.toArray();

      // Should be sorted by order, not insertion order
      assert.equal(frames[0].content.text, 'one');
      assert.equal(frames[1].content.text, 'two');
      assert.equal(frames[2].content.text, 'three');
    });

    it('should load frames filtered by interactionID', async () => {
      let now = Date.now();
      let id1 = generateFrameID();
      let id2 = generateFrameID();
      let id3 = generateFrameID();

      await persistence.saveFrames(session.id, [
        { id: id1, type: 'message', interactionID: 'int_A', order: 1, timestamp: now },
        { id: id2, type: 'message', interactionID: 'int_B', order: 2, timestamp: now + 1 },
        { id: id3, type: 'message', interactionID: 'int_A', order: 3, timestamp: now + 2 },
      ]);

      let frameManager = await persistence.loadFrames(session.id, { interactionID: 'int_A' });
      let frames       = frameManager.toArray();

      assert.equal(frames.length, 2);
      assert.equal(frames[0].id, id1);
      assert.equal(frames[1].id, id3);
    });

    it('should load frames after a given order (for reconnection replay)', async () => {
      let now = Date.now();
      let id1 = generateFrameID();
      let id2 = generateFrameID();
      let id3 = generateFrameID();
      let id4 = generateFrameID();

      await persistence.saveFrames(session.id, [
        { id: id1, type: 'message', order: 1, timestamp: now },
        { id: id2, type: 'message', order: 2, timestamp: now + 1 },
        { id: id3, type: 'message', order: 3, timestamp: now + 2 },
        { id: id4, type: 'message', order: 4, timestamp: now + 3 },
      ]);

      let frameManager = await persistence.loadFrames(session.id, { afterOrder: 2 });
      let frames       = frameManager.toArray();

      assert.equal(frames.length, 2);
      assert.equal(frames[0].id, id3);
      assert.equal(frames[1].id, id4);
    });

    it('should return a populated FrameManager instance', async () => {
      let { FrameManager } = await import('../../src/shared/frame-manager/frame-manager.mjs');
      let frameID          = generateFrameID();

      await persistence.saveFrames(session.id, [
        { id: frameID, type: 'message', content: { text: 'test' }, order: 1, timestamp: Date.now() },
      ]);

      let frameManager = await persistence.loadFrames(session.id);
      assert.ok(frameManager instanceof FrameManager);
      assert.ok(frameManager.get(frameID));
    });

    it('should return an empty FrameManager for a session with no frames', async () => {
      let frameManager = await persistence.loadFrames(session.id);
      let frames       = frameManager.toArray();
      assert.equal(frames.length, 0);
    });

    it('should deserialize content from JSON string to object', async () => {
      let frameID = generateFrameID();
      let content = { text: 'hello', nested: { deep: true } };

      await persistence.saveFrames(session.id, [
        { id: frameID, type: 'message', content, order: 1, timestamp: Date.now() },
      ]);

      let frameManager = await persistence.loadFrames(session.id);
      let frame        = frameManager.get(frameID);

      assert.deepEqual(frame.content, content);
    });

    it('should deserialize targets from JSON string to array', async () => {
      let frameID = generateFrameID();
      let targets = ['target_a', 'target_b'];

      await persistence.saveFrames(session.id, [
        { id: frameID, type: 'prompt-response', targets, order: 1, timestamp: Date.now() },
      ]);

      let frameManager = await persistence.loadFrames(session.id);
      let frame        = frameManager.get(frameID);

      assert.deepEqual(frame.targets, targets);
    });
  });

  // ===========================================================================
  // loadFramesInto
  // ===========================================================================

  describe('loadFramesInto', () => {
    it('should load frames into an existing FrameManager', async () => {
      let { FrameManager } = await import('../../src/shared/frame-manager/frame-manager.mjs');
      let frameManager     = new FrameManager({ history: true });
      let frameID          = generateFrameID();

      // Pre-populate with a frame
      frameManager.merge([
        { id: 'existing_001', type: 'message', content: { text: 'existing' } },
      ]);

      await persistence.saveFrames(session.id, [
        { id: frameID, type: 'message', content: { text: 'from db' }, order: 1, timestamp: Date.now() },
      ]);

      let loadedFrames = await persistence.loadFramesInto(frameManager, session.id);

      assert.equal(loadedFrames.length, 1);
      assert.ok(frameManager.get('existing_001'), 'should still have the pre-existing frame');
      assert.ok(frameManager.get(frameID), 'should have the loaded frame');
    });

    it('should return the array of loaded frame data', async () => {
      let id1 = generateFrameID();
      let id2 = generateFrameID();

      await persistence.saveFrames(session.id, [
        { id: id1, type: 'message', order: 1, timestamp: Date.now() },
        { id: id2, type: 'message', order: 2, timestamp: Date.now() + 1 },
      ]);

      let { FrameManager } = await import('../../src/shared/frame-manager/frame-manager.mjs');
      let frameManager     = new FrameManager({ history: true });

      let loaded = await persistence.loadFramesInto(frameManager, session.id);
      assert.equal(loaded.length, 2);
      assert.equal(loaded[0].id, id1);
      assert.equal(loaded[1].id, id2);
    });

    it('should throw if sessionID is missing', async () => {
      let { FrameManager } = await import('../../src/shared/frame-manager/frame-manager.mjs');
      let frameManager     = new FrameManager({ history: true });

      await assert.rejects(
        () => persistence.loadFramesInto(frameManager, null),
        /sessionID is required/,
      );
    });
  });

  // ===========================================================================
  // deleteFrames
  // ===========================================================================

  describe('deleteFrames', () => {
    it('should delete all frames for a session', async () => {
      let now = Date.now();
      let id1 = generateFrameID();
      let id2 = generateFrameID();

      await persistence.saveFrames(session.id, [
        { id: id1, type: 'message', order: 1, timestamp: now },
        { id: id2, type: 'message', order: 2, timestamp: now + 1 },
      ]);

      let deleted = await persistence.deleteFrames(session.id);
      assert.equal(deleted, 2);

      let count = await persistence.getFrameCount(session.id);
      assert.equal(count, 0);
    });

    it('should delete only frames for a specific interactionID', async () => {
      let now = Date.now();
      let id1 = generateFrameID();
      let id2 = generateFrameID();
      let id3 = generateFrameID();

      await persistence.saveFrames(session.id, [
        { id: id1, type: 'message', interactionID: 'int_A', order: 1, timestamp: now },
        { id: id2, type: 'message', interactionID: 'int_B', order: 2, timestamp: now + 1 },
        { id: id3, type: 'message', interactionID: 'int_A', order: 3, timestamp: now + 2 },
      ]);

      let deleted = await persistence.deleteFrames(session.id, { interactionID: 'int_A' });
      assert.equal(deleted, 2);

      let count = await persistence.getFrameCount(session.id);
      assert.equal(count, 1);

      // Verify the remaining frame is from int_B
      let dbFrame = await models.Frame.where.sessionID.EQ(session.id).first();
      assert.equal(dbFrame.interactionID, 'int_B');
    });

    it('should return 0 when no frames to delete', async () => {
      let deleted = await persistence.deleteFrames(session.id);
      assert.equal(deleted, 0);
    });

    it('should throw if sessionID is missing', async () => {
      await assert.rejects(
        () => persistence.deleteFrames(null),
        /sessionID is required/,
      );
    });
  });

  // ===========================================================================
  // getNextOrder
  // ===========================================================================

  describe('getNextOrder', () => {
    it('should return 1 for an empty session', async () => {
      let nextOrder = await persistence.getNextOrder(session.id);
      assert.equal(nextOrder, 1);
    });

    it('should return max + 1 when frames exist', async () => {
      let now = Date.now();
      let id1 = generateFrameID();
      let id2 = generateFrameID();
      let id3 = generateFrameID();

      await persistence.saveFrames(session.id, [
        { id: id1, type: 'message', order: 1, timestamp: now },
        { id: id2, type: 'message', order: 5, timestamp: now + 1 },
        { id: id3, type: 'message', order: 3, timestamp: now + 2 },
      ]);

      let nextOrder = await persistence.getNextOrder(session.id);
      assert.equal(nextOrder, 6);
    });

    it('should throw if sessionID is missing', async () => {
      await assert.rejects(
        () => persistence.getNextOrder(null),
        /sessionID is required/,
      );
    });
  });

  // ===========================================================================
  // getFrameCount
  // ===========================================================================

  describe('getFrameCount', () => {
    it('should return 0 for an empty session', async () => {
      let count = await persistence.getFrameCount(session.id);
      assert.equal(count, 0);
    });

    it('should return correct count', async () => {
      let now = Date.now();
      let id1 = generateFrameID();
      let id2 = generateFrameID();
      let id3 = generateFrameID();

      await persistence.saveFrames(session.id, [
        { id: id1, type: 'message', order: 1, timestamp: now },
        { id: id2, type: 'message', order: 2, timestamp: now + 1 },
        { id: id3, type: 'tool-call', order: 3, timestamp: now + 2 },
      ]);

      let count = await persistence.getFrameCount(session.id);
      assert.equal(count, 3);
    });

    it('should throw if sessionID is missing', async () => {
      await assert.rejects(
        () => persistence.getFrameCount(null),
        /sessionID is required/,
      );
    });
  });

  // ===========================================================================
  // getMaxOrder
  // ===========================================================================

  describe('getMaxOrder', () => {
    it('should return 0 for an empty session', async () => {
      let maxOrder = await persistence.getMaxOrder(session.id);
      assert.equal(maxOrder, 0);
    });

    it('should return the highest order among frames', async () => {
      let now = Date.now();
      let id1 = generateFrameID();
      let id2 = generateFrameID();
      let id3 = generateFrameID();

      await persistence.saveFrames(session.id, [
        { id: id1, type: 'message', order: 2, timestamp: now },
        { id: id2, type: 'message', order: 7, timestamp: now + 1 },
        { id: id3, type: 'message', order: 5, timestamp: now + 2 },
      ]);

      let maxOrder = await persistence.getMaxOrder(session.id);
      assert.equal(maxOrder, 7);
    });

    it('should return correct order with a single frame', async () => {
      let id = generateFrameID();

      await persistence.saveFrames(session.id, [
        { id, type: 'message', order: 42, timestamp: Date.now() },
      ]);

      let maxOrder = await persistence.getMaxOrder(session.id);
      assert.equal(maxOrder, 42);
    });

    it('should not be affected by frames in other sessions', async () => {
      let otherSession = await models.Session.create({ organizationID: org.id, name: 'Other Session' });

      let id1 = generateFrameID();
      let id2 = generateFrameID();

      await persistence.saveFrames(session.id, [
        { id: id1, type: 'message', order: 3, timestamp: Date.now() },
      ]);

      await persistence.saveFrames(otherSession.id, [
        { id: id2, type: 'message', order: 100, timestamp: Date.now() },
      ]);

      let maxOrder = await persistence.getMaxOrder(session.id);
      assert.equal(maxOrder, 3);
    });

    it('should throw if sessionID is missing', async () => {
      await assert.rejects(
        () => persistence.getMaxOrder(null),
        /sessionID is required/,
      );
    });
  });

  // ===========================================================================
  // _frameToRecord / _recordToFrame
  // ===========================================================================

  describe('_frameToRecord', () => {
    it('should map parentID to parentID', () => {
      let record = persistence._frameToRecord('ses_001', 'int_001', {
        id:       'frm_test',
        type:     'message',
        parentID: 'frm_parent',
        order:    1,
      });

      assert.equal(record.parentID, 'frm_parent');
    });

    it('should map groupID to groupID', () => {
      let record = persistence._frameToRecord('ses_001', 'int_001', {
        id:      'frm_test',
        type:    'message',
        groupID: 'grp_001',
        order:   1,
      });

      assert.equal(record.groupID, 'grp_001');
    });

    it('should serialize content object to JSON string', () => {
      let record = persistence._frameToRecord('ses_001', 'int_001', {
        id:      'frm_test',
        type:    'message',
        content: { text: 'hello' },
        order:   1,
      });

      assert.equal(typeof record.content, 'string');
      assert.deepEqual(JSON.parse(record.content), { text: 'hello' });
    });

    it('should serialize targets array to JSON string', () => {
      let record = persistence._frameToRecord('ses_001', 'int_001', {
        id:      'frm_test',
        type:    'message',
        targets: ['frm_a', 'frm_b'],
        order:   1,
      });

      assert.equal(typeof record.targets, 'string');
      assert.deepEqual(JSON.parse(record.targets), ['frm_a', 'frm_b']);
    });

    it('should set sessionID and interactionID', () => {
      let record = persistence._frameToRecord('ses_123', 'int_456', {
        id:    'frm_test',
        type:  'message',
        order: 1,
      });

      assert.equal(record.sessionID, 'ses_123');
      assert.equal(record.interactionID, 'int_456');
    });
  });

  describe('_recordToFrame', () => {
    it('should map parentID to parentID', () => {
      let frame = persistence._recordToFrame({
        id:        'frm_test',
        type:      'message',
        parentID:  'frm_parent',
        order:     1,
        timestamp: Date.now(),
      });

      assert.equal(frame.parentID, 'frm_parent');
    });

    it('should map groupID to groupID', () => {
      let frame = persistence._recordToFrame({
        id:        'frm_test',
        type:      'message',
        groupID:   'grp_001',
        order:     1,
        timestamp: Date.now(),
      });

      assert.equal(frame.groupID, 'grp_001');
    });

    it('should deserialize content JSON string to object', () => {
      let frame = persistence._recordToFrame({
        id:        'frm_test',
        type:      'message',
        content:   '{"text":"hello"}',
        order:     1,
        timestamp: Date.now(),
      });

      assert.deepEqual(frame.content, { text: 'hello' });
    });

    it('should deserialize targets JSON string to array', () => {
      let frame = persistence._recordToFrame({
        id:        'frm_test',
        type:      'message',
        targets:   '["frm_a","frm_b"]',
        order:     1,
        timestamp: Date.now(),
      });

      assert.deepEqual(frame.targets, ['frm_a', 'frm_b']);
    });

    it('should default content to empty object when null', () => {
      let frame = persistence._recordToFrame({
        id:        'frm_test',
        type:      'message',
        content:   null,
        order:     1,
        timestamp: Date.now(),
      });

      assert.deepEqual(frame.content, {});
    });

    it('should default targets to empty array when null', () => {
      let frame = persistence._recordToFrame({
        id:        'frm_test',
        type:      'message',
        targets:   null,
        order:     1,
        timestamp: Date.now(),
      });

      assert.deepEqual(frame.targets, []);
    });
  });

  // ===========================================================================
  // Round-trip
  // ===========================================================================

  describe('round-trip', () => {
    it('should preserve data integrity through save and load', async () => {
      let now     = Date.now();
      let frameID = generateFrameID();
      let content = { text: 'hello world', format: 'html', metadata: { score: 42 } };
      let targets = ['target_1', 'target_2'];

      let frames = [
        {
          id:            frameID,
          type:          'message',
          content:       content,
          targets:       targets,
          parentID:      'frm_parent_id',
          groupID:       'grp_001',
          groupType:     'thinking',
          interactionID: 'int_root',
          authorType:    'agent',
          authorID:      'agt_test',
          hidden:        false,
          deleted:       false,
          processed:     false,
          processedAt:   null,
          order:         7,
          timestamp:     now,
        },
      ];

      await persistence.saveFrames(session.id, frames);
      let frameManager = await persistence.loadFrames(session.id);
      let loaded       = frameManager.toArray();

      assert.equal(loaded.length, 1);

      let frame = loaded[0];
      assert.equal(frame.id, frameID);
      assert.equal(frame.type, 'message');
      assert.deepEqual(frame.content, content);
      assert.deepEqual(frame.targets, targets);
      assert.equal(frame.parentID, 'frm_parent_id');
      assert.equal(frame.groupID, 'grp_001');
      assert.equal(frame.groupType, 'thinking');
      assert.equal(frame.hidden, false);
      assert.equal(frame.deleted, false);
    });

    it('should handle multiple save-load cycles', async () => {
      let now = Date.now();
      let id1 = generateFrameID();
      let id2 = generateFrameID();

      // First batch
      await persistence.saveFrames(session.id, [
        { id: id1, type: 'message', content: { text: 'first' }, order: 1, timestamp: now },
      ]);

      // Second batch
      await persistence.saveFrames(session.id, [
        { id: id2, type: 'message', content: { text: 'second' }, order: 2, timestamp: now + 1 },
      ]);

      // Load all
      let frameManager = await persistence.loadFrames(session.id);
      let frames       = frameManager.toArray();

      assert.equal(frames.length, 2);
      assert.deepEqual(frames[0].content, { text: 'first' });
      assert.deepEqual(frames[1].content, { text: 'second' });
    });
  });
});
