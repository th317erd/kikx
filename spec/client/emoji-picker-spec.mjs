'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { register } from 'node:module';

import { installDom } from './support/mini-dom.mjs';

register(new URL('./support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);

const { document } = installDom();
const listeners = new Map();
document.addEventListener = (type, listener) => {
  let set = listeners.get(type) || new Set();
  set.add(listener);
  listeners.set(type, set);
};
document.removeEventListener = (type, listener) => {
  listeners.get(type)?.delete(listener);
};
globalThis.document = document;

const { KikxEmojiPicker } = await import('../../src/client/components/kikx-emoji-picker.mjs');
const { handleEmojiPickerKeydown, updateEmojiPickerFromComposer } = await import('../../src/client/components/composer-emoji.mjs');
const { onComposerKeydown } = await import('../../src/client/components/kikx-composer.mjs');

// A textarea stand-in. mini-dom has no selection model, which is precisely why
// the picker takes the caret as an argument instead of reading it off the node.
// NOTE: `selectionStart` here is the harness's own field. It proves the picker
// WRITES a caret; it does not prove a browser places one. That claim belongs to
// spec/ui/playwright/emoji-picker-playwright.mjs.
function createTextarea(value = '', caret = value.length) {
  let attrs = new Map();
  let node = {
    value,
    selectionStart: caret,
    setSelectionRange(start, end) {
      node.selectionStart = start;
      node.selectionEnd = end;
    },
    setAttribute(name, value) {
      attrs.set(name, String(value));
    },
    getAttribute(name) {
      return attrs.has(name) ? attrs.get(name) : null;
    },
    removeAttribute(name) {
      attrs.delete(name);
    },
    form: null,
  };
  return node;
}

function createApp(textarea) {
  let drafts = [];
  let app = {
    _state: { draft: textarea.value },
    querySelector(selector) {
      return selector === 'textarea[name="message"]' ? textarea : null;
    },
    _syncDraft(event) {
      app._state.draft = event.target.value;
      drafts.push(event.target.value);
    },
    get drafts() {
      return drafts;
    },
  };
  return app;
}

function mount(app, textarea) {
  let picker = new KikxEmojiPicker();
  picker.configure({ app, textarea });
  return picker;
}

function keyEvent(key, extra = {}) {
  let prevented = 0;
  let stopped = 0;
  return {
    key,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    preventDefault() { prevented += 1; },
    stopPropagation() { stopped += 1; },
    get prevented() { return prevented; },
    get stopped() { return stopped; },
    ...extra,
  };
}

test('a colon query opens the picker and lists matching emoji', () => {
  let textarea = createTextarea(':smi');
  let app = createApp(textarea);
  let picker = mount(app, textarea);

  assert.equal(updateEmojiPickerFromComposer(app, { target: textarea }), true);
  assert.equal(picker.isOpen, true);
  assert.ok(picker.results.length > 0);
  assert.ok(picker.results.some((e) => e.char === '😊' || e.char === '😄' || e.char === '🙂'),
    'a `:smi` query should surface a smile family glyph');
});

test('a bare colon opens the picker with a popular set, as the owner asked', () => {
  let textarea = createTextarea(':');
  let app = createApp(textarea);
  let picker = mount(app, textarea);

  assert.equal(updateEmojiPickerFromComposer(app, { target: textarea }), true,
    'typing `:` alone must open the picker');
  assert.equal(picker.isOpen, true);
  assert.ok(picker.results.length > 1, 'the empty query offers a popular set, not one row');
  assert.ok(picker.results.some((e) => e.name === 'thumbsup'));
});

test('a value with no colon keeps the picker closed', () => {
  let textarea = createTextarea('just typing');
  let app = createApp(textarea);
  let picker = mount(app, textarea);

  assert.equal(updateEmojiPickerFromComposer(app, { target: textarea }), false);
  assert.equal(picker.isOpen, false);
});

test('the negative cases stay shut: http://, 12:30, and a mid-word colon', () => {
  for (let value of ['http://example.com', '12:30', 'foo:bar']) {
    let textarea = createTextarea(value);
    let app = createApp(textarea);
    let picker = mount(app, textarea);
    assert.equal(updateEmojiPickerFromComposer(app, { target: textarea }), false,
      `${value} must not open the picker`);
    assert.equal(picker.isOpen, false, `${value} left the picker open`);
  }
});

test('a query with no matches closes the picker instead of showing an empty box', () => {
  let textarea = createTextarea(':zzzzzznope');
  let app = createApp(textarea);
  let picker = mount(app, textarea);

  assert.equal(updateEmojiPickerFromComposer(app, { target: textarea }), false);
  assert.equal(picker.isOpen, false);
});

test('typing narrows the list incrementally and restarts the highlight', () => {
  let textarea = createTextarea(':s');
  let app = createApp(textarea);
  let picker = mount(app, textarea);
  updateEmojiPickerFromComposer(app, { target: textarea });
  let wide = picker.results.length;

  picker.moveSelection(3);
  assert.equal(picker.selectedIndex, 3);

  textarea.value = ':sm';
  textarea.selectionStart = 3;
  updateEmojiPickerFromComposer(app, { target: textarea });
  let narrow = picker.results.length;

  assert.ok(narrow > 0, ':sm must still match something');
  assert.ok(narrow <= wide, 'a longer query must not widen the list');
  assert.equal(picker.selectedIndex, 0, 'a changed query restarts at the top result');
});

test('Enter with the picker open inserts the emoji and does NOT submit the form', () => {
  let submitted = 0;
  let textarea = createTextarea(':tad');
  textarea.form = { requestSubmit() { submitted += 1; } };
  let app = createApp(textarea);
  mount(app, textarea);
  updateEmojiPickerFromComposer(app, { target: textarea });

  let event = keyEvent('Enter', { target: textarea });
  onComposerKeydown(app, event);

  assert.equal(submitted, 0, 'Enter must not send the half-written `:tad` message');
  assert.equal(event.prevented, 1, 'Enter must be claimed');
  assert.equal(textarea.value, '🎉');
  assert.equal(app._state.draft, '🎉');
});

test('Tab also accepts, so the picker is keyboard-complete', () => {
  let textarea = createTextarea(':roc');
  let app = createApp(textarea);
  mount(app, textarea);
  updateEmojiPickerFromComposer(app, { target: textarea });

  let event = keyEvent('Tab', { target: textarea });
  onComposerKeydown(app, event);

  assert.equal(textarea.value, '🚀');
  assert.equal(event.prevented, 1, 'Tab must not move focus after accepting');
});

test('Enter with the picker CLOSED still submits, so normal sending is unchanged', () => {
  let submitted = 0;
  let textarea = createTextarea('hello');
  textarea.form = { requestSubmit() { submitted += 1; } };
  let app = createApp(textarea);
  mount(app, textarea);

  onComposerKeydown(app, keyEvent('Enter', { target: textarea }));

  assert.equal(submitted, 1, 'the plain send path must be untouched');
});

test('ArrowDown then Enter selects the second result, not the first', () => {
  let textarea = createTextarea(':th');
  let app = createApp(textarea);
  let picker = mount(app, textarea);
  updateEmojiPickerFromComposer(app, { target: textarea });

  let first = picker.results[0];
  let second = picker.results[1];
  assert.ok(second, 'need at least two results for this test');
  assert.notEqual(second.char, first.char, 'the first two results must differ for this test');

  onComposerKeydown(app, keyEvent('ArrowDown', { target: textarea }));
  assert.equal(picker.selectedIndex, 1);

  onComposerKeydown(app, keyEvent('Enter', { target: textarea }));
  assert.equal(textarea.value, second.char);
  assert.notEqual(textarea.value, first.char);
});

test('arrow movement wraps at both ends', () => {
  let textarea = createTextarea(':a');
  let app = createApp(textarea);
  let picker = mount(app, textarea);
  updateEmojiPickerFromComposer(app, { target: textarea });
  let count = picker.results.length;
  assert.ok(count > 2, 'need a few results to test wrapping');

  picker.moveSelection(-1);
  assert.equal(picker.selectedIndex, count - 1, 'ArrowUp from the top wraps to the bottom');

  picker.moveSelection(1);
  assert.equal(picker.selectedIndex, 0, 'ArrowDown from the bottom wraps to the top');
});

test('arrow movement scrolls the highlighted row into view', () => {
  let textarea = createTextarea(':a');
  let app = createApp(textarea);
  let picker = mount(app, textarea);
  updateEmojiPickerFromComposer(app, { target: textarea });
  assert.ok(picker.results.length > 2, 'need several rows');

  // Record what the option nodes are asked to do. mini-dom has no layout, so
  // this proves the CALL is made; only the browser spec can prove the row
  // actually came into view.
  let scrolled = [];
  for (let node of picker._optionNodes)
    node.scrollIntoView = (options) => scrolled.push({ node, options });

  picker.moveSelection(1);
  assert.equal(scrolled.length, 1, 'moving must scroll exactly one row into view');
  assert.equal(scrolled[0].node, picker._optionNodes[1], 'it scrolls the row it moved to');
  assert.equal(scrolled[0].options?.block, 'nearest', 'block:nearest keeps the list still when possible');
});

test('arrow movement repaints in place instead of rebuilding the list', () => {
  // A rebuild would drop the scroll offset, so the "row scrolls into view"
  // behaviour above would be pointless. Identity is the cheap way to prove it.
  let textarea = createTextarea(':a');
  let app = createApp(textarea);
  let picker = mount(app, textarea);
  updateEmojiPickerFromComposer(app, { target: textarea });

  let before = picker._optionNodes.slice();
  picker.moveSelection(1);
  let after = picker._optionNodes;

  assert.equal(after.length, before.length);
  for (let index = 0; index < before.length; index += 1)
    assert.equal(after[index], before[index], 'the option nodes must survive a move');
});

test('the listbox mirrors its state into aria on the focused textarea', () => {
  // `:a` deliberately returns several rows: with a single-result query (e.g.
  // `:tad`) moving down wraps straight back to index 0 and the test would
  // assert nothing about following the highlight.
  let textarea = createTextarea(':a');
  let app = createApp(textarea);
  let picker = mount(app, textarea);
  updateEmojiPickerFromComposer(app, { target: textarea });
  assert.ok(picker.results.length > 2, 'need several rows to test movement');

  assert.equal(textarea.getAttribute('aria-expanded'), 'true');
  assert.equal(textarea.getAttribute('aria-controls'), 'kikx-emoji-picker-list');
  assert.equal(textarea.getAttribute('aria-autocomplete'), 'list');

  let active = textarea.getAttribute('aria-activedescendant');
  assert.equal(active, 'kikx-emoji-picker-list-option-0');

  picker.moveSelection(1);
  assert.equal(textarea.getAttribute('aria-activedescendant'), 'kikx-emoji-picker-list-option-1',
    'the active option id follows the highlight');

  let selected = picker._optionNodes.filter((n) => n.getAttribute('aria-selected') === 'true');
  assert.equal(selected.length, 1, 'exactly one option is aria-selected');
  assert.equal(selected[0], picker._optionNodes[1]);

  picker.close();
  assert.equal(textarea.getAttribute('aria-expanded'), 'false');
  assert.equal(textarea.getAttribute('aria-activedescendant'), null,
    'no stale active descendant once closed');
});

test('ArrowUp and ArrowDown are claimed while open, so message history does not fire', () => {
  let textarea = createTextarea(':th');
  let app = createApp(textarea);
  mount(app, textarea);
  updateEmojiPickerFromComposer(app, { target: textarea });

  let up = keyEvent('ArrowUp');
  onComposerKeydown(app, up);
  assert.equal(up.prevented, 1);
  assert.equal(up.stopped, 1, 'history listens on the same node; the picker must win');
});

test('arrows do nothing at all once the picker is closed', () => {
  let textarea = createTextarea('plain text');
  let app = createApp(textarea);
  let picker = mount(app, textarea);
  updateEmojiPickerFromComposer(app, { target: textarea });
  assert.equal(picker.isOpen, false);

  let event = keyEvent('ArrowUp');
  assert.equal(handleEmojiPickerKeydown(app, event), false);
  assert.equal(event.prevented, 0, 'history navigation must be left alone when closed');
  assert.equal(event.stopped, 0);
});

test('Escape closes the picker and leaves the typed text alone', () => {
  let textarea = createTextarea(':smi');
  let app = createApp(textarea);
  let picker = mount(app, textarea);
  updateEmojiPickerFromComposer(app, { target: textarea });

  let event = keyEvent('Escape');
  onComposerKeydown(app, event);

  assert.equal(picker.isOpen, false);
  assert.equal(event.prevented, 1);
  assert.equal(textarea.value, ':smi', 'closing must not edit the draft');
});

test('deleting back past the colon closes the picker', () => {
  let textarea = createTextarea(':smi');
  let app = createApp(textarea);
  let picker = mount(app, textarea);
  updateEmojiPickerFromComposer(app, { target: textarea });
  assert.equal(picker.isOpen, true);

  // Backspace three times: `:smi` -> `:`. A lone colon still offers the set.
  textarea.value = ':';
  textarea.selectionStart = 1;
  assert.equal(updateEmojiPickerFromComposer(app, { target: textarea }), true,
    'a lone colon still offers the popular set');

  // One more Backspace removes the colon itself and must dismiss.
  textarea.value = '';
  textarea.selectionStart = 0;
  assert.equal(updateEmojiPickerFromComposer(app, { target: textarea }), false);
  assert.equal(picker.isOpen, false, 'deleting the colon dismisses the picker');
});

test('Shift+Enter passes through so a newline still works', () => {
  let textarea = createTextarea(':smi');
  let app = createApp(textarea);
  let picker = mount(app, textarea);
  updateEmojiPickerFromComposer(app, { target: textarea });

  let event = keyEvent('Enter', { shiftKey: true });
  let consumed = handleEmojiPickerKeydown(app, event);

  assert.equal(consumed, false, 'Shift+Enter must not be swallowed');
  assert.equal(event.prevented, 0);
  assert.equal(picker.isOpen, false, 'but the picker should get out of the way');
});

test('selecting replaces only the :query span and preserves surrounding text', () => {
  let textarea = createTextarea('hi :fire please', 8);
  let app = createApp(textarea);
  let picker = mount(app, textarea);
  updateEmojiPickerFromComposer(app, { target: textarea });

  picker.select(0);

  assert.equal(textarea.value, 'hi 🔥 please');
  assert.equal(textarea.selectionStart, 'hi 🔥'.length, 'the picker writes the caret right after the glyph');
  assert.ok(app.drafts.includes('hi 🔥 please'), 'the draft sync runs, exactly as typing would');
});

test('a click on an option commits the same way a keypress does', () => {
  let textarea = createTextarea('x :tad');
  let app = createApp(textarea);
  let picker = mount(app, textarea);
  updateEmojiPickerFromComposer(app, { target: textarea });

  let option = picker._list.childNodes.find((n) => n.getAttribute?.('data-emoji') === picker.results[0].char);
  assert.ok(option, 'the rendered list must carry the option nodes');

  let prevented = 0;
  option.dispatchEvent({ type: 'mousedown', preventDefault() { prevented += 1; } });

  assert.equal(prevented, 1, 'mousedown must be claimed so focus stays in the textarea');
  assert.equal(textarea.value, 'x 🎉');
});

test('mousedown fires before click, and the click must not double-insert', () => {
  let textarea = createTextarea(':tad');
  let app = createApp(textarea);
  let picker = mount(app, textarea);
  updateEmojiPickerFromComposer(app, { target: textarea });

  let option = picker._list.childNodes[0];
  option.dispatchEvent({ type: 'mousedown', preventDefault() {} });
  let afterDown = textarea.value;
  // A real browser sends click after mousedown; the node is detached by then,
  // but the listener still runs, so it must be a no-op rather than a 2nd insert.
  option.dispatchEvent({ type: 'click', preventDefault() {} });

  assert.equal(afterDown, '🎉');
  assert.equal(textarea.value, '🎉', 'the trailing click must not insert twice');
});

test('the picker closes when the caret moves out of the token', () => {
  let textarea = createTextarea(':smi');
  let app = createApp(textarea);
  let picker = mount(app, textarea);
  updateEmojiPickerFromComposer(app, { target: textarea });
  assert.equal(picker.isOpen, true);

  textarea.value = ':smi done';
  textarea.selectionStart = textarea.value.length;
  assert.equal(updateEmojiPickerFromComposer(app, { target: textarea }), false);
  assert.equal(picker.isOpen, false);
});

test('no app or no picker means the keydown bridge is inert, never a crash', () => {
  assert.equal(handleEmojiPickerKeydown(null, keyEvent('Enter')), false);
  assert.equal(handleEmojiPickerKeydown({}, keyEvent('Enter')), false);
  assert.equal(updateEmojiPickerFromComposer(null, { target: createTextarea('x') }), false);
});
