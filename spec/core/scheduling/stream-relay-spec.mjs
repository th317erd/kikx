'use strict';

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from '../../../src/shared/lib/event-emitter.mjs';
import { StreamRelay }  from '../../../src/core/scheduling/stream-relay.mjs';

// =============================================================================
// StreamRelay Tests
// =============================================================================
// Verifies cross-session delta forwarding, auto-destroy on interaction:end,
// manual destroy, multiple simultaneous relays, and filtering.
// =============================================================================

describe('StreamRelay', () => {
  let interactionLoop;
  let relay;

  beforeEach(() => {
    interactionLoop = new EventEmitter();
    interactionLoop.setMaxListeners(Infinity);
    relay = new StreamRelay(interactionLoop);
  });

  // ---------------------------------------------------------------------------
  // Construction
  // ---------------------------------------------------------------------------

  describe('construction', () => {
    it('creates with an InteractionLoop', () => {
      assert.ok(relay);
      assert.equal(relay.getRelayCount(), 0);
    });

    it('throws without an InteractionLoop', () => {
      assert.throws(() => new StreamRelay(), { message: /requires an InteractionLoop/ });
    });

    it('throws with null', () => {
      assert.throws(() => new StreamRelay(null), { message: /requires an InteractionLoop/ });
    });
  });

  // ---------------------------------------------------------------------------
  // createRelay — forwarding
  // ---------------------------------------------------------------------------

  describe('createRelay', () => {
    it('forwards delta events from target session to relay:delta', () => {
      let captured = [];
      relay.on('relay:delta', (event) => captured.push(event));

      relay.createRelay('ses_source', 'ses_target');

      interactionLoop.emit('delta', {
        sessionID:     'ses_target',
        interactionID: 'int_1',
        content:       { text: 'hello' },
        authorType:    'agent',
        authorID:      'agt_1',
      });

      assert.equal(captured.length, 1);
      assert.equal(captured[0].sourceSessionID, 'ses_source');
      assert.equal(captured[0].targetSessionID, 'ses_target');
      assert.equal(captured[0].interactionID, 'int_1');
      assert.deepStrictEqual(captured[0].content, { text: 'hello' });
      assert.equal(captured[0].authorType, 'agent');
      assert.equal(captured[0].authorID, 'agt_1');
    });

    it('forwards reflection-delta events', () => {
      let captured = [];
      relay.on('relay:reflection-delta', (event) => captured.push(event));

      relay.createRelay('ses_source', 'ses_target');

      interactionLoop.emit('reflection-delta', {
        sessionID:     'ses_target',
        interactionID: 'int_1',
        content:       { text: 'thinking' },
        authorType:    'agent',
        authorID:      'agt_1',
      });

      assert.equal(captured.length, 1);
      assert.equal(captured[0].sourceSessionID, 'ses_source');
      assert.equal(captured[0].targetSessionID, 'ses_target');
    });

    it('does not forward deltas from unrelated sessions', () => {
      let captured = [];
      relay.on('relay:delta', (event) => captured.push(event));

      relay.createRelay('ses_source', 'ses_target');

      interactionLoop.emit('delta', {
        sessionID:     'ses_other',
        interactionID: 'int_1',
        content:       { text: 'nope' },
      });

      assert.equal(captured.length, 0);
    });

    it('does not forward deltas from the source session itself', () => {
      let captured = [];
      relay.on('relay:delta', (event) => captured.push(event));

      relay.createRelay('ses_source', 'ses_target');

      interactionLoop.emit('delta', {
        sessionID:     'ses_source',
        interactionID: 'int_1',
        content:       { text: 'nope' },
      });

      assert.equal(captured.length, 0);
    });

    it('is idempotent — creating same relay twice does not duplicate events', () => {
      let captured = [];
      relay.on('relay:delta', (event) => captured.push(event));

      relay.createRelay('ses_source', 'ses_target');
      relay.createRelay('ses_source', 'ses_target');

      interactionLoop.emit('delta', {
        sessionID:     'ses_target',
        interactionID: 'int_1',
        content:       { text: 'hello' },
      });

      assert.equal(captured.length, 1);
    });

    it('throws when sourceSessionID is missing', () => {
      assert.throws(() => relay.createRelay(null, 'ses_target'), { message: /sourceSessionID/ });
    });

    it('throws when targetSessionID is missing', () => {
      assert.throws(() => relay.createRelay('ses_source', null), { message: /targetSessionID/ });
    });

    it('includes null authorType/authorID when not provided', () => {
      let captured = [];
      relay.on('relay:delta', (event) => captured.push(event));

      relay.createRelay('ses_source', 'ses_target');

      interactionLoop.emit('delta', {
        sessionID:     'ses_target',
        interactionID: 'int_1',
        content:       { text: 'bare' },
      });

      assert.equal(captured[0].authorType, null);
      assert.equal(captured[0].authorID, null);
    });
  });

  // ---------------------------------------------------------------------------
  // Auto-destroy on interaction:end
  // ---------------------------------------------------------------------------

  describe('auto-destroy', () => {
    it('destroys relay when interaction:end fires for target session', () => {
      relay.createRelay('ses_source', 'ses_target');
      assert.ok(relay.hasRelay('ses_source', 'ses_target'));

      interactionLoop.emit('interaction:end', { sessionID: 'ses_target', interactionID: 'int_1' });
      assert.ok(!relay.hasRelay('ses_source', 'ses_target'));
    });

    it('stops forwarding after auto-destroy', () => {
      let captured = [];
      relay.on('relay:delta', (event) => captured.push(event));

      relay.createRelay('ses_source', 'ses_target');

      // Auto-destroy
      interactionLoop.emit('interaction:end', { sessionID: 'ses_target', interactionID: 'int_1' });

      // Should no longer forward
      interactionLoop.emit('delta', {
        sessionID:     'ses_target',
        interactionID: 'int_2',
        content:       { text: 'after destroy' },
      });

      assert.equal(captured.length, 0);
    });

    it('does not destroy relay on interaction:end from unrelated session', () => {
      relay.createRelay('ses_source', 'ses_target');

      interactionLoop.emit('interaction:end', { sessionID: 'ses_other', interactionID: 'int_1' });
      assert.ok(relay.hasRelay('ses_source', 'ses_target'));
    });
  });

  // ---------------------------------------------------------------------------
  // Manual destroyRelay
  // ---------------------------------------------------------------------------

  describe('destroyRelay', () => {
    it('stops forwarding after manual destroy', () => {
      let captured = [];
      relay.on('relay:delta', (event) => captured.push(event));

      relay.createRelay('ses_source', 'ses_target');
      relay.destroyRelay('ses_source', 'ses_target');

      interactionLoop.emit('delta', {
        sessionID:     'ses_target',
        interactionID: 'int_1',
        content:       { text: 'nope' },
      });

      assert.equal(captured.length, 0);
    });

    it('returns true when relay existed', () => {
      relay.createRelay('ses_source', 'ses_target');
      let result = relay.destroyRelay('ses_source', 'ses_target');
      assert.equal(result, true);
    });

    it('returns false when relay did not exist', () => {
      let result = relay.destroyRelay('ses_source', 'ses_target');
      assert.equal(result, false);
    });
  });

  // ---------------------------------------------------------------------------
  // Multiple simultaneous relays
  // ---------------------------------------------------------------------------

  describe('multiple relays', () => {
    it('supports multiple relays from different source sessions', () => {
      let captured = [];
      relay.on('relay:delta', (event) => captured.push(event));

      relay.createRelay('ses_a', 'ses_target');
      relay.createRelay('ses_b', 'ses_target');

      interactionLoop.emit('delta', {
        sessionID:     'ses_target',
        interactionID: 'int_1',
        content:       { text: 'shared' },
      });

      assert.equal(captured.length, 2);
      assert.equal(captured[0].sourceSessionID, 'ses_a');
      assert.equal(captured[1].sourceSessionID, 'ses_b');
    });

    it('supports multiple relays to different target sessions', () => {
      let captured = [];
      relay.on('relay:delta', (event) => captured.push(event));

      relay.createRelay('ses_source', 'ses_target_1');
      relay.createRelay('ses_source', 'ses_target_2');

      interactionLoop.emit('delta', {
        sessionID:     'ses_target_1',
        interactionID: 'int_1',
        content:       { text: 'for target 1' },
      });

      assert.equal(captured.length, 1);
      assert.equal(captured[0].targetSessionID, 'ses_target_1');

      interactionLoop.emit('delta', {
        sessionID:     'ses_target_2',
        interactionID: 'int_2',
        content:       { text: 'for target 2' },
      });

      assert.equal(captured.length, 2);
      assert.equal(captured[1].targetSessionID, 'ses_target_2');
    });

    it('auto-destroy only removes the matching relay', () => {
      relay.createRelay('ses_a', 'ses_target');
      relay.createRelay('ses_b', 'ses_target');

      assert.equal(relay.getRelayCount(), 2);

      // This should destroy both relays to ses_target since they both listen
      // for interaction:end from ses_target
      interactionLoop.emit('interaction:end', { sessionID: 'ses_target', interactionID: 'int_1' });

      assert.equal(relay.getRelayCount(), 0);
    });
  });

  // ---------------------------------------------------------------------------
  // destroyAll
  // ---------------------------------------------------------------------------

  describe('destroyAll', () => {
    it('removes all relays', () => {
      relay.createRelay('ses_a', 'ses_target_1');
      relay.createRelay('ses_b', 'ses_target_2');
      assert.equal(relay.getRelayCount(), 2);

      relay.destroyAll();
      assert.equal(relay.getRelayCount(), 0);
    });

    it('stops all forwarding after destroyAll', () => {
      let captured = [];
      relay.on('relay:delta', (event) => captured.push(event));

      relay.createRelay('ses_a', 'ses_target');
      relay.destroyAll();

      interactionLoop.emit('delta', {
        sessionID:     'ses_target',
        interactionID: 'int_1',
        content:       { text: 'nope' },
      });

      assert.equal(captured.length, 0);
    });
  });

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  describe('queries', () => {
    it('hasRelay returns true when relay exists', () => {
      relay.createRelay('ses_a', 'ses_b');
      assert.ok(relay.hasRelay('ses_a', 'ses_b'));
    });

    it('hasRelay returns false when relay does not exist', () => {
      assert.ok(!relay.hasRelay('ses_a', 'ses_b'));
    });

    it('getRelayCount returns correct count', () => {
      assert.equal(relay.getRelayCount(), 0);
      relay.createRelay('ses_a', 'ses_b');
      assert.equal(relay.getRelayCount(), 1);
      relay.createRelay('ses_c', 'ses_d');
      assert.equal(relay.getRelayCount(), 2);
    });
  });
});
