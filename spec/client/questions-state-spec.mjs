'use strict';

// Client-side question model (plan §6.2/§6.3/§6.6, [D-3], [D-4]).
//
// The module under test is pure: no DOM, no fetch. It reconciles three sources
// that describe the same open set — the `GET /api/v1/questions` list route, the
// `question.*` runtime events, and optimistic local updates — so these specs pin
// the rules where they can actually regress:
//
//  * a paginated fetch must never make a known row vanish (reconcile asymmetry),
//  * a terminal status must remove the row rather than leave it in the inbox,
//  * grouping order is the asker's `index`, not timestamps.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  QUESTION_STATUSES,
  QUESTION_TERMINAL_STATUSES,
  applyQuestionEvent,
  applyQuestionsFetch,
  canSubmitAnswer,
  createQuestionsState,
  groupHeading,
  groupQuestions,
  isOpenQuestion,
  isTerminalQuestion,
  normalizeAnswerText,
  normalizeContextRefs,
  normalizeQuestionList,
  normalizeQuestionSummary,
  openQuestionCount,
  questionAge,
  reconcileQuestions,
  removeQuestion,
  sortQuestions,
  unreadQuestionCount,
  upsertQuestion,
} from '../../src/client/state/questions-state.mjs';

// The shape `summarizeQuestion()` in questions-store.mjs puts on the open index;
// the list route ships exactly these fields and nothing else.
function summary(overrides = {}) {
  return {
    id: 'q_1',
    groupID: null,
    index: 1,
    status: 'open',
    mode: 'wait',
    sessionID: 'ses_1',
    agentID: 'agent-1',
    text: 'Which database should I target?',
    priority: 'normal',
    askedAt: 1_000,
    askedClock: null,
    readAt: null,
    contextRefs: [],
    ...overrides,
  };
}

test('normalizeQuestionSummary rejects non-object input, a missing id, and empty text', () => {
  // Anything that is not a plain object cannot be a summary.
  for (let value of [ null, undefined, 'q_1', 42, true, [], [ summary() ] ])
    assert.equal(normalizeQuestionSummary(value), null, `${JSON.stringify(value)} must be rejected`);

  // An id is the row key: blank, whitespace-only, missing and non-string all fail.
  for (let overrides of [ {}, { id: '' }, { id: '   ' }, { id: 7 }, { id: null } ])
    assert.equal(normalizeQuestionSummary(summary({ ...overrides, id: overrides.id })), null);

  // The question text is the whole point of the row; an empty body is not a row.
  for (let text of [ '', '   ', '\n\t ', null, undefined, 42 ])
    assert.equal(normalizeQuestionSummary(summary({ text })), null, `text ${JSON.stringify(text)} must be rejected`);

  assert.ok(normalizeQuestionSummary(summary()));
});

test('normalizeQuestionSummary applies the documented defaults', () => {
  let question = normalizeQuestionSummary({ id: 'q_1', text: '  Anything?  ' });

  assert.equal(question.id, 'q_1');
  assert.equal(question.text, 'Anything?', 'text is trimmed before it reaches a renderer');
  assert.equal(question.status, 'open');
  assert.equal(question.mode, 'wait');
  assert.equal(question.priority, 'normal');
  assert.equal(question.index, 1);
  assert.equal(question.groupID, null);
  assert.equal(question.sessionID, null);
  assert.equal(question.agentID, null);
  assert.equal(question.askedAt, 0);
  assert.equal(question.readAt, null);
  assert.deepEqual(question.contextRefs, []);
  assert.equal(question.deleted, false);
});

test('normalizeQuestionSummary keeps valid values and coerces unknown ones to defaults', () => {
  let question = normalizeQuestionSummary(summary({
    status: 'answered',
    mode: 'continue',
    priority: 'high',
    index: 3,
    readAt: 1_500,
    deleted: true,
  }));

  assert.equal(question.status, 'answered');
  assert.equal(question.mode, 'continue');
  assert.equal(question.priority, 'high');
  assert.equal(question.index, 3);
  assert.equal(question.readAt, 1_500);
  assert.equal(question.deleted, true);

  // An unknown value must land on the safe default, never on the wire value.
  assert.equal(normalizeQuestionSummary(summary({ status: 'exploded' })).status, 'open');
  assert.equal(normalizeQuestionSummary(summary({ status: null })).status, 'open');
  assert.equal(normalizeQuestionSummary(summary({ mode: 'steer' })).mode, 'wait');
  assert.equal(normalizeQuestionSummary(summary({ priority: 'urgent' })).priority, 'normal');
  assert.equal(normalizeQuestionSummary(summary({ priority: null })).priority, 'normal');

  // Ordering keys must stay integers: a float or a string would break the sort.
  assert.equal(normalizeQuestionSummary(summary({ index: 1.5 })).index, 1);
  assert.equal(normalizeQuestionSummary(summary({ index: '2' })).index, 1);
  assert.equal(normalizeQuestionSummary(summary({ askedAt: 'soon' })).askedAt, 0);
  assert.equal(normalizeQuestionSummary(summary({ askedAt: Infinity })).askedAt, 0);
});

test('the status tables separate open from terminal', () => {
  assert.deepEqual(QUESTION_STATUSES, [ 'open', 'answered', 'dismissed', 'undeliverable' ]);
  assert.deepEqual(QUESTION_TERMINAL_STATUSES, [ 'answered', 'dismissed', 'undeliverable' ]);

  assert.equal(isOpenQuestion(summary()), true);
  assert.equal(isOpenQuestion(summary({ deleted: true })), false, 'a deleted open row is not open');
  for (let status of QUESTION_TERMINAL_STATUSES) {
    assert.equal(isOpenQuestion(summary({ status })), false);
    assert.equal(isTerminalQuestion(summary({ status })), true);
  }
  assert.equal(isTerminalQuestion(summary()), false);
  assert.equal(isTerminalQuestion(null), false);
});

test('normalizeContextRefs drops refs without both a non-empty type and id', () => {
  // Mirrors normalizeToolReferences (src/core/tools/tool-execution-service.mjs:407):
  // a reference without both halves cannot be clicked through, so it is dropped.
  let refs = normalizeContextRefs([
    { type: 'frame', id: 'frame_1' },
    { type: 'frame' },
    { id: 'frame_2' },
    { type: '', id: 'frame_3' },
    { type: 'frame', id: '   ' },
    { type: 7, id: 'frame_4' },
    { type: 'frame', id: 8 },
    null,
    'frame:frame_5',
    [ ],
    {},
  ]);

  assert.deepEqual(refs, [
    {
      type: 'frame',
      id: 'frame_1',
      label: null,
      sessionID: null,
      frameID: null,
      path: null,
    },
  ]);

  // Non-array input is not an error: callers may see a missing field.
  assert.deepEqual(normalizeContextRefs(undefined), []);
  assert.deepEqual(normalizeContextRefs(null), []);
  assert.deepEqual(normalizeContextRefs({ type: 'frame', id: 'frame_1' }), []);
});

test('normalizeContextRefs keeps the optional display fields and trims them', () => {
  let refs = normalizeContextRefs([
    {
      type: ' frame ',
      id: ' frame_1 ',
      label: '  Tool call  ',
      sessionID: 'ses_1',
      frameID: 'frame_1',
      path: '/home/wyatt/Projects/kikx-workspace/kikx2/src/client/app.mjs',
      extra: 'ignored',
    },
  ]);

  assert.equal(refs.length, 1);
  assert.equal(refs[0].type, 'frame');
  assert.equal(refs[0].id, 'frame_1');
  assert.equal(refs[0].label, 'Tool call');
  assert.equal(refs[0].sessionID, 'ses_1');
  assert.equal(refs[0].frameID, 'frame_1');
  assert.equal(refs[0].path, '/home/wyatt/Projects/kikx-workspace/kikx2/src/client/app.mjs');
  assert.equal(refs[0].extra, undefined, 'an unknown field must not be copied through');
});

test('normalizeQuestionSummary normalizes its context refs', () => {
  let question = normalizeQuestionSummary(summary({
    contextRefs: [ { type: 'frame', id: 'frame_1' }, { type: 'frame' } ],
  }));

  assert.equal(question.contextRefs.length, 1);
  assert.equal(question.contextRefs[0].id, 'frame_1');
});

test('sortQuestions orders oldest askedAt first with an id tie-break', () => {
  let sorted = sortQuestions([
    { id: 'q_c', askedAt: 300 },
    { id: 'q_b', askedAt: 200 },
    { id: 'q_a', askedAt: 200 },
    { id: 'q_d', askedAt: 100 },
  ]);

  assert.deepEqual(sorted.map((question) => question.id), [ 'q_d', 'q_a', 'q_b', 'q_c' ]);

  // The input array must not be reordered in place.
  let input = [ { id: 'q_b', askedAt: 2 }, { id: 'q_a', askedAt: 1 } ];
  assert.deepEqual(sortQuestions(input).map((question) => question.id), [ 'q_a', 'q_b' ]);
  assert.deepEqual(input.map((question) => question.id), [ 'q_b', 'q_a' ]);
});

test('normalizeQuestionList sorts, drops unusable rows, and collapses duplicates by id', () => {
  let questions = normalizeQuestionList([
    summary({ id: 'q_late', askedAt: 300 }),
    summary({ id: 'q_early', askedAt: 100 }),
    summary({ id: 'q_mid', askedAt: 200 }),
    // The first occurrence of an id wins: a later duplicate must not overwrite
    // it, so a closed row cannot be resurrected by a trailing copy.
    summary({ id: 'q_early', askedAt: 100, text: 'duplicate copy' }),
    { id: '', text: 'no id' },
    { id: 'q_notext', text: '  ' },
    null,
  ]);

  assert.deepEqual(questions.map((question) => question.id), [ 'q_early', 'q_mid', 'q_late' ]);
  assert.equal(questions[0].text, 'Which database should I target?');
  assert.notEqual(questions[0].text, 'duplicate copy');

  assert.deepEqual(normalizeQuestionList(undefined), []);
  assert.deepEqual(normalizeQuestionList(null), []);
  assert.deepEqual(normalizeQuestionList({ id: 'q_1' }), []);
});

test('reconcileQuestions with complete:false KEEPS rows the fetch did not return', () => {
  // The Inbox asks for the default page (limit 50). With 60 open questions a
  // paginated fetch sees only 50 of them; dropping the unseen 10 would make
  // them disappear from the UI even though they are still awaiting an answer.
  let existing = [
    summary({ id: 'q_1', askedAt: 100 }),
    summary({ id: 'q_2', askedAt: 200 }),
    summary({ id: 'q_3', askedAt: 300 }),
  ];
  let incoming = [ summary({ id: 'q_1', askedAt: 100 }) ];

  let merged = reconcileQuestions(existing, incoming, { complete: false });

  assert.deepEqual(merged.map((question) => question.id), [ 'q_1', 'q_2', 'q_3' ]);
});

test('reconcileQuestions with complete:true DROPS rows the fetch did not return', () => {
  // A complete fetch is authoritative: an unseen row was answered elsewhere.
  let existing = [
    summary({ id: 'q_1', askedAt: 100 }),
    summary({ id: 'q_2', askedAt: 200 }),
    summary({ id: 'q_3', askedAt: 300 }),
  ];
  let incoming = [ summary({ id: 'q_1', askedAt: 100 }) ];

  let replaced = reconcileQuestions(existing, incoming, { complete: true });

  assert.deepEqual(replaced.map((question) => question.id), [ 'q_1' ]);
});

test('reconcileQuestions defaults to a complete fetch', () => {
  let merged = reconcileQuestions(
    [ summary({ id: 'q_1' }), summary({ id: 'q_2' }) ],
    [ summary({ id: 'q_2' }) ],
  );

  assert.deepEqual(merged.map((question) => question.id), [ 'q_2' ]);
  assert.deepEqual(reconcileQuestions([], []), []);
  assert.deepEqual(reconcileQuestions(), []);
});

test('reconcileQuestions lets the fetch win on content while keeping the merge sorted', () => {
  let existing = [
    summary({ id: 'q_2', askedAt: 200, text: 'stale text' }),
    summary({ id: 'q_1', askedAt: 100 }),
  ];
  let incoming = [
    summary({ id: 'q_2', askedAt: 200, text: 'fresh text' }),
    summary({ id: 'q_3', askedAt: 150 }),
  ];

  let merged = reconcileQuestions(existing, incoming, { complete: false });

  assert.deepEqual(merged.map((question) => question.id), [ 'q_1', 'q_3', 'q_2' ]);
  assert.equal(merged[2].text, 'fresh text', 'the fetched copy replaces the local one');
});

test('reconcileQuestions ignores unusable rows on both sides', () => {
  let merged = reconcileQuestions(
    [ summary({ id: 'q_1' }), { id: 'broken' } ],
    [ { text: 'no id at all' } ],
    { complete: false },
  );

  assert.deepEqual(merged.map((question) => question.id), [ 'q_1' ]);
});

test('upsertQuestion inserts an open row and keeps the list sorted', () => {
  let questions = upsertQuestion(
    [ summary({ id: 'q_1', askedAt: 100 }), summary({ id: 'q_3', askedAt: 300 }) ],
    summary({ id: 'q_2', askedAt: 200, text: 'Newly asked' }),
  );

  assert.deepEqual(questions.map((question) => question.id), [ 'q_1', 'q_2', 'q_3' ]);
  assert.equal(questions[1].text, 'Newly asked');
});

test('upsertQuestion updates an existing open row in place instead of duplicating it', () => {
  let questions = upsertQuestion(
    [ summary({ id: 'q_1', askedAt: 100, text: 'before' }) ],
    summary({ id: 'q_1', askedAt: 100, text: 'after' }),
  );

  assert.equal(questions.length, 1);
  assert.equal(questions[0].text, 'after');
});

test('upsertQuestion REMOVES the id for every terminal status', () => {
  // The Inbox lists what still awaits an answer; an answered/dismissed/
  // undeliverable row must leave the open set, not linger as a stale card.
  for (let status of [ 'answered', 'dismissed', 'undeliverable' ]) {
    let questions = upsertQuestion(
      [ summary({ id: 'q_1', askedAt: 100 }), summary({ id: 'q_2', askedAt: 200 }) ],
      summary({ id: 'q_1', askedAt: 100, status }),
    );

    assert.deepEqual(questions.map((question) => question.id), [ 'q_2' ], `status ${status} must remove q_1`);
  }
});

test('upsertQuestion also removes a soft-deleted open row', () => {
  let questions = upsertQuestion(
    [ summary({ id: 'q_1' }) ],
    summary({ id: 'q_1', deleted: true }),
  );

  assert.deepEqual(questions, []);
});

test('upsertQuestion leaves the list untouched for an unusable update', () => {
  let existing = [ summary({ id: 'q_1', askedAt: 100 }), summary({ id: 'q_2', askedAt: 200 }) ];

  for (let update of [ null, undefined, {}, { id: 'q_x', text: '   ' }, { text: 'no id' } ]) {
    let questions = upsertQuestion(existing, update);
    assert.deepEqual(questions.map((question) => question.id), [ 'q_1', 'q_2' ], `update ${JSON.stringify(update)}`);
  }

  assert.deepEqual(upsertQuestion(undefined, summary({ id: 'q_9' })).map((question) => question.id), [ 'q_9' ]);
});

test('removeQuestion drops one id and tolerates a blank one', () => {
  let existing = [ summary({ id: 'q_1' }), summary({ id: 'q_2' }) ];

  assert.deepEqual(removeQuestion(existing, 'q_1').map((question) => question.id), [ 'q_2' ]);
  assert.deepEqual(removeQuestion(existing, 'q_missing').map((question) => question.id), [ 'q_1', 'q_2' ]);
  assert.deepEqual(removeQuestion(existing, '').map((question) => question.id), [ 'q_1', 'q_2' ]);
  assert.deepEqual(removeQuestion(existing, null).map((question) => question.id), [ 'q_1', 'q_2' ]);
});

test('groupQuestions groups shared groupID rows and orders them by index', () => {
  // [D-3]: a batch is one flow. The asker's `index` is authoritative inside the
  // group even when the timestamps disagree (they are stamped milliseconds apart).
  let groups = groupQuestions([
    summary({ id: 'q_2', groupID: 'grp_1', index: 2, askedAt: 200, agentID: 'agent-1' }),
    summary({ id: 'q_1', groupID: 'grp_1', index: 1, askedAt: 300, agentID: 'agent-1' }),
    summary({ id: 'q_3', groupID: 'grp_1', index: 3, askedAt: 100, agentID: 'agent-1' }),
  ]);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].groupID, 'grp_1');
  assert.equal(groups[0].agentID, 'agent-1');
  assert.deepEqual(groups[0].questions.map((question) => question.id), [ 'q_1', 'q_2', 'q_3' ]);
});

test('groupQuestions makes each ungrouped row its own group', () => {
  let groups = groupQuestions([
    summary({ id: 'q_1', askedAt: 100, agentID: 'agent-1' }),
    summary({ id: 'q_2', groupID: 'grp_1', index: 1, askedAt: 200 }),
    summary({ id: 'q_3', groupID: 'grp_1', index: 2, askedAt: 200 }),
  ]);

  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].questions.map((question) => question.id), [ 'q_1' ]);
  assert.equal(groups[0].groupID, null);
  assert.deepEqual(groups[1].questions.map((question) => question.id), [ 'q_2', 'q_3' ]);
});

test('groupQuestions orders groups by their oldest member', () => {
  // The inbox stays oldest-first at the group level even when a later batch has
  // an earlier index; `oldestAskedAt` is the sort key.
  let groups = groupQuestions([
    summary({ id: 'q_new_1', groupID: 'grp_new', index: 1, askedAt: 500 }),
    summary({ id: 'q_new_2', groupID: 'grp_new', index: 2, askedAt: 900 }),
    summary({ id: 'q_old', askedAt: 100 }),
  ]);

  assert.deepEqual(groups.map((group) => group.key), [ 'q_old', 'grp_new' ]);
  assert.equal(groups[1].oldestAskedAt, 500);
});

test('groupQuestions tolerates no rows and unusable rows', () => {
  assert.deepEqual(groupQuestions([]), []);
  assert.deepEqual(groupQuestions(undefined), []);
  assert.deepEqual(groupQuestions([ { id: '' }, null ]), []);
});

test('groupHeading is null for a single question and descriptive for a batch', () => {
  let single = groupQuestions([ summary({ id: 'q_1', agentID: 'agent-1' }) ])[0];
  let batch = groupQuestions([
    summary({ id: 'q_1', groupID: 'grp_1', index: 1, agentID: 'agent-1' }),
    summary({ id: 'q_2', groupID: 'grp_1', index: 2, agentID: 'agent-1' }),
  ])[0];

  assert.equal(groupHeading(single), null, 'a lone question needs no batch heading');
  assert.equal(groupHeading(batch), 'Waiting on you · 2 questions from agent-1');
  assert.equal(groupHeading(null), null);
  assert.equal(groupHeading({}), null);
  assert.equal(groupHeading({ questions: [] }), null);
});

test('groupHeading omits the agent clause when the asker is unknown', () => {
  let group = groupQuestions([
    summary({ id: 'q_1', groupID: 'grp_1', index: 1, agentID: null }),
    summary({ id: 'q_2', groupID: 'grp_1', index: 2, agentID: null }),
  ])[0];

  assert.equal(groupHeading(group), 'Waiting on you · 2 questions');
});

test('unreadQuestionCount and openQuestionCount separate unread from open', () => {
  let questions = [
    summary({ id: 'q_unread_1', status: 'open', readAt: null }),
    summary({ id: 'q_unread_2', status: 'open' }),
    summary({ id: 'q_read', status: 'open', readAt: 1_500 }),
    summary({ id: 'q_answered', status: 'answered' }),
    summary({ id: 'q_dismissed', status: 'dismissed' }),
    summary({ id: 'q_deleted', status: 'open', deleted: true }),
  ];

  assert.equal(openQuestionCount(questions), 3, 'open = status open and not deleted');
  assert.equal(unreadQuestionCount(questions), 2, 'a read row still lists but no longer badges');

  assert.equal(openQuestionCount([]), 0);
  assert.equal(unreadQuestionCount([]), 0);
  assert.equal(openQuestionCount(undefined), 0);
  assert.equal(unreadQuestionCount([ { id: 'broken' }, null ]), 0);
});

test('questionAge returns null when there is no usable timestamp', () => {
  let now = 1_700_000_000_000;

  // A missing or zero stamp must produce no label at all rather than "1970".
  for (let askedAt of [ undefined, null, 0, -1, NaN, Infinity, '1000', {} ])
    assert.equal(questionAge(askedAt, now), null, `askedAt ${String(askedAt)} must yield null`);
});

test('questionAge returns null for a future timestamp', () => {
  // A clock skew (server ahead of the browser) or a bad stamp must not print an
  // age label; there is no honest value to show for a question asked in the
  // future. The module's own docstring promises exactly this.
  let now = 1_700_000_000_000;

  assert.equal(questionAge(now + 1_000, now), null);
  assert.equal(questionAge(now + 60_000, now), null);
  assert.equal(questionAge(now + 31_536_000_000, now), null);
});

test('questionAge buckets seconds, minutes, hours, days and weeks', () => {
  let now = 1_700_000_000_000;

  assert.equal(questionAge(now - 1_000, now), 'now');
  assert.equal(questionAge(now - 4_999, now), 'now');
  assert.equal(questionAge(now - 5_000, now), '5s');
  assert.equal(questionAge(now - 45_000, now), '45s');
  assert.equal(questionAge(now - 90_000, now), '1m');
  assert.equal(questionAge(now - 3_600_000, now), '1h');
  assert.equal(questionAge(now - 259_200_000, now), '3d');
  assert.equal(questionAge(now - 864_000_000, now), '1w');
});

test('canSubmitAnswer rejects blank input and accepts real text', () => {
  // [D-4]: free-form only, so the single validation is "not empty".
  for (let value of [ '', '   ', '\n\t ', null, undefined, 42, {} ])
    assert.equal(canSubmitAnswer(value), false, `${JSON.stringify(value)} must not submit`);

  assert.equal(canSubmitAnswer('yes'), true);
  assert.equal(canSubmitAnswer('  1m  '), true);

  // The submitted text is trimmed, which is what the answer route expects.
  assert.equal(normalizeAnswerText('  because B  '), 'because B');
  assert.equal(normalizeAnswerText(null), '');
  assert.equal(normalizeAnswerText(42), '');
});

test('createQuestionsState starts empty and unloaded', () => {
  let state = createQuestionsState();

  // `closedQuestionIDs` is asserted separately because it is a Set: deepEqual
  // compares Sets by content, so folding it into the literal below would still
  // pin the exact shape while hiding that the field must be live and mutable.
  assert.deepEqual(
    { ...state, closedQuestionIDs: undefined },
    {
      questions: [],
      counts: { open: 0 },
      loaded: false,
      loading: false,
      error: null,
      lastFetchedAt: null,
      closedQuestionIDs: undefined,
    },
  );

  assert.ok(state.closedQuestionIDs instanceof Set, 'the closed-id guard must exist on a fresh slice');
  assert.equal(state.closedQuestionIDs.size, 0, 'a fresh slice knows of no closed questions');
  assert.notEqual(
    createQuestionsState().closedQuestionIDs,
    createQuestionsState().closedQuestionIDs,
    'each slice owns its own set — a shared one would leak closures across tabs',
  );
});

test('applyQuestionsFetch sets loaded, clears the error, and recounts', () => {
  let state = createQuestionsState();
  state.loading = true;
  state.error = 'network down';

  let result = applyQuestionsFetch(
    state,
    { questions: [ summary({ id: 'q_1' }), summary({ id: 'q_2', status: 'answered' }) ], counts: { open: 99 } },
    { now: 1_700_000_000_000 },
  );

  assert.equal(result, state, 'the slice is mutated in place so ReactiveState sees one assignment');
  assert.equal(state.loaded, true);
  assert.equal(state.loading, false);
  assert.equal(state.error, null, 'a successful fetch must clear a previous error');
  assert.equal(state.lastFetchedAt, 1_700_000_000_000);
  assert.deepEqual(state.questions.map((question) => question.id), [ 'q_1', 'q_2' ]);
  // The server count is not trusted: the slice recounts locally from the rows
  // it actually holds, so a stale page cannot claim questions it did not show.
  assert.deepEqual(state.counts, { open: 1 });
});

test('applyQuestionsFetch merges unknown server counters but keeps its own open count', () => {
  let state = createQuestionsState();

  applyQuestionsFetch(state, {
    questions: [ summary({ id: 'q_1' }) ],
    counts: { open: 42, unread: 3 },
  }, { now: 1 });

  assert.equal(state.counts.open, 1);
  assert.equal(state.counts.unread, 3);
});

test('applyQuestionsFetch with complete:false keeps locally-known rows', () => {
  let state = createQuestionsState();
  state.questions = normalizeQuestionList([ summary({ id: 'q_1', askedAt: 100 }), summary({ id: 'q_2', askedAt: 200 }) ]);

  applyQuestionsFetch(state, { questions: [ summary({ id: 'q_1', askedAt: 100 }) ] }, { complete: false, now: 1 });

  assert.deepEqual(state.questions.map((question) => question.id), [ 'q_1', 'q_2' ]);
  assert.equal(state.counts.open, 2);
});

test('applyQuestionsFetch tolerates an empty or malformed payload', () => {
  let state = createQuestionsState();

  applyQuestionsFetch(state, undefined, { now: 1 });
  assert.equal(state.loaded, true);
  assert.deepEqual(state.questions, []);

  applyQuestionsFetch(state, { questions: 'nope' }, { now: 2 });
  assert.deepEqual(state.questions, []);
  assert.equal(state.counts.open, 0);

  // A missing slice is not a crash: the helper returns what it was given.
  assert.equal(applyQuestionsFetch(null, { questions: [] }), null);
});

test('applyQuestionEvent removes the row when the question is answered', () => {
  // This is the event the answer loop emits (question-wake.mjs:100), wrapped by
  // kikx-runtime-events.mjs as `{ type, payload: data }`.
  let state = createQuestionsState();
  state.questions = normalizeQuestionList([
    summary({ id: 'q_1', askedAt: 100 }),
    summary({ id: 'q_2', askedAt: 200, groupID: 'grp_1', index: 2 }),
  ]);
  state.counts = { open: 2 };

  let result = applyQuestionEvent(state, {
    type: 'question.answered',
    payload: {
      type: 'question.answered',
      sessionID: 'ses_1',
      question: summary({ id: 'q_1', status: 'answered', askedAt: 100 }),
      frameID: 'frame_1',
      wakeFrameID: 'frame_1',
    },
  });

  assert.equal(result, state);
  assert.deepEqual(state.questions.map((question) => question.id), [ 'q_2' ]);
  assert.equal(state.counts.open, 1, 'the badge count follows the removal');
});

test('applyQuestionEvent removes a row that became undeliverable', () => {
  let state = createQuestionsState();
  state.questions = normalizeQuestionList([ summary({ id: 'q_1' }) ]);

  applyQuestionEvent(state, {
    type: 'question.updated',
    payload: { sessionID: 'ses_1', question: summary({ id: 'q_1', status: 'undeliverable' }), reason: 'agent deleted' },
  });

  assert.deepEqual(state.questions, []);
  assert.equal(state.counts.open, 0);
});

test('applyQuestionEvent inserts a question from a single-question payload', () => {
  let state = createQuestionsState();

  applyQuestionEvent(state, {
    type: 'question.asked',
    payload: { sessionID: 'ses_1', question: summary({ id: 'q_1', text: 'From the inline frame?', askedAt: 1_000 }) },
  });

  assert.deepEqual(state.questions.map((question) => question.id), [ 'q_1' ]);
  assert.equal(state.counts.open, 1);
});

test('applyQuestionEvent inserts every question from the real question.asked payload', () => {
  // The producer (src/core/tools/ask-user-tool.mjs:147) emits the batch under
  // `questions: [...]` — one entry per question — and frame-runtime adds only a
  // `type` field on top (frame-runtime.mjs:441). A live ask must therefore
  // populate the Inbox from that array; otherwise a question asked while the
  // tab is open stays invisible until the next full fetch.
  let state = createQuestionsState();

  applyQuestionEvent(state, {
    type: 'question.asked',
    payload: {
      type: 'question.asked',
      sessionID: 'ses_1',
      agentID: 'agent-1',
      groupID: 'grp_1',
      questionIDs: [ 'q_1', 'q_2' ],
      questions: [
        { id: 'q_1', text: 'First?', priority: 'normal', status: 'open', mode: 'wait', askedAt: 100, sessionID: 'ses_1', agentID: 'agent-1' },
        { id: 'q_2', text: 'Second?', priority: 'high', status: 'open', mode: 'wait', askedAt: 200, sessionID: 'ses_1', agentID: 'agent-1' },
      ],
    },
  });

  assert.deepEqual(state.questions.map((question) => question.id), [ 'q_1', 'q_2' ]);
  assert.equal(state.counts.open, 2);
});

test('applyQuestionEvent ignores unknown event types and missing state', () => {
  let state = createQuestionsState();
  state.questions = normalizeQuestionList([ summary({ id: 'q_1' }) ]);
  state.counts = { open: 1 };

  let before = state.questions;
  applyQuestionEvent(state, { type: 'session.saved', payload: { sessionID: 'ses_1' } });

  assert.equal(state.questions, before, 'an unrelated event must not touch the list');
  assert.deepEqual(state.counts, { open: 1 });

  assert.equal(applyQuestionEvent(null, { type: 'question.asked' }), null);
  assert.equal(applyQuestionEvent(state, null), state);
});

test('applyQuestionEvent accepts a bare event object without a payload wrapper', () => {
  let state = createQuestionsState();

  applyQuestionEvent(state, { type: 'question.asked', question: summary({ id: 'q_1', askedAt: 100 }) });

  assert.deepEqual(state.questions.map((question) => question.id), [ 'q_1' ]);
});
