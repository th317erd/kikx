'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  THEME_STORAGE_KEY,
  THEME_PALETTE,
  DEFAULT_THEME_ID,
  themeHex,
  readThemeID,
  writeThemeID,
  applyTheme,
  initTheme,
  setPrimaryTheme,
} from '../../src/client/lib/theme.mjs';

// Owner request (2026-11-11): the app is VERY gray — set up a THEME whose
// primary color is chosen from a rainbow (red, orange, yellow, green, cyan,
// blue, purple, pink), applied to buttons and other primary elements.
// Architecture: ONE CSS custom property (--kikx-accent) swapped at runtime;
// --accent aliases the AEOR framework convention so vendor components
// (tab-view, links, aeor-button) follow automatically; the 26 hardcoded
// primary blues in the stylesheets become var(--kikx-accent).

function storage() {
  let values = new Map();
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
    values,
  };
}

test('the palette is exactly the eight owner-named rainbow colors, in order', () => {
  assert.deepEqual(
    THEME_PALETTE.map((c) => c.id),
    [ 'red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple', 'pink' ],
    'the owner list, in rainbow order',
  );
  assert.equal(THEME_PALETTE.length, 8);
  for (const entry of THEME_PALETTE) {
    assert.match(entry.hex, /^#[0-9a-f]{6}$/i, `${entry.id} is a 6-digit hex`);
    assert.ok(typeof entry.label === 'string' && entry.label.length > 0, `${entry.id} has a label`);
  }
  assert.equal(new Set(THEME_PALETTE.map((c) => c.hex)).size, 8, 'all eight hexes are distinct');
  assert.equal(DEFAULT_THEME_ID, 'blue', 'the current app look is the default — nobody is surprise-recolored');
  assert.equal(themeHex('blue'), themeHex(DEFAULT_THEME_ID));
  assert.equal(themeHex('not-a-color'), themeHex(DEFAULT_THEME_ID), 'unknown ids fall back to the default');
  assert.equal(themeHex(undefined), themeHex(DEFAULT_THEME_ID));
});

test('read/write persist through localStorage with validation (debug-mode pattern)', () => {
  globalThis.localStorage = storage();

  assert.equal(readThemeID(), DEFAULT_THEME_ID, 'absent key → default');
  writeThemeID('purple');
  assert.equal(globalThis.localStorage.getItem(THEME_STORAGE_KEY), 'purple');
  assert.equal(readThemeID(), 'purple', 'a valid stored id round-trips');

  globalThis.localStorage.setItem(THEME_STORAGE_KEY, 'chartreuse; DROP TABLE');
  assert.equal(readThemeID(), DEFAULT_THEME_ID, 'garbage never reaches the stylesheet — validated');

  writeThemeID('nope');
  assert.equal(readThemeID(), DEFAULT_THEME_ID, 'writes are validated too');

  globalThis.localStorage = undefined;
});

test('applyTheme sets the accent variable; setPrimaryTheme is state + storage + paint', () => {
  const written = [];
  const root = { style: { setProperty: (k, v) => written.push([ k, v ]) } };
  globalThis.localStorage = storage();

  applyTheme(root, 'pink');
  assert.deepEqual(written, [ [ '--kikx-accent', themeHex('pink') ] ],
    'ONE custom property — --accent and every consumer derive from it');

  const state = {};
  setPrimaryTheme(state, 'purple', root);
  assert.equal(state.themeID, 'purple', 'state records the choice (next paint renders it selected)');
  assert.equal(globalThis.localStorage.getItem(THEME_STORAGE_KEY), 'purple', 'persisted');
  assert.deepEqual(written.at(-1), [ '--kikx-accent', themeHex('purple') ], 'applied immediately — no reload needed');

  setPrimaryTheme(state, 'evil', root);
  assert.equal(state.themeID, DEFAULT_THEME_ID, 'invalid input normalizes to the default everywhere at once');

  // initTheme = read + apply at boot, returns the id for state
  globalThis.localStorage.setItem(THEME_STORAGE_KEY, 'green');
  const id = initTheme(root);
  assert.equal(id, 'green');
  assert.equal(written.at(-1)[1], themeHex('green'), 'boot applies the stored choice before first paint');

  globalThis.localStorage = undefined;
});
