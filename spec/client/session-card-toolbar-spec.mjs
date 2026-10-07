'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

import { installDom } from './support/mini-dom.mjs';

// The session card reaches browser-only modules through /vendor/... imports in
// aeor-ui.mjs. Redirect those to local stand-ins before loading it.
register(new URL('./support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);

const { document, registry: customElements } = installDom();

// The card embeds a kikx-chat-view, whose mini renderer needs DOM APIs the
// mini-DOM does not implement. Pre-empt it with a recording stub so these
// toolbar tests stay focused on the card's own DOM.
class StubChatView extends HTMLElement {
  constructor() {
    super();
    this.mode = 'full';
    this.updates = [];
  }

  update(values) {
    this.updates.push(values);
  }
}
customElements.define('kikx-chat-view', StubChatView);

// aeor-progress-button cannot load in node; stand in a minimal element that
// exposes the same contract the card relies on (attributes, disabled, confirm).
// The constructor counter makes the double-build defect observable.
let createdProgressButtons = 0;
class StubProgressButton extends HTMLElement {
  constructor() {
    super();
    createdProgressButtons++;
    this.disabled = false;
  }

  fireConfirm() {
    this.dispatchEvent(new CustomEvent('confirm', { bubbles: true }));
  }
}
customElements.define('aeor-progress-button', StubProgressButton);

await import('../../src/client/components/kikx-session-card.mjs');

function mountCard(input = {}) {
  let card = document.createElement('kikx-session-card');
  card.update({
    session: { id: 'ses_1', title: 'Alpha' },
    ...input,
  });
  return card;
}

function cardRoot(card) {
  return card.querySelector('.kikx-session-card');
}

function progressButtons(card) {
  return [ ...card.querySelectorAll('aeor-progress-button') ];
}

test('the card builds exactly one toolbar with Open and Delete progress buttons', () => {
  createdProgressButtons = 0;
  let card = mountCard();

  assert.equal(card.querySelectorAll('.kikx-session-card__toolbar').length, 1, 'exactly one toolbar');
  assert.equal(createdProgressButtons, 2, 'exactly two radial buttons are created (no dead first toolbar)');

  let [ open, deleteButton ] = progressButtons(card);
  assert.ok(open, 'the Open button must exist');
  assert.equal(open.getAttribute('icon'), 'open');
  assert.equal(open.getAttribute('duration'), '0');

  assert.ok(deleteButton, 'the Delete button must exist');
  assert.equal(deleteButton.getAttribute('icon'), 'delete');
  assert.equal(deleteButton.getAttribute('duration'), '1000');
  assert.ok(deleteButton.classList.contains('progress-button-danger'), 'Delete must be danger-themed');
});

test('confirming Delete emits exactly one kikx-card-delete carrying the session id', () => {
  let card = mountCard();
  let deletes = [];
  card.addEventListener('kikx-card-delete', (event) => deletes.push(event.detail));

  let [, deleteButton ] = progressButtons(card);
  deleteButton.fireConfirm();

  assert.deepEqual(deletes, [ { sessionID: 'ses_1' } ]);
});

test('a click inside the toolbar does not open the session', () => {
  let card = mountCard();
  let opens = [];
  card.addEventListener('kikx-card-open', (event) => opens.push(event.detail));

  let [ open ] = progressButtons(card);
  open.dispatchEvent(new CustomEvent('click', { bubbles: true }));

  assert.deepEqual(opens, [], 'toolbar clicks must be stopped before the card open handler');
});

test('a keydown inside the toolbar does not open the session', () => {
  let card = mountCard();
  let opens = [];
  card.addEventListener('kikx-card-open', (event) => opens.push(event.detail));

  let [ open ] = progressButtons(card);
  open.dispatchEvent(new CustomEvent('keydown', { bubbles: true }));

  assert.deepEqual(opens, [], 'toolbar keydown must be stopped before the card open handler');
});

test('confirming Open emits the open event once', () => {
  let card = mountCard();
  let opens = [];
  card.addEventListener('kikx-card-open', (event) => opens.push(event.detail));

  let [ open ] = progressButtons(card);
  open.fireConfirm();

  assert.deepEqual(opens, [ { sessionID: 'ses_1' } ]);
});

test('deleting: true disables Delete and marks the card busy', () => {
  let card = mountCard({ deleting: true });

  let [, deleteButton ] = progressButtons(card);
  assert.equal(deleteButton.disabled, true);
  assert.ok(cardRoot(card).classList.contains('is-deleting'));
  assert.equal(cardRoot(card).getAttribute('aria-busy'), 'true');

  card.update({ deleting: false });
  assert.equal(progressButtons(card)[1].disabled, false);
  assert.ok(!cardRoot(card).classList.contains('is-deleting'));
  assert.equal(cardRoot(card).getAttribute('aria-busy'), 'false');
});

test('the card root is not a button and marks selection with aria-current', () => {
  let card = mountCard({ selected: true });
  let root = cardRoot(card);

  // The root contains real controls, so it must not claim role="button"; the
  // grid already labels the host as a listitem.
  assert.notEqual(root.getAttribute('role'), 'button');
  assert.equal(root.getAttribute('aria-current'), 'true');
  assert.equal(root.hasAttribute('aria-pressed'), false);

  // Unselecting clears aria-current; no stale attribute survives a re-render.
  card.update({ selected: false });
  assert.equal(cardRoot(card).getAttribute('aria-current'), null);
  assert.equal(cardRoot(card).hasAttribute('aria-pressed'), false);
});
