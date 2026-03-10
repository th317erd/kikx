'use strict';

import { describe, it }   from 'node:test';
import assert              from 'node:assert/strict';
import { Frame }           from '../../../src/shared/frame-manager/frame.mjs';

describe('Frame', () => {
  it('should accept parentId (camelCase)', () => {
    let frame = new Frame({ id: 'f1', type: 'user-message', parentId: 'f0' });
    assert.equal(frame.parentId, 'f0');
  });

  it('should accept parentID (uppercase D) and normalize to parentId', () => {
    let frame = new Frame({ id: 'f1', type: 'user-message', parentID: 'f0' });
    assert.equal(frame.parentId, 'f0');
  });

  it('should prefer parentId over parentID when both are present', () => {
    let frame = new Frame({ id: 'f1', type: 'user-message', parentId: 'from-camel', parentID: 'from-upper' });
    assert.equal(frame.parentId, 'from-camel');
  });

  it('should default parentId to null when neither casing is provided', () => {
    let frame = new Frame({ id: 'f1', type: 'user-message' });
    assert.equal(frame.parentId, null);
  });

  it('should accept groupId (camelCase)', () => {
    let frame = new Frame({ id: 'f1', type: 'delta', groupId: 'g1' });
    assert.equal(frame.groupId, 'g1');
  });

  it('should accept groupID (uppercase D) and normalize to groupId', () => {
    let frame = new Frame({ id: 'f1', type: 'delta', groupID: 'g1' });
    assert.equal(frame.groupId, 'g1');
  });

  it('should prefer groupId over groupID when both are present', () => {
    let frame = new Frame({ id: 'f1', type: 'delta', groupId: 'from-camel', groupID: 'from-upper' });
    assert.equal(frame.groupId, 'from-camel');
  });

  it('should default groupId to null when neither casing is provided', () => {
    let frame = new Frame({ id: 'f1', type: 'delta' });
    assert.equal(frame.groupId, null);
  });
});
