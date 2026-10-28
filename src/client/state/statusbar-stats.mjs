'use strict';

// Status-bar session counts (owner review 3, 2026-10-28 screenshot
// `session-2026-10-28-00-32-44.404.png`).
//
// The owner struck out the word "Activities" in the sidebar and boxed the five stat
// cards: "I want all of this information removed, and remove the 'Activities' sidebar
// too. I want all the information in each one of these cards to be shown in the
// statusbar below" + "changes for each session navigation". So the four numbers the
// cards carried (SESSIONS / OPEN QUESTIONS / MESSAGES / AGENTS) now live in the status
// bar and are a function of *which session sits on top of the navigation stack*.
//
// Two deliberate structural choices:
//
//   1. PURE. No DOM, no fetch, no ReactiveState — same rule the view it replaces
//      stated for itself. Data is passed in, so the arithmetic is testable without a
//      browser. `activities-stats.mjs` is NOT deleted and NOT duplicated: it remains
//      the per-session derivation library and `buildSessionStats` is reused here.
//      Two independent implementations of "how many agents" is precisely how the bar
//      would drift from the cards it replaced.
//
//   2. PLAIN VALUES, NOT BINDINGS. The shell is rebuilt whole on every render:
//      `kikx-shell-builders.mjs:112-115` calls `$(app).empty()` and then re-appends a
//      freshly built tree, preceded by `_cleanupReactiveBindings()`. A value computed
//      inside the builder is therefore already recomputed on every navigation, so a
//      `bindState` would only allocate listeners for something that is always fresh —
//      and `AGENTS.md` warns that bindings allocate listeners that must be cleaned up.
//
// Counts at a scope are sums over WHAT THIS CLIENT HOLDS. `GET /api/v1/sessions`
// caps at 50 rows (`session-routes.mjs:22-30`), so a workspace with more than 50
// sessions reports a floor, not a total. That is the same bound the cards had; it is
// recorded here rather than silently implied.

import { buildSessionStats, questionCountsBySession } from './activities-stats.mjs';
import { descendantSessionIDs } from '../../shared/session-ancestry.mjs';

// The four labels the cards used, in the order they read left-to-right in the bar.
// Frozen and exported so a spec pins them: the owner asked for *this* information,
// and a rename here silently changes what the bar claims to show.
export const STATUSBAR_STAT_LABELS = Object.freeze([
  'SESSIONS',
  'OPEN QUESTIONS',
  'MESSAGES',
  'AGENTS',
]);

function textOrNull(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

// Open questions attributed to the sessions in scope.
//
// Deliberately NOT "every open question in the store". Root must equal the sum of its
// sessions, or the owner sees a total that no drill-down explains. Going through
// `questionCountsBySession` also keeps the two branches bit-identical: that helper
// skips a question with no `sessionID` rather than bucketing it under a synthetic key,
// and a root total that silently added those rows would disagree with every child.
function countOpenQuestions(sessions, questions) {
  let counts = questionCountsBySession(questions);
  let open = 0;
  for (let session of sessions) {
    let id = textOrNull(session?.id);
    if (id)
      open += counts.get(id)?.open || 0;
  }

  return open;
}

// Distinct participants across every session handed in. A Map keyed by agent id is
// deliberate: ids arrive from the wire, so `__proto__` / `constructor` must not touch
// a prototype or collide with `Object` members.
function countDistinctAgents(sessions) {
  let seen = new Map();
  for (let session of sessions) {
    for (let agentID of Array.isArray(session?.participantAgentIDs) ? session.participantAgentIDs : []) {
      let normalized = textOrNull(agentID);
      if (normalized && !seen.has(normalized))
        seen.set(normalized, true);
    }
  }

  return seen.size;
}

/**
 * The four counts for one scope, plus the scope label.
 *
 * `scopeKind` is `'session'` when a session is on top of the stack, `'workspace'`
 * otherwise (root, or a view such as the Inbox, whose stack entry carries
 * `sessionID: null` by construction — `navigation-stack.mjs:112`). Both cases always
 * return all four cells, so the builder never null-checks and the bar never shows a
 * ragged row.
 *
 * A `currentSessionID` that is absent from `sessions` is NOT an error: it happens
 * whenever a deep link addresses a session beyond the 50-row page cap. That degrades
 * to a labelled zero row (so the user sees *which* session is empty) instead of
 * throwing inside a shell builder, which would blank the whole app through the error
 * boundary.
 */
export function buildStatusBarStats(options = {}) {
  let sessions = Array.isArray(options.sessions) ? options.sessions.filter(Boolean) : [];
  let questions = Array.isArray(options.questions) ? options.questions : [];
  let currentSessionID = textOrNull(options.currentSessionID);

  if (!currentSessionID) {
    let messages = 0;
    for (let session of sessions) {
      let stats = buildSessionStats(session, { questions });
      messages += stats.messageCount;
    }

    return {
      scopeKind: 'workspace',
      scopeLabel: 'Workspace',
      // Summed over the rows this client holds (the 50-row cap, above).
      cells: freezeCells([
        { label: STATUSBAR_STAT_LABELS[0], value: sessions.length },
        // Open questions come from the store's open set, which is not capped, so this
        // counts every open question rather than only those under the visible sessions.
        { label: STATUSBAR_STAT_LABELS[1], value: countOpenQuestions(sessions, questions) },
        { label: STATUSBAR_STAT_LABELS[2], value: messages },
        { label: STATUSBAR_STAT_LABELS[3], value: countDistinctAgents(sessions) },
      ]),
    };
  }

  let current = sessions.find((session) => session.id === currentSessionID) || null;
  let stats = buildSessionStats(current, { questions });
  // Descendants at any depth, excluding the session itself: `descendantSessionIDs`
  // returns the viewer plus its subtree, and its `scope` set makes a parent cycle
  // terminate (each id visited once) rather than loop.
  let descendants = current ? Math.max(0, descendantSessionIDs(currentSessionID, sessions).length - 1) : 0;

  return {
    scopeKind: 'session',
    scopeLabel: stats.title || stats.sessionID || currentSessionID,
    cells: freezeCells([
      { label: STATUSBAR_STAT_LABELS[0], value: descendants },
      { label: STATUSBAR_STAT_LABELS[1], value: stats.openQuestions },
      { label: STATUSBAR_STAT_LABELS[2], value: stats.messageCount },
      { label: STATUSBAR_STAT_LABELS[3], value: stats.agentCount },
    ]),
  };
}

function freezeCells(cells) {
  return Object.freeze(cells.map((cell) => Object.freeze({ ...cell })));
}
