'use strict';

// The rendered shape of a settled question.
//
// The card has three states and they must not be confused:
//   open       -> a box to type in
//   settled    -> "You replied." / "Dismissed ..." plus a countdown close
//   terminal   -> "Closed: <status>." with no controls
//
// The middle one is new. It exists because a row that vanished on answer gave
// the user no confirmation, and a row that rendered as plain terminal gave them
// nothing to press to get rid of it early.

import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// `kikx-question-card.mjs` reaches `/vendor/aeor-web-components/*` through
// aeor-ui.mjs, which only resolves in the browser. The shared loader aliases
// those specifiers to local stand-ins; without it this spec cannot import the
// module under test at all.
register(new URL('./support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);

import { installDom } from './support/mini-dom.mjs';

const { document, registry } = installDom();

function question(overrides = {}) {
  return {
    id: 'q_1',
    text: 'Which database should we use?',
    status: 'open',
    askedAt: 1000,
    ...overrides,
  };
}

const app = { ownerDocument: document };

test('an open question renders an answer box and no receipt', async () => {
  const { renderQuestionCard } = await import('../../src/client/components/kikx-question-card.mjs');
  let card = renderQuestionCard(app, question());

  assert.ok(card.querySelector('.kikx-question-card__input'), 'an open row offers a box');
  assert.equal(card.querySelector('.kikx-question-card__closed'), null);
  assert.equal(card.getAttribute('data-question-settled'), null);
});

test('a settled row says "You replied." and offers the countdown instead of a box', async () => {
  const { renderQuestionCard } = await import('../../src/client/components/kikx-question-card.mjs');
  let card = renderQuestionCard(app, question({
    status: 'answered',
    closedAt: 5000,
    settleAfter: 60000,
  }));

  let note = card.querySelector('.kikx-question-card__closed');
  assert.equal(card.querySelector('.kikx-question-card__input'), null, 'a settled row has no box to answer');
  assert.ok(note, 'the row says what happened');
  assert.equal(note.textContent, 'You replied.');
  assert.equal(card.getAttribute('data-question-settled'), 'true');
  assert.equal(card.getAttribute('data-settled-until'), '65000',
    'the row publishes its deadline, so expiry is decided by data');
});

test('a dismissal says the user chose not to respond, and that nobody was woken', async () => {
  const { renderQuestionCard } = await import('../../src/client/components/kikx-question-card.mjs');
  let card = renderQuestionCard(app, question({
    status: 'dismissed',
    closedAt: 5000,
    settleAfter: 60000,
  }));

  let note = card.querySelector('.kikx-question-card__closed');
  assert.match(note.textContent, /chose not to respond/,
    'the wording must match what the server recorded');
  assert.match(note.textContent, /not woken/,
    'a silent dismissal has to say it was silent, or it reads as a failed click');
});

test('a terminal row learned from the server has no receipt and no controls', async () => {
  const { renderQuestionCard } = await import('../../src/client/components/kikx-question-card.mjs');
  // No closedAt/settleAfter: this tab never settled it, it arrived answered.
  let card = renderQuestionCard(app, question({ status: 'answered' }));

  let note = card.querySelector('.kikx-question-card__closed');
  assert.equal(note.textContent, 'Closed: answered.',
    'a row never seen as open gets the plain status, not a receipt');
  assert.equal(card.getAttribute('data-question-settled'), null);
  assert.equal(card.querySelector('.kikx-question-card__dismiss-close'), null,
    'nothing to press: there is no countdown to end');
});

test('the countdown control is a click-to-close fuse, not a hold control', async () => {
  const { renderQuestionCard } = await import('../../src/client/components/kikx-question-card.mjs');

  // Register a stand-in so the assertion does not depend on the vendored element
  // being loaded. What matters is the contract the card hands the component:
  // duration=0 (a press closes immediately) plus auto-complete-after=the window.
  class FakeProgressButton extends globalThis.HTMLElement {}
  if (!registry.get('aeor-progress-button'))
    registry.define('aeor-progress-button', FakeProgressButton);

  let card = renderQuestionCard(app, question({
    status: 'answered',
    closedAt: 5000,
    settleAfter: 60000,
  }));

  let control = card.querySelector('.kikx-question-card__dismiss-close--settle');
  assert.ok(control, 'the settled row carries the countdown control');
  assert.equal(control.getAttribute('duration'), '0',
    'a press must close immediately, not start a hold');
  assert.equal(control.getAttribute('auto-complete-after'), '60000',
    'the fuse runs for the receipt window');
});
