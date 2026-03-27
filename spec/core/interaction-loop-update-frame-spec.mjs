'use strict';

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mock }  from 'node:test';

import XID                   from 'xid-js';
import { createKikxCore }   from '../../src/core/index.mjs';
import { InteractionLoop }  from '../../src/core/interaction/index.mjs';
import { SessionManager }   from '../../src/core/session/index.mjs';
import { FramePersistence }  from '../../src/core/frames/index.mjs';
import { ContentSanitizer }  from '../../src/core/lib/content-sanitizer.mjs';

// =============================================================================
// InteractionLoop.updateFrame() Tests
// =============================================================================
// Validates the single blessed path for modifying existing frames.
// All mutations go through FrameManager.merge() — no direct ORM saves.
// =============================================================================

describe('InteractionLoop.updateFrame()', () => {
  let core;
  let models;
  let context;
  let sessionManager;
  let framePersistence;
  let sanitizer;

  before(async () => {
    core    = createKikxCore();
    await core.start();
    models  = core.getModels();
    context = core.getContext();

    sessionManager   = new SessionManager(context);
    framePersistence  = new FramePersistence(context);
    sanitizer         = new ContentSanitizer();

    context.setProperty('sessionManager', sessionManager);
    context.setProperty('framePersistence', framePersistence);
    context.setProperty('contentSanitizer', sanitizer);
  });

  after(async () => {
    if (core && core.isStarted())
      await core.stop();
  });

  // Helpers
  async function createTestSession() {
    let org     = await models.Organization.create({ name: 'Test Org' });
    let session = await sessionManager.createSession(org.id, { name: 'Test Session' });
    return session;
  }

  function createLoop() {
    return new InteractionLoop(context);
  }

  function makeFrame(overrides = {}) {
    let id = `frm_${XID.next()}`;
    return {
      id,
      type:        'Message',
      content:     { text: 'Hello world' },
      hidden:      false,
      deleted:     false,
      processed:   false,
      processedAt: null,
      timestamp:   Date.now(),
      ...overrides,
    };
  }

  // ---------------------------------------------------------------------------
  // 1. updateFrame() merges into session's FrameManager
  // ---------------------------------------------------------------------------

  it('should merge an update into the session FrameManager', async () => {
    let session = await createTestSession();
    let loop    = createLoop();
    let fm      = sessionManager.getFrameManager(session.id);

    // Seed a frame
    let frame = makeFrame();
    fm.merge([frame]);

    // Update: hide the frame
    let results = await loop.updateFrame(session.id, { id: frame.id, hidden: true });

    assert.ok(results, 'updateFrame should return results');
    assert.equal(results.length, 1);

    // Verify in FrameManager
    let updated = fm.get(frame.id);
    assert.equal(updated.hidden, true, 'Frame should be hidden in FrameManager');
  });

  // ---------------------------------------------------------------------------
  // 2. updateFrame() hydrates partial updates (type required by merge)
  // ---------------------------------------------------------------------------

  it('should hydrate partial updates so merge does not skip them', async () => {
    let session = await createTestSession();
    let loop    = createLoop();
    let fm      = sessionManager.getFrameManager(session.id);

    // Seed a frame with a type
    let frame = makeFrame({ type: 'ToolCall' });
    fm.merge([frame]);

    // Update WITHOUT type — updateFrame should hydrate from existing
    let results = await loop.updateFrame(session.id, { id: frame.id, hidden: true });

    assert.ok(results, 'updateFrame should return results (not null)');
    assert.equal(results.length, 1);
    assert.equal(results[0].type, 'ToolCall', 'Hydrated result should retain original type');
    assert.equal(results[0].hidden, true, 'Updated field should be applied');
  });

  // ---------------------------------------------------------------------------
  // 3. updateFrame() emits commit event
  // ---------------------------------------------------------------------------

  it('should emit a commit event with sessionID and commit data', async () => {
    let session  = await createTestSession();
    let loop     = createLoop();
    let fm       = sessionManager.getFrameManager(session.id);

    let frame = makeFrame();
    fm.merge([frame]);

    let commitEvents = [];
    loop.on('commit', (data) => commitEvents.push(data));

    await loop.updateFrame(session.id, { id: frame.id, hidden: true });

    assert.ok(commitEvents.length >= 1, 'Should have emitted at least one commit event');

    let lastCommit = commitEvents[commitEvents.length - 1];
    assert.equal(lastCommit.sessionID, session.id, 'Commit event should have correct sessionID');
    assert.ok(lastCommit.commit, 'Commit event should have commit data');
    assert.ok(lastCommit.commit.frames, 'Commit should include frames array');
    assert.ok(lastCommit.commit.frames.length >= 1, 'Commit frames should not be empty');

    loop.removeAllListeners('commit');
  });

  // ---------------------------------------------------------------------------
  // 4. updateFrame() persists to DB via saveFrames
  // ---------------------------------------------------------------------------

  it('should persist full frame data to the database via saveFrames', async () => {
    let session = await createTestSession();
    let loop    = createLoop();
    let fm      = sessionManager.getFrameManager(session.id);

    let frame = makeFrame({ content: { text: 'persist-me' } });
    fm.merge([frame]);

    // Track saveFrames calls
    let saveCalls = [];
    let originalSave = framePersistence.saveFrames.bind(framePersistence);
    framePersistence.saveFrames = async function (sid, frames) {
      saveCalls.push({ sessionID: sid, frames });
      return originalSave(sid, frames);
    };

    await loop.updateFrame(session.id, { id: frame.id, hidden: true });

    // Restore
    framePersistence.saveFrames = originalSave;

    assert.ok(saveCalls.length >= 1, 'saveFrames should have been called');

    let lastCall = saveCalls[saveCalls.length - 1];
    assert.equal(lastCall.sessionID, session.id);
    assert.ok(lastCall.frames.length >= 1);

    // The saved frame should be the FULL frame (hydrated), not the partial
    let savedFrame = lastCall.frames[0];
    assert.equal(savedFrame.type, 'Message', 'Saved frame should have type (full data)');
    assert.equal(savedFrame.hidden, true, 'Saved frame should have updated hidden field');
  });

  // ---------------------------------------------------------------------------
  // 5. updateFrame() works for content updates
  // ---------------------------------------------------------------------------

  it('should update frame content in both FrameManager and persistence', async () => {
    let session = await createTestSession();
    let loop    = createLoop();
    let fm      = sessionManager.getFrameManager(session.id);

    let frame = makeFrame({ content: { text: 'original' } });
    fm.merge([frame]);

    let newContent = { text: 'updated content' };
    await loop.updateFrame(session.id, { id: frame.id, content: newContent });

    // Verify in FrameManager
    let updated = fm.get(frame.id);
    assert.deepEqual(updated.content, newContent, 'FrameManager should have new content');

    // Verify in DB
    let loadedFM = await framePersistence.loadFrames(session.id);
    let dbFrame  = loadedFM.get(frame.id);
    assert.ok(dbFrame, 'Frame should exist in DB');
    assert.deepEqual(dbFrame.content, newContent, 'DB should have new content');
  });

  // ---------------------------------------------------------------------------
  // 6. updateFrame() works for multiple frame updates
  // ---------------------------------------------------------------------------

  it('should update multiple frames at once', async () => {
    let session = await createTestSession();
    let loop    = createLoop();
    let fm      = sessionManager.getFrameManager(session.id);

    let frame1 = makeFrame({ content: { text: 'frame-1' } });
    let frame2 = makeFrame({ content: { text: 'frame-2' } });
    fm.merge([frame1, frame2]);

    let results = await loop.updateFrame(session.id, [
      { id: frame1.id, hidden: true },
      { id: frame2.id, content: { text: 'frame-2-updated' } },
    ]);

    assert.ok(results, 'Should return results');
    assert.equal(results.length, 2, 'Should have 2 updated frames');

    let updatedF1 = fm.get(frame1.id);
    let updatedF2 = fm.get(frame2.id);

    assert.equal(updatedF1.hidden, true, 'Frame 1 should be hidden');
    assert.deepEqual(updatedF2.content, { text: 'frame-2-updated' }, 'Frame 2 content should be updated');
  });

  // ---------------------------------------------------------------------------
  // 7. updateFrame() returns null when merge produces no results
  // ---------------------------------------------------------------------------

  it('should return null when merge produces no results', async () => {
    let session = await createTestSession();
    let loop    = createLoop();

    // FrameManager is empty, and the update has no type → merge skips it
    let result = await loop.updateFrame(session.id, { id: 'nonexistent_id' });

    assert.equal(result, null, 'Should return null when merge produces no results');
  });

  // ---------------------------------------------------------------------------
  // 8. updateFrame() loads frames if FrameManager is empty
  // ---------------------------------------------------------------------------

  it('should load frames into FrameManager if it is empty', async () => {
    let session = await createTestSession();
    let loop    = createLoop();

    // Persist a frame directly to DB (bypassing FrameManager)
    let frame = makeFrame({ type: 'Message', content: { text: 'from-db' }, order: 1 });
    await framePersistence.saveFrames(session.id, [frame]);

    // Get a FRESH FrameManager (destroy the cached one so it starts empty)
    sessionManager.destroyFrameManager(session.id);

    // Track loadFramesInto calls
    let loadCalls = [];
    let originalLoad = framePersistence.loadFramesInto.bind(framePersistence);
    framePersistence.loadFramesInto = async function (fm, sid, opts) {
      loadCalls.push({ sessionID: sid });
      return originalLoad(fm, sid, opts);
    };

    // Now update the frame — updateFrame should auto-load from DB
    let results = await loop.updateFrame(session.id, { id: frame.id, hidden: true });

    // Restore
    framePersistence.loadFramesInto = originalLoad;

    assert.ok(loadCalls.length >= 1, 'loadFramesInto should have been called');
    assert.equal(loadCalls[0].sessionID, session.id);

    assert.ok(results, 'Should return results after loading');
    assert.equal(results.length, 1);
    assert.equal(results[0].hidden, true);
  });

  // ---------------------------------------------------------------------------
  // 9. updateFrame() throws on missing sessionID
  // ---------------------------------------------------------------------------

  it('should throw when sessionID is missing', async () => {
    let loop = createLoop();

    await assert.rejects(
      () => loop.updateFrame(null, { id: 'x', hidden: true }),
      { message: /sessionID is required/ },
    );

    await assert.rejects(
      () => loop.updateFrame(undefined, { id: 'x', hidden: true }),
      { message: /sessionID is required/ },
    );
  });

  // ---------------------------------------------------------------------------
  // 10. updateFrame() throws on missing frameUpdates
  // ---------------------------------------------------------------------------

  it('should throw when frameUpdates is missing', async () => {
    let session = await createTestSession();
    let loop    = createLoop();

    await assert.rejects(
      () => loop.updateFrame(session.id, null),
      { message: /frameUpdates is required/ },
    );

    await assert.rejects(
      () => loop.updateFrame(session.id, undefined),
      { message: /frameUpdates is required/ },
    );
  });

  // ---------------------------------------------------------------------------
  // 11. updateFrame() handles new frame with type provided
  // ---------------------------------------------------------------------------

  it('should handle a new frame (not in FM) when caller provides type', async () => {
    let session = await createTestSession();
    let loop    = createLoop();
    let fm      = sessionManager.getFrameManager(session.id);

    // Insert a brand-new frame (not yet in FM) — caller provides full data including type
    let newFrame = makeFrame({ type: 'ToolResult', content: { output: 'done' } });

    let results = await loop.updateFrame(session.id, newFrame);

    assert.ok(results, 'Should return results for new frame');
    assert.equal(results.length, 1);
    assert.equal(results[0].type, 'ToolResult');

    // Verify it landed in the FrameManager
    let stored = fm.get(newFrame.id);
    assert.ok(stored, 'New frame should be in FrameManager');
    assert.deepEqual(stored.content, { output: 'done' });
  });

  // ---------------------------------------------------------------------------
  // 12. updateFrame() accepts a single update (not array)
  // ---------------------------------------------------------------------------

  it('should accept a single update object (not wrapped in array)', async () => {
    let session = await createTestSession();
    let loop    = createLoop();
    let fm      = sessionManager.getFrameManager(session.id);

    let frame = makeFrame();
    fm.merge([frame]);

    let results = await loop.updateFrame(session.id, { id: frame.id, deleted: true });

    assert.ok(results);
    assert.equal(results.length, 1);

    let updated = fm.get(frame.id);
    assert.equal(updated.deleted, true);
  });
});
