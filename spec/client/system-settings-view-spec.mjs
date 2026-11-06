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
//   3. The sections model: ['General', 'Plugins'] per the S2 model, local
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
  assert.match(text, /System Settings/, `the view must render its heading; saw: ${JSON.stringify(text.slice(0, 200))}`);
  assert.match(text, /General/, 'the sections tab row must be present');
  assert.match(text, /Plugins/, 'the Plugins section tab must be present');
  assert.match(text, /Account/, 'the General section renders the Account block');
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

  assert.deepEqual(SETTINGS_SECTIONS, [ 'General', 'Plugins' ]);

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

test('the topbar opens System Settings via navigation, not the dialog', async () => {
  let topbar = await source('src/client/components/kikx-topbar.mjs');

  assert.match(topbar, /navigateSystemSettings\(app\._state\)/,
    'the gear must push the settings view');
  assert.doesNotMatch(topbar, /app\._openSettings\)/,
    'the topbar must no longer call the dialog opener (the dialog path stays in code)');
  assert.match(topbar, /createIcon\('gear'\)/, 'the entry point is the gear icon');
  assert.match(topbar, /title\('System Settings'\)/, 'titled per the annotation');
});

// ---------------------------------------------------------------------------
// 6. The sidebar row lives in the view group, active when open (§5-S1)
// ---------------------------------------------------------------------------

test('the sidebar carries a System Settings row in the view group', async () => {
  let { buildSessionObjectItems } =
    await import('../../src/client/components/kikx-sidebar-session-objects.mjs');

  let app = makeApp({ state: { navigationStack: [ { sessionID: null, collapsed: true, view: 'settings' } ] } });
  let items = buildSessionObjectItems(app);
  let row = items.find((item) => item.label === 'System Settings');

  assert.ok(row, 'the annotated sidebar entry must exist');
  assert.equal(row.group, 'view', 'it sits with Inbox/Agents/Teams, not the footer');
  assert.equal(row.active, true, 'active state follows the stack, same as the core rows');

  app._state.navigationStack = [ { sessionID: null, collapsed: true } ];
  let inactive = buildSessionObjectItems(app).find((item) => item.label === 'System Settings');
  assert.equal(inactive.active, false, 'and clears when the view is not open');

  inactive.onSelect();
  assert.equal(app._state.navigationStack.at(-1).view, 'settings',
    'the row must actually navigate (a dead control is the failure mode we hunt)');
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
  assert.match(viewCluster, /System Settings/, 'the core view cluster keeps its rows');
});

test('every class the settings view emits exists in a stylesheet', async () => {
  let viewSource = await source('src/client/components/kikx-system-settings-view.mjs');
  let used = [ ...viewSource.matchAll(/\.class\(\s*'([^']+)'/g) ].map((match) => match[1]);
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
