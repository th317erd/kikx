'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

import { installDom } from './support/mini-dom.mjs';

register(new URL('./support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);

const { document, registry: customElements } = installDom();

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

class StubProgressButton extends HTMLElement {
  constructor() {
    super();
    this.disabled = false;
  }
}
customElements.define('aeor-progress-button', StubProgressButton);

await import('../../src/client/components/kikx-session-grid.mjs');

function mountGrid(sessions = [ { id: 'ses_1', title: 'Alpha' } ], deletingSessionIDs = new Set()) {
  let grid = document.createElement('kikx-session-grid');
  grid.update({ allSessions: sessions, parentSessionID: null, deletingSessionIDs });
  return grid;
}

function cardRoot(grid) {
  return grid.querySelector('kikx-session-card .kikx-session-card');
}

test('update() applies the app-owned deleting set to the card', () => {
  let deletingSessionIDs = new Set();
  let grid = mountGrid(undefined, deletingSessionIDs);
  assert.ok(!cardRoot(grid).classList.contains('is-deleting'));

  deletingSessionIDs.add('ses_1');
  grid.update({ allSessions: [ { id: 'ses_1', title: 'Alpha' } ], parentSessionID: null });
  assert.ok(cardRoot(grid).classList.contains('is-deleting'));
  assert.equal(cardRoot(grid).getAttribute('aria-busy'), 'true');

  deletingSessionIDs.delete('ses_1');
  grid.update({ allSessions: [ { id: 'ses_1', title: 'Alpha' } ], parentSessionID: null });
  assert.ok(!cardRoot(grid).classList.contains('is-deleting'));
  assert.equal(cardRoot(grid).getAttribute('aria-busy'), 'false');
});

test('a re-render that omits the set keeps the app-owned pending state', () => {
  // The app owns this Set and passes the same reference on every full render;
  // a partial shell sync (e.g. an SSE frame) does not re-pass it.
  let deletingSessionIDs = new Set([ 'ses_1' ]);
  let grid = mountGrid(undefined, deletingSessionIDs);

  grid.update({ allSessions: [ { id: 'ses_1', title: 'Alpha' } ], parentSessionID: null });

  assert.ok(cardRoot(grid).classList.contains('is-deleting'), 'pending state survives a re-render');
});

test('clearing the app set before a full re-render does not resurrect the flag', () => {
  let deletingSessionIDs = new Set([ 'ses_1' ]);
  let grid = mountGrid(undefined, deletingSessionIDs);
  assert.ok(cardRoot(grid).classList.contains('is-deleting'));

  // The app clears the flag in _deleteSession's finally, then re-renders and
  // hands the same (now empty) set to the rebuilt grid.
  deletingSessionIDs.delete('ses_1');
  grid.update({ allSessions: [ { id: 'ses_1', title: 'Alpha' } ], parentSessionID: null, deletingSessionIDs });

  assert.ok(!cardRoot(grid).classList.contains('is-deleting'));
});
