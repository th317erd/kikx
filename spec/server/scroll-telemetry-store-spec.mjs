'use strict';

// =============================================================================
// Scroll telemetry store — the live event ring the agent analyzes (owner ask)
// =============================================================================
// "Why don't we have a websocket setup that we can stream to the server?" —
// chosen shape: the client BATCHES events over authenticated POST, the server
// keeps a bounded ring, and the agent subscribes to an SSE tail. Same real-time
// effect, zero new dependencies, existing auth reused; a true WebSocket can
// replace the transport later without changing this contract.
//
// Rules pinned here: monotonic seq, bounded ring (a diagnostic must never grow
// unbounded), hostile/partial events dropped rather than throwing, per-event
// listener fanout with unsubscribe, and a since() backfill bounded per call.

import assert from 'node:assert/strict';
import test from 'node:test';

import { createScrollTelemetryStore } from '../../src/server/scroll-telemetry-store.mjs';

test('record assigns monotonic seq and reports the accepted range', () => {
  const store = createScrollTelemetryStore({ capacity: 10 });
  const result = store.record([
    { type: 'focal', t: 100, id: 'f_1', off: -4, y: 9000 },
    { type: 'pageload', t: 140, pageIndex: 47 },
  ]);
  assert.equal(result.accepted, 2);
  assert.equal(result.first, 1);
  assert.equal(result.last, 2);
  assert.equal(store.latest(), 2);

  const next = store.record([ { type: 'shift', t: 200, value: 0.31 } ]);
  assert.equal(next.first, 3, 'seq continues across batches');
});

test('since() backfills in order and never exceeds the per-call bound', () => {
  const store = createScrollTelemetryStore({ capacity: 50, maxBatch: 5 });
  store.record(Array.from({ length: 12 }, (_v, i) => ({ type: 'focal', t: i })));
  const tail = store.since(0);
  assert.ok(tail.length <= 5, 'a backfill is bounded — an old client cannot dump the ring');
  assert.deepEqual(tail.map((e) => e.seq), [ 8, 9, 10, 11, 12 ], 'the newest end wins');
  assert.deepEqual(store.since(12), [], 'since latest yields nothing');
  assert.deepEqual(store.since(10).map((e) => e.seq), [ 11, 12 ]);
});

test('the ring is bounded: oldest events fall off, seq still climbs', () => {
  const store = createScrollTelemetryStore({ capacity: 5 });
  store.record(Array.from({ length: 10 }, (_v, i) => ({ type: 'focal', t: i })));
  const kept = store.since(0);
  assert.equal(kept.length, 5, 'capacity enforced');
  assert.deepEqual(kept.map((e) => e.t), [ 5, 6, 7, 8, 9 ], 'oldest dropped first');
  assert.equal(store.latest(), 10, 'seq reflects everything seen, not just what is kept');
});

test('invalid or oversized events are dropped, never thrown', () => {
  const store = createScrollTelemetryStore({ capacity: 10 });
  const result = store.record([
    null,
    'string',
    { t: 1 },                                  // no type
    { type: '', t: 1 },                        // empty type
    { type: 'x'.repeat(64), t: 1 },            // absurd type
    { type: 'focal', t: Number.NaN },          // non-finite t
    { type: 'focal', t: 1, pad: 'y'.repeat(9000) }, // oversized payload
    { type: 'ok', t: 5 },
  ]);
  assert.equal(result.accepted, 1, 'exactly the one well-formed event');
  assert.ok(result.dropped >= 7, `everything else counted as dropped, got ${result.dropped}`);
  assert.equal(store.since(0).length, 1);
});

test('subscribers see live events and unsubscribe cleanly', () => {
  const store = createScrollTelemetryStore({ capacity: 10 });
  const seenA = [];
  const seenB = [];
  const unsubA = store.subscribe((event) => seenA.push(event.seq));
  store.subscribe((event) => seenB.push(event.seq));

  store.record([ { type: 'a', t: 1 }, { type: 'b', t: 2 } ]);
  unsubA();
  store.record([ { type: 'c', t: 3 } ]);

  assert.deepEqual(seenA, [ 1, 2 ], 'the unsubscribed listener stops receiving');
  assert.deepEqual(seenB, [ 1, 2, 3 ], 'the remaining listener keeps streaming');
});
