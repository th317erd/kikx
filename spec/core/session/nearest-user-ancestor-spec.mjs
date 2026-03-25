'use strict';

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import XID from 'xid-js';

import { createKikxCore }   from '../../../src/core/index.mjs';
import { SessionManager }   from '../../../src/core/session/index.mjs';
import { FramePersistence } from '../../../src/core/frames/index.mjs';

// =============================================================================
// SessionManager.getNearestUserAncestor
// =============================================================================
// Tests for getNearestUserAncestor(sessionID) which returns the session ID of
// the closest ancestor (including self) that has at least one frame with
// authorType === 'user'. Returns null if no user found in the entire chain.
//
// User presence is determined by querying persisted Frame records for
// authorType === 'user' in each session.
// =============================================================================

// Helper: create a user-message frame in a session via FramePersistence
async function createUserFrame(framePersistence, sessionID) {
  await framePersistence.saveFrames(sessionID, [{
    id:         `frm_${XID.next()}`,
    type:       'UserMessage',
    content:    { text: 'Hello from a user' },
    authorType: 'user',
    authorID:   'usr_test_user',
    timestamp:  Date.now(),
    order:      1,
    hidden:     false,
    deleted:    false,
    processed:  false,
  }]);
}

// Helper: create an agent-message frame in a session via FramePersistence
async function createAgentFrame(framePersistence, sessionID) {
  await framePersistence.saveFrames(sessionID, [{
    id:         `frm_${XID.next()}`,
    type:       'Message',
    content:    { text: 'Hello from an agent' },
    authorType: 'agent',
    authorID:   'agt_test_agent',
    timestamp:  Date.now(),
    order:      1,
    hidden:     false,
    deleted:    false,
    processed:  false,
  }]);
}

describe('SessionManager.getNearestUserAncestor', () => {
  let core;
  let models;
  let manager;
  let framePersistence;
  let org;

  before(async () => {
    core = createKikxCore();
    await core.start();
    models = core.getModels();
  });

  after(async () => {
    if (core && core.isStarted())
      await core.stop();
  });

  beforeEach(async () => {
    manager          = new SessionManager(core.getContext());
    framePersistence = new FramePersistence(core.getContext());
    org              = await models.Organization.create({ name: 'UserAncestor Test Org' });
  });

  // ===========================================================================
  // Happy Paths
  // ===========================================================================

  it('session with user frame returns self', async () => {
    let session = await manager.createSession(org.id, { name: 'Has User' });
    await createUserFrame(framePersistence, session.id);

    let result = await manager.getNearestUserAncestor(session.id);
    assert.equal(result, session.id);
  });

  it('child session with no user returns parent (which has user)', async () => {
    let parent = await manager.createSession(org.id, { name: 'Parent With User' });
    await createUserFrame(framePersistence, parent.id);

    let child = await manager.createSession(org.id, {
      name:            'Child No User',
      parentSessionID: parent.id,
    });
    await createAgentFrame(framePersistence, child.id);

    let result = await manager.getNearestUserAncestor(child.id);
    assert.equal(result, parent.id);
  });

  it('deep chain finds user 3 levels up', async () => {
    let root = await manager.createSession(org.id, { name: 'Root With User' });
    await createUserFrame(framePersistence, root.id);

    let level1 = await manager.createSession(org.id, {
      name:            'Level 1',
      parentSessionID: root.id,
    });
    await createAgentFrame(framePersistence, level1.id);

    let level2 = await manager.createSession(org.id, {
      name:            'Level 2',
      parentSessionID: level1.id,
    });
    await createAgentFrame(framePersistence, level2.id);

    let level3 = await manager.createSession(org.id, {
      name:            'Level 3',
      parentSessionID: level2.id,
    });
    await createAgentFrame(framePersistence, level3.id);

    let result = await manager.getNearestUserAncestor(level3.id);
    assert.equal(result, root.id);
  });

  it('no user in entire chain returns null', async () => {
    let root = await manager.createSession(org.id, { name: 'Root No User' });
    await createAgentFrame(framePersistence, root.id);

    let child = await manager.createSession(org.id, {
      name:            'Child No User',
      parentSessionID: root.id,
    });
    await createAgentFrame(framePersistence, child.id);

    let result = await manager.getNearestUserAncestor(child.id);
    assert.equal(result, null);
  });

  it('multiple users in chain returns nearest ancestor', async () => {
    let grandparent = await manager.createSession(org.id, { name: 'Grandparent With User' });
    await createUserFrame(framePersistence, grandparent.id);

    let parent = await manager.createSession(org.id, {
      name:            'Parent With User',
      parentSessionID: grandparent.id,
    });
    await createUserFrame(framePersistence, parent.id);

    let child = await manager.createSession(org.id, {
      name:            'Child No User',
      parentSessionID: parent.id,
    });
    await createAgentFrame(framePersistence, child.id);

    let result = await manager.getNearestUserAncestor(child.id);
    // Should return parent (nearest), not grandparent
    assert.equal(result, parent.id);
  });

  it('self has user frame — returns self even when ancestors also have users', async () => {
    let parent = await manager.createSession(org.id, { name: 'Parent With User' });
    await createUserFrame(framePersistence, parent.id);

    let child = await manager.createSession(org.id, {
      name:            'Child With User',
      parentSessionID: parent.id,
    });
    await createUserFrame(framePersistence, child.id);

    let result = await manager.getNearestUserAncestor(child.id);
    assert.equal(result, child.id);
  });

  // ===========================================================================
  // Failure Paths
  // ===========================================================================

  it('non-existent session returns null', async () => {
    let result = await manager.getNearestUserAncestor('ses_does_not_exist');
    assert.equal(result, null);
  });

  it('null sessionID returns null', async () => {
    let result = await manager.getNearestUserAncestor(null);
    assert.equal(result, null);
  });

  it('undefined sessionID returns null', async () => {
    let result = await manager.getNearestUserAncestor(undefined);
    assert.equal(result, null);
  });

  // ===========================================================================
  // Edge Cases
  // ===========================================================================

  it('session with only system frames returns null (no user)', async () => {
    let session = await manager.createSession(org.id, { name: 'System Only' });

    // Create a system-authored frame
    await framePersistence.saveFrames(session.id, [{
      id:         `frm_${XID.next()}`,
      type:       'ParticipantJoined',
      content:    { agentID: 'agt_test', agentName: 'Test Agent' },
      authorType: 'system',
      authorID:   null,
      timestamp:  Date.now(),
      order:      1,
      hidden:     false,
      deleted:    false,
      processed:  false,
    }]);

    let result = await manager.getNearestUserAncestor(session.id);
    assert.equal(result, null);
  });

  it('session with no frames at all returns null (no user)', async () => {
    let session = await manager.createSession(org.id, { name: 'Empty Session' });

    let result = await manager.getNearestUserAncestor(session.id);
    assert.equal(result, null);
  });

  it('root session with user frame and no ancestors returns self', async () => {
    let root = await manager.createSession(org.id, { name: 'Lonely Root' });
    await createUserFrame(framePersistence, root.id);

    let result = await manager.getNearestUserAncestor(root.id);
    assert.equal(result, root.id);
  });

  it('chain where only middle session has user', async () => {
    let root = await manager.createSession(org.id, { name: 'Root No User' });
    await createAgentFrame(framePersistence, root.id);

    let middle = await manager.createSession(org.id, {
      name:            'Middle With User',
      parentSessionID: root.id,
    });
    await createUserFrame(framePersistence, middle.id);

    let leaf = await manager.createSession(org.id, {
      name:            'Leaf No User',
      parentSessionID: middle.id,
    });
    await createAgentFrame(framePersistence, leaf.id);

    let result = await manager.getNearestUserAncestor(leaf.id);
    // Middle is nearer than root, and middle has the user
    assert.equal(result, middle.id);
  });

  // ===========================================================================
  // Caching
  // ===========================================================================

  it('second call uses cached ancestry (does not re-query chain)', async () => {
    let parent = await manager.createSession(org.id, { name: 'Parent With User' });
    await createUserFrame(framePersistence, parent.id);

    let child = await manager.createSession(org.id, {
      name:            'Child',
      parentSessionID: parent.id,
    });

    let result1 = await manager.getNearestUserAncestor(child.id);
    let result2 = await manager.getNearestUserAncestor(child.id);

    assert.equal(result1, parent.id);
    assert.equal(result2, parent.id);
  });
});
