'use strict';

// S3: a streaming burst must not become a DOM rebuild storm. These specs drive
// the coalesced sync paths and assert, via the render counters, that a burst of
// runtime updates produces a bounded number of full rebuilds while the final
// content and element identity stay correct.
//
// Before the S3 change these fail: `syncSessionShell` called `grid.update()` (a
// full grid + card rebuild) once per `session.saved`, and the render counters
// did not exist at all.

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

import { installDom } from './support/mini-dom.mjs';

register(new URL('./support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);

const { document, registry: customElements } = installDom();

// A recording card stub so the grid specs observe reconciliation without the
// heavy real card/chat-view renderer.
let cardUpdates = 0;
class StubCard extends HTMLElement {
  constructor() {
    super();
    this._session = null;
  }

  update(input) {
    cardUpdates += 1;
    if (input?.session)
      this._session = input.session;
  }

  get sessionID() {
    return this._session?.id || '';
  }
}
customElements.define('kikx-session-card', StubCard);

await import('../../src/client/components/kikx-frame-item.mjs');
await import('../../src/client/components/kikx-chat-view.mjs');
await import('../../src/client/components/kikx-session-grid.mjs');
const { syncSessionShell } = await import('../../src/client/components/kikx-frame-scroll.mjs');
const { snapshotRenderStats } = await import('../../src/client/components/render-stats.mjs');
const { onRuntimeEvent } = await import('../../src/client/components/kikx-runtime-events.mjs');
const { setAnimationFrameScheduler } = await import('../../src/client/components/kikx-app-helpers.mjs');
const { createSessionStateSnapshot } = await import('../../src/client/state/session-state-utils.mjs');

// Deterministic frames. The grid repaint, the runtime-event drain, and the
// reconcile pass are all deferred through `scheduleAnimationFrame`; in Node that
// defaults to a real setTimeout(0), which can fire between a spec's own awaits
// and is the timing dependency that made the identity assertions flaky under
// load. Route every deferred frame through a queue the spec flushes by hand, so
// an assertion can never interleave with a real timer. Production (browser)
// scheduling is untouched -- no scheduler is installed outside this spec.
let scheduledFrames = [];
setAnimationFrameScheduler((callback) => {
  scheduledFrames.push(callback);
  return scheduledFrames.length;
});

test.after(() => {
  scheduledFrames = [];
  setAnimationFrameScheduler(null);
});

function flushAnimationFrames() {
  let callbacks = scheduledFrames;
  scheduledFrames = [];
  for (let callback of callbacks)
    callback();
}

// Element identity is the contract ("existing cards are reused"); structural
// deep-equality of live DOM nodes is not, and is both slower and more fragile
// than comparing the node references and their order.
function assertCardsReused(grid, cards, message) {
  let current = [ ...grid.querySelectorAll('kikx-session-card') ];
  assert.equal(current.length, cards.length, `${message} (length)`);
  for (let index = 0; index < cards.length; index += 1)
    assert.strictEqual(current[index], cards[index], `${message} (index ${index})`);
}

function gridState() {
  let state = createSessionStateSnapshot({
    sessionIDs: [ 's1', 's2', 's3' ],
    sessionDetailsByID: {
      s1: { id: 's1', title: 'One' },
      s2: { id: 's2', title: 'Two' },
      s3: { id: 's3', title: 'Three' },
    },
    framesBySessionID: { s1: [], s2: [], s3: [] },
    sessionPagingByID: {},
  });
  state.selectedSessionID = '';
  state.navigationStack = [ { sessionID: null, collapsed: true } ];
  return state;
}

// A fake app whose querySelector only answers for the session grid, plus a real
// syncSessionShell bound to it. This exercises the exact production sync path
// without the full app shell (the spec DOM has no bindState).
function createGridApp(state = gridState()) {
  let grid = document.createElement('kikx-session-grid');
  let app = {
    _state: state,
    _selectedSession: () => null,
    _requestRender() {},
    querySelector: (selector) => (selector === 'kikx-session-grid' ? grid : null),
    grid,
  };
  app._syncSessionShell = () => syncSessionShell(app);
  grid.update({
    allSessions: [ ...state.sessionIDs ].map((id) => state.sessionDetailsByID[id]),
    parentSessionID: null,
    previews: new Map(),
    appState: state,
    selectedSessionID: '',
  });
  return app;
}

function sessionSaved(session) {
  return { type: 'message', data: JSON.stringify({ type: 'session.saved', session }) };
}

test('a burst of session saves repaints the grid once, not once per save', () => {
  cardUpdates = 0;
  let app = createGridApp();
  // Snapshot AFTER the initial render so the baseline includes it; the spec
  // measures deltas and never resets global counters another spec might read.
  let statsBefore = snapshotRenderStats();
  let cards = [ ...app.grid.querySelectorAll('kikx-session-card') ];
  assert.equal(cards.length, 3, 'the initial grid must have one card per session');
  cardUpdates = 0;

  for (let index = 0; index < 300; index += 1) {
    onRuntimeEvent(app, sessionSaved({ id: 's1', title: `Streaming ${index}`, updatedAt: index }));
  }

  // Reconciliation is synchronous, so identity is already stable even though the
  // repaint is deferred to the next animation frame.
  assertCardsReused(app.grid, cards, 'existing cards are reused');
  assert.equal(snapshotRenderStats().grid - statsBefore.grid, 0, 'a session.saved burst must not fully rebuild the grid');

  flushAnimationFrames();

  assert.equal(snapshotRenderStats().grid - statsBefore.grid, 0, 'still no full grid rebuild after the paint');
  assert.ok(cardUpdates <= cards.length, `at most one repaint of each card per frame (saw ${cardUpdates})`);
});

test('a burst across many sessions does not rebuild the selected grid more than once', () => {
  cardUpdates = 0;
  let app = createGridApp();
  let statsBefore = snapshotRenderStats();
  let cards = [ ...app.grid.querySelectorAll('kikx-session-card') ];
  cardUpdates = 0;

  let sessionIDs = [ 's1', 's2', 's3' ];
  for (let index = 0; index < 400; index += 1) {
    let id = sessionIDs[index % sessionIDs.length];
    onRuntimeEvent(app, sessionSaved({ id, title: `${id} ${index}`, updatedAt: index }));
  }

  assertCardsReused(app.grid, cards, 'card identity survives cross-session churn');
  assert.equal(snapshotRenderStats().grid - statsBefore.grid, 0, 'cross-session saves must not rebuild the grid');

  flushAnimationFrames();
  assert.ok(cardUpdates <= cards.length, `one repaint per frame across all sessions (saw ${cardUpdates})`);
});

test('session.saved while the title editor is open does not rebuild the shell', () => {
  let state = gridState();
  let titleInput = document.createElement('input');
  titleInput.className = 'kikx-window__title-input';
  let requested = 0;
  let app = {
    _state: state,
    isConnected: true,
    _selectedSession: () => null,
    querySelector: (selector) => (selector.includes('kikx-window__title-input') ? titleInput : null),
    _requestRender() {
      requested += 1;
    },
  };
  app._syncSessionShell = () => syncSessionShell(app);

  for (let index = 0; index < 50; index += 1)
    onRuntimeEvent(app, sessionSaved({ id: state.selectedSessionID || 's1', title: `Renamed ${index}` }));

  assert.equal(requested, 0, 'a streaming save must not tear the shell down under an open title editor');
});

test('streaming into one long message updates it in place with no full rebuild', () => {
  let view = document.createElement('kikx-chat-view');
  let state = {};
  view.update({
    frames: [ { id: 'm1', type: 'AgentMessageDelta', content: { text: '0' } } ],
    appState: state,
  });

  let item = view.querySelector('kikx-frame-item[data-frame-id="m1"]');
  let stream = item.querySelector('.kikx-frame__content.kikx-frame__stream');
  assert.ok(item && stream, 'the initial message must render an item and stream container');
  let statsBefore = snapshotRenderStats();
  let touched = new Set([ 'm1' ]);

  for (let index = 1; index <= 300; index += 1) {
    view.syncFrames(
      [ { id: 'm1', type: 'AgentMessageDelta', content: { text: String(index) } } ],
      state,
      { touchedFrameIDs: touched },
    );
  }

  assert.equal(snapshotRenderStats().chatView - statsBefore.chatView, 0, 'no full chat-view rebuild while streaming');
  assert.equal(snapshotRenderStats().frameItem - statsBefore.frameItem, 0, 'the item is reconciled, not rebuilt');
  assert.equal(view.querySelector('kikx-frame-item[data-frame-id="m1"]'), item, 'item element identity preserved');
  assert.equal(item.querySelector('.kikx-frame__content.kikx-frame__stream'), stream, 'stream container identity preserved');
  assert.equal(stream.textContent, '300', 'the final streamed content is correct');
});
