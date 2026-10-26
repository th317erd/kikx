'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  activateComposerDraftSession,
  clearComposerDraftWithServer,
  deleteComposerHistoryEntry,
  flushComposerDraft,
  getComposerDraftController,
  markComposerDraftSent,
  readLocalComposerDraft,
  replaceComposerText,
  syncComposerDraft,
  writeLocalComposerDraft,
} from '../../src/client/components/composer-drafts.mjs';

function installStorage() {
  let values = new Map();
  globalThis.localStorage = {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
    clear() { values.clear(); },
  };
  return values;
}

function createApp(options = {}) {
  let requests = [];
  let textarea = {
    value: '',
    setSelectionRange() {},
    focus() {},
  };
  let app = {
    _state: {
      selectedSessionID: 'ses_1',
      draft: '',
      status: '',
      statusKind: '',
    },
    _activeComposerDraftSessionID: options.activeSessionID || null,
    querySelector(selector) {
      return selector === 'textarea[name="message"]' ? textarea : null;
    },
    async _getJSON(url) {
      requests.push({ method: 'GET', url });
      if (options.failGet)
        throw new Error('offline');
      return options.getResult || { data: { drafts: [] } };
    },
    async _putJSON(url, body, requestOptions) {
      requests.push({ method: 'PUT', url, body, requestOptions });
      return { data: { draft: { draftID: body.draftID } } };
    },
    async _deleteJSON(url) {
      requests.push({ method: 'DELETE', url });
      return { data: { draft: null } };
    },
  };
  return { app, textarea, requests };
}

test('current composer draft is cached in localStorage', () => {
  installStorage();
  writeLocalComposerDraft('ses_1', { draftID: 'draft-a', text: 'half a thought' });

  assert.deepEqual(readLocalComposerDraft('ses_1'), {
    draftID: 'draft-a',
    text: 'half a thought',
    updatedAt: readLocalComposerDraft('ses_1').updatedAt,
  });
  assert.ok(readLocalComposerDraft('ses_1').updatedAt > 0);

  writeLocalComposerDraft('ses_1', { text: '   ' });
  assert.equal(readLocalComposerDraft('ses_1'), null);
});

test('flush sends the active draft to the server with one stable draft id', async () => {
  installStorage();
  let { app, textarea, requests } = createApp();
  syncComposerDraft(app, 'draft text');
  let draftID = readLocalComposerDraft('ses_1').draftID;

  assert.equal(await flushComposerDraft(app, 'ses_1'), true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'PUT');
  assert.match(requests[0].url, new RegExp(`/composer/drafts/${draftID}$`));
  assert.deepEqual(requests[0].body, { text: 'draft text' });
  assert.equal(textarea.value, '');

  syncComposerDraft(app, 'draft text plus more');
  assert.equal(readLocalComposerDraft('ses_1').draftID, draftID, 'typing in the same draft does not rotate its id');
});

test('selecting history flushes the old draft and starts a fresh draft id', async () => {
  installStorage();
  let { app, textarea, requests } = createApp();
  syncComposerDraft(app, 'old unfinished draft');
  let oldID = readLocalComposerDraft('ses_1').draftID;

  assert.equal(await replaceComposerText(app, 'selected historical message'), true);
  assert.equal(requests[0].method, 'PUT');
  assert.match(requests[0].url, new RegExp(`/composer/drafts/${oldID}$`));
  assert.equal(textarea.value, 'selected historical message');
  let local = readLocalComposerDraft('ses_1');
  assert.equal(local.text, 'selected historical message');
  assert.ok(local.draftID);
  assert.notEqual(local.draftID, oldID);
});

test('a failed draft flush aborts replacing the composer text', async () => {
  installStorage();
  let { app, textarea } = createApp();
  textarea.value = 'must not be lost';
  app._state.draft = 'must not be lost';
  syncComposerDraft(app, 'must not be lost');
  app._putJSON = async () => { throw new Error('offline'); };

  assert.equal(await replaceComposerText(app, 'replacement'), false);
  assert.equal(app._state.draft, 'must not be lost');
  assert.equal(textarea.value, 'must not be lost');
});

test('local draft is recovered when the server draft load fails', async () => {
  installStorage();
  writeLocalComposerDraft('ses_1', { draftID: 'offline-draft', text: 'typed while offline' });
  let { app, textarea } = createApp({ failGet: true });

  await activateComposerDraftSession(app, 'ses_1');
  assert.equal(textarea.value, 'typed while offline');
  assert.equal(app._state.draft, 'typed while offline');
});

test('deleting the active draft clears the composer and local fallback', async () => {
  installStorage();
  let { app, textarea, requests } = createApp();
  syncComposerDraft(app, 'delete me');
  let draftID = readLocalComposerDraft('ses_1').draftID;

  assert.equal(await deleteComposerHistoryEntry(app, {
    kind: 'draft',
    draftID,
    text: 'delete me',
  }), true);
  assert.equal(textarea.value, '');
  assert.equal(app._state.draft, '');
  assert.equal(readLocalComposerDraft('ses_1'), null);
  assert.match(requests.at(-1).url, new RegExp(`/composer/drafts/${draftID}$`));
});


test('a successful empty server response clears a stale local draft', async () => {
  installStorage();
  writeLocalComposerDraft('ses_1', { draftID: 'draft_sent', text: 'already delivered' });
  let { app, textarea } = createApp();

  await activateComposerDraftSession(app, 'ses_1');

  assert.equal(textarea.value, '');
  assert.equal(app._state.draft, '');
  assert.equal(readLocalComposerDraft('ses_1'), null, 'server emptiness wins over the local cache');
});

test('a delivered draft cannot be restored from a stale server row', async () => {
  installStorage();
  let delivered = 'message that was already sent';
  writeLocalComposerDraft('ses_1', { draftID: 'draft_sent', text: delivered });
  markComposerDraftSent('ses_1', { draftID: 'draft_sent', text: delivered });
  let { app, textarea, requests } = createApp({
    getResult: {
      data: {
        drafts: [
          { draftID: 'draft_sent', text: delivered, updatedAt: Date.now() },
        ],
      },
    },
  });

  let controller = getComposerDraftController(app, 'ses_1');
  controller.draftID = 'draft_sent';
  controller.text = delivered;
  controller.savedText = delivered;

  await activateComposerDraftSession(app, 'ses_1');

  assert.equal(textarea.value, '');
  assert.equal(app._state.draft, '');
  assert.equal(controller.text, '', 'in-memory copy is invalidated too');
  assert.equal(readLocalComposerDraft('ses_1'), null);
  assert.match(requests.at(-1).url, /composer\/drafts\/draft_sent$/);
  assert.equal(requests.at(-1).method, 'DELETE');
});

test('a real server draft still repopulates after reload', async () => {
  installStorage();
  let { app, textarea } = createApp({
    getResult: {
      data: {
        drafts: [
          { draftID: 'draft_live', text: 'not sent yet', updatedAt: 1 },
        ],
      },
    },
  });

  await activateComposerDraftSession(app, 'ses_1');

  assert.equal(textarea.value, 'not sent yet');
  assert.equal(app._state.draft, 'not sent yet');
  assert.equal(readLocalComposerDraft('ses_1').draftID, 'draft_live');
});

test('clearing a sent draft waits for an in-flight save before deleting it', async () => {
  installStorage();
  let { app, requests } = createApp();
  syncComposerDraft(app, 'send this once');
  let draftID = readLocalComposerDraft('ses_1').draftID;
  let finishPut;
  let putStarted;
  let started = new Promise((resolve) => { putStarted = resolve; });
  app._putJSON = async (url, body) => {
    requests.push({ method: 'PUT', url, body });
    putStarted();
    await new Promise((resolve) => { finishPut = resolve; });
    return { data: { draft: { draftID } } };
  };

  let save = flushComposerDraft(app, 'ses_1');
  await started;
  let clear = clearComposerDraftWithServer(app, 'ses_1');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.some((request) => request.method === 'DELETE'), false, 'DELETE must not overtake the PUT');

  finishPut();
  await save;
  await clear;
  assert.deepEqual(requests.map((request) => request.method), [ 'PUT', 'DELETE' ]);
  assert.equal(readLocalComposerDraft('ses_1'), null);
});
