'use strict';

// Coordinator resolution across the session tree, and the authority predicate
// derived from it.
//
// THE RULE (owner ruling, 2026-10-25):
//
//   1. A session's coordinator is its own `coordinatorAgentID`, if that agent is
//      still a participant.
//   2. Otherwise it is the coordinator of the nearest ANCESTOR session that
//      resolves to one. A child may inherit from any depth.
//   3. If no ancestor resolves to a coordinator, one is FORCE-PROMOTED from the
//      participants and persisted, so a tree always has a coordinator.
//   4. Only a chain with no participants anywhere resolves to null.
//
// Authority then flows DOWN the tree: if Z coordinates session S, Z may
// coordinate every descendant of S, at any depth, whether or not Z is a
// participant there. Presence is required to *run* in a session, not to command
// it.
//
// ---------------------------------------------------------------------------
// Two walks that look alike and are not
// ---------------------------------------------------------------------------
// The predicate below walks UP from the *target* session, checking whether the
// actor coordinates any session on that chain. The near-identical-looking
// `resolveVisibleSessionIDs` (src/core/questions/question-dedupe.mjs:120)
// computes the DESCENDANTS of a viewer, and `visibleOwnerIDsFor`
// (src/core/ownership/session-ownership.mjs) walks up from a *viewer* for the
// ownership rule. Both are the opposite direction from what authority needs,
// and a two-level fixture cannot tell them apart: with P -> C only,
// "coordinator of an ancestor" and "coordinator of a descendant" both reduce to
// the same pair of ids. The distinguishing test needs a third level, and
// `spec/core/agents/coordinator-scope-spec.mjs` has one.
//
// ---------------------------------------------------------------------------
// Why this module is pure, and how promotion can both be pure and persist
// ---------------------------------------------------------------------------
// Every function here takes a `getSession(id)` lookup and reads participants off
// the session record; nothing reaches into the runtime store. Promotion is the
// one rule that must WRITE (a resolver that returns a promoted bot without
// recording it can disagree with itself on the next call), so the write is
// injected as `persistCoordinator(sessionID, agentID)` and performed by the
// caller that owns storage.
//
// Resolution stays deterministic without that callback, which is what makes a
// read-only caller safe: promotion always picks `participantAgentIDs[0]` of the
// highest session in the chain that has participants, and participants are
// stored in join order. So an authority check that does not persist still
// returns exactly what a persisting resolve would have returned. The spec
// asserts that agreement rather than assuming it.

// ---------------------------------------------------------------------------
// Small normalizers (local; this module imports nothing)
// ---------------------------------------------------------------------------

/** A trimmed non-empty string, or ''. */
export function normalizeID(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** A de-duplicated list of trimmed non-empty strings, order preserved. */
export function normalizeIDList(values) {
  let list = [];

  for (let value of Array.isArray(values) ? values : []) {
    let id = normalizeID(value);
    if (id && !list.includes(id))
      list.push(id);
  }

  return list;
}

/** The parent link on a session record, tolerating the camel-case alias. */
export function parentSessionIDOf(session) {
  if (session == null || typeof session !== 'object')
    return '';

  return normalizeID(session.parentSessionID) || normalizeID(session.parentSessionId);
}

/** The participants of a session record, in stored (join) order. */
export function participantAgentIDsOf(session) {
  return normalizeIDList(session?.participantAgentIDs);
}

function toLookup(getSession) {
  if (typeof getSession === 'function')
    return getSession;

  if (getSession instanceof Map)
    return (id) => getSession.get(id);

  let byID = new Map();
  for (let session of Array.isArray(getSession) ? getSession : []) {
    let id = normalizeID(session?.id);
    if (id && !byID.has(id))
      byID.set(id, session);
  }

  return (id) => byID.get(id);
}

// How far ancestry may be walked before the tree is assumed corrupt. Deep enough
// for any real tree, shallow enough that a malformed cycle cannot run away even
// if the visited-set check is ever bypassed.
export const COORDINATOR_MAX_ANCESTOR_DEPTH = 64;

// ---------------------------------------------------------------------------
// The ancestor chain
// ---------------------------------------------------------------------------

/**
 * The ancestry chain of `sessionID`, nearest first, including the session
 * itself. Terminates on a missing record, a dangling parent link, or a cycle,
 * and reports which of those stopped it rather than throwing or hanging.
 *
 * Returns `{ chain, stopped, cycleDetected, missingSessionID, truncated }`.
 * `chain` holds session ids; `stopped` is one of 'root' | 'missing' | 'cycle' |
 * 'depth'.
 */
export function resolveAncestorChain(sessionID, getSession, options = {}) {
  let start = normalizeID(sessionID);
  let maxDepth = Number.isFinite(Number(options.maxDepth)) && Number(options.maxDepth) > 0
    ? Math.trunc(Number(options.maxDepth))
    : COORDINATOR_MAX_ANCESTOR_DEPTH;

  let chain = [];
  let seen = new Set();
  let current = start;

  if (!start) {
    return { chain, stopped: 'missing', cycleDetected: false, missingSessionID: null, truncated: false };
  }

  for (;;) {
    if (chain.length >= maxDepth)
      return { chain, stopped: 'depth', cycleDetected: false, missingSessionID: null, truncated: true };

    if (seen.has(current)) {
      return { chain, stopped: 'cycle', cycleDetected: true, missingSessionID: null, truncated: false };
    }

    seen.add(current);

    let session = getSession(current);
    // A record that is not loaded ends the walk. For the start session that is
    // a genuinely unknown session; further up it is a dangling parent link. Both
    // are reported as 'missing' with the id that could not be loaded.
    if (session == null) {
      return { chain, stopped: 'missing', cycleDetected: false, missingSessionID: current, truncated: false };
    }

    chain.push(current);

    let parent = parentSessionIDOf(session);
    if (!parent) {
      return { chain, stopped: 'root', cycleDetected: false, missingSessionID: null, truncated: false };
    }

    current = parent;
  }
}

/** Just the ids from `resolveAncestorChain`, nearest first. */
export function ancestorSessionIDs(sessionID, getSession, options = {}) {
  return resolveAncestorChain(sessionID, getSession, options).chain;
}

// ---------------------------------------------------------------------------
// The resolver
// ---------------------------------------------------------------------------

/**
 * Resolve a session's coordinator per rules 1-4 above.
 *
 * `options.getSession`      (id) => session | null            [required]
 * `options.persistCoordinator` (sessionID, agentID) => void  [optional]
 *
 * Returns:
 *   coordinatorAgentID  string | null
 *   source              'explicit' | 'inherited' | 'promoted' | 'none'
 *   ownerSessionID      the session the coordinator was taken from
 *   promoted            true when rule 3 chose a bot
 *   persisted           true when the promotion was actually written
 *   chain               ancestor ids walked, nearest first
 *   stopped             why the walk ended (see resolveAncestorChain)
 *   cycleDetected       boolean
 *   missingSessionID    string | null
 */
export function resolveSessionCoordinator(options = {}) {
  let sessionID = normalizeID(options.sessionID);
  let getSession = toLookup(options.getSession);
  let persist = typeof options.persistCoordinator === 'function' ? options.persistCoordinator : null;

  let walk = resolveAncestorChain(sessionID, getSession, options);
  let result = {
    sessionID,
    coordinatorAgentID: null,
    source: 'none',
    ownerSessionID: null,
    promoted: false,
    persisted: false,
    chain: walk.chain,
    stopped: walk.stopped,
    cycleDetected: walk.cycleDetected,
    missingSessionID: walk.missingSessionID,
  };

  if (walk.chain.length === 0)
    return result;

  // Rule 1: the session's own explicit coordinator, while it is still a
  // participant. This deliberately does NOT fall back to "first participant"
  // here -- see rule 3, which is where promotion happens and where it is
  // recorded. The old fallback lived at this exact spot in two copies and is
  // why the first invited bot silently became coordinator.
  let nearest = walk.chain[0];
  let nearestSession = getSession(nearest);
  let nearestParticipants = participantAgentIDsOf(nearestSession);
  let explicit = normalizeID(nearestSession?.coordinatorAgentID);

  if (explicit && nearestParticipants.includes(explicit)) {
    result.coordinatorAgentID = explicit;
    result.source = 'explicit';
    result.ownerSessionID = nearest;
    return result;
  }

  // Rule 2: walk ancestors upward (nearest first) looking for one that resolves.
  for (let ancestorID of walk.chain.slice(1)) {
    let ancestor = getSession(ancestorID);
    let ancestorParticipants = participantAgentIDsOf(ancestor);
    let ancestorExplicit = normalizeID(ancestor?.coordinatorAgentID);

    if (ancestorExplicit && ancestorParticipants.includes(ancestorExplicit)) {
      result.coordinatorAgentID = ancestorExplicit;
      result.source = 'inherited';
      result.ownerSessionID = ancestorID;
      return result;
    }
  }

  // Rule 3: forced promotion. Pick the highest session in the chain that has
  // participants -- nearest first would crown a local bot even when a parent
  // above it is merely uncoordinated, and the owner's rule is that a parent
  // takes responsibility for its children. Choosing the highest participant-
  // holding session keeps one bot accountable for the whole run below it.
  //
  // A session full of non-coordinator bots is legal (req 1): it must not be
  // crowned merely for being non-empty *as a child of nothing*. It only gets a
  // coordinator because nothing above it had one.
  let promotionSessionID = null;
  let promotionParticipants = [];

  for (let index = walk.chain.length - 1; index >= 0; index -= 1) {
    let candidateID = walk.chain[index];
    let candidateParticipants = participantAgentIDsOf(getSession(candidateID));

    if (candidateParticipants.length > 0) {
      promotionSessionID = candidateID;
      promotionParticipants = candidateParticipants;
      break;
    }
  }

  // Rule 4: no participants anywhere in the chain.
  if (!promotionSessionID)
    return result;

  let promotedAgentID = promotionParticipants[0];
  result.coordinatorAgentID = promotedAgentID;
  result.source = 'promoted';
  result.ownerSessionID = promotionSessionID;
  result.promoted = true;

  if (persist) {
    try {
      // `false` means the injector could not reach a writable record. Treat that
      // as not-persisted rather than not-throwing-as-success: a caller that
      // trusts `persisted` would otherwise believe the store agrees with an
      // answer that only exists in this stack frame.
      result.persisted = persist(promotionSessionID, promotedAgentID) !== false;
    } catch (_error) {
      // A failed write must not turn a resolvable session into an unusable one.
      // The answer is still deterministic (see the header note), so the caller
      // keeps working and `persisted` reports that the store disagrees.
      result.persisted = false;
    }
  }

  return result;
}

/** Convenience: the resolved coordinator id, or null. */
export function coordinatorAgentIDFor(sessionID, options = {}) {
  return resolveSessionCoordinator({ ...options, sessionID }).coordinatorAgentID;
}

/**
 * The coordinators responsible for `sessionID`, nearest first: the session's own
 * resolution followed by every ancestor session that has a coordinator of its
 * own. This is the chain a UI renders as "who is in charge here".
 */
export function resolveCoordinatorChain(options = {}) {
  let sessionID = normalizeID(options.sessionID);
  let getSession = toLookup(options.getSession);
  let walk = resolveAncestorChain(sessionID, getSession, options);
  let seen = new Set();
  let chain = [];

  for (let chainSessionID of walk.chain) {
    let session = getSession(chainSessionID);
    let participants = participantAgentIDsOf(session);
    let explicit = normalizeID(session?.coordinatorAgentID);
    if (!explicit || !participants.includes(explicit))
      continue;

    if (seen.has(explicit))
      continue;

    seen.add(explicit);
    chain.push({ agentID: explicit, sessionID: chainSessionID });
  }

  return {
    sessionID,
    chain,
    ancestors: walk,
  };
}

/**
 * The nearest ancestor session (excluding `sessionID` itself) whose own
 * explicit coordinator is `agentID`. Used to report *why* an ancestor grants
 * authority, which the refusal messages need.
 */
export function nearestAncestorCoordinator(options = {}) {
  let sessionID = normalizeID(options.sessionID);
  let agentID = normalizeID(options.agentID);
  let getSession = toLookup(options.getSession);
  let walk = resolveAncestorChain(sessionID, getSession, options);

  for (let ancestorID of walk.chain.slice(1)) {
    let ancestor = getSession(ancestorID);
    let explicit = normalizeID(ancestor?.coordinatorAgentID);
    if (explicit && participantAgentIDsOf(ancestor).includes(explicit) && explicit === agentID) {
      return { found: true, sessionID: ancestorID, agentID: explicit, ancestors: walk };
    }
  }

  return { found: false, sessionID: null, agentID: null, ancestors: walk };
}

// ---------------------------------------------------------------------------
// The authority predicate
// ---------------------------------------------------------------------------

/**
 * May `actorAgentID` exercise coordinator authority over `targetSessionID`?
 *
 *   hasCoordinatorAuthority(actor, target)
 *     for each A in [target] + ancestors(target):
 *        if resolveCoordinator(A) === actor  ->  true
 *     return false
 *
 * The walk goes UP from the target, so the actor's own session must be an
 * ANCESTOR-OR-SELF of the target: authority flows down. An ancestor-of-the-viewer
 * question ("may my coordinator command my parent?") is the opposite set and
 * must answer false here -- `spec/core/agents/coordinator-scope-spec.mjs` asserts
 * both directions on a three-level tree.
 *
 * Read-only: never promotes, never writes. A promoted-but-unpersisted coordinator
 * still answers identically here, because promotion is deterministic, so a
 * permission check cannot be the thing that silently changes the tree.
 *
 * Returns `{ allowed, reason, ownerSessionID, chain }` where `reason` is one of
 *   'self'            -- actor coordinates the target session itself
 *   'ancestor'        -- actor coordinates an ancestor of the target
 *   'not-coordinator' -- no session on the chain names this actor
 *   'unknown-session' -- the target session could not be loaded
 * and `ownerSessionID` names the session that actually grants the authority.
 */
export function hasCoordinatorAuthority(options = {}) {
  let actorAgentID = normalizeID(options.agentID);
  let targetSessionID = normalizeID(options.targetSessionID ?? options.sessionID);
  let getSession = toLookup(options.getSession);

  let empty = { allowed: false, reason: 'unknown-session', ownerSessionID: null, chain: [] };

  if (!actorAgentID || !targetSessionID)
    return empty;

  let walk = resolveAncestorChain(targetSessionID, getSession, options);
  if (walk.chain.length === 0)
    return { ...empty, chain: walk.chain };

  for (let index = 0; index < walk.chain.length; index += 1) {
    let chainSessionID = walk.chain[index];
    let session = getSession(chainSessionID);
    let participants = participantAgentIDsOf(session);
    let explicit = normalizeID(session?.coordinatorAgentID);

    // Only a *recorded* coordinator grants authority. An inherited coordinator is
    // already recorded on the ancestor that owns it, and that ancestor is itself
    // on this chain, so it is found on a later iteration -- no need to recurse.
    if (explicit && participants.includes(explicit) && explicit === actorAgentID) {
      return {
        allowed: true,
        reason: index === 0 ? 'self' : 'ancestor',
        ownerSessionID: chainSessionID,
        chain: walk.chain,
      };
    }
  }

  // Forced promotion is the last thing that can make this actor the coordinator
  // of the target: if the chain has participants and this actor is the one
  // promotion would pick, a persisting resolve would have made it so.
  let resolution = resolveSessionCoordinator({
    sessionID: targetSessionID,
    getSession,
    maxDepth: options.maxDepth,
  });

  if (resolution.source === 'promoted' && resolution.coordinatorAgentID === actorAgentID) {
    return {
      allowed: true,
      reason: resolution.ownerSessionID === targetSessionID ? 'self' : 'ancestor',
      ownerSessionID: resolution.ownerSessionID,
      chain: walk.chain,
      promoted: true,
    };
  }

  return {
    allowed: false,
    reason: 'not-coordinator',
    ownerSessionID: null,
    chain: walk.chain,
  };
}

// ---------------------------------------------------------------------------
// The local (single-session) rule, and the join override
// ---------------------------------------------------------------------------

/**
 * The single-session rule, with no tree walk: the session's own coordinator while
 * it is still a participant, otherwise its first participant.
 *
 * This is the body that used to be copy-pasted into three files
 * (`agent-route/normalize.mjs:46`, `frame-runtime-normalize.mjs:143`,
 * `plugins/agent-normalizers.mjs:164`). It is kept as the *named* local rule
 * because some callers genuinely have no session tree in scope, and it must
 * never be confused with `resolveSessionCoordinator`, which inherits and
 * promotes. Callers holding a tree want the latter.
 */
export function resolveLocalCoordinatorAgentID(session, participantAgentIDs) {
  let participants = normalizeIDList(participantAgentIDs ?? session?.participantAgentIDs);
  let explicit = normalizeID(session?.coordinatorAgentID);

  if (explicit && participants.includes(explicit))
    return explicit;

  return participants[0] || null;
}

/**
 * The join-as-coordinator override (owner ruling P3): "If a coordinator is added
 * to a child frame, then that coordinator takes over responsibility for itself,
 * and all child bots."
 *
 * Read as: when a bot that is the coordinator of *some* session joins `sessionID`
 * as a participant, that bot becomes `sessionID`'s coordinator, overriding
 * inheritance. Returns `{ coordinatorAgentID, changed }` so the caller can decide
 * whether it owes a write.
 *
 * `isCoordinatorOfSomeSession(agentID)` is injected because answering it needs
 * the whole tree, which this pure module deliberately does not hold.
 */
export function applyJoinCoordinatorOverride(options = {}) {
  let sessionID = normalizeID(options.sessionID);
  let joiningAgentID = normalizeID(options.agentID);
  let getSession = toLookup(options.getSession);
  let isCoordinatorOfSomeSession = typeof options.isCoordinatorOfSomeSession === 'function'
    ? options.isCoordinatorOfSomeSession
    : null;

  let session = sessionID ? getSession(sessionID) : null;
  if (!session || !joiningAgentID)
    return { coordinatorAgentID: normalizeID(session?.coordinatorAgentID) || null, changed: false };

  let participants = participantAgentIDsOf(session);
  if (!participants.includes(joiningAgentID))
    return { coordinatorAgentID: normalizeID(session.coordinatorAgentID) || null, changed: false };

  let current = normalizeID(session.coordinatorAgentID);
  if (current === joiningAgentID)
    return { coordinatorAgentID: current, changed: false };

  let qualifies = isCoordinatorOfSomeSession
    ? isCoordinatorOfSomeSession(joiningAgentID) === true
    // With no oracle supplied, the conservative reading is that a joining bot is a
    // coordinator only if it already coordinates THIS session (handled above) --
    // never promote a stranger on a guess.
    : false;

  if (!qualifies)
    return { coordinatorAgentID: current || null, changed: false };

  return { coordinatorAgentID: joiningAgentID, changed: true };
}
