'use strict';

// The DOWNWARD view of the session tree: a session and everything beneath it.
//
// This is the fan-out set for a subtree operation such as `/halt` against a
// descendant. It is deliberately NOT the same direction as
// `hasCoordinatorAuthority` (./coordinator-scope.mjs), which walks UP from a
// target to decide whether an actor's authority reaches it. Authority asks
// "who is above this session"; this asks "what is below it".
//
// Same relation as `resolveVisibleSessionIDs`
// (src/core/questions/question-dedupe.mjs:120), which answers "whose questions
// belong in this Inbox". That module takes a full session array and belongs to
// the question path; this one takes an injected child source so a caller can
// walk a tree it has only partly loaded. `spec/core/agents/
// coordinator-scope-spec.mjs` pins the two against each other on one fixture --
// if either drifts, that test fails.
//
// Terminates on a cycle via the visited set, and on a node cap so a corrupt
// `parentSessionID` cannot make one request enumerate the world.

/** A trimmed non-empty string, or ''. */
function normalizeID(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** The parent link on a session record, tolerating the camel-case alias. */
function parentSessionIDOf(session) {
  if (session == null || typeof session !== 'object')
    return '';

  return normalizeID(session.parentSessionID) || normalizeID(session.parentSessionId);
}

/**
 * Build a `childrenOf(parentID) -> string[]` source from a flat session array.
 * Exported so a caller that already holds the tree does not have to re-index.
 */
export function childrenIndexFrom(sessions) {
  let childrenByParent = new Map();

  for (let session of Array.isArray(sessions) ? sessions : []) {
    let id = normalizeID(session?.id);
    let parent = parentSessionIDOf(session);
    if (!id || !parent)
      continue;

    if (!childrenByParent.has(parent))
      childrenByParent.set(parent, []);

    childrenByParent.get(parent).push(id);
  }

  return (parentID) => childrenByParent.get(normalizeID(parentID)) || [];
}

/**
 * Every session at or below `rootSessionID`, including the root, breadth-first.
 *
 * `options.childrenOf(parentID)` supplies the children; alternatively
 * `options.listSessions()` returns a flat array and the index is built here.
 * With neither, only the root is returned -- a caller that cannot enumerate
 * children gets the safe answer rather than a wrong one.
 *
 * Returns `{ sessionIDs, truncated }`. `truncated` is true when the node cap was
 * hit, so a caller can refuse to report a full subtree halt it did not perform.
 */
export function resolveSubtreeSessionIDs(rootSessionID, options = {}) {
  let root = normalizeID(rootSessionID);
  if (!root)
    return { sessionIDs: [], truncated: false };

  let maxNodes = Number.isFinite(Number(options.maxNodes)) && Number(options.maxNodes) > 0
    ? Math.trunc(Number(options.maxNodes))
    : 1000;

  let childrenOf = typeof options.childrenOf === 'function' ? options.childrenOf : null;

  if (!childrenOf && Array.isArray(options.sessions))
    childrenOf = childrenIndexFrom(options.sessions);

  if (!childrenOf)
    return { sessionIDs: [ root ], truncated: false };

  let sessionIDs = [ root ];
  let seen = new Set([ root ]);
  let queue = [ root ];
  let truncated = false;

  while (queue.length > 0) {
    let current = queue.shift();

    for (let childID of childrenOf(current) || []) {
      let id = normalizeID(childID);
      if (!id || seen.has(id))
        continue;

      if (sessionIDs.length >= maxNodes) {
        truncated = true;
        break;
      }

      seen.add(id);
      sessionIDs.push(id);
      queue.push(id);
    }

    if (truncated)
      break;
  }

  return { sessionIDs, truncated };
}

/** Just the ids, for callers that do not care about truncation. */
export function descendantSessionIDs(rootSessionID, options = {}) {
  return resolveSubtreeSessionIDs(rootSessionID, options).sessionIDs;
}
