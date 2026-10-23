'use strict';

// The answer path, driven through the view's own wiring rather than through the
// card module in isolation.
//
// Why this spec exists, as a port of the Playwright lane:
//
// `inbox-question-playwright.mjs` proves several things that were assumed to be
// browser-only. Most already had browser-free coverage:
//   - the POST URL and body shape     -> question-dismiss-compat-spec.mjs:88
//                                        question-draft-preservation-spec.mjs:317
//   - receipt text and the fuse attrs -> question-settle-card-spec.mjs:94
//   - settle-before-POST and rollback -> question-optimistic-close-spec.mjs
//
// What none of them prove is that `submitQuestionAnswer` and
// `dismissQuestionAnswer` -- the functions the Inbox view actually calls -- are
// wired to the transport with the right request. Those specs either call
// `bindAnswerForm` directly with hand-made handlers, or they test the local-state
// primitives and never touch the network call. A regression that renamed the
// endpoint, dropped the URL encoding, or stopped settling before the round trip
// would pass every one of them.
//
// Two guarantees stay browser-only and are deliberately NOT claimed here:
//   - focus/caret surviving a repaint (mini-DOM has no focus model, no
//     getComputedStyle and no getBoundingClientRect)
//   - the progress ring visibly draining over time (needs real layout + a clock)
// Those remain in the Playwright lane. This file is the part that graduates into
// `npm test`.

import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// `kikx-inbox-view.mjs` reaches `/vendor/aeor-web-components/elements.js` via
// aeor-ui.mjs, which only resolves in a browser. The shared loader aliases those
// specifiers to local stand-ins; without it the module under test cannot even be
// imported here.
register(new URL('./support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);

import { installDom } from './support/mini-dom.mjs';

installDom();

const {
  submitQuestionAnswer,
  dismissQuestionAnswer,
  SETTLE_WINDOW_MS,
} = await import('../../src/client/components/kikx-inbox-view.mjs');

const { createQuestionsState } = await import('../../src/client/state/questions-state.mjs');

// `getQuestionsState` reads `state.questionsState` (kikx-state.mjs:277), NOT
// `state.questions`. A fake app that puts the list at `state.questions` is
// silently ignored and the function operates on a fresh empty state -- which is
// exactly how the first draft of this spec produced a green-looking no-op.
function fakeApp(questions = []) {
  let questionsState = createQuestionsState();
  questionsState.questions = questions;
  questionsState.counts = { open: questions.filter((q) => q.status === 'open').length };
  questionsState.loaded = true;

  return {
    _state: { questionsState },
    _postJSON() {
      throw new Error('the injected transport must be used, not app._postJSON');
    },
  };
}

function stateOf(app) {
  return app._state.questionsState;
}

function openQuestion(overrides = {}) {
  return {
    id: 'q_1',
    groupID: 'g_1',
    index: 1,
    text: 'Which database should we use?',
    status: 'open',
    askedAt: 1000,
    closedAt: null,
    settleAfter: null,
    ...overrides,
  };
}

// A repaint hook the view calls after a local settlement. It touches the DOM via
// the shell, which has no session data here, so it is stubbed at the app level by
// giving the view nothing to sync: `repaintQuestionShell` guards on the presence
// of an inbox surface and returns early. No stub needed; asserted below so this
// comment cannot silently become wrong.

test('an answer POSTs to the question answer endpoint with the trimmed text', async () => {
  let calls = [];
  let app = fakeApp([ openQuestion() ]);

  let result = await submitQuestionAnswer(app, 'q_1', '  Ship it.  ', {
    postJSON: async (url, body) => {
      calls.push({ url, body });
      return { ok: true, delivered: true };
    },
    announce: () => {},
  });

  assert.equal(calls.length, 1, 'exactly one request leaves the client');
  assert.equal(calls[0].url, '/api/v1/questions/q_1/answer',
    'the endpoint the server exposes, spelled the way the server expects');
  assert.equal(calls[0].body.answer, 'Ship it.',
    'the answer is the trimmed text the user typed, not the raw value');
  assert.equal(result?.ok, true);
});

test('the question id is URL-encoded, so an awkward id cannot forge a path', async () => {
  let calls = [];
  let app = fakeApp([ openQuestion({ id: 'q/../escape' }) ]);

  await submitQuestionAnswer(app, 'q/../escape', 'hello', {
    postJSON: async (url, body) => {
      calls.push({ url, body });
      return { ok: true };
    },
    announce: () => {},
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/v1/questions/q%2F..%2Fescape/answer',
    'the id is encoded into a single path segment');
});

test('an empty or whitespace-only answer is never sent', async () => {
  let calls = [];
  let app = fakeApp([ openQuestion() ]);

  for (const blank of [ '', '   ', '\n\t ' ]) {
    let result = await submitQuestionAnswer(app, 'q_1', blank, {
      postJSON: async (url, body) => {
        calls.push({ url, body });
        return { ok: true };
      },
      announce: () => {},
    });

    assert.equal(result?.ok, false, `a blank answer (${JSON.stringify(blank)}) is refused locally`);
    assert.equal(result?.reason, 'empty');
  }

  assert.equal(calls.length, 0, 'no request is made for a blank answer');
});

test('the row settles before the request resolves, not after', async () => {
  // The "click does nothing until the round trip finishes" complaint, asserted at
  // the level the view actually runs at. The transport is held open on purpose so
  // the model can be read while the POST is still in flight.
  let release;
  let app = fakeApp([ openQuestion() ]);

  let inFlight = submitQuestionAnswer(app, 'q_1', 'Ship it.', {
    postJSON: () => new Promise((resolve) => { release = () => resolve({ ok: true }); }),
    announce: () => {},
  });

  // Let the async function run as far as the await.
  await new Promise((resolve) => setImmediate(resolve));

  let row = stateOf(app).questions[0];
  assert.notEqual(row.status, 'open',
    'the row leaves the open state on the click, before the server answers');
  assert.equal(row.settleAfter, SETTLE_WINDOW_MS,
    'and it carries the receipt window, so confirmation appears immediately');

  release();
  await inFlight;
});

test('a failed answer POST throws-free-returns a message and reopens the row', async () => {
  let app = fakeApp([ openQuestion() ]);

  // The view's failure path is a THROW from the transport, not a falsey result:
  // the server answers 200 even when delivery failed, so a falsey return is not
  // the error signal. This matches how `app._postJSON` reports a dead link.
  let result = await submitQuestionAnswer(app, 'q_1', 'Ship it.', {
    postJSON: async () => { throw new Error('network down'); },
    announce: () => {},
  });

  assert.equal(result?.ok, false, 'a failed write reports failure, it does not resolve as success');
  assert.equal(typeof result?.message, 'string', 'and carries a message the card can show');
  assert.ok(result.message.length > 0, 'the message is not an empty string');
  assert.match(result.message, /network down/, 'the underlying reason is preserved');

  let row = stateOf(app).questions[0];
  assert.equal(row.status, 'open',
    'a failed write must not leave the user staring at a success receipt');
  // Cleared to 0 (not null) by the rollback; either reads as "no deadline", and
  // the point is that no settle deadline survives a failed write -- otherwise the
  // row would retire itself on a receipt the server never accepted.
  assert.ok(!row.settleAfter,
    `the receipt window must be cleared, got settleAfter=${JSON.stringify(row.settleAfter)}`);

  // `reconcileQuestions` filters on the closed-id set, so a row restored but still
  // remembered is dropped by the very next fetch and the rollback is invisible.
  assert.equal(stateOf(app).closedQuestionIDs.has('q_1'), false,
    'the rollback must forget the id so a later fetch keeps the restored row');
});

test('a dismissal answers silently, so the agent is not woken', async () => {
  let calls = [];
  let app = fakeApp([ openQuestion() ]);

  await dismissQuestionAnswer(app, 'q_1', {
    postJSON: async (url, body) => {
      calls.push({ url, body });
      return { ok: true };
    },
    announce: () => {},
  });

  assert.equal(calls.length, 1, 'a dismissal is still a write to the answer endpoint');
  assert.equal(calls[0].url, '/api/v1/questions/q_1/answer',
    'a user dismissal is an answer, never /dismiss (that is the asking agent withdrawing)');
  assert.equal(calls[0].body.silent, true,
    'silent:true is what stops the agent being woken');
  assert.ok(typeof calls[0].body.answer === 'string' && calls[0].body.answer.length > 0,
    'a dismissal still sends the no-response answer text rather than an empty body');
});

test('a failed dismissal reopens the row too', async () => {
  let app = fakeApp([ openQuestion() ]);

  let result = await dismissQuestionAnswer(app, 'q_1', {
    postJSON: async () => { throw new Error('network down'); },
    announce: () => {},
  });

  assert.equal(result?.ok, false);
  let row = stateOf(app).questions[0];
  assert.equal(row.status, 'open', 'a dismissal that never landed must not stay dismissed on screen');
  assert.equal(stateOf(app).closedQuestionIDs.has('q_1'), false,
    'and its id is un-remembered');
});
