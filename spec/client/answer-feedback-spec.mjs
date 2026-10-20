'use strict';

// Feedback for answering a question.
//
// Three user-visible defects are covered here, all of which made a submission
// indistinguishable from a no-op:
//
//   1. A busy send looked exactly like an idle one: `disabled` and `aria-busy`
//      were set but nothing rendered differently, and the only change was the
//      textarea emptying.
//   2. A FAILED send resolved with `{ ok: false }`, which the card treated as
//      success — it cleared the box and destroyed the draft for an answer the
//      server never stored. Silent data loss.
//   3. Nothing confirmed a successful send after the row left the Inbox.
//
// The tests drive `bindAnswerForm` directly with a fake app, because these are
// properties of the card's own state machine rather than of the whole shell.

import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./support/frame-item-loader.mjs', import.meta.url));
const { installDom } = await import('./support/mini-dom.mjs');
installDom();

const { renderQuestionCard, bindAnswerForm } = await import('../../src/client/components/kikx-question-card.mjs');
const { createDraftStore, getAnswerDraft } = await import('../../src/client/state/question-drafts.mjs');
const { announceAnswerStatus, dismissAnswerStatus, ANSWER_NOTICE_CLASS } = await import('../../src/client/components/answer-notice.mjs');

const SUBMIT = 'kikx-question-card__submit';
const INPUT = 'kikx-question-card__input';
const HINT = 'kikx-question-card__hint';
const STATE = 'data-answer-state';

function byClass(root, name) {
  return [ ...root.querySelectorAll(`.${name}`) ];
}

// The mini-DOM implements neither `element.form` nor `closest`, so the answer
// form is located by tag name. Deliberately not `querySelector('form')`: the
// selector engine keys off classes here.
function formOf(node) {
  let found = [];
  let visit = (current) => {
    if (!current || !current.childNodes)
      return;

    for (let child of current.childNodes) {
      if (String(child.tagName || '').toUpperCase() === 'FORM')
        found.push(child);
      visit(child);
    }
  };
  visit(node);

  return found[0] || null;
}

function question(overrides = {}) {
  return {
    id: 'q_1',
    status: 'open',
    text: 'Which database should we use?',
    agentID: 'agent-1',
    sessionID: 'session-1',
    askedAt: Date.now(),
    ...overrides,
  };
}

// Mount one card wired to `onSubmit`, and return everything a test needs to poke.
function mount(onSubmit, handlers = {}) {
  let app = { ownerDocument: document };
  let card = renderQuestionCard(app, question(), {});
  assert.ok(card, 'card rendered');

  let drafts = createDraftStore();
  bindAnswerForm(card, { onSubmit, drafts, ...handlers });

  document.body.appendChild(card);

  return {
    app,
    card,
    drafts,
    submit: byClass(card, SUBMIT)[0],
    input: byClass(card, INPUT)[0],
    hint: byClass(card, HINT)[0],
    type(text) {
      this.input.value = text;
      this.input.dispatchEvent(new CustomEvent('input', { bubbles: true }));
    },
    send() {
      let form = formOf(this.card);
      assert.ok(form, 'the card has an answer form');
      form.dispatchEvent({ type: 'submit', preventDefault() {} });
    },
  };
}

// Drain pending microtasks so a `.then` chain attached to `onSubmit` has run.
async function settle() {
  for (let i = 0; i < 8; i += 1)
    await Promise.resolve();
}

test('a card starts idle, not busy', () => {
  let view = mount(async () => ({ ok: true }));
  assert.equal(view.card.getAttribute(STATE), 'idle');
  assert.equal(view.submit.textContent, 'Answer');
  assert.equal(view.submit.getAttribute('disabled'), null, 'the control is usable before any send');
});

test('a send in flight shows "Sending…", disables the control and marks the row busy', async () => {
  let release;
  let view = mount(() => new Promise((resolve) => { release = resolve; }));

  view.type('PostgreSQL');
  view.send();

  assert.equal(view.submit.textContent, 'Sending\u2026', 'the label changes, not just an attribute');
  assert.notEqual(view.submit.getAttribute('disabled'), null, 'the control is disabled while in flight');
  assert.notEqual(view.input.getAttribute('readonly'), null, 'the box cannot be edited mid-send');
  assert.equal(view.card.getAttribute('aria-busy'), 'true');
  assert.equal(view.card.getAttribute(STATE), 'busy', 'the row publishes its phase for the stylesheet');

  release({ ok: true });
  await settle();

  assert.equal(view.card.getAttribute(STATE), 'sent');
  assert.equal(view.card.getAttribute('aria-busy'), 'false');
});

test('a second submit while one is in flight is ignored', async () => {
  let calls = 0;
  let view = mount(() => {
    calls += 1;
    return new Promise(() => {});
  });

  view.type('PostgreSQL');
  view.send();
  view.send();
  view.send();

  assert.equal(calls, 1, 'only the first submit reached the caller');
});

test('a failed send keeps the typed answer and the draft', async () => {
  let view = mount(async () => ({ ok: false, reason: 'error', message: 'Could not send the answer: HTTP 409' }));

  view.type('PostgreSQL');
  assert.equal(getAnswerDraft(view.drafts, 'q_1'), 'PostgreSQL', 'the draft is saved as it is typed');

  view.send();
  await settle();

  // The defect: this used to be '' with the draft deleted, because the card
  // treated every resolution as success.
  assert.equal(view.input.value, 'PostgreSQL', 'the typed answer survives a failure');
  assert.equal(getAnswerDraft(view.drafts, 'q_1'), 'PostgreSQL', 'the draft is not discarded by a failure');

  assert.equal(view.card.getAttribute(STATE), 'error');
  assert.equal(view.submit.textContent, 'Answer', 'the control is usable again so the send can be retried');
  assert.equal(view.submit.getAttribute('disabled'), null);

  let hint = byClass(view.card, HINT)[0];
  assert.equal(hint.getAttribute('hidden'), null, 'the failure hint is visible');
  assert.match(hint.textContent, /HTTP 409/, 'the hint carries the reason');
});

test('a rejected send is reported and keeps the text', async () => {
  let view = mount(async () => {
    throw new Error('network down');
  });

  view.type('PostgreSQL');
  view.send();
  await settle();

  assert.equal(view.card.getAttribute(STATE), 'error');
  assert.equal(view.input.value, 'PostgreSQL', 'the typed answer survives a rejection');
  assert.equal(getAnswerDraft(view.drafts, 'q_1'), 'PostgreSQL');
});

test('a successful send clears only its own draft and text', async () => {
  let view = mount(async () => ({ ok: true }));

  view.type('PostgreSQL');
  view.send();
  await settle();

  assert.equal(view.card.getAttribute(STATE), 'sent');
  assert.equal(view.input.value, '', 'the sent answer leaves the box');
  assert.equal(getAnswerDraft(view.drafts, 'q_1'), '', 'the sent draft is dropped');
});

test('a failure does not touch a sibling question\'s draft', async () => {
  let failing = mount(async () => ({ ok: false, message: 'Could not send the answer.' }));
  let sibling = mount(async () => ({ ok: true }));

  failing.type('first');
  sibling.type('second, unsent');

  failing.send();
  await settle();

  assert.equal(failing.card.getAttribute(STATE), 'error');
  assert.equal(
    getAnswerDraft(failing.drafts, 'q_1'),
    'first',
    'the failed question keeps its own draft',
  );
});

test('a card rendered for a terminal question is marked closed, not idle', () => {
  let app = { ownerDocument: document };
  let card = renderQuestionCard(app, question({ status: 'answered' }), {});

  assert.ok(card);
  assert.equal(card.getAttribute(STATE), 'closed');
  assert.equal(byClass(card, SUBMIT).length, 0, 'a closed row offers no submit control');
});

// --- The notice -------------------------------------------------------------

test('a success notice mounts once and is reused for the next answer', () => {
  let app = { ownerDocument: document, appended: [], querySelector: null, appendChild(node) {
    this.appended.push(node);
    this.querySelector = (selector) => (selector === `.${ANSWER_NOTICE_CLASS}` ? node : null);
  } };

  let first = announceAnswerStatus(app, 'Answer sent.', { tone: 'success', autoHideMs: 0 });
  assert.ok(first, 'a notice node is returned');
  assert.equal(first.textContent, 'Answer sent.');
  assert.equal(app.appended.length, 1, 'one node mounted');
  assert.ok(first.classList.contains(`${ANSWER_NOTICE_CLASS}--visible`));
  assert.ok(first.classList.contains(`${ANSWER_NOTICE_CLASS}--success`));
  assert.equal(first.getAttribute('role'), 'status');
  assert.equal(first.getAttribute('aria-live'), 'polite');

  let second = announceAnswerStatus(app, 'Could not send the answer.', { tone: 'error', autoHideMs: 0 });
  assert.equal(second, first, 'the same node is reused');
  assert.equal(app.appended.length, 1, 'no second node was mounted');
  assert.ok(second.classList.contains(`${ANSWER_NOTICE_CLASS}--error`));
  assert.equal(second.classList.contains(`${ANSWER_NOTICE_CLASS}--success`), false, 'the old tone is removed');

  dismissAnswerStatus(app);
  assert.equal(second.classList.contains(`${ANSWER_NOTICE_CLASS}--visible`), false);
  assert.equal(second.textContent, '');
});
