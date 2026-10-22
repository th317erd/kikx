'use strict';

// Regression: pressing a dismiss control must never read as "submit an answer".
//
// The bug this pins down (2026-10-22): `aeor-confirm-button` renders a real
// `<button>` into the light DOM with no `type` attribute. Inside the answer
// `<form>` an untyped button defaults to `type="submit"`, so the instant the
// user pressed the text "Dismiss", the browser submitted the form, the empty
// answer failed validation, and the hint appeared — shoving both buttons
// sideways under the cursor. The round close control failed separately, because
// it reached a server build that predated `silent` support.
//
// Two independent defences are tested here:
//   1. the card ignores any submit whose `submitter` is not the Answer button;
//   2. untyped nested buttons inside a dismiss control are forced to
//      `type="button"`, so the submit never happens in the first place.

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

import { installDom } from './support/mini-dom.mjs';

register(new URL('./support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);

const { document } = installDom();

const {
  renderQuestionCard,
  bindAnswerForm,
} = await import('../../src/client/components/kikx-question-card.mjs');

function question(overrides = {}) {
  return {
    id: 'q_1',
    status: 'open',
    mode: 'wait',
    text: 'Which database should we use?',
    priority: 'normal',
    askedAt: Date.now() - 60_000,
    sessionID: 'ses_1',
    agentID: 'agent-1',
    ...overrides,
  };
}

function walk(node, predicate, found = []) {
  if (!node || typeof node !== 'object')
    return found;

  if (predicate(node))
    found.push(node);

  for (let child of node.childNodes || [])
    walk(child, predicate, found);

  return found;
}

function hasClass(node, className) {
  return String(node.className || '').split(/\s+/).includes(className);
}

function byClass(root, className) {
  return walk(root, (node) => hasClass(node, className));
}

// A submit event carrying a `submitter`, which is the property the guard reads.
// Native SubmitEvent is not available in this spec DOM, so the property is set
// on a plain CustomEvent.
function submitEventWith(submitter) {
  let event = new CustomEvent('submit', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'submitter', { configurable: true, value: submitter });
  return event;
}

function build(handlers) {
  let node = renderQuestionCard({ ownerDocument: document }, question());
  assert.ok(node, 'the card renders');
  bindAnswerForm(node, handlers);
  return node;
}

test('a submit from a dismiss control does not run the answer handler', () => {
  let submitted = [];
  let node = build({
    onSubmit: (questionID, text) => {
      submitted.push([ questionID, text ]);
      return Promise.resolve({ ok: true });
    },
    onDismissAnswer: () => Promise.resolve({ ok: true }),
  });

  let formNode = byClass(node, 'kikx-question-card__answer')[0];
  let dismissControl = byClass(node, 'kikx-question-card__dismiss')[0];
  let nested = dismissControl.querySelector?.('button') || dismissControl;

  formNode.dispatchEvent(submitEventWith(nested));

  return Promise.resolve().then(() => {
    assert.deepEqual(submitted, [], 'a dismiss press must not submit an answer');

    let hint = byClass(node, 'kikx-question-card__hint')[0];
    assert.equal(hint.hasAttribute('hidden'), true,
      'the empty-answer validation must not fire for a dismiss press');
    assert.equal(node.getAttribute('data-answer-state'), 'idle',
      'the row is not pushed into an error state');
  });
});

test('a submit from the Answer button still answers normally', () => {
  let submitted = [];
  let node = build({
    onSubmit: (questionID, text) => {
      submitted.push([ questionID, text ]);
      return Promise.resolve({ ok: true });
    },
    onDismissAnswer: () => Promise.resolve({ ok: true }),
    drafts: new Map([ [ 'q_1', '' ] ]),
  });

  let formNode = byClass(node, 'kikx-question-card__answer')[0];
  let input = byClass(node, 'kikx-question-card__input')[0];
  let submit = byClass(node, 'kikx-question-card__submit')[0];

  input.value = 'Postgres, please.';
  formNode.dispatchEvent(submitEventWith(submit));

  return Promise.resolve().then(() => {
    assert.deepEqual(submitted, [ [ 'q_1', 'Postgres, please.' ] ],
      'the real Answer button is unaffected by the guard');
  });
});

test('a submit with no submitter still answers (implicit submission)', () => {
  // Pressing Enter in a text field fires a submit whose `submitter` may be
  // absent. The guard must be permissive in that case or it would break
  // keyboard submission.
  let submitted = [];
  let node = build({
    onSubmit: (questionID, text) => {
      submitted.push([ questionID, text ]);
      return Promise.resolve({ ok: true });
    },
    onDismissAnswer: () => Promise.resolve({ ok: true }),
  });

  let formNode = byClass(node, 'kikx-question-card__answer')[0];
  let input = byClass(node, 'kikx-question-card__input')[0];

  input.value = 'Typed, then Enter.';
  let event = new CustomEvent('submit', { bubbles: true, cancelable: true });
  formNode.dispatchEvent(event);

  return Promise.resolve().then(() => {
    assert.deepEqual(submitted, [ [ 'q_1', 'Typed, then Enter.' ] ],
      'implicit submission is not blocked');
  });
});

test('the validation hint is the last element in the actions row', () => {
  // The hint used to be rendered FIRST, so unhiding it inserted its width ahead
  // of the buttons and pushed them sideways. It must come after both controls,
  // so revealing it grows into the free space to their right.
  let node = build({ onDismissAnswer: () => Promise.resolve({ ok: true }) });
  let actions = byClass(node, 'kikx-question-card__actions')[0];

  let ordered = (actions.childNodes || []).filter((child) => child?.nodeType !== 3
    || String(child.textContent || '').trim() !== '');

  let hintIndex = ordered.findIndex((child) => hasClass(child, 'kikx-question-card__hint'));
  let submitIndex = ordered.findIndex((child) => hasClass(child, 'kikx-question-card__submit'));
  let dismissIndex = ordered.findIndex((child) => hasClass(child, 'kikx-question-card__dismiss'));

  assert.ok(hintIndex > 0, 'the hint is present');
  assert.ok(hintIndex > submitIndex, 'the hint sits to the right of Answer');
  assert.ok(hintIndex > dismissIndex, 'the hint sits to the right of Dismiss');
});

test('untyped buttons nested in a dismiss control are neutralised', () => {
  let node = build({ onDismissAnswer: () => Promise.resolve({ ok: true }) });

  for (let className of [ 'kikx-question-card__dismiss', 'kikx-question-card__dismiss-close' ]) {
    let control = byClass(node, className)[0];
    for (let nested of control.querySelectorAll?.('button') || []) {
      assert.equal(nested.getAttribute('type'), 'button',
        `${className} must not leave a default-type submit button inside the form`);
    }
  }
});
