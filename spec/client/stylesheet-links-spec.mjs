'use strict';

// Guards the one failure mode that no other spec can see: index.html linking a
// stylesheet that does not exist, or shipping a component whose classes have no
// CSS rule at all.
//
// This is not hypothetical. `questions.css` was written for P3/P4 and linked
// from a working-tree-only copy of index.html, but neither file was committed.
// `main` therefore served Inbox, Activities, the question cards/frames and the
// sidebar nav with no stylesheet at all -- every one of them rendered as raw
// unstyled block flow. The whole suite stayed green because client specs assert
// on class names and ARIA state, both of which are correct regardless of
// styling, and nothing loaded index.html to check that its links resolve.

import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { readCssBundle } from './support/css-bundle.mjs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CLIENT_ROOT = path.join(REPO_ROOT, 'src', 'client');
const INDEX_HTML = path.join(CLIENT_ROOT, 'index.html');
const COMPONENTS_DIR = path.join(CLIENT_ROOT, 'components');
const STYLES_DIR = path.join(CLIENT_ROOT, 'styles');

// Classes that already had no rule when this guard was added. They are recorded
// here rather than fixed, because restyling them is separate work -- but the
// list is exhaustive and the test fails if it grows. Anything new that ships
// unstyled breaks the build instead of silently rendering as block flow.
const PRE_EXISTING_UNSTYLED = new Set([
  'kikx-agent-list__item',
  'kikx-chat-view--full',
  'kikx-default-config__control',
  'kikx-frame__compact-summary',
  'kikx-team-list',
  'kikx-team-list__edit',
  'kikx-team-manager',
  'kikx-thinking-tip__name',
  'kikx-tool-card__pre',
  'kikx-window__title--editable',
]);

function extractStylesheetHrefs(html) {
  let hrefs = [];
  let re = /<link\b[^>]*\brel=["']stylesheet["'][^>]*\bhref=["']([^"']+)["'][^>]*>/gi;
  let match;
  while ((match = re.exec(html)) !== null) hrefs.push(match[1]);
  return hrefs;
}

// '/client/styles/app.css' -> src/client/styles/app.css
function resolveClientHref(href) {
  assert.ok(href.startsWith('/client/'), `stylesheet "${href}" is not under /client/`);
  let pathname = href.split(/[?#]/, 1)[0];
  return path.join(CLIENT_ROOT, pathname.slice('/client/'.length));
}

function linkedClientStylesheets(html) {
  return extractStylesheetHrefs(html).filter((href) => href.startsWith('/client/'));
}

async function linkedStylesheetBasenames(html) {
  let linked = new Set();
  let pending = linkedClientStylesheets(html).map((href) => resolveClientHref(href));
  while (pending.length > 0) {
    let file = pending.pop();
    let name = path.basename(file);
    if (linked.has(name))
      continue;
    linked.add(name);
    let source = await readFile(file, 'utf8');
    for (let match of source.matchAll(/@import\s+url\(\s*["']?([^"')]+)["']?\s*\)\s*;/g)) {
      let target = match[1].split(/[?#]/, 1)[0];
      if (!target || /^(?:[a-z]+:)?\/\//i.test(target) || target.startsWith('data:'))
        continue;
      pending.push(path.resolve(path.dirname(file), target));
    }
  }
  return linked;
}

async function readLinkedClientCss(html) {
  let css = '';
  for (let href of linkedClientStylesheets(html)) {
    css += await readCssBundle(resolveClientHref(href));
  }
  return css;
}

// Only real class assignments count. Matching every `kikx-*` string literal
// would also pick up CustomEvent names (`kikx-card-add`) and view-transition
// names (`kikx-chat-hero`), which are identifiers, not classes. Interpolated
// fragments (`kikx-activities__card${open ? ... }`) are cut at the `$` and
// treated as runtime-composed class names.
function classesIn(source) {
  let found = new Set();
  let patterns = [
    /\.class\(\s*['"`]([^'"`]+)['"`]/g,          // builder DSL: .class('a b')
    /\bclass\s*=\s*["']([^"']+)["']/g,            // template literal HTML
    /classList\.add\(\s*['"`]([^'"`]+)['"`]/g,    // direct DOM
  ];
  for (let re of patterns) {
    for (let match of source.matchAll(re)) {
      for (let token of match[1].split(/\s+/)) {
        let literal = token.split('$')[0];
        if (literal.startsWith('kikx-')) found.add(literal);
      }
    }
  }
  return found;
}

async function emittedKikxClasses() {
  let names = (await readdir(COMPONENTS_DIR)).filter((name) => name.endsWith('.mjs'));
  let found = new Set();
  for (let name of names) {
    let source = await readFile(path.join(COMPONENTS_DIR, name), 'utf8');
    for (let className of classesIn(source)) found.add(className);
  }
  return found;
}

// Class names composed at runtime by suffixing (`kikx-auth-status--${kind}`)
// cannot have a literal rule, so they are not evidence of a missing style.
function isRuntimePrefix(name) {
  return name.endsWith('-') || name.endsWith('--');
}

function hasRule(css, className) {
  // The class must appear as a whole selector token: `.kikx-inbox` must not be
  // satisfied by `.kikx-inbox__card`.
  return new RegExp(`\\.${className}(?![a-zA-Z0-9_-])`).test(css);
}

test('every stylesheet linked from index.html exists on disk', async () => {
  let html = await readFile(INDEX_HTML, 'utf8');
  let hrefs = linkedClientStylesheets(html);

  assert.ok(hrefs.length > 0, 'index.html links no /client/ stylesheet at all');
  for (let href of hrefs) {
    let absolute = resolveClientHref(href);
    await assert.doesNotReject(
      () => readFile(absolute, 'utf8'),
      `index.html links "${href}" but ${path.relative(REPO_ROOT, absolute)} does not exist`,
    );
  }
});

test('the stylesheet carrying the Inbox/Activities/question CSS is linked', async () => {
  let html = await readFile(INDEX_HTML, 'utf8');

  // Pin the exact regression: these rules live in questions.css. If it stops
  // being linked, the P3/P4 features render as unstyled block flow again.
  assert.ok(
    extractStylesheetHrefs(html).includes('/client/styles/questions.css'),
    'index.html does not link /client/styles/questions.css, so Inbox, Activities '
    + 'and the question card/frame styling would silently disappear',
  );
});

test('every stylesheet in src/client/styles is linked from index.html', async () => {
  let html = await readFile(INDEX_HTML, 'utf8');
  let linked = await linkedStylesheetBasenames(html);
  let onDisk = (await readdir(STYLES_DIR)).filter((name) => name.endsWith('.css')).sort();

  let orphaned = onDisk.filter((name) => !linked.has(name));
  assert.deepEqual(
    orphaned,
    [],
    `these stylesheets exist but nothing loads them: ${orphaned.join(', ')}`,
  );
});

test('no newly added kikx-* class is left without a CSS rule', async () => {
  let css = await readLinkedClientCss(await readFile(INDEX_HTML, 'utf8'));
  let emitted = [...await emittedKikxClasses()].sort();

  let unstyled = emitted.filter((name) => {
    if (PRE_EXISTING_UNSTYLED.has(name) || isRuntimePrefix(name)) return false;
    return !hasRule(css, name);
  });

  assert.deepEqual(
    unstyled,
    [],
    'these kikx-* classes are assigned by components but have no CSS rule in the '
    + `stylesheets index.html loads: ${unstyled.join(', ')}`,
  );
});

test('the Inbox question styling survives in a loaded stylesheet', async () => {
  let css = await readLinkedClientCss(await readFile(INDEX_HTML, 'utf8'));

  for (let required of [
    // Was '.kikx-activities__card' / '.kikx-activities__stat-label'. Those classes are
    // gone with the view (owner request, 2026-10-28); the status-bar counts took their
    // place in the same stylesheet, so those are what must now be present.
    '.kikx-statusbar__stat',
    '.kikx-statusbar__stat-sep',
    '.kikx-inbox__card',
    '.kikx-question-frame__answer',
    '.kikx-question-card',
    '.kikx-sidebar__inbox-badge',
  ]) {
    assert.ok(hasRule(css, required.slice(1)), `${required} is missing from the loaded stylesheets`);
  }
});

test('the shell keeps its base styling', async () => {
  let css = await readCssBundle(path.join(STYLES_DIR, 'app.css'));
  for (let required of ['.kikx-shell', '.kikx-topbar']) {
    assert.ok(css.includes(required), `app.css lost the ${required} rule`);
  }
});

test('inline code uses the shared compact line box in markdown summaries', async () => {
  let css = await readCssBundle(path.join(STYLES_DIR, 'app.css'));
  assert.match(css, /\.kikx-markdown code \{[^}]*font-size: 0\.85em/);
  assert.match(css, /\.kikx-frame__compact-description :not\(pre\) > code \{[^}]*font-size: 0\.85em/);
  assert.doesNotMatch(css, /\.kikx-frame__compact-description code \{[^}]*font-size: inherit/);
  assert.match(css, /\.kikx-frame__compact-markdown \{[^}]*line-height: 1\.55/);
});


test('user messages inherit the shared frame shell instead of overriding its fundamentals', async () => {
  let appCSS = await readCssBundle(path.join(STYLES_DIR, 'app.css'));
  let colorCSS = await readFile(path.join(STYLES_DIR, 'frame-colors.css'), 'utf8');

  // UserMessage may choose its role hue and placement, but radius, border,
  // status colour, header hatch and body surface belong to every frame.
  assert.match(colorCSS, /\.kikx-frame--UserMessage \{[^}]*--kikx-frame-type-color: #4d8fb5/);
  assert.doesNotMatch(colorCSS, /--kikx-frame-radius:\s*18px 18px 5px 18px/);
  assert.doesNotMatch(colorCSS, /--kikx-frame-border-color:\s*#5eead4/);
  assert.doesNotMatch(colorCSS, /--kikx-frame-solid-color:\s*#0b2427/);
  assert.doesNotMatch(colorCSS, /\.kikx-frame--UserMessage \.kikx-frame__meta::before \{[^}]*display: none/);
  assert.match(colorCSS, /\.kikx-frame--UserMessage \.kikx-frame__meta,[\s\S]*?background: var\(--kikx-frame-surface\)/);
  assert.match(appCSS, /\.kikx-frame--UserMessage \{[^}]*justify-self: end;/);
  assert.doesNotMatch(appCSS, /\.kikx-frame--UserMessage \{[^}]*background:/);
  assert.doesNotMatch(appCSS, /\.kikx-frame--UserMessage \{[^}]*border-color:/);
});

test('timestamps stay quiet until hover and disappear from minimized rows', async () => {
  let css = await readCssBundle(path.join(STYLES_DIR, 'app.css'));
  assert.match(css, /\.kikx-frame__timestamp \{[^}]*opacity: 0\.4/);
  assert.match(css, /\.kikx-frame:hover \.kikx-frame__timestamp[^{]*\{[^}]*opacity: 1/);
  assert.match(css, /\.kikx-frame--minimized \.kikx-frame__timestamp \{[^}]*display: none/);
});


test('minimized command labels claim enough width for ordinary tool names', async () => {
  let css = await readFile(path.join(STYLES_DIR, 'frame-colors.css'), 'utf8');
  assert.match(css, /\.kikx-frame--minimized \.kikx-frame__meta-status \{[^}]*max-width: none/);
  assert.match(css, /\.kikx-frame--minimized \.kikx-frame__meta-status-label \{[^}]*max-width: 18ch/);
});


test('the floating scroll-lock control is one and a half times the normal button size', async () => {
  let css = await readCssBundle(path.join(STYLES_DIR, 'app.css'));
  assert.match(css, /\.kikx-scroll-lock-floating \{[^}]*width: 45px;[^}]*height: 45px;/);
  assert.match(css, /\.kikx-scroll-lock-floating svg \{[^}]*width: 1\.575em;[^}]*height: 1\.575em;/);
});


// Owner annotation (session-2026-11-14-02-02-31.771.png), verbatim:
//   "Quick-action buttons can end up BEHIND another card, or push down too far
//    vertically. Can we have them wrap inside their container please?"
//
// This test has now been re-ruled TWICE, which is the point worth recording.
//
// v1 asserted `.kikx-frame-stream { padding: 0 72px 1px 0 }` — a vertical rail
// painted in a lateral gutter OUTSIDE the frame. That gutter is still gone.
// v2 re-ruled it to "inside the CARD" on the strength of the 2026-11-14 request,
// then the owner rejected that reading of "container" (2026-11-17). The rail is
// OUTSIDE the message again, but not in a lateral gutter: it hangs below the
// card as a wrapping row, and the card is lifted on hover so a following card
// cannot cover it. Geometry is proven on rendered metrics by
// spec/ui/puppeteer/frame-quick-actions-outside-message-puppeteer.mjs; the
// assertions here only pin that the rules exist and are not silently reverted.
test('frame quick actions wrap OUTSIDE the message and appear on hover', async () => {
  let css = await readCssBundle(path.join(STYLES_DIR, 'app.css'));
  // The lateral 72px gutter is gone. (The rail IS painted outside the card
  // again, below it — see the assertions at the end of this test.)
  assert.doesNotMatch(css, /\.kikx-frame-stream \{[^}]*padding: 0 72px 1px 0/);
  // The rail is a wrapping row anchored to the card, not a gutter column.
  assert.match(css, /\.kikx-frame__quick-actions \{[^}]*flex-direction: row/);
  assert.match(css, /\.kikx-frame__quick-actions \{[^}]*flex-wrap: wrap/);
  assert.doesNotMatch(css, /\.kikx-frame__quick-actions \{[^}]*right: -44px/);
  // OUTSIDE the message (owner, 2026-11-17): the row starts at the card's bottom
  // edge rather than being inset into it. `bottom: 8px` was the in-card
  // arrangement the owner rejected.
  assert.match(css, /\.kikx-frame__quick-actions \{[^}]*top: calc\(100% \+ var\(--kikx-frame-border-width\)\)/);
  assert.doesNotMatch(css, /\.kikx-frame__quick-actions \{[^}]*bottom: 8px/);
  // .kikx-frame sets `transform`, so the card itself must be lifted for its
  // outboard rail to clear following cards; a child's z-index cannot do it.
  assert.match(css, /\.kikx-frame:hover[^{]*\{[^}]*z-index: 2/);
  // The seam has to be tall enough to hold a 30px row, or the row covers the
  // next message ("end up BEHIND another card", inverted).
  assert.match(css, /\.kikx-frame:not\(\.kikx-frame--minimized\) \{[^}]*margin-bottom: calc\(1em \+ 24px\)/);
  // Hover still reveals them, minimized frames still hide them, icons stay 17px.
  assert.match(css, /\.kikx-frame:hover \.kikx-frame__quick-actions[^{]*\{[^}]*opacity: 1/);
  assert.match(css, /\.kikx-frame--minimized \.kikx-frame__quick-actions \{[^}]*display: none/);
  // The last card needs room beneath it or the outboard row is clipped by the
  // scroll container and the final message's actions become unreachable.
  assert.match(css, /\.kikx-frame-stream \{[^}]*padding: 0 0 38px 0/);
  assert.match(css, /\.kikx-frame__quick-action svg \{[^}]*width: 17px/);
});


test('frames transition dimensional and color properties, including auto height entry', async () => {
  let css = await readCssBundle(path.join(STYLES_DIR, 'app.css'));
  assert.match(css, /interpolate-size: allow-keywords/);
  assert.match(css, /\.kikx-frame \{[^}]*height 220ms ease/);
  assert.match(css, /\.kikx-frame \{[^}]*width 180ms ease/);
  assert.match(css, /\.kikx-frame \{[^}]*border-color 180ms ease/);
  assert.match(css, /\.kikx-frame--entering \{[^}]*height: 0/);
});


test('frame lists reserve their scrollbar and mini previews never scroll', async () => {
  let css = await readCssBundle(path.join(STYLES_DIR, 'app.css'));
  assert.match(css, /\.kikx-frame-list \{[^}]*scrollbar-gutter: stable/);
  assert.match(css, /\.kikx-frame-list:hover \{[^}]*scrollbar-color: #52606c transparent/);
  assert.match(css, /\.kikx-chat-view--mini \.kikx-frame-list \{[^}]*overflow: hidden/);
  assert.match(css, /\.kikx-chat-view--mini \.kikx-frame-list \{[^}]*justify-content: flex-end/);
  assert.match(css, /\.kikx-chat-view--mini \.kikx-user-message__prompt \{[^}]*display: none/);
});


test('debug mode reveals frame class names and the status-bar toggle', async () => {
  let css = await readCssBundle(path.join(STYLES_DIR, 'app.css'));
  assert.match(css, /\.kikx-debug-mode \.kikx-frame__debug-class \{[^}]*display: inline/);
  assert.match(css, /\.kikx-debug-toggle\.is-on \{[^}]*opacity: 1/);
});
