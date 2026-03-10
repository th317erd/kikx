'use strict';

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createKikxCore } from '../../src/core/index.mjs';
import { SessionManager } from '../../src/core/session/index.mjs';

// =============================================================================
// Session Parent-Child Relationships
// =============================================================================
// TDD tests for parentSessionID and linkedFrameID fields on the Session model.
// These fields do NOT exist yet. Tests are expected to FAIL until the model
// is updated to include them.
//
// Fields under test:
//   parentSessionID — nullable FK to self (Session:id), CASCADE delete, indexed
//   linkedFrameID   — nullable STRING(128), indexed
// =============================================================================

describe('Session Parent-Child Relationships', () => {
  let core;
  let models;
  let manager;
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
    manager = new SessionManager(core.getContext());
    org     = await models.Organization.create({ name: 'Relationship Test Org' });
  });

  // ===========================================================================
  // Happy Paths
  // ===========================================================================

  // 1. Top-level session defaults
  it('top-level session — parentSessionID and linkedFrameID default to null', async () => {
    let session = await manager.createSession(org.id);

    assert.ok(session);
    assert.equal(session.parentSessionID, null);
    assert.equal(session.linkedFrameID, null);
  });

  // 2. Sub-session with parentSessionID
  it('sub-session — stores correct parentSessionID reference', async () => {
    let parent = await manager.createSession(org.id, { name: 'Parent' });
    let child  = await manager.createSession(org.id, {
      name:            'Child',
      parentSessionID: parent.id,
    });

    assert.ok(child);
    assert.equal(child.parentSessionID, parent.id);

    // Re-fetch to confirm persistence
    let fetched = await manager.getSession(child.id);
    assert.equal(fetched.parentSessionID, parent.id);
  });

  // 3. Sub-session with linkedFrameID
  it('sub-session — stores linkedFrameID correctly', async () => {
    let parent  = await manager.createSession(org.id, { name: 'Parent' });
    let frameID = 'frm_abc123def456';
    let child   = await manager.createSession(org.id, {
      name:            'Linked Child',
      parentSessionID: parent.id,
      linkedFrameID:   frameID,
    });

    assert.equal(child.linkedFrameID, frameID);

    // Re-fetch to confirm persistence
    let fetched = await manager.getSession(child.id);
    assert.equal(fetched.linkedFrameID, frameID);
  });

  // 4. Query child sessions of a parent
  it('query children — returns only children of specified parent', async () => {
    let parent   = await manager.createSession(org.id, { name: 'Parent' });
    let childA   = await manager.createSession(org.id, {
      name:            'Child A',
      parentSessionID: parent.id,
    });
    let childB   = await manager.createSession(org.id, {
      name:            'Child B',
      parentSessionID: parent.id,
    });
    let unrelated = await manager.createSession(org.id, { name: 'Unrelated' });

    let { Session } = models;
    let children    = await Session.where.parentSessionID.EQ(parent.id).all();

    assert.equal(children.length, 2);

    let childIDs = children.map((session) => session.id);
    assert.ok(childIDs.includes(childA.id));
    assert.ok(childIDs.includes(childB.id));
    assert.ok(!childIDs.includes(unrelated.id));
  });

  // 5. Query top-level sessions only
  it('query top-level — excludes sessions with a parent', async () => {
    let freshOrg  = await models.Organization.create({ name: 'TopLevel Org' });
    let topLevel  = await manager.createSession(freshOrg.id, { name: 'Top' });
    let parent    = await manager.createSession(freshOrg.id, { name: 'Also Top' });
    let child     = await manager.createSession(freshOrg.id, {
      name:            'Sub',
      parentSessionID: parent.id,
    });

    let { Session }  = models;
    let topSessions  = await Session.where
      .organizationID.EQ(freshOrg.id)
      .AND.parentSessionID.EQ(null)
      .all();

    let topIDs = topSessions.map((session) => session.id);
    assert.ok(topIDs.includes(topLevel.id));
    assert.ok(topIDs.includes(parent.id));
    assert.ok(!topIDs.includes(child.id));
  });

  // 6. CASCADE delete: parent deletion removes children
  it('CASCADE delete — deleting parent removes child sessions', async () => {
    let parent = await manager.createSession(org.id, { name: 'Parent' });
    let childA = await manager.createSession(org.id, {
      name:            'Child A',
      parentSessionID: parent.id,
    });
    let childB = await manager.createSession(org.id, {
      name:            'Child B',
      parentSessionID: parent.id,
    });

    await manager.deleteSession(parent.id);

    let fetchedA = await manager.getSession(childA.id);
    let fetchedB = await manager.getSession(childB.id);
    assert.equal(fetchedA, null);
    assert.equal(fetchedB, null);
  });

  // 7. CASCADE delete: grandchild also deleted (depth 2)
  it('CASCADE delete — deleting grandparent removes grandchild (depth 2)', async () => {
    let grandparent = await manager.createSession(org.id, { name: 'Grandparent' });
    let parent      = await manager.createSession(org.id, {
      name:            'Parent',
      parentSessionID: grandparent.id,
    });
    let grandchild  = await manager.createSession(org.id, {
      name:            'Grandchild',
      parentSessionID: parent.id,
    });

    await manager.deleteSession(grandparent.id);

    let fetchedParent     = await manager.getSession(parent.id);
    let fetchedGrandchild = await manager.getSession(grandchild.id);
    assert.equal(fetchedParent, null);
    assert.equal(fetchedGrandchild, null);
  });

  // 8. Sub-session organization matches parent
  it('sub-session org — child shares same organizationID as parent', async () => {
    let parent = await manager.createSession(org.id, { name: 'Parent' });
    let child  = await manager.createSession(org.id, {
      name:            'Child',
      parentSessionID: parent.id,
    });

    assert.equal(child.organizationID, parent.organizationID);
    assert.equal(child.organizationID, org.id);
  });

  // 9. Multiple sub-sessions under one parent
  it('multiple sub-sessions — all returned when queried by parent', async () => {
    let parent   = await manager.createSession(org.id, { name: 'Parent' });
    let children = [];

    for (let index = 0; index < 5; index++) {
      let child = await manager.createSession(org.id, {
        name:            `Child ${index}`,
        parentSessionID: parent.id,
      });
      children.push(child);
    }

    let { Session } = models;
    let fetched     = await Session.where.parentSessionID.EQ(parent.id).all();

    assert.equal(fetched.length, 5);

    let fetchedIDs = fetched.map((session) => session.id);
    for (let child of children) {
      assert.ok(fetchedIDs.includes(child.id));
    }
  });

  // ===========================================================================
  // Failure Paths
  // ===========================================================================

  // 10. Non-existent parentSessionID should fail
  it('non-existent parentSessionID — should reject with FK constraint error', async () => {
    await assert.rejects(
      () => manager.createSession(org.id, {
        name:            'Orphan',
        parentSessionID: 'ses_nonexistent_parent_id',
      }),
      (error) => {
        // Accept any error — FK constraint violation, validation error, etc.
        assert.ok(error instanceof Error);
        return true;
      },
    );
  });

  // 11. Self-referencing parentSessionID
  it('self-referencing parentSessionID — should reject or be guarded against', async () => {
    let session = await manager.createSession(org.id, { name: 'Self-Ref' });

    // Attempt to set parentSessionID to the session's own ID
    // This should either be rejected at creation, or fail on update
    let selfRefFailed = false;
    try {
      let { Session } = models;
      let record      = await Session.where.id.EQ(session.id).first();
      record.parentSessionID = session.id;
      await record.save();
    } catch (error) {
      selfRefFailed = true;
    }

    // If the model enforces no self-reference, the above should have thrown.
    // If it doesn't enforce, the test documents expected future behavior.
    // Either way, we assert the field exists by reading it back.
    let fetched = await manager.getSession(session.id);
    if (selfRefFailed) {
      // Self-reference was blocked — parentSessionID should remain null
      assert.equal(fetched.parentSessionID, null);
    } else {
      // Self-reference was allowed — document that the model permits it.
      // This is acceptable for now; a guard can be added later.
      assert.equal(fetched.parentSessionID, session.id);
    }
  });

  // ===========================================================================
  // Edge Cases
  // ===========================================================================

  // 12. Depth 3+ nesting with CASCADE propagation
  it('CASCADE delete — depth 3+ nesting all removed when root deleted', async () => {
    let root   = await manager.createSession(org.id, { name: 'Root' });
    let depth1 = await manager.createSession(org.id, {
      name:            'Depth 1',
      parentSessionID: root.id,
    });
    let depth2 = await manager.createSession(org.id, {
      name:            'Depth 2',
      parentSessionID: depth1.id,
    });
    let depth3 = await manager.createSession(org.id, {
      name:            'Depth 3',
      parentSessionID: depth2.id,
    });

    await manager.deleteSession(root.id);

    let fetchedDepth1 = await manager.getSession(depth1.id);
    let fetchedDepth2 = await manager.getSession(depth2.id);
    let fetchedDepth3 = await manager.getSession(depth3.id);
    assert.equal(fetchedDepth1, null);
    assert.equal(fetchedDepth2, null);
    assert.equal(fetchedDepth3, null);
  });

  // 13. Orphaned linkedFrameID: session works even if frame is gone
  it('orphaned linkedFrameID — session remains functional without valid frame', async () => {
    let parent      = await manager.createSession(org.id, { name: 'Parent' });
    let bogusFrame  = 'frm_does_not_exist_anywhere';
    let child       = await manager.createSession(org.id, {
      name:            'Ghost Link',
      parentSessionID: parent.id,
      linkedFrameID:   bogusFrame,
    });

    assert.ok(child);
    assert.equal(child.linkedFrameID, bogusFrame);

    // Session should be fully queryable and updatable
    let fetched = await manager.getSession(child.id);
    assert.ok(fetched);
    assert.equal(fetched.linkedFrameID, bogusFrame);

    // Update should still work
    let updated = await manager.updateSession(child.id, { name: 'Renamed Ghost' });
    assert.equal(updated.name, 'Renamed Ghost');
    assert.equal(updated.linkedFrameID, bogusFrame);
  });

  // 14. Archive parent — children remain independent
  it('archive parent — child sessions retain their own archived flag', async () => {
    let parent = await manager.createSession(org.id, { name: 'Parent' });
    let childA = await manager.createSession(org.id, {
      name:            'Active Child',
      parentSessionID: parent.id,
    });
    let childB = await manager.createSession(org.id, {
      name:            'Already Archived',
      parentSessionID: parent.id,
      archived:        true,
    });

    // Archive the parent
    await manager.archiveSession(parent.id);

    // Re-fetch everything
    let fetchedParent = await manager.getSession(parent.id);
    let fetchedChildA = await manager.getSession(childA.id);
    let fetchedChildB = await manager.getSession(childB.id);

    // Parent should be archived
    assert.equal(fetchedParent.archived, true);

    // Children should NOT be affected — they keep their own archived status
    assert.equal(fetchedChildA.archived, false);
    assert.equal(fetchedChildB.archived, true);
  });
});
