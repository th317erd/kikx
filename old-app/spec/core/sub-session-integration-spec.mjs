'use strict';

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import XID from 'xid-js';

import { createKikxCore }  from '../../src/core/index.mjs';
import { SessionManager }  from '../../src/core/session/index.mjs';
import { FrameManager }    from '../../src/shared/frame-manager/frame-manager.mjs';
import { FramePersistence } from '../../src/core/frames/index.mjs';

// =============================================================================
// Sub-Session Integration Tests
// =============================================================================
// TDD red-phase tests for the full flow of parent-child session relationships.
// These tests verify:
//   1. Creating a sub-session automatically produces a session-link frame
//   2. Pre-generated XIDs resolve the cyclic dependency (session needs frame,
//      frame needs session)
//   3. Deleting a parent cascades to sub-sessions
//   4. Multi-level hierarchy (parent -> child -> grandchild)
//
// All tests are expected to FAIL until the sub-session implementation lands.
// =============================================================================

describe('Sub-Session Integration', () => {
  let core;
  let models;
  let manager;
  let persistence;
  let org;

  before(async () => {
    core = createKikxCore();
    await core.start();
    models      = core.getModels();
    persistence = new FramePersistence(core.getContext());
  });

  after(async () => {
    if (core && core.isStarted())
      await core.stop();
  });

  beforeEach(async () => {
    manager = new SessionManager(core.getContext());
    org     = await models.Organization.create({ name: 'Sub-Session Integration Org' });
  });

  // ---- Test 1 ----
  // Create parent -> create sub-session -> create session-link frame -> verify
  it('creating a sub-session produces a session-link frame in the parent', async () => {
    // Create parent session
    let parent = await manager.createSession(org.id, { name: 'Parent Session' });
    assert.ok(parent);
    assert.ok(parent.id.startsWith('ses_'));

    // Pre-generate IDs to break the cyclic dependency
    let childSessionID = 'ses_' + XID.next();
    let linkFrameID    = 'frm_' + XID.next();

    // Create sub-session with parentSessionID and linkedFrameID
    let child = await manager.createSession(org.id, {
      id:              childSessionID,
      name:            'Child Session',
      parentSessionID: parent.id,
      linkedFrameID:   linkFrameID,
    });

    assert.ok(child);
    assert.equal(child.parentSessionID, parent.id);
    assert.equal(child.linkedFrameID, linkFrameID);

    // Create the session-link frame in the parent (caller's responsibility)
    await persistence.saveFrames(parent.id, [{
      id:         linkFrameID,
      type:       'SessionLink',
      content:    { targetSessionID: child.id, title: 'Child Session' },
      order:      1,
      timestamp:  Date.now(),
      authorType: 'system',
      authorID:   null,
      hidden:     false,
    }]);

    // Load frames from the parent session
    let parentFrameManager = await persistence.loadFrames(parent.id);
    let parentFrames       = parentFrameManager.toArray();

    // Verify a session-link frame exists
    let linkFrames = parentFrames.filter((frame) => frame.type === 'SessionLink');
    assert.ok(linkFrames.length >= 1, 'Expected at least one session-link frame in the parent session');

    // Verify the session-link frame references the child session
    let linkFrame = linkFrames.find((frame) => {
      let content = frame.content;
      return content && content.targetSessionID === child.id;
    });

    assert.ok(linkFrame, 'session-link frame should reference the child session ID');
  });

  // ---- Test 2 ----
  // Verify pre-generated XIDs resolve cyclic dependency
  it('pre-generated XIDs allow session and frame to cross-reference each other', async () => {
    // Create parent session
    let parent = await manager.createSession(org.id, { name: 'XID Parent' });

    // Pre-generate both IDs before creating either record
    let sessionID = 'ses_' + XID.next();
    let frameID   = 'frm_' + XID.next();

    // Create session record with pre-generated ID, parentSessionID, and linkedFrameID
    let child = await manager.createSession(org.id, {
      id:              sessionID,
      name:            'XID Child',
      parentSessionID: parent.id,
      linkedFrameID:   frameID,
    });

    assert.ok(child);
    assert.equal(child.id, sessionID);
    assert.equal(child.linkedFrameID, frameID);

    // Create the matching session-link frame in the parent session
    await persistence.saveFrames(parent.id, [
      {
        id:        frameID,
        type:      'SessionLink',
        content:   { targetSessionID: sessionID },
        order:     1,
        timestamp: Date.now(),
      },
    ]);

    // Verify both exist and cross-reference correctly
    let fetchedSession = await manager.getSession(sessionID);
    assert.ok(fetchedSession);
    assert.equal(fetchedSession.linkedFrameID, frameID);

    let parentFrameManager = await persistence.loadFrames(parent.id);
    let linkFrame          = parentFrameManager.get(frameID);
    assert.ok(linkFrame, 'session-link frame should exist in parent');
    assert.equal(linkFrame.type, 'SessionLink');
    assert.equal(linkFrame.content.targetSessionID, sessionID);

    // The cross-reference is complete: session -> frame via linkedFrameID,
    // frame -> session via content.targetSessionID
    assert.equal(fetchedSession.linkedFrameID, linkFrame.id);
    assert.equal(linkFrame.content.targetSessionID, fetchedSession.id);
  });

  // ---- Test 3 ----
  // Delete parent cascades to sub-session
  it('deleting parent session cascades to sub-session', async () => {
    let parent = await manager.createSession(org.id, { name: 'Cascade Parent' });
    let child  = await manager.createSession(org.id, {
      name:            'Cascade Child',
      parentSessionID: parent.id,
    });

    // Verify both exist
    assert.ok(await manager.getSession(parent.id));
    assert.ok(await manager.getSession(child.id));

    // Delete the parent
    await manager.deleteSession(parent.id);

    // Verify parent is gone
    let fetchedParent = await manager.getSession(parent.id);
    assert.equal(fetchedParent, null);

    // Verify child is also gone (CASCADE)
    let fetchedChild = await manager.getSession(child.id);
    assert.equal(fetchedChild, null);
  });

  // ---- Test 4 ----
  // Sub-session hierarchy: parent -> child -> grandchild works
  it('three-level hierarchy: parent -> child -> grandchild all cascade on root delete', async () => {
    let root = await manager.createSession(org.id, { name: 'Root' });
    let child = await manager.createSession(org.id, {
      name:            'Child',
      parentSessionID: root.id,
    });
    let grandchild = await manager.createSession(org.id, {
      name:            'Grandchild',
      parentSessionID: child.id,
    });

    // Verify all parentSessionID references are correct
    assert.equal(child.parentSessionID, root.id);
    assert.equal(grandchild.parentSessionID, child.id);

    // Verify hierarchy is traversable
    let fetchedChild = await manager.getSession(child.id);
    assert.equal(fetchedChild.parentSessionID, root.id);

    let fetchedGrandchild = await manager.getSession(grandchild.id);
    assert.equal(fetchedGrandchild.parentSessionID, child.id);

    // Delete root — all three levels should be gone
    await manager.deleteSession(root.id);

    let fetchedRoot       = await manager.getSession(root.id);
    let fetchedChildAfter = await manager.getSession(child.id);
    let fetchedGCAfter    = await manager.getSession(grandchild.id);

    assert.equal(fetchedRoot, null);
    assert.equal(fetchedChildAfter, null);
    assert.equal(fetchedGCAfter, null);
  });
});
