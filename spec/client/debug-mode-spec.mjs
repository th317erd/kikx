'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEBUG_MODE_STORAGE_KEY,
  readDebugMode,
  setDebugMode,
  toggleDebugMode,
  writeDebugMode,
} from '../../src/client/lib/debug-mode.mjs';

function storage() {
  let values = new Map();
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
    values,
  };
}

test('debug mode persists in localStorage and supports a URL override', () => {
  globalThis.localStorage = storage();
  globalThis.location = { search: '' };
  assert.equal(readDebugMode(), false);
  writeDebugMode(true);
  assert.equal(globalThis.localStorage.getItem(DEBUG_MODE_STORAGE_KEY), '1');
  assert.equal(readDebugMode(), true);
  writeDebugMode(false);
  assert.equal(readDebugMode(), false);

  globalThis.location = { search: '?debug=1' };
  assert.equal(readDebugMode(), true);
  assert.equal(globalThis.localStorage.getItem(DEBUG_MODE_STORAGE_KEY), '1');
  globalThis.location = { search: '?debug=0' };
  assert.equal(readDebugMode(), false);
  assert.equal(globalThis.localStorage.getItem(DEBUG_MODE_STORAGE_KEY), null);
});

test('debug mode toggles app state and the debug class', () => {
  globalThis.localStorage = storage();
  globalThis.location = { search: '' };
  let app = {
    _state: { debugMode: false },
    classList: {
      value: '',
      toggle(name, force) {
        if (force) this.value = name;
        else this.value = '';
      },
    },
  };

  assert.equal(toggleDebugMode(app), true);
  assert.equal(app._state.debugMode, true);
  assert.equal(app.classList.value, 'kikx-debug-mode');
  assert.equal(toggleDebugMode(app), false);
  assert.equal(app._state.debugMode, false);
  assert.equal(app.classList.value, '');

  setDebugMode(app, true);
  assert.equal(app._state.debugMode, true);
});
