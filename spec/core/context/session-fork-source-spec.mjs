'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_FORK_PARENT_FRAMES,
  resolveForkParentFrames,
} from '../../../src/core/context/session-fork-source.mjs';

function frame(id, sessionID = 'parent') {
  return { id, type: 'AgentMessage', sessionID, order: Number(id.replace(/\D/g, '')) || 1 };
}

test('the current session uses the live engine without probing the runtime', async () => {
  let live = [ frame('f1') ];
  let ensureCalls = 0;
  let runtime = {
    async ensureSessionEntry() {
      ensureCalls += 1;
      return null;
    },
    frameStore: { async listFrames() { throw new Error('must not read the store'); } },
  };

  let frames = await resolveForkParentFrames({
    runtime,
    sourceSession: { id: 'parent' },
    context: {
      session: { id: 'parent' },
      services: { frameEngine: { toArray: () => live } },
    },
  });

  assert.equal(frames, live);
  assert.equal(ensureCalls, 0);
});

test('a cached non-current source uses its loaded engine without hydrating it', async () => {
  let cached = [ frame('f1') ];
  let ensureCalls = [];
  let runtime = {
    async ensureSessionEntry(id, options) {
      ensureCalls.push({ id, options });
      return { framesLoaded: true, frameEngine: { toArray: () => cached } };
    },
    frameStore: { async listFrames() { throw new Error('must not read the store'); } },
  };

  let frames = await resolveForkParentFrames({
    runtime,
    sourceSession: { id: 'parent' },
    context: { session: { id: 'child' }, services: { frameEngine: { toArray: () => [] } } },
  });

  assert.equal(frames, cached);
  assert.deepEqual(ensureCalls, [ { id: 'parent', options: { loadFrames: false } } ]);
});

test('a cold non-current source pages the store instead of hydrating a runtime', async () => {
  let pages = [
    [ frame('f1'), frame('f2') ],
    [ frame('f3') ],
  ];
  let ensureCalls = [];
  let calls = [];
  let runtime = {
    async ensureSessionEntry(id, options) {
      ensureCalls.push({ id, options });
      return { framesLoaded: false, frameEngine: { toArray: () => [] } };
    },
    frameStore: {
      async listFrames(id, options) {
        calls.push({ id, options });
        return pages.shift() || [];
      },
    },
  };

  let frames = await resolveForkParentFrames({
    runtime,
    sourceSession: { id: 'parent' },
    context: { session: { id: 'child' } },
    pageSize: 2,
  });

  assert.deepEqual(frames.map((entry) => entry.id), [ 'f1', 'f2', 'f3' ]);
  assert.deepEqual(ensureCalls, [ { id: 'parent', options: { loadFrames: false } } ]);
  assert.deepEqual(calls.map((call) => call.options.offset), [ 0, 2 ]);
});

test('an oversized parent fails with an actionable freshContext message', async () => {
  let runtime = {
    async ensureSessionEntry() {
      return { framesLoaded: false, frameEngine: { toArray: () => [] } };
    },
    frameStore: {
      async listFrames(_id, options) {
        return Array.from({ length: options.limit }, (_, index) => frame(`f${options.offset + index + 1}`));
      },
    },
  };

  await assert.rejects(
    () => resolveForkParentFrames({
      runtime,
      sourceSession: { id: 'parent' },
      context: { session: { id: 'child' } },
      maxFrames: 3,
    }),
    /refuses to fork more than 3 parent frames.*freshContext:true/,
  );
  assert.equal(MAX_FORK_PARENT_FRAMES, 20000);
});
