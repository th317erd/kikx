'use strict';

// S2 (client half) / G22: add-only client structures must be bounded. These
// specs pin a cap (or an explicit prune) on the module-level loaded-module set,
// the per-session frame/paging caches, the preview cache, and the composer
// history, and prove that eviction never drops the session the user is reading.

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

import { installDom } from './support/mini-dom.mjs';

register(new URL('./support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);

installDom();

const {
  MAX_CACHED_SESSION_FRAME_SETS,
  MAX_SESSION_PREVIEWS,
  boundSessionFrameCaches,
  boundSessionPreviews,
  createSessionStateSnapshot,
} = await import('../../src/client/state/session-state-utils.mjs');
const {
  MAX_COMPOSER_HISTORY_ENTRIES,
  createComposerHistoryState,
  recordComposerHistoryEntry,
} = await import('../../src/client/components/composer-history.mjs');
const {
  MAX_LOADED_MODULE_URLS,
  loadedModuleURLCount,
  recordLoadedModuleURL,
} = await import('../../src/client/components/frame-component-registry.mjs');
const { setSessionFrames, setSessionPreviews } = await import('../../src/client/state/kikx-state.mjs');

function frame(id) {
  return { id, type: 'UserMessage', content: { text: id } };
}

test('per-session frame caches are bounded and the selected session is never evicted', () => {
  let framesBySessionID = {};
  let sessionPagingByID = {};
  for (let index = 0; index < MAX_CACHED_SESSION_FRAME_SETS + 20; index += 1) {
    framesBySessionID[`s${index}`] = [ frame(`m${index}`) ];
    sessionPagingByID[`s${index}`] = { hasMoreOlder: false, hasMoreNewer: false };
  }

  let bounded = boundSessionFrameCaches(framesBySessionID, sessionPagingByID, 's0');

  assert.equal(Object.keys(bounded.framesBySessionID).length, MAX_CACHED_SESSION_FRAME_SETS);
  assert.ok(Object.hasOwn(bounded.framesBySessionID, 's0'), 'the session in view is kept');
  assert.deepEqual(
    Object.keys(bounded.sessionPagingByID).sort(),
    Object.keys(bounded.framesBySessionID).sort(),
    'paging is kept only for cached sessions',
  );
});

test('per-session previews are pruned to the live session list and capped', () => {
  let previewsByID = {};
  for (let index = 0; index < MAX_SESSION_PREVIEWS + 15; index += 1)
    previewsByID[`s${index}`] = { sessionID: `s${index}` };
  previewsByID.deleted = { sessionID: 'deleted' };

  let live = [];
  for (let index = 0; index < MAX_SESSION_PREVIEWS + 15; index += 1)
    live.push(`s${index}`);

  let bounded = boundSessionPreviews(previewsByID, live);

  assert.equal(Object.keys(bounded).length, MAX_SESSION_PREVIEWS);
  assert.ok(!Object.hasOwn(bounded, 'deleted'), 'a deleted session loses its derived preview');
});

test('kikx-state applies the frame-cache bound as snapshots are applied', () => {
  let state = createSessionStateSnapshot();
  state.selectedSessionID = 's0';

  for (let index = 0; index < MAX_CACHED_SESSION_FRAME_SETS + 20; index += 1)
    setSessionFrames(`s${index}`, [ frame(`m${index}`) ], state);

  assert.ok(Object.keys(state.framesBySessionID).length <= MAX_CACHED_SESSION_FRAME_SETS);
  assert.ok(Object.hasOwn(state.framesBySessionID, 's0'), 'the selected session survives streaming churn');
});

// P3-b: the frame cache is not a true LRU (only the selected session is
// promoted), so a session can be evicted even though the user opened it earlier.
// Re-selecting it must re-populate cleanly from the re-fetched window rather than
// serving a partial or stale cache entry.
test('a re-selected session whose frames were evicted re-fetches correctly', () => {
  let state = createSessionStateSnapshot();
  state.selectedSessionID = 's0';

  for (let index = 0; index < MAX_CACHED_SESSION_FRAME_SETS + 20; index += 1)
    setSessionFrames(`s${index}`, [ frame(`m${index}`) ], state);

  assert.ok(!Object.hasOwn(state.framesBySessionID, 's1'), 'the old non-selected window was evicted');

  state.selectedSessionID = 's1';
  setSessionFrames('s1', [ frame('m1'), frame('m2') ], state);

  assert.ok(Object.hasOwn(state.framesBySessionID, 's1'), 'the re-selected session is cached again');
  assert.deepEqual(
    state.framesBySessionID.s1.map((message) => message.id),
    [ 'm1', 'm2' ],
    'the re-fetched window is served whole, not partially reconstructed',
  );
});

test('kikx-state prunes previews for sessions that are no longer listed', () => {
  let state = createSessionStateSnapshot({
    sessionIDs: [ 's1' ],
    sessionDetailsByID: { s1: { id: 's1' } },
  });

  setSessionPreviews([
    { sessionID: 's1', session: { id: 's1' } },
    { sessionID: 'gone', session: { id: 'gone' } },
  ], state);

  assert.deepEqual(Object.keys(state.sessionPreviewsByID), [ 's1' ]);
});

test('composer history stays bounded', () => {
  let history = createComposerHistoryState();
  for (let index = 0; index < MAX_COMPOSER_HISTORY_ENTRIES + 20; index += 1)
    recordComposerHistoryEntry(history, `message ${index}`);

  assert.equal(history.entries.length, MAX_COMPOSER_HISTORY_ENTRIES);
  assert.equal(history.entries[history.entries.length - 1], `message ${MAX_COMPOSER_HISTORY_ENTRIES + 19}`);
});

test('loaded component module URLs are bounded', () => {
  for (let index = 0; index < MAX_LOADED_MODULE_URLS + 20; index += 1)
    recordLoadedModuleURL(`/client/components/component-${index}.mjs`);

  assert.ok(loadedModuleURLCount() <= MAX_LOADED_MODULE_URLS);
});
