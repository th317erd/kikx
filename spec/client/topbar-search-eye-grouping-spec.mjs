'use strict';

// Owner item 3 (2026-10-27): "I would like the 'eye' filter to be hugged up next
// to the 'Search' field, to the right, just next to it (group 'search' items
// together on the UI)."
//
// THE MEASURED DEFECT: search was `div.kikx-session-search` mounted in the bar's
// centre `div.kikx-topbar__rest`, while the eyeball (`<kikx-frame-filter-popup>`)
// was created inside `buildTopbarActions` and therefore lived in the TRAILING
// `div.kikx-window__actions` -- far right, past the participants popup and
// `+ Add`. Two controls that both narrow what you see, at opposite ends of the bar.
//
// WHAT MUST NOT REGRESS, and is the reason this file exists rather than a pixel
// assertion alone:
//
//   The eye must still render at ROOT with `sessionID === null`. The Projects grid
//   is where soft-deleted sessions are listed, so gating the eye on a session
//   would strand "show deleted" on the one screen that needs it. A refactor that
//   moves the popup and "tidies" it behind the session guard passes a naive
//   adjacency test and breaks the owner's deleted-session workflow.
//
// Adjacency ITSELF is the browser probe's line -- there is no layout here. What
// this asserts is the structural precondition that makes the pixel claim true:
// the eye is a SIBLING of the field inside ONE group, with nothing between them.

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { installDom } from './support/mini-dom.mjs';

register(new URL('./support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);

const { document } = installDom();

const { buildTopbarSearch, buildTopbarActions, buildUnifiedTopbar } =
  await import('../../src/client/components/kikx-topbar.mjs');

// --- helpers ---------------------------------------------------------------

function makeApp(state = {}) {
  return {
    _state: {
      authToken: 'token',
      navigationStack: [ { sessionID: 's1', collapsed: false } ],
      sessionIDs: [ 's1' ],
      sessionDetailsByID: { s1: { id: 's1', title: 'A session' } },
      sessionSearch: '',
      frameFilters: {},
      account: { name: 'w' },
      ...state,
    },
    _onSessionSearchInput() {},
    _clearFrameFilters() {},
    _minimizeCurrent() {},
    _navigateToDepth() {},
    _beginSessionNameEdit() {},
  };
}

function classesOf(node) {
  return String(node.className || '').split(/\s+/).filter(Boolean);
}

function childNames(node) {
  return node.childNodes
    .filter((child) => child.nodeType === 1)
    .map((child) => child.localName);
}

// --- the grouping ----------------------------------------------------------

test('search and the eye share ONE group, with the field first', () => {
  let app = makeApp();
  let group = buildTopbarSearch(app, 's1').build(document);

  assert.ok(classesOf(group).includes('kikx-topbar__search-group'),
    `the search controls must live in one group; got "${group.className}"`);

  // Field container, eye, participants, then the mobile ⋮ overflow (owner
  // changes 2026-11-05 and 2026-11-14) — still nothing BETWEEN the field and the
  // eye; participants sits on the eye's OTHER side, which is what the owner
  // asked for ("right next to the eyeball"). The overflow shares the eye's slot
  // at the opposite breakpoint (overflow-popup.css), and now so does the
  // participants copy.
  assert.deepEqual(childNames(group),
    [ 'div', 'kikx-frame-filter-popup', 'kikx-participants-popup', 'kikx-overflow-popup' ],
    'field, then the eyeball, then participants, then the mobile overflow');
  assert.ok(classesOf(group.childNodes[0]).includes('kikx-session-search'),
    'the first child must be the search field container');
});

test('the eye is a SIBLING of the field, not nested inside it', () => {
  // If the eye were moved INSIDE `.kikx-session-search`, the field's own
  // `clear` button would sit between the two controls the owner wants adjacent,
  // and the group would look right in the DOM order test while rendering wrong.
  let app = makeApp();
  let group = buildTopbarSearch(app, 's1').build(document);
  let field = group.querySelector('.kikx-session-search');

  assert.equal(field.querySelector('kikx-frame-filter-popup'), null,
    'the eyeball must not be nested inside the search field container');
  assert.ok(group.querySelector('kikx-frame-filter-popup'),
    'the eyeball must still be reachable inside the group');
});

test('the field container still holds exactly the input and the clear button', () => {
  let app = makeApp();
  let group = buildTopbarSearch(app, 's1').build(document);
  let field = group.querySelector('.kikx-session-search');

  assert.ok(field.querySelector('.kikx-session-search__input'), 'the search input must still render');
  assert.ok(field.querySelector('.kikx-session-search__clear'), 'the clear-filters button must still render');
});

// --- the root case: the reason the popup is not session-gated ---------------

test('the eye renders at ROOT with no session selected', () => {
  // THE regression this guards. The Projects grid lists soft-deleted sessions,
  // so an eye gated on sessionID would remove "show deleted" from the one screen
  // that needs it. `buildTopbarSearch(app, null)` is the root call.
  let app = makeApp();
  let group = buildTopbarSearch(app, null).build(document);

  let eye = group.querySelector('kikx-frame-filter-popup');
  assert.ok(eye, 'the eyeball must render at the project root, where there is no sessionID');

  // And it must be functional, not just present: configure() must have been
  // given the app and state so the popup can read and write frame filters.
  assert.equal(eye._app, app, 'the root eyeball must be configured with the app');
  assert.equal(eye._appState, app._state, 'the root eyeball must be configured with app state');
});

test('the eye is configured for the session when there IS one', () => {
  let app = makeApp();
  let group = buildTopbarSearch(app, 's1').build(document);
  let eye = group.querySelector('kikx-frame-filter-popup');

  assert.ok(eye, 'the eyeball must render inside a session too');
  assert.equal(eye._sessionID, 's1', 'inside a session the eyeball is scoped to it');
});

test('the eye still renders at root through the WHOLE bar, not just the builder', () => {
  // The end-to-end root case: an unauthenticated-shaped stack with no session
  // entry. This is the path buildUnifiedTopbar takes, so it covers a future
  // change that special-cases the bar rather than the builder.
  let app = makeApp({ navigationStack: [ { sessionID: null, collapsed: true } ], sessionIDs: [], sessionDetailsByID: {} });
  let bar = buildUnifiedTopbar(app).build(document);

  let group = bar.querySelector('.kikx-topbar__search-group');
  assert.ok(group, 'the whole bar must render the search group');
  assert.ok(group.querySelector('kikx-frame-filter-popup'),
    'the eyeball must exist at the project root through the real bar');
});

// --- the eye must be gone from the trailing actions -------------------------

test('the eye is no longer in the trailing actions cluster', () => {
  // The defect was a DUPLICATE-or-misplaced eye. Moving it without removing the
  // old one would leave two eyeballs and two different filter sources.
  let app = makeApp();
  let actions = buildTopbarActions(app, 's1').build(document);

  assert.equal(actions.querySelector('kikx-frame-filter-popup'), null,
    'the trailing actions must not still contain the eyeball');
});

test('the whole bar contains EXACTLY ONE eyeball trigger', () => {
  // The eye is the only trigger. The mobile ⋮ (owner change, 2026-11-05) hosts
  // the SAME filter rows in EMBEDDED mode, but triggerless — and it builds them
  // on first open, so at rest the bar holds exactly one popup element outside
  // the overflow. Two triggers would mean two open/close contracts fighting
  // over app._frameFilterPopupOpen.
  let app = makeApp();
  let bar = buildUnifiedTopbar(app).build(document);
  let group = bar.querySelector('.kikx-topbar__search-group');
  let directPopups = Array.from(group.childNodes)
    .filter((node) => node.nodeType === 1 && node.localName === 'kikx-frame-filter-popup');
  assert.equal(directPopups.length, 1,
    'exactly one eye trigger, directly in the search group');

  let overflow = group.querySelector('kikx-overflow-popup');
  assert.ok(overflow, 'the mobile overflow shares the slot');
  let panel = overflow.querySelector('.kikx-overflow__panel');
  assert.ok(panel, 'the overflow carries its panel');
  // Content — actions AND the embedded filter rows — builds on first OPEN
  // (kikx-overflow-popup.mjs _open), so nothing duplicates the eye's rows in
  // the DOM while the menu sits closed.
  assert.equal(Array.from(panel.childNodes).filter((node) => node.nodeType === 1).length, 0,
    'the overflow panel starts empty; content builds on open');
});

test('the search group is not inside the trailing actions', () => {
  let app = makeApp();
  let bar = buildUnifiedTopbar(app).build(document);

  let actions = bar.querySelector('.kikx-window__actions');
  assert.ok(actions, 'the trailing actions cluster must still render');
  assert.equal(actions.querySelector('.kikx-topbar__search-group'), null,
    'the search group must not live inside the trailing actions');

  let group = bar.querySelector('.kikx-topbar__search-group');
  let field = group.querySelector('.kikx-session-search');
  // DOM-order guarantee: the field precedes the eye. The owner said "to the
  // right, just next to it"; left-to-right reading order is DOM order here.
  let order = group.childNodes.filter((child) => child.nodeType === 1);
  assert.equal(order.indexOf(field), 0, 'the field comes first');
  assert.equal(order.indexOf(group.querySelector('kikx-frame-filter-popup')), 1, 'the eye comes second');
});

// --- the group is CENTRED on the bar (owner annotation, 2026-11-14) -------

test('the group is pinned to the BAR centre above 1201px, not the leftover band', async () => {
  // Owner annotation (2026-11-14, screenshot session-2026-11-14-01-42-32.122):
  // "Move the Search field and two buttons over to the center of the top bar
  // (as a whole group)."
  //
  // This SUPERSEDES the 2026-11-07 ruling that banned auto margins from the
  // group to keep it a left-hand band. Three mechanisms were ruled in turn and
  // only the third survives measurement:
  //
  //   1. `margin-left/right: auto` on the group -- centres it in the BAND
  //      (breadcrumb edge to +Add), and that band's centre is NOT the bar's
  //      centre, because the band starts where the 220-280px sidebar column
  //      ends. Measured group-centre minus bar-centre: +125.7 at 1100 in the
  //      Project view, +217.9 at 1100 in the Session view. Worse than the
  //      layout it replaced.
  //   2. in-flow with no auto margins -- the group hugs the breadcrumb, ~153px
  //      left of the bar centre at 1440.
  //   3. absolutely positioned against the bar at `left: 50%` -- the ONLY one
  //      that hits the bar centre, because `.kikx-topbar` spans the viewport.
  //      Measured 0.0 at 1280/1440/1920 in both views.
  //
  // This spec asserts the CSS text. Geometry is asserted in the puppeteer lane
  // (`spec/ui/puppeteer/topbar-search-group-centring-puppeteer.mjs`), because a
  // regex over a stylesheet cannot tell you where anything lands on screen --
  // the auto-margin version passed a spec like this one while sitting 126-218px
  // right of centre.
  let css = await readFile(fileURLToPath(new URL('../../src/client/styles/topbar-unified.css', import.meta.url)), 'utf8');
  let stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');

  let groupRule = /\.kikx-topbar__search-group\s*\{([^}]*)\}/.exec(stripped);
  assert.ok(groupRule, 'the search group must have a layout rule in topbar-unified.css');
  let body = groupRule[1];

  assert.match(body, /(^|[;\s])gap\s*:/, 'the group must set the gap that makes the two controls hug');
  assert.doesNotMatch(body, /margin-(left|right)\s*:\s*auto/,
    'the base rule must not carry auto margins -- they centre on the band, not the bar');

  // The >1201px block holds the actual centring. It must exist, must position
  // the group against the bar, and must use `left: 50%` with a translate so the
  // group's own CENTRE (not its left edge) lands on the bar centre.
  let blockMatch = /@media\s*\(\s*min-width\s*:\s*1201px\s*\)\s*\{/.exec(stripped);
  assert.ok(blockMatch, 'the >1201px centring media block must exist');

  // Scan every compound-scoped group rule in the file and require one to be
  // absolutely positioned. The group has several scoped rules (sizing, the eye,
  // Participants), so anchoring on the first match would assert against the
  // wrong one and pass for the wrong reason.
  let scoped = [...stripped.matchAll(
    /\.kikx-topbar\.kikx-window__header\s+\.kikx-topbar__search-group\s*\{([^}]*)\}/g,
  )].map((match) => match[1]);
  assert.ok(scoped.length >= 1, 'the group must have a compound-scoped rule in the topbar');

  let pinned = scoped.filter((rule) => /position\s*:\s*absolute/.test(rule));
  assert.equal(pinned.length, 1,
    `exactly one of the group's ${scoped.length} scoped rules must take it out of flow; found ${pinned.length}`);
  assert.match(pinned[0], /left\s*:\s*50%/, 'the pinned rule must sit at the bar\'s 50% line');
  assert.match(pinned[0], /transform\s*:\s*translate\(\s*-50%/,
    'and must shift by half its own width, so the CENTRE lands there');
  assert.match(pinned[0], /top\s*:\s*50%/, 'vertically centred in the bar too');

  // The bar must be the containing block for that absolute position, or
  // `left: 50%` would resolve against some ancestor and the group would be
  // centred on the wrong box entirely.
  let barPos = /\.kikx-topbar\.kikx-window__header\s*\{([^}]*)\}/.exec(
    stripped.slice(blockMatch.index),
  );
  assert.ok(barPos, 'the media block must contain a rule for the bar itself');
  assert.match(barPos[1], /position\s*:\s*relative/,
    'the bar must be position:relative so left:50% resolves against the BAR');

  // The breadcrumb YIELDS to the centred group. Without this cap the lead ran
  // to 581.7px while the group started at 465 -- a 116.7px overlap at 1280 AND
  // 1440, hiding the session title under the search field. The group is out of
  // flow, so it cannot report its left edge back to the flex row; the crumb has
  // to be capped explicitly.
  let leadRule = /\.kikx-topbar\.kikx-window__header\s+\.kikx-window__lead\s*\{([^}]*)\}/.exec(
    stripped.slice(blockMatch.index),
  );
  assert.ok(leadRule, 'the media block must cap the breadcrumb lead');
  assert.match(leadRule[1], /max-width\s*:\s*calc\(\s*50vw/,
    'the cap is derived from the same 50%/width arithmetic as the group, not a magic number');

  // +Add still lands on the right edge, now pushed by the actions cluster
  // because the group has been lifted out of the flow entirely.
  let trailingRule = /\.kikx-topbar__trailing-actions\s*\{([^}]*)\}/.exec(stripped);
  assert.ok(trailingRule, 'the trailing +Add container must exist');
  assert.match(trailingRule[1], /order\s*:\s*3/, '+Add rides the trailing slot');

  let actionsRule = /\.kikx-window__actions\s*\{([^}]*)\}/.exec(stripped);
  assert.ok(actionsRule, 'the actions rule must exist in topbar-unified.css');
  assert.match(actionsRule[1], /order\s*:\s*2/,
    'actions rides the search group slot, immediately after it');
  assert.doesNotMatch(actionsRule[1], /margin-(left|right)\s*:\s*auto/,
    'the base actions rule must not reintroduce a hole between the controls');

  // A "hugged up next to" gap, not the bar's normal rhythm: the three must read
  // as one control group. 8px is the ceiling the owner's wording allows.
  let gap = /(^|[;\s])gap\s*:\s*(\d+(?:\.\d+)?)px/.exec(body);
  assert.ok(gap, 'the gap must be an explicit px value so this can be checked');
  assert.ok(Number(gap[2]) <= 8,
    `the search/eye gap must be small enough to read as one group; got ${gap[2]}px`);

  // The field must not centre itself: the GROUP is the centred unit, so the
  // field, the eye and Participants always travel together.
  let fieldRule = /\.kikx-topbar\.kikx-window__header\s+\.kikx-session-search\s*\{([^}]*)\}/.exec(stripped);
  assert.ok(fieldRule, 'the field must still have its own sizing rule');
  assert.doesNotMatch(fieldRule[1], /margin-left\s*:\s*auto/,
    'the field must not centre itself now that the group does');
});

test('preview status is a narrow property-store update in the topbar', async () => {
  let { previewStatusStore } = await import('../../src/client/state/preview-status-store.mjs');
  let app = makeApp();
  let actions = buildTopbarActions(app).build(document);
  let status = actions.querySelector('.kikx-workspace__status');

  previewStatusStore.set('loading', true, { source: 'test.loading' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(status.className, /kikx-auth-status--pending/);
  assert.equal(status.textContent, 'Loading previews…');

  previewStatusStore.set('loading', false, { source: 'test.loading' });
  previewStatusStore.set('status', '3 previews ready', { source: 'test.status' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(status.className, /kikx-auth-status--ready/);
  assert.equal(status.textContent, '3 previews ready');
});

// --- participants beside the eye (owner change, 2026-11-14) -----------------
//
// "take the Participants button, and move it to be right next to the eyeball
//  filter icon button in the top bar. Please also make it the same height as the
//  eyeball icon button ... which is currently a unique button size in the
//  top-bar."

test('the Participants button is a DIRECT sibling immediately after the eye', () => {
  // Structural, not pixel: a direct sibling with nothing between it and the eye
  // is what makes "right next to" survive the next refactor. Nesting it inside
  // the eye's popup, or leaving a spacer in the gap, would pass a screenshot
  // today and drift tomorrow.
  let app = makeApp();
  let group = buildTopbarSearch(app, 's1').build(document);
  let order = Array.from(group.childNodes).filter((node) => node.nodeType === 1);

  let eyeIndex = order.findIndex((node) => node.localName === 'kikx-frame-filter-popup');
  let participantsIndex = order.findIndex((node) => node.localName === 'kikx-participants-popup');
  assert.equal(eyeIndex, 1, 'the eye follows the field');
  assert.equal(participantsIndex, eyeIndex + 1,
    `participants must sit directly after the eye; got ${JSON.stringify(childNames(group))}`);
});

test('participants stays session-scoped: the Projects root has no roster', () => {
  // The eye is unconditional -- soft-deleted sessions are listed at the root, so
  // gating it there would strand "show deleted". Participants is a session
  // roster, so it must not render with no session at all.
  let app = makeApp();
  let root = buildTopbarSearch(app, null).build(document);

  assert.deepEqual(childNames(root), [ 'div', 'kikx-frame-filter-popup', 'kikx-overflow-popup' ],
    'at the root the participants slot collapses; the eye stays');
});

test('the Participants button is the same height as the eyeball button', async () => {
  // "also make it the same height as the eyeball icon button ... which is
  //  currently a unique button size in the top-bar."
  //
  // Both buttons are content-box, carry a 1px border and set no other vertical
  // sizing, so matching min-height is exactly what matches rendered height.
  // Asserted as AGREEMENT rather than the literal 34px: moving the eye's height
  // must move both or fail here, so there is one pair of rules and not a second
  // size scale.
  let readStyles = async (name) => (await readFile(
    fileURLToPath(new URL(`../../src/client/styles/${name}`, import.meta.url)), 'utf8'))
    .replace(/\/\*[\s\S]*?\*\//g, '');

  let eyeCss = await readStyles('app-thinking.css');
  let barCss = await readStyles('topbar-unified.css');

  let eye = /\.kikx-frame-filter__button\s*\{([^}]*)\}/.exec(eyeCss);
  assert.ok(eye, 'the eyeball button must have its own rule in app-thinking.css');
  let eyeHeight = /min-height\s*:\s*(\d+)px/.exec(eye[1]);
  assert.ok(eyeHeight, `the eyeball button must set an explicit min-height; got "${eye[1].trim()}"`);

  // Read from the sheet where participants now LIVES (the search group in the
  // top bar), not from the generic button family it was built for.
  let participants = /\.kikx-participants__button\s*\{([^}]*)\}/.exec(barCss);
  assert.ok(participants,
    'participants must be re-heighted where it now lives, so the pair reads as one row');
  let participantsHeight = /min-height\s*:\s*(\d+)px/.exec(participants[1]);
  assert.ok(participantsHeight, 'the participants rule must set an explicit min-height');

  assert.equal(participantsHeight[1], eyeHeight[1],
    `participants (${participantsHeight[1]}px) must match the eyeball (${eyeHeight[1]}px)`);
});

// --- Raw / Debug left the bar (owner change, 2026-11-14) -------------------

test('the bar no longer carries Raw/Debug chips -- they live in the eye popup', () => {
  // Removing them from the cluster is half the change; the other half is that the
  // popup renders them at its foot, asserted in frame-filter-popup-spec.mjs.
  // Leftover chips would be a second source of truth for the same two flags.
  let app = makeApp({ rawMarkdown: true, debugMode: true });
  let bar = buildUnifiedTopbar(app).build(document);

  assert.equal(bar.querySelector('.kikx-raw-toggle'), null, 'no Raw chip anywhere in the bar');
  assert.equal(bar.querySelector('.kikx-debug-toggle'), null, 'no Debug chip anywhere in the bar');
});
