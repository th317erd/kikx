'use strict';

// =============================================================================
// Settings chrome (owner screenshot, 2026-11-17 16:31)
// =============================================================================
// Three defects in one screenshot, all about the bar and the General card:
//
//   1. "This should be ONE button... NOT two." The exit affordance rendered
//      twice: the session-close chevron, because the settings mode is a PUSHED
//      stack entry so `nested` was true, plus the crumb's '< Exit Settings'.
//   2. "Remove 'Search' field and 'Add Project' button when in 'Settings' view."
//      Both stayed, over a form where neither can do what its label says.
//   3. "This is horribly ugly... everything is just smashed together."
//      General's heading and two identity rows were bare siblings in a block
//      box with `margin: 0` on every child, so nothing separated them.
//
// NEGATIVE CONTROLS ARE THE POINT OF SEVERAL OF THESE. A test that only asserts
// "the chevron is absent in Settings" also passes if the chevron is absent
// EVERYWHERE — which would silently remove the only way to close a session. So
// each absence assertion is paired with the presence assertion one level over.

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { installDom } from './support/mini-dom.mjs';

register(new URL('./support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);

const { document } = installDom();

const { buildUnifiedTopbar } = await import('../../src/client/components/kikx-topbar.mjs');
const { pushSystemSettings } = await import('../../src/client/state/navigation-stack.mjs');
const { resolveViewSurface } = await import('../../src/client/components/client-view-surfaces.mjs');

const ROOT_STACK = [ { sessionID: null, collapsed: true } ];
const SESSION_STACK = [
  { sessionID: null, collapsed: true },
  { sessionID: 's1', collapsed: false },
];

function makeApp(state = {}) {
  return {
    _state: {
      authToken: 'token',
      account: { name: 'Wyatt', email: 'wegreenway@taraani.org' },
      themeID: 'orange',
      navigationStack: ROOT_STACK,
      sessionIDs: [ 's1' ],
      sessionDetailsByID: { s1: { id: 's1', title: 'A session' } },
      sessionSearch: '',
      frameFilters: {},
      clientComponentsByKind: {},
      clientSettingsPanels: {},
      ...state,
    },
    _onSessionSearchInput() {},
    _clearFrameFilters() {},
    _minimizeCurrent() { this.__minimized = (this.__minimized || 0) + 1; },
    _navigateToDepth() {},
    _beginSessionNameEdit() {},
    _createSession() { this.__created = true; },
    _syncURLFromStack() {},
    _requestRender() {},
  };
}

function settingsApp() {
  return makeApp({ navigationStack: pushSystemSettings(SESSION_STACK) });
}

function count(node, predicate) {
  let total = 0;
  (function walk(current) {
    if (!current) return;
    if (predicate(current)) total += 1;
    for (const child of current.childNodes || []) walk(child);
  })(node);
  return total;
}

function textOf(node) {
  let text = '';
  (function walk(current) {
    if (!current) return;
    if (current.nodeType === 3) text += `${current.textContent || ''} `;
    for (const child of current.childNodes || []) walk(child);
  })(node);
  return text;
}

function classesOf(node) {
  return String(node.className || '').split(/\s+/).filter(Boolean);
}

function hasClass(name) {
  return (node) => classesOf(node).includes(name);
}

// ---------------------------------------------------------------------------
// 1. ONE exit control
// ---------------------------------------------------------------------------

test('Settings shows exactly ONE exit control — the crumb, not the chevron (owner 2026-11-17)', () => {
  const app = settingsApp();
  const bar = buildUnifiedTopbar(app).build(document);

  assert.equal(
    count(bar, hasClass('kikx-window__close')),
    0,
    'the session-close chevron must not render in Settings — it duplicated the crumb exit',
  );
  assert.equal(
    count(bar, hasClass('kikx-breadcrumb__exit-settings')),
    1,
    'the surviving control is the single "< Exit Settings" button',
  );
});

test('NEGATIVE CONTROL: the session-close chevron still renders for a nested SESSION', () => {
  // Same stack depth (2) as the Settings case, without the view entry. If the
  // fix had been "drop the chevron whenever depth > 1" this would fail, and
  // session navigation would have lost its close button.
  const app = makeApp({ navigationStack: SESSION_STACK });
  const bar = buildUnifiedTopbar(app).build(document);

  assert.equal(
    count(bar, hasClass('kikx-window__close')),
    1,
    'a nested session keeps its close chevron — the suppression is Settings-only',
  );
  assert.equal(
    count(bar, hasClass('kikx-breadcrumb__exit-settings')),
    0,
    'and no exit-settings control leaks outside the mode',
  );
});

test('the surviving exit control keeps the app action the chevron had', async () => {
  // No capability was lost, so this is not merely a visual merge: the crumb
  // routes to the SAME app method. Asserted on source because the handler is
  // bound with `.onClick` and this DOM is a stub.
  const topbar = await readFile(fileURLToPath(new URL('../../src/client/components/kikx-topbar.mjs', import.meta.url)), 'utf8');
  const exitBlock = /if \(crumb\.exitSettings\) \{([\s\S]*?)\n  \}/.exec(topbar);
  assert.ok(exitBlock, 'the exit-settings branch must exist');
  assert.match(exitBlock[1], /app\._minimizeCurrent\?\.\(\)/,
    'the crumb exit calls app._minimizeCurrent — the exact handler the chevron called');
});

// ---------------------------------------------------------------------------
// 2. No Search field, no "+ Add Project" in Settings
// ---------------------------------------------------------------------------

test('Settings drops the search group and the trailing Add action (owner 2026-11-17)', () => {
  const app = settingsApp();
  const bar = buildUnifiedTopbar(app).build(document);

  assert.equal(count(bar, hasClass('kikx-topbar__search-group')), 0,
    'no search group in Settings (the field AND the frame-filter eye it hosts)');
  assert.equal(count(bar, (node) => node.localName === 'input'
    && node.getAttribute?.('name') === 'session-search'), 0,
    'no session-search input node at all, not merely hidden');
  assert.equal(count(bar, hasClass('kikx-topbar__trailing-actions')), 0,
    'no trailing Add container');
  assert.doesNotMatch(textOf(bar), /Add (Project|Session)/,
    'and no Add label reaches the DOM');
});

test('NEGATIVE CONTROL: the same bar still carries search + Add outside Settings', () => {
  const app = makeApp({ navigationStack: SESSION_STACK });
  const bar = buildUnifiedTopbar(app).build(document);

  assert.equal(count(bar, hasClass('kikx-topbar__search-group')), 1,
    'a session view keeps its search group');
  assert.equal(count(bar, hasClass('kikx-topbar__trailing-actions')), 1,
    'and its trailing Add control');
  assert.match(textOf(bar), /Add /, 'whose label is still rendered');
});

// ---------------------------------------------------------------------------
// 3. General is a card stack with an aligned fact grid
// ---------------------------------------------------------------------------

test('General renders as a card stack with a label/value fact grid (owner 2026-11-17)', () => {
  const app = makeApp();
  const view = resolveViewSurface('settings', app._state, app);

  const stack = [];
  (function walk(node) {
    if (!node) return;
    if (hasClass('kikx-settings-general')(node)) stack.push(node);
    for (const child of node.childNodes || []) walk(child);
  })(view);

  assert.equal(stack.length, 1, 'exactly one General stack');
  const root = stack[0];

  assert.equal(count(root, hasClass('kikx-settings-general__card')), 2,
    'two cards: Account and Theme');

  const lists = [];
  (function walk(node) {
    if (!node) return;
    if (node.localName === 'dl' && hasClass('kikx-settings-general__facts')(node)) lists.push(node);
    for (const child of node.childNodes || []) walk(child);
  })(root);
  assert.equal(lists.length, 1, 'the identity rows are a description list, not two sentences');

  const children = (lists[0].childNodes || []).filter((node) => node.nodeType === 1);
  assert.deepEqual(children.map((node) => node.localName), [ 'dt', 'dd', 'dt', 'dd' ],
    'Name/email are label-value PAIRS, so the two values align in one column');
  assert.equal(count(root, (node) => node.localName === 'dt'), 2, 'two term cells');
  assert.equal(count(root, (node) => node.localName === 'dd'), 2, 'two definition cells');

  const text = textOf(root);
  for (const expected of [ 'Account', 'Name', 'Wyatt', 'Email', 'wegreenway@taraani.org', 'Theme' ])
    assert.ok(text.includes(expected), `the card content is intact: ${expected}`);
});

test('the old bare-paragraph Account block is gone, not merely restyled', () => {
  // The defect was structural: three <p> siblings with no container. Asserting
  // the card exists would also pass with the paragraphs still alongside it.
  const app = makeApp();
  const view = resolveViewSurface('settings', app._state, app);
  assert.doesNotMatch(textOf(view), /Name: Wyatt/,
    'the "Name: X" run-on string must not survive — it was the smashed layout');
});

test('every class the General restyle emits has a rule in a stylesheet', async () => {
  // Mirrors the gate at the foot of system-settings-view-spec, scoped to the new
  // classes only, so a rename cannot ship an unstyled class.
  const source = await readFile(fileURLToPath(
    new URL('../../src/client/components/kikx-system-settings-view.mjs', import.meta.url)), 'utf8');
  const used = [ ...source.matchAll(/\.class\(\s*'([^']+)'/g) ]
    .flatMap((match) => match[1].split(/\s+/).filter(Boolean))
    .filter((name) => name.startsWith('kikx-settings-general'));

  assert.ok(used.length > 0, 'the restyle must declare its classes through the DSL');

  const css = await readFile(fileURLToPath(
    new URL('../../src/client/styles/app-views.css', import.meta.url)), 'utf8');
  for (const name of new Set(used))
    assert.ok(css.includes(`.${name}`), `class .${name} has no rule in app-views.css`);
});

test('the General card rules give the block real vertical rhythm', async () => {
  // The measured cause of "smashed together": a block box whose children all
  // carried margin:0, so the gap was literally 0. Assert a non-zero gap exists
  // rather than trusting the comment that claims it does.
  const css = await readFile(fileURLToPath(
    new URL('../../src/client/styles/app-views.css', import.meta.url)), 'utf8');
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');

  const stackRule = /\.kikx-settings-general\s*\{([^}]*)\}/.exec(stripped);
  assert.ok(stackRule, '.kikx-settings-general must have a rule');
  assert.match(stackRule[1], /display\s*:\s*flex/, 'the stack is a flex column');
  assert.match(stackRule[1], /gap\s*:\s*\d+px/, 'with an explicit non-zero gap between cards');

  const cardRule = /\.kikx-settings-general__card\s*\{([^}]*)\}/.exec(stripped);
  assert.ok(cardRule, '.kikx-settings-general__card must have a rule');
  assert.match(cardRule[1], /gap\s*:\s*\d+px/, 'the card spaces its own children');
  assert.match(cardRule[1], /padding\s*:\s*\d+px/, 'and has padding, so text is not on the border');

  const factsRule = /\.kikx-settings-general__facts\s*\{([^}]*)\}/.exec(stripped);
  assert.ok(factsRule, 'the fact grid must have a rule');
  assert.match(factsRule[1], /grid-template-columns\s*:/,
    'the label/value alignment is a grid declaration, not text padding');
});
