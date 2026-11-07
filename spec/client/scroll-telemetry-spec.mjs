'use strict';

// =============================================================================
// Scroll telemetry client — batched, debug-gated, failure-silent (owner ask)
// =============================================================================
// The instrumented half (scrollTop traps, focal sampler, page-load snapshots,
// layout-shift observer) runs only in the browser; what is pinned here is the
// CONTRACT those instruments feed: record is a no-op unless active, batches
// flush once with a single authenticated POST, a failed flush RESTORES the
// buffer (diagnostics must not eat their own data on a blip), and maxBuffer
// forces a flush so a hot scroll storm still reaches the server in slices.

import assert from 'node:assert/strict';
import test from 'node:test';

import { createScrollTelemetry } from '../../src/client/lib/scroll-telemetry.mjs';

test('record is a no-op while inactive — no buffer growth, no traffic', async () => {
  const posts = [];
  const telem = createScrollTelemetry({ post: async (body) => { posts.push(body); } });
  assert.equal(telem.active, false, 'starts inactive');
  assert.equal(telem.record('focal', { id: 'f_1' }), false);
  assert.equal(telem.pending, 0);
  await telem.flushNow();
  assert.equal(posts.length, 0, 'an inactive telemetry never posts');
});

test('active: events buffer, flush posts one batch and clears', async () => {
  const posts = [];
  const telem = createScrollTelemetry({ post: async (body) => { posts.push(body); } });
  telem.setActive(true);
  telem.record('scrollwrite', { v: 100, s: 'at restoreFrameListAnchor' });
  telem.record('focal', { id: 'f_2', off: -12, y: 8000 });
  assert.equal(telem.pending, 2);

  const flushed = await telem.flushNow();
  assert.equal(flushed, 2);
  assert.equal(telem.pending, 0, 'the buffer is emptied after a flush');
  assert.equal(posts.length, 1, 'ONE post for the whole batch');
  assert.equal(posts[0].events.length, 2);
  assert.equal(posts[0].events[0].type, 'scrollwrite');
  assert.ok(Number.isFinite(posts[0].events[0].t), 'every event carries a client timestamp');

  await telem.flushNow();
  assert.equal(posts.length, 1, 'an empty buffer posts nothing');
});

test('a failed flush restores the buffer for the next attempt', async () => {
  let fail = true;
  const posts = [];
  const telem = createScrollTelemetry({
    post: async (body) => { if (fail) throw new Error('offline'); posts.push(body); },
  });
  telem.setActive(true);
  telem.record('pageload', { pageIndex: 47 });
  const failed = await telem.flushNow();
  assert.equal(failed, -1, 'a failed flush reports -1, not success');
  assert.equal(telem.pending, 1, 'events survive the failure');

  fail = false;
  const retried = await telem.flushNow();
  assert.equal(retried, 1, 'the same events flush on the next attempt');
  assert.equal(posts[0].events[0].pageIndex, 47);
});

test('maxBuffer forces a flush mid-storm, with a hard per-event size cut', async () => {
  const posts = [];
  const telem = createScrollTelemetry({ post: async (body) => { posts.push(body); }, maxBuffer: 3 });
  telem.setActive(true);
  telem.record('focal', { id: 'a' });
  telem.record('focal', { id: 'b' });
  assert.equal(posts.length, 0, 'under the cap nothing flushes yet');
  telem.record('focal', { id: 'c' });
  assert.equal(posts.length, 1, 'reaching maxBuffer flushes immediately');
  assert.equal(posts[0].events.length, 3);

  // A runaway instrument payload is trimmed, not shipped wholesale.
  telem.record('scrollwrite', { v: 1, s: 'x'.repeat(20000) });
  const flushed = await telem.flushNow();
  assert.equal(flushed, 1);
  assert.ok(JSON.stringify(posts[1]).length < 8192,
    `oversized event must be trimmed before POST, got ${JSON.stringify(posts[1]).length}B`);
});
