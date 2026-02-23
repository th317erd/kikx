'use strict';

// ============================================================================
// Compaction System Tests
// ============================================================================
// Tests for:
// - Snapshot population during compaction
// - Compact frame rendering/visibility
// - getVisibleFrames including compact frames as dividers

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ============================================================================
// Frame Types (matches server/lib/frames/index.mjs)
// ============================================================================

const FrameType = {
  MESSAGE: 'message',
  REQUEST: 'request',
  RESULT: 'result',
  UPDATE: 'update',
  COMPACT: 'compact',
};

// ============================================================================
// compileFrames (same as session-frames-provider.js)
// ============================================================================

function compileFrames(frames) {
  const compiled = new Map();

  for (const frame of frames) {
    switch (frame.type) {
      case FrameType.COMPACT:
        if (frame.payload && frame.payload.snapshot) {
          for (const [id, content] of Object.entries(frame.payload.snapshot)) {
            compiled.set(id, content);
          }
        }
        break;

      case FrameType.UPDATE:
        if (frame.targetIds) {
          for (const targetId of frame.targetIds) {
            if (targetId.startsWith('frame:')) {
              const frameId = targetId.slice(6);
              if (compiled.has(frameId)) {
                compiled.set(frameId, frame.payload);
              }
            }
          }
        }
        break;

      case FrameType.MESSAGE:
      case FrameType.REQUEST:
      case FrameType.RESULT:
      default:
        compiled.set(frame.id, frame.payload);
        break;
    }
  }

  return compiled;
}

// ============================================================================
// getVisibleFrames logic (ported from session-frames-provider.js)
// Must include compact frames as dividers
// ============================================================================

function getVisibleFrames(frames, compiledMap, showHidden = false) {
  // Filter out non-displayable frame types (update only — compact is now visible)
  const displayable = frames.filter((f) => f.type !== 'update');

  if (showHidden) {
    return displayable;
  }

  // Filter out hidden frames (but always show compact frames)
  return displayable.filter((f) => {
    if (f.type === 'compact') return true; // Always show compact as divider
    const payload = compiledMap.get(f.id) || f.payload || {};
    return !payload.hidden;
  });
}

// ============================================================================
// buildSnapshotFromFrames — builds snapshot for compact frame
// This is the function we need to implement in compaction.mjs
// ============================================================================

function buildSnapshotFromFrames(frames) {
  const compiled = compileFrames(frames);
  const snapshot = {};

  for (const frame of frames) {
    // Only include visible MESSAGE frames in snapshot
    if (frame.type !== FrameType.MESSAGE) continue;

    const payload = compiled.get(frame.id);
    if (!payload) continue;

    // Skip hidden messages (system prompts, etc.)
    if (payload.hidden) continue;

    snapshot[frame.id] = payload;
  }

  return snapshot;
}


// ============================================================================
// Tests: Compact Frame Visibility
// ============================================================================

describe('Compact Frame Visibility', () => {
  it('should include compact frames in visible frames', () => {
    const frames = [
      {
        id: 'compact-1',
        type: FrameType.COMPACT,
        payload: { context: 'Summary of conversation', snapshot: {} },
        timestamp: '2026-01-01T00:00:01.000Z',
      },
      {
        id: 'msg-1',
        type: FrameType.MESSAGE,
        payload: { role: 'user', content: 'Hello after compact' },
        timestamp: '2026-01-01T00:00:02.000Z',
      },
    ];

    const compiled = compileFrames(frames);
    const visible = getVisibleFrames(frames, compiled);

    assert.equal(visible.length, 2);
    assert.equal(visible[0].type, 'compact');
    assert.equal(visible[1].type, 'message');
  });

  it('should show compact frame even when showHidden is false', () => {
    const frames = [
      {
        id: 'hidden-msg',
        type: FrameType.MESSAGE,
        payload: { role: 'system', content: 'System init', hidden: true },
        timestamp: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'compact-1',
        type: FrameType.COMPACT,
        payload: { context: 'Summary', snapshot: {} },
        timestamp: '2026-01-01T00:00:01.000Z',
      },
      {
        id: 'msg-1',
        type: FrameType.MESSAGE,
        payload: { role: 'user', content: 'After compact' },
        timestamp: '2026-01-01T00:00:02.000Z',
      },
    ];

    const compiled = compileFrames(frames);
    const visible = getVisibleFrames(frames, compiled, false);

    // Hidden message filtered out, compact and msg-1 remain
    assert.equal(visible.length, 2);
    assert.equal(visible[0].type, 'compact');
    assert.equal(visible[1].type, 'message');
  });

  it('should still filter out update frames', () => {
    const frames = [
      {
        id: 'msg-1',
        type: FrameType.MESSAGE,
        payload: { role: 'user', content: 'Original' },
        timestamp: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'update-1',
        type: FrameType.UPDATE,
        targetIds: ['frame:msg-1'],
        payload: { role: 'user', content: 'Updated' },
        timestamp: '2026-01-01T00:00:01.000Z',
      },
      {
        id: 'compact-1',
        type: FrameType.COMPACT,
        payload: { context: 'Summary', snapshot: {} },
        timestamp: '2026-01-01T00:00:02.000Z',
      },
    ];

    const compiled = compileFrames(frames);
    const visible = getVisibleFrames(frames, compiled);

    // msg-1 and compact-1 visible, update-1 filtered
    assert.equal(visible.length, 2);
    assert.equal(visible[0].type, 'message');
    assert.equal(visible[1].type, 'compact');
  });

  it('should handle multiple compact frames', () => {
    const frames = [
      {
        id: 'compact-1',
        type: FrameType.COMPACT,
        payload: { context: 'First summary', snapshot: {} },
        timestamp: '2026-01-01T00:00:01.000Z',
      },
      {
        id: 'msg-1',
        type: FrameType.MESSAGE,
        payload: { role: 'user', content: 'Between compacts' },
        timestamp: '2026-01-01T00:00:02.000Z',
      },
      {
        id: 'compact-2',
        type: FrameType.COMPACT,
        payload: { context: 'Second summary', snapshot: {} },
        timestamp: '2026-01-01T00:00:03.000Z',
      },
      {
        id: 'msg-2',
        type: FrameType.MESSAGE,
        payload: { role: 'user', content: 'After second compact' },
        timestamp: '2026-01-01T00:00:04.000Z',
      },
    ];

    const compiled = compileFrames(frames);
    const visible = getVisibleFrames(frames, compiled);

    assert.equal(visible.length, 4);
    assert.equal(visible[0].type, 'compact');
    assert.equal(visible[1].type, 'message');
    assert.equal(visible[2].type, 'compact');
    assert.equal(visible[3].type, 'message');
  });

  it('should preserve compact frame context in payload', () => {
    const frames = [
      {
        id: 'compact-1',
        type: FrameType.COMPACT,
        payload: {
          context: '## CONTEXT SUMMARY\nUser discussed AI topics.\n\n## TODO LIST\nNo pending tasks.',
          snapshot: {},
        },
        timestamp: '2026-01-01T00:00:01.000Z',
      },
    ];

    const compiled = compileFrames(frames);
    const visible = getVisibleFrames(frames, compiled);

    assert.equal(visible.length, 1);
    assert.equal(visible[0].payload.context, '## CONTEXT SUMMARY\nUser discussed AI topics.\n\n## TODO LIST\nNo pending tasks.');
  });
});

// ============================================================================
// Tests: Snapshot Population
// ============================================================================

describe('Compaction Snapshot Population', () => {
  it('should build snapshot from visible message frames', () => {
    const frames = [
      {
        id: 'msg-1',
        type: FrameType.MESSAGE,
        payload: { role: 'user', content: 'Hello' },
        timestamp: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'msg-2',
        type: FrameType.MESSAGE,
        payload: { role: 'assistant', content: 'Hi there' },
        timestamp: '2026-01-01T00:00:01.000Z',
      },
    ];

    const snapshot = buildSnapshotFromFrames(frames);

    assert.equal(Object.keys(snapshot).length, 2);
    assert.equal(snapshot['msg-1'].content, 'Hello');
    assert.equal(snapshot['msg-2'].content, 'Hi there');
  });

  it('should exclude hidden messages from snapshot', () => {
    const frames = [
      {
        id: 'sys-1',
        type: FrameType.MESSAGE,
        payload: { role: 'system', content: 'System init', hidden: true },
        timestamp: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'msg-1',
        type: FrameType.MESSAGE,
        payload: { role: 'user', content: 'Hello' },
        timestamp: '2026-01-01T00:00:01.000Z',
      },
    ];

    const snapshot = buildSnapshotFromFrames(frames);

    assert.equal(Object.keys(snapshot).length, 1);
    assert.ok(!snapshot['sys-1']);
    assert.equal(snapshot['msg-1'].content, 'Hello');
  });

  it('should exclude non-message frames from snapshot', () => {
    const frames = [
      {
        id: 'msg-1',
        type: FrameType.MESSAGE,
        payload: { role: 'user', content: 'Hello' },
        timestamp: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'req-1',
        type: FrameType.REQUEST,
        payload: { action: 'websearch', query: 'test' },
        timestamp: '2026-01-01T00:00:01.000Z',
      },
      {
        id: 'result-1',
        type: FrameType.RESULT,
        payload: { status: 'success' },
        timestamp: '2026-01-01T00:00:02.000Z',
      },
    ];

    const snapshot = buildSnapshotFromFrames(frames);

    assert.equal(Object.keys(snapshot).length, 1);
    assert.ok(snapshot['msg-1']);
    assert.ok(!snapshot['req-1']);
    assert.ok(!snapshot['result-1']);
  });

  it('should use compiled content (after UPDATEs applied)', () => {
    const frames = [
      {
        id: 'msg-1',
        type: FrameType.MESSAGE,
        payload: { role: 'assistant', content: 'Original answer' },
        timestamp: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'update-1',
        type: FrameType.UPDATE,
        targetIds: ['frame:msg-1'],
        payload: { role: 'assistant', content: 'Updated with prompt answer' },
        timestamp: '2026-01-01T00:00:01.000Z',
      },
    ];

    const snapshot = buildSnapshotFromFrames(frames);

    assert.equal(Object.keys(snapshot).length, 1);
    assert.equal(snapshot['msg-1'].content, 'Updated with prompt answer');
  });

  it('should handle empty frames array', () => {
    const snapshot = buildSnapshotFromFrames([]);
    assert.deepEqual(snapshot, {});
  });

  it('should produce snapshot that compileFrames can load', () => {
    // Build snapshot from existing frames
    const originalFrames = [
      {
        id: 'msg-1',
        type: FrameType.MESSAGE,
        payload: { role: 'user', content: 'Hello' },
        timestamp: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'msg-2',
        type: FrameType.MESSAGE,
        payload: { role: 'assistant', content: 'Hi' },
        timestamp: '2026-01-01T00:00:01.000Z',
      },
    ];

    const snapshot = buildSnapshotFromFrames(originalFrames);

    // Now create a compact frame with this snapshot + new messages
    const compactPlusNew = [
      {
        id: 'compact-1',
        type: FrameType.COMPACT,
        payload: { context: 'Summary', snapshot },
        timestamp: '2026-01-01T00:00:02.000Z',
      },
      {
        id: 'msg-3',
        type: FrameType.MESSAGE,
        payload: { role: 'user', content: 'New message' },
        timestamp: '2026-01-01T00:00:03.000Z',
      },
    ];

    const compiled = compileFrames(compactPlusNew);

    // Snapshot entries restored + new message
    assert.equal(compiled.size, 3);
    assert.equal(compiled.get('msg-1').content, 'Hello');
    assert.equal(compiled.get('msg-2').content, 'Hi');
    assert.equal(compiled.get('msg-3').content, 'New message');
  });
});

// ============================================================================
// Tests: Compact Frame to Message Conversion
// ============================================================================

describe('Compact Frame to Message Format', () => {
  it('should convert compact frame to divider message', () => {
    const frame = {
      id: 'compact-1',
      type: FrameType.COMPACT,
      authorType: 'system',
      timestamp: '2026-01-01T00:00:01.000Z',
      payload: {
        context: '## CONTEXT SUMMARY\nThe user discussed favorite colors.\n\n## TODO LIST\nNo pending tasks.',
        snapshot: {},
      },
    };

    // When hero-chat encounters a compact frame, it should produce a "divider" message
    const message = frameToMessage(frame);

    assert.equal(message.type, 'compact');
    assert.equal(message.role, 'system');
    assert.ok(message.context.includes('CONTEXT SUMMARY'));
    assert.equal(message.frameId, 'compact-1');
  });
});

/**
 * Convert a frame to message format (mirrors hero-chat._frameToMessage).
 * For compact frames, extracts context for display.
 */
function frameToMessage(frame) {
  if (frame.type === FrameType.COMPACT) {
    return {
      id:        frame.id,
      type:      'compact',
      role:      'system',
      context:   frame.payload?.context || '',
      frameId:   frame.id,
      createdAt: frame.timestamp,
    };
  }

  const payload = frame.payload || {};
  return {
    id:         frame.id,
    role:       payload.role || ((frame.authorType === 'user') ? 'user' : 'assistant'),
    content:    payload.content || '',
    hidden:     payload.hidden || false,
    type:       frame.type,
    authorType: frame.authorType,
    createdAt:  frame.timestamp,
    frameId:    frame.id,
  };
}
