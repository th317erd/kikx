'use strict';

// Session-scope ownership rules — CORE / SERVER SURFACE.
//
// The rule and the walk live in ONE place now:
//   src/shared/session-ancestry.mjs
// and this file is the thin core-facing surface over it. It was an independent
// copy until the two copies (this file and
// src/client/state/session-scope.mjs) were found to have already diverged in
// two behaviours while sharing line numbers, signatures and near-identical
// comments. A suite that tests each copy in isolation cannot detect that, so
// the copy is gone.
//
// The earlier justification for the duplication — that src/client cannot
// import src/core and vice versa — was true but incomplete: it ignored
// src/shared/, which src/core imports in 12 places, src/client in 8, and which
// src/server/static-files.mjs:75-77 serves to the browser. The walk belongs
// there, not in two leaves.
//
// THE RULE, from the owner ("everything is a view into that descendant of the
// session tree"; only the user account is global):
//
//     an item owned by session O is visible to viewer session V
//         iff  O === V  or  O is an ancestor of V
//
//     visible-to-V  =  items owned by  { V } union ancestors(V)
//
// A parent must NOT see what its children own: "these agents would trickle
// down to all child sessions, but wouldn't be usable in sessions above the
// level in which they are created". Siblings and unrelated subtrees get
// nothing, in either direction.
//
// ---------------------------------------------------------------------------
// Two questions that look alike and are not
// ---------------------------------------------------------------------------
//     who may see what V owns?   ==>   { V } union descendants(V)
//
// That is the DOWNWARD view, and it is what resolveVisibleSessionIDs
// (src/core/questions/question-dedupe.mjs:120) computes for the ask-user path
// ("whose questions belong in this Inbox"). It is the correct helper for that
// job and the WRONG helper for ownership: substituting it here makes a leaf
// session lose the project-root agents the owner explicitly described, and
// makes a parent able to use its children's agents.
//
// A two-session test cannot tell the two apart. Do not collapse them.
//
// Pure on purpose: no I/O, no storage, no framework. The storage adapters live
// in ownership-query.mjs.

import {
  ancestryChain,
  descendantSessionIDs,
  isAncestorOrSelf,
  isOwnedBy,
  isSessionVisibleTo,
  isVisibleTo,
  normalizeSessionID,
  sessionParentID,
  SESSION_SCOPE_POLICY,
  visibleOwnerIDs,
} from '../../shared/session-ancestry.mjs';

// ---------------------------------------------------------------------------
// The shared walk, re-exported verbatim
// ---------------------------------------------------------------------------

export {
  isAncestorOrSelf,
  isVisibleTo,
  isOwnedBy,
  isSessionVisibleTo,
  normalizeSessionID,
};

/**
 * The single policy switch. Same frozen object the client surface exports as
 * SCOPE_POLICY — one switch, not two that can be flipped independently.
 */
export const OWNERSHIP_POLICY = SESSION_SCOPE_POLICY;

/** The parent link on a session record, tolerating the camel-case alias. */
export function parentSessionIDOf(session) {
  return sessionParentID(session);
}

/** The viewer's ancestry chain including itself: { V } + ancestors. */
export function visibleOwnerIDsFor(viewerSessionID, sessions = []) {
  return ancestryChain(viewerSessionID, sessions);
}

/**
 * The owner ids a viewer may see, governed by OWNERSHIP_POLICY. This is the
 * only function the policy affects; everything else is the fixed relation.
 *
 * It used to ignore the policy while the client counterpart honoured it — one
 * of the two drifts the consolidation removed.
 */
export function ownerScopeFor(viewerSessionID, sessions = []) {
  return visibleOwnerIDs(viewerSessionID, sessions);
}

/**
 * The downward view: the viewer plus every descendant. Kept on this surface
 * because the parity spec compares the two directions in one file.
 *
 * Production code that needs "who can see what V owns" should call the
 * canonical resolveVisibleSessionIDs in src/core/questions/question-dedupe.mjs
 * rather than grow a second answer.
 */
export function resolveScopeSessionIDs(viewerSessionID, sessions = []) {
  return descendantSessionIDs(viewerSessionID, sessions);
}
