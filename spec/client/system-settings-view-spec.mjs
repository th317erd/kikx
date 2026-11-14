'use strict';

// =============================================================================
// System Settings: a core shell mode, dispatched through the core table
// =============================================================================
// Campaign S1 (plan §5-S1, amended by §9). The two annotated screenshots ask
// for a first-class "System Settings" mode: the SAME layout, reusing the
// sidebar, opened from a topbar gear — not a dialog. What this spec locks:
//
//   1. `settings` is a core view id. It joins CORE_VIEW_SURFACE_IDS, which is
//      both the addressable vocabulary (?view=settings parses, pushView holds
//      it) and the reserved set (§9.3.9: a plugin descriptor claiming
//      `settings` is refused — core wins, with the conflict observable here).
//   2. Dispatch goes through the CORE_VIEW_BUILDERS table, never a new
//      `viewName ===` branch in the shell (the P7 grep gate).
//   3. The sections model: ['General', 'Email', 'Plugins'] base trio (Email
//      joined owner 2026-11-13) ∪ plugin sections, local
//      choice in state.settingsSection, defaulting to 'General', with the
//      §9.3.12 clamp — a section whose plugin was unloaded live must fall
//      back to 'General' rather than a blank body.
//   4. The topbar gear replaces the dialog-opening text button; the dialog
//      path stays in code but the topbar must reach navigation, not
//      `app._openSettings`.
//   5. The sidebar gains a "System Settings" row in the `view` group,
//      active when the view is open.
//
// Same bootstrap as the neighbouring top-bar specs: stub the vendor web
// components, install a jsdom-free DOM, then import the real modules.

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';
import { readFile } from 'node:fs/promises';

register(new URL('./support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);
const { installDom } = await import('./support/mini-dom.mjs');
installDom();

const REPO = new URL('../../', import.meta.url);
const source = (relativePath) => readFile(new URL(relativePath, REPO), 'utf8');

function makeApp(overrides = {}) {
  return {
    _state: {
      account: { name: 'Wyatt', email: 'wegreenway@taraani.org' },
      navigationStack: [ { sessionID: null, collapsed: true } ],
      ...overrides.state,
    },
    renders: 0,
    _render() { this.renders++; },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Core vocabulary and the reserved-id conflict (§9.3.9)
// ---------------------------------------------------------------------------

test('settings is a core, reserved view id', async () => {
  let registry = await import('../../src/client/state/view-name-registry.mjs');

  assert.ok(registry.isCoreViewSurface('settings'), 'settings must be a core surface id');
  assert.ok(registry.isReservedViewSurfaceID('settings'), 'and therefore reserved');
  assert.ok(registry.getRegisteredViewNames().includes('settings'),
    'and addressable with no descriptor at all');
});

test('a plugin descriptor claiming settings is refused — core wins (§9.3.9)', async () => {
  let { viewNamesFromComponents } =
    await import('../../src/client/state/view-name-registry.mjs');

  let claimed = viewNamesFromComponents([
    { kind: 'view', surfaceID: 'settings', tagName: 'kikx-takeover', moduleURL: '/x.mjs' },
    { kind: 'sidebar-item', surfaceID: 'row', view: 'settings', tagName: 'kikx-row', moduleURL: '/y.mjs' },
    { kind: 'view', surfaceID: 'notes', tagName: 'kikx-notes', moduleURL: '/n.mjs' },
  ]);

  assert.deepEqual(claimed, [ 'notes' ],
    'both collisions must be filtered and the non-colliding view must survive');
});

test('?view=settings parses and round-trips (§9.3.10 comes free)', async () => {
  let { syncViewNames } = await import('../../src/client/state/view-name-registry.mjs');
  let { stackFromSearchParams, currentViewName, pushView, stackToURL } =
    await import('../../src/client/state/navigation-stack.mjs');

  syncViewNames(null);
  try {
    assert.equal(stackFromSearchParams('?view=settings').view, 'settings');

    let stack = pushView([ { sessionID: null, collapsed: true } ], 'settings');
    assert.equal(currentViewName(stack), 'settings');
    assert.match(stackToURL(stack, { pathname: '/' }), /view=settings/);
  } finally {
    syncViewNames(null);
  }
});

// ---------------------------------------------------------------------------
// 2. Navigation seam (mirror of navigateInbox / pushInbox)
// ---------------------------------------------------------------------------

test('navigateSystemSettings pushes the view and is idempotent', async () => {
  let { navigateSystemSettings } =
    await import('../../src/client/state/kikx-state.mjs');
  let { pushSystemSettings } = await import('../../src/client/state/navigation-stack.mjs');

  let state = { navigationStack: [ { sessionID: null, collapsed: true } ] };
  navigateSystemSettings(state);
  assert.equal(state.navigationStack.at(-1).view, 'settings');
  let depth = state.navigationStack.length;

  navigateSystemSettings(state);
  assert.equal(state.navigationStack.length, depth,
    'entering Settings twice must not stack two copies (Back would look broken)');

  assert.equal(current(state), 'settings');
  assert.equal(pushSystemSettings([ { sessionID: null, collapsed: true } ]).at(-1).view, 'settings');

  function current(s) {
    return s.navigationStack.at(-1)?.view ?? null;
  }
});

// ---------------------------------------------------------------------------
// 3. Dispatch through the core table — no new viewName branch (P7 gate)
// ---------------------------------------------------------------------------

test('resolveViewSurface renders the settings view through the core table', async () => {
  let { resolveViewSurface } = await import('../../src/client/components/client-view-surfaces.mjs');
  let app = makeApp();
  let element = resolveViewSurface('settings', app._state, app);

  assert.ok(element, 'the core table must resolve settings to a builder result');
  let text = collectText(element);
  assert.match(text, /Account/, 'the default (General) section renders its body — the Account block');

  // Owner screenshot 1 (2026-11-13): "Remove all of this (the sub-title and
  // back button, and the tabbed-view)" — now asserted as ABSENCE, twice over:
  // the sidebar carries navigation and the breadcrumb carries the mode.
  assert.equal(
    findNode(element, (node) => node.localName === 'aeor-tab-view'),
    null, 'no tabbed view renders');
  assert.equal(
    findNode(element, (node) => node.localName === 'aeor-tab'),
    null, 'no tabs render');
  assert.equal(
    findNode(element, (node) => String(node.className || '').includes('kikx-view-header')),
    null, 'no view header — so no Back button and no subtitle');
  assert.doesNotMatch(text, /System Settings/,
    'the subtitle is gone from the view (the breadcrumb reads "Settings › …")');
});

test('settings mode swaps the sidebar view cluster for section navigation (owner screenshot 1)', async () => {
  const { buildSessionObjectItems } = await import('../../src/client/components/kikx-sidebar-session-objects.mjs');
  const { buildInboxSidebarEntry } = await import('../../src/client/components/kikx-inbox-view.mjs');
  const { pushSystemSettings } = await import('../../src/client/state/navigation-stack.mjs');
  const app = makeApp();
  app._state.navigationStack = pushSystemSettings(
    app._state.navigationStack || [ { sessionID: null, collapsed: true } ]);

  const viewRows = buildSessionObjectItems(app).filter((item) => item.group === 'view');
  assert.deepEqual(viewRows.map((row) => row.label), [ 'General', 'Email', 'Plugins' ],
    'the settings navigation items REPLACE Agents/Teams (owner: "Sidebar content gets replaced with Settings navigation items")');
  assert.equal(viewRows[0].active, true, 'General is active by default');
  assert.equal(buildInboxSidebarEntry(app), null,
    'Inbox belongs to the replaced content — the builder bows out');

  const labels = buildSessionObjectItems(app).map((item) => item.label);
  assert.ok(labels.includes('Account') && labels.includes('Sign out'), 'the footer stays');

  // A row click goes through the ONE seam (persist + publish + render).
  app._syncURLFromStack = () => { app.__synced = true; };
  app._requestRender = () => { app.__rendered = true; };
  viewRows.find((row) => row.label === 'Email').onSelect();
  assert.equal(app._state.settingsSection, 'Email', 'persisted');
  assert.equal(app.__synced, true, 'URL published');
  assert.equal(app.__rendered, true, 'render requested');
  const after = buildSessionObjectItems(app).filter((item) => item.group === 'view');
  assert.equal(after.find((row) => row.label === 'Email').active, true, 'active follows the switch');

  // Leaving the mode restores the normal view rows.
  app._state.navigationStack = [ { sessionID: null, collapsed: true } ];
  const normal = buildSessionObjectItems(app).filter((item) => item.group === 'view')
    .map((row) => row.label);
  assert.deepEqual(normal, [ 'Agents', 'Teams' ], 'outside the mode the view rows come back');
});

test('the settings breadcrumb is ONE "< Exit Settings" control; the sidebar owns sections (owner 2026-11-13)', async () => {
  const { buildCrumbModel } = await import('../../src/client/components/kikx-topbar.mjs');
  const { pushSystemSettings } = await import('../../src/client/state/navigation-stack.mjs');
  const { activateSettingsSection, getSettingsSection } =
    await import('../../src/client/components/kikx-system-settings-view.mjs');
  const app = makeApp();
  app._state.navigationStack = pushSystemSettings(
    app._state.navigationStack || [ { sessionID: null, collapsed: true } ]);

  const crumbs = buildCrumbModel(app);
  assert.equal(crumbs.length, 1, 'the breadcrumb collapses to a single control');
  assert.equal(crumbs[0].label, '< Exit Settings', "the owner's literal label");
  assert.equal(crumbs[0].exitSettings, true, 'it carries the exit marker');
  assert.equal(crumbs[0].active, false, 'a real button, never a passive span');
  assert.equal('settingsRoot' in crumbs[0], false,
    'the earlier Settings→General crumb idea is superseded by the exit control');

  // The SECTION seam stays for the sidebar rows (persist + publish + render).
  app._syncURLFromStack = () => { app.__synced = true; };
  app._requestRender = () => { app.__rendered = true; };
  app._state.settingsSection = 'Plugins';
  activateSettingsSection(app, 'General');
  assert.equal(app._state.settingsSection, 'General', 'persisted');
  assert.equal(getSettingsSection(app._state), 'General');
  assert.equal(app.__synced && app.__rendered, true, 'URL + render published');
});

test('grep gate: the shell gains no viewName branch for settings', async () => {
  let shell = await source('src/client/components/kikx-shell-builders.mjs');
  assert.doesNotMatch(shell, /viewName\s*===\s*'settings'/,
    'dispatch must resolve through the core table, not a new ternary branch');
  assert.match(shell, /resolveViewSurface\(/,
    'and the shell must keep dispatching through resolveViewSurface');

  let surfaces = await source('src/client/components/client-view-surfaces.mjs');
  assert.match(surfaces, /\[\s*'settings'\s*,/,
    'the core fallback table must carry the settings builder entry');
});

// ---------------------------------------------------------------------------
// 4. Sections model, state, and the live-unload clamp (§9.3.12)
// ---------------------------------------------------------------------------

test('the sections model is General + Plugins, default General', async () => {
  let { SETTINGS_SECTIONS, getSettingsSection, setSettingsSection } =
    await import('../../src/client/components/kikx-system-settings-view.mjs');

  assert.deepEqual(SETTINGS_SECTIONS, [ 'General', 'Email', 'Plugins' ]);

  let state = { account: { name: 'Wyatt', email: 'w@example.com' } };
  assert.equal(getSettingsSection(state), 'General', 'unset means General');
  assert.equal(state.settingsSection, undefined,
    'reading must not write: the default is derived, state changes only on user choice');

  setSettingsSection(state, 'Plugins');
  assert.equal(state.settingsSection, 'Plugins', 'the user choice lives in app state (integrity rule)');

  setSettingsSection(state, 'Evil');
  assert.equal(state.settingsSection, 'Plugins', 'an unknown section is refused, never stored');
});

test('a section whose plugin was unloaded clamps to General (§9.3.12)', async () => {
  let { getSettingsSection, clampSettingsSection } =
    await import('../../src/client/components/kikx-system-settings-view.mjs');

  let state = { settingsSection: 'Acme Mailer' };
  assert.equal(getSettingsSection(state, [ 'General', 'Plugins' ]), 'General',
    'a live unload must not leave the view rendering a body that no longer exists');
  assert.equal(clampSettingsSection('Acme Mailer', [ 'General', 'Plugins' ]), 'General');
  assert.equal(clampSettingsSection('Plugins', [ 'General', 'Plugins' ]), 'Plugins');
  // General is always available even if a caller passes a nonsense list.
  assert.equal(clampSettingsSection('Anything', []), 'General');
});

// ---------------------------------------------------------------------------
// 5. The topbar gear reaches navigation, not the dialog
// ---------------------------------------------------------------------------

test('the ONLY System Settings entry is the upper-left brand mark (owner ruling)', async () => {
  // Owner ruling (2026-11-07): the cluster gear is gone — "it is NOT supposed
  // to be here (only in the upper left)". Pin the negative so the cluster gear
  // cannot quietly return, and the brand path with it.
  let topbar = await source('src/client/components/kikx-topbar.mjs');

  assert.doesNotMatch(topbar, /settingsOpenButton/,
    'no settings gear in the actions cluster — settings is brand-only');
  assert.match(topbar, /button[\s\S]{0,200}kikx-brand__mark/,
    'the brand mark remains a real button (clickable and focusable)');
  assert.match(topbar, /kikx-brand__mark[\s\S]{0,500}navigateSystemSettings\(app\._state\)/,
    'and clicking it still navigates to System Settings');
  assert.match(topbar, /title\('System Settings'\)/, 'and announces itself');
  assert.doesNotMatch(topbar, /app\._openSettings\)/, 'never the dialog opener');
});

// ---------------------------------------------------------------------------
// 6. The sidebar row lives in the view group, active when open (§5-S1)
// ---------------------------------------------------------------------------

test('System Settings is NOT a Workspace row — the brand mark is the global entry (owner ruling)', async () => {
  // Built, then removed on owner correction: settings is GLOBAL, so a sidebar
  // row made it read as session-scoped. Pin the negative (no row returns) and
  // the positive entry (the upper-left [K] brand mark is a gear button).
  let { buildSessionObjectItems } =
    await import('../../src/client/components/kikx-sidebar-session-objects.mjs');

  let app = makeApp({ state: { navigationStack: [ { sessionID: null, collapsed: true, view: 'settings' } ] } });
  let items = buildSessionObjectItems(app);
  assert.ok(!items.some((item) => item.label === 'System Settings'),
    'no sidebar row may claim System Settings — it is not a session object');

  let topbar = await source('src/client/components/kikx-topbar.mjs');
  assert.match(topbar, /class\('kikx-brand__mark'\)/, 'the brand mark is the entry surface');
  assert.match(topbar, /button[\s\S]{0,200}kikx-brand__mark/,
    'the mark renders as a real button (clickable and focusable)');
  assert.match(topbar, /kikx-brand__mark[\s\S]{0,500}navigateSystemSettings\(app\._state\)/,
    'clicking the brand gear navigates to System Settings');
  assert.match(topbar, /title\('System Settings'\)/, 'and announces itself as System Settings');
});

// ---------------------------------------------------------------------------
// 7. Stylesheet gate for the new classes
// ---------------------------------------------------------------------------

test('plugin sidebar rows render under a PLUGINS heading only while one exists (§9.1.4)', async () => {
  let { buildSidebarSessionObjects } =
    await import('../../src/client/components/kikx-sidebar-session-objects.mjs');

  let state = {
    account: { name: 'Wyatt', email: 'w@example.com' },
    navigationStack: [ { sessionID: null, collapsed: true } ],
    clientSidebarItems: {},
  };
  let app = makeApp({ state });

  assert.equal(
    buildSidebarSessionObjects(app, { group: 'plugins' }),
    null,
    'with no plugin-owned rows the cluster must be absent — no orphan heading, no empty box',
  );

  // NOTE: makeApp SPREADS the passed state into _state, so mutations must land
  // on app._state — mutating the local object would silently test nothing.
  app._state.clientSidebarItems = {
    'notes-row': {
      kind: 'sidebar-item', surfaceID: 'notes-row', label: 'Notes', view: 'notes',
      tagName: 'kikx-notes', moduleURL: '/n.mjs',
    },
  };
  let cluster = buildSidebarSessionObjects(app, { group: 'plugins' });
  let text = collectText(cluster);
  assert.match(text, /PLUGINS/, 'a plugin-owned row must cluster under the PLUGINS heading');
  assert.match(text, /Notes/, 'and still render its own row');

  // Presentation-only means the row KEEPS its view-row styling — falling into
  // the footer branch would render plugin rows with Sign-out styling, which is
  // the exact defect renderItem's group split once fixed.
  let pluginButton = findNode(cluster, (node) => node.localName === 'button');
  assert.ok(pluginButton, 'the plugin row must be a button');
  let className = pluginButton.getAttribute?.('class') || '';
  assert.match(className, /kikx-sidebar__view/,
    'plugin rows keep view-row presentation under the new heading');
  assert.doesNotMatch(className, /kikx-sign-out-button/,
    'and must not fall through to footer/sign-out styling');

  // The core clusters are untouched by the new group.
  let viewCluster = collectText(buildSidebarSessionObjects(app, { group: 'view' }));
  assert.doesNotMatch(viewCluster, /PLUGINS/,
    'the heading must not leak into the Workspace cluster');
  assert.match(viewCluster, /Agents[\s\S]*Teams/,
    'the core view cluster keeps its rows');
});

test('every class the settings view emits exists in a stylesheet', async () => {
  let viewSource = (await source('src/client/components/kikx-system-settings-view.mjs'))
    + (await source('src/client/components/kikx-settings-plugins-section.mjs'));
  let used = [ ...viewSource.matchAll(/\.class\(\s*'([^']+)'/g) ]
    .flatMap((match) => match[1].split(/\s+/).filter(Boolean));
  assert.ok(used.length > 0, 'the view must declare its classes through the DSL');

  let css = '';
  for (const { readdir, readFile: rf } of [ { readdir: (await import('node:fs/promises')).readdir, readFile: (await import('node:fs/promises')).readFile } ]) {
    let dir = new URL('src/client/styles/', REPO);
    for (let name of await readdir(dir)) {
      if (name.endsWith('.css')) css += await rf(new URL(name, dir), 'utf8');
    }
  }

  for (let className of used)
    assert.ok(css.includes(`.${className}`),
      `class .${className} is emitted by the settings view but appears in no stylesheet`);
});

// ---------------------------------------------------------------------------

function collectText(node) {
  let text = '';
  (function walk(current) {
    if (!current) return;
    if (current.nodeType === 3) text += `${current.textContent || ''} `;
    for (let child of current.childNodes || []) walk(child);
  })(node);
  return text;
}

function findNode(node, predicate) {
  if (!node) return null;
  if (predicate(node)) return node;
  for (let child of node.childNodes || []) {
    let found = findNode(child, predicate);
    if (found) return found;
  }
  return null;
}

// Superseded (owner follow-up, 2026-11-13): "The Breadcrumb is pretty useless
// in this Settings area. All navigation items are single-level, and are
// already all present on the sidebar… swap out the breadcrumb for a
// '< Exit Settings' button." This replaces screenshot 2's
// "Settings › <section>" test — same guarantee (the mode never leaks the
// session path behind it), one control instead of two crumbs.
test('buildCrumbModel in the mode is ONLY the exit control — never the session path (owner 2026-11-13)', async () => {
  const { buildCrumbModel } = await import('../../src/client/components/kikx-topbar.mjs');
  const { pushSystemSettings } = await import('../../src/client/state/navigation-stack.mjs');
  const app = makeApp();
  // A session UNDERNEATH the mode — the ?session=…&view=settings URL shape.
  app._state.navigationStack = pushSystemSettings([
    { sessionID: null, collapsed: true },
    { sessionID: 'session_identity', collapsed: false },
  ]);
  app._state.settingsSection = 'Plugins';
  const labels = buildCrumbModel(app).map((crumb) => crumb.label);
  assert.deepEqual(labels, [ '< Exit Settings' ],
    `one control, no section crumbs, no session path leaked (got ${JSON.stringify(labels)})`);
});

test('getSettingsSection prefers live state, falls back to the URL-restored entry, clamps junk (owner 2026-11-12)', async () => {
  let { getSettingsSection } = await import('../../src/client/components/kikx-system-settings-view.mjs');

  const restored = [
    { sessionID: null, collapsed: true },
    { view: 'settings', section: 'Plugins' },
  ];

  assert.equal(getSettingsSection({ navigationStack: restored }), 'Plugins',
    'a freshly reloaded page opens the tab the URL named — no click needed');
  assert.equal(getSettingsSection({ navigationStack: restored, settingsSection: 'General' }), 'General',
    'live state always wins over the restored entry');
  assert.equal(getSettingsSection({ navigationStack: [ { sessionID: null } ] }), 'General',
    'no entry, no state → the default');
  assert.equal(
    getSettingsSection({ navigationStack: [ { sessionID: null }, { view: 'settings', section: 'Bogus' } ] }),
    'General',
    'an unknown restored section clamps to the base pair',
  );
});

test('General renders the eight rainbow theme swatches with the selected one pressed (owner 2026-11-11)', async () => {
  let { resolveViewSurface } = await import('../../src/client/components/client-view-surfaces.mjs');
  let { THEME_PALETTE } = await import('../../src/client/lib/theme.mjs');

  const state = {
    account: { name: 'Wyatt', email: 'w@example.com' },
    navigationStack: [ { sessionID: null, collapsed: true } ],
    settingsSection: 'General',
    themeID: 'purple',
  };
  const app = makeApp();
  app._state = state;
  const view = resolveViewSurface('settings', state, app);

  const swatches = [];
  (function walk(node) {
    if (!node) return;
    // Exact class TOKEN — a substring match also catches the __swatches
    // container, whose class starts with the same prefix (that bug: 9 !== 8).
    if (String(node.className || '').split(/\s+/).includes('kikx-theme-picker__swatch')) swatches.push(node);
    for (const child of node.childNodes || []) walk(child);
  })(view);

  assert.equal(swatches.length, THEME_PALETTE.length, 'one swatch per palette color (8)');
  for (const color of THEME_PALETTE) {
    const swatch = swatches.find((node) => String(node.className || '').split(/\s+/).includes(`kikx-theme-picker__swatch--${color.id}`));
    assert.ok(swatch, `the ${color.id} swatch exists`);
    assert.match(String(swatch.getAttribute('aria-label') || ''), new RegExp(color.label, 'i'),
      `${color.id} is labelled for screen readers`);
    const pressed = swatch.getAttribute('aria-pressed');
    assert.equal(pressed, color.id === 'purple' ? 'true' : 'false',
      `aria-pressed reflects state.themeID exactly once (${color.id})`);
  }
  assert.equal(swatches.filter((node) => node.getAttribute('aria-pressed') === 'true').length, 1,
    'exactly ONE swatch reads as selected');
});
