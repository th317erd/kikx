'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { createDraftStore, getAnswerDraft, setAnswerDraft } from '../../src/client/state/question-drafts.mjs';

function installStorage() {
  let values = new Map();
  globalThis.localStorage = {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
  return values;
}

test('question drafts are coalesced into local storage and restore into a new store', async () => {
  installStorage();
  let store = createDraftStore({ sessionID: 'ses_1' });
  setAnswerDraft(store, 'q_1', 'typed answer');

  assert.equal(globalThis.localStorage.getItem('kikx.questionDrafts.ses_1'), null, 'typing must not synchronously serialize');
  await new Promise((resolve) => setTimeout(resolve, 160));

  let restored = createDraftStore({ sessionID: 'ses_1' });
  assert.equal(getAnswerDraft(restored, 'q_1'), 'typed answer');
});
