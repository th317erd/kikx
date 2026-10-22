'use strict';

// The two dismiss affordances on a question card (Inbox).
//
//   - a text "Dismiss" (linear aeor-confirm-button) next to Answer
//   - a round close (radial aeor-progress-button) in the header row
//
// Both are hold-to-activate with a 500ms hold, so a stray click cannot throw away
// a question the user was about to answer. In this spec DOM the vendored custom
// elements are not defined, so the card takes its plain-button fallback path:
// that is deliberate, because the fallback is what ships if the vendor tree
// fails to load, and it must still dismiss.

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

function build(overrides, handlers = null) {
  let node = renderQuestionCard({ ownerDocument: document }, question(overrides));
  assert.ok(node, 'the card renders');
  if (handlers)
    bindAnswerForm(node, handlers);

  return node;
}

test('an open question renders both dismiss affordances', () => {
  let node = build();

  assert.equal(byClass(node, 'kikx-question-card__dismiss').length, 1, 'the text Dismiss');
  assert.equal(byClass(node, 'kikx-question-card__dismiss-close').length, 1, 'the round close');
});

test('the round close sits in the header, the text Dismiss in the answer actions', () => {
  let node = build();

  let header = byClass(node, 'kikx-question-card__header')[0];
  let actions = byClass(node, 'kikx-question-card__actions')[0];

  assert.equal(byClass(header, 'kikx-question-card__dismiss-close').length, 1,
    'close is reachable without scrolling to the answer box');
  assert.equal(byClass(actions, 'kikx-question-card__dismiss').length, 1,
    'the text Dismiss sits beside Answer');
});

test('both dismiss affordances carry the 500ms hold duration', () => {
  // The hold only exists when the vendored hold-to-confirm controls are present.
  // A plain fallback button has no hold at all, which is covered below.
  let previous = globalThis.customElements;
  globalThis.customElements = {
    ...previous,
    get: (name) => (name === 'aeor-confirm-button' || name === 'aeor-progress-button'
      ? function FakeElement() {}
      : previous?.get?.(name)),
  };

  try {
    let node = build();

    for (let className of [ 'kikx-question-card__dismiss', 'kikx-question-card__dismiss-close' ]) {
      let control = byClass(node, className)[0];
      assert.equal(control.getAttribute('duration'), '500',
        `${className} holds for half a second`);
    }
  } finally {
    globalThis.customElements = previous;
  }
});

test('the plain fallback is a real button, so it degrades rather than disappearing', () => {
  let node = build();

  for (let className of [ 'kikx-question-card__dismiss', 'kikx-question-card__dismiss-close' ]) {
    let control = byClass(node, className)[0];
    assert.equal(control.localName, 'button', `${className} falls back to a plain button`);
    assert.equal(control.type, 'button',
      'never a submit: activating it must not post the empty answer box');
  }
});

test('a terminal question offers no way to dismiss it again', () => {
  for (let status of [ 'answered', 'dismissed', 'undeliverable' ]) {
    let node = build({ status });
    assert.equal(byClass(node, 'kikx-question-card__dismiss').length, 0, `${status}: no text Dismiss`);
    assert.equal(byClass(node, 'kikx-question-card__dismiss-close').length, 0, `${status}: no close`);
  }
});

test('the fallback controls keep an accessible name', () => {
  let node = build();

  let dismiss = byClass(node, 'kikx-question-card__dismiss')[0];
  let close = byClass(node, 'kikx-question-card__dismiss-close')[0];

  assert.equal(dismiss.getAttribute('aria-label'), 'Dismiss');
  assert.equal(close.getAttribute('aria-label'), 'Dismiss question');
  // The visible glyph for the round control is decorative; the name is on aria-label.
  assert.equal(String(close.textContent ?? '').trim(), '\u00d7');
});

test('activating the text Dismiss calls onDismissAnswer, not onDismiss', () => {
  let dismissed = [];
  let withdrawn = [];
  let node = build({}, {
    onDismissAnswer: (id) => { dismissed.push(id); return Promise.resolve({ ok: true }); },
    onDismiss: (id) => { withdrawn.push(id); },
  });

  byClass(node, 'kikx-question-card__dismiss')[0]
    .dispatchEvent(new CustomEvent('click', { bubbles: true }));

  assert.deepEqual(dismissed, [ 'q_1' ], 'the answer-path dismissal fires');
  assert.deepEqual(withdrawn, [], 'the asker-withdraw endpoint is not used');
});

test('activating the round close calls onDismissAnswer', () => {
  let dismissed = [];
  let node = build({}, {
    onDismissAnswer: (id) => { dismissed.push(id); return Promise.resolve({ ok: true }); },
  });

  byClass(node, 'kikx-question-card__dismiss-close')[0]
    .dispatchEvent(new CustomEvent('click', { bubbles: true }));

  assert.deepEqual(dismissed, [ 'q_1' ]);
});

test('a vendored hold-to-confirm control is driven by confirm, not click', async () => {
  // Simulate the vendored element being available for the duration of this test,
  // so the card takes its real (non-fallback) path.
  let defined = [ 'aeor-confirm-button', 'aeor-progress-button' ];
  let previous = globalThis.customElements;
  globalThis.customElements = {
    ...previous,
    get: (name) => (defined.includes(name) ? function FakeElement() {} : previous?.get?.(name)),
  };

  try {
    let dismissed = [];
    let node = build({}, {
      onDismissAnswer: (id) => { dismissed.push(id); return Promise.resolve({ ok: true }); },
    });

    let close = byClass(node, 'kikx-question-card__dismiss-close')[0];
    assert.equal(close.localName, 'aeor-progress-button', 'the round control is the radial button');
    assert.equal(close.getAttribute('icon'), 'close');
    assert.equal(close.getAttribute('duration'), '500');

    let dismiss = byClass(node, 'kikx-question-card__dismiss')[0];
    assert.equal(dismiss.localName, 'aeor-confirm-button', 'the text control is the linear button');
    assert.equal(dismiss.getAttribute('duration'), '500');

    // A plain click is not a confirmation: the hold has not completed.
    close.dispatchEvent(new CustomEvent('click', { bubbles: true }));
    assert.deepEqual(dismissed, [], 'a click alone does not dismiss');

    close.dispatchEvent(new CustomEvent('confirm', { bubbles: true }));
    assert.deepEqual(dismissed, [ 'q_1' ], 'completing the hold dismisses');

    // A second activation while the first is still in flight is ignored, so the
    // two controls can never double-submit the same dismissal.
    dismiss.dispatchEvent(new CustomEvent('confirm', { bubbles: true }));
    assert.deepEqual(dismissed, [ 'q_1' ], 'the in-flight guard holds');

    // Once it settles, the other affordance works too.
    await new Promise((resolve) => setTimeout(resolve, 0));
    dismiss.dispatchEvent(new CustomEvent('confirm', { bubbles: true }));
    assert.deepEqual(dismissed, [ 'q_1', 'q_1' ], 'both affordances dismiss');
  } finally {
    globalThis.customElements = previous;
  }
});

test('a failed dismissal surfaces an error and leaves the row answerable', () => {
  let node = build({}, {
    onDismissAnswer: () => Promise.resolve({ ok: false, message: 'Could not dismiss the question.' }),
  });

  byClass(node, 'kikx-question-card__dismiss')[0]
    .dispatchEvent(new CustomEvent('click', { bubbles: true }));

  return Promise.resolve().then(() => {
    let hint = byClass(node, 'kikx-question-card__hint')[0];
    assert.match(String(hint.textContent ?? ''), /Could not dismiss/);
    assert.equal(hint.hasAttribute('hidden'), false, 'the failure is visible');
    assert.equal(node.getAttribute('data-answer-state'), 'error');
  });
});

test('a dismissal clears the question draft, like a real answer', () => {
  let drafts = new Map([ [ 'q_1', 'half-typed thought' ] ]);
  let node = build({}, {
    onDismissAnswer: () => Promise.resolve({ ok: true }),
    drafts,
  });

  byClass(node, 'kikx-question-card__dismiss')[0]
    .dispatchEvent(new CustomEvent('click', { bubbles: true }));

  return Promise.resolve().then(() => {
    assert.equal(node.getAttribute('data-answer-state'), 'sent');
  });
});

test('with no dismissal handler the card falls back to onDismiss rather than dying', () => {
  // An inline frame can render the card with no Inbox handlers at all.
  let withdrawn = [];
  let node = build({}, { onDismiss: (id) => { withdrawn.push(id); } });

  byClass(node, 'kikx-question-card__dismiss')[0]
    .dispatchEvent(new CustomEvent('click', { bubbles: true }));

  assert.deepEqual(withdrawn, [ 'q_1' ]);
});
