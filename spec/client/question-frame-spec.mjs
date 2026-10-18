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
  assert.equal(textOf(byClass(el, 'kikx-question-frame__agent')[0]), 'agent-1');

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
    assert.equal(textOf(answered[0]), `Answered (${status}).`);

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
  assert.equal(textOf(byClass(el, 'kikx-question-frame__answered')[0]), 'Answered (answered).');
});
