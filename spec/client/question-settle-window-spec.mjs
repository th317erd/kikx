'use strict';

// The receipt window for a settled question.
//
// Three behaviours are pinned here, and each one corresponds to a failure the
// Inbox actually had:
//
//  1. Answering or dismissing used to DELETE the row, so there was no "You
//     replied." and no "Dismissed" — the row simply vanished. A settled row must
//     survive long enough to be read.
//  2. The row must leave on its own afterwards, or a long-lived tab fills up
//     with archaeology.
//  3. Expiry is decided by a deadline in the data, not by a timer owned by a
//     view. That is what makes it safe against a repaint, a backgrounded tab and
//     a rebuild: none of them can resurrect a receipt that is already spent.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createQuestionsState,
  applyQuestionsFetch,
  expiredSettledQuestions,
  isSettledPendingRetirement,
  isVisibleInboxQuestion,
  retireQuestion,
  settleQuestion,
} from '../../src/client/state/questions-state.mjs';
import {
  applyLocalAnswer,
  applyLocalDismiss,
} from '../../src/client/state/questions-local-state.mjs';

const WINDOW = 60000;

function question(overrides = {}) {
  return {
    id: 'q_1',
    text: 'Which database should we use?',
    status: 'open',
    askedAt: 1000,
    ...overrides,
  };
}

test('settling without a window removes the row, exactly as closing used to', () => {
  let state = createQuestionsState();
  state.questions = [ question() ];

  applyLocalAnswer(state, 'q_1');

  assert.deepEqual(state.questions, [], 'no window requested means no receipt, so the row goes');
});

test('a settled row is kept and carries its deadline while the window runs', () => {
  let state = createQuestionsState();
  state.questions = [ question() ];

  applyLocalAnswer(state, 'q_1', { settleAfter: WINDOW });

  let retained = state.questions.find((entry) => entry.id === 'q_1');
  assert.ok(retained, 'the row is retained so the receipt can be rendered');
  assert.equal(retained.status, 'answered');
  assert.equal(retained.settleAfter, WINDOW);
  assert.ok(retained.closedAt > 0, 'the deadline needs a start time');
  assert.ok(isSettledPendingRetirement(retained), 'it is a pending-retirement row');
  assert.equal(isVisibleInboxQuestion(retained, retained.closedAt + WINDOW - 1), true,
    'it stays visible for the whole window');
  assert.equal(isVisibleInboxQuestion(retained, retained.closedAt + WINDOW), false,
    'it is gone the moment the window closes');
});

test('the badge and the count drop immediately even though the row stays', () => {
  let state = createQuestionsState();
  state.questions = [ question(), question({ id: 'q_2' }) ];
  state.counts = { open: 2 };

  applyLocalAnswer(state, 'q_1', { settleAfter: WINDOW });

  // This is the whole point of distinguishing "terminal" from "deleted": the row
  // is still on screen, but it must not be counted as awaiting an answer.
  assert.equal(state.counts.open, 1, 'a settled row is not open');
  assert.equal(state.questions.filter((entry) => entry.status === 'open').length, 1);
});

test('a dismissal is retained too, with its own status', () => {
  let state = createQuestionsState();
  state.questions = [ question() ];

  applyLocalDismiss(state, 'q_1', { settleAfter: WINDOW });

  let retained = state.questions.find((entry) => entry.id === 'q_1');
  assert.ok(retained);
  assert.equal(retained.status, 'dismissed', 'a dismissal is not an answer');
  assert.ok(isSettledPendingRetirement(retained));
});

test('only rows whose deadline has passed are reported as expired', () => {
  let state = createQuestionsState();
  state.questions = [ question(), question({ id: 'q_2' }) ];
  applyLocalAnswer(state, 'q_1', { settleAfter: WINDOW });

  let closedAt = state.questions.find((entry) => entry.id === 'q_1').closedAt;

  assert.deepEqual(expiredSettledQuestions(state.questions, closedAt), [],
    'nothing expires before its window ends');
  assert.deepEqual(expiredSettledQuestions(state.questions, closedAt + WINDOW), [ 'q_1' ],
    'the settled row expires when its window ends');
});

test('an open question never expires, however old it is', () => {
  let state = createQuestionsState();
  state.questions = [ question({ askedAt: 0 }) ];

  assert.deepEqual(expiredSettledQuestions(state.questions, Number.MAX_SAFE_INTEGER), [],
    'a long-unanswered question is still waiting on the user, not stale');
});

test('retiring an expired row leaves the others alone', () => {
  let state = createQuestionsState();
  state.questions = [ question(), question({ id: 'q_2' }) ];
  applyLocalAnswer(state, 'q_1', { settleAfter: WINDOW });

  state.questions = retireQuestion(state.questions, 'q_1');

  assert.deepEqual(state.questions.map((entry) => entry.id), [ 'q_2' ]);
});

test('a stale fetch cannot resurrect an expired receipt', () => {
  // The failure this guards: a fetch that was in flight while the receipt ran
  // lands afterwards carrying the question as open, and the row comes back.
  let state = createQuestionsState();
  state.questions = [ question() ];
  applyLocalAnswer(state, 'q_1', { settleAfter: WINDOW });

  let closedAt = state.questions.find((entry) => entry.id === 'q_1').closedAt;
  state.questions = retireQuestion(state.questions, 'q_1');

  applyQuestionsFetch(state, { questions: [ question() ] }, { complete: true });

  assert.deepEqual(state.questions, [],
    'the closed-id record outlives the row, so a late fetch cannot put it back');
  assert.ok(closedAt > 0);
});

test('settling an unknown id is a no-op rather than a crash', () => {
  let state = createQuestionsState();
  state.questions = [ question() ];

  applyLocalAnswer(state, 'q_missing', { settleAfter: WINDOW });
  applyLocalAnswer(state, '', { settleAfter: WINDOW });

  assert.deepEqual(state.questions.map((entry) => entry.id), [ 'q_1' ]);
});

test('settleQuestion keeps a terminal row terminal', () => {
  let rows = settleQuestion([ question() ], 'q_1', { status: 'answered', settleAfter: WINDOW });
  assert.equal(rows[0].status, 'answered');

  // A second settle (an event arriving after the user's own action) must not
  // quietly reopen it.
  rows = settleQuestion(rows, 'q_1', { status: 'dismissed', settleAfter: WINDOW });
  assert.equal(rows[0].status, 'dismissed');
  assert.equal(isVisibleInboxQuestion(rows[0], rows[0].closedAt + 1), true);
});
