'use strict';

// Owner item 4 (2026-10-27): "the thinking indicator is buried under the
// composer" -- the brain/badge renders BEHIND the composer, so a user cannot see
// that an agent is thinking.
//
// THE MEASURED DEFECT (E2E, real authed app on :3001, 1280x900 and 1280x620):
//
//   .kikx-thread gridTemplateRows = "697.625px 0px 104px 0px"
//   .kikx-thinking-dock  y=767 h=54   position:static
//   .kikx-composer       y=767 h=104  position:relative
//   dockBottomOverlapsComposerTopBy = 54
//   realClippingAncestors = []        clipped:false
//   elementFromPoint(dock centre) -> button.kikx-composer-history-button
//
// So it was NOT clipping and NOT a z-index fight: the dock sat in a 0px row and
// overflowed onto the composer, which being `position:relative` painted over it.
//
// The cause is a track/child COUNT mismatch. `buildThreadSection` emits THREE
// children (body, dock, composer) but `app.css` gives `.kikx-thread` FOUR rows
// (`auto minmax(0,1fr) auto auto`). The body's tall max-content claimed the
// `auto` row, the `minmax(0,1fr)` row resolved to 0px, and the dock -- being
// child 2 -- landed in that zero-height row.
//
// The invariant that must not regress, and the reason a count check alone is
// not enough: the fix is NOT "delete a track". `auto minmax(0,1fr) auto` also
// has 3 tracks and still hands the dock the 0px row. What matters is that the
// BODY -- child 1 -- owns the flexible row, i.e. the tracks must be the
// `minmax(0,1fr) auto auto` assignment, not merely 3 in number.
//
// NO CSS CASCADE EXISTS under Node, so this models the cascade for the REAL
// selector over the REAL sheet text, in the REAL <link> order from
// src/client/index.html. Every assertion carries a control: a model that
// matched everything would still pass against the pre-fix sheets.

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { installDom } from './support/mini-dom.mjs';

register(new URL('./support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);

const { document } = installDom();

const shellBuilders = await import('../../src/client/components/kikx-shell-builders.mjs');

// --- helpers ---------------------------------------------------------------

const CLIENT_ROOT = fileURLToPath(new URL('../../src/client/', import.meta.url));

// The app surface `buildThreadSection` reads. Kept minimal on purpose: an
// over-stuffed fixture hides which field the builder actually depends on.
function makeApp(state = {}) {
  return {
    _state: {
      selectedSessionID: '',
      frameFilters: {},
      sessionSearch: '',
      editingSessionNameID: '',
      editingSessionNameValue: '',
      navigationStack: [],
      ...state,
    },
    _onSubmit() {},
    _createSession() {},
    _beginSessionNameEdit() {},
    _commitSessionName() {},
    _cancelSessionNameEdit() {},
    _onSessionNameKeydown() {},
    _navigateToDepth() {},
    _onSessionSearchInput() {},
    _toggleFrameFilter() {},
    _render() {},
  };
}

// Counts specificity as (id, class/attr/pseudo-class, element). Anything this
// does not understand throws rather than scoring zero, because a selector that
// silently scores (0,0,0) makes every comparison against it vacuous.
function specificity(selector) {
  let ids = (selector.match(/#[\w-]+/g) || []).length;
  let classes = (selector.match(/\.[\w-]+/g) || []).length;
  let attributes = (selector.match(/\[[^\]]+\]/g) || []).length;
  let pseudoClasses = (selector.match(/:(?!:)[\w-]+/g) || []).length;
  let stripped = selector
    .replace(/#[\w-]+/g, ' ')
    .replace(/\.[\w-]+/g, ' ')
    .replace(/\[[^\]]+\]/g, ' ')
    .replace(/:(?!:)[\w-]+/g, ' ');
  let elements = stripped.split(/[\s>+~]+/).filter((part) => /^[a-zA-Z]/.test(part)).length;
  return [ ids, classes + attributes + pseudoClasses, elements ];
}

// Does this selector-list contain `.kikx-thread` as an EXACT member? A substring
// test would wrongly credit `.kikx-thread__body` (a different element) and
// `.kikx-thread--foo` (a modifier), which would let the model invent a winner.
function targetsThread(selectorList) {
  return selectorList.split(',')
    .map((part) => part.trim())
    .some((part) => part === '.kikx-thread');
}

function outranks(candidate, baseline) {
  for (let index = 0; index < 3; index += 1) {
    if (candidate[index] !== baseline[index])
      return candidate[index] > baseline[index];
  }
  return false;
}

// Read the <link rel="stylesheet"> order from the REAL index.html, restricted to
// our own sheets (the /vendor/ ones are aeor-web-components and do not style
// .kikx-thread). Load order is what decides the tie in this fix, so reading it
// from the document rather than hard-coding it is the point.
async function linkedSheetOrder() {
  let html = await readFile(new URL('index.html', `file://${CLIENT_ROOT}`), 'utf8');
  let hrefs = [ ...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g) ]
    .map((match) => match[1]);
  assert.ok(hrefs.length > 0, 'index.html must link at least one stylesheet');
  return hrefs
    .map((href) => {
      let clean = href.split('?')[0].replace(/^\/client\/styles\//, '');
      return href.includes('/client/styles/') ? `styles/${clean}` : null;
    })
    .filter(Boolean);
}

// Collect every `grid-template-rows` declaration that applies to `.kikx-thread`,
// in sheet-load order, with its specificity. Comments are stripped first: this
// file's own fix is documented in a prose comment that quotes BOTH the broken
// and the fixed value, so a naive scan would read the explanation as a rule.
async function threadRowDeclarations(sheets) {
  let declarations = [];
  for (let [ sheetIndex, sheet ] of sheets.entries()) {
    let source = await readFile(new URL(sheet, `file://${CLIENT_ROOT}`), 'utf8');
    let css = source.replace(/\/\*[\s\S]*?\*\//g, '');
    let pattern = /([^{}]+)\{([^{}]*)\}/g;
    let match;
    // `ruleIndex` captures source order WITHIN the sheet, which is the tiebreak
    // when two rules have equal specificity.
    let ruleIndex = 0;
    while ((match = pattern.exec(css)) !== null) {
      let selectors = match[1].trim();
      ruleIndex += 1;
      if (selectors.startsWith('@') || !targetsThread(selectors))
        continue;
      let value = /(^|[;\s])grid-template-rows\s*:\s*([^;]+)/.exec(match[2]);
      if (!value)
        continue;
      declarations.push({
        sheet,
        sheetIndex,
        ruleIndex,
        selector: '.kikx-thread',
        specificity: specificity('.kikx-thread'),
        value: value[2].trim(),
      });
    }
  }
  return declarations;
}

// The winner: highest specificity, then LAST source order.
function winningDeclaration(declarations) {
  assert.ok(declarations.length > 0,
    'no sheet declares grid-template-rows for .kikx-thread -- the thread grid is undefined');
  return declarations.reduce((winner, candidate) => {
    if (outranks(candidate.specificity, winner.specificity))
      return candidate;
    // Equal specificity: later in the cascade wins. `>=` on the combined
    // (sheetIndex, ruleIndex) tuple is exactly that.
    let candidateOrder = [ candidate.sheetIndex, candidate.ruleIndex ];
    let winnerOrder = [ winner.sheetIndex, winner.ruleIndex ];
    let later = candidateOrder[0] > winnerOrder[0]
      || (candidateOrder[0] === winnerOrder[0] && candidateOrder[1] >= winnerOrder[1]);
    return later ? candidate : winner;
  });
}

// Split a track list, respecting `minmax(a, b)` and `repeat()`-free syntax.
function tracks(value) {
  let depth = 0;
  let current = '';
  let list = [];
  for (let character of value) {
    if (character === '(')
      depth += 1;
    if (character === ')')
      depth -= 1;
    if (/\s/.test(character) && depth === 0) {
      if (current.trim())
        list.push(current.trim());
      current = '';
      continue;
    }
    current += character;
  }
  if (current.trim())
    list.push(current.trim());
  return list;
}

function isFlexible(track) {
  let inner = /^minmax\(([^,]+),\s*([^)]+)\)$/.exec(track);
  let basis = inner ? inner[2].trim() : track;
  return /\d*\.?\d*fr$/.test(basis);
}

function isZeroFlexible(track) {
  let inner = /^minmax\(([^,]+),/.exec(track);
  let minimum = inner ? inner[1].trim() : track;
  // `minmax(0, ...)` pins the row to zero whenever the free space is contended,
  // which is precisely how the dock ended up in a 0px row.
  return minimum === '0' || minimum === '0px' || minimum === '0%';
}

// --- the thread emits three children --------------------------------------

test('buildThreadSection emits exactly body, dock, composer', () => {
  let node = shellBuilders.buildThreadSection(makeApp(), '');
  let section = node.build ? node.build(document) : node;

  assert.equal(section.localName, 'section');
  assert.ok(section.className.includes('kikx-thread'),
    `the thread container must carry .kikx-thread; got "${section.className}"`);

  let children = section.childNodes.map((child) => child.className || child.localName);
  assert.equal(children.length, 3,
    `the thread grid has exactly 3 children; got ${JSON.stringify(children)}`);

  // Order is load-bearing: the track assignment is positional. If the dock ever
  // moves, the grid must change WITH it, so pin the order as well as the count.
  assert.match(children[0], /kikx-thread__body/, 'child 1 must be the scrollable body');
  assert.match(children[1], /kikx-thinking-dock/, 'child 2 must be the thinking dock');
  assert.match(children[2], /kikx-composer/, 'child 3 must be the composer');
});

// --- the grid assigns the flexible row to the BODY ------------------------

test('the winning grid-template-rows gives the body the flexible row', async () => {
  let sheets = await linkedSheetOrder();
  let declarations = await threadRowDeclarations(sheets);
  let winner = winningDeclaration(declarations);

  let rowList = tracks(winner.value);
  assert.equal(rowList.length, 3,
    `the winning rule must declare one track per child (3), got ${rowList.length} from `
    + `"${winner.value}" in ${winner.sheet}. A 4th track resolves the body's row to `
    + `max-content and gives the dock a 0px row -- the reported defect.`);

  // The whole point of the fix: child 1 is the body, and the body is what must
  // absorb the free space.
  // NOTE on `minmax(0, 1fr)` for the BODY: the `0` minimum is correct and
  // necessary here -- it lets the scroll container shrink below its content
  // height instead of forcing the grid to overflow. The defect was never the
  // body having a 0 minimum; it was the DOCK being handed this row, where a
  // 0 minimum does mean "collapse onto the composer". So assert that the body
  // owns a flexible row, and save the not-pinned-to-0 rule for the dock.
  assert.ok(isFlexible(rowList[0]),
    `track 1 (the body) must be flexible, got "${rowList[0]}" from "${winner.value}"`);

  // Child 2 is the dock. It must sit in an intrinsically sized row -- NOT a
  // 0-pinned flexible row, which is what buried it under the composer.
  assert.equal(isZeroFlexible(rowList[1]), false,
    `track 2 (the dock) must not be pinned to 0, got "${rowList[1]}"`);
  assert.equal(rowList[1], 'auto',
    `track 2 (the dock) must be auto-sized so its content sets the row height, got "${rowList[1]}"`);

  // Child 3 is the composer, likewise intrinsically sized.
  assert.equal(rowList[2], 'auto',
    `track 3 (the composer) must be auto-sized, got "${rowList[2]}"`);
});

test('CONTROL: without the newer sheet the 4-track rule wins, which is the bug', async () => {
  // Falsifies "the model always finds a good value". Dropping topbar-unified.css
  // must reproduce the measured defect: 4 tracks, body's row auto, dock's row
  // the 0-pinned flexible one. If this control returned 3 healthy tracks, the
  // assertions above would be proving nothing about the override.
  let sheets = (await linkedSheetOrder()).filter((sheet) => !sheet.includes('topbar-unified'));
  assert.ok(sheets.length > 0, 'the control needs at least app.css');

  let winner = winningDeclaration(await threadRowDeclarations(sheets));
  let rowList = tracks(winner.value);

  assert.equal(winner.sheet, 'styles/app.css',
    'the control should fall back to app.css');
  assert.equal(rowList.length, 4,
    `app.css alone must still show the 4-track defect, got "${winner.value}"`);
  assert.equal(isFlexible(rowList[1]), true,
    'in the broken layout the flexible row is track 2, i.e. the DOCK -- the defect');
  assert.equal(isZeroFlexible(rowList[1]), true,
    'and it is minmax(0, ...), which resolves to 0px and collides with the composer');
});

test('CONTROL: a 3-track rule that still starves the dock is rejected', async () => {
  // Guards the trap: "just delete the 4th track" yields `auto minmax(0,1fr) auto`.
  // That has the right COUNT and is still wrong, because the dock keeps the 0px
  // row. The invariant asserted above is the assignment, not the count -- this
  // proves the difference is detectable rather than merely asserted in a comment.
  let naive = tracks('auto minmax(0, 1fr) auto');
  assert.equal(naive.length, 3, 'the naive fix does have 3 tracks');
  assert.equal(isZeroFlexible(naive[1]), true,
    'yet it still pins the dock to a 0px flexible row, so it must be rejected');

  let fixed = tracks('minmax(0, 1fr) auto auto');
  assert.equal(isZeroFlexible(fixed[1]), false,
    'the accepted fix gives the dock an auto row');
  assert.equal(isFlexible(fixed[0]), true,
    'and gives the body the flexible row');
});

// --- the fix must not disturb the sessions grid or app.css size -----------

test('the override is scoped to .kikx-thread and leaves .kikx-workspace alone', async () => {
  // `.kikx-thread` and `.kikx-workspace` share a base rule in app.css
  // (`auto 1fr auto`) and `.kikx-workspace` already has a correct track list.
  // A sloppy shared override would silently reflow the session grid too.
  let source = await readFile(new URL('styles/topbar-unified.css', `file://${CLIENT_ROOT}`), 'utf8');
  let css = source.replace(/\/\*[\s\S]*?\*\//g, '');
  let pattern = /([^{}]+)\{([^{}]*)\}/g;
  let match;
  while ((match = pattern.exec(css)) !== null) {
    let selectors = match[1].trim();
    if (!/(^|[;\s])grid-template-rows\s*:/.test(match[2]))
      continue;
    if (!targetsThread(selectors))
      continue;
    assert.equal(selectors, '.kikx-thread',
      `the thread track override must target .kikx-thread alone, got "${selectors}"`);
    assert.ok(!selectors.includes('kikx-workspace'),
      'the thread override must not name .kikx-workspace');
  }
});

test('the thread override lives in a sheet that index.html actually links', async () => {
  // A rule in an unlinked sheet is dead CSS, and would make the assertions above
  // true while the app renders the broken layout.
  let sheets = await linkedSheetOrder();
  assert.ok(sheets.some((sheet) => sheet.includes('topbar-unified')),
    `topbar-unified.css must be linked in index.html; linked: ${JSON.stringify(sheets)}`);

  let declarations = await threadRowDeclarations(sheets);
  let fromOverride = declarations.filter((entry) => entry.sheet.includes('topbar-unified'));
  assert.ok(fromOverride.length > 0,
    'the fix must come from topbar-unified.css, not by editing the 4021-line app.css');
});

test('app.css is not where the fix lives', async () => {
  // The merge constraint for this work: do not grow app.css. A future edit that
  // "fixes" the tracks back into app.css would satisfy the behavioural tests
  // while violating the constraint, so pin the location as well.
  let source = await readFile(new URL('styles/app.css', `file://${CLIENT_ROOT}`), 'utf8');
  let css = source.replace(/\/\*[\s\S]*?\*\//g, '');
  let pattern = /([^{}]+)\{([^{}]*)\}/g;
  let match;
  let appCssDeclarations = [];
  while ((match = pattern.exec(css)) !== null) {
    if (!targetsThread(match[1].trim()))
      continue;
    let value = /(^|[;\s])grid-template-rows\s*:\s*([^;]+)/.exec(match[2]);
    if (value)
      appCssDeclarations.push(value[2].trim());
  }

  assert.ok(appCssDeclarations.length > 0,
    'app.css is expected to still carry its original thread rule -- the fix overrides it '
    + 'rather than rewriting a 4021-line sheet');
  assert.ok(!appCssDeclarations.some((value) => value === 'minmax(0, 1fr) auto auto'),
    'the corrected track list must NOT be written into app.css');
});
