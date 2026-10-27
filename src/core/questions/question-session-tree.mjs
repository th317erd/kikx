'use strict';

/**
 * Session-tree resolution for tree-scoped question reads.
 *
 * Why this is a module instead of a few lines inside the store: the same
 * three-step decision — find a lister, refuse to answer without one, fetch the
 * session list — is needed by `listOpen`, `listVisibleQuestions`,
 * `queryQuestions` and `listRecentlySettledQuestions`. Keeping it in one place
 * is what stops the silent-empty behaviour from creeping back into a fourth
 * call site later.
 *
 * The history matters, because it is why the failure was invisible from the
 * inside. `QuestionsStore` used to look for `this.frameStore ||
 * this.aeordb?.frameStore`, and the only object in the process that has a
 * `frameStore` property is `FrameRuntime`. The server constructed the store
 * with `{ db }` alone, so the lookup always missed, and `listSessionTree()`
 * returned `[]`. Every tree-scoped read then collapsed to "exactly the session
 * you named" — which looks identical to a correct answer on a childless
 * session. An asking agent reading its own session therefore saw a working
 * Inbox while a root-session Inbox was blind to every child.
 *
 * Two rules follow from that:
 *
 * 1. Resolution is LAZY. `frameRuntime` is registered in `create-server.mjs`
 *    after `questionsStore`, so a store that captured the runtime at
 *    construction would capture `undefined` and reintroduce the same bug. The
 *    resolver is called per read.
 * 2. A store that cannot enumerate the tree THROWS. "I could not look" must
 *    never be reported as "there is nothing to see", because the two are
 *    indistinguishable downstream and only one of them is a safe thing to let
 *    a coordinator conclude about its children.
 */

export class SessionTreeUnavailableError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'SessionTreeUnavailableError';
    this.code = 'SESSION_TREE_UNAVAILABLE';
    this.reason = options.reason || 'unavailable';
    if (options.cause !== undefined)
      this.cause = options.cause;
  }
}

/**
 * Pull a `listSessions` function out of whatever the resolver returned.
 *
 * `FrameRuntime` exposes `listSessions` directly; `FrameStore` exposes it too.
 * Anything else (a plain db client, `undefined` from an not-yet-registered
 * context key) is a miss rather than an error condition to ignore.
 */
export function resolveSessionLister(candidate) {
  if (!candidate)
    return null;

  if (typeof candidate.listSessions === 'function')
    return candidate;

  if (typeof candidate.frameStore?.listSessions === 'function')
    return candidate.frameStore;

  return null;
}

/**
 * Resolve the lister for one read, or throw a typed error explaining which of
 * the several possible wiring mistakes happened.
 */
export function requireSessionLister({ resolver, frameStore, aeordb } = {}) {
  let candidate = null;

  if (typeof resolver === 'function') {
    try {
      candidate = resolver();
    } catch (error) {
      throw new SessionTreeUnavailableError(
        'QuestionsStore cannot read the session tree: the sessionLister resolver threw. '
        + 'Tree-scoped question reads would silently under-report, so this is a failure instead.',
        { reason: 'resolver-threw', cause: error },
      );
    }
  } else if (resolver) {
    candidate = resolver;
  }

  let lister = resolveSessionLister(candidate);
  if (lister)
    return lister;

  // An explicitly attached store, kept as a supported override. Nothing in src/
  // assigns it (only FrameRuntime owns a frameStore property), but a caller
  // that hands the store a FrameStore-like object keeps working.
  let attached = resolveSessionLister(frameStore);
  if (attached)
    return attached;

  // Back-compat for callers that hand the store a FrameStore-like db object.
  let fromDb = resolveSessionLister(aeordb) || resolveSessionLister(aeordb?.frameStore);
  if (fromDb)
    return fromDb;

  throw new SessionTreeUnavailableError(
    'QuestionsStore cannot enumerate the session tree: no sessionLister resolver is wired and the '
    + 'db client has no frameStore. Tree-scoped reads (includeDescendants, scope=tree, scope=all) '
    + 'cannot be answered without it, and answering "no descendants" here is a false negative that '
    + 'hides child sessions\' questions from their ancestors.',
    { reason: 'not-wired' },
  );
}

/**
 * The flat session list for tree walks.
 *
 * A lister that throws is surfaced rather than converted to `[]`: an empty tree
 * and a broken index produce the same narrowing, and only the caller can decide
 * whether degrading is acceptable. `limit` is passed through because the page
 * size is the lister's contract, but a truncated list would also under-report,
 * so a short page is reported in the error rather than assumed complete.
 */
export async function listSessionsForTree({ resolver, frameStore, aeordb, limit = 5000, onWarning } = {}) {
  let lister = requireSessionLister({ resolver, frameStore, aeordb });
  let sessions;

  try {
    sessions = await lister.listSessions({ limit });
  } catch (error) {
    throw new SessionTreeUnavailableError(
      'QuestionsStore cannot enumerate the session tree: the session lister threw, so any '
      + 'tree-scoped answer would silently omit descendants.',
      { reason: 'list-failed', cause: error },
    );
  }

  if (!Array.isArray(sessions)) {
    throw new SessionTreeUnavailableError(
      'QuestionsStore cannot enumerate the session tree: the session lister did not return an array.',
      { reason: 'list-not-array' },
    );
  }

  // A full page means the listing was probably clipped at `limit`. Say so rather
  // than pretending the tree ends there — a missing session here is exactly the
  // invisible-child failure this module exists to prevent.
  if (sessions.length >= limit && typeof onWarning === 'function') {
    onWarning(new SessionTreeUnavailableError(
      `QuestionsStore listed ${sessions.length} sessions, which reached the ${limit} limit; `
      + 'deeper sessions may be missing from tree-scoped results.',
      { reason: 'list-truncated' },
    ));
  }

  return sessions;
}

/**
 * The tolerant twin of `listSessionsForTree`, for call sites that genuinely
 * have a correct answer WITHOUT the tree and merely want to disclose that they
 * could not see it.
 *
 * This exists because "throw always" and "return [] always" are both wrong, in
 * opposite directions:
 *
 *  - The Inbox/report paths must throw. Their whole job is to show an owner the
 *    questions in its subtree, so an unanswered tree walk is a false all-clear.
 *  - The look-before-you-write digest (`listVisibleQuestions`) must not throw.
 *    It is a precondition on the caller's OWN session, and "this session only"
 *    is a correct, strictly narrower answer for it — the same answer a
 *    childless session legitimately gets. Failing the whole ask because a
 *    fixture (or a not-yet-registered runtime) cannot enumerate sessions would
 *    break writing questions entirely, which is worse than the bug being fixed.
 *
 * The danger the original bug posed was not that it degraded — it is that it
 * degraded SILENTLY. So this returns the narrowing as data: `warning` is null
 * when the tree was read, and a plain object describing the gap when it was
 * not. Callers are expected to forward it, not swallow it.
 */
export async function tryListSessionsForTree({ resolver, frameStore, aeordb, limit = 5000 } = {}) {
  try {
    let sessions = await listSessionsForTree({ resolver, frameStore, aeordb, limit });
    return { sessions, warning: null };
  } catch (error) {
    return {
      sessions: [],
      warning: {
        code: error?.code || 'SESSION_TREE_UNAVAILABLE',
        reason: error?.reason || 'unavailable',
        message: error?.message || 'QuestionsStore could not enumerate the session tree.',
      },
    };
  }
}

export { listSessionsForTree as default };
