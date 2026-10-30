'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RAW_MARKDOWN_STORAGE_KEY,
  readRawMarkdown,
  setRawMarkdown,
  toggleRawMarkdown,
  writeRawMarkdown,
} from '../../src/client/lib/raw-markdown.mjs';

function storage() {
  let values = new Map();
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
    values,
  };
}

test('raw Markdown mode persists locally and defaults off', () => {
  globalThis.localStorage = storage();
  assert.equal(readRawMarkdown(), false);

  writeRawMarkdown(true);
  assert.equal(globalThis.localStorage.getItem(RAW_MARKDOWN_STORAGE_KEY), '1');
  assert.equal(readRawMarkdown(), true);

  writeRawMarkdown(false);
  assert.equal(readRawMarkdown(), false);
});

test('raw Markdown toggles only the app class and the button state', () => {
  globalThis.localStorage = storage();
  let renders = 0;
  let pressed = null;
  let button = {
    classList: {
      value: '',
      toggle(name, force) { this.value = force ? name : ''; },
    },
    setAttribute(name, value) {
      if (name === 'aria-pressed')
        pressed = value;
    },
  };
  let app = {
    _state: { rawMarkdown: false },
    classList: {
      value: '',
      toggle(name, force) {
        this.value = force ? name : '';
      },
    },
    querySelectorAll() { return [ button ]; },
    _render() { renders++; },
  };

  assert.equal(toggleRawMarkdown(app), true);
  assert.equal(app._state.rawMarkdown, true);
  assert.equal(app.classList.value, 'kikx-raw-mode');
  assert.equal(button.classList.value, 'is-on');
  assert.equal(pressed, 'true');
  assert.equal(renders, 0, 'a view-only toggle must not rebuild the shell');

  assert.equal(setRawMarkdown(app, true), true);
  assert.equal(renders, 0);

  assert.equal(toggleRawMarkdown(app), false);
  assert.equal(app._state.rawMarkdown, false);
  assert.equal(app.classList.value, '');
  assert.equal(button.classList.value, '');
  assert.equal(pressed, 'false');
  assert.equal(renders, 0);
});
