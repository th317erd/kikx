'use strict';

// =============================================================================
// System Settings → Plugins (campaign S2): sections model, inventory, cards
// =============================================================================
// Plan §5-S2 amended by §9.1.2/§9.1.3/§9.3.12. What this pins:
//
//   1. Sections model = ['General','Plugins'] ∪ plugin-contributed sections,
//      extras stable-sorted by surfaceID; the unload clamp follows the LIVE
//      set (§9.3.12), so a vanished plugin section falls back to General.
//   2. `settings-panel` descriptors gain `section` (default 'General') —
//      through normalization, listSettingsPanels, and per-section mounting in
//      the VIEW body (the dialog keeps working as the legacy mount).
//   3. The inventory store: fetch /api/v1/plugins when the view opens,
//      unwrap {data}, surface operator 401/403 messages verbatim, never drop
//      a previously loaded inventory on error.
//   4. Installed Plugins cards: name/version/description/mount state, the
//      Internal Plugin notice (managed === false), failures, restart-required
//      notice, Unload/Reload/Install-from-path controls, Browse placeholder
//      column for S3.
//   5. `isManagedPluginLocation` — bundled root is NEVER managed, configured
//      paths are, unknown roots fail closed (secure-by-default posture), and
//      the inventory route reports it (source-gated here; route behaviour is
//      exercised end-to-end with the uninstall phase, where the gate bites).
//   6. `KikxSettingsPage` — the base class plugin authors subclass — carries
//      configure({label,description,section}), an app/state slot, and
//      teardown that runs exactly once on disconnect.

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';
import { readFile } from 'node:fs/promises';

register(new URL('./support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);
const { installDom } = await import('./support/mini-dom.mjs');
installDom();

const REPO = new URL('../../', import.meta.url);
const source = (relativePath) => readFile(new URL(relativePath, REPO), 'utf8');

function pluginPanel(surfaceID, section, tagName) {
  return {
    kind: 'settings-panel',
    surfaceID,
    tagName: tagName || `kikx-panel-${surfaceID}`,
    moduleURL: `/plugins/${surfaceID}/panel.mjs`,
    label: `${surfaceID} panel`,
    ...(section ? { section } : {}),
  };
}

function makeApp(stateOverrides = {}) {
  return {
    _state: {
      account: { name: 'Wyatt', email: 'w@example.com' },
      navigationStack: [ { sessionID: null, collapsed: true } ],
      ...stateOverrides,
    },
    _posts: [],
    async _getJSON() { throw new Error('_getJSON not stubbed'); },
    async _postJSON(url, body) { this._posts.push([ url, body ]); return { data: { ok: true } }; },
    _render() {},
    _requestRender() {},
  };
}

// ---------------------------------------------------------------------------
// 1/2. Sections model: union, stable order, live clamp
// ---------------------------------------------------------------------------

test('sections model unions plugin sections: base first, extras stable by surfaceID', async () => {
  let { setClientComponents } = await import('../../src/client/state/kikx-state.mjs');
  let { settingsSections, SETTINGS_SECTIONS } =
    await import('../../src/client/components/kikx-system-settings-view.mjs');

  let state = {};
  setClientComponents([
    pluginPanel('zebra', 'Zebra Mail'),
    pluginPanel('aaa', 'Notes'),
    pluginPanel('in-base', 'Plugins'),   // joins an existing base section — no duplicate
    pluginPanel('unsectioned'),          // defaults to General — no duplicate
  ], state);

  assert.deepEqual(SETTINGS_SECTIONS, [ 'General', 'Plugins' ], 'the base pair is unchanged');
  assert.deepEqual(
    settingsSections(state),
    [ 'General', 'Plugins', 'Notes', 'Zebra Mail' ],
    'extras are sorted by surfaceID (aaa before zebra) and de-duplicated against the base',
  );

  setClientComponents([], state);
  assert.deepEqual(settingsSections(state), [ 'General', 'Plugins' ], 'unload shrinks the set again');
});

test('the unload clamp follows the LIVE section set (§9.3.12)', async () => {
  let { setClientComponents } = await import('../../src/client/state/kikx-state.mjs');
  let { getSettingsSection, settingsSections } =
    await import('../../src/client/components/kikx-system-settings-view.mjs');

  let state = { settingsSection: 'Notes' };
  setClientComponents([ pluginPanel('aaa', 'Notes') ], state);
  assert.equal(getSettingsSection(state, settingsSections(state)), 'Notes',
    'a present section keeps the selection');

  setClientComponents([], state);
  assert.equal(getSettingsSection(state, settingsSections(state)), 'General',
    'the moment the plugin is gone, the selection must not point at a body that no longer exists');
});

// ---------------------------------------------------------------------------
// 3. Descriptor plumbing: section through normalize + listSettingsPanels
// ---------------------------------------------------------------------------

test('settings-panel descriptors keep `section` end to end, defaulting to General', async () => {
  let { setClientComponents } = await import('../../src/client/state/kikx-state.mjs');
  let { listSettingsPanels } = await import('../../src/client/components/kikx-settings-panel.mjs');

  let state = {};
  setClientComponents([ pluginPanel('zebra', 'Zebra Mail'), pluginPanel('plain') ], state);

  assert.equal(state.clientSettingsPanels?.['zebra']?.section, 'Zebra Mail',
    'normalization must not strip the new field');

  let byID = Object.fromEntries(listSettingsPanels(state).map((panel) => [ panel.surfaceID, panel.section ]));
  assert.deepEqual(byID, { zebra: 'Zebra Mail', plain: 'General' },
    'listSettingsPanels passes section through and defaults it');
});

// ---------------------------------------------------------------------------
// 4. Inventory store
// ---------------------------------------------------------------------------

test('inventory store: success unwraps {data}, loading and error stay honest', async () => {
  let { loadSystemSettingsPlugins, createSystemSettingsPluginsState } =
    await import('../../src/client/state/system-settings-plugins.mjs');

  let state = {};
  let calls = 0;
  await loadSystemSettingsPlugins(state, async () => {
    calls++;
    return { data: { plugins: [ { name: 'alpha' } ], failures: [ { location: '/x', message: 'boom' } ], restartRequired: [ 'FrameRouter' ] } };
  });
  let store = state.systemSettingsPlugins;
  assert.equal(store.loading, false, 'loading clears');
  assert.equal(store.loaded, true, 'a successful load marks the store loaded');
  assert.equal(store.error, null);
  assert.deepEqual(store.inventory.map((p) => p.name), [ 'alpha' ]);
  assert.deepEqual(store.failures.map((f) => f.message), [ 'boom' ], 'failures carry through for the cards');
  assert.deepEqual(store.restartRequired, [ 'FrameRouter' ]);

  // An operator-denied fetch (401/403) surfaces the SERVER message — the
  // single honest answer when the caller is not an operator — and keeps the
  // previously loaded inventory on screen instead of blanking it.
  await loadSystemSettingsPlugins(state, async () => {
    const error = new Error('plugin install is disabled');
    error.hint = 'set KIKX_PLUGIN_INSTALL_ENABLED=true to allow installing code at runtime';
    throw error;
  });
  let errored = state.systemSettingsPlugins;
  assert.equal(errored.loading, false, 'error path clears loading');
  assert.match(errored.error, /plugin install is disabled/, 'the server message is shown verbatim');
  assert.match(errored.error, /KIKX_PLUGIN_INSTALL_ENABLED/, 'the 403 hint rides along');
  assert.deepEqual(errored.inventory.map((p) => p.name), [ 'alpha' ],
    'an error must not wipe a loaded inventory');
  assert.equal(calls, 1);
  assert.ok(createSystemSettingsPluginsState, 'the factory stays exported for first open');
});

// ---------------------------------------------------------------------------
// 5. Installed Plugins cards
// ---------------------------------------------------------------------------

function inventoryState() {
  return {
    systemSettingsPlugins: {
      inventory: [
        {
          name: 'alpha-plugin', location: '/srv/plugs/alpha', managed: true,
          manifest: { version: '1.2.0', description: 'Does alpha things' },
          mounted: true, mount: { auth: 'operator' }, subscriptions: null,
        },
        {
          name: 'bundled-core', location: '/repo/src/plugins/core', managed: false,
          manifest: { version: '0.1.0', description: 'Ships with the platform' },
          mounted: false, mount: null, subscriptions: null,
        },
      ],
      failures: [ { location: '/srv/plugs/broken', message: 'entry threw on load' } ],
      restartRequired: [ 'FrameRouter' ],
      loading: false, error: null, loaded: true,
    },
  };
}

test('Installed Plugins cards render inventory, notices and actions honestly', async () => {
  let { buildPluginsSection } = await import('../../src/client/components/kikx-settings-plugins-section.mjs');
  let app = makeApp(inventoryState());
  let built = buildPluginsSection(app);
  let node = typeof built.build === 'function' ? built.build(document) : built;

  const textOf = (root) => {
    let text = '';
    (function walk(current) {
      if (!current) return;
      if (current.nodeType === 3) text += `${current.textContent || ''} `;
      for (const child of current.childNodes || []) walk(child);
    })(root);
    return text;
  };
  const find = (root, predicate) => {
    if (!root) return null;
    if (predicate(root)) return root;
    for (const child of root.childNodes || []) {
      const hit = find(child, predicate);
      if (hit) return hit;
    }
    return null;
  };
  let text = textOf(node);

  assert.match(text, /alpha-plugin/, 'plugin names render');
  assert.match(text, /1\.2\.0/, 'manifest version renders');
  assert.match(text, /Does alpha things/, 'manifest description renders');
  assert.match(text, /Internal Plugin — cannot be uninstalled/,
    'the unmanaged/built-in plugin carries the Internal notice');
  assert.equal(text.split('Internal Plugin').length - 1, 1,
    'exactly ONE internal notice — the managed plugin must not wear it');
  assert.match(text, /entry threw on load/, 'load failures are shown');
  assert.match(text, /FrameRouter/, 'restart-required is surfaced');
  assert.match(text, /operator/, 'the mount auth declaration is visible');
  assert.match(text, /Browse/, 'the Browse column exists for S3');

  let unload = find(node, (n) => n.getAttribute?.('data-action') === 'unload');
  let reload = find(node, (n) => n.getAttribute?.('data-action') === 'reload');
  let installField = find(node, (n) => String(n.className || '').includes('kikx-settings-plugins__path'));
  assert.ok(unload, 'each card exposes Unload');
  assert.ok(reload, 'each card exposes Reload');
  assert.ok(installField, 'Install from path has a field to type into');
});

test('the inventory error state renders its message instead of a blank column', async () => {
  let { buildPluginsSection } = await import('../../src/client/components/kikx-settings-plugins-section.mjs');
  let app = makeApp({
    systemSettingsPlugins: {
      inventory: [], failures: [], restartRequired: [],
      loading: false, error: 'Sign in as an operator to view plugins.', loaded: false,
    },
  });
  let built = buildPluginsSection(app);
  let node = typeof built.build === 'function' ? built.build(document) : built;
  let text = '';
  (function walk(n) {
    if (!n) return;
    if (n.nodeType === 3) text += `${n.textContent || ''} `;
    for (const c of n.childNodes || []) walk(c);
  })(node);
  assert.match(text, /Sign in as an operator to view plugins\./,
    'the operator-denied message must be readable in the view');
  assert.match(text, /Browse/, 'the layout still holds');
});

// ---------------------------------------------------------------------------
// 6. Managed classification (fail closed) + route reporting
// ---------------------------------------------------------------------------

test('isManagedPluginLocation: bundled never, configured yes, unknown fails closed', async () => {
  let { isManagedPluginLocation, BUNDLED_PLUGIN_ROOT } =
    await import('../../src/core/plugins/plugin-paths.mjs');

  assert.equal(typeof BUNDLED_PLUGIN_ROOT, 'string', 'the bundled root is exported');
  assert.ok(BUNDLED_PLUGIN_ROOT.length > 0, 'and is a real path');
  assert.equal(
    isManagedPluginLocation(`${BUNDLED_PLUGIN_ROOT}/core`, { configuredPaths: '/srv/plugs' }),
    false,
    'the bundled root is platform territory — never managed',
  );
  assert.equal(
    isManagedPluginLocation('/srv/plugs/alpha/index.mjs', { configuredPaths: '/srv/plugs' }),
    true,
    'a configured operator path is managed',
  );
  assert.equal(
    isManagedPluginLocation('/etc/elsewhere/x', { configuredPaths: '/srv/plugs' }),
    false,
    'an unknown root fails CLOSED — uninstall must never act outside known ground',
  );
  assert.equal(isManagedPluginLocation(null, { configuredPaths: '/srv/plugs' }), false);
  assert.equal(isManagedPluginLocation('', { configuredPaths: '/srv/plugs' }), false);
});

test('the inventory route reports `managed` from the shared classifier', async () => {
  // Source-gated: the behaviour contract lands with the uninstall route (the
  // phase where the gate actually decides filesystem action).
  let routes = await source('src/server/routes/plugin-routes.mjs');
  assert.match(routes, /isManagedPluginLocation/, 'the route imports the shared classifier');
  assert.match(routes, /managed:\s*isManagedPluginLocation\(/, 'every inventory record carries managed');
});

// ---------------------------------------------------------------------------
// 7. KikxSettingsPage base class
// ---------------------------------------------------------------------------

test('KikxSettingsPage: configure, app slot, exactly-once teardown', async () => {
  let { KikxSettingsPage } = await import('../../src/client/lib/settings-page.mjs');
  assert.equal(typeof KikxSettingsPage, 'function', 'the base class is exported');

  let page = document.createElement('kikx-settings-page');
  assert.ok(page instanceof KikxSettingsPage, 'the tag is defined and constructs the base');

  let returned = page.configure({ label: 'Acme Mailer', description: 'SMTP settings', section: 'Notes' });
  assert.equal(returned, page, 'configure chains (fluent)');
  assert.equal(page.label, 'Acme Mailer');
  assert.equal(page.description, 'SMTP settings');
  assert.equal(page.section, 'Notes');

  let app = makeApp();
  page.mountApp(app);
  assert.equal(page.app, app, 'the app slot is filled');
  assert.equal(page.appState, app._state, 'and the state slot points at live state');

  let runs = 0;
  page.addTeardown(() => { runs++; });
  page.disconnectedCallback();
  page.disconnectedCallback();
  assert.equal(runs, 1, 'teardown runs exactly once, however many times disconnect fires');

  let page2 = document.createElement('kikx-settings-page');
  page2.configure({});
  assert.equal(page2.section, 'General', 'an empty configure still lands on the default section');
});

// ---------------------------------------------------------------------------
// 8. The view mounts panels in their section's body
// ---------------------------------------------------------------------------

test('the settings view mounts a plugin panel inside its section tab', async () => {
  let { setClientComponents } = await import('../../src/client/state/kikx-state.mjs');
  let { resolveViewSurface } = await import('../../src/client/components/client-view-surfaces.mjs');

  let state = { systemSettingsPlugins: inventoryState().systemSettingsPlugins };
  setClientComponents([ pluginPanel('zebra', 'Zebra Mail'), pluginPanel('core-general') ], state);
  let app = makeApp();
  app._state = state;

  let view = resolveViewSurface('settings', state, app);

  const labels = [];
  const tags = [];
  (function walk(node) {
    if (!node) return;
    if (node.localName === 'aeor-tab') labels.push(node.getAttribute('label'));
    if (node.localName === 'kikx-panel-core-general') tags.push('general-panel');
    if (node.localName === 'kikx-panel-zebra') tags.push('zebra-panel');
    for (const child of node.childNodes || []) walk(child);
  })(view);

  assert.deepEqual(labels, [ 'General', 'Plugins', 'Zebra Mail' ],
    'the tab row comes from the LIVE sections model');
  assert.ok(tags.includes('general-panel'),
    'the General section mounts its panel next to the Account block');

  setClientComponents([], state);
});
