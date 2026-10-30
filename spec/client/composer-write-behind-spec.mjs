'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  activateComposerDraftSession,
  flushLocalComposerDraft,
  getComposerDraftController,
  readLocalComposerDraft,
  syncComposerDraft,
} from '../../src/client/components/composer-drafts.mjs';

function installStorage() {
  let values = new Map();
  globalThis.localStorage = {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
    clear() { values.clear(); },
  };
  globalThis.requestIdleCallback = undefined;
  return values;
}

function appWithComposer() {
  let textarea = { value: '', setSelectionRange() {}, focus() {} };
  return {
    _state: { selectedSessionID: 'ses_1', draft: '', status: '', statusKind: '' },
    _activeComposerDraftSessionID: 'ses_1',
    querySelector(selector) { return selector === 'textarea[name="message"]' ? textarea : null; },
    async _getJSON() { return { data: { drafts: [] } }; },
    async _putJSON() { return { data: {} }; },
    async _deleteJSON() { return { data: null }; },
  };
}

test('typing updates the controller immediately but defers local serialization', async () => {
  installStorage();
  let app = appWithComposer();
  syncComposerDraft(app, 'first draft');

  assert.equal(getComposerDraftController(app, 'ses_1').text, 'first draft');
  assert.equal(readLocalComposerDraft('ses_1'), null, 'typing must not synchronously write localStorage');
  assert.equal(await flushLocalComposerDraft(app, 'ses_1'), true);
  assert.deepEqual(readLocalComposerDraft('ses_1')?.text, 'first draft');
});

test('a stale empty server response cannot delete a newer local draft', async () => {
  installStorage();
  let app = appWithComposer();
  syncComposerDraft(app, 'do not lose me');
  await flushLocalComposerDraft(app, 'ses_1');
  app._activeComposerDraftSessionID = null;
  app._getJSON = async () => ({ data: { drafts: [] } });

  await activateComposerDraftSession(app, 'ses_1');
  assert.equal(app._state.draft, 'do not lose me');
  assert.equal(readLocalComposerDraft('ses_1')?.text, 'do not lose me');
});

test('composer mutations are exact, contained, and ordered', () => {
  installStorage();
  let app = appWithComposer();
  syncComposerDraft(app, 'a');
  syncComposerDraft(app, 'ab');

  let controller = getComposerDraftController(app, 'ses_1');
  assert.deepEqual(controller.mutations.entries().map((entry) => ({
    scope: entry.scope,
    owner: entry.owner,
    key: entry.key,
    previous: entry.previous,
    next: entry.next,
    operation: entry.operation,
    revision: entry.revision,
  })), [
    { scope: 'composer', owner: 'ses_1', key: 'text', previous: '', next: 'a', operation: 'setText', revision: 1 },
    { scope: 'composer', owner: 'ses_1', key: 'text', previous: 'a', next: 'ab', operation: 'setText', revision: 2 },
  ]);
  assert.deepEqual(Object.keys(app._state).sort(), [ 'draft', 'selectedSessionID', 'status', 'statusKind' ], 'composer updates must not broaden app state');
});

