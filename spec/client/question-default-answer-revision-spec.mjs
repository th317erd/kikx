'use strict';

// Revising a delivered default answer, from the UI side.
//
// The behaviour being pinned, in the owner's words: "let the user see the
// default answer was delivered, and what that answer was (in the green) ...
// but allow the user to edit/change the message, and submit a different answer
// (or an acknowledgement)."
//
// Three things have to hold together, and each one has failed in this codebase
// before:
//
//   1. A default answer renders GREEN, but is visibly NOT the user's own words.
//      A receipt that says "Your answer: declined to say" is a lie — the user
//      never said it, the agent's fallback did.
//   2. The box must still be there. Every other terminal question is read-only
//      on purpose (`assertOpen` would 409 a second POST), so this is the one
//      deliberate exception and it must not be widened by accident.
//   3. The revision must keep the default visible next to the replacement. The
//      agent was told "declined to say" and may have acted on it; a receipt
//      that only shows the correction erases the record of the mistake.
//
// The server enforces the same gate it enforced when the default fired, so a
// client that offered the box more generously would paint an affordance that
// 409s on submit. `isRevisableDefaultAnswer` is therefore asserted directly
// here, not merely exercised through the renderer.

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

import { installDom } from './support/mini-dom.mjs';

register(new URL('./support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);

installDom();

const { KikxQuestionFrame } = await import('../../src/client/components/kikx-question-frame.mjs');
const {
  DEFAULT_ANSWER_SOURCE,
  isRevisableDefaultAnswer,
  normalizeQuestionSummary,
  USER_ANSWER_SOURCE,
} = await import('../../src/client/state/questions-state.mjs');

// --- DOM helpers -----------------------------------------------------------
// mini-dom has no querySelector engine wired into these specs, so walk the tree
// directly, exactly as question-frame-spec.mjs does.

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

function byTag(node, tagName) {
  return nodes(node).filter((child) => child.localName === tagName);
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

function bySource(node, source) {
  return nodes(node).filter((child) => {
    if (typeof child.getAttribute !== 'function')
      return false;
    return child.getAttribute('data-answer-source') === source;
  });
}

// --- fixtures --------------------------------------------------------------

const DEFAULT_TEXT = 'declined to say';
const REAL_TEXT = 'I copied a stack trace from the terminal';

function question(overrides = {}) {
  return {
    id: 'q_1',
    groupID: 'grp_1',
    index: 1,
    status: 'open',
    mode: 'wait',
    sessionID: 'ses_1',
    agentID: 'agent-1',
    text: "What's the last thing you copied to your clipboard?",
    priority: 'normal',
    askedAt: Date.now() - 60_000,
    ...overrides,
  };
}

function frameWith(overrides = {}) {
  return {
    id: 'frame_1',
    type: 'Question',
    content: { question: question(overrides) },
  };
}

function mount(frame, appState = {}) {
  let el = document.createElement('kikx-question-frame');
  assert.ok(el instanceof KikxQuestionFrame, 'kikx-question-frame must be the registered component');
  el.updateFrame(frame, appState);
  return el;
}

function appSpy(result = { ok: true, delivered: true }) {
  let calls = [];
  return {
    calls,
    app: {
      // `options` is recorded, not dropped. Dropping it is how this file ended up
      // unable to tell a confirmation from a replacement: both arrived as
      // { questionID, text } and every assertion passed either way.
      _submitQuestionAnswer(questionID, text, options) {
        calls.push({ questionID, text, options });
        return Promise.resolve(result);
      },
    },
  };
}

function clickSubmit(el) {
  let submit = byClass(el, 'kikx-question-frame__submit')[0];
  assert.ok(submit, 'the frame must have a submit control');
  submit.dispatchEvent({ type: 'click', preventDefault() {} });
  return submit;
}

function clickConfirm(el) {
  let confirm = byClass(el, 'kikx-question-frame__confirm')[0];
  assert.ok(confirm, 'the frame must offer the acknowledgement control');
  confirm.dispatchEvent({ type: 'click', preventDefault() {} });
  return confirm;
}

function typeInto(el, text) {
  let box = byTag(el, 'textarea')[0];
  assert.ok(box, 'the frame must have an answer box');
  box.value = text;
  return box;
}

// --- the gate itself -------------------------------------------------------

test('isRevisableDefaultAnswer accepts only an answered question of default provenance', () => {
  assert.equal(isRevisableDefaultAnswer({ status: 'answered', answerSource: DEFAULT_ANSWER_SOURCE }), true);

  // An open question is not "revisable" — it is still answerable, which is a
  // different affordance with different text.
  assert.equal(isRevisableDefaultAnswer({ status: 'open', answerSource: null }), false);

  // A person already answered. A second POST must 409, and the UI must not
  // offer one.
  assert.equal(isRevisableDefaultAnswer({ status: 'answered', answerSource: USER_ANSWER_SOURCE }), false);

  // Null provenance: an answer written before provenance existed. It cannot be
  // shown to have come from a default, so it is treated as somebody's answer
  // rather than being offered up for editing.
  assert.equal(isRevisableDefaultAnswer({ status: 'answered', answerSource: null }), false);

  // A CONFIRMED default stays revisable on the client too. The server gate
  // (question-answer-revision.mjs) and this one must agree exactly: if the
  // client closed here, the box would vanish on "That's right" while the server
  // still accepted a replacement — a misclick would become unfixable in the UI
  // even though the data layer could take the fix. If the client opened where
  // the server refused, the form would 409.
  assert.equal(isRevisableDefaultAnswer({
    status: 'answered',
    answerSource: DEFAULT_ANSWER_SOURCE,
    acknowledgedAt: 1_700_000_000_000,
  }), true);

  // A deleted question is not editable no matter what it says.
  assert.equal(isRevisableDefaultAnswer({
    status: 'answered',
    answerSource: DEFAULT_ANSWER_SOURCE,
    deleted: true,
  }), false);

  // A dismissal is terminal and was never a default.
  assert.equal(isRevisableDefaultAnswer({ status: 'dismissed', answerSource: DEFAULT_ANSWER_SOURCE }), false);
});

test('the normalizer carries provenance instead of dropping it', () => {
  let model = normalizeQuestionSummary(question({
    status: 'answered',
    answer: DEFAULT_TEXT,
    answerSource: DEFAULT_ANSWER_SOURCE,
  }));

  assert.equal(model.answerSource, DEFAULT_ANSWER_SOURCE);
  assert.equal(model.answer, DEFAULT_TEXT);

  // Absent provenance normalizes to null, NOT to a guessed source.
  let legacy = normalizeQuestionSummary(question({ status: 'answered', answer: 'yes' }));
  assert.equal(legacy.answerSource, null);
});

test('the normalizer keeps the superseded default beside the live answer', () => {
  let model = normalizeQuestionSummary(question({
    status: 'answered',
    answer: REAL_TEXT,
    answerSource: USER_ANSWER_SOURCE,
    supersededDefaultAnswer: DEFAULT_TEXT,
    revisedAt: 1792800000000,
  }));

  assert.equal(model.answer, REAL_TEXT);
  assert.equal(model.supersededDefaultAnswer, DEFAULT_TEXT);
  assert.equal(model.revisedAt, 1792800000000);
});

// --- rendering: the default receipt ---------------------------------------

test('a delivered default renders green, labelled as a default, and NOT as the user\'s answer', () => {
  let el = mount(frameWith({
    status: 'answered',
    answer: DEFAULT_TEXT,
    answerSource: DEFAULT_ANSWER_SOURCE,
  }));

  let receipts = bySource(el, DEFAULT_ANSWER_SOURCE);
  assert.equal(receipts.length, 1, 'the default must be marked with its provenance');

  let receipt = receipts[0];
  assert.match(textOf(receipt), /declined to say/, 'the default answer itself must be visible');

  // The label must not claim the user said it.
  let label = textOf(byClass(receipt, 'kikx-question-frame__answer-label')[0]);
  assert.match(label, /Default answer/i);
  assert.doesNotMatch(label, /^You replied$/i, 'a default must never be labelled as the user\'s own words');

  // The note explains why the answer exists at all.
  let note = textOf(byClass(receipt, 'kikx-question-frame__answer-note')[0]);
  assert.match(note, /Nobody answered in time/i);
});

test('a delivered default still offers an editable box, and the submit says what it will do', () => {
  let el = mount(frameWith({
    status: 'answered',
    answer: DEFAULT_TEXT,
    answerSource: DEFAULT_ANSWER_SOURCE,
  }));

  // This is the whole point: a terminal question normally has no box. A default
  // is the one exception, because the person it spoke for was never asked.
  assert.equal(byTag(el, 'textarea').length, 1, 'a default must leave the answer box available');

  let submit = byClass(el, 'kikx-question-frame__submit')[0];
  assert.ok(submit, 'a default must leave a submit control');
  assert.match(textOf(submit), /different answer/i, 'the control must say it replaces the default');
});

test('the replacement box asks for a different answer rather than repeating the default', () => {
  let el = mount(frameWith({
    status: 'answered',
    answer: DEFAULT_TEXT,
    answerSource: DEFAULT_ANSWER_SOURCE,
  }));

  let box = byTag(el, 'textarea')[0];
  assert.notEqual(box.value, DEFAULT_TEXT, 'the box must not be pre-filled with an answer the user did not give');
});

// --- the cases that must NOT become editable ------------------------------

test('a human answer stays read-only: no box, no submit, labelled as the user\'s', () => {
  let el = mount(frameWith({
    status: 'answered',
    answer: REAL_TEXT,
    answerSource: USER_ANSWER_SOURCE,
  }));

  assert.equal(byTag(el, 'textarea').length, 0, 'a human answer must not be editable');
  assert.equal(byClass(el, 'kikx-question-frame__submit').length, 0);

  let receipt = bySource(el, USER_ANSWER_SOURCE)[0];
  assert.ok(receipt, 'a human answer must be marked with its provenance');
  assert.match(textOf(byClass(receipt, 'kikx-question-frame__answer-label')[0]), /^You replied$/);
});

test('an answer with no recorded provenance is treated as read-only, not up for editing', () => {
  // This is the pre-existing data shape: every question answered before
  // provenance was written has `answerSource: null`. Guessing "user" here would
  // hide the affordance; guessing "default" would offer to overwrite an answer
  // a person really gave. Neither guess is acceptable, so neither is made.
  let el = mount(frameWith({ status: 'answered', answer: 'yes' }));

  assert.equal(byTag(el, 'textarea').length, 0);
  assert.equal(bySource(el, DEFAULT_ANSWER_SOURCE).length, 0);
  assert.equal(bySource(el, USER_ANSWER_SOURCE).length, 0);
});

test('a dismissed question is read-only even if a default somehow set its source', () => {
  let el = mount(frameWith({
    status: 'dismissed',
    answer: DEFAULT_TEXT,
    answerSource: DEFAULT_ANSWER_SOURCE,
  }));

  assert.equal(byTag(el, 'textarea').length, 0);
});

// --- submission ------------------------------------------------------------

test('submitting a replacement reports the new text to the app', async () => {
  let { calls, app } = appSpy();
  let el = mount(frameWith({
    status: 'answered',
    answer: DEFAULT_TEXT,
    answerSource: DEFAULT_ANSWER_SOURCE,
  }), { app });

  typeInto(el, REAL_TEXT);
  clickSubmit(el);

  // The frame only reports intent; the app owns the network call.
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].questionID, 'q_1');
  assert.equal(calls[0].text, REAL_TEXT);
});

test('a default receipt survives the replacement being sent, with both answers shown', async () => {
  let release;
  let el = mount(frameWith({
    status: 'answered',
    answer: DEFAULT_TEXT,
    answerSource: DEFAULT_ANSWER_SOURCE,
  }), {
    app: {
      _submitQuestionAnswer() {
        return new Promise((resolve) => { release = resolve; });
      },
    },
  });

  typeInto(el, REAL_TEXT);
  clickSubmit(el);

  release({ ok: true, delivered: true });
  await new Promise((resolve) => setImmediate(resolve));

  // The default is still on screen — the agent was told it, and that record is
  // not the user's to erase by correcting it.
  let defaults = bySource(el, DEFAULT_ANSWER_SOURCE);
  assert.equal(defaults.length, 1, 'the delivered default must remain visible after a revision');
  assert.match(textOf(defaults[0]), /declined to say/);

  // And the replacement is there too, marked as a person's answer.
  let replacements = bySource(el, USER_ANSWER_SOURCE);
  assert.equal(replacements.length, 1, 'the replacement must be shown as the user\'s answer');
  assert.match(textOf(replacements[0]), new RegExp(REAL_TEXT.slice(0, 20)));

  // The form is gone: the row is a record again.
  assert.equal(byTag(el, 'textarea').length, 0);
  assert.equal(byClass(el, 'kikx-question-frame__submit').length, 0);
});

test('a failed replacement keeps the box and the default, and says so', async () => {
  let el = mount(frameWith({
    status: 'answered',
    answer: DEFAULT_TEXT,
    answerSource: DEFAULT_ANSWER_SOURCE,
  }), {
    app: {
      _submitQuestionAnswer() {
        return Promise.resolve({ ok: false, message: 'Could not send the answer.' });
      },
    },
  });

  typeInto(el, REAL_TEXT);
  clickSubmit(el);
  await new Promise((resolve) => setTimeout(resolve, 0));

  // Nothing was stored, so nothing may disappear. A failure that wipes the
  // receipt or the typed text would lose the user's work and hide the default.
  assert.equal(bySource(el, DEFAULT_ANSWER_SOURCE).length, 1, 'the default receipt must survive a failed send');
  assert.equal(byTag(el, 'textarea').length, 1, 'the box must survive a failed send so the text is not lost');

  let hint = byClass(el, 'kikx-question-frame__hint')[0];
  assert.ok(hint, 'the failure must be reported');
  assert.match(textOf(hint), /Could not send/i);
});

// --- a revision that already happened -------------------------------------

test('a question already revised shows the default AND the answer that replaced it', () => {
  let el = mount(frameWith({
    status: 'answered',
    answer: REAL_TEXT,
    answerSource: USER_ANSWER_SOURCE,
    supersededDefaultAnswer: DEFAULT_TEXT,
    revisedAt: 1792800000000,
  }));

  let defaults = bySource(el, DEFAULT_ANSWER_SOURCE);
  let answers = bySource(el, USER_ANSWER_SOURCE);

  assert.equal(defaults.length, 1, 'the superseded default must still be readable');
  assert.match(textOf(defaults[0]), /declined to say/);

  assert.equal(answers.length, 1);
  assert.match(textOf(answers[0]), /stack trace/);

  // Already corrected, so there is nothing left to edit: this is a record.
  assert.equal(byTag(el, 'textarea').length, 0);
});

test('an open question renders no answer receipt at all', () => {
  let el = mount(frameWith());

  assert.equal(bySource(el, DEFAULT_ANSWER_SOURCE).length, 0);
  assert.equal(bySource(el, USER_ANSWER_SOURCE).length, 0);
  assert.equal(byTag(el, 'textarea').length, 1);
});

// --- the acknowledgement control -------------------------------------------
//
// "That's right" exists because the ONLY way to agree with a default used to be
// to retype it, and retyping is indistinguishable from a correction. The server
// reads the declared intent, so the control's entire job is to declare the right
// one and to carry no text.

test('the frame offers a confirm control beside the replacement box, and they are different controls', () => {
  let el = mount(frameWith({
    status: 'answered',
    answer: DEFAULT_TEXT,
    answerSource: DEFAULT_ANSWER_SOURCE,
  }));

  let confirm = byClass(el, 'kikx-question-frame__confirm');
  let submit = byClass(el, 'kikx-question-frame__submit');

  assert.equal(confirm.length, 1, 'exactly one acknowledgement control');
  assert.equal(submit.length, 1, 'and exactly one replacement control');
  assert.notEqual(confirm[0], submit[0], 'two distinct controls, not one button relabelled');
  assert.match(textOf(confirm[0]), /right/i, 'the label says what agreeing means');
});

test('clicking confirm reports the confirm intent and NO text', async () => {
  let { calls, app } = appSpy({ ok: true, acknowledged: true, delivered: false });
  let el = mount(frameWith({
    status: 'answered',
    answer: DEFAULT_TEXT,
    answerSource: DEFAULT_ANSWER_SOURCE,
  }), { app });

  clickConfirm(el);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls.length, 1, 'the click must reach the app layer, not be swallowed');
  assert.equal(calls[0].options?.intent, 'confirm', 'the intent is what decides whether the agent is woken');
  assert.equal(calls[0].text, '', 'a confirmation carries no text: the default already said it');
});

test('typing a replacement still declares change, not confirm', async () => {
  let { calls, app } = appSpy();
  let el = mount(frameWith({
    status: 'answered',
    answer: DEFAULT_TEXT,
    answerSource: DEFAULT_ANSWER_SOURCE,
  }), { app });

  typeInto(el, REAL_TEXT);
  clickSubmit(el);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].text, REAL_TEXT);
  assert.notEqual(calls[0].options?.intent, 'confirm',
    'a correction must wake the agent; only an affirmation is silent');
});

test('a confirmation paints no answer block: the person wrote nothing', async () => {
  // The phase setter used to append a "Your answer" block holding the empty
  // string, i.e. it invented a receipt for words nobody typed.
  let el = mount(frameWith({
    status: 'answered',
    answer: DEFAULT_TEXT,
    answerSource: DEFAULT_ANSWER_SOURCE,
  }), { app: appSpy({ ok: true, acknowledged: true }).app });

  let before = bySource(el, USER_ANSWER_SOURCE).length;

  clickConfirm(el);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(bySource(el, USER_ANSWER_SOURCE).length, before,
    'confirming must not add a user-answer block');
  let defaults = bySource(el, DEFAULT_ANSWER_SOURCE);
  assert.equal(defaults.length, 1, 'the default receipt stays');
  assert.match(textOf(defaults[0]), /declined to say/);
});

test('an already-confirmed default shows the confirmation and drops the confirm button', () => {
  let el = mount(frameWith({
    status: 'answered',
    answer: DEFAULT_TEXT,
    answerSource: DEFAULT_ANSWER_SOURCE,
    acknowledgedAt: 1792800000000,
  }));

  assert.equal(byClass(el, 'kikx-question-frame__confirm').length, 0,
    'there is nothing left to confirm');

  let receipt = bySource(el, DEFAULT_ANSWER_SOURCE);
  assert.equal(receipt.length, 1);
  assert.match(textOf(receipt[0]), /confirmed/i, 'the receipt records that somebody affirmed it');

  // And the correction path is still open, which is what makes the promise in
  // that note ("you can still replace it below") true.
  assert.equal(byTag(el, 'textarea').length, 1);
  assert.equal(byClass(el, 'kikx-question-frame__submit').length, 1);
});

test('a real human answer offers no acknowledgement control', () => {
  let el = mount(frameWith({
    status: 'answered',
    answer: REAL_TEXT,
    answerSource: USER_ANSWER_SOURCE,
  }));

  assert.equal(byClass(el, 'kikx-question-frame__confirm').length, 0,
    'there is no default to affirm');
});
