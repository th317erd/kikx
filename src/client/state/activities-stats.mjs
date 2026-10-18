'use strict';

// Client-derived Activities stats (plan §6.4, phase P4, [D-10]). Pure helpers: no
// DOM, no fetch, no ReactiveState — data is passed in, so the math is testable.
//
// Inputs: (1) sessions from `GET /api/v1/sessions` (`{ sessions: [...] }`,
// `session-routes.mjs:22-30`, cap 50), merged by `loadSessions` (`kikx-data.mjs:83`) and
// read via `getSessions` (`kikx-state.mjs:150`, soft deletes already filtered);
// (2) questions from `getQuestionsState(state).questions` (`kikx-state.mjs:267`), filled
// by `applyQuestionsFetch` (`questions-state.mjs:332`); classification delegated to
// `isOpenQuestion` (`questions-state.mjs:24`).
//
// NOT EMITTED ON PURPOSE — `unreadAnswers`. Plan §6.4 lists "unread answers", but it
// is NOT derivable from what the client has, so this module omits the field entirely
// rather than emitting a constant 0 that would read as measured data.
// `GET /api/v1/questions` (`question-routes.mjs:21-49`) reads only the store's *open*
// index via `listOpen` and never scans per-question docs, so
// answered/dismissed/undeliverable questions never come back; its `status=` filter
// (`question-routes.mjs:39-43`) selects *within* that open set, so `status=answered`
// returns nothing instead of history. The server aggregate endpoint §6.4 explicitly
// welcomes is the honest path to adding one later.

import { isOpenQuestion } from './questions-state.mjs';

function textOrNull(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

// Only verified manifest fields: `id`, `title`, `parentSessionID`, `messageCount`,
// `participantAgentIDs`, `updatedAt` (`frame-runtime.mjs:74-95`). `sessionID` is a string
// because the walk and counts Map key on it; id-less manifests are dropped, so '' never
// reaches a rollup and `buildSessionStats` reports null. `coordinatorAgentID` is by
// construction a participant (`frame-runtime-normalize.mjs:143-151`), so counting it
// changes nothing.
function normalizeSession(session) {
  let source = session && typeof session === 'object' && !Array.isArray(session) ? session : {};
  let agentIDs = [];
  for (let value of Array.isArray(source.participantAgentIDs) ? source.participantAgentIDs : []) {
    let agentID = textOrNull(value);
    if (agentID && !agentIDs.includes(agentID))
      agentIDs.push(agentID);
  }

  return {
    sessionID: textOrNull(source.id) || '',
    title: textOrNull(source.title),
    // Roots carry `parentSessionID: null`; a blank string is treated the same way.
    parentSessionID: textOrNull(source.parentSessionID),
    messageCount: Number.isInteger(source.messageCount) && source.messageCount >= 0 ? source.messageCount : 0,
    updatedAt: typeof source.updatedAt === 'number' && Number.isFinite(source.updatedAt) ? source.updatedAt : null,
    agentIDs,
  };
}

// No id: unplaceable in a tree. Duplicate id: would double-count a subtree. First
// occurrence wins (the list is already the authoritative merge).
function normalizeSessionList(sessions) {
  let output = [];
  for (let session of Array.isArray(sessions) ? sessions : []) {
    let normalized = normalizeSession(session);
    if (normalized.sessionID)
      output.push(normalized);
  }

  return output;
}

/**
 * Open/total counts per session. `open` counts only rows where `isOpenQuestion` holds
 * (`questions-state.mjs:24`); `total` counts every attributed row whatever its status —
 * equal in production since the route ships only open rows
 * (`question-routes.mjs:21-49`), diverging only for a caller holding a terminal row. No
 * `sessionID` is unattributable: skipped, never bucketed under a synthetic key. A `Map`
 * is deliberate — ids come from the wire, so `__proto__` / `constructor` must not touch
 * a prototype or collide with `Object` members.
 */
export function questionCountsBySession(questions = []) {
  let counts = new Map();

  for (let question of Array.isArray(questions) ? questions : []) {
    if (!question || typeof question !== 'object' || Array.isArray(question))
      continue;

    let sessionID = textOrNull(question.sessionID);
    if (!sessionID)
      continue;

    let entry = counts.get(sessionID) || { open: 0, total: 0 };
    entry.total += 1;
    if (isOpenQuestion(question))
      entry.open += 1;

    counts.set(sessionID, entry);
  }

  return counts;
}

/**
 * Stats for one session. Every field is present, so a renderer never null-checks: an
 * unusable input yields a zeroed card, not `undefined`. A blank title is `null` not a
 * placeholder — presentation belongs to the view, which supplies
 * `stats.title || 'Untitled'` (`kikx-activities-view.mjs:122`). `updatedAt` passes
 * through untouched (Unix *microseconds*, `hybrid-logical-clock.mjs:73-75`), converted
 * only by `formatActivityAge` (`kikx-activities-view.mjs:44`).
 */
export function buildSessionStats(session, options = {}) {
  let normalized = normalizeSession(session);
  let counts = options?.counts instanceof Map ? options.counts : questionCountsBySession(options?.questions);

  return {
    sessionID: normalized.sessionID || null,
    title: normalized.title,
    parentSessionID: normalized.parentSessionID,
    messageCount: normalized.messageCount,
    updatedAt: normalized.updatedAt,
    agentCount: normalized.agentIDs.length,
    agentIDs: normalized.agentIDs.slice(),
    openQuestions: counts.get(normalized.sessionID)?.open || 0,
  };
}

/**
 * Roll each subtree up under its root (`parentSessionID === null`). `sessionCount` is the
 * project plus descendants at any depth, walked iteratively so depth cannot threaten the
 * JS stack. A `claimed` set counts each session under exactly one project, stopping a
 * cycle looping forever *and* double-counting when two roots reach one node. An orphan
 * (parent absent from the list, e.g. beyond the 50-session page cap,
 * `session-routes.mjs:22-30`) becomes its own root, so it appears once rather than being
 * dropped or duplicated. A cycle (a → b → a) has no reachable root, so the earliest
 * unclaimed session is promoted: the guard degrades to "shown once", never "gone".
 */
export function buildProjectStats(sessions = [], questions = []) {
  let byID = new Map();
  for (let session of normalizeSessionList(sessions)) {
    if (!byID.has(session.sessionID))
      byID.set(session.sessionID, session);
  }

  // Children are indexed only when the parent is actually present; that single
  // condition is what turns an absent parent into an orphan root.
  let childrenByParent = new Map();
  let seeds = [];
  for (let session of byID.values()) {
    let parentID = session.parentSessionID;
    if (!parentID || !byID.has(parentID)) {
      seeds.push(session.sessionID);
      continue;
    }

    let bucket = childrenByParent.get(parentID) || [];
    childrenByParent.set(parentID, bucket);
    bucket.push(session.sessionID);
  }

  let counts = questionCountsBySession(questions);
  let claimed = new Set();
  let projects = [];

  while (true) {
    while (seeds.length > 0) {
      let rootID = seeds.shift();
      if (!claimed.has(rootID))
        projects.push(rollupProject(rootID, { byID, childrenByParent, counts, claimed }));
    }

    // Anything still unclaimed sits in a parent cycle (or below one): promote the
    // earliest such session so the guard shows it exactly once.
    let leftoverID = null;
    for (let sessionID of byID.keys()) {
      if (!claimed.has(sessionID)) {
        leftoverID = sessionID;
        break;
      }
    }
    if (!leftoverID)
      return projects;
    seeds.push(leftoverID);
  }
}

function rollupProject(rootID, { byID, childrenByParent, counts, claimed }) {
  let sessionIDs = [];
  let stack = [ rootID ];
  let openQuestions = 0;
  let messageCount = 0;
  let lastActivity = null;
  let agentIDs = [];

  while (stack.length > 0) {
    let sessionID = stack.pop();
    if (claimed.has(sessionID))
      continue;

    claimed.add(sessionID);
    sessionIDs.push(sessionID);

    let session = byID.get(sessionID);
    if (!session)
      continue;

    openQuestions += counts.get(sessionID)?.open || 0;
    messageCount += session.messageCount;

    if (session.updatedAt != null && (lastActivity == null || session.updatedAt > lastActivity))
      lastActivity = session.updatedAt;

    for (let agentID of session.agentIDs)
      if (!agentIDs.includes(agentID))
        agentIDs.push(agentID);

    let children = childrenByParent.get(sessionID);
    // Reverse-push so `pop()` visits children in input order (deterministic rollup).
    for (let index = (children?.length || 0) - 1; index >= 0; index--)
      stack.push(children[index]);
  }

  return {
    sessionID: rootID,
    title: byID.get(rootID)?.title ?? null,
    sessionCount: sessionIDs.length,
    openQuestions,
    messageCount,
    lastActivity,
    agentCount: agentIDs.length,
    agentIDs,
    // Additive to §6.4 because the P4 consumer reads it: `deriveActivities` finds
    // the current project via `stats.sessionIDs.includes(...)`
    // (`kikx-activities-view.mjs:96`).
    sessionIDs,
  };
}

/**
 * Newest activity first, stable: ties keep input order via an explicit index tiebreak
 * (`Array#sort` stability is ES2019+, but leaning on it while comparing possibly-missing
 * values is how "the grid reshuffled" bugs start). A missing/non-finite timestamp sorts
 * as oldest rather than poisoning the compare with NaN. Reads `lastActivity` (rollups) or
 * `updatedAt` (session stats), mirroring `lastActivity ?? updatedAt` at
 * `kikx-activities-view.mjs:128`.
 */
export function sortStatsByActivity(stats = []) {
  return (Array.isArray(stats) ? stats : [])
    .map((value, index) => {
      let at = value?.lastActivity ?? value?.updatedAt;
      return { value, index, at: typeof at === 'number' && Number.isFinite(at) ? at : 0 };
    })
    .sort((left, right) => (left.at === right.at ? left.index - right.index : right.at - left.at))
    .map((entry) => entry.value);
}
