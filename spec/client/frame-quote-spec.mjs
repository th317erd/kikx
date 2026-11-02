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

function installCaret(textarea, start) {
  let position = Number.isInteger(start) ? start : textarea.value.length;
  textarea.selectionStart = position;
  textarea.selectionEnd = position;
  textarea.setSelectionRange = (nextStart, nextEnd = nextStart) => {
    textarea.selectionStart = nextStart;
    textarea.selectionEnd = nextEnd;
  };
  textarea.focused = false;
  textarea.focus = () => { textarea.focused = true; };
  return textarea;
}

function createComposerApp(textarea, draftText = textarea.value) {
  let app = {
    _state: { selectedSessionID: 'ses_1', draft: draftText },
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
  return app;
}

function typeInto(app, textarea, text) {
  textarea.value += text;
  app._state.draft = textarea.value;
  textarea.selectionStart = textarea.value.length;
  textarea.selectionEnd = textarea.value.length;
}

test('quoting inserts at the caret without moving surrounding text', async () => {
  let textarea = document.createElement('textarea');
  textarea.name = 'message';
  textarea.value = 'before text after';
  installCaret(textarea, 7);
  let app = createComposerApp(textarea);
  let marker = 'User is asking about and referring to frame id[frame_1]:';

  let replaced = await quoteFrameIntoComposer(app, { frameID: 'frame_1', text: 'the quoted text' });

  assert.equal(replaced, true);
  assert.equal(textarea.value, [
    'before ',
    marker,
    'the quoted text',
    '',
    'text after',
  ].join('\n'));
  let insertion = `\n${marker}\nthe quoted text\n\n`;
  assert.equal(textarea.selectionStart, 7 + insertion.length, 'caret lands after the inserted block');
  assert.equal(textarea.selectionEnd, 7 + insertion.length);
  assert.equal(textarea.focused, true);
  assert.equal(app._state.draft, textarea.value);
  let controller = getComposerDraftController(app, 'ses_1');
  assert.equal(controller.text, textarea.value, 'the draft controller mirrors the insert');
});

test('every quote insert lands: quote, comment, quote, same frame again', async () => {
  let textarea = document.createElement('textarea');
  textarea.name = 'message';
  textarea.value = '';
  installCaret(textarea, 0);
  let app = createComposerApp(textarea);
  let marker = (id) => `User is asking about and referring to frame id[${id}]:`;

  await quoteFrameIntoComposer(app, { frameID: 'frame_1', text: 'first quote' });
  typeInto(app, textarea, 'my comment');
  await quoteFrameIntoComposer(app, { frameID: 'frame_2', text: 'second quote' });
  await quoteFrameIntoComposer(app, { frameID: 'frame_1', text: 'first quote' });

  let value = textarea.value;
  assert.equal(value, [
    marker('frame_1'),
    'first quote',
    '',
    'my comment',
    marker('frame_2'),
    'second quote',
    '',
    marker('frame_1'),
    'first quote',
    '',
    '',
  ].join('\n'));
  assert.equal((value.match(/frame id\[frame_1\]:/g) || []).length, 2, 'the same frame can be quoted again');
  assert.equal((value.match(/frame id\[frame_2\]:/g) || []).length, 1);
  assert.ok(value.indexOf('my comment') < value.indexOf(marker('frame_2')), 'typed text stays put between quotes');
});

test('parallel double-clicks serialize; both inserts land at the caret', async () => {
  let textarea = document.createElement('textarea');
  textarea.name = 'message';
  textarea.value = 'draft line';
  installCaret(textarea, 10);
  let app = createComposerApp(textarea);

  await Promise.all([
    quoteFrameIntoComposer(app, { frameID: 'frame_1', text: 'the quote' }),
    quoteFrameIntoComposer(app, { frameID: 'frame_1', text: 'the quote' }),
  ]);

  assert.equal((textarea.value.match(/frame id\[frame_1\]:/g) || []).length, 2);
  assert.ok(textarea.value.startsWith('draft line\n'), 'pre-existing text is not disturbed');
  assert.equal(app._state.draft, textarea.value);
  assert.equal(textarea.selectionStart, textarea.value.length, 'caret rests after the second insert');
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
