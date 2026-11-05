'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { installDom } from './support/mini-dom.mjs';

const { document } = installDom();

import {
  RAW_MARKDOWN_STORAGE_KEY,
  readRawMarkdown,
  setRawMarkdown,
  toggleRawMarkdown,
  writeRawMarkdown,
} from '../../src/client/lib/raw-markdown.mjs';
import {
  isMarkdownRawMode,
  renderMarkdownToElement,
  setMarkdownRawMode,
} from '../../src/client/lib/markdown-renderer.mjs';

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

test('raw mode renders the markdown SOURCE as real, selectable text', () => {
  // Owner, 2026-11-05: "I can not select or copy the markdown styling
  // characters... which is specifically what RAW mode is for." The old paint
  // path (::before/::after markers) is generated content — invisible to
  // selection. The renderer must now emit the source as an actual text node.
  let source = '**bold** and _italics_ with `code`\n# Heading';
  setMarkdownRawMode(true);
  try {
    assert.equal(isMarkdownRawMode(), true);
    let element = renderMarkdownToElement(document, source);
    assert.equal(element.textContent, source, 'every source character exists as real text');
    assert.equal(element.querySelector('strong'), null, 'no rendered tree in raw mode');
    assert.equal(element.querySelector('code'), null, 'backticks stay literal text');
    assert.ok(element.className.includes('kikx-markdown--source'), 'source wrapping class applied');
  } finally {
    setMarkdownRawMode(false);
  }

  let rendered = renderMarkdownToElement(document, source);
  assert.equal(rendered.querySelector('strong')?.textContent, 'bold', 'rendered mode is back');
  assert.doesNotMatch(rendered.textContent, /\*\*bold/, 'delimiters are consumed when rendered');
});

test('setRawMarkdown flips the renderer flag alongside the class', () => {
  globalThis.localStorage = storage();
  let app = { _state: { rawMarkdown: false }, classList: { toggle() {} }, querySelectorAll() { return []; } };
  setMarkdownRawMode(false);

  setRawMarkdown(app, true);
  assert.equal(isMarkdownRawMode(), true, 'renderer follows the toggle');

  setRawMarkdown(app, false);
  assert.equal(isMarkdownRawMode(), false);
});
