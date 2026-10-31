'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

import { installDom } from './support/mini-dom.mjs';

register(new URL('./support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);

const { document } = installDom();
globalThis.document = document;
globalThis.localStorage = createStorage();

const {
  QUOTE_FRAME_EVENT,
  buildFrameQuickActions,
  quoteTextForFrame,
} = await import('../../src/client/components/kikx-frame-quick-actions.mjs');
const { quoteFrameIntoComposer } = await import('../../src/client/components/kikx-composer.mjs');
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

function frame(overrides = {}) {
  return {
    id: 'frame_1',
    type: 'UserMessage',
    content: { text: 'What the hell is this?!? You sent that picture to my mom?!?!' },
    ...overrides,
  };
}

test('the reply quick action emits a quote event with the visible frame text', () => {
  let target = frame();
  let toolbar = buildFrameQuickActions(target, document);
  document.body.appendChild(toolbar);
  let events = [];
  document.body.addEventListener(QUOTE_FRAME_EVENT, (event) => events.push(event.detail));

  toolbar.querySelector('button').dispatchEvent(new Event('click', { bubbles: true, cancelable: true }));

  assert.deepEqual(events, [ {
    frameID: 'frame_1',
    text: 'What the hell is this?!? You sent that picture to my mom?!?!',
  } ]);
  assert.ok(toolbar.querySelector('svg'));
});

test('turn reports quote their short visible summary, not the long details', () => {
  assert.equal(quoteTextForFrame(frame({
    type: 'AgentMessage',
    content: { turnReport: true, summary: '- Short result.', text: 'Long evidence.' },
  })), '- Short result.');
});

test('quoting prefixes the composer and dedupes repeated clicks', async () => {
  let textarea = document.createElement('textarea');
  textarea.name = 'message';
  textarea.value = 'What the hell is this?!? You sent that picture to my mom?!?!';
  let app = {
    _state: {
      selectedSessionID: 'ses_1',
      draft: textarea.value,
    },
    querySelector(selector) {
      return selector === 'textarea[name="message"]' ? textarea : null;
    },
    async _putJSON() {
      return { data: {} };
    },
  };
  let controller = getComposerDraftController(app, 'ses_1');
  controller.text = textarea.value;
  controller.savedText = textarea.value;

  let quote = {
    frameID: 'frame_1',
    text: 'What the hell is this?!? You sent that picture to my mom?!?!',
  };
  await Promise.all([
    quoteFrameIntoComposer(app, quote),
    quoteFrameIntoComposer(app, quote),
  ]);
  let once = textarea.value;
  assert.equal((once.match(/User is asking about and referring to frame id\[frame_1\]:/g) || []).length, 1);
  assert.equal(once, [
    'User is asking about and referring to frame id[frame_1]:',
    'What the hell is this?!? You sent that picture to my mom?!?!',
    '',
    'What the hell is this?!? You sent that picture to my mom?!?!',
  ].join('\n'));

  await quoteFrameIntoComposer(app, quote);
  assert.equal(textarea.value, once, 'the same frame is not quoted twice');
});

test('a pending draft save cannot block a second quote', async () => {
  let textarea = document.createElement('textarea');
  textarea.name = 'message';
  let app = {
    _state: { selectedSessionID: 'ses_1', draft: '' },
    querySelector(selector) {
      return selector === 'textarea[name="message"]' ? textarea : null;
    },
    // Deliberately never resolves: a quote is a local edit and must not wait
    // for the previous draft save chain.
    _putJSON() {
      return new Promise(() => {});
    },
  };
  let controller = getComposerDraftController(app, 'ses_1');
  controller.text = '';
  controller.savedText = '';

  await quoteFrameIntoComposer(app, { frameID: 'frame_1', text: 'first quote' });
  await quoteFrameIntoComposer(app, { frameID: 'frame_2', text: 'second quote' });

  assert.match(textarea.value, /frame id\[frame_1\]:\nfirst quote/);
  assert.match(textarea.value, /frame id\[frame_2\]:\nsecond quote/);
});
