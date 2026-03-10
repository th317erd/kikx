'use strict';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import XID from 'xid-js';

import { createKikxCore }     from '../../src/core/index.mjs';
import { FramePersistence }   from '../../src/core/frames/index.mjs';
import { SessionManager }     from '../../src/core/session/index.mjs';
import { FrameManager }       from '../../src/shared/frame-manager/frame-manager.mjs';

// =============================================================================
// Phase D5 — Viewport Management
// =============================================================================
// Verifies:
//   1. FramePersistence.loadFramesInto supports beforeOrder + limit
//   2. FrameManager window operations (loadWindow, evict, getWindowBounds)
//   3. Paginated loading simulates scroll-up behavior
// =============================================================================

describe('Viewport Management (D5)', () => {
  let core;
  let models;
  let context;
  let sessionManager;
  let framePersistence;

  before(async () => {
    core    = createKikxCore();
    await core.start();
    models  = core.getModels();
    context = core.getContext();

    sessionManager   = new SessionManager(context);
    framePersistence = new FramePersistence(context);

    context.setProperty('sessionManager', sessionManager);
    context.setProperty('framePersistence', framePersistence);
  });

  after(async () => {
    if (core && core.isStarted())
      await core.stop();
  });

  async function createTestSession(name) {
    let org     = await models.Organization.create({ name: `D5 Org ${name}` });
    let session = await sessionManager.createSession(org.id, { name });
    return session;
  }

  async function seedFrames(sessionID, count) {
    let { Frame } = models;
    let frames = [];

    for (let i = 1; i <= count; i++) {
      frames.push({
        id:            `frm_${XID.next()}`,
        sessionID:     sessionID,
        type:          'message',
        content:       JSON.stringify({ text: `Message ${i}` }),
        order:         i,
        timestamp:     Date.now() + i,
        interactionID: `int_${XID.next()}`,
        authorType:    'user',
        authorID:      null,
        hidden:        false,
        deleted:       false,
        processed:     false,
        phantom:       false,
      });
    }

    for (let frame of frames)
      await Frame.create(frame);

    return frames;
  }

  // ---------------------------------------------------------------------------
  // FramePersistence: beforeOrder support
  // ---------------------------------------------------------------------------

  describe('FramePersistence beforeOrder', () => {
    it('loads only frames with order < beforeOrder', async () => {
      let session = await createTestSession('beforeOrder test');
      await seedFrames(session.id, 20);

      let frameManager = new FrameManager({ history: false });
      await framePersistence.loadFramesInto(frameManager, session.id, { beforeOrder: 11 });

      let loaded = frameManager.toArray();
      assert.equal(loaded.length, 10);

      for (let frame of loaded)
        assert.ok(frame.order < 11, `Expected order < 11, got ${frame.order}`);
    });

    it('combines beforeOrder with limit', async () => {
      let session = await createTestSession('beforeOrder+limit');
      await seedFrames(session.id, 20);

      let frameManager = new FrameManager({ history: false });
      await framePersistence.loadFramesInto(frameManager, session.id, {
        beforeOrder: 16,
        limit:       5,
      });

      let loaded = frameManager.toArray();
      assert.equal(loaded.length, 5);

      // Should be the first 5 frames with order < 16 (ordered by +order)
      for (let frame of loaded)
        assert.ok(frame.order < 16);
    });

    it('returns empty when beforeOrder is 1 (no frames with order < 1)', async () => {
      let session = await createTestSession('beforeOrder edge');
      await seedFrames(session.id, 5);

      let frameManager = new FrameManager({ history: false });
      await framePersistence.loadFramesInto(frameManager, session.id, { beforeOrder: 1 });

      assert.equal(frameManager.toArray().length, 0);
    });

    it('combines afterOrder and beforeOrder for range queries', async () => {
      let session = await createTestSession('range query');
      await seedFrames(session.id, 20);

      let frameManager = new FrameManager({ history: false });
      let rawFrames = await framePersistence.loadFramesInto(frameManager, session.id, {
        afterOrder:  5,
        beforeOrder: 11,
      });

      // Should load exactly 5 frames (DB orders 6,7,8,9,10)
      assert.equal(rawFrames.length, 5);
      assert.equal(frameManager.toArray().length, 5);

      // Verify content matches the expected range (Messages 6-10)
      let texts = rawFrames.map((f) => {
        let content = (typeof f.content === 'string') ? JSON.parse(f.content) : f.content;
        return content.text;
      });

      for (let i = 6; i <= 10; i++)
        assert.ok(texts.includes(`Message ${i}`), `Expected Message ${i} in results`);
    });
  });

  // ---------------------------------------------------------------------------
  // FrameManager window operations
  // ---------------------------------------------------------------------------

  describe('FrameManager loadWindow', () => {
    it('loadWindow merges frames without emitting per-frame events', () => {
      let manager = new FrameManager({ history: false });
      let events  = [];

      manager.on('frame:added', () => events.push('added'));
      manager.on('frames:bulk-loaded', () => events.push('bulk'));

      manager.loadWindow([
        { id: 'f1', type: 'message', content: { text: 'a' } },
        { id: 'f2', type: 'message', content: { text: 'b' } },
      ]);

      // frame:added should NOT fire; bulk-loaded should
      assert.equal(events.filter((e) => e === 'added').length, 0);
      assert.equal(events.filter((e) => e === 'bulk').length, 1);
      assert.equal(manager.toArray().length, 2);
    });
  });

  describe('FrameManager evict', () => {
    it('evicts frames below the given order', () => {
      let manager = new FrameManager({ history: false });

      manager.merge([
        { id: 'f1', type: 'message', content: {}, order: 1 },
        { id: 'f2', type: 'message', content: {}, order: 2 },
        { id: 'f3', type: 'message', content: {}, order: 3 },
        { id: 'f4', type: 'message', content: {}, order: 4 },
        { id: 'f5', type: 'message', content: {}, order: 5 },
      ], { events: false });

      // Note: merge reassigns orders sequentially, so actual orders are 1-5
      let evicted = manager.evict(4);

      assert.ok(evicted >= 2, `Expected at least 2 evicted, got ${evicted}`);

      let remaining = manager.toArray();
      for (let frame of remaining)
        assert.ok(frame.order >= 4, `Expected order >= 4, got ${frame.order}`);
    });

    it('returns 0 when nothing to evict', () => {
      let manager = new FrameManager({ history: false });

      manager.merge([
        { id: 'f1', type: 'message', content: {} },
      ], { events: false });

      let evicted = manager.evict(0);
      assert.equal(evicted, 0);
    });
  });

  describe('FrameManager getWindowBounds', () => {
    it('returns { from: 0, to: 0 } when empty', () => {
      let manager = new FrameManager({ history: false });
      let bounds  = manager.getWindowBounds();

      assert.deepStrictEqual(bounds, { from: 0, to: 0 });
    });

    it('returns min/max order of loaded frames', () => {
      let manager = new FrameManager({ history: false });

      manager.merge([
        { id: 'f1', type: 'message', content: {} },
        { id: 'f2', type: 'message', content: {} },
        { id: 'f3', type: 'message', content: {} },
      ], { events: false });

      let bounds = manager.getWindowBounds();
      assert.ok(bounds.from > 0);
      assert.ok(bounds.to >= bounds.from);
      assert.equal(bounds.to - bounds.from, 2); // 3 frames, sequential
    });

    it('updates after loadWindow', () => {
      let manager = new FrameManager({ history: false });

      manager.merge([
        { id: 'f3', type: 'message', content: {} },
      ], { events: false });

      let before = manager.getWindowBounds();

      manager.loadWindow([
        { id: 'f1', type: 'message', content: {} },
        { id: 'f2', type: 'message', content: {} },
      ]);

      let after = manager.getWindowBounds();
      assert.ok(after.from <= before.from);
      assert.equal(manager.toArray().length, 3);
    });
  });

  // ---------------------------------------------------------------------------
  // Simulated scroll-up pagination
  // ---------------------------------------------------------------------------

  describe('scroll-up pagination simulation', () => {
    it('simulates paginated loading with beforeOrder + limit', async () => {
      let session = await createTestSession('pagination');
      let seeded  = await seedFrames(session.id, 30);

      // Initial load: last 10 frames (DB orders 21-30)
      let manager = new FrameManager({ history: false });
      let initialRaw = await framePersistence.loadFramesInto(manager, session.id, {
        afterOrder: 20,
      });

      assert.equal(initialRaw.length, 10);

      // Track the smallest DB order from the seeded data that should be in this batch
      // (merge() mutates .order, so we use the known seeded order range)
      let dbMinOrder = 21; // We seeded 30 frames with orders 1-30, loaded afterOrder: 20

      // Scroll up: load 10 more before the oldest DB order
      let olderManager = new FrameManager({ history: false });
      let olderRaw = await framePersistence.loadFramesInto(olderManager, session.id, {
        beforeOrder: dbMinOrder,
        limit:       10,
      });

      assert.equal(olderRaw.length, 10);

      // Verify the older batch contains messages from the expected range
      let texts = olderRaw.map((f) => {
        let content = (typeof f.content === 'string') ? JSON.parse(f.content) : f.content;
        return content.text;
      });

      // Should contain messages 1-10 (first 10 of 20 frames with order < 21)
      for (let i = 1; i <= 10; i++)
        assert.ok(texts.includes(`Message ${i}`), `Expected Message ${i} in older batch`);

      // Merge older frames into the main manager
      manager.loadWindow(olderRaw.map((f) => ({
        id:      f.id,
        type:    f.type,
        content: f.content,
      })));

      assert.equal(manager.toArray().length, 20);
    });
  });
});
