'use strict';

// App-wide button colors (owner, 2026-11-13): "I asked you to change all
// button colors app-wide… why did they also not change for the rest of the
// app?" Root cause recorded here as pins: the theme pass swapped the 26
// EXISTING blue instances (what was already primary-blue followed the theme),
// most buttons were never blue (transparent vendor aeor-button, neutral
// #1b2027/#242a30 chrome), and the Email tab was written post-theme with an
// explicit accent recipe — the only deliberate one. The fix: ONE recipe
// (--kikx-btn-*) defined once on :root, a global element default, and every
// neutral surface converted to reference it. Semantic exceptions (STOP red,
// palette swatches, error chips) keep their own rules — pinned below so they
// can never be swept in by accident.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const STYLES = fileURLToPath(new URL('../../src/client/styles/', import.meta.url));
const COMPONENT = fileURLToPath(new URL(
  '../../src/client/components/kikx-settings-email-section.mjs', import.meta.url));

const read = (name) => readFile(path.join(STYLES, name), 'utf8');

// Extract the first rule body whose selector block starts at `selector`
// (flat rules — these sheets write one declaration block per rule).
function ruleBlock(css, selector) {
  const index = css.indexOf(selector);
  assert.notEqual(index, -1, `selector present: ${selector}`);
  const open = css.indexOf('{', index);
  const close = css.indexOf('}', open);
  return css.slice(open, close);
}

test('the ONE recipe lives on :root and derives from the chosen accent', async () => {
  const shell = await read('app-base-shell.css');
  for (const variable of [ '--kikx-btn-bg', '--kikx-btn-bg-hover', '--kikx-btn-border' ]) {
    const match = new RegExp(`${variable}:\\s*color-mix\\(in srgb, var\\(--kikx-accent\\)[^)]*\\)`, 'u').exec(shell);
    assert.ok(match, `${variable} is a color-mix over var(--kikx-accent) — one knob moves it`);
  }
});

test('the global element default exists (aeor-button + button, load order after vendor)', async () => {
  const shell = await read('app-base-shell.css');
  assert.match(shell, /aeor-button,\s*\nbutton\s*\{[^}]*var\(--kikx-btn-bg\)/u,
    'resting background comes from the recipe');
  assert.match(shell, /button:hover:not\(:disabled\)[^}]*var\(--kikx-btn-bg-hover\)/u,
    'hover comes from the recipe');
});

test('the two hardcoded send-state blues are gone app-wide', async () => {
  const files = [ 'app-composer.css', 'questions-answers.css', 'app-views.css',
    'app-base-shell.css', 'app-workspace.css', 'app-thinking.css',
    'topbar-unified.css', 'overflow-popup.css', 'mobile.css', 'app.css' ];
  for (const name of files) {
    const css = await read(name);
    assert.equal(css.includes('#5b84ff'), false, `${name} must not carry #5b84ff`);
    assert.equal(css.includes('#2b4aad'), false, `${name} must not carry #2b4aad`);
  }
});

test('every formerly-neutral button surface references the recipe', async () => {
  const pins = [
    [ 'app-views.css', '.kikx-settings-plugins__install-btn,' ],
    [ 'app-views.css', '.kikx-settings-email__save {' ],
    [ 'app-composer.css', '.kikx-icon-button,' ],
    [ 'app-composer.css', '.kikx-sign-out-button {' ],
    [ 'app-workspace.css', '.kikx-session-toolbar__button {' ],
    [ 'app-thinking.css', '.kikx-frame-filter__button {' ],
    [ 'questions-answers.css', '.kikx-question-frame__submit {' ],
  ];
  for (const [ name, selector ] of pins) {
    const block = ruleBlock(await read(name), selector);
    assert.ok(
      block.includes('var(--kikx-btn-bg)') || block.includes('var(--kikx-accent)'),
      `${selector} in ${name} follows the recipe (got: ${block.replace(/\s+/g, ' ').trim()})`,
    );
  }
});

test('the Email tab consumed the shared recipe (no private color-mix left)', async () => {
  const block = ruleBlock(await read('app-views.css'), '.kikx-settings-email__save {');
  assert.ok(block.includes('var(--kikx-btn-bg)'), 'save uses the shared background');
  assert.equal(block.includes('color-mix'), false,
    'the recipe lives once in app-base-shell, not re-mixed per surface');
});

test('semantic exceptions survive the global rule (class rules outrank it)', async () => {
  const composer = await read('app-composer.css');
  assert.match(composer, /\.kikx-stop-button[^{]*\{[^}]*#4a0f0f/u,
    'STOP keeps its dark-red semantic fill');
  const views = await read('app-views.css');
  assert.match(views, /\.kikx-theme-picker__swatch--red\s*\{[^}]*#d43f3f/u,
    'palette swatches keep their chips (they are the palette, not actions)');
  assert.match(views, /#3fb950/u, 'Installed/success green is untouched');
});

test('our rails force FULL corner radii on tabs — the vendor square-right rail reads as cut-off here (owner 2026-11-14)', async () => {
  // Vendor design note (owner, decoded annotation): left-rail tabs have NO
  // right-side corner radius by design — correct generically, "terribly
  // ugly" in our scenario, where it reads as the item being clipped by the
  // divider. Ruling: force full-corner-radiuses for OUR scenario — consumer
  // override scoped to kikx-view-container rails; the vendor default stays.
  const base = await read('app-base-shell.css');
  const rule = base.match(
    /aeor-tab-view\.kikx-view-container\[tab-bar-position="left"\]\s+\.tab\s*\{[^}]*\}/u,
  );
  assert.ok(rule,
    'a consumer override rule exists for our left-rail tabs');
  assert.match(rule[0], /border-radius:\s*0\.375rem\s*;/u,
    'every corner is rounded (radius on all four sides, not left-only)');
  assert.match(rule[0], /border-right:\s*1px solid transparent/u,
    'the fourth border side is restored so the active accent completes the chip');
});

test('rail footer buttons (Account / Sign out) wear the app-wide button recipe — colors, border, hover (owner 2026-11-14)', async () => {
  // The scoped rule in topbar-unified (specificity 0,2,0) used to beat the
  // recipe-based .kikx-sign-out-button rule in app-composer and forced
  // `border: 0; background: transparent` — flat rows with no colors, no
  // border and a hover nothing like the rest of the app (owner annotation).
  const topbar = await read('topbar-unified.css');
  const base = topbar.match(/\.kikx-session-objects \.kikx-sign-out-button\s*\{[^}]*\}/u);
  assert.ok(base, 'the scoped footer-button rule exists');
  assert.match(base[0], /border:\s*1px solid var\(--kikx-btn-border\)/u,
    'border comes from the shared recipe');
  assert.match(base[0], /background:\s*var\(--kikx-btn-bg\)/u,
    'fill comes from the shared recipe');
  assert.ok(!/background:\s*transparent/u.test(base[0]),
    'the transparent override is gone');
  const hover = topbar.match(/\.kikx-session-objects \.kikx-sign-out-button:hover,\s*\n\.kikx-session-objects \.kikx-sign-out-button:focus-visible\s*\{[^}]*\}/u);
  assert.ok(hover, 'the hover/focus rule exists');
  assert.match(hover[0], /background:\s*var\(--kikx-btn-bg-hover\)/u,
    'hover fill from the recipe');
  assert.match(hover[0], /border-color:\s*var\(--kikx-accent\)/u,
    'hover border completes the accent, like every other button');
});
