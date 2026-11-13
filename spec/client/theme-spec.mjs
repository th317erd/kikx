'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  THEME_PROPERTY_KEY,
  THEME_PROPERTIES_URL,
  THEME_PALETTE,
  DEFAULT_THEME_ID,
  themeHex,
  applyTheme,
  initTheme,
  loadAccountTheme,
  setPrimaryTheme,
} from '../../src/client/lib/theme.mjs';

// Owner request (2026-11-11), migrated 2026-11-13 (plan P4, properties
// store): the primary color must FOLLOW THE USER — it is an account-scoped
// property (/core/user/theme/primary_color), not browser-local state.
// HARD CUT (owner ruling: "I am the only user in the world currently"): no
// localStorage import, kikx.theme becomes dead code — boot paints default
// blue until the account fetch lands, and the picker persists over P3.
// Architecture stays: ONE custom property (--kikx-accent) on <html>.

function storage() {
  const values = new Map();
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

test('the property identity the whole feature hangs on (plan §6)', () => {
  assert.equal(THEME_PROPERTY_KEY, '/core/user/theme/primary_color');
  assert.equal(THEME_PROPERTIES_URL, '/api/v1/properties');
});

test('initTheme paints default blue — the hard cut never touches localStorage', () => {
  globalThis.localStorage = storage();
  const written = [];
  const root = { style: { setProperty: (k, v) => written.push([ k, v ]) } };

  const id = initTheme(root);
  assert.equal(id, DEFAULT_THEME_ID, 'boot holds default blue until the account fetch lands');
  assert.deepEqual(written, [ [ '--kikx-accent', themeHex(DEFAULT_THEME_ID) ] ]);
  assert.equal(globalThis.localStorage.values.size, 0, 'localStorage is dead code — nothing is read or written');

  globalThis.localStorage = undefined;
});

test('loadAccountTheme: fetched value applies and lands in state; guards keep it one request', async () => {
  const root = { style: { setProperty: () => {} } };
  const applied = [];
  const fakeRoot = { style: { setProperty: (k, v) => applied.push([ k, v ]) } };

  // Missing app / fetch helper: nothing to do, no throw.
  assert.equal(await loadAccountTheme(null), null);
  assert.equal(await loadAccountTheme({ _state: {} }), null);

  const state = {};
  let fetches = 0;
  const app = {
    _state: state,
    async _getJSON() {
      fetches += 1;
      return { data: { key: THEME_PROPERTY_KEY, scope_type: 'account', value: 'purple', hasValue: true, version: 1 } };
    },
    _requestRender() {},
  };
  const first = await loadAccountTheme(app, fakeRoot);
  assert.equal(first, 'purple');
  assert.equal(state.themeID, 'purple', 'state records it (the swatch ring renders selected)');
  assert.deepEqual(applied.at(-1), [ '--kikx-accent', themeHex('purple') ], 'the accent var swaps on arrival');
  // Re-entry guard: toggles/re-renders never become a fetch storm.
  assert.equal(await loadAccountTheme(app, fakeRoot), null);
  assert.equal(fetches, 1, 'exactly one account fetch per page');
  void root;
});

test('loadAccountTheme failures hold default blue — silent, no error surface', async () => {
  for (const failure of [
    async () => { throw new Error('network down'); },              // fetch blew up
    async () => { const e = new Error('Not Found'); e.status = 404; throw e; }, // never-set -> 404
    async () => ({ data: { value: 'chartreuse; DROP TABLE' } }),   // invalid id
    async () => ({ data: { hasValue: false } }),                   // cleared row
  ]) {
    const applied = [];
    const fakeRoot = { style: { setProperty: (k, v) => applied.push([ k, v ]) } };
    const state = { themeID: DEFAULT_THEME_ID };
    const app = { _state: state, _getJSON: failure, _requestRender() {} };
    const result = await loadAccountTheme(app, fakeRoot);
    assert.equal(result, null, 'failure keeps the default');
    assert.equal(state.themeID, DEFAULT_THEME_ID, 'state untouched');
    assert.deepEqual(applied, [], 'no paint attempted');
  }
});

test('setPrimaryTheme: instant paint + state, persisted over P3, localStorage untouched', async () => {
  globalThis.localStorage = storage();
  const applied = [];
  const root = { style: { setProperty: (k, v) => applied.push([ k, v ]) } };
  const puts = [];
  const state = {};
  const app = {
    _state: state,
    async _putJSON(url, body) { puts.push([ url, body ]); return { data: { ok: true } }; },
  };

  const next = setPrimaryTheme(app, 'purple', root);
  assert.equal(next, 'purple');
  assert.equal(state.themeID, 'purple', 'state records the choice (next paint renders it selected)');
  assert.deepEqual(applied.at(-1), [ '--kikx-accent', themeHex('purple') ], 'applied immediately — no reload');
  assert.deepEqual(puts, [ [ THEME_PROPERTIES_URL, { key: THEME_PROPERTY_KEY, value: 'purple' } ] ],
    'persisted to the ACCOUNT property (hard cut from localStorage)');
  assert.equal(globalThis.localStorage.values.size, 0, 'localStorage stays dead');

  setPrimaryTheme(app, 'evil', root);
  assert.equal(state.themeID, DEFAULT_THEME_ID, 'invalid input normalizes to the default everywhere at once');
  assert.equal(puts.at(-1)[1].value, DEFAULT_THEME_ID, 'the normalized value is what reaches the server');

  // A bare state (no app / no _putJSON): paint + state, no persist, no throw.
  const bare = {};
  assert.equal(setPrimaryTheme(bare, 'cyan', root), 'cyan');
  assert.equal(bare.themeID, 'cyan');
  assert.equal(puts.length, 2, 'no PUT without a helper');

  globalThis.localStorage = undefined;
});

test('a rejected persist never throws into the click path', async () => {
  const applied = [];
  const root = { style: { setProperty: (k, v) => applied.push([ k, v ]) } };
  const app = {
    _state: {},
    _putJSON() { return Promise.reject(new Error('offline')); },
  };
  const result = setPrimaryTheme(app, 'pink', root);
  assert.equal(result, 'pink', 'the visual applied anyway');
  assert.equal(app._state.themeID, 'pink');
  await new Promise((resolve) => setImmediate(resolve)); // let the swallowed rejection settle
  assert.deepEqual(applied.at(-1), [ '--kikx-accent', themeHex('pink') ]);
});

test('applyTheme sets the accent variable — ONE custom property carries everything', () => {
  const written = [];
  const root = { style: { setProperty: (k, v) => written.push([ k, v ]) } };
  applyTheme(root, 'pink');
  assert.deepEqual(written, [ [ '--kikx-accent', themeHex('pink') ] ]);
});
