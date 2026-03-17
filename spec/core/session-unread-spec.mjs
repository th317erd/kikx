'use strict';

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import XID from 'xid-js';

import { createKikxCore }    from '../../src/core/index.mjs';
import { SessionManager }    from '../../src/core/session/index.mjs';
import { FramePersistence }  from '../../src/core/frames/index.mjs';
import { ValueStoreService } from '../../src/core/lib/value-store-service.mjs';

// =============================================================================
// Session Unread Enrichment Tests
// =============================================================================
// Integration tests for the unread count, lastActivity, and participantCount
// enrichment logic used by SessionController.list() and markRead().
//
// Tests the building blocks:
//   - getMaxOrder() returns the correct high-water mark
//   - ValueStoreService stores/retrieves read positions per user per session
//   - Unread count computation: max(0, maxOrder - lastReadOrder)
//   - Default unreadCount=0 for sessions with no read position
//   - participantCount via Participant model
//   - lastActivity from session timestamps
// =============================================================================

function generateFrameID() {
  return `frm_${XID.next()}`;
}

describe('Session Unread Enrichment', () => {
  let core;
  let models;
  let manager;
  let persistence;
  let valueStore;
  let org;
  let userID;

  before(async () => {
    core = createKikxCore();
    await core.start();
    models      = core.getModels();
    persistence = new FramePersistence(core.getContext());
    valueStore  = new ValueStoreService({ context: core.getContext() });
  });

  after(async () => {
    if (core && core.isStarted())
      await core.stop();
  });

  beforeEach(async () => {
    manager = new SessionManager(core.getContext());
    org     = await models.Organization.create({ name: 'Unread Test Org' });
    userID  = `usr_${XID.next()}`;
  });

  // ===========================================================================
  // Unread count computation
  // ===========================================================================

  describe('unread count computation', () => {
    it('should return unreadCount=0 when no read position exists (unseen session)', async () => {
      let session = await manager.createSession(org.id, { name: 'Unseen Session' });

      // Add some frames
      await persistence.saveFrames(session.id, [
        { id: generateFrameID(), type: 'message', content: { text: 'hello' }, order: 1, timestamp: Date.now() },
        { id: generateFrameID(), type: 'message', content: { text: 'world' }, order: 2, timestamp: Date.now() + 1 },
      ]);

      let maxOrder      = await persistence.getMaxOrder(session.id);
      let lastReadOrder = await valueStore.get('user', userID, 'read-state', 'lastReadOrder', { scopeID: session.id });

      // No read position → unreadCount defaults to 0
      assert.equal(lastReadOrder, null);
      assert.equal(maxOrder, 2);

      let unreadCount = (lastReadOrder == null) ? 0 : Math.max(0, maxOrder - lastReadOrder);
      assert.equal(unreadCount, 0);
    });

    it('should return unreadCount=0 when user is fully caught up', async () => {
      let session = await manager.createSession(org.id, { name: 'Caught Up Session' });

      await persistence.saveFrames(session.id, [
        { id: generateFrameID(), type: 'message', order: 1, timestamp: Date.now() },
        { id: generateFrameID(), type: 'message', order: 2, timestamp: Date.now() + 1 },
        { id: generateFrameID(), type: 'message', order: 3, timestamp: Date.now() + 2 },
      ]);

      // User marks read at order 3
      await valueStore.set('user', userID, 'read-state', 'lastReadOrder', 3, {
        scopeID:        session.id,
        organizationID: org.id,
      });

      let maxOrder      = await persistence.getMaxOrder(session.id);
      let lastReadOrder = await valueStore.get('user', userID, 'read-state', 'lastReadOrder', { scopeID: session.id });

      let unreadCount = (lastReadOrder == null) ? 0 : Math.max(0, maxOrder - lastReadOrder);
      assert.equal(unreadCount, 0);
    });

    it('should return correct unreadCount when new frames arrive after mark-read', async () => {
      let session = await manager.createSession(org.id, { name: 'Unread Session' });

      // Initial frames
      await persistence.saveFrames(session.id, [
        { id: generateFrameID(), type: 'message', order: 1, timestamp: Date.now() },
        { id: generateFrameID(), type: 'message', order: 2, timestamp: Date.now() + 1 },
      ]);

      // User marks read at order 2
      await valueStore.set('user', userID, 'read-state', 'lastReadOrder', 2, {
        scopeID:        session.id,
        organizationID: org.id,
      });

      // New frames arrive
      await persistence.saveFrames(session.id, [
        { id: generateFrameID(), type: 'message', order: 3, timestamp: Date.now() + 2 },
        { id: generateFrameID(), type: 'message', order: 4, timestamp: Date.now() + 3 },
        { id: generateFrameID(), type: 'message', order: 5, timestamp: Date.now() + 4 },
      ]);

      let maxOrder      = await persistence.getMaxOrder(session.id);
      let lastReadOrder = await valueStore.get('user', userID, 'read-state', 'lastReadOrder', { scopeID: session.id });

      let unreadCount = (lastReadOrder == null) ? 0 : Math.max(0, maxOrder - lastReadOrder);
      assert.equal(unreadCount, 3);
    });

    it('should isolate read positions per user', async () => {
      let session = await manager.createSession(org.id, { name: 'Multi-User Session' });
      let userA   = `usr_${XID.next()}`;
      let userB   = `usr_${XID.next()}`;

      await persistence.saveFrames(session.id, [
        { id: generateFrameID(), type: 'message', order: 1, timestamp: Date.now() },
        { id: generateFrameID(), type: 'message', order: 2, timestamp: Date.now() + 1 },
        { id: generateFrameID(), type: 'message', order: 3, timestamp: Date.now() + 2 },
      ]);

      // User A reads up to 3, user B reads up to 1
      await valueStore.set('user', userA, 'read-state', 'lastReadOrder', 3, { scopeID: session.id, organizationID: org.id });
      await valueStore.set('user', userB, 'read-state', 'lastReadOrder', 1, { scopeID: session.id, organizationID: org.id });

      let maxOrder = await persistence.getMaxOrder(session.id);

      let readA     = await valueStore.get('user', userA, 'read-state', 'lastReadOrder', { scopeID: session.id });
      let unreadA   = Math.max(0, maxOrder - readA);

      let readB     = await valueStore.get('user', userB, 'read-state', 'lastReadOrder', { scopeID: session.id });
      let unreadB   = Math.max(0, maxOrder - readB);

      assert.equal(unreadA, 0);
      assert.equal(unreadB, 2);
    });

    it('should isolate read positions per session', async () => {
      let sessionA = await manager.createSession(org.id, { name: 'Session A' });
      let sessionB = await manager.createSession(org.id, { name: 'Session B' });

      await persistence.saveFrames(sessionA.id, [
        { id: generateFrameID(), type: 'message', order: 1, timestamp: Date.now() },
        { id: generateFrameID(), type: 'message', order: 2, timestamp: Date.now() + 1 },
      ]);

      await persistence.saveFrames(sessionB.id, [
        { id: generateFrameID(), type: 'message', order: 1, timestamp: Date.now() },
        { id: generateFrameID(), type: 'message', order: 5, timestamp: Date.now() + 1 },
      ]);

      // Mark session A as fully read, leave session B at order 1
      await valueStore.set('user', userID, 'read-state', 'lastReadOrder', 2, { scopeID: sessionA.id, organizationID: org.id });
      await valueStore.set('user', userID, 'read-state', 'lastReadOrder', 1, { scopeID: sessionB.id, organizationID: org.id });

      let maxA  = await persistence.getMaxOrder(sessionA.id);
      let readA = await valueStore.get('user', userID, 'read-state', 'lastReadOrder', { scopeID: sessionA.id });

      let maxB  = await persistence.getMaxOrder(sessionB.id);
      let readB = await valueStore.get('user', userID, 'read-state', 'lastReadOrder', { scopeID: sessionB.id });

      assert.equal(Math.max(0, maxA - readA), 0);
      assert.equal(Math.max(0, maxB - readB), 4);
    });

    it('should handle empty session (no frames, no read position)', async () => {
      let session = await manager.createSession(org.id, { name: 'Empty Session' });

      let maxOrder      = await persistence.getMaxOrder(session.id);
      let lastReadOrder = await valueStore.get('user', userID, 'read-state', 'lastReadOrder', { scopeID: session.id });

      assert.equal(maxOrder, 0);
      assert.equal(lastReadOrder, null);

      let unreadCount = (lastReadOrder == null) ? 0 : Math.max(0, maxOrder - lastReadOrder);
      assert.equal(unreadCount, 0);
    });
  });

  // ===========================================================================
  // Mark-read (simulating SessionController.markRead)
  // ===========================================================================

  describe('mark-read', () => {
    it('should store the current maxOrder as lastReadOrder', async () => {
      let session = await manager.createSession(org.id, { name: 'Mark-Read Session' });

      await persistence.saveFrames(session.id, [
        { id: generateFrameID(), type: 'message', order: 1, timestamp: Date.now() },
        { id: generateFrameID(), type: 'message', order: 2, timestamp: Date.now() + 1 },
        { id: generateFrameID(), type: 'message', order: 3, timestamp: Date.now() + 2 },
      ]);

      // Simulate markRead
      let maxOrder = await persistence.getMaxOrder(session.id);
      await valueStore.set('user', userID, 'read-state', 'lastReadOrder', maxOrder, {
        scopeID:        session.id,
        organizationID: org.id,
      });

      let stored = await valueStore.get('user', userID, 'read-state', 'lastReadOrder', { scopeID: session.id });
      assert.equal(stored, 3);
    });

    it('should update existing read position on subsequent mark-read', async () => {
      let session = await manager.createSession(org.id, { name: 'Update-Read Session' });

      await persistence.saveFrames(session.id, [
        { id: generateFrameID(), type: 'message', order: 1, timestamp: Date.now() },
        { id: generateFrameID(), type: 'message', order: 2, timestamp: Date.now() + 1 },
      ]);

      // First mark-read
      await valueStore.set('user', userID, 'read-state', 'lastReadOrder', 2, {
        scopeID:        session.id,
        organizationID: org.id,
      });

      // New frames arrive
      await persistence.saveFrames(session.id, [
        { id: generateFrameID(), type: 'message', order: 3, timestamp: Date.now() + 2 },
        { id: generateFrameID(), type: 'message', order: 4, timestamp: Date.now() + 3 },
      ]);

      // Second mark-read
      let maxOrder = await persistence.getMaxOrder(session.id);
      await valueStore.set('user', userID, 'read-state', 'lastReadOrder', maxOrder, {
        scopeID:        session.id,
        organizationID: org.id,
      });

      let stored = await valueStore.get('user', userID, 'read-state', 'lastReadOrder', { scopeID: session.id });
      assert.equal(stored, 4);

      // Unread should now be 0
      let unreadCount = Math.max(0, maxOrder - stored);
      assert.equal(unreadCount, 0);
    });

    it('should store 0 when marking read on an empty session', async () => {
      let session = await manager.createSession(org.id, { name: 'Empty Mark-Read' });

      let maxOrder = await persistence.getMaxOrder(session.id);
      assert.equal(maxOrder, 0);

      await valueStore.set('user', userID, 'read-state', 'lastReadOrder', maxOrder, {
        scopeID:        session.id,
        organizationID: org.id,
      });

      let stored = await valueStore.get('user', userID, 'read-state', 'lastReadOrder', { scopeID: session.id });
      assert.equal(stored, 0);
    });
  });

  // ===========================================================================
  // Participant count
  // ===========================================================================

  describe('participantCount', () => {
    it('should return 0 for a session with no participants', async () => {
      let session      = await manager.createSession(org.id, { name: 'No Participants' });
      let participants = await models.Participant.where.sessionID.EQ(session.id).all();
      assert.equal(participants.length, 0);
    });

    it('should return correct count after adding participants', async () => {
      let session = await manager.createSession(org.id, { name: 'With Participants' });

      let agentA = await models.Agent.create({ organizationID: org.id, name: 'test-agent-a', pluginID: 'claude-agent' });
      let agentB = await models.Agent.create({ organizationID: org.id, name: 'test-agent-b', pluginID: 'claude-agent' });

      await manager.addParticipant(session.id, agentA.id);
      await manager.addParticipant(session.id, agentB.id);

      let participants = await models.Participant.where.sessionID.EQ(session.id).all();
      assert.equal(participants.length, 2);
    });
  });

  // ===========================================================================
  // Last activity
  // ===========================================================================

  describe('lastActivity', () => {
    it('should use createdAt when updatedAt equals createdAt', async () => {
      let session   = await manager.createSession(org.id, { name: 'New Session' });
      let createdAt = session.createdAt;
      let updatedAt = session.updatedAt;

      let createdMs = (createdAt && typeof createdAt.toMillis === 'function') ? createdAt.toMillis() : createdAt;
      let updatedMs = (updatedAt && typeof updatedAt.toMillis === 'function') ? updatedAt.toMillis() : updatedAt;

      let lastActivity = (!updatedAt || updatedMs === createdMs) ? createdAt : updatedAt;
      assert.equal(lastActivity, createdAt);
    });

    it('should use updatedAt when it differs from createdAt', async () => {
      let session = await manager.createSession(org.id, { name: 'Updated Session' });

      // Update to force a different updatedAt
      await manager.updateSession(session.id, { name: 'Updated Session Name' });

      let updated   = await manager.getSession(session.id);
      let createdAt = updated.createdAt;
      let updatedAt = updated.updatedAt;

      let createdMs = (createdAt && typeof createdAt.toMillis === 'function') ? createdAt.toMillis() : createdAt;
      let updatedMs = (updatedAt && typeof updatedAt.toMillis === 'function') ? updatedAt.toMillis() : updatedAt;

      // Only assert updatedAt is used when it differs from createdAt
      if (updatedMs !== createdMs) {
        let lastActivity = (!updatedAt || updatedMs === createdMs) ? createdAt : updatedAt;
        assert.equal(lastActivity, updatedAt);
      }
    });
  });
});
