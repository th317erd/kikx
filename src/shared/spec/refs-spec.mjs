'use strict';

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { FrameManager } from '../frame-manager/index.mjs';

// =============================================================================
// Refs Tests — Phase A Step 3
// =============================================================================
// Named pointers to commit orders. Analogous to git refs (branches, tags).
// 'heads/main' auto-advances on every commit.
// =============================================================================

describe('Refs', () => {
  let manager;

  beforeEach(() => {
    manager = new FrameManager();
  });

  // ---------------------------------------------------------------------------
  // heads/main auto-advancing
  // ---------------------------------------------------------------------------

  it('should auto-create heads/main on first commit', () => {
    manager.merge([{ id: 'f1', type: 'message' }]);

    let mainRef = manager.getRef('heads/main');
    assert.ok(mainRef !== undefined, 'heads/main should exist');
    assert.equal(mainRef, manager.getLatestCommit().order);
  });

  it('should auto-advance heads/main on each commit', () => {
    manager.merge([{ id: 'f1', type: 'message' }]);
    let firstOrder = manager.getRef('heads/main');

    manager.merge([{ id: 'f2', type: 'message' }]);
    let secondOrder = manager.getRef('heads/main');

    assert.ok(secondOrder > firstOrder);
    assert.equal(secondOrder, manager.getLatestCommit().order);
  });

  // ---------------------------------------------------------------------------
  // CRUD operations
  // ---------------------------------------------------------------------------

  it('createRef() should create a named ref', () => {
    manager.merge([{ id: 'f1', type: 'message' }]);
    let commitOrder = manager.getLatestCommit().order;

    manager.createRef('processed/agent-1', commitOrder);

    assert.equal(manager.getRef('processed/agent-1'), commitOrder);
  });

  it('createRef() should throw for non-existent commit order', () => {
    assert.throws(
      () => manager.createRef('bad-ref', 999),
      /commit order 999 does not exist/i,
    );
  });

  it('getRef() should return undefined for non-existent ref', () => {
    assert.equal(manager.getRef('nonexistent'), undefined);
  });

  it('updateRef() should move a ref to a new commit order', () => {
    manager.merge([{ id: 'f1', type: 'message' }]);
    let order1 = manager.getLatestCommit().order;

    manager.merge([{ id: 'f2', type: 'message' }]);
    let order2 = manager.getLatestCommit().order;

    manager.createRef('processed/agent-1', order1);
    manager.updateRef('processed/agent-1', order2);

    assert.equal(manager.getRef('processed/agent-1'), order2);
  });

  it('updateRef() should throw for non-existent ref', () => {
    manager.merge([{ id: 'f1', type: 'message' }]);

    assert.throws(
      () => manager.updateRef('nonexistent', 1),
      /ref "nonexistent" does not exist/i,
    );
  });

  it('deleteRef() should remove a ref', () => {
    manager.merge([{ id: 'f1', type: 'message' }]);
    let commitOrder = manager.getLatestCommit().order;

    manager.createRef('temp-ref', commitOrder);
    assert.ok(manager.getRef('temp-ref') !== undefined);

    manager.deleteRef('temp-ref');
    assert.equal(manager.getRef('temp-ref'), undefined);
  });

  it('listRefs() should return all refs', () => {
    manager.merge([{ id: 'f1', type: 'message' }]);
    let commitOrder = manager.getLatestCommit().order;

    manager.createRef('processed/agent-1', commitOrder);
    manager.createRef('processed/agent-2', commitOrder);

    let allRefs = manager.listRefs();
    assert.ok(allRefs instanceof Map);
    assert.ok(allRefs.has('heads/main'));
    assert.ok(allRefs.has('processed/agent-1'));
    assert.ok(allRefs.has('processed/agent-2'));
    assert.equal(allRefs.size, 3);
  });

  it('listRefs() with prefix should filter refs', () => {
    manager.merge([{ id: 'f1', type: 'message' }]);
    let commitOrder = manager.getLatestCommit().order;

    manager.createRef('processed/agent-1', commitOrder);
    manager.createRef('processed/agent-2', commitOrder);
    manager.createRef('seen/client-1', commitOrder);

    let processedRefs = manager.listRefs('processed/');
    assert.equal(processedRefs.size, 2);
    assert.ok(processedRefs.has('processed/agent-1'));
    assert.ok(processedRefs.has('processed/agent-2'));
    assert.ok(!processedRefs.has('seen/client-1'));
  });

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------

  it('should emit ref:created when createRef() is called', () => {
    manager.merge([{ id: 'f1', type: 'message' }]);
    let commitOrder = manager.getLatestCommit().order;

    let emitted = null;
    manager.on('ref:created', (data) => { emitted = data; });

    manager.createRef('processed/agent-1', commitOrder);

    assert.ok(emitted);
    assert.equal(emitted.name, 'processed/agent-1');
    assert.equal(emitted.commitOrder, commitOrder);
  });

  it('should emit ref:updated when updateRef() is called', () => {
    manager.merge([{ id: 'f1', type: 'message' }]);
    let order1 = manager.getLatestCommit().order;
    manager.merge([{ id: 'f2', type: 'message' }]);
    let order2 = manager.getLatestCommit().order;

    manager.createRef('processed/agent-1', order1);

    let emitted = null;
    manager.on('ref:updated', (data) => { emitted = data; });

    manager.updateRef('processed/agent-1', order2);

    assert.ok(emitted);
    assert.equal(emitted.name, 'processed/agent-1');
    assert.equal(emitted.previousOrder, order1);
    assert.equal(emitted.newOrder, order2);
  });

  it('should emit ref:updated when heads/main auto-advances', () => {
    manager.merge([{ id: 'f1', type: 'message' }]);
    let order1 = manager.getRef('heads/main');

    let emitted = null;
    manager.on('ref:updated', (data) => {
      if (data.name === 'heads/main')
        emitted = data;
    });

    manager.merge([{ id: 'f2', type: 'message' }]);

    assert.ok(emitted);
    assert.equal(emitted.previousOrder, order1);
    assert.equal(emitted.newOrder, manager.getRef('heads/main'));
  });

  it('should emit ref:deleted when deleteRef() is called', () => {
    manager.merge([{ id: 'f1', type: 'message' }]);
    let commitOrder = manager.getLatestCommit().order;

    manager.createRef('temp-ref', commitOrder);

    let emitted = null;
    manager.on('ref:deleted', (data) => { emitted = data; });

    manager.deleteRef('temp-ref');

    assert.ok(emitted);
    assert.equal(emitted.name, 'temp-ref');
  });
});
