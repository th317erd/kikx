'use strict';

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from '../../../src/shared/lib/event-emitter.mjs';

// =============================================================================
// StreamController — commit event forwarding tests
// =============================================================================
// These tests verify the SSE commit event forwarding logic in isolation by
// simulating the InteractionLoop emit pattern and a mock response.
// =============================================================================

function createMockResponse() {
  let chunks = [];

  return {
    chunks,
    writableEnded: false,
    setHeader() {},
    write(data) { chunks.push(data); },
    end()       { this.writableEnded = true; },
  };
}

function createMockRequest() {
  let listeners = {};

  return {
    on(event, listener) {
      if (!listeners[event])
        listeners[event] = [];

      listeners[event].push(listener);
    },
    _emit(event) {
      let handlers = listeners[event] || [];
      for (let handler of handlers)
        handler();
    },
    _listeners: listeners,
  };
}

// Simulate the StreamController.connect() listener wiring without importing
// the full Mythix controller. This mirrors the exact listener logic.
function wireStreamListeners(interactionLoop, sessionID, response) {
  let onFrame = ({ sessionID: sid, frame }) => {
    if (sid !== sessionID)
      return;

    response.write(`event: frame\ndata: ${JSON.stringify(frame)}\n\n`);
  };

  let onCommit = ({ sessionID: sid, commit }) => {
    if (sid !== sessionID)
      return;

    response.write(`event: commit\ndata: ${JSON.stringify(commit)}\n\n`);
  };

  let onInteractionStart = ({ sessionID: sid, interactionID, agentID }) => {
    if (sid !== sessionID)
      return;

    response.write(`event: interaction:start\ndata: ${JSON.stringify({ interactionID, agentID: agentID || null })}\n\n`);
  };

  let onInteractionEnd = ({ sessionID: sid, interactionID, agentID }) => {
    if (sid !== sessionID)
      return;

    response.write(`event: interaction:end\ndata: ${JSON.stringify({ interactionID, agentID: agentID || null })}\n\n`);
  };

  let onDelta = ({ sessionID: sid, interactionID: iid, content, authorType: aType, authorID: aID }) => {
    if (sid !== sessionID)
      return;

    response.write(`event: Delta\ndata: ${JSON.stringify({ interactionID: iid, content, authorType: aType || null, authorID: aID || null })}\n\n`);
  };

  interactionLoop.on('frame', onFrame);
  interactionLoop.on('commit', onCommit);
  interactionLoop.on('interaction:start', onInteractionStart);
  interactionLoop.on('interaction:end', onInteractionEnd);
  interactionLoop.on('Delta', onDelta);

  return () => {
    interactionLoop.off('frame', onFrame);
    interactionLoop.off('commit', onCommit);
    interactionLoop.off('interaction:start', onInteractionStart);
    interactionLoop.off('interaction:end', onInteractionEnd);
    interactionLoop.off('Delta', onDelta);
  };
}

describe('StreamController commit forwarding', () => {
  let interactionLoop;
  let response;
  let cleanup;

  beforeEach(() => {
    interactionLoop = new EventEmitter();
    interactionLoop.setMaxListeners(Infinity);
    response = createMockResponse();
    cleanup  = wireStreamListeners(interactionLoop, 'ses_abc', response);
  });

  // ---------------------------------------------------------------------------
  // Commit event forwarding
  // ---------------------------------------------------------------------------

  describe('commit events', () => {
    it('forwards commit events for the correct session', () => {
      let commit = {
        order:       1,
        changes:     [{ frameID: 'frm_1', operation: 'create' }],
        authorType:  'user',
        authorID:    'usr_1',
        timestamp:   Date.now(),
        parentOrder: null,
        silent:      false,
        frames:      [{ id: 'frm_1', type: 'UserMessage', content: { text: 'hello' } }],
      };

      interactionLoop.emit('commit', { sessionID: 'ses_abc', commit });

      let commitChunks = response.chunks.filter((chunk) => chunk.startsWith('event: commit'));
      assert.equal(commitChunks.length, 1);

      let data = JSON.parse(commitChunks[0].split('data: ')[1].trim());
      assert.equal(data.order, 1);
      assert.deepStrictEqual(data.frames, commit.frames);
    });

    it('filters commit events by sessionID', () => {
      let commit = {
        order:  1,
        frames: [{ id: 'frm_1', type: 'Message', content: { html: 'hi' } }],
      };

      interactionLoop.emit('commit', { sessionID: 'ses_other', commit });

      let commitChunks = response.chunks.filter((chunk) => chunk.startsWith('event: commit'));
      assert.equal(commitChunks.length, 0);
    });

    it('includes enriched frame data in commit payload', () => {
      let frameData = {
        id:         'frm_enriched',
        type: 'Message',
        content:    { html: '<p>enriched</p>' },
        timestamp:  Date.now(),
        authorType: 'agent',
        authorID:   'agt_1',
      };

      let commit = {
        order:       2,
        changes:     [{ frameID: 'frm_enriched', operation: 'create' }],
        authorType:  'agent',
        authorID:    'agt_1',
        timestamp:   Date.now(),
        parentOrder: 1,
        silent:      false,
        frames:      [frameData],
      };

      interactionLoop.emit('commit', { sessionID: 'ses_abc', commit });

      let commitChunks = response.chunks.filter((chunk) => chunk.startsWith('event: commit'));
      let data = JSON.parse(commitChunks[0].split('data: ')[1].trim());

      assert.equal(data.frames.length, 1);
      assert.equal(data.frames[0].id, 'frm_enriched');
      assert.equal(data.frames[0].content.html, '<p>enriched</p>');
    });
  });

  // ---------------------------------------------------------------------------
  // Frame event still works (backward compatibility)
  // ---------------------------------------------------------------------------

  describe('frame event backward compatibility', () => {
    it('still forwards frame events alongside commit events', () => {
      let frame = { id: 'frm_1', type: 'Message', content: { html: 'test' } };

      interactionLoop.emit('frame', { sessionID: 'ses_abc', frame });

      let frameChunks = response.chunks.filter((chunk) => chunk.startsWith('event: frame'));
      assert.equal(frameChunks.length, 1);
    });

    it('both frame and commit events are forwarded for same interaction', () => {
      let frame  = { id: 'frm_1', type: 'Message', content: { html: 'test' } };
      let commit = { order: 1, frames: [frame], changes: [{ frameID: 'frm_1', operation: 'create' }] };

      interactionLoop.emit('frame', { sessionID: 'ses_abc', frame });
      interactionLoop.emit('commit', { sessionID: 'ses_abc', commit });

      let frameChunks  = response.chunks.filter((chunk) => chunk.startsWith('event: frame'));
      let commitChunks = response.chunks.filter((chunk) => chunk.startsWith('event: commit'));

      assert.equal(frameChunks.length, 1);
      assert.equal(commitChunks.length, 1);
    });
  });

  // ---------------------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------------------

  describe('cleanup', () => {
    it('cleanup removes all listeners', () => {
      cleanup();

      interactionLoop.emit('frame', { sessionID: 'ses_abc', frame: {} });
      interactionLoop.emit('commit', { sessionID: 'ses_abc', commit: {} });

      assert.equal(response.chunks.length, 0);
    });
  });

  // ---------------------------------------------------------------------------
  // Streaming identity — agentID in interaction events, authorType/authorID in delta
  // ---------------------------------------------------------------------------

  describe('streaming identity', () => {
    it('interaction:start SSE includes agentID', () => {
      interactionLoop.emit('interaction:start', { sessionID: 'ses_abc', interactionID: 'int_1', agentID: 'agt_42' });

      let startChunks = response.chunks.filter((chunk) => chunk.startsWith('event: interaction:start'));
      assert.equal(startChunks.length, 1);

      let data = JSON.parse(startChunks[0].split('data: ')[1].trim());
      assert.equal(data.interactionID, 'int_1');
      assert.equal(data.agentID, 'agt_42');
    });

    it('interaction:start SSE agentID is null when not provided', () => {
      interactionLoop.emit('interaction:start', { sessionID: 'ses_abc', interactionID: 'int_2' });

      let startChunks = response.chunks.filter((chunk) => chunk.startsWith('event: interaction:start'));
      let data = JSON.parse(startChunks[0].split('data: ')[1].trim());
      assert.equal(data.agentID, null);
    });

    it('interaction:end SSE includes agentID', () => {
      interactionLoop.emit('interaction:end', { sessionID: 'ses_abc', interactionID: 'int_3', agentID: 'agt_99' });

      let endChunks = response.chunks.filter((chunk) => chunk.startsWith('event: interaction:end'));
      assert.equal(endChunks.length, 1);

      let data = JSON.parse(endChunks[0].split('data: ')[1].trim());
      assert.equal(data.interactionID, 'int_3');
      assert.equal(data.agentID, 'agt_99');
    });

    it('delta SSE includes authorType and authorID', () => {
      interactionLoop.emit('Delta', {
        sessionID:     'ses_abc',
        interactionID: 'int_4',
        content:       { text: 'hello' },
        authorType:    'agent',
        authorID:      'agt_55',
      });

      let deltaChunks = response.chunks.filter((chunk) => chunk.startsWith('event: Delta'));
      assert.equal(deltaChunks.length, 1);

      let data = JSON.parse(deltaChunks[0].split('data: ')[1].trim());
      assert.equal(data.interactionID, 'int_4');
      assert.equal(data.authorType, 'agent');
      assert.equal(data.authorID, 'agt_55');
      assert.deepStrictEqual(data.content, { text: 'hello' });
    });

    it('delta SSE authorType/authorID are null when not provided', () => {
      interactionLoop.emit('Delta', {
        sessionID:     'ses_abc',
        interactionID: 'int_5',
        content:       { text: 'bare' },
      });

      let deltaChunks = response.chunks.filter((chunk) => chunk.startsWith('event: Delta'));
      let data = JSON.parse(deltaChunks[0].split('data: ')[1].trim());
      assert.equal(data.authorType, null);
      assert.equal(data.authorID, null);
    });

    it('filters streaming identity events by sessionID', () => {
      interactionLoop.emit('interaction:start', { sessionID: 'ses_other', interactionID: 'int_x', agentID: 'agt_1' });
      interactionLoop.emit('interaction:end', { sessionID: 'ses_other', interactionID: 'int_x', agentID: 'agt_1' });
      interactionLoop.emit('Delta', { sessionID: 'ses_other', interactionID: 'int_x', content: { text: 'hi' }, authorType: 'agent', authorID: 'agt_1' });

      assert.equal(response.chunks.length, 0);
    });
  });

  // ---------------------------------------------------------------------------
  // SSE format correctness
  // ---------------------------------------------------------------------------

  describe('SSE format', () => {
    it('commit events are formatted as valid SSE', () => {
      let commit = { order: 1, frames: [{ id: 'f1' }] };
      interactionLoop.emit('commit', { sessionID: 'ses_abc', commit });

      let chunk = response.chunks[0];
      assert.ok(chunk.startsWith('event: commit\n'));
      assert.ok(chunk.includes('data: '));
      assert.ok(chunk.endsWith('\n\n'));

      // Verify JSON is parseable
      let jsonStr = chunk.split('data: ')[1].replace(/\n\n$/, '');
      let parsed  = JSON.parse(jsonStr);
      assert.equal(parsed.order, 1);
    });

    it('multiple commits produce separate SSE events', () => {
      for (let i = 1; i <= 3; i++) {
        interactionLoop.emit('commit', {
          sessionID: 'ses_abc',
          commit:    { order: i, frames: [{ id: `frm_${i}` }] },
        });
      }

      let commitChunks = response.chunks.filter((chunk) => chunk.startsWith('event: commit'));
      assert.equal(commitChunks.length, 3);
    });
  });
});
