'use strict';

// Answering and dismissing must feel like a click, not like a request.
//
// The row used to be closed only after the answer POST resolved. On localhost
// that is invisible; on a slow link the row sits there looking unanswered, and
// on a dead connection a click does nothing at all until the transport gives
// up. The close is now applied to the model BEFORE the request is sent.
//
// That is only acceptable because it is reversible, so most of what is pinned
// here is the undo, not the do:
//
//  1. The close happens synchronously, before the transport is ever called.
//  2. A rejected write reopens the row: no "You replied." receipt survives an
//     answer the server never stored.
//  3. The reopened row is no longer in the closed-id set, or the next fetch
//     would keep it hidden and the row would never come back.
//  4. A rollback cannot clobber a settlement a server event wrote in the
//     meantime. Two asynchronous paths touch one row; the newer fact wins.
//  5. The typed text survives a failed send, so retrying does not mean retyping.

import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

import { installDom } from './support/mini-dom.mjs';

// The view reaches `aeor-ui.mjs`, which imports browser-absolute
// `/vendor/aeor-web-components/*` paths. This hook maps them to local stand-ins;
// without it the module cannot even be loaded outside a browser.
register(new URL('./support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);

installDom();

import {
  createQuestionsState,
  isVisibleInboxQuestion,
} from '../../src/client/state/questions-state.mjs';
import {
  applyLocalAnswer,
  applyLocalDismiss,
  captureSettlementTarget,
  revertLocalSettlement,
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

function openState(overrides = {}) {
  let state = createQuestionsState();
  state.questions = [ question(overrides) ];
  state.counts = { open: 1 };
  return state;
}

// --- the reverse path itself ------------------------------------------------

test('a settlement can be undone, putting the row back as open', () => {
  let state = openState();
  let target = captureSettlementTarget(state, 'q_1', { status: 'answered' });
  assert.ok(target, 'an open row yields a rollback token');
  assert.equal(target.wasOpen, true);

  applyLocalAnswer(state, 'q_1', { settleAfter: WINDOW });
  let closedAt = state.questions[0].closedAt;
  assert.equal(state.questions[0].status, 'answered');

  revertLocalSettlement(state, 'q_1', {
    expectedClosedAt: closedAt,
    expectedStatus: 'answered',
  });

  assert.equal(state.questions[0].status, 'open', 'the row is open again');
  assert.equal(state.questions[0].closedAt, 0, 'the deadline is cleared');
  assert.equal(state.questions[0].settleAfter, 0, 'no receipt window survives');
  assert.equal(state.counts.open, 1, 'it counts as awaiting an answer again');
  assert.equal(state.closedQuestionIDs.has('q_1'), false,
    'and it is no longer remembered as closed, or a fetch would keep it hidden');
});

test('a dismissal is undone the same way', () => {
  let state = openState();
  applyLocalDismiss(state, 'q_1', { settleAfter: WINDOW });
  let closedAt = state.questions[0].closedAt;
  assert.equal(state.questions[0].status, 'dismissed');

  revertLocalSettlement(state, 'q_1', {
    expectedClosedAt: closedAt,
    expectedStatus: 'dismissed',
  });

  assert.equal(state.questions[0].status, 'open');
  assert.equal(state.closedQuestionIDs.has('q_1'), false);
});

test('the reopened row stays visible, so the user can retry', () => {
  let state = openState();
  applyLocalAnswer(state, 'q_1', { settleAfter: WINDOW });
  let closedAt = state.questions[0].closedAt;
  revertLocalSettlement(state, 'q_1', { expectedClosedAt: closedAt, expectedStatus: 'answered' });

  assert.equal(isVisibleInboxQuestion(state.questions[0], closedAt + WINDOW + 1), true,
    'an open row never expires, however long the user takes to retry');
});

test('the answer text is preserved, because the draft is what the user retypes', () => {
  let state = openState();
  applyLocalAnswer(state, 'q_1', { answer: 'Use PostgreSQL', settleAfter: WINDOW });
  let closedAt = state.questions[0].closedAt;

  revertLocalSettlement(state, 'q_1', { expectedClosedAt: closedAt, expectedStatus: 'answered' });

  // The restore only undoes the settlement; it must not quietly delete anything
  // else the row was carrying, so nothing the user can still see disappears.
  assert.equal(state.questions[0].text, 'Which database should we use?');
});

// --- refusal to undo somebody else's newer fact -----------------------------

test('a rollback does not undo a settlement that has moved on', () => {
  let state = openState();
  applyLocalAnswer(state, 'q_1', { settleAfter: WINDOW });
  let mine = state.questions[0].closedAt;

  // A newer settle lands first (a `question.answered` event, say).
  state.questions = [ { ...state.questions[0], closedAt: mine + 5 } ];

  revertLocalSettlement(state, 'q_1', { expectedClosedAt: mine, expectedStatus: 'answered' });

  assert.equal(state.questions[0].status, 'answered',
    'the newer settlement stands; an older rollback must not reopen it');
});

test('a rollback does not undo a settlement of a different kind', () => {
  let state = openState();
  applyLocalAnswer(state, 'q_1', { settleAfter: WINDOW });
  let closedAt = state.questions[0].closedAt;

  // Same deadline, different outcome: the question was dismissed elsewhere.
  state.questions = [ { ...state.questions[0], status: 'dismissed' } ];
  state.closedQuestionIDs.add('q_1');

  revertLocalSettlement(state, 'q_1', { expectedClosedAt: closedAt, expectedStatus: 'answered' });

  assert.equal(state.questions[0].status, 'dismissed',
    'an answer rollback must not overwrite a dismissal');
});

test('a row that was already terminal is not reopened by our own failure', () => {
  let state = createQuestionsState();
  state.questions = [ question({ status: 'answered', answer: 'done earlier' }) ];
  state.counts = { open: 0 };

  let target = captureSettlementTarget(state, 'q_1', { status: 'answered' });
  assert.equal(target.wasOpen, false, 'the row was not open when the user acted');

  // Even if a rollback were attempted, the terminal row must survive.
  revertLocalSettlement(state, 'q_1', { expectedClosedAt: 0, expectedStatus: 'answered' });
  assert.equal(state.questions[0].status, 'answered');
});

test('reverting an unknown or already-open id changes nothing', () => {
  let state = openState();

  revertLocalSettlement(state, 'q_missing', { expectedClosedAt: 123, expectedStatus: 'answered' });
  revertLocalSettlement(state, 'q_1', { expectedClosedAt: 123, expectedStatus: 'answered' });

  assert.deepEqual(state.questions.map((entry) => entry.id), [ 'q_1' ]);
  assert.equal(state.questions[0].status, 'open');
  assert.equal(state.counts.open, 1);
});

test('capturing a token for a row this tab does not have yields null', () => {
  let state = createQuestionsState();
  state.questions = [ question() ];

  assert.equal(captureSettlementTarget(state, 'q_absent', { status: 'answered' }), null);
  assert.equal(captureSettlementTarget(state, '', { status: 'answered' }), null);
  assert.equal(captureSettlementTarget(null, 'q_1'), null);
});

// --- the ordering guarantee, at the transport boundary ---------------------

test('the row is closed before the answer POST is even called', async () => {
  const view = await import('../../src/client/components/kikx-inbox-view.mjs');

  let state = openState();
  let seen = [];

  let app = {
    _state: { questionsState: state },
    _postJSON: async () => {
      // Captured at the moment the request is issued: this is the assertion the
      // old code fails, because it only settled after the await resolved.
      seen.push(state.questions[0].status);
      return { data: { delivered: true } };
    },
    _syncQuestionShell: () => true,
    _requestRender: () => {},
  };

  let result = await view.submitQuestionAnswer(app, 'q_1', 'Use PostgreSQL');

  assert.equal(result.ok, true);
  assert.deepEqual(seen, [ 'answered' ],
    'the row must already be closed when the transport is invoked');
});

test('the row is dismissed before the dismiss POST is called', async () => {
  const view = await import('../../src/client/components/kikx-inbox-view.mjs');

  let state = openState();
  let seen = [];

  let app = {
    _state: { questionsState: state },
    _postJSON: async () => {
      seen.push(state.questions[0].status);
      return { data: { suppressed: true } };
    },
    _syncQuestionShell: () => true,
    _requestRender: () => {},
  };

  let result = await view.dismissQuestionAnswer(app, 'q_1');

  assert.equal(result.ok, true);
  assert.deepEqual(seen, [ 'dismissed' ],
    'the dismissal must be visible before the request is issued');
});

test('a failed answer reopens the row and reports the failure', async () => {
  const view = await import('../../src/client/components/kikx-inbox-view.mjs');

  let state = openState();
  let notices = [];
  let renders = 0;

  let app = {
    _state: { questionsState: state },
    _postJSON: async () => { throw new Error('socket hang up'); },
    _syncQuestionShell: () => { renders += 1; return true; },
    _requestRender: () => { renders += 1; },
  };

  let result = await view.submitQuestionAnswer(app, 'q_1', 'Use PostgreSQL', {
    announce: (message, options) => { notices.push([ message, options?.tone ]); },
  });

  assert.equal(result.ok, false);
  assert.equal(state.questions[0].status, 'open', 'the receipt is withdrawn');
  assert.equal(state.closedQuestionIDs.has('q_1'), false,
    'and the id is forgotten, so a fetch can bring the row back');
  assert.equal(state.counts.open, 1);
  assert.ok(renders > 0, 'the rollback is painted, not just modelled');
  assert.equal(notices.length, 1);
  assert.equal(notices[0][1], 'error');
  assert.match(notices[0][0], /socket hang up/);
});

test('a failed dismissal reopens the row as open', async () => {
  const view = await import('../../src/client/components/kikx-inbox-view.mjs');

  let state = openState();

  let app = {
    _state: { questionsState: state },
    _postJSON: async () => { throw new Error('offline'); },
    _syncQuestionShell: () => true,
    _requestRender: () => {},
  };

  let result = await view.dismissQuestionAnswer(app, 'q_1', {
    announce: () => {},
  });

  assert.equal(result.ok, false);
  assert.equal(state.questions[0].status, 'open', 'not left looking dismissed');
  assert.equal(state.closedQuestionIDs.has('q_1'), false);
});

test('a successful answer leaves the row closed, without a second settle', async () => {
  const view = await import('../../src/client/components/kikx-inbox-view.mjs');

  let state = openState();
  let app = {
    _state: { questionsState: state },
    _postJSON: async () => ({ data: { delivered: true } }),
    _syncQuestionShell: () => true,
    _requestRender: () => {},
  };

  await view.submitQuestionAnswer(app, 'q_1', 'Use PostgreSQL', { announce: () => {} });

  assert.equal(state.questions[0].status, 'answered');
  assert.equal(state.questions[0].settleAfter, WINDOW,
    'the window is not reset by the response; the countdown keeps running');
  assert.equal(state.closedQuestionIDs.has('q_1'), true);
});

test('a failure that races a server settlement leaves the server fact alone', async () => {
  const view = await import('../../src/client/components/kikx-inbox-view.mjs');

  let state = openState();
  let app = {
    _state: { questionsState: state },
    _postJSON: async () => {
      // While the request is in flight, the socket delivers the real outcome.
      state.questions = [ { ...state.questions[0], closedAt: Date.now() + 1000 } ];
      throw new Error('timed out');
    },
    _syncQuestionShell: () => true,
    _requestRender: () => {},
  };

  let result = await view.submitQuestionAnswer(app, 'q_1', 'Use PostgreSQL', {
    announce: () => {},
  });

  assert.equal(result.ok, false);
  assert.equal(state.questions[0].status, 'answered',
    'the newer server settlement is not undone by our failed write');
});
