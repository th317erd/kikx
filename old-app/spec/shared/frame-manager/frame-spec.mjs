'use strict';

import { describe, it }   from 'node:test';
import assert              from 'node:assert/strict';
import { Frame }           from '../../../src/shared/frame-manager/frame.mjs';

describe('Frame', () => {
  it('should set parentID from data', () => {
    let frame = new Frame({ id: 'f1', type: 'UserMessage', parentID: 'f0' });
    assert.equal(frame.parentID, 'f0');
  });

  it('should default parentID to null when not provided', () => {
    let frame = new Frame({ id: 'f1', type: 'UserMessage' });
    assert.equal(frame.parentID, null);
  });

  it('should set groupID from data', () => {
    let frame = new Frame({ id: 'f1', type: 'Delta', groupID: 'g1' });
    assert.equal(frame.groupID, 'g1');
  });

  it('should default groupID to null when not provided', () => {
    let frame = new Frame({ id: 'f1', type: 'Delta' });
    assert.equal(frame.groupID, null);
  });

  it('should set all default values', () => {
    let frame = new Frame({ id: 'f1', type: 'UserMessage' });
    assert.deepEqual(frame.targets, []);
    assert.equal(frame.phantom, false);
    assert.deepEqual(frame.content, {});
    assert.equal(frame.groupType, null);
    assert.equal(frame.order, 0);
    assert.equal(frame.hidden, true);
    assert.equal(frame.deleted, false);
    assert.equal(frame.authorType, null);
    assert.equal(frame.authorID, null);
    assert.equal(frame.processed, null);
    assert.equal(frame.processedAt, null);
  });
});
