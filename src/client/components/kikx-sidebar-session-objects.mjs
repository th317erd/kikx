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
// renderer is a dumb projection of that array. It accepts an optional
// `scopeFilter` seam whose default is "show everything".
//
// CORRECTION (2026-10-30, HEAD ddfbc733). An earlier version of this comment
// said Prong B would filter the array "via its filterSessionsInScope". That was
// not what shipped. Correcting it is why the seam sat dead: `filterSessionObjectItems`
// short-circuits to grant-all when no filter is passed, so the whole scoping
// layer had zero production callers and nothing said so.
//
// WIRED NOW (2026-10-30). `buildRunnerShell` passes a REAL predicate
// (`sidebarScopePredicateFor`, below) for both clusters, so
// `createSessionScope` / `filterItemsInScope` / `filterSessionsInScope` are all
// reached from a production entry point. See `spec/client/sidebar-shell-scope-spec.mjs`,
// which drives `buildRunnerShell` itself -- not this module in isolation, which
// is the mistake that hid the dead seam.
//
// WHAT THE WIRING CAN AND CANNOT DO. With the descriptors as they are, every
// non-chip row carries the VIEWED session's own id (or none at the project
// root), so a correct predicate grants them and the sidebar looks identical to
// the unfiltered one. That is the EXPECTED result, not a failed filter: the spec
// therefore asserts the predicate's decisions and its reachability, and
// deliberately does not claim a visible change. The wiring becomes visible the
// moment a row owned by a DIFFERENT session is rendered here, which the spec
// pins directly by feeding a foreign row through the same seam.
//
// The descriptor field is `scopeSessionID`, and `sessionIDOf` in
// src/client/state/session-scope.mjs must keep reading it —
// spec/ownership/sidebar-scope-field-spec.mjs pins that boundary and fails if
// either side renames.

import { elements } from '../lib/aeor-ui.mjs';
import { guardClientOperation } from '../lib/error-boundary.mjs';
import { getScopeSessionID, isViewOpen } from '../state/kikx-state.mjs';
import { createSessionScope, sessionIDOf } from '../state/session-scope.mjs';

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
  let scopeSessionID = app?._state ? getScopeSessionID(app._state) : null;

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
      active: isViewOpen('agents', app?._state),
      onSelect: () => app._openAgentManager(),
    },
    {
      id: 'teams',
      kind: 'button',
      group: 'view',
      label: 'Teams',
      scopeSessionID,
      active: isViewOpen('teams', app?._state),
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

  return items.filter((item) => {
    let verdict = scopeFilter(item, item.scopeSessionID, appState);

    // The predicate must ANSWER. Two plausible-looking wrong pairings used to
    // pass silently in opposite directions, and both were measured against the
    // real sidebar descriptors:
    //
    //   (items, scope.filter)  -> [] is truthy, so ALL FIVE were kept  (leak)
    //   (items, scope.owns)    -> owns(item) reads the item as a session id,
    //                             so NONE were kept                    (blank)
    //
    // A non-boolean is never a deliberate answer here, so it is a programming
    // error and it is raised rather than guessed at. Use
    // `createSessionScope(v).predicate`, which is shaped for this seam.
    if (typeof verdict !== 'boolean') {
      throw new TypeError(
        `filterSessionObjectItems: the scope predicate returned ` +
        `${typeof verdict} for item "${item?.id}". ` +
        `Expected a boolean. Pass createSessionScope(viewer).predicate, not ` +
        `scope.filter (a collection filter) or scope.owns (takes a session id).`,
      );
    }

    return verdict;
  });
}

// The scope predicate the shell actually passes, in ONE place so the shell and
// its spec cannot disagree about it. A spec that re-implemented this filter
// would pass while the shell stayed broken -- precisely how the dead seam
// survived.
//
// Two traps, both measured, both of which a plausible-looking wiring gets wrong:
//
//   1. GRANT BY ITEM IDENTITY, NOT BY NULL. `scopeSessionID === null` means two
//      unrelated things: the global account chip (owner point 5's carve-out) and
//      "project root, no session selected". Granting on null would hide that the
//      chip is a deliberate global exception; denying on null would hide the chip
//      altogether. Neither is right, so the one genuinely global row is named.
//   2. ROOT MUST GRANT. At the project root there is no viewer session id, so
//      `createSessionScope(null)` returns an EMPTY owner set (measured: owners=[],
//      owns(undefined)=false) and every row would be dropped -- a blank sidebar.
//      Root is not outside the tree; it owns everything below it, so it grants.
//
// A viewer that DOES have an id is filtered for real: a row owned by a session
// the viewer cannot see is denied. That is the behaviour this wiring exists to
// provide, and it is what makes the seam more than a no-op.
export const GLOBAL_SESSION_OBJECT_IDS = Object.freeze([ 'account-chip' ]);

export function sidebarScopePredicateFor(viewerSessionID, sessions = []) {
  let scope = createSessionScope(viewerSessionID, sessions);

  return (item, scopeSessionID) => {
    // Trap 1: the global carve-out, by identity. The chip has no owner to scope.
    if (item && GLOBAL_SESSION_OBJECT_IDS.includes(item.id))
      return true;

    // Trap 2: root genuinely owns everything below it.
    if (!scope.viewerSessionID)
      return true;

    // A row with no owner id at all is unscoped. At root it was granted above;
    // anywhere else an ownerless row is not demonstrably this viewer's, so it
    // fails closed rather than leaking.
    let owner = scopeSessionID === undefined ? sessionIDOf(item) : scopeSessionID;
    return owner ? scope.owns(owner) : false;
  };
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
      .class(`kikx-sidebar__view${item.active ? ' kikx-sidebar__view--active' : ''}`)
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
