'use strict';

// ============================================================================
// Session Frames Provider Tests
// ============================================================================
// Tests for the client-side frame compilation system including:
// - compileFrames function (event-sourcing replay logic)
// - Frame type handling (MESSAGE, REQUEST, RESULT, UPDATE, COMPACT)
// - ID-based overwrites

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ============================================================================
// Frame Types (matches session-frames-provider.js)
// ============================================================================

const FrameType = {
  MESSAGE: 'message',
  REQUEST: 'request',
  RESULT: 'result',
  UPDATE: 'update',
  COMPACT: 'compact',
};

// ============================================================================
// compileFrames Implementation (ported from session-frames-provider.js)
// ============================================================================

/**
 * Compile frames into current state by replaying them in timestamp order.
 * This is the core of the event-sourcing system.
 *
 * @param {Object[]} frames - Array of frames sorted by timestamp
 * @returns {Map<string, Object>} Map of frame ID to compiled payload
 */
function compileFrames(frames) {
  const compiled = new Map();

  for (const frame of frames) {
    switch (frame.type) {
      case FrameType.COMPACT:
        // Load snapshot from compact frame
        if (frame.payload && frame.payload.snapshot) {
          for (const [id, content] of Object.entries(frame.payload.snapshot)) {
            compiled.set(id, content);
          }
        }
        break;

      case FrameType.UPDATE:
        // Replace content of target frame(s)
        if (frame.targetIds) {
          for (const targetId of frame.targetIds) {
            // Parse target ID - format is "prefix:id"
            if (targetId.startsWith('frame:')) {
              const frameId = targetId.slice(6);
              // Only apply update if target exists (graceful handling)
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
        // Store frame payload by ID
        compiled.set(frame.id, frame.payload);
        break;
    }
  }

  return compiled;
}

// ============================================================================
// Tests: Basic Frame Compilation
// ============================================================================

describe('compileFrames - Basic Operations', () => {
  it('should return empty Map for empty input', () => {
    const result = compileFrames([]);
    assert.ok(result instanceof Map);
    assert.equal(result.size, 0);
  });

  it('should compile single MESSAGE frame', () => {
    const frames = [
      {
        id: 'msg-1',
        type: FrameType.MESSAGE,
        payload: { role: 'user', content: 'Hello' },
        timestamp: '2026-01-01T00:00:00.000Z',
      },
    ];

    const result = compileFrames(frames);
    assert.equal(result.size, 1);
    assert.ok(result.has('msg-1'));
    assert.equal(result.get('msg-1').content, 'Hello');
  });

  it('should compile multiple frames in order', () => {
    const frames = [
      {
        id: 'msg-1',
        type: FrameType.MESSAGE,
        payload: { role: 'user', content: 'Hello' },
        timestamp: '2026-01-01T00:00:00.001Z',
      },
      {
        id: 'msg-2',
        type: FrameType.MESSAGE,
        payload: { role: 'assistant', content: 'Hi there' },
        timestamp: '2026-01-01T00:00:00.002Z',
      },
      {
        id: 'req-1',
        type: FrameType.REQUEST,
        payload: { action: 'websearch', query: 'test' },
        timestamp: '2026-01-01T00:00:00.003Z',
      },
    ];

    const result = compileFrames(frames);
    assert.equal(result.size, 3);
    assert.ok(result.has('msg-1'));
    assert.ok(result.has('msg-2'));
    assert.ok(result.has('req-1'));
    assert.equal(result.get('msg-1').content, 'Hello');
    assert.equal(result.get('msg-2').content, 'Hi there');
    assert.equal(result.get('req-1').action, 'websearch');
  });
});

// ============================================================================
// Tests: UPDATE Frames
// ============================================================================

describe('compileFrames - UPDATE Frames', () => {
  it('should apply UPDATE to existing frame', () => {
    const frames = [
      {
        id: 'msg-1',
        type: FrameType.MESSAGE,
        payload: { role: 'user', content: 'Original content' },
        timestamp: '2026-01-01T00:00:00.001Z',
      },
      {
        id: 'update-1',
        type: FrameType.UPDATE,
        targetIds: ['frame:msg-1'],
        payload: { role: 'user', content: 'Updated content' },
        timestamp: '2026-01-01T00:00:00.002Z',
      },
    ];

    const result = compileFrames(frames);
    // UPDATE frames are not stored by their own ID
    assert.equal(result.size, 1);
    assert.ok(result.has('msg-1'));
    assert.equal(result.get('msg-1').content, 'Updated content');
  });

  it('should ignore UPDATE for non-existent target', () => {
    const frames = [
      {
        id: 'update-1',
        type: FrameType.UPDATE,
        targetIds: ['frame:non-existent'],
        payload: { content: 'Should not appear' },
        timestamp: '2026-01-01T00:00:00.001Z',
      },
    ];

    const result = compileFrames(frames);
    assert.equal(result.size, 0);
  });

  it('should apply multiple UPDATEs to same target (last wins)', () => {
    const frames = [
      {
        id: 'msg-1',
        type: FrameType.MESSAGE,
        payload: { content: 'v1' },
        timestamp: '2026-01-01T00:00:00.001Z',
      },
      {
        id: 'update-1',
        type: FrameType.UPDATE,
        targetIds: ['frame:msg-1'],
        payload: { content: 'v2' },
        timestamp: '2026-01-01T00:00:00.002Z',
      },
      {
        id: 'update-2',
        type: FrameType.UPDATE,
        targetIds: ['frame:msg-1'],
        payload: { content: 'v3' },
        timestamp: '2026-01-01T00:00:00.003Z',
      },
    ];

    const result = compileFrames(frames);
    assert.equal(result.size, 1);
    assert.equal(result.get('msg-1').content, 'v3');
  });

  it('should apply UPDATE to multiple targets', () => {
    const frames = [
      {
        id: 'msg-1',
        type: FrameType.MESSAGE,
        payload: { content: 'A' },
        timestamp: '2026-01-01T00:00:00.001Z',
      },
      {
        id: 'msg-2',
        type: FrameType.MESSAGE,
        payload: { content: 'B' },
        timestamp: '2026-01-01T00:00:00.002Z',
      },
      {
        id: 'update-1',
        type: FrameType.UPDATE,
        targetIds: ['frame:msg-1', 'frame:msg-2'],
        payload: { content: 'Updated' },
        timestamp: '2026-01-01T00:00:00.003Z',
      },
    ];

    const result = compileFrames(frames);
    assert.equal(result.size, 2);
    assert.equal(result.get('msg-1').content, 'Updated');
    assert.equal(result.get('msg-2').content, 'Updated');
  });
});

// ============================================================================
// Tests: COMPACT Frames
// ============================================================================

describe('compileFrames - COMPACT Frames', () => {
  it('should load state from COMPACT snapshot', () => {
    const frames = [
      {
        id: 'compact-1',
        type: FrameType.COMPACT,
        payload: {
          snapshot: {
            'msg-1': { content: 'Snapshot A' },
            'msg-2': { content: 'Snapshot B' },
          },
        },
        timestamp: '2026-01-01T00:00:00.001Z',
      },
    ];

    const result = compileFrames(frames);
    assert.equal(result.size, 2);
    assert.equal(result.get('msg-1').content, 'Snapshot A');
    assert.equal(result.get('msg-2').content, 'Snapshot B');
  });

  it('should handle COMPACT without snapshot', () => {
    const frames = [
      {
        id: 'compact-1',
        type: FrameType.COMPACT,
        payload: {},
        timestamp: '2026-01-01T00:00:00.001Z',
      },
    ];

    const result = compileFrames(frames);
    assert.equal(result.size, 0);
  });

  it('should apply frames after COMPACT', () => {
    const frames = [
      {
        id: 'compact-1',
        type: FrameType.COMPACT,
        payload: {
          snapshot: {
            'msg-1': { content: 'From snapshot' },
          },
        },
        timestamp: '2026-01-01T00:00:00.001Z',
      },
      {
        id: 'msg-2',
        type: FrameType.MESSAGE,
        payload: { content: 'New message' },
        timestamp: '2026-01-01T00:00:00.002Z',
      },
      {
        id: 'update-1',
        type: FrameType.UPDATE,
        targetIds: ['frame:msg-1'],
        payload: { content: 'Updated from snapshot' },
        timestamp: '2026-01-01T00:00:00.003Z',
      },
    ];

    const result = compileFrames(frames);
    assert.equal(result.size, 2);
    assert.equal(result.get('msg-1').content, 'Updated from snapshot');
    assert.equal(result.get('msg-2').content, 'New message');
  });
});

// ============================================================================
// Tests: Frame Type Handling
// ============================================================================

describe('compileFrames - Frame Types', () => {
  it('should handle REQUEST frames', () => {
    const frames = [
      {
        id: 'req-1',
        type: FrameType.REQUEST,
        payload: { action: 'websearch', query: 'test query' },
        timestamp: '2026-01-01T00:00:00.001Z',
      },
    ];

    const result = compileFrames(frames);
    assert.equal(result.size, 1);
    assert.equal(result.get('req-1').action, 'websearch');
    assert.equal(result.get('req-1').query, 'test query');
  });

  it('should handle RESULT frames', () => {
    const frames = [
      {
        id: 'result-1',
        type: FrameType.RESULT,
        payload: { status: 'success', data: { items: [1, 2, 3] } },
        timestamp: '2026-01-01T00:00:00.001Z',
      },
    ];

    const result = compileFrames(frames);
    assert.equal(result.size, 1);
    assert.equal(result.get('result-1').status, 'success');
    assert.deepEqual(result.get('result-1').data.items, [1, 2, 3]);
  });

  it('should handle unknown frame types as default', () => {
    const frames = [
      {
        id: 'custom-1',
        type: 'custom-type',
        payload: { custom: true },
        timestamp: '2026-01-01T00:00:00.001Z',
      },
    ];

    const result = compileFrames(frames);
    assert.equal(result.size, 1);
    assert.equal(result.get('custom-1').custom, true);
  });
});

// ============================================================================
// Tests: Determinism
// ============================================================================

describe('compileFrames - Determinism', () => {
  it('should produce same output for same input (idempotent)', () => {
    const frames = [
      {
        id: 'msg-1',
        type: FrameType.MESSAGE,
        payload: { content: 'A' },
        timestamp: '2026-01-01T00:00:00.001Z',
      },
      {
        id: 'update-1',
        type: FrameType.UPDATE,
        targetIds: ['frame:msg-1'],
        payload: { content: 'B' },
        timestamp: '2026-01-01T00:00:00.002Z',
      },
    ];

    const result1 = compileFrames(frames);
    const result2 = compileFrames(frames);
    const result3 = compileFrames(frames);

    assert.equal(result1.get('msg-1').content, 'B');
    assert.equal(result2.get('msg-1').content, 'B');
    assert.equal(result3.get('msg-1').content, 'B');
  });

  it('should be order-dependent (frame order matters)', () => {
    const framesA = [
      { id: 'msg-1', type: FrameType.MESSAGE, payload: { content: 'First' }, timestamp: '2026-01-01T00:00:00.001Z' },
      { id: 'msg-1', type: FrameType.MESSAGE, payload: { content: 'Second' }, timestamp: '2026-01-01T00:00:00.002Z' },
    ];

    const framesB = [
      { id: 'msg-1', type: FrameType.MESSAGE, payload: { content: 'Second' }, timestamp: '2026-01-01T00:00:00.001Z' },
      { id: 'msg-1', type: FrameType.MESSAGE, payload: { content: 'First' }, timestamp: '2026-01-01T00:00:00.002Z' },
    ];

    const resultA = compileFrames(framesA);
    const resultB = compileFrames(framesB);

    // Same ID frames overwrite - last one wins
    assert.equal(resultA.get('msg-1').content, 'Second');
    assert.equal(resultB.get('msg-1').content, 'First');
  });
});
