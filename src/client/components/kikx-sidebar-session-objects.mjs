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

// Owner item 2 (2026-10-27): "Agents and Teams should go up into the 'Session
// View' items." The five controls therefore split into two clusters:
//
//   'view'   -- Agents and Teams. They are views into the session tree, so they
//               sit with Workspace / Inbox / Activities, above the tree.
//   'footer' -- the account chip, Account and Sign out. They are identity, they
//               act on the whole scope rather than on one row, so they stay at
//               the foot behind `margin-top: auto`.
//
// `group` is presentation only. `id`, `label`, `kind`, `scopeSessionID` and
// `onSelect` are unchanged by this split: the label text is load-bearing
// (`clickButtonByText(page, 'Teams'|'Agents')` in seven stagehand specs) and the
// scope id is what Prong B's predicate consumes.
export const SESSION_OBJECT_GROUPS = Object.freeze(['view', 'footer']);

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
      group: 'footer',
      label: app?._state?.account?.name || 'User',
      // The account itself is global, by owner point 5's explicit carve-out.
      scopeSessionID: null,
      onSelect: null,
    },
    {
      id: 'account',
      kind: 'button',
      group: 'footer',
      label: 'Account',
      scopeSessionID,
      onSelect: () => app._openAccountEditor(),
    },
    {
      id: 'agents',
      kind: 'button',
      group: 'view',
      label: 'Agents',
      scopeSessionID,
      onSelect: () => app._openAgentManager(),
    },
    {
      id: 'teams',
      kind: 'button',
      group: 'view',
      label: 'Teams',
      scopeSessionID,
      onSelect: () => app._openTeamManager(),
    },
    {
      id: 'sign-out',
      kind: 'button',
      group: 'footer',
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

function itemsForGroup(items, group) {
  if (group === null || group === undefined)
    return [...items];

  return items.filter((item) => item.group === group);
}

// Owner item 1 (2026-10-27): "These two items should be grouped with, and have
// the same styling as, the 'Inbox' and 'Activities'... every item in this sidebar
// is a 'view' into the current session and its children."
//
// The defect this fixes: every non-chip descriptor rendered as
// `button.kikx-sign-out-button` -- the SAME class as the footer's Sign out. So
// Agents and Teams were wearing footer-identity styling while sitting in the
// view cluster, which is exactly why they read as misplaced controls rather than
// as views.
//
// View items now render the `kikx-sidebar__view` family, whose rule lives beside
// the Inbox/Activities rule in questions.css so all four are ONE rule rather than
// two copies of the same metrics that can drift apart. The label is wrapped in a
// span, as Inbox and Activities do, so it can ellipsise like they can -- and
// `button.textContent` still equals exactly `Agents` / `Teams`, which is what
// `clickButtonByText`'s `textContent.trim() === text` assertion needs (seven
// stagehand specs click these by text).
//
// The footer branch below is unchanged and still emits `kikx-sign-out-button`:
// Account and Sign out ARE bar-style controls, and that styling is correct there.
function renderItem(item) {
  if (item.kind === 'chip')
    return span.class('kikx-account-chip')(item.label);

  if (item.group === 'view')
    return button
      .type('button')
      .class('kikx-sidebar__view')
      .onClick(item.onSelect)(span.class('kikx-sidebar__view-label')(item.label));

  return button
    .type('button')
    .class('kikx-sign-out-button')
    .onClick(item.onSelect)(item.label);
}

// Renders one cluster under the class `kikx-session-objects`, which owns the
// sidebar layout in src/client/styles/topbar-unified.css.
//
// `group` selects which descriptors to render: 'view', 'footer', or omitted for
// all of them (the pre-split behaviour, so existing one-argument callers keep
// working).
//
// Both clusters carry `kikx-session-objects` on purpose. Seven stagehand specs
// select `.kikx-session-objects button` and then click by button text; they must
// keep matching after the split without being edited, so the layout difference
// rides on a modifier class (`kikx-session-objects--view` / `--footer`) instead
// of on a different base class.
//
// Both clusters also go through `filterSessionObjectItems` -- the scope seam is
// not bypassed for the new cluster, or Agents/Teams would leak past ownership
// filtering while Account did not.
//
// `kikx-session-objects` stays on BOTH clusters' containers, and the button text
// stays exactly the label. Both are load-bearing: seven stagehand specs select
// `.kikx-session-objects button` and then compare `textContent.trim()`.
//
// Button text is load-bearing: `clickButtonByText(page, 'Teams'|'Agents')`.
export function buildSidebarSessionObjects(app, { scopeFilter = null, group = null } = {}) {
  let modifier = (group === null || group === undefined) ? '' : ` kikx-session-objects--${group}`;
  let className = `kikx-session-objects${modifier}`;

  return guardClientOperation('kikx-sidebar.session-objects', () => {
    let items = itemsForGroup(
      filterSessionObjectItems(
        buildSessionObjectItems(app),
        scopeFilter,
        app?._state,
      ),
      group,
    );

    return div.class(className)(...items.map(renderItem)).build(document);
  }, { surface: 'sidebar' }) || div.class(className)().build(document);
}
