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
// Frame Persistence — Lazy Content Loading Tests
// =============================================================================

describe('FramePersistence — lazy content loading', () => {
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

    org     = await models.Organization.create({ name: 'Test Org' });
    session = await models.Session.create({ organizationID: org.id, name: 'Lazy Test Session' });
  });

  afterEach(async () => {
    if (core && core.isStarted())
      await core.stop();

    core = null;
  });

  // ===========================================================================
  // metadataOnly option
  // ===========================================================================

  describe('loadFramesInto with metadataOnly', () => {
    it('should load frames without content when metadataOnly is true', async () => {
      let now = Date.now();
      let id1 = generateFrameID();
      let id2 = generateFrameID();

      await persistence.saveFrames(session.id, [
        { id: id1, type: 'Message', content: { text: 'hello' }, order: 1, timestamp: now },
        { id: id2, type: 'Message', content: { text: 'world' }, order: 2, timestamp: now + 1 },
      ]);

      let { FrameManager } = await import('../../src/shared/frame-manager/frame-manager.mjs');
      let frameManager      = new FrameManager({ history: true });

      await persistence.loadFramesInto(frameManager, session.id, { metadataOnly: true });
      let frames = frameManager.toArray();

      assert.equal(frames.length, 2);
      assert.equal(frames[0].content, null);
      assert.equal(frames[1].content, null);
    });

    it('should preserve all other frame properties when metadataOnly is true', async () => {
      let now     = Date.now();
      let frameID = generateFrameID();

      await persistence.saveFrames(session.id, [
        {
          id:            frameID,
          type:          'ToolCall',
          content:       { name: 'search', input: { query: 'test' } },
          targets:       ['target_1', 'target_2'],
          parentID:      'frm_parent',
          groupID:       'grp_001',
          groupType:     'thinking',
          interactionID: 'int_root',
          authorType:    'agent',
          authorID:      'agt_test',
          hidden:        false,
          deleted:       false,
          processed:     true,
          order:         5,
          timestamp:     now,
        },
      ]);

      let { FrameManager } = await import('../../src/shared/frame-manager/frame-manager.mjs');
      let frameManager      = new FrameManager({ history: true });

      await persistence.loadFramesInto(frameManager, session.id, { metadataOnly: true });
      let frame = frameManager.get(frameID);

      assert.equal(frame.content, null, 'content should be null');
      assert.equal(frame.id, frameID);
      assert.equal(frame.type, 'ToolCall');
      assert.deepEqual(frame.targets, ['target_1', 'target_2']);
      assert.equal(frame.parentID, 'frm_parent');
      assert.equal(frame.groupID, 'grp_001');
      assert.equal(frame.groupType, 'thinking');
      assert.equal(frame.authorType, 'agent');
      assert.equal(frame.authorID, 'agt_test');
      assert.equal(frame.hidden, false);
      assert.equal(frame.deleted, false);
      assert.equal(frame.processed, true);
      assert.equal(typeof frame.order, 'number', 'order should be a number');
      assert.equal(frame.timestamp, now);
    });

    it('should still load content normally when metadataOnly is false (default)', async () => {
      let frameID = generateFrameID();

      await persistence.saveFrames(session.id, [
        { id: frameID, type: 'Message', content: { text: 'loaded' }, order: 1, timestamp: Date.now() },
      ]);

      let { FrameManager } = await import('../../src/shared/frame-manager/frame-manager.mjs');
      let frameManager      = new FrameManager({ history: true });

      await persistence.loadFramesInto(frameManager, session.id);
      let frame = frameManager.get(frameID);

      assert.deepEqual(frame.content, { text: 'loaded' });
    });

    it('should still load content when metadataOnly is explicitly false', async () => {
      let frameID = generateFrameID();

      await persistence.saveFrames(session.id, [
        { id: frameID, type: 'Message', content: { text: 'explicit false' }, order: 1, timestamp: Date.now() },
      ]);

      let { FrameManager } = await import('../../src/shared/frame-manager/frame-manager.mjs');
      let frameManager      = new FrameManager({ history: true });

      await persistence.loadFramesInto(frameManager, session.id, { metadataOnly: false });
      let frame = frameManager.get(frameID);

      assert.deepEqual(frame.content, { text: 'explicit false' });
    });

    it('should work with loadFrames (which delegates to loadFramesInto)', async () => {
      let frameID = generateFrameID();

      await persistence.saveFrames(session.id, [
        { id: frameID, type: 'Message', content: { text: 'via loadFrames' }, order: 1, timestamp: Date.now() },
      ]);

      let frameManager = await persistence.loadFrames(session.id, { metadataOnly: true });
      let frame        = frameManager.get(frameID);

      assert.equal(frame.content, null);
    });

    it('should combine metadataOnly with other options (afterOrder, limit)', async () => {
      let now = Date.now();
      let id1 = generateFrameID();
      let id2 = generateFrameID();
      let id3 = generateFrameID();

      await persistence.saveFrames(session.id, [
        { id: id1, type: 'Message', content: { text: 'one' }, order: 1, timestamp: now },
        { id: id2, type: 'Message', content: { text: 'two' }, order: 2, timestamp: now + 1 },
        { id: id3, type: 'Message', content: { text: 'three' }, order: 3, timestamp: now + 2 },
      ]);

      let frameManager = await persistence.loadFrames(session.id, {
        metadataOnly: true,
        afterOrder:   1,
        limit:        1,
      });

      let frames = frameManager.toArray();

      assert.equal(frames.length, 1);
      assert.equal(frames[0].id, id2);
      assert.equal(frames[0].content, null);
    });
  });

  // ===========================================================================
  // loadContent
  // ===========================================================================

  describe('loadContent', () => {
    it('should return the full content for a single frame', async () => {
      let frameID = generateFrameID();
      let content = { text: 'hello', nested: { deep: true, count: 42 } };

      await persistence.saveFrames(session.id, [
        { id: frameID, type: 'Message', content, order: 1, timestamp: Date.now() },
      ]);

      let loadedContent = await persistence.loadContent(frameID);

      assert.deepEqual(loadedContent, content);
    });

    it('should return null for a non-existent frame', async () => {
      let result = await persistence.loadContent('frm_nonexistent');

      assert.equal(result, null);
    });

    it('should return null when frameID is null', async () => {
      let result = await persistence.loadContent(null);

      assert.equal(result, null);
    });

    it('should return null when frameID is undefined', async () => {
      let result = await persistence.loadContent(undefined);

      assert.equal(result, null);
    });

    it('should return null when frameID is empty string', async () => {
      let result = await persistence.loadContent('');

      assert.equal(result, null);
    });

    it('should parse JSON string content from the database', async () => {
      let frameID = generateFrameID();
      let content = { format: 'html', body: '<p>test</p>' };

      await persistence.saveFrames(session.id, [
        { id: frameID, type: 'Message', content, order: 1, timestamp: Date.now() },
      ]);

      let loadedContent = await persistence.loadContent(frameID);

      assert.deepEqual(loadedContent, content);
    });

    it('should return string content as-is when it is not valid JSON', async () => {
      let frameID    = generateFrameID();
      let badContent = 'this is not JSON {{{';

      // Save directly via model to bypass normal serialization
      await models.Frame.create({
        id:            frameID,
        sessionID:     session.id,
        interactionID: frameID,
        type:          'Message',
        content:       badContent,
        order:         1,
        timestamp:     Date.now(),
        hidden:        true,
        deleted:       false,
        processed:     false,
      });

      let loadedContent = await persistence.loadContent(frameID);

      assert.equal(loadedContent, badContent);
    });

    it('should return empty object when content is null in the database', async () => {
      let frameID = generateFrameID();

      await models.Frame.create({
        id:            frameID,
        sessionID:     session.id,
        interactionID: frameID,
        type:          'Message',
        content:       null,
        order:         1,
        timestamp:     Date.now(),
        hidden:        true,
        deleted:       false,
        processed:     false,
      });

      let loadedContent = await persistence.loadContent(frameID);

      assert.deepEqual(loadedContent, {});
    });
  });

  // ===========================================================================
  // loadContentBulk
  // ===========================================================================

  describe('loadContentBulk', () => {
    it('should return a Map of frameID to content for multiple frames', async () => {
      let now = Date.now();
      let id1 = generateFrameID();
      let id2 = generateFrameID();
      let id3 = generateFrameID();

      await persistence.saveFrames(session.id, [
        { id: id1, type: 'Message', content: { text: 'one' }, order: 1, timestamp: now },
        { id: id2, type: 'Message', content: { text: 'two' }, order: 2, timestamp: now + 1 },
        { id: id3, type: 'ToolCall', content: { name: 'search' }, order: 3, timestamp: now + 2 },
      ]);

      let contentMap = await persistence.loadContentBulk([id1, id2, id3]);

      assert.ok(contentMap instanceof Map);
      assert.equal(contentMap.size, 3);
      assert.deepEqual(contentMap.get(id1), { text: 'one' });
      assert.deepEqual(contentMap.get(id2), { text: 'two' });
      assert.deepEqual(contentMap.get(id3), { name: 'search' });
    });

    it('should return an empty Map for an empty array', async () => {
      let result = await persistence.loadContentBulk([]);

      assert.ok(result instanceof Map);
      assert.equal(result.size, 0);
    });

    it('should return an empty Map for null input', async () => {
      let result = await persistence.loadContentBulk(null);

      assert.ok(result instanceof Map);
      assert.equal(result.size, 0);
    });

    it('should return an empty Map for undefined input', async () => {
      let result = await persistence.loadContentBulk(undefined);

      assert.ok(result instanceof Map);
      assert.equal(result.size, 0);
    });

    it('should skip non-existent frame IDs without error', async () => {
      let frameID = generateFrameID();

      await persistence.saveFrames(session.id, [
        { id: frameID, type: 'Message', content: { text: 'exists' }, order: 1, timestamp: Date.now() },
      ]);

      let contentMap = await persistence.loadContentBulk([frameID, 'frm_nonexistent', 'frm_also_missing']);

      assert.equal(contentMap.size, 1);
      assert.deepEqual(contentMap.get(frameID), { text: 'exists' });
      assert.equal(contentMap.has('frm_nonexistent'), false);
      assert.equal(contentMap.has('frm_also_missing'), false);
    });

    it('should handle string content that is not valid JSON', async () => {
      let frameID = generateFrameID();

      await models.Frame.create({
        id:            frameID,
        sessionID:     session.id,
        interactionID: frameID,
        type:          'Message',
        content:       'not valid json >>>',
        order:         1,
        timestamp:     Date.now(),
        hidden:        true,
        deleted:       false,
        processed:     false,
      });

      let contentMap = await persistence.loadContentBulk([frameID]);

      assert.equal(contentMap.size, 1);
      assert.equal(contentMap.get(frameID), 'not valid json >>>');
    });

    it('should return empty object for frames with null content', async () => {
      let frameID = generateFrameID();

      await models.Frame.create({
        id:            frameID,
        sessionID:     session.id,
        interactionID: frameID,
        type:          'Message',
        content:       null,
        order:         1,
        timestamp:     Date.now(),
        hidden:        true,
        deleted:       false,
        processed:     false,
      });

      let contentMap = await persistence.loadContentBulk([frameID]);

      assert.equal(contentMap.size, 1);
      assert.deepEqual(contentMap.get(frameID), {});
    });
  });

  // ===========================================================================
  // loadFramesInWindow
  // ===========================================================================

  describe('loadFramesInWindow', () => {
    it('should load only frames within the given order range', async () => {
      let now = Date.now();
      let id1 = generateFrameID();
      let id2 = generateFrameID();
      let id3 = generateFrameID();
      let id4 = generateFrameID();
      let id5 = generateFrameID();

      await persistence.saveFrames(session.id, [
        { id: id1, type: 'Message', content: { text: 'one' }, order: 1, timestamp: now },
        { id: id2, type: 'Message', content: { text: 'two' }, order: 2, timestamp: now + 1 },
        { id: id3, type: 'Message', content: { text: 'three' }, order: 3, timestamp: now + 2 },
        { id: id4, type: 'Message', content: { text: 'four' }, order: 4, timestamp: now + 3 },
        { id: id5, type: 'Message', content: { text: 'five' }, order: 5, timestamp: now + 4 },
      ]);

      // Load frames with order > 1 AND order < 5 (should get orders 2, 3, 4)
      let frameManager = await persistence.loadFramesInWindow(session.id, 1, 5);
      let frames       = frameManager.toArray();

      assert.equal(frames.length, 3);
      assert.equal(frames[0].id, id2);
      assert.equal(frames[1].id, id3);
      assert.equal(frames[2].id, id4);
    });

    it('should load frames with full content (not metadata-only)', async () => {
      let frameID = generateFrameID();

      await persistence.saveFrames(session.id, [
        { id: frameID, type: 'Message', content: { text: 'full content' }, order: 5, timestamp: Date.now() },
      ]);

      let frameManager = await persistence.loadFramesInWindow(session.id, 0, 10);
      let frame        = frameManager.get(frameID);

      assert.deepEqual(frame.content, { text: 'full content' });
    });

    it('should return empty FrameManager when no frames in range', async () => {
      let frameID = generateFrameID();

      await persistence.saveFrames(session.id, [
        { id: frameID, type: 'Message', content: { text: 'outside' }, order: 100, timestamp: Date.now() },
      ]);

      let frameManager = await persistence.loadFramesInWindow(session.id, 0, 10);
      let frames       = frameManager.toArray();

      assert.equal(frames.length, 0);
    });

    it('should throw if sessionID is missing', async () => {
      await assert.rejects(
        () => persistence.loadFramesInWindow(null, 0, 10),
        /sessionID is required/,
      );
    });

    it('should load all frames when fromOrder and toOrder are both undefined', async () => {
      let now = Date.now();
      let id1 = generateFrameID();
      let id2 = generateFrameID();

      await persistence.saveFrames(session.id, [
        { id: id1, type: 'Message', content: { text: 'one' }, order: 1, timestamp: now },
        { id: id2, type: 'Message', content: { text: 'two' }, order: 2, timestamp: now + 1 },
      ]);

      let frameManager = await persistence.loadFramesInWindow(session.id, undefined, undefined);
      let frames       = frameManager.toArray();

      assert.equal(frames.length, 2);
    });

    it('should load frames after fromOrder when toOrder is undefined', async () => {
      let now = Date.now();
      let id1 = generateFrameID();
      let id2 = generateFrameID();
      let id3 = generateFrameID();

      await persistence.saveFrames(session.id, [
        { id: id1, type: 'Message', content: { text: 'one' }, order: 1, timestamp: now },
        { id: id2, type: 'Message', content: { text: 'two' }, order: 2, timestamp: now + 1 },
        { id: id3, type: 'Message', content: { text: 'three' }, order: 3, timestamp: now + 2 },
      ]);

      let frameManager = await persistence.loadFramesInWindow(session.id, 1, undefined);
      let frames       = frameManager.toArray();

      assert.equal(frames.length, 2);
      assert.equal(frames[0].id, id2);
      assert.equal(frames[1].id, id3);
    });

    it('should load frames before toOrder when fromOrder is undefined', async () => {
      let now = Date.now();
      let id1 = generateFrameID();
      let id2 = generateFrameID();
      let id3 = generateFrameID();

      await persistence.saveFrames(session.id, [
        { id: id1, type: 'Message', content: { text: 'one' }, order: 1, timestamp: now },
        { id: id2, type: 'Message', content: { text: 'two' }, order: 2, timestamp: now + 1 },
        { id: id3, type: 'Message', content: { text: 'three' }, order: 3, timestamp: now + 2 },
      ]);

      let frameManager = await persistence.loadFramesInWindow(session.id, undefined, 3);
      let frames       = frameManager.toArray();

      assert.equal(frames.length, 2);
      assert.equal(frames[0].id, id1);
      assert.equal(frames[1].id, id2);
    });
  });

  // ===========================================================================
  // _recordToFrameMetadataOnly
  // ===========================================================================

  describe('_recordToFrameMetadataOnly', () => {
    it('should set content to null', () => {
      let frame = persistence._recordToFrameMetadataOnly({
        id:        'frm_test',
        type:      'Message',
        content:   '{"text":"hello"}',
        targets:   '["t1"]',
        order:     1,
        timestamp: Date.now(),
        hidden:    false,
        deleted:   false,
        processed: false,
      });

      assert.equal(frame.content, null);
    });

    it('should still deserialize targets', () => {
      let frame = persistence._recordToFrameMetadataOnly({
        id:        'frm_test',
        type:      'Message',
        content:   '{"text":"hello"}',
        targets:   '["target_a","target_b"]',
        order:     1,
        timestamp: Date.now(),
        hidden:    false,
        deleted:   false,
        processed: false,
      });

      assert.deepEqual(frame.targets, ['target_a', 'target_b']);
    });

    it('should preserve all metadata fields', () => {
      let now   = Date.now();
      let frame = persistence._recordToFrameMetadataOnly({
        id:                    'frm_test',
        interactionID:         'int_abc',
        type:                  'ToolResult',
        content:               '{"result":"data"}',
        targets:               null,
        parentID:              'frm_parent',
        groupID:               'grp_001',
        groupType:             'thinking',
        order:                 7,
        timestamp:             now,
        hidden:                true,
        deleted:               false,
        processed:             true,
        processedAt:           now + 100,
        authorType:            'agent',
        authorID:              'agt_123',
        signature:             'sig_abc',
        signingKeyFingerprint: 'fp_xyz',
        state:                 '{"step":2}',
        createdAt:             now - 1000,
      });

      assert.equal(frame.id, 'frm_test');
      assert.equal(frame.interactionID, 'int_abc');
      assert.equal(frame.type, 'ToolResult');
      assert.equal(frame.content, null);
      assert.deepEqual(frame.targets, []);
      assert.equal(frame.parentID, 'frm_parent');
      assert.equal(frame.groupID, 'grp_001');
      assert.equal(frame.groupType, 'thinking');
      assert.equal(frame.order, 7);
      assert.equal(frame.timestamp, now);
      assert.equal(frame.hidden, true);
      assert.equal(frame.deleted, false);
      assert.equal(frame.processed, true);
      assert.equal(frame.processedAt, now + 100);
      assert.equal(frame.authorType, 'agent');
      assert.equal(frame.authorID, 'agt_123');
      assert.equal(frame.signature, 'sig_abc');
      assert.equal(frame.signingKeyFingerprint, 'fp_xyz');
      assert.equal(frame.state, '{"step":2}');
      assert.equal(frame.createdAt, now - 1000);
    });

    it('should handle invalid targets JSON gracefully', () => {
      let frame = persistence._recordToFrameMetadataOnly({
        id:        'frm_test',
        type:      'Message',
        content:   '{"text":"hi"}',
        targets:   'not valid json',
        order:     1,
        timestamp: Date.now(),
        hidden:    false,
        deleted:   false,
        processed: false,
      });

      assert.deepEqual(frame.targets, []);
    });
  });

  // ===========================================================================
  // Integration: metadataOnly + loadContent round-trip
  // ===========================================================================

  describe('metadataOnly + loadContent round-trip', () => {
    it('should load metadata first, then content on demand', async () => {
      let now     = Date.now();
      let frameID = generateFrameID();
      let content = { text: 'lazy loaded', metadata: { score: 99 } };

      await persistence.saveFrames(session.id, [
        { id: frameID, type: 'Message', content, order: 1, timestamp: now },
      ]);

      // Step 1: load metadata only
      let frameManager = await persistence.loadFrames(session.id, { metadataOnly: true });
      let frame        = frameManager.get(frameID);

      assert.equal(frame.content, null, 'content should be null after metadataOnly load');
      assert.equal(frame.type, 'Message', 'type should be present');

      // Step 2: load content on demand
      let loadedContent = await persistence.loadContent(frameID);

      assert.deepEqual(loadedContent, content, 'content should be fully loaded');
    });

    it('should load metadata first, then bulk content for specific frames', async () => {
      let now = Date.now();
      let id1 = generateFrameID();
      let id2 = generateFrameID();
      let id3 = generateFrameID();

      await persistence.saveFrames(session.id, [
        { id: id1, type: 'Message', content: { text: 'alpha' }, order: 1, timestamp: now },
        { id: id2, type: 'Message', content: { text: 'beta' }, order: 2, timestamp: now + 1 },
        { id: id3, type: 'Message', content: { text: 'gamma' }, order: 3, timestamp: now + 2 },
      ]);

      // Step 1: load metadata only
      let frameManager = await persistence.loadFrames(session.id, { metadataOnly: true });
      let frames       = frameManager.toArray();

      assert.equal(frames.length, 3);
      for (let frame of frames)
        assert.equal(frame.content, null);

      // Step 2: bulk load content for only the frames we need
      let contentMap = await persistence.loadContentBulk([id1, id3]);

      assert.equal(contentMap.size, 2);
      assert.deepEqual(contentMap.get(id1), { text: 'alpha' });
      assert.deepEqual(contentMap.get(id3), { text: 'gamma' });
      assert.equal(contentMap.has(id2), false);
    });
  });
});
