'use strict';

// Session-scope ownership rules — CLIENT SURFACE.
//
// The rule and the walk live in ONE place now:
//   src/shared/session-ancestry.mjs
// and this file is the thin client-facing surface over it. It existed as an
// independent copy until the two copies (`this file` and
// src/core/ownership/session-ownership.mjs) were found to have already
// diverged in two behaviours while sharing line numbers and signatures. A
// suite that tests each copy in isolation cannot detect that, so the copy is
// gone: both surfaces re-export the shared walk, and
// spec/ownership/session-ancestry-parity-spec.mjs fails if they ever disagree
// on the same tree.
//
// THE RULE, from the owner ("everything is a view into that descendant of the
// session tree"; only the user account is global):
//
//     an item owned by session O is visible to viewer session V
//         iff  O === V  or  O is an ancestor of V
//
//    visible-to-V  =  items owned by  { V } union ancestors(V)
//
// Read the same relation from the other side and you get:
//
//     who can see what V owns?   ==>   { V } union descendants(V)
//
// Both are the same relation, "is ancestor-or-self". They are NOT the same
// set, and substituting one for the other looks correct in a two-session test
// and is wrong everywhere else. This surface names them separately and never
// offers an ambiguous "inScope(a, b)":
//
//   isAncestorOrSelf(ancestor, descendant)   the one primitive
//   isSessionVisibleTo(viewer, owner)        R(owner, viewer) -- the upward view
//   isVisibleTo / isOwnedBy(viewer, owner)   the same call, spoken as callers ask
//   visibleOwnersFor(viewer)                 { V } + ancestors
//   resolveScopeSessionIDs(viewer)           { V } + descendants (downward view)
//
// Pure on purpose: no I/O, no DOM, no framework. It re-exports from src/shared,
// which the server serves to the browser (src/server/static-files.mjs:75-77),
// so this remains loadable client-side and never reaches into src/core.
//
// WHERE THE RULE IS ACTUALLY ENFORCED TODAY (measured at HEAD ddfbc733, so this
// file does not repeat a claim it cannot back):
//
//   kikx-agent-team-views.mjs:30-43  scopedAgents / scopedTeams filter the
//                                    global catalogue through
//                                    getEffectiveSessionAgentIDs. This is the
//                                    live path, and it does NOT come through
//                                    this module.
//   kikx-sidebar-session-objects.mjs the five sidebar controls (Account,
//                                    Agents, Teams, Sign out, account chip).
//                                    Four carry the VIEWED session's id and one
//                                    carries null, so owner === viewer for all
//                                    five by construction. A scope predicate
//                                    can only ever pass them; the `scopeFilter`
//                                    argument there is scaffolding with no
//                                    owner to discriminate.
//
// So this module is a CONTRACT plus reusable primitives, not the code path the
// UI currently renders through. An earlier comment in
// kikx-sidebar-session-objects.mjs claimed Prong B would filter the sidebar
// "via its filterSessionsInScope"; that is not what shipped and the comment has
// been corrected. Do not describe this module as wired.

import {
  SESSION_SCOPE_POLICY,
  ancestryChain,
  descendantSessionIDs,
  isAncestorOrSelf,
  isOwnedBy,
  isSessionVisibleTo,
  isVisibleTo,
  normalizeSessionID,
  sessionParentID,
  visibleOwnerIDs,
} from '../../shared/session-ancestry.mjs';

// ---------------------------------------------------------------------------
// The shared walk, re-exported verbatim
// ---------------------------------------------------------------------------

export {
  isAncestorOrSelf,
  isSessionVisibleTo,
  isVisibleTo,
  isOwnedBy,
  normalizeSessionID,
  sessionParentID,
};

/**
 * The single policy switch. Same frozen object the core surface exports as
 * OWNERSHIP_POLICY — one switch, not two that can be flipped independently.
 */
export const SCOPE_POLICY = SESSION_SCOPE_POLICY;

/** The viewer's ancestry chain including itself, nearest last: { V } + ancestors. */
export function visibleOwnersFor(viewerSessionID, allSessions = []) {
  return ancestryChain(viewerSessionID, allSessions);
}

/** The owners whose items the viewer may see, governed by SCOPE_POLICY. */
export function visibleOwnerIDsFor(viewerSessionID, sessions = []) {
  return visibleOwnerIDs(viewerSessionID, sessions);
}

/** The viewer plus every descendant: the downward view. */
export function resolveScopeSessionIDs(viewerSessionID, sessions = []) {
  return descendantSessionIDs(viewerSessionID, sessions);
}

// ---------------------------------------------------------------------------
// The seam: filter arbitrary scoped rows
// ---------------------------------------------------------------------------

/**
 * Which session owns an entry? Sidebar entries are data-driven, so the owner
 * travels with the row; this reads the field names in use and nothing more.
 * An item with no owner field is unscoped, and unscoped items are only shown
 * when they carry the viewer's own id — never granted by default.
 *
 * `scopeSessionID` is FIRST and it is load-bearing. `buildSessionObjectItems`
 * stamps every sidebar descriptor with that name, and this function used to
 * read only the four below it — so every real descriptor resolved to '' and
 * `createSessionScope(viewer).filter(items)` kept 0 of 5, for every viewer
 * including root. That is a blank sidebar, not a scoped one.
 *
 * Two green specs hid it because neither crossed the boundary: the seam spec
 * supplies its own filter and reads the second argument directly, never
 * calling this function, and the filter spec asserted exactly the four names
 * that already worked. `spec/ownership/sidebar-scope-field-spec.mjs` now pins
 * the descriptor-to-predicate boundary for real.
 *
 * The other four names stay because other row shapes carry them (assignment
 * rows, question rows, activity rows); dropping one silently widens what is
 * visible. Order matters only in that the sidebar's own field wins.
 */
export function sessionIDOf(item) {
  if (item == null || typeof item !== 'object')
    return '';

  return normalizeSessionID(item.scopeSessionID)
    || normalizeSessionID(item.sessionID)
    || normalizeSessionID(item.sessionId)
    || normalizeSessionID(item.ownerSessionID)
    || normalizeSessionID(item.ownerSessionId);
}

/**
 * One viewer evaluated repeatedly — the shape a sidebar actually needs.
 *
 * Exposes both sets, named for their question, so no caller has to remember
 * which direction it holds:
 *   ownerSessionIDs  what this viewer may see   ({V} + ancestors by default)
 *   sessionIDs       who may see this viewer    ({V} + descendants)
 *   owns(id)         is `id` visible to the viewer
 *   filter(items)    the scope filter over data-driven entries, order preserved
 */
export function createSessionScope(viewerSessionID, sessions = []) {
  let list = Array.isArray(sessions) ? sessions : [];
  let viewer = normalizeSessionID(viewerSessionID);
  if (!viewer)
    return emptyScope();

  let ownerSessionIDs = new Set(visibleOwnerIDsFor(viewer, list));
  let owns = (sessionID) => {
    // `owns` answers about ONE SESSION ID. Handed a descriptor row it used to
    // normalize to '' and answer `false` for every item -- a blank sidebar with
    // no error anywhere. Callers legitimately pass a string, null, or undefined
    // (all of src/ and spec/ do), so only a row-shaped argument is rejected:
    // that is a shape mistake, never an answerable id.
    if (typeof sessionID === 'object' && sessionID !== null) {
      let shape = Array.isArray(sessionID)
        ? 'an array'
        : `the object with id "${sessionID.id}"`;
      throw new TypeError(
        `session-scope: owns() takes a session ID string, received ${shape}. ` +
        `To test one sidebar item use predicate(item, scopeSessionID).`,
      );
    }

    let id = normalizeSessionID(sessionID);
    return id ? ownerSessionIDs.has(id) : false;
  };

  return {
    viewerSessionID: viewer,
    ownerSessionIDs,
    sessionIDs: new Set(resolveScopeSessionIDs(viewer, list)),
    owns,
    // The predicate the sidebar seam actually wants: '(item, scopeSessionID) => boolean'.
    // Passed to `filterSessionObjectItems` as-is.
    predicate(item, scopeSessionID) {
      return owns(scopeSessionID === undefined ? sessionIDOf(item) : scopeSessionID);
    },
    filter(items) {
      // A filter, never a re-sort: the caller's order survives.
      return normalizeItemCollection(items).filter((item) => owns(sessionIDOf(item)));
    },
  };
}

// A COLLECTION filter takes a collection. Given a single row it used to answer
// `[]`, and `Boolean([]) === true` -- so handing `scope.filter` to a seam that
// calls its argument per item kept EVERY item and looked like it worked. Two
// wrong pairings, both silent, in opposite directions:
//
//   filterSessionObjectItems(items, scope.filter)  -> all kept   (leak)
//   filterSessionObjectItems(items, scope.owns)    -> none kept   (blank)
//
// Neither throws on its own. `assertItemCollection` makes the first loud at the
// misuse site, and the seam's own boolean check makes the second loud too.
function normalizeItemCollection(items) {
  // `filter(null)` meaning "nothing to filter" is public, pinned behaviour:
  // spec/ownership/session-scope-filter-spec.mjs asserts it. Only a
  // non-array, non-nullish argument is a shape mistake -- that is a single
  // row where a collection was expected, and it is never answerable.
  if (items == null)
    return [];

  if (!Array.isArray(items)) {
    throw new TypeError(
      `session-scope: filter() takes an ARRAY of items, received ` +
      `${typeof items} of ${JSON.stringify(items)}. ` +
      `To test one item use predicate(item, scopeSessionID).`,
    );
  }

  return items;
}

function emptyScope() {
  let owners = new Set();
  return {
    viewerSessionID: '',
    ownerSessionIDs: owners,
    sessionIDs: new Set(),
    owns: () => false,
    predicate: () => false,
    filter(items) {
      normalizeItemCollection(items);
      return [];
    },
  };
}

/**
 * The one-liner a shell builder wires into a data-driven sidebar: keep the
 * entries this viewer may see, in the order the caller built them.
 */
export function filterItemsInScope(viewerSessionID, items, sessions = []) {
  return createSessionScope(viewerSessionID, sessions).filter(items);
}

/** Sessions the viewer may see, in the caller's order. */
export function filterSessionsInScope(viewerSessionID, sessions = []) {
  let rows = Array.isArray(sessions) ? sessions : [];
  let scope = createSessionScope(viewerSessionID, rows);

  return rows.filter((session) => scope.owns(normalizeSessionID(session?.id)));
}
