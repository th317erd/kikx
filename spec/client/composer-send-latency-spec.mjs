'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

import { installDom } from './support/mini-dom.mjs';

register(new URL('./support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);

const { document } = installDom();
globalThis.document = document;
globalThis.localStorage = createStorage();

const { onSubmit } = await import('../../src/client/components/kikx-composer.mjs');
const { getComposerDraftController } = await import('../../src/client/components/composer-drafts.mjs');

function createStorage() {
  let values = new Map();
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
    clear() { values.clear(); },
  };
}

test('sending renders the durable message before draft cleanup or refresh completes', async () => {
  let textarea = document.createElement('textarea');
  textarea.name = 'message';
  textarea.value = 'hello';
  let timeline = [];
  let resolveDelete;
  let deleteDone = new Promise((resolve) => { resolveDelete = resolve; });
  let app = {
    _state: {
      selectedSessionID: 'ses_1',
      draft: 'hello',
      account: { name: 'Wyatt' },
      sessionIDs: [],
      sessionDetailsByID: {},
      framesBySessionID: {},
      sessionPagingByID: {},
      status: '',
      statusKind: '',
    },
    querySelector(selector) {
      return selector === 'textarea[name="message"]' ? textarea : null;
    },
    async _postJSON() {
      timeline.push('post');
      return {
        data: {
          session: { id: 'ses_1', title: 'Session 1' },
          frame: {
            id: 'msg_1',
            type: 'UserMessage',
            sessionID: 'ses_1',
            authorType: 'user',
            content: { text: 'hello' },
          },
        },
      };
    },
    _deleteJSON() {
      timeline.push('delete');
      return deleteDone;
    },
    _render() {
      timeline.push('render');
    },
  };
  let controller = getComposerDraftController(app, 'ses_1');
  controller.draftID = 'draft_1';
  controller.text = 'hello';
  controller.savedText = 'hello';

  await onSubmit(app, { preventDefault() {} });

  assert.deepEqual(timeline, [ 'delete', 'post', 'render' ]);
  assert.equal(textarea.value, '');
  assert.equal(app._state.draft, '');
  assert.equal(app._state.frameListAnchoredToBottom, undefined);
  assert.equal(app._forceScrollToBottomAfterRender, true);

  resolveDelete();
  await deleteDone;
  await new Promise((resolve) => setTimeout(resolve, 0));
});
