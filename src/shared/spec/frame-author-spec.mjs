'use strict';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Frame }        from '../frame-manager/frame.mjs';
import { FrameManager } from '../frame-manager/frame-manager.mjs';

// =============================================================================
// Frame Author Fields — Phase B Step 1
// =============================================================================
// The Frame value object must carry authorType and authorID so every subsequent
// step in Phase B can identify who created each frame.
// =============================================================================

describe('Frame author fields', () => {
  it('should default authorType to null when not provided', () => {
    let frame = new Frame({ id: 'f1', type: 'message' });
    assert.equal(frame.authorType, null);
  });

  it('should default authorID to null when not provided', () => {
    let frame = new Frame({ id: 'f1', type: 'message' });
    assert.equal(frame.authorID, null);
  });

  it('should preserve authorType when provided', () => {
    let frame = new Frame({ id: 'f1', type: 'message', authorType: 'agent' });
    assert.equal(frame.authorType, 'agent');
  });

  it('should preserve authorID when provided', () => {
    let frame = new Frame({ id: 'f1', type: 'message', authorID: 'agt_123' });
    assert.equal(frame.authorID, 'agt_123');
  });

  it('should preserve both authorType and authorID together', () => {
    let frame = new Frame({
      id:         'f1',
      type:       'UserMessage',
      authorType: 'user',
      authorID:   'usr_abc',
    });

    assert.equal(frame.authorType, 'user');
    assert.equal(frame.authorID, 'usr_abc');
  });

  it('should round-trip through FrameManager merge', () => {
    let manager = new FrameManager();

    manager.merge([{
      id:         'f1',
      type:       'message',
      authorType: 'agent',
      authorID:   'agt_xyz',
    }]);

    let frame = manager.get('f1');
    assert.equal(frame.authorType, 'agent');
    assert.equal(frame.authorID, 'agt_xyz');
  });
});
