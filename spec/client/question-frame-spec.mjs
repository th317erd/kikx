'use strict';

// The inline `Question` frame component (plan §6.5, §8, §9 P3).
//
// This is the in-thread half of the ask-user UI: the same question that appears
// in the Inbox also renders where it was asked, so the conversation stays
// readable. §8 lists `question-frame-spec.mjs` as a required test item and it
// had never been written.
//
// The behaviours pinned here are the ones with real user-visible consequences:
//   - an open question offers a free-form box ([D-4]: no quick-pick options);
//   - a terminal question renders READ-ONLY, because offering a box that the
//     server would reject with 409 is worse than showing what was answered;
//   - submitting reports intent to the app and never performs the network call
//     itself, and a blank answer is not submitted at all;
//   - a standalone frame (no app reachable) does not throw inside a handler.
//
// The modules import the AEOR element DSL through aeor-ui.mjs, whose
// /vendor/... imports are browser-only. Redirect them to local stand-ins first,
// exactly as the other DOM specs do. Load order matters: register() must come
// before installDom() and before the dynamic import of anything that pulls in
// the DSL.

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

import { installDom } from './support/mini-dom.mjs';

register(new URL('./support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);

installDom();

const { KikxQuestionFrame } = await import('../../src/client/components/kikx-question-frame.mjs');

// --- DOM helpers -----------------------------------------------------------
// mini-dom has no querySelector engine wired into these specs, so walk the
// tree directly. Same house style as inbox-list-spec.mjs.

function walk(node, out = []) {
  for (let child of node?.childNodes || []) {
    out.push(child);
    walk(child, out);
  }
  return out;
}

function nodes(node) {
  return walk(node);
}

function byClass(node, className) {
  return nodes(node).filter((child) => {
    let cls = typeof child.className === 'string' ? child.className : '';
    return cls.split(/\s+/).includes(className);
  });
}

function textOf(node) {
  if (!node)
    return '';
  if (node.nodeType === 3)
    return String(node.textContent ?? node.data ?? '');
  let parts = [];
  for (let child of node.childNodes || [])
    parts.push(textOf(child));
  return parts.join('');
}

function byTag(node, tagName) {
  return nodes(node).filter((child) => child.localName === tagName);
}

// --- fixtures --------------------------------------------------------------

function question(overrides = {}) {
  return {
    id: 'q_1',
    groupID: 'grp_1',
    index: 1,
    status: 'open',
    mode: 'wait',
    sessionID: 'ses_1',
    agentID: 'agent-1',
    text: 'Which database should we use?',
    priority: 'normal',
    askedAt: Date.now() - 60_000,
    ...overrides,
  };
}

// The frame content carries the question document (written by ask-user-tool).
function frameWith(overrides = {}) {
  return {
    id: 'frame_1',
    type: 'Question',
    content: { question: question(overrides) },
  };
}

// The app owns the network call. Record what the frame asks for so we can
// assert on intent without any HTTP.
function appSpy() {
  let calls = [];
  return {
    calls,
    app: {
      _submitQuestionAnswer(questionID, text) {
        calls.push({ questionID, text });
        return Promise.resolve({ delivered: true });
      },
    },
  };
}

function mount(frame, appState = {}) {
  let el = document.createElement('kikx-question-frame');
  assert.ok(el instanceof KikxQuestionFrame, 'kikx-question-frame must be the registered component');
  el.updateFrame(frame, appState);
  return el;
}

// --- rendering: open question ---------------------------------------------

test('an open question renders the asker, the text, a free-form box and a submit button', () => {
  let el = mount(frameWith());

  assert.equal(el.className, 'kikx-question-frame');
  assert.equal(el.dataset.questionID, 'q_1', 'the frame must be addressable by question id');

  assert.equal(byClass(el, 'kikx-question-frame__agent').length, 1);
  // The frame names the asker the same way the Inbox card does. No lookup is
  // available in this fixture, so it degrades to the id rather than a fake name.
  assert.match(textOf(byClass(el, 'kikx-question-frame__agent')[0]), /agent-1/);

  assert.equal(byClass(el, 'kikx-question-frame__text').length, 1);
  assert.equal(textOf(byClass(el, 'kikx-question-frame__text')[0]), 'Which database should we use?');

  // [D-4]: free-form text only. The answer UI is a textarea, not a set of
  // options, and no option/radio/select element should exist anywhere.
  let boxes = byTag(el, 'textarea');
  assert.equal(boxes.length, 1, 'an open question must offer exactly one answer box');
  assert.equal(boxes[0].getAttribute('name'), 'answer');
  assert.equal(byTag(el, 'select').length, 0);
  assert.equal(byTag(el, 'input').length, 0, 'no quick-pick inputs (D-4)');

  assert.equal(byClass(el, 'kikx-question-frame__submit').length, 1);
  assert.equal(textOf(byClass(el, 'kikx-question-frame__submit')[0]), 'Answer');

  // Nothing answered yet.
  assert.equal(byClass(el, 'kikx-question-frame__answered').length, 0);
});

test('a high-priority question is marked; a normal one is not', () => {
  let high = mount(frameWith({ priority: 'high' }));
  assert.equal(byClass(high, 'kikx-question-frame__priority').length, 1);
  assert.equal(textOf(byClass(high, 'kikx-question-frame__priority')[0]), 'high');

  let normal = mount(frameWith({ priority: 'normal' }));
  assert.equal(byClass(normal, 'kikx-question-frame__priority').length, 0);
});

// --- rendering: terminal question -----------------------------------------

// This is the 409 guard. `POST /api/v1/questions/:id/answer` returns 409 for a
// terminal question (assertOpen), so rendering a box there would invite the
// user to hit an error the UI could have prevented.
for (let status of ['answered', 'dismissed', 'undeliverable']) {
  test(`a ${status} question renders read-only, with no answer box and no submit`, () => {
    let el = mount(frameWith({ status }));

    assert.equal(byTag(el, 'textarea').length, 0, 'no answer box for a terminal question');
    assert.equal(byClass(el, 'kikx-question-frame__submit').length, 0, 'no submit for a terminal question');

    let answered = byClass(el, 'kikx-question-frame__answered');
    assert.equal(answered.length, 1);
    // The old copy interpolated the status into its own name
    // ("Answered (answered)."), which said nothing about the answer.
    let expected = status === 'answered' ? 'Answered.' : `Closed: ${status}.`;
    assert.equal(textOf(answered[0]), expected);

    // The question itself still reads in the thread.
    assert.equal(textOf(byClass(el, 'kikx-question-frame__text')[0]), 'Which database should we use?');
  });
}

// --- submitting ------------------------------------------------------------

test('submitting typed text reports intent to the app, trimmed, exactly once', () => {
  let spy = appSpy();
  let el = mount(frameWith(), { app: spy.app });

  let box = byTag(el, 'textarea')[0];
  box.value = '   use postgres   ';

  let form = byClass(el, 'kikx-question-frame__card')[0];
  assert.ok(form, 'the card is a form so Enter submits');
  form.dispatchEvent(new CustomEvent('submit', { bubbles: true, cancelable: true }));

  assert.deepEqual(spy.calls, [{ questionID: 'q_1', text: 'use postgres' }]);
});

test('the submit button submits the same way as the form', () => {
  let spy = appSpy();
  let el = mount(frameWith(), { app: spy.app });

  byTag(el, 'textarea')[0].value = 'sqlite';
  byClass(el, 'kikx-question-frame__submit')[0]
    .dispatchEvent(new CustomEvent('click', { bubbles: true }));

  assert.deepEqual(spy.calls, [{ questionID: 'q_1', text: 'sqlite' }]);
});

// canSubmitAnswer() is the only validation (free-form, D-4), and an empty
// answer must not reach the network: the server would 400 it.
for (let [label, value] of [['empty', ''], ['whitespace only', '   \n\t  ']]) {
  test(`a ${label} answer is not submitted`, () => {
    let spy = appSpy();
    let el = mount(frameWith(), { app: spy.app });

    // Precondition: the submit path must actually be reachable, otherwise
    // "nothing was called" is satisfied by a form wired to nothing and this
    // test proves the opposite of what it claims.
    byTag(el, 'textarea')[0].value = 'reachable';
    byClass(el, 'kikx-question-frame__card')[0]
      .dispatchEvent(new CustomEvent('submit', { bubbles: true, cancelable: true }));
    assert.deepEqual(spy.calls, [{ questionID: 'q_1', text: 'reachable' }],
      'precondition: the submit path is live');
    spy.calls.length = 0;

    byTag(el, 'textarea')[0].value = value;
    byClass(el, 'kikx-question-frame__card')[0]
      .dispatchEvent(new CustomEvent('submit', { bubbles: true, cancelable: true }));

    assert.deepEqual(spy.calls, [], 'blank answers must never be POSTed');
  });
}

test('a frame with no reachable app does not throw inside the handler', () => {
  // Precondition: on an otherwise identical wired frame the same interaction
  // DOES submit. Without this, a dead form makes the test below pass vacuously.
  let spy = appSpy();
  let wired = mount(frameWith(), { app: spy.app });
  byTag(wired, 'textarea')[0].value = 'anything';
  byClass(wired, 'kikx-question-frame__card')[0]
    .dispatchEvent(new CustomEvent('submit', { bubbles: true, cancelable: true }));
  assert.deepEqual(spy.calls, [{ questionID: 'q_1', text: 'anything' }],
    'precondition: the submit path is live');

  let el = mount(frameWith(), {});

  byTag(el, 'textarea')[0].value = 'anything';
  assert.doesNotThrow(() => {
    byClass(el, 'kikx-question-frame__card')[0]
      .dispatchEvent(new CustomEvent('submit', { bubbles: true, cancelable: true }));
  });
});

// --- content shapes and fallbacks -----------------------------------------

test('content may carry the question bare, not wrapped in .question', () => {
  let el = mount({ id: 'frame_2', type: 'Question', content: question({ id: 'q_bare' }) });
  assert.equal(el.dataset.questionID, 'q_bare');
  assert.equal(byClass(el, 'kikx-question-frame__text').length, 1);
});

test('a question with no usable text falls back instead of rendering an empty card', () => {
  // normalizeQuestionSummary rejects a blank text, so this must degrade rather
  // than render a card with an empty prompt and an answerable box.
  let el = mount({ id: 'frame_3', type: 'Question', content: { question: { id: 'q_blank', text: '   ' } } });

  assert.equal(byClass(el, 'kikx-question-frame__card').length, 0, 'no card for an unusable question');
  assert.equal(byTag(el, 'textarea').length, 0);
  assert.equal(byClass(el, 'kikx-question-frame__missing').length, 1);
  assert.equal(textOf(byClass(el, 'kikx-question-frame__missing')[0]), 'Question unavailable.');
});

test('a frame with no content at all shows the preview text, or the generic fallback', () => {
  let withPreview = mount({ id: 'frame_4', type: 'Question', content: { preview: 'loading…' } });
  assert.equal(textOf(byClass(withPreview, 'kikx-question-frame__missing')[0]), 'loading…');

  let bare = mount({ id: 'frame_5', type: 'Question' });
  assert.equal(textOf(byClass(bare, 'kikx-question-frame__missing')[0]), 'Question unavailable.');
});

// --- live updates ----------------------------------------------------------

test('setting appState re-renders a frame that is already showing', () => {
  let el = mount(frameWith(), {});
  let before = byTag(el, 'textarea').length;
  assert.equal(before, 1);

  el.appState = { app: { _submitQuestionAnswer() {} } };

  // Still exactly one box: the re-render must replace the tree, not append a
  // second card on top of the first.
  assert.equal(byClass(el, 'kikx-question-frame__card').length, 1);
  assert.equal(byTag(el, 'textarea').length, 1);
});

test('updateFrame swaps an open question for its answered state without stacking cards', () => {
  let el = mount(frameWith());
  assert.equal(byTag(el, 'textarea').length, 1);

  el.updateFrame(frameWith({ status: 'answered' }), {});

  assert.equal(byClass(el, 'kikx-question-frame__card').length, 1, 'exactly one card after update');
  assert.equal(byTag(el, 'textarea').length, 0);
  assert.equal(textOf(byClass(el, 'kikx-question-frame__answered')[0]), 'Answered.');
});

// --- submission feedback ---------------------------------------------------
//
// The frame used to discard the promise returned by `_submitQuestionAnswer`, so
// a send produced no busy state, no confirmation, and no way to tell a failure
// from a success. These pin the three phases it now reports.

function clickSubmit(el) {
  let submit = byClass(el, 'kikx-question-frame__submit')[0];
  assert.ok(submit, 'the frame has a submit control');
  submit.dispatchEvent({ type: 'click', preventDefault() {} });
  return submit;
}

function typeInto(el, text) {
  let box = byTag(el, 'textarea')[0];
  assert.ok(box, 'the frame has an answer box');
  box.value = text;
  return box;
}

test('a frame send reports busy, then replaces the form with the answer', async () => {
  let release;
  let el = mount(frameWith(), {
    app: { _submitQuestionAnswer() { return new Promise((resolve) => { release = resolve; }); } },
  });

  let box = typeInto(el, 'Use PostgreSQL');
  let submit = clickSubmit(el);

  assert.equal(el.getAttribute('data-answer-state'), 'busy');
  assert.equal(textOf(submit), 'Sending\u2026', 'the label changes while in flight');
  assert.notEqual(submit.getAttribute('disabled'), null, 'the control is disabled while in flight');

  // One status, not two. The busy phase used to ALSO write "Sending…" into the
  // hint next to a button that already said it.
  let hint = byClass(el, 'kikx-question-frame__hint')[0];
  assert.equal(textOf(hint), '', 'the busy label is not duplicated in the hint');

  release({ ok: true, delivered: false, pending: true, message: 'Answer saved. The agent has not started on it yet.' });
  for (let i = 0; i < 8; i += 1)
    await Promise.resolve();

  assert.equal(el.getAttribute('data-answer-state'), 'sent');

  // The complaint this fixes: an enabled "Answer sent" button next to a live
  // box invited a second answer to a question that was already answered.
  assert.equal(byClass(el, 'kikx-question-frame__submit').length, 0, 'the submit control is gone once sent');
  assert.equal(byTag(el, 'textarea').length, 0, 'the answer box is gone once sent');

  // ...and the answer itself is on screen, in its own read-only block.
  let given = byClass(el, 'kikx-question-frame__answer-text');
  assert.equal(given.length, 1, 'the answer is displayed');
  assert.equal(textOf(given[0]), 'Use PostgreSQL');

  let label = byClass(el, 'kikx-question-frame__answer-label')[0];
  assert.equal(textOf(label), 'You replied');
});

test('an already-answered question shows the answer it holds', () => {
  let el = mount(frameWith({ status: 'answered', answer: 'Postgres, port 5434.' }));

  assert.equal(byTag(el, 'textarea').length, 0, 'no box for an answered question');
  assert.equal(byClass(el, 'kikx-question-frame__submit').length, 0, 'no submit either');

  let given = byClass(el, 'kikx-question-frame__answer-text');
  assert.equal(given.length, 1);
  assert.equal(textOf(given[0]), 'Postgres, port 5434.', 'the answer is shown, not the status word');
});

test('a failed frame send reports the reason and keeps the typed text', async () => {
  let el = mount(frameWith(), {
    app: {
      _submitQuestionAnswer() {
        return Promise.resolve({ ok: false, message: 'Could not send the answer: HTTP 409' });
      },
    },
  });

  let box = typeInto(el, 'Use PostgreSQL');
  clickSubmit(el);

  for (let i = 0; i < 8; i += 1)
    await Promise.resolve();

  assert.equal(el.getAttribute('data-answer-state'), 'error');
  assert.equal(box.value, 'Use PostgreSQL', 'a failed send must not discard what was typed');

  let hint = byClass(el, 'kikx-question-frame__hint')[0];
  assert.match(textOf(hint), /HTTP 409/, 'the reason is shown');
});

test('a frame send that throws is reported rather than swallowed', async () => {
  let el = mount(frameWith(), {
    app: {
      _submitQuestionAnswer() {
        return Promise.reject(new Error('network down'));
      },
    },
  });

  let box = typeInto(el, 'Use PostgreSQL');
  clickSubmit(el);

  for (let i = 0; i < 8; i += 1)
    await Promise.resolve();

  assert.equal(el.getAttribute('data-answer-state'), 'error');
  assert.equal(box.value, 'Use PostgreSQL');

  let hint = byClass(el, 'kikx-question-frame__hint')[0];
  assert.match(textOf(hint), /network down/);
});

// --- the answer block appears exactly once ---------------------------------
//
// Reported from a screenshot: after answering, the same answer was rendered
// TWICE inside one question card, both labelled "Your answer", with identical
// text.
//
// The card has two independent ways to paint an answer block, and until now
// they were not aware of each other:
//
//   _render()   paints one through `_answeredBlock()` as soon as
//               `question.status !== 'open'`;
//   _showSent() appends one when the POST resolves, removing the box and the
//               actions first but NOT any block that was already there.
//
// The two are ordered by two different clocks — the socket and the request — so
// whichever lands second wins the race to be the duplicate. When the
// `question.updated` event arrives while the POST is still in flight, the
// re-render paints the block, and then `_showSent()` appends a second copy of
// the same sentence underneath it. Both orderings are pinned below, because
// fixing only the one that was photographed would leave the mirror image of the
// bug in place.

test('an answer block painted by a re-render is not duplicated when the send resolves', async () => {
  let release;
  let el = mount(frameWith(), {
    app: {
      _submitQuestionAnswer() {
        return new Promise((resolve) => { release = resolve; });
      },
    },
  });

  typeInto(el, 'Both! A strange breed of person.');
  clickSubmit(el);

  // The socket wins: the question is answered out from under the in-flight POST.
  el.updateFrame(frameWith({ status: 'answered', answer: 'Both! A strange breed of person.' }), {});
  assert.equal(
    byClass(el, 'kikx-question-frame__answer-text').length,
    1,
    'the re-render paints exactly one answer block',
  );

  // ...and then the POST resolves, which is what appended the second copy.
  release({ ok: true, delivered: true });
  for (let i = 0; i < 8; i += 1)
    await Promise.resolve();

  assert.equal(
    byClass(el, 'kikx-question-frame__answer-text').length,
    1,
    'the resolved send must not add a second answer block to one already on screen',
  );
  assert.equal(
    byClass(el, 'kikx-question-frame__answer-label').length,
    1,
    'one "You replied" label, not two',
  );
  assert.equal(
    textOf(byClass(el, 'kikx-question-frame__answer-text')[0]),
    'Both! A strange breed of person.',
    'the surviving block holds the text the user typed',
  );
});

test('a send that resolves before the re-render is not duplicated by that re-render', async () => {
  let el = mount(frameWith(), { app: appSpy().app });

  typeInto(el, 'Use PostgreSQL');
  clickSubmit(el);

  for (let i = 0; i < 8; i += 1)
    await Promise.resolve();
  assert.equal(
    byClass(el, 'kikx-question-frame__answer-text').length,
    1,
    'the send paints the answer once',
  );

  // The other ordering: the socket arrives after the send already settled the
  // row. The full re-render must replace what is there, not add to it.
  el.updateFrame(frameWith({ status: 'answered', answer: 'Use PostgreSQL' }), {});

  assert.equal(byClass(el, 'kikx-question-frame__card').length, 1, 'still exactly one card');
  assert.equal(
    byClass(el, 'kikx-question-frame__answer-text').length,
    1,
    'one answer block whichever clock lands first',
  );
  assert.equal(textOf(byClass(el, 'kikx-question-frame__answer-text')[0]), 'Use PostgreSQL');
});

// --- dismiss affordances ---------------------------------------------------
//
// The owner's screenshot: "Honestly, this should look like a Question frame in
// a session... and there is no reason a question frame shouldn't have a
// 'Dismiss' and 'X' close button." The inline frame previously offered only
// Answer, so a question asked in a session could not be dismissed without
// opening the Inbox. These tests pin the two controls and, more importantly,
// that they route a DISMISSAL to the app rather than submitting an answer.

function appDismissSpy(result = { ok: true }) {
  let answered = [];
  let dismissed = [];

  return {
    answered,
    dismissed,
    app: {
      _submitQuestionAnswer(questionID, text) {
        answered.push({ questionID, text });
        return Promise.resolve({ delivered: true });
      },
      _dismissQuestionAnswer(questionID) {
        dismissed.push(questionID);
        return Promise.resolve(result);
      },
    },
  };
}

function clickControl(node) {
  assert.ok(node, 'the control must exist before it can be clicked');
  node.dispatchEvent({ type: 'click', preventDefault() {}, stopPropagation() {} });
}

test('an open frame renders both dismiss affordances the Inbox card has', () => {
  let el = mount(frameWith());
  let spy = appDismissSpy();
  el.appState = { app: spy.app };

  let text = byClass(el, 'kikx-question-card__dismiss');
  let close = byClass(el, 'kikx-question-card__dismiss-close');

  assert.equal(text.length, 1, 'the labelled Dismiss button');
  assert.equal(close.length, 1, 'the round close button');
});

test('a terminal question in a frame offers no dismiss controls', () => {
  for (let status of [ 'answered', 'dismissed', 'undeliverable' ]) {
    let el = mount(frameWith({ status, answer: 'done' }));

    assert.equal(byClass(el, 'kikx-question-card__dismiss').length, 0,
      `a ${status} question has nothing left to dismiss`);
    assert.equal(byClass(el, 'kikx-question-card__dismiss-close').length, 0,
      `a ${status} question must not offer the round close either`);
  }
});

test('dismissing from the frame routes to the app and does not submit an answer', () => {
  let el = mount(frameWith());
  let spy = appDismissSpy();
  el.appState = { app: spy.app };

  clickControl(byClass(el, 'kikx-question-card__dismiss')[0]);

  assert.deepEqual(spy.dismissed, [ 'q_1' ],
    'the frame must ask the app to dismiss this question');
  assert.equal(spy.answered.length, 0,
    'a dismissal is not an answer — submitting one would be a different request');
});

test('the round close dismisses the same way as the text button', () => {
  let el = mount(frameWith());
  let spy = appDismissSpy();
  el.appState = { app: spy.app };

  clickControl(byClass(el, 'kikx-question-card__dismiss-close')[0]);

  assert.deepEqual(spy.dismissed, [ 'q_1' ]);
  assert.equal(spy.answered.length, 0);
});

test('a rejected dismissal is reported, not shown as success', () => {
  let el = mount(frameWith());
  let spy = appDismissSpy({ ok: false, message: 'Question not found' });
  el.appState = { app: spy.app };

  clickControl(byClass(el, 'kikx-question-card__dismiss')[0]);

  // `dismissQuestionAnswer` reports a dropped POST or a 409 as `{ ok: false }`
  // rather than rejecting, so treating every resolution as success would tell
  // the user a question was dismissed when the server still has it open.
  return Promise.resolve().then(() => Promise.resolve()).then(() => {
    assert.equal(el.getAttribute('data-answer-state'), 'dismiss-error',
      'a failed dismissal must not read as a completed one');

    let hint = byClass(el, 'kikx-question-frame__hint')[0];
    assert.ok(hint, 'the frame must have a hint node to report into');
    assert.match(String(hint.textContent || ''), /Question not found/,
      'the reason the server gave must reach the user');
  });
});

test('a frame with no reachable app does not throw when dismissed', () => {
  let el = mount(frameWith());

  assert.doesNotThrow(() => {
    clickControl(byClass(el, 'kikx-question-card__dismiss')[0]);
  });
});
