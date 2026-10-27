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
// This surface is what the shell is wired against (kikx-sidebar-session-objects
// imports it), so every name that existed before the consolidation still
// exists here with the same signature. Renaming was not on the table.
//
// Pure on purpose: no I/O, no DOM, no framework. It re-exports from src/shared,
// which the server serves to the browser (src/server/static-files.mjs:75-77),
// so this remains loadable client-side and never reaches into src/core.

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
 */
export function sessionIDOf(item) {
  if (item == null || typeof item !== 'object')
    return '';

  return normalizeSessionID(item.sessionID)
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
    let id = normalizeSessionID(sessionID);
    return id ? ownerSessionIDs.has(id) : false;
  };

  return {
    viewerSessionID: viewer,
    ownerSessionIDs,
    sessionIDs: new Set(resolveScopeSessionIDs(viewer, list)),
    owns,
    filter(items) {
      // A filter, never a re-sort: the caller's order survives.
      return (Array.isArray(items) ? items : []).filter((item) => owns(sessionIDOf(item)));
    },
  };
}

function emptyScope() {
  let owners = new Set();
  return {
    viewerSessionID: '',
    ownerSessionIDs: owners,
    sessionIDs: new Set(),
    owns: () => false,
    filter: () => [],
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
