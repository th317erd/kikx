'use strict';

// Sidebar session objects (owner points 2, 5 and 6).
//
// The owner's claim, in their words: User / Account / Agents / Teams / Sign out
// "really are and always were meant to be session objects", so they belong in
// "our session tree overview pane" -- the `section.kikx-sessions` block built by
// buildRunnerShell (kikx-shell-builders.mjs:252-268).
//
// Point 5 says every sidebar item is a view into a DESCENDANT of the session
// tree, except the user account. Point 6 says ownership trickles down. Those two
// points are why this module is DATA FIRST: `buildSessionObjectItems` returns a
// plain array of descriptors, each carrying the session it is scoped to, and the
// renderer is a dumb projection of that array. Prong B can therefore filter the
// array (via its `filterSessionsInScope`, src/client/state/session-scope.mjs)
// without this file being rewritten, and without a second answer to "what is in
// scope" appearing here.
//
// This module deliberately does NOT import a scope predicate and does NOT
// re-derive one. It accepts an optional `scopeFilter` seam whose default is
// "show everything": with no filter supplied every item renders, exactly as
// today. Wiring a real filter is Prong B's change, made by passing one in.

import { elements } from '../lib/aeor-ui.mjs';
import { guardClientOperation } from '../lib/error-boundary.mjs';

const { div, span, button } = elements;

// `scopeSessionID === null` means "not scoped to a session" -- the user account
// is the one item owner point 5 exempts. Everything else is scoped to the session
// the sidebar is currently showing, which is what makes point 6 (trickle-down)
// expressible: an item created at session S is visible at S and below, never
// above.
export function buildSessionObjectItems(app) {
  let scopeSessionID = app?._state
    ? (app._state.navigationStack?.at(-1)?.sessionID || null)
    : null;

  return [
    {
      id: 'account-chip',
      kind: 'chip',
      label: app?._state?.account?.name || 'User',
      // The account itself is global, by owner point 5's explicit carve-out.
      scopeSessionID: null,
      onSelect: null,
    },
    {
      id: 'account',
      kind: 'button',
      label: 'Account',
      scopeSessionID,
      onSelect: () => app._openAccountEditor(),
    },
    {
      id: 'agents',
      kind: 'button',
      label: 'Agents',
      scopeSessionID,
      onSelect: () => app._openAgentManager(),
    },
    {
      id: 'teams',
      kind: 'button',
      label: 'Teams',
      scopeSessionID,
      onSelect: () => app._openTeamManager(),
    },
    {
      id: 'sign-out',
      kind: 'button',
      label: 'Sign out',
      scopeSessionID,
      onSelect: () => app._signOut(),
    },
  ];
}

// The only supported way to change what the sidebar shows. Identity by default,
// so shipped behaviour is "show everything" until Prong B supplies a predicate.
// `scopeSessionID` is passed as the second argument so a caller can be
// `(item, sessionID) => isSessionInScope(...)` without reshaping the data.
export function filterSessionObjectItems(items, scopeFilter = null, appState = null) {
  if (typeof scopeFilter !== 'function')
    return [...items];

  return items.filter((item) => scopeFilter(item, item.scopeSessionID, appState));
}

// Renders the cluster under a single class, `kikx-session-objects`, which owns
// the sidebar layout in src/client/styles/topbar-unified.css.
//
// History worth keeping: this cluster was born in the top bar and carried the
// legacy `kikx-topbar__actions` class so seven stagehand specs that select
// `.kikx-topbar__actions button` kept passing. That kept the specs green while
// lying about which bar owned the controls, and a future cleanup of the dead
// top-bar CSS would have silently broken them. The seven specs now select
// `kikx-session-objects` directly (coordinator option (ii)), so this is the only
// class name to honour.
//
// Button text is load-bearing: `clickButtonByText(page, 'Teams'|'Agents')`.
export function buildSidebarSessionObjects(app, { scopeFilter = null } = {}) {
  return guardClientOperation('kikx-sidebar.session-objects', () => {
    let items = filterSessionObjectItems(
      buildSessionObjectItems(app),
      scopeFilter,
      app?._state,
    );

    let children = items.map((item) => {
      if (item.kind === 'chip')
        return span.class('kikx-account-chip')(item.label);

      return button
        .type('button')
        .class('kikx-sign-out-button')
        .onClick(item.onSelect)(item.label);
    });

    return div.class('kikx-session-objects')(...children).build(document);
  }, { surface: 'sidebar' }) || div.class('kikx-session-objects')().build(document);
}
