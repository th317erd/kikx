'use strict';

// Canonical session-ancestry walk and ownership scope. ONE implementation,
// imported by both sides of the tree.
//
// Why this file exists: the same parent walk had been written twice — once in
// src/client/state/session-scope.mjs and once in
// src/core/ownership/session-ownership.mjs — with the same line numbers, the
// same signatures, and two already-diverged behaviours. A per-copy test suite
// cannot detect that the two copies disagree, so the duplication is removed
// rather than policed.
//
// `src/shared/` is the real boundary for this: src/core/ imports it in 12
// places, src/client/ in 8, and src/server/static-files.mjs:75-77 serves
// `/shared/` to the browser. Nothing here may import from src/core or
// src/client.
//
// ---------------------------------------------------------------------------
// THE RULE, from the owner
// ---------------------------------------------------------------------------
// "everything is a view into that descendant of the session tree"; only the
// user account is global.
//
//     an item owned by session O is visible to viewer session V
//         iff  O === V  or  O is an ancestor of V
//
//     visible-to-V  =  items owned by  { V } union ancestors(V)
//
// A parent must NOT use what its child owns ("wouldn't be usable in sessions
// above the level in which they are created"). Siblings and unrelated trees
// get nothing, in either direction.
//
// ---------------------------------------------------------------------------
// Two questions that look alike and are not
// ---------------------------------------------------------------------------
// Read the family relation from the other side and you get:
//
//     who may see what V owns?   ==>   { V } union descendants(V)
//
// That is the DOWNWARD view (ancestryChain's mirror, descendantSessionIDs
// here) and it is what resolveVisibleSessionIDs computes for the ask-user path
// (src/core/questions/question-dedupe.mjs:120). It is correct for "whose
// questions belong in this Inbox" and it is the WRONG helper for ownership:
// substituting it makes a leaf session lose the project-root agents the owner
// explicitly described, and lets a parent use its children's agents.
//
// A two-session test cannot tell the two apart. Do not collapse them.
//
// Failures are closed: a blank id, an unresolvable viewer or a corrupt parent
// chain yields no grant, never a default one. One boundary is deliberate: a
// parent link naming a session missing from the supplied list is still honoured
// as an ancestor, because the link on the descendant record is the evidence.
// That admits one declared ancestor and never a branch.

// ---------------------------------------------------------------------------
// Policy — the single thing to change if the owner revises the rule
// ---------------------------------------------------------------------------

/**
 * `ancestorsVisible: true` is the owner's rule: usability is granted at and
 * below the creation level, so a viewer sees what it owns plus what its
 * ancestors own.
 *
 * `ancestorsVisible: false` is the stricter reading ("only my own subtree").
 * Flipping this one flag changes `visibleOwnerIDs` and nothing else.
 *
 * Both surfaces export this same frozen object (as SCOPE_POLICY and
 * OWNERSHIP_POLICY) so there is exactly one switch to flip.
 */
export const SESSION_SCOPE_POLICY = Object.freeze({
  ancestorsVisible: true,
});

/** Trim a session id; anything that is not a string becomes ''. */
export function normalizeSessionID(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * The parent link on a session record.
 *
 * `parentSessionID` is the wire field (src/core/runtime/frame-runtime.mjs:84-92
 * normalizes it; src/server/routes/session-routes.mjs:105-114 accepts it on
 * create and rejects an empty string, allowing null). `parentSessionId` is the
 * accepted camel-case alias from that same route.
 *
 * An empty or blank `parentSessionID` does NOT stop the alias from being
 * consulted: the create route treats an empty string as a rejection rather
 * than as a value, so a record carrying one is malformed rather than
 * meaningfully parentless. The two previous copies disagreed here (one tested
 * `== null`, the other `||`); this is the single answer, and both surfaces are
 * pinned to it by spec/ownership/session-ancestry-parity-spec.mjs.
 */
export function sessionParentID(session) {
  if (session == null || typeof session !== 'object')
    return '';

  return normalizeSessionID(session.parentSessionID)
    || normalizeSessionID(session.parentSessionId);
}

/**
 * Accepts the shapes callers have on hand and returns `(id) => session`.
 * An array or Map is indexed once, so repeated lookups stay O(1).
 */
function toSessionLookup(source) {
  if (typeof source === 'function')
    return source;

  if (source instanceof Map)
    return (id) => source.get(id);

  let byID = new Map();
  for (let session of Array.isArray(source) ? source : []) {
    let id = normalizeSessionID(session?.id);
    if (id && !byID.has(id))
      byID.set(id, session);
  }

  return (id) => byID.get(id);
}

// ---------------------------------------------------------------------------
// The primitive
// ---------------------------------------------------------------------------

/**
 * True when `ancestorSessionID` is `descendantSessionID` itself or sits
 * anywhere above it in the parent chain.
 *
 * Direction is the whole point: the walk goes UP from the descendant, so a
 * child is unreachable from its parent and a parent can never see what its
 * children own. Callers must not swap the arguments; the names say which way
 * the walk goes.
 *
 * Iterative with a visited set, so a cycle in corrupted parent links terminates
 * instead of hanging, and a cycle that does not contain the ancestor cannot
 * produce a grant.
 */
export function isAncestorOrSelf(ancestorSessionID, descendantSessionID, getSession) {
  let ancestor = normalizeSessionID(ancestorSessionID);
  let descendant = normalizeSessionID(descendantSessionID);

  if (!ancestor || !descendant)
    return false;

  // Self is a grant before the record is loaded: an item is always visible to
  // the session that owns it.
  if (ancestor === descendant)
    return true;

  let lookup = toSessionLookup(getSession);
  let visited = new Set([ descendant ]);
  let current = descendant;

  for (;;) {
    let session = lookup(current);
    // The record is not loaded, so the chain ends here. Reaching this by
    // following a declared parent link means that parent already matched
    // above; anything beyond an unloaded record is unprovable.
    if (session == null)
      return false;

    let parent = sessionParentID(session);
    if (!parent)
      return false;

    if (parent === ancestor)
      return true;

    // Revisiting a link means the chain is corrupt; the ancestor was not on it
    // or we would have returned above.
    if (visited.has(parent))
      return false;

    visited.add(parent);
    current = parent;
  }
}

// ---------------------------------------------------------------------------
// The upward view: what may this viewer see?
// ---------------------------------------------------------------------------

/** May `viewer` see an item owned by `owner`? `owner` on the viewer's chain. */
export function isVisibleTo(viewerSessionID, ownerSessionID, getSession) {
  return isAncestorOrSelf(ownerSessionID, viewerSessionID, getSession);
}

/** The same relation under the name a sidebar asks it by. */
export function isOwnedBy(viewerSessionID, ownerSessionID, getSession) {
  return isAncestorOrSelf(ownerSessionID, viewerSessionID, getSession);
}

/** The same relation, spelled with the viewer first in the name. */
export function isSessionVisibleTo(viewerSessionID, ownerSessionID, getSession) {
  return isAncestorOrSelf(ownerSessionID, viewerSessionID, getSession);
}

/**
 * The viewer's ancestry chain including itself, nearest last: the owners whose
 * items the viewer may see. Iterative; terminates on a missing parent or a
 * cycle.
 */
export function ancestryChain(viewerSessionID, source = []) {
  let viewer = normalizeSessionID(viewerSessionID);
  if (!viewer)
    return [];

  let lookup = toSessionLookup(source);
  let owners = [ viewer ];
  let seen = new Set([ viewer ]);
  let current = viewer;

  for (;;) {
    let session = lookup(current);
    if (session == null)
      return owners;

    let parent = sessionParentID(session);
    if (!parent || seen.has(parent))
      return owners;

    seen.add(parent);
    owners.push(parent);
    current = parent;
  }
}

/** The downward view: the viewer plus every descendant. Needs the full list. */
export function descendantSessionIDs(viewerSessionID, sessions = []) {
  let viewer = normalizeSessionID(viewerSessionID);
  if (!viewer)
    return [];

  let childrenByParent = new Map();

  for (let session of Array.isArray(sessions) ? sessions : []) {
    let id = normalizeSessionID(session?.id);
    let parent = sessionParentID(session);
    if (!id || !parent)
      continue;

    if (!childrenByParent.has(parent))
      childrenByParent.set(parent, []);

    childrenByParent.get(parent).push(id);
  }

  let scope = new Set([ viewer ]);
  let queue = [ viewer ];

  for (let index = 0; index < queue.length; index++) {
    let current = queue[index];
    for (let childID of childrenByParent.get(current) ?? []) {
      if (scope.has(childID))
        continue;

      scope.add(childID);
      queue.push(childID);
    }
  }

  return [ ...scope ];
}

/**
 * The owner ids a viewer may see, governed by SESSION_SCOPE_POLICY. This is the
 * only function the policy affects; everything else is the fixed relation.
 *
 * The downward branch needs the full session list to index children, so it
 * degrades to the viewer alone when handed a lookup function or a Map.
 */
export function visibleOwnerIDs(viewerSessionID, sessions = []) {
  let viewer = normalizeSessionID(viewerSessionID);
  if (!viewer)
    return [];

  if (SESSION_SCOPE_POLICY.ancestorsVisible)
    return ancestryChain(viewer, sessions);

  return descendantSessionIDs(viewer, Array.isArray(sessions) ? sessions : []);
}
