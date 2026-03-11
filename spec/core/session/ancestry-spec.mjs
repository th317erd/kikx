'use strict';

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createKikxCore } from '../../../src/core/index.mjs';
import { SessionManager } from '../../../src/core/session/index.mjs';

// =============================================================================
// Session Ancestry Chain
// =============================================================================
// Tests for SessionManager.getAncestryChain(sessionID) and
// SessionManager.clearAncestryCache(sessionID).
//
// getAncestryChain returns an array of session IDs ordered from self to root:
//   [sessionID, parentID, grandparentID, ...]
//
// Results are cached (ancestry is immutable once a session is created).
// =============================================================================

describe('SessionManager.getAncestryChain', () => {
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
    org     = await models.Organization.create({ name: 'Ancestry Test Org' });
  });

  // ===========================================================================
  // Happy Paths
  // ===========================================================================

  it('root session (no parent) returns [self]', async () => {
    let root  = await manager.createSession(org.id);
    let chain = await manager.getAncestryChain(root.id);

    assert.deepEqual(chain, [root.id]);
  });

  it('child session returns [self, parent]', async () => {
    let parent = await manager.createSession(org.id, { name: 'Parent' });
    let child  = await manager.createSession(org.id, {
      name:            'Child',
      parentSessionID: parent.id,
    });

    let chain = await manager.getAncestryChain(child.id);
    assert.deepEqual(chain, [child.id, parent.id]);
  });

  it('grandchild returns [self, parent, grandparent]', async () => {
    let grandparent = await manager.createSession(org.id, { name: 'Grandparent' });
    let parent      = await manager.createSession(org.id, {
      name:            'Parent',
      parentSessionID: grandparent.id,
    });
    let grandchild  = await manager.createSession(org.id, {
      name:            'Grandchild',
      parentSessionID: parent.id,
    });

    let chain = await manager.getAncestryChain(grandchild.id);
    assert.deepEqual(chain, [grandchild.id, parent.id, grandparent.id]);
  });

  it('deep chain (5 levels) returns correct order', async () => {
    let sessions = [];
    let previous = null;

    for (let index = 0; index < 5; index++) {
      let options = { name: `Level ${index}` };

      if (previous)
        options.parentSessionID = previous.id;

      let session = await manager.createSession(org.id, options);
      sessions.push(session);
      previous = session;
    }

    // sessions[4] is the deepest; sessions[0] is root
    let chain = await manager.getAncestryChain(sessions[4].id);

    let expected = [
      sessions[4].id,
      sessions[3].id,
      sessions[2].id,
      sessions[1].id,
      sessions[0].id,
    ];

    assert.deepEqual(chain, expected);
  });

  it('session with null parentSessionID returns [self]', async () => {
    let session = await manager.createSession(org.id, { name: 'Null Parent' });

    // Verify parentSessionID is null
    let fetched = await manager.getSession(session.id);
    assert.equal(fetched.parentSessionID, null);

    let chain = await manager.getAncestryChain(session.id);
    assert.deepEqual(chain, [session.id]);
  });

  // ===========================================================================
  // Caching
  // ===========================================================================

  it('cache returns same result on second call', async () => {
    let parent = await manager.createSession(org.id, { name: 'Parent' });
    let child  = await manager.createSession(org.id, {
      name:            'Child',
      parentSessionID: parent.id,
    });

    let chain1 = await manager.getAncestryChain(child.id);
    let chain2 = await manager.getAncestryChain(child.id);

    assert.deepEqual(chain1, chain2);
    // Same array reference (served from cache)
    assert.strictEqual(chain1, chain2);
  });

  it('clearAncestryCache removes cached entry', async () => {
    let parent = await manager.createSession(org.id, { name: 'Parent' });
    let child  = await manager.createSession(org.id, {
      name:            'Child',
      parentSessionID: parent.id,
    });

    let chain1 = await manager.getAncestryChain(child.id);
    manager.clearAncestryCache(child.id);
    let chain2 = await manager.getAncestryChain(child.id);

    // Same values but different array reference (rebuilt from DB)
    assert.deepEqual(chain1, chain2);
    assert.notStrictEqual(chain1, chain2);
  });

  it('clearAncestryCache also clears entries that contain the given sessionID', async () => {
    let grandparent = await manager.createSession(org.id, { name: 'Grandparent' });
    let parent      = await manager.createSession(org.id, {
      name:            'Parent',
      parentSessionID: grandparent.id,
    });
    let child       = await manager.createSession(org.id, {
      name:            'Child',
      parentSessionID: parent.id,
    });

    // Populate caches for both child and parent
    let childChain1  = await manager.getAncestryChain(child.id);
    let parentChain1 = await manager.getAncestryChain(parent.id);

    // Clear grandparent — should invalidate child and parent caches since both include it
    manager.clearAncestryCache(grandparent.id);

    let childChain2  = await manager.getAncestryChain(child.id);
    let parentChain2 = await manager.getAncestryChain(parent.id);

    // Values are the same but references differ (cache was rebuilt)
    assert.deepEqual(childChain1, childChain2);
    assert.notStrictEqual(childChain1, childChain2);
    assert.deepEqual(parentChain1, parentChain2);
    assert.notStrictEqual(parentChain1, parentChain2);
  });

  // ===========================================================================
  // Failure Paths
  // ===========================================================================

  it('non-existent session returns empty array', async () => {
    let chain = await manager.getAncestryChain('ses_does_not_exist');
    assert.deepEqual(chain, []);
  });

  it('null sessionID returns empty array', async () => {
    let chain = await manager.getAncestryChain(null);
    assert.deepEqual(chain, []);
  });

  it('undefined sessionID returns empty array', async () => {
    let chain = await manager.getAncestryChain(undefined);
    assert.deepEqual(chain, []);
  });

  // ===========================================================================
  // Edge Cases
  // ===========================================================================

  it('ancestry chain for parent does not include child', async () => {
    let parent = await manager.createSession(org.id, { name: 'Parent' });
    let child  = await manager.createSession(org.id, {
      name:            'Child',
      parentSessionID: parent.id,
    });

    let chain = await manager.getAncestryChain(parent.id);
    assert.deepEqual(chain, [parent.id]);
    assert.ok(!chain.includes(child.id));
  });

  it('sibling sessions have different chains sharing the parent', async () => {
    let parent   = await manager.createSession(org.id, { name: 'Parent' });
    let siblingA = await manager.createSession(org.id, {
      name:            'Sibling A',
      parentSessionID: parent.id,
    });
    let siblingB = await manager.createSession(org.id, {
      name:            'Sibling B',
      parentSessionID: parent.id,
    });

    let chainA = await manager.getAncestryChain(siblingA.id);
    let chainB = await manager.getAncestryChain(siblingB.id);

    assert.deepEqual(chainA, [siblingA.id, parent.id]);
    assert.deepEqual(chainB, [siblingB.id, parent.id]);
  });

  it('protects against infinite loops with a maximum depth guard', async () => {
    // This test verifies the implementation won't infinite-loop if data is corrupt.
    // We can't easily create a circular reference with FK constraints, but we
    // can verify the chain terminates for valid deep trees.
    let sessions = [];
    let previous = null;

    for (let index = 0; index < 10; index++) {
      let options = { name: `Deep ${index}` };

      if (previous)
        options.parentSessionID = previous.id;

      let session = await manager.createSession(org.id, options);
      sessions.push(session);
      previous = session;
    }

    let chain = await manager.getAncestryChain(sessions[9].id);
    assert.equal(chain.length, 10);
    assert.equal(chain[0], sessions[9].id);
    assert.equal(chain[9], sessions[0].id);
  });
});
