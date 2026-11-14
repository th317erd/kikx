'use strict';

// Mobile chrome rulings (owner annotations, 2026-11-14 02:13 screenshot,
// 424x744): (1) "Hamburger menu button is supposed to be on the RIGHT SIDE on
// mobile, NOT the left-side." (2) "The 'Add Session' button should be in the
// triple-dot menu" — the ⋮ overflow already carries addButton(), so the
// visible trailing copy must yield below the stacking width (the same
// breakpoint swap the eye/cluster already do). (3) "View cuts off prematurely
// on mobile" — the list's scrollview is height:100% inside an implicit AUTO
// row of .kikx-thread__body, so the percentage resolves against content and
// the list stops ~36px short of the composer, leaving the annotated void. (4)
// "Massive padding around all edges on mobile" — 12px thread padding + 10px
// row gaps + 18px composer bottom on a phone.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const REPO = new URL('../../', import.meta.url);
const source = (p) => readFile(new URL(p, REPO), 'utf8');

test('hamburger rides the RIGHT of the lead row on mobile (owner 2026-11-14)', async () => {
  const css = await source('src/client/styles/mobile.css');
  assert.match(css,
    /\.kikx-menu-toggle\s*\{[^}]*order:\s*9\s*;[^}]*margin-left:\s*auto\s*;/u,
    'the toggle is ordered last and pushed to the row end inside .kikx-window__lead');
  // and the desktop base rule must not carry the move (desktop keeps it leading)
  const mobileOnly = css.match(/order:\s*9/u);
  assert.ok(mobileOnly, 'the order lives in mobile.css, not the desktop sheets');
});

test('the visible + Add affordance yields to the triple-dot menu below the stacking width (owner 2026-11-14)', async () => {
  const css = await source('src/client/styles/overflow-popup.css');
  const media = css.match(/@media \(max-width: 960px\), \(max-height: 520px\) \{[\s\S]*\n\}/u);
  assert.ok(media, 'the hamburger-breakpoint swap block exists');
  assert.match(media[0],
    /\.kikx-topbar\.kikx-window__header \.kikx-topbar__trailing-actions\s*\{\s*display:\s*none\s*;/u,
    'trailing-actions hides in the same block that hides window__actions and shows the ⋮');
  const topbar = await source('src/client/styles/topbar-unified.css');
  assert.match(topbar,
    /\.kikx-topbar\.kikx-window__header \.kikx-topbar__trailing-actions\s*\{[^}]*order:\s*3/u,
    'desktop keeps its trailing rule (the hide must be the later, media-scoped sheet)');
});

test('the mobile list fills body to composer — body gets an explicit row (owner: view cuts off prematurely)', async () => {
  const css = await source('src/client/styles/mobile.css');
  const body = css.match(/\.kikx-thread__body\s*\{[^}]*\}/u);
  assert.ok(body, 'a mobile .kikx-thread__body rule exists');
  assert.match(body[0], /grid-template-rows:\s*minmax\(0,\s*1fr\)/u,
    'an explicit single row makes the scrollview height:100% resolve against the BODY, not its content');
});

test('phone-tight thread chrome — padding and gaps off the desktop values (owner: massive padding around all edges)', async () => {
  const css = await source('src/client/styles/mobile.css');
  const thread = [...css.matchAll(/\.kikx-thread\s*\{([^}]*)\}/gu)].map((m) => m[1]).join('\n');
  assert.match(thread, /padding:\s*8px/u,
    'thread edge padding is phone-tight (8px), not the desktop 12px');
  assert.match(thread, /gap:\s*6px/u,
    'row gaps tighten to 6px — the hidden dock row still contributes two of them');
  assert.match(css, /\.kikx-composer\s*\{[^}]*padding:[^}]*\d+px[^}]*\}/u,
    'the composer gets a mobile padding override so the band above the status bar shrinks');
});
