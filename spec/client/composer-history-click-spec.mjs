'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { installDom } from './support/mini-dom.mjs';

const { document } = installDom();
document.addEventListener = () => {};
document.removeEventListener = () => {};
globalThis.document = document;
globalThis.localStorage = createStorage();

const { KikxComposerHistory } = await import('../../src/client/components/kikx-composer-history.mjs');
const { syncComposerDraft } = await import('../../src/client/components/composer-drafts.mjs');

function createStorage() {
  let values = new Map();
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
    clear() { values.clear(); },
  };
}

function createApp() {
  let textarea = document.createElement('textarea');
  textarea.name = 'message';
  let app = {
    _state: {
      selectedSessionID: 'ses_1',
      authToken: 'token',
      refreshToken: 'refresh',
      draft: '',
      account: { id: 'usr_1', name: 'Wyatt' },
      status: '',
      statusKind: '',
    },
    querySelector(selector) {
      return selector === 'textarea[name="message"]' ? textarea : null;
    },
    async _getJSON() {
      return {
        data: {
          entries: [
            { frameID: 'm1', id: 'm1', kind: 'message', text: 'first choice', order: 1, createdAt: 1 },
            { frameID: 'm2', id: 'm2', kind: 'message', text: 'second choice', order: 2, createdAt: 2 },
          ],
          hasMoreOlder: false,
          oldestOrder: 1,
        },
      };
    },
    async _putJSON() {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return { data: { draft: {} } };
    },
    async _deleteJSON() {
      return null;
    },
  };
  return { app, textarea };
}

test('a second history click is ignored while the first selection is still opening', async () => {
  let { app, textarea } = createApp();
  syncComposerDraft(app, 'old draft');
  app._state.draft = 'old draft';
  textarea.value = 'old draft';

  let history = new KikxComposerHistory();
  document.body.appendChild(history);
  history.configure({ app, sessionID: 'ses_1' });
  history._search.focus = () => {};
  await history.open();

  let first = history._select(history._entries[0]);
  let second = history._select(history._entries[1]);
  assert.equal(history._selecting, true, 'the first click immediately latches the popup');
  assert.equal(history._search.disabled, true, 'follow-up input is disabled immediately');

  await Promise.all([ first, second ]);
  assert.equal(textarea.value, 'first choice');
  assert.equal(history.hidden, true);

  textarea.value = '';
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(textarea.value, '', 'the ignored click must not land after the popup closes');
});
