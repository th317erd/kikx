'use strict';

// =============================================================================
// A view is addressable by URL, not only by clicking (campaign P4)
// =============================================================================
// P4's remaining item is that a plugin view survives reload/removal without
// losing the user's state. "Survives a reload" is a URL contract, and it was
// broken in two independent places, both found by driving the real browser and
// both fixed here:
//
//   1. `stackFromSearchParams` validated `?view=` against `VIEW_NAMES`, the
//      frozen core literal (`inbox`/`agents`/`teams`). A plugin surface can never
//      be in that array, so every plugin view was unreachable by URL: the sidebar
//      could push `notes` onto the stack, but a reload or a shared link silently
//      dropped it. Every OTHER reader of the vocabulary (`normalizeNavigationStack`,
//      `pushView`, `isViewEntry`) already asked the live registry. The parse site
//      was the last holdout, which is exactly the "frozen literal drifts from the
//      registry" family this campaign keeps re-finding.
//
//   2. `stackFromCurrentURL` skipped any entry whose `sessionID` was not a known
//      session, and `break` discarded the rest of the tail. A view entry has
//      `sessionID: null` BY CONSTRUCTION, so this rejected every view entry --
//      `?view=inbox` included, which means the pinned Inbox deep link had been
//      dead in production, not just for plugins.
//
// These are plain-Node assertions on purpose: no DOM, no Chrome, no server. The
// browser spec (`plugin-view-focus-playwright.mjs`) proves the focus half; this
// one proves the addressability half, and keeps proving it when no browser is
// available.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  currentViewName,
  stackFromSearchParams,
  stackToURL,
} from '../../src/client/state/navigation-stack.mjs';
import {
  getRegisteredViewNames,
  registerViewNames,
  syncViewNames,
} from '../../src/client/state/view-name-registry.mjs';

// The render-on-ready test below dynamically imports kikx-navigation, which
// reaches aeor-ui (/vendor/*) — the same shim + mini-DOM bootstrap every other
// client spec uses. Registered here (module scope, before the test runs); the
// plain-Node URL tests above never touch it.
import { register } from 'node:module';
register(new URL('./support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);
const { installDom } = await import('./support/mini-dom.mjs');
installDom();

// The registry is module-level state (one writer: setClientComponents). Every
// test that touches it restores it, so test order cannot matter.
function withRegisteredViews(names, run) {
  syncViewNames(names);
  try {
    return run();
  } finally {
    syncViewNames(null);
  }
}

test('a plugin view name parses from ?view= once it is registered', () => {
  withRegisteredViews([ 'notes' ], () => {
    let parsed = stackFromSearchParams('?view=notes');

    assert.equal(parsed.view, 'notes', 'the parse must accept a registered plugin view');
    assert.equal(currentViewName(parsed.stack), 'notes');
  });
});

test('the same ?view= is refused before its descriptor is registered', () => {
  // Failing-first shape: this is what the frozen literal did to EVERY plugin view,
  // always. It must still be the answer for a name nobody registered -- otherwise
  // a stale bookmark would blank the work area.
  withRegisteredViews(null, () => {
    assert.equal(
      getRegisteredViewNames().includes('notes'),
      false,
      'precondition: notes is not registered',
    );

    let parsed = stackFromSearchParams('?view=notes');

    assert.equal(parsed.view, null);
    assert.equal(currentViewName(parsed.stack), null);
    assert.deepEqual(parsed.stack, [ { sessionID: null, collapsed: true } ]);
  });
});

test('core views still parse, and the removed activities view still degrades', () => {
  // The fix must not loosen the two existing guarantees: core names work, and a
  // name that was deliberately REMOVED stays unaddressable.
  withRegisteredViews([ 'notes' ], () => {
    assert.equal(stackFromSearchParams('?view=inbox').view, 'inbox');
    assert.equal(stackFromSearchParams('?view=activities').view, null,
      'a removed view must not come back just because the gate moved');
  });
});

test('registering a view makes an already-encoded URL round-trip', () => {
  // The end-to-end contract: encode a stack holding a plugin view, then parse it
  // back. Before the fix the encode side wrote `?view=notes` and the decode side
  // refused it, so the round-trip lost the view and reload landed on the grid.
  withRegisteredViews([ 'notes' ], () => {
    let stack = [
      { sessionID: null, collapsed: true },
      { sessionID: null, collapsed: true, view: 'notes' },
    ];

    let url = stackToURL(stack, { pathname: '/' });
    assert.match(url, /view=notes/);

    let search = url.slice(url.indexOf('?'));
    let parsed = stackFromSearchParams(search);

    assert.equal(currentViewName(parsed.stack), 'notes', 'the decoded stack must still hold the view');
    assert.deepEqual(parsed.stack, stack);
  });
});

test('unregistering a view makes its URL unaddressable again (the unload path)', () => {
  // Removal is the other half of P4: a view whose plugin is gone must not be
  // reachable, so the stack cannot hold a name nothing renders.
  let parsedWhileRegistered = withRegisteredViews([ 'notes' ], () => stackFromSearchParams('?view=notes'));
  assert.equal(parsedWhileRegistered.view, 'notes');

  let parsedAfterUnload = stackFromSearchParams('?view=notes');
  assert.equal(parsedAfterUnload.view, null, 'an unloaded view must not parse');
});

test('registerViewNames is the same writer as syncViewNames', () => {
  // Both names are exported and used by different callers; a second vocabulary
  // would reintroduce exactly the split this spec exists to prevent.
  registerViewNames([ 'notes' ]);
  try {
    assert.equal(stackFromSearchParams('?view=notes').view, 'notes');
  } finally {
    registerViewNames(null);
  }
});

test('applySessionDeepLink requests a RENDER when it flips _deepLinkReady (the loading screen must not strand)', async () => {
  // Product bug found by the stagehand triage (2026-11-14): the finally block
  // set _deepLinkReady = true with NO repaint, so "Loading page…" persisted
  // forever unless an unrelated event happened to repaint (lean fixtures
  // starved; fixtures with extra API chatter got lucky). The state flip and
  // the paint that shows it must be one step.
  const { applySessionDeepLink } = await import('../../src/client/components/kikx-navigation.mjs');

  const previousLocation = globalThis.location;
  globalThis.location = {
    href: 'http://kikx.test/?session=session_1',
    search: '?session=session_1',
    pathname: '/',
    hash: '',
    origin: 'http://kikx.test',
  };

  const renders = [];
  const app = {
    _state: {
      navigationStack: [ { sessionID: null, collapsed: true } ],
      sessions: [ { id: 'session_1', title: 'S' } ],
      sessionIDs: [ 'session_1' ],
      sessionDetailsByID: { session_1: { id: 'session_1', title: 'S' } },
      deletedSessionIDs: [],
      deletedSessionDetailsByID: {},
      sessionPreviews: {},
      frames: {},
      frameFilters: null,
      sessionSearch: '',
      account: { name: 'W' },
    },
    _loadFrames: async () => ({ frames: [] }),
    _render: () => renders.push('render'),
    _requestRender: (reason) => renders.push(String(reason || 'request')),
    _syncURLFromStack: () => {},
  };

  try {
    await applySessionDeepLink(app);
  } finally {
    if (previousLocation === undefined)
      delete globalThis.location;
    else
      globalThis.location = previousLocation;
  }

  assert.equal(app._deepLinkReady, true, 'the gate resolves');
  assert.ok(renders.length > 0,
    'and the shell repaints so the loading screen actually clears — ready-without-render is the strand bug');
});
