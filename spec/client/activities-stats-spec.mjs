'use strict';

// Client-derived Activities stats (plan §6.4, phase P4, [D-10]).
//
// The module under test is pure: no DOM, no fetch, no ReactiveState. It is
// imported directly here — there is no `installDom`/loader step, and one test
// below pins that the import works with the DOM genuinely absent, so nobody
// later reintroduces a document dependency into a maths helper.
//
// These specs are deliberately adversarial about the claims that are easiest to
// get wrong and hardest to notice:
//
//  * `unreadAnswers` must stay ABSENT. §6.4 lists it, but the client cannot
//    derive it: `GET /api/v1/questions` reads only the store's open index
//    (`question-routes.mjs:21-49`), so terminal rows never arrive. The failure
//    mode to prevent is a later "fix" that emits a constant `0`, which reads as
//    measured data and is a lie. A key-absence assertion is the only guard that
//    catches an invented zero, so it is asserted on both builders.
//  * an orphan (parent missing from the list) must be shown once, not dropped
//    and not duplicated,
//  * a parent cycle must terminate and must not double-count,
//  * `messageCount` is the manifest field, never a count of loaded frames,
//  * sort stability, because a reshuffling grid is the visible symptom.
//
// When behaviour is genuinely unspecified (which session in a cycle becomes the
// root) the assertion stays on the invariant that actually matters.

import assert from 'node:assert/strict';
import test from 'node:test';

import * as activitiesStats from '../../src/client/state/activities-stats.mjs';

const {
  buildProjectStats,
  buildSessionStats,
  questionCountsBySession,
  sortStatsByActivity,
} = activitiesStats;

// Unix *microseconds* (`hybrid-logical-clock.mjs:73-75`) — the module passes
// these through untouched, so only relative order matters to these specs.
const T = (seconds) => 1_700_000_000_000_000 + seconds * 1_000_000;

function makeSession({
  id,
  title = null,
  parentSessionID = null,
  messageCount = 0,
  participantAgentIDs = [],
  updatedAt = T(0),
} = {}) {
  return { id, title, parentSessionID, messageCount, participantAgentIDs, updatedAt };
}

function makeQuestion({ id, sessionID, status = 'open', deleted = false } = {}) {
  return { id, sessionID, status, deleted };
}

const idsOf = (stats) => stats.map((value) => value.sessionID);
const sorted = (values) => values.slice().sort();

// ---------------------------------------------------------------------------
// Export surface
// ---------------------------------------------------------------------------

test('module exports exactly the four documented helpers (no invented fields)', () => {
  assert.deepEqual(
    Object.keys(activitiesStats).sort(),
    [ 'buildProjectStats', 'buildSessionStats', 'questionCountsBySession', 'sortStatsByActivity' ],
  );
});

test('importing the module needs no DOM', () => {
  // The helper is pure maths; a document dependency here would mean the
  // Activities view could not compute stats in a headless test.
  assert.equal(typeof document, 'undefined');
});

// ---------------------------------------------------------------------------
// questionCountsBySession
// ---------------------------------------------------------------------------

test('questionCountsBySession: separates open from total, keyed by session', () => {
  const counts = questionCountsBySession([
    makeQuestion({ id: 'q1', sessionID: 's1', status: 'open' }),
    makeQuestion({ id: 'q2', sessionID: 's1', status: 'answered' }),
    makeQuestion({ id: 'q3', sessionID: 's1', status: 'dismissed' }),
    makeQuestion({ id: 'q4', sessionID: 's2', status: 'open' }),
  ]);

  assert.ok(counts instanceof Map);
  assert.deepEqual(counts.get('s1'), { open: 1, total: 3 });
  assert.deepEqual(counts.get('s2'), { open: 1, total: 1 });
});

test('questionCountsBySession: an open-but-deleted row counts toward total, not open', () => {
  // `isOpenQuestion` (`questions-state.mjs:24`) requires status 'open' AND
  // `deleted !== true`. Delegating that rule is the point; re-deriving it is how
  // the Inbox badge and the Activities card drift apart.
  const counts = questionCountsBySession([
    makeQuestion({ id: 'q1', sessionID: 's1', status: 'open', deleted: true }),
  ]);

  assert.deepEqual(counts.get('s1'), { open: 0, total: 1 });
});

test('questionCountsBySession: skips unattributable rows instead of bucketing them', () => {
  const counts = questionCountsBySession([
    null,
    undefined,
    'not-an-object',
    [],
    makeQuestion({ id: 'q1', sessionID: '' }),
    makeQuestion({ id: 'q2', sessionID: '   ' }),
    makeQuestion({ id: 'q3', sessionID: 's1', status: 'open' }),
  ]);

  assert.equal(counts.size, 1);
  assert.deepEqual(counts.get('s1'), { open: 1, total: 1 });
});

test('questionCountsBySession: a Map keeps hostile ids off the prototype', () => {
  // Session ids arrive from the wire. With a plain object, a session literally
  // named `__proto__` would either vanish or poison `Object.prototype`.
  const counts = questionCountsBySession([
    makeQuestion({ id: 'q1', sessionID: '__proto__', status: 'open' }),
    makeQuestion({ id: 'q2', sessionID: 'constructor', status: 'open' }),
  ]);

  assert.deepEqual(counts.get('__proto__'), { open: 1, total: 1 });
  assert.deepEqual(counts.get('constructor'), { open: 1, total: 1 });
  assert.equal({}.open, undefined);
  assert.equal(Object.prototype.open, undefined);
});

test('questionCountsBySession: junk input yields an empty Map, not a throw', () => {
  for (const input of [ undefined, null, 'nope', 42, {} ]) {
    const counts = questionCountsBySession(input);
    assert.ok(counts instanceof Map, `expected a Map for ${String(input)}`);
    assert.equal(counts.size, 0);
  }
});

// ---------------------------------------------------------------------------
// buildSessionStats
// ---------------------------------------------------------------------------

test('buildSessionStats: reports the verified manifest fields verbatim', () => {
  const stats = buildSessionStats(makeSession({
    id: 's1',
    title: 'Alpha',
    parentSessionID: 'root-1',
    messageCount: 42,
    participantAgentIDs: [ 'ag-1', 'ag-2' ],
    updatedAt: T(9),
  }));

  assert.deepEqual(stats, {
    sessionID: 's1',
    title: 'Alpha',
    parentSessionID: 'root-1',
    messageCount: 42,
    updatedAt: T(9),
    agentCount: 2,
    agentIDs: [ 'ag-1', 'ag-2' ],
    openQuestions: 0,
  });
});

test('buildSessionStats: never emits unreadAnswers (and no constant-zero stand-in)', () => {
  const stats = buildSessionStats(makeSession({ id: 's1', messageCount: 3 }));

  assert.equal(Object.hasOwn(stats, 'unreadAnswers'), false);
  // Broader net: catch a rename or a sibling invention such as `unreadAnswers: 0`.
  assert.deepEqual(
    Object.keys(stats).filter((key) => /unread/i.test(key)),
    [],
  );
});

test('buildSessionStats: messageCount comes from the manifest, not from frames', () => {
  // A session whose frames were never loaded still reports its real volume.
  const withoutFrames = buildSessionStats(makeSession({ id: 's1', messageCount: 900 }));
  assert.equal(withoutFrames.messageCount, 900);

  // The negative half: if the manifest field is absent, frames must NOT be
  // counted. A 900-element frames array is provided precisely to catch an
  // implementation that derives the number from loaded frames.
  const noManifestCount = buildSessionStats({
    id: 's1',
    frames: Array.from({ length: 900 }, (_unused, index) => ({ id: `f${index}` })),
    participantAgentIDs: [],
  });
  assert.equal(noManifestCount.messageCount, 0);
});

test('buildSessionStats: openQuestions counts only this session, only open rows', () => {
  const stats = buildSessionStats(
    makeSession({ id: 's1' }),
    {
      questions: [
        makeQuestion({ id: 'q1', sessionID: 's1', status: 'open' }),
        makeQuestion({ id: 'q2', sessionID: 's1', status: 'answered' }),
        makeQuestion({ id: 'q3', sessionID: 's1', status: 'open' }),
        makeQuestion({ id: 'q4', sessionID: 's2', status: 'open' }),
      ],
    },
  );

  assert.equal(stats.openQuestions, 2);
});

test('buildSessionStats: a precomputed counts Map produces the same number', () => {
  // `buildProjectStats` reuses this path; a divergence would desync card and
  // project totals.
  const questions = [
    makeQuestion({ id: 'q1', sessionID: 's1', status: 'open' }),
    makeQuestion({ id: 'q2', sessionID: 's1', status: 'open' }),
  ];
  const viaQuestions = buildSessionStats(makeSession({ id: 's1' }), { questions });
  const viaCounts = buildSessionStats(makeSession({ id: 's1' }), {
    counts: questionCountsBySession(questions),
  });

  assert.equal(viaQuestions.openQuestions, 2);
  assert.equal(viaCounts.openQuestions, 2);
});

test('buildSessionStats: an agentID listed twice is counted once', () => {
  const stats = buildSessionStats(makeSession({
    id: 's1',
    participantAgentIDs: [ 'ag-1', 'ag-1', 'ag-2' ],
  }));

  assert.equal(stats.agentCount, 2);
});

test('buildSessionStats: usable contract for an unusable input (zeroed card, not undefined)', () => {
  // A renderer should never null-check, so every field must be present.
  for (const input of [ undefined, null, 'nope', [], 42 ]) {
    const stats = buildSessionStats(input);
    assert.equal(stats.sessionID, null);
    assert.equal(stats.title, null);
    assert.equal(stats.parentSessionID, null);
    assert.equal(stats.messageCount, 0);
    assert.equal(stats.updatedAt, null);
    assert.equal(stats.agentCount, 0);
    assert.equal(stats.openQuestions, 0);
  }
});

test('buildSessionStats: a blank title stays null — the view owns "Untitled"', () => {
  // Presentation belongs to `kikx-activities-view.mjs`; putting a placeholder in
  // the model would leak view copy into stats and break exact-equality consumers.
  assert.equal(buildSessionStats(makeSession({ id: 's1', title: '   ' })).title, null);
  assert.equal(buildSessionStats(makeSession({ id: 's1', title: undefined })).title, null);
});

test('buildSessionStats: emits agentIDs alongside agentCount (stated export contract)', () => {
  // Zav's export contract for buildSessionStats lists `agentIDs` as well as
  // `agentCount`; `buildProjectStats` emits both. Asserted here so the asymmetry
  // is either fixed or the contract is corrected deliberately.
  const stats = buildSessionStats(makeSession({
    id: 's1',
    participantAgentIDs: [ 'ag-1', 'ag-2' ],
  }));

  assert.ok(Array.isArray(stats.agentIDs), 'buildSessionStats should expose the agent id list');
  assert.deepEqual(sorted(stats.agentIDs), [ 'ag-1', 'ag-2' ]);
});

// ---------------------------------------------------------------------------
// buildProjectStats — rollup
// ---------------------------------------------------------------------------

test('buildProjectStats: rolls a depth-3 chain into exactly one root', () => {
  const sessions = [
    makeSession({
      id: 'A', title: 'Project A', messageCount: 100,
      participantAgentIDs: [ 'x' ], updatedAt: T(1),
    }),
    makeSession({
      id: 'B', parentSessionID: 'A', messageCount: 20,
      participantAgentIDs: [ 'y' ], updatedAt: T(5),
    }),
    makeSession({
      id: 'C', parentSessionID: 'B', messageCount: 7,
      participantAgentIDs: [ 'z' ], updatedAt: T(3),
    }),
  ];
  const questions = [
    makeQuestion({ id: 'q1', sessionID: 'A', status: 'open' }),
    makeQuestion({ id: 'q2', sessionID: 'A', status: 'open' }),
    makeQuestion({ id: 'q3', sessionID: 'B', status: 'open' }),
    makeQuestion({ id: 'q4', sessionID: 'C', status: 'open' }),
    makeQuestion({ id: 'q5', sessionID: 'C', status: 'answered' }),
  ];

  const projects = buildProjectStats(sessions, questions);

  assert.equal(projects.length, 1, 'only the root A should surface as a project');
  const [project] = projects;

  assert.equal(project.sessionID, 'A');
  assert.equal(project.title, 'Project A');
  assert.equal(project.sessionCount, 3);
  assert.deepEqual(sorted(project.sessionIDs), [ 'A', 'B', 'C' ]);
  assert.equal(project.openQuestions, 4, 'open=2+1+1; the answered row must not count');
  assert.equal(project.messageCount, 127);
  assert.equal(project.lastActivity, T(5), 'newest activity may live below the root');
  assert.deepEqual(sorted(project.agentIDs), [ 'x', 'y', 'z' ]);
  assert.equal(project.agentCount, 3);
});

test('buildProjectStats: lastActivity is the subtree maximum, not the root or the leaf', () => {
  const sessions = [
    makeSession({ id: 'A', updatedAt: T(2) }),
    makeSession({ id: 'B', parentSessionID: 'A', updatedAt: T(9) }),
    makeSession({ id: 'C', parentSessionID: 'B', updatedAt: T(4) }),
  ];

  assert.equal(buildProjectStats(sessions, []).at(0).lastActivity, T(9));
});

test('buildProjectStats: an orphan whose parent is absent becomes its own root', () => {
  // Happens in production when a child is within the 50-session page cap
  // (`session-routes.mjs:22-30`) but its parent is not. Dropping it would hide a
  // project; duplicating it would double its totals.
  const sessions = [
    makeSession({ id: 'root-A', messageCount: 5 }),
    makeSession({ id: 'orphan', parentSessionID: 'ghost-not-in-list', messageCount: 9 }),
  ];

  const projects = buildProjectStats(sessions, []);
  assert.equal(projects.length, 2, 'both the root and the orphan must surface');

  const orphan = projects.find((value) => value.sessionID === 'orphan');
  assert.ok(orphan, 'orphan must not be dropped');
  assert.equal(orphan.sessionCount, 1);
  assert.equal(orphan.messageCount, 9);

  const everyID = projects.flatMap((value) => value.sessionIDs);
  assert.equal(everyID.filter((id) => id === 'orphan').length, 1, 'orphan must appear exactly once');
});

test('buildProjectStats: an orphan keeps its own children beneath it', () => {
  const sessions = [
    makeSession({ id: 'orphan', parentSessionID: 'ghost', messageCount: 1 }),
    makeSession({ id: 'child', parentSessionID: 'orphan', messageCount: 2 }),
  ];

  const projects = buildProjectStats(sessions, []);
  assert.equal(projects.length, 1);
  assert.equal(projects[0].sessionID, 'orphan');
  assert.equal(projects[0].sessionCount, 2);
  assert.equal(projects[0].messageCount, 3);
});

test('buildProjectStats: a parent cycle terminates and counts each session once', () => {
  // A->B->A has no reachable root. Which one is promoted is unspecified; that it
  // terminates, and counts each session exactly once, is not.
  const sessions = [
    makeSession({ id: 'A', parentSessionID: 'B', messageCount: 10 }),
    makeSession({ id: 'B', parentSessionID: 'A', messageCount: 20 }),
  ];

  const projects = buildProjectStats(sessions, []);

  const everyID = projects.flatMap((value) => value.sessionIDs);
  assert.deepEqual(sorted(everyID), [ 'A', 'B' ], 'each session appears exactly once, no duplicates');
  assert.equal(everyID.length, new Set(everyID).size, 'no duplicate ids across projects');
  assert.equal(
    projects.reduce((total, value) => total + value.sessionCount, 0),
    2,
    'sessionCount must total the input, not double-count the cycle',
  );
  assert.equal(
    projects.reduce((total, value) => total + value.messageCount, 0),
    30,
    'messageCount must not double-count a cycle',
  );
});

test('buildProjectStats: a self-parenting session terminates and counts once', () => {
  const sessions = [ makeSession({ id: 'A', parentSessionID: 'A', messageCount: 4 }) ];

  const projects = buildProjectStats(sessions, []);
  assert.equal(projects.length, 1);
  assert.equal(projects[0].sessionIDs.length, 1);
  assert.equal(projects[0].messageCount, 4);
});

test('buildProjectStats: a cycle with an attached subtree covers every session once', () => {
  const sessions = [
    makeSession({ id: 'A', parentSessionID: 'B', messageCount: 1 }),
    makeSession({ id: 'B', parentSessionID: 'A', messageCount: 2 }),
    makeSession({ id: 'C', parentSessionID: 'A', messageCount: 4 }),
    makeSession({ id: 'D', parentSessionID: 'C', messageCount: 8 }),
  ];

  const projects = buildProjectStats(sessions, []);
  const everyID = projects.flatMap((value) => value.sessionIDs);

  assert.deepEqual(sorted(everyID), [ 'A', 'B', 'C', 'D' ]);
  assert.equal(everyID.length, new Set(everyID).size);
  assert.equal(projects.reduce((total, value) => total + value.messageCount, 0), 15);
});

test('buildProjectStats: sibling projects do not leak into each other', () => {
  const sessions = [
    makeSession({ id: 'A', messageCount: 10, participantAgentIDs: [ 'ag-a' ], updatedAt: T(2) }),
    makeSession({ id: 'A1', parentSessionID: 'A', messageCount: 5, participantAgentIDs: [ 'ag-a2' ], updatedAt: T(3) }),
    makeSession({ id: 'B', messageCount: 7, participantAgentIDs: [ 'ag-b' ], updatedAt: T(1) }),
    makeSession({ id: 'B1', parentSessionID: 'B', messageCount: 3, participantAgentIDs: [ 'ag-b2' ], updatedAt: T(0) }),
  ];
  const questions = [
    makeQuestion({ id: 'qa1', sessionID: 'A', status: 'open' }),
    makeQuestion({ id: 'qa2', sessionID: 'A', status: 'open' }),
    makeQuestion({ id: 'qa3', sessionID: 'A1', status: 'open' }),
    makeQuestion({ id: 'qb1', sessionID: 'B', status: 'open' }),
    makeQuestion({ id: 'qb2', sessionID: 'B1', status: 'open' }),
    makeQuestion({ id: 'qb3', sessionID: 'B1', status: 'open' }),
    makeQuestion({ id: 'qb4', sessionID: 'B1', status: 'open' }),
  ];

  const projects = buildProjectStats(sessions, questions);
  assert.equal(projects.length, 2);

  const a = projects.find((value) => value.sessionID === 'A');
  const b = projects.find((value) => value.sessionID === 'B');

  assert.equal(a.sessionCount, 2);
  assert.equal(a.messageCount, 15);
  assert.equal(a.openQuestions, 3, "A must sum 2+1, not B's questions");
  assert.deepEqual(sorted(a.agentIDs), [ 'ag-a', 'ag-a2' ]);
  assert.equal(a.lastActivity, T(3));

  assert.equal(b.sessionCount, 2);
  assert.equal(b.messageCount, 10);
  assert.equal(b.openQuestions, 4, "B must sum 1+3, not A's questions");
  assert.deepEqual(sorted(b.agentIDs), [ 'ag-b', 'ag-b2' ]);
  assert.equal(b.lastActivity, T(1));

  for (const id of a.sessionIDs) {
    assert.ok([ 'A', 'A1' ].includes(id), `A leaked a foreign session: ${id}`);
  }
  for (const id of b.sessionIDs) {
    assert.ok([ 'B', 'B1' ].includes(id), `B leaked a foreign session: ${id}`);
  }
});

test('buildProjectStats: duplicate ids count once, first occurrence wins', () => {
  // The list is already the authoritative merge, so a repeated id means the same
  // session twice. Counting it twice would inflate a project's totals.
  const sessions = [
    makeSession({ id: 'A', messageCount: 5 }),
    makeSession({ id: 'A', messageCount: 999 }),
  ];

  const projects = buildProjectStats(sessions, []);
  assert.equal(projects.length, 1);
  assert.equal(projects[0].sessionCount, 1);
  assert.equal(projects[0].messageCount, 5);
});

test('buildProjectStats: a session with no id is dropped, never bucketed', () => {
  const sessions = [
    makeSession({ id: '', messageCount: 50 }),
    makeSession({ id: 'A', messageCount: 5 }),
  ];

  const projects = buildProjectStats(sessions, []);
  assert.equal(projects.length, 1);
  assert.equal(projects[0].sessionID, 'A');
  assert.equal(projects[0].sessionCount, 1);
});

test('buildProjectStats: a long chain does not overflow the stack', () => {
  // The rollup is documented as iterative. A recursive rewrite would blow the
  // stack here rather than in review.
  const depth = 500;
  const sessions = [ makeSession({ id: 's0', messageCount: 1 }) ];
  for (let index = 1; index < depth; index++) {
    sessions.push(makeSession({
      id: `s${index}`,
      parentSessionID: `s${index - 1}`,
      messageCount: 1,
    }));
  }

  const projects = buildProjectStats(sessions, []);
  assert.equal(projects.length, 1);
  assert.equal(projects[0].sessionID, 's0');
  assert.equal(projects[0].sessionCount, depth);
  assert.equal(projects[0].messageCount, depth);
});

test('buildProjectStats: never emits unreadAnswers on any project', () => {
  const sessions = [
    makeSession({ id: 'A' }),
    makeSession({ id: 'B', parentSessionID: 'A' }),
  ];

  const projects = buildProjectStats(sessions, [
    makeQuestion({ id: 'q1', sessionID: 'A', status: 'open' }),
  ]);

  assert.ok(projects.length > 0);
  for (const project of projects) {
    assert.equal(Object.hasOwn(project, 'unreadAnswers'), false);
    assert.deepEqual(Object.keys(project).filter((key) => /unread/i.test(key)), []);
  }
});

test('buildProjectStats: empty and undefined inputs return [], never undefined', () => {
  const cases = [
    buildProjectStats(),
    buildProjectStats(undefined, undefined),
    buildProjectStats([], []),
    buildProjectStats(null, null),
    buildProjectStats('nope', 'nope'),
  ];

  for (const projects of cases) {
    assert.ok(Array.isArray(projects), 'expected an array');
    assert.deepEqual(projects, []);
  }
});

test('buildProjectStats: an empty session list ignores stray questions', () => {
  // Questions for sessions not in the list must not conjure projects.
  const projects = buildProjectStats([], [
    makeQuestion({ id: 'q1', sessionID: 'ghost', status: 'open' }),
  ]);

  assert.deepEqual(projects, []);
});

// ---------------------------------------------------------------------------
// sortStatsByActivity
// ---------------------------------------------------------------------------

test('sortStatsByActivity: newest activity first', () => {
  const stats = [
    { sessionID: 'old', lastActivity: T(1) },
    { sessionID: 'newest', lastActivity: T(9) },
    { sessionID: 'middle', lastActivity: T(5) },
  ];

  assert.deepEqual(idsOf(sortStatsByActivity(stats)), [ 'newest', 'middle', 'old' ]);
});

test('sortStatsByActivity: equal activity keeps input order (stable)', () => {
  const stats = [
    { sessionID: 'a', lastActivity: T(1) },
    { sessionID: 'b', lastActivity: T(3) },
    { sessionID: 'c', lastActivity: T(1) },
    { sessionID: 'd', lastActivity: T(1) },
  ];

  // b leads; the three ties keep a, c, d — a grid reshuffle would show here.
  assert.deepEqual(idsOf(sortStatsByActivity(stats)), [ 'b', 'a', 'c', 'd' ]);
});

test('sortStatsByActivity: reads updatedAt for session stats, lastActivity for projects', () => {
  const sessionStats = [
    { sessionID: 's1', updatedAt: T(1) },
    { sessionID: 's2', updatedAt: T(4) },
  ];
  assert.deepEqual(idsOf(sortStatsByActivity(sessionStats)), [ 's2', 's1' ]);

  const mixed = [
    { sessionID: 'project', lastActivity: T(2) },
    { sessionID: 'session', updatedAt: T(6) },
  ];
  assert.deepEqual(idsOf(sortStatsByActivity(mixed)), [ 'session', 'project' ]);
});

test('sortStatsByActivity: missing or non-finite activity sorts last, without NaN poisoning', () => {
  const stats = [
    { sessionID: 'none' },
    { sessionID: 'dated', lastActivity: T(5) },
    { sessionID: 'null', lastActivity: null },
    { sessionID: 'nan', lastActivity: Number.NaN },
  ];

  const sortedIDs = idsOf(sortStatsByActivity(stats));

  assert.equal(sortedIDs[0], 'dated', 'the only real timestamp must lead');
  assert.equal(sortedIDs.length, stats.length, 'no entry may be dropped');
  // Ties among the undefined values keep their relative input order.
  assert.deepEqual(sortedIDs.slice(1), [ 'none', 'null', 'nan' ]);
});

test('sortStatsByActivity: null lastActivity falls back to updatedAt', () => {
  // Mirrors `lastActivity ?? updatedAt` (`kikx-activities-view.mjs:128`).
  const stats = [
    { sessionID: 'fallback', lastActivity: null, updatedAt: T(7) },
    { sessionID: 'dated', lastActivity: T(3), updatedAt: T(0) },
  ];

  assert.deepEqual(idsOf(sortStatsByActivity(stats)), [ 'fallback', 'dated' ]);
});

test('sortStatsByActivity: does not mutate its input and returns a new array', () => {
  const stats = [
    { sessionID: 'a', lastActivity: T(1) },
    { sessionID: 'b', lastActivity: T(2) },
  ];
  const before = stats.slice();

  const sortedStats = sortStatsByActivity(stats);

  assert.notEqual(sortedStats, stats);
  assert.deepEqual(stats, before, 'input order must be untouched');
  assert.deepEqual(idsOf(sortedStats), [ 'b', 'a' ]);
});

test('sortStatsByActivity: empty and undefined inputs return [], never undefined', () => {
  for (const input of [ undefined, null, [], 'nope' ]) {
    const sortedStats = sortStatsByActivity(input);
    assert.ok(Array.isArray(sortedStats), `expected an array for ${String(input)}`);
    assert.deepEqual(sortedStats, []);
  }
});
