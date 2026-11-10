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
    return { data: { plugins: [ { name: 'alpha' } ], failures: [ { location: '/x', message: 'boom' } ], restartRequired: [ 'FrameRouter' ], signatureMode: 'required' } };
  });
  let store = state.systemSettingsPlugins;
  assert.equal(store.loading, false, 'loading clears');
  assert.equal(store.loaded, true, 'a successful load marks the store loaded');
  assert.equal(store.error, null);
  assert.deepEqual(store.inventory.map((p) => p.name), [ 'alpha' ]);
  assert.deepEqual(store.failures.map((f) => f.message), [ 'boom' ], 'failures carry through for the cards');
  assert.deepEqual(store.restartRequired, [ 'FrameRouter' ]);
  assert.equal(store.signatureMode, 'required',
    'the enforcement mode rides the inventory payload — the banner reads it');

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
      signatureMode: 'unsafe',
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
  assert.match(text, /Signature verification disabled — unsafe mode/,
    'an unsafe deployment is announced where the operator looks (plan §5-S4)');

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

// ---------------------------------------------------------------------------
// 9. Browse search store + column (campaign S3 slice 5, plan 5-S3)
// ---------------------------------------------------------------------------

test('browse search: hits the S3 route with encoded q, flips loading honestly', async () => {
  let { searchSystemSettingsPlugins, createSystemSettingsPluginsState } =
    await import('../../src/client/state/system-settings-plugins.mjs');

  let state = {};
  const seen = [];
  await searchSystemSettingsPlugins(state, async (url) => {
    seen.push(url);
    return { data: { query: 'echo tools', keyword: 'kikx-plugin', plugins: [ { name: 'kikx-echo', version: '1.4.0', description: 'Echoes' } ] } };
  }, 'echo tools');

  const store = state.systemSettingsPlugins;
  assert.equal(seen.length, 1, 'one fetch');
  assert.ok(seen[0].startsWith('/api/v1/plugins/search?q='), 'the S3 search route');
  assert.ok(seen[0].includes(encodeURIComponent('echo tools')), 'q rides URL-encoded');
  assert.equal(store.browseQuery, 'echo tools');
  assert.equal(store.browseLoading, false, 'loading clears');
  assert.equal(store.browseError, null);
  assert.deepEqual(store.browseResults.map((r) => r.name), [ 'kikx-echo' ], 'results unwrap from {data.plugins}');

  const defaults = createSystemSettingsPluginsState();
  assert.ok(Array.isArray(defaults.browseResults), 'browse fields live in the default state');
  assert.equal(defaults.browseLoading, false);
});

test('a stale search response never overwrites the newer one', async () => {
  let { searchSystemSettingsPlugins } = await import('../../src/client/state/system-settings-plugins.mjs');

  let state = {};
  let resolveSlow = null;
  const slow = searchSystemSettingsPlugins(state, () => new Promise((resolve) => { resolveSlow = resolve; }), 'slow query');
  const fast = searchSystemSettingsPlugins(state, async () => ({ data: { query: 'fast', plugins: [ { name: 'fast-pkg' } ] } }), 'fast');
  await fast;
  resolveSlow({ data: { query: 'slow', plugins: [ { name: 'slow-pkg' } ] } });
  await slow;

  const store = state.systemSettingsPlugins;
  assert.deepEqual(store.browseResults.map((r) => r.name), [ 'fast-pkg' ],
    'the slow response is dropped whole — network order must not decide the UI');
  assert.equal(store.browseQuery, 'fast', 'nor the committed query');
  assert.equal(store.browseLoading, false);
});

test('search failure keeps previous results and shows the server message', async () => {
  let { searchSystemSettingsPlugins } = await import('../../src/client/state/system-settings-plugins.mjs');

  let state = {};
  await searchSystemSettingsPlugins(state, async () => ({ data: { plugins: [ { name: 'kept-pkg' } ] } }), 'first');
  await searchSystemSettingsPlugins(state, async () => {
    const error = new Error('registry search failed: registry-unreachable');
    throw error;
  }, 'second');

  const store = state.systemSettingsPlugins;
  assert.equal(store.browseLoading, false, 'error clears loading');
  assert.match(store.browseError, /registry search failed/, 'the failure is readable');
  assert.deepEqual(store.browseResults.map((r) => r.name), [ 'kept-pkg' ],
    'stale-but-true beats blank, same rule as the inventory');
});

test('an empty query clears the Browse column without a fetch', async () => {
  let { searchSystemSettingsPlugins } = await import('../../src/client/state/system-settings-plugins.mjs');

  let state = {};
  await searchSystemSettingsPlugins(state, async () => ({ data: { plugins: [ { name: 'seeded' } ] } }), 'seed');
  let fetches = 0;
  await searchSystemSettingsPlugins(state, async () => { fetches++; return { data: { plugins: [] } }; }, '   ');

  const store = state.systemSettingsPlugins;
  assert.equal(fetches, 0, 'whitespace never reaches the network');
  assert.deepEqual(store.browseResults, [], 'the column clears');
  assert.equal(store.browseQuery, '');
  assert.equal(store.browseLoading, false);
});

test('an inventory refresh preserves Browse results and installing state', async () => {
  let { searchSystemSettingsPlugins, loadSystemSettingsPlugins } =
    await import('../../src/client/state/system-settings-plugins.mjs');

  let state = {};
  await searchSystemSettingsPlugins(state, async () => ({ data: { plugins: [ { name: 'browse-pkg', version: '2.0.0', description: 'x' } ] } }), 'browse');
  state.systemSettingsPlugins = { ...state.systemSettingsPlugins, installing: 'browse-pkg@2.0.0' };

  // The post-install refresh must not wipe what the operator was browsing.
  await loadSystemSettingsPlugins(state, async () => ({ data: { plugins: [ { name: 'browse-pkg', managed: true } ], failures: [], restartRequired: [], signatureMode: 'required' } }));

  const store = state.systemSettingsPlugins;
  assert.deepEqual(store.browseResults.map((r) => r.name), [ 'browse-pkg' ], 'browse results survive the refresh');
  assert.equal(store.browseQuery, 'browse');
  assert.equal(store.installing, 'browse-pkg@2.0.0');
  assert.deepEqual(store.inventory.map((p) => p.name), [ 'browse-pkg' ], 'and the inventory still updates');
  assert.equal(store.signatureMode, 'required');
});

test('Browse column: notice, search field, result cards, Installed chip, empty state', async () => {
  let { buildPluginsSection } = await import('../../src/client/components/kikx-settings-plugins-section.mjs');

  const baseBrowse = {
    browseQuery: 'echo',
    browseResults: [
      { name: 'kikx-echo', version: '1.4.0', description: 'Echoes back' },
      { name: 'kikx-other', version: '0.3.0', description: 'Something else' },
    ],
    browseLoading: false,
    browseError: null,
    browseSeq: 3,
    installing: null,
  };
  const inventory = [ { name: 'kikx-echo', location: 'kikx-echo#abc', managed: true, manifest: { version: '1.4.0' }, mounted: true, mount: { auth: 'operator' }, subscriptions: null } ];

  let app = makeApp({
    systemSettingsPlugins: {
      inventory, failures: [], restartRequired: [], loading: false, error: null, loaded: true,
      signatureMode: 'required',
      ...baseBrowse,
    },
  });
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
  const text = textOf(node);

  assert.match(text, /kikx-plugin/, 'the notice names the keyword the column searches');
  assert.match(text, /third-party|runs/, 'the notice warns that installing runs code');

  const searchField = find(node, (n) => String(n.className || '').includes('kikx-settings-plugins__search-input'));
  assert.ok(searchField, 'the search field exists');
  assert.equal(searchField?.getAttribute?.('value'), 'echo', 'the committed query is restored into the field');
  assert.ok(find(node, (n) => String(n.className || '').includes('kikx-settings-plugins__search-btn')), 'a Search button');

  assert.match(text, /Echoes back/, 'result description renders');
  assert.match(text, /kikx-other/, 'every hit renders');
  const installButtons = [];
  (function collect(n) {
    if (!n) return;
    if (n.getAttribute?.('data-action') === 'install-npm') installButtons.push(n);
    for (const c of n.childNodes || []) collect(c);
  })(node);
  assert.equal(installButtons.length, 2, 'each result offers Install');
  assert.match(text, /Installed/, 'a package already in the inventory wears the Installed chip');

  // Empty state: results gone but a committed query shows the honest message.
  let emptyApp = makeApp({
    systemSettingsPlugins: {
      inventory: [], failures: [], restartRequired: [], loading: false, error: null, loaded: true,
      ...baseBrowse, browseResults: [], browseQuery: 'zzz',
    },
  });
  let emptyNode = (() => {
    const b = buildPluginsSection(emptyApp);
    return typeof b.build === 'function' ? b.build(document) : b;
  })();
  assert.match(textOf(emptyNode), /No kikx-plugin packages found for/, 'empty state names the query');
});

// ---------------------------------------------------------------------------
// 10. Update system (campaign S3 slice 6, plan 5-S3)
// ---------------------------------------------------------------------------

test('update check derives npm-sourced packages only, and applies newer latests', async () => {
  let { loadSystemSettingsPluginUpdates, createSystemSettingsPluginsState } =
    await import('../../src/client/state/system-settings-plugins.mjs');

  let state = {
    systemSettingsPlugins: {
      ...createSystemSettingsPluginsState(),
      inventory: [
        { name: 'alpha-plugin', source: { type: 'npm', ref: 'alpha-plugin@1.0.0', registry: 'https://registry.npmjs.org' } },
        { name: 'pathy', source: { type: 'path', ref: '/srv/plugs/pathy', registry: null } },
        { name: 'unknown-src' },
      ],
      loaded: true,
    },
  };

  const calls = [];
  await loadSystemSettingsPluginUpdates(state, async (url, body) => {
    calls.push([ url, body ]);
    return { data: { updates: { 'alpha-plugin': { latest: '1.2.0' } }, checked: 1 } };
  });

  assert.equal(calls.length, 1, 'one batch request per check');
  assert.equal(calls[0][0], '/api/v1/plugins/updates', 'the S3 route');
  assert.deepEqual(calls[0][1], { packages: [ { name: 'alpha-plugin', version: '1.0.0' } ] },
    'only npm-sourced installs are checked, version taken from the provenance ref');

  const store = state.systemSettingsPlugins;
  assert.deepEqual(store.updates, { 'alpha-plugin': { latest: '1.2.0' } }, 'the chip map lands in the store');
  assert.equal(store.error, null, 'a successful check never touches the error slot');
});

test('update check failure is silent: no chip state, no error pollution, no throw', async () => {
  let { loadSystemSettingsPluginUpdates, createSystemSettingsPluginsState } =
    await import('../../src/client/state/system-settings-plugins.mjs');

  let state = {
    systemSettingsPlugins: {
      ...createSystemSettingsPluginsState(),
      inventory: [ { name: 'alpha-plugin', source: { type: 'npm', ref: 'alpha-plugin@1.0.0' } } ],
      loaded: true,
    },
  };

  await loadSystemSettingsPluginUpdates(state, async () => { throw new Error('network gone'); });

  const store = state.systemSettingsPlugins;
  assert.deepEqual(store.updates, {}, 'lookup failure = no chip, by contract');
  assert.equal(store.error, null, 'and it does not clobber the inventory error slot');
});

test('an available Update renders the chip and an action pinning the latest version', async () => {
  let { buildPluginsSection } = await import('../../src/client/components/kikx-settings-plugins-section.mjs');
  let { createSystemSettingsPluginsState } = await import('../../src/client/state/system-settings-plugins.mjs');

  const app = makeApp({
    systemSettingsPlugins: {
      ...createSystemSettingsPluginsState(),
      inventory: [
        { name: 'alpha-plugin', location: 'alpha-plugin#abc', managed: true,
          source: { type: 'npm', ref: 'alpha-plugin@1.0.0' },
          manifest: { version: '1.0.0' }, mounted: false, mount: null, subscriptions: null },
        { name: 'beta-plugin', location: 'beta-plugin#def', managed: true,
          source: { type: 'npm', ref: 'beta-plugin@2.0.0' },
          manifest: { version: '2.0.0' }, mounted: false, mount: null, subscriptions: null },
      ],
      loaded: true,
      updates: { 'alpha-plugin': { latest: '1.2.0' } },
    },
  });
  let built = buildPluginsSection(app);
  let node = typeof built.build === 'function' ? built.build(document) : built;

  let text = '';
  const buttons = [];
  (function walk(n) {
    if (!n) return;
    if (n.nodeType === 3) text += `${n.textContent || ''} `;
    if (n.getAttribute?.('data-action') === 'update-npm') buttons.push(n);
    for (const c of n.childNodes || []) walk(c);
  })(node);

  assert.match(text, /Update available/, 'the chip renders for the outdated package');
  const chips = text.split('Update available').length - 1;
  assert.equal(chips, 1, 'exactly ONE chip — beta-plugin has no update');
  assert.equal(buttons.length, 1, 'and exactly one Update action');
  assert.match(text, /Update/, 'the action is labelled');
});

test('the repaint hook subscribes once and store writes request a render (owner bug 4: eternal Loading)', async () => {
  let { maybeLoadSystemSettingsPlugins } = await import('../../src/client/state/system-settings-plugins.mjs');

  const subscribedKeys = [];
  const listeners = [];
  const renders = [];
  const state = {
    navigationStack: [],
    on: (key, fn) => { subscribedKeys.push(key); listeners.push(fn); },
    off: () => {},
  };
  const app = {
    _state: state,
    _requestRender: (reason) => renders.push(reason),
    _getJSON: async () => ({ data: { plugins: [], failures: [], restartRequired: [], signatureMode: 'required', disabledPlugins: [] } }),
  };

  maybeLoadSystemSettingsPlugins(app);
  maybeLoadSystemSettingsPlugins(app);
  assert.deepEqual(subscribedKeys, [ 'systemSettingsPlugins' ],
    'exactly ONE subscription for the store — installed once per page, never stacked');

  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(renders.length, 0, 'the subscription itself does not render — only store writes do');

  for (const fn of listeners) fn();
  assert.deepEqual(renders, [ 'system-settings-plugins' ],
    'firing the listener requests a render — THIS is what clears the loading state');
});

test('loading states carry the spinner (owner bug 5)', async () => {
  let { buildPluginsSection } = await import('../../src/client/components/kikx-settings-plugins-section.mjs');
  let { createSystemSettingsPluginsState } = await import('../../src/client/state/system-settings-plugins.mjs');

  const hasSpinner = (node) => {
    let found = false;
    (function walk(n) {
      if (!n) return;
      if (String(n.className || '').includes('kikx-spinner')) found = true;
      for (const c of n.childNodes || []) walk(c);
    })(node);
    return found;
  };
  const build = (store) => {
    const app = makeApp({ systemSettingsPlugins: { ...createSystemSettingsPluginsState(), ...store } });
    const built = buildPluginsSection(app);
    return typeof built.build === 'function' ? built.build(document) : built;
  };

  assert.equal(hasSpinner(build({ loading: true, loaded: false })), true,
    'the inventory loading state renders a spinner next to its text');
  assert.equal(hasSpinner(build({ browseLoading: true, loaded: true, inventory: [ { name: 'x' } ] })), true,
    'the Browse searching state renders a spinner too');
  assert.equal(hasSpinner(build({ loading: false, loaded: true, inventory: [] })), false,
    'terminal states carry no spinner');
});

// ---------------------------------------------------------------------------
// S5 realtime: plugin.changed → components-then-inventory refetch (9.1.3)
// ---------------------------------------------------------------------------

test('plugin.changed (S5) refetches components then inventory — the list updates in place, no shell repaint', async () => {
  let { onRuntimeEvent } = await import('../../src/client/components/kikx-runtime-events.mjs');
  let { createSystemSettingsPluginsState } = await import('../../src/client/state/system-settings-plugins.mjs');

  const calls = [];
  const app = makeApp({
    // loaded:true is the trap: S2's maybeLoad skips a loaded store, so an
    // event arriving while the view is CLOSED would otherwise leave the next
    // open stale. S5 refreshes unconditionally — components first (the 9.3.12
    // clamp needs vanished sections gone), then the inventory.
    systemSettingsPlugins: {
      ...createSystemSettingsPluginsState(),
      inventory: [ { name: 'old-one' } ],
      loaded: true,
    },
  });
  app._render = () => calls.push('render');
  app._requestRender = () => calls.push('requestRender');
  app._loadClientComponents = async () => { calls.push('components'); };
  app._getJSON = async (url) => {
    calls.push(`inv:${url}`);
    return { data: { plugins: [ { name: 'fresh-one' } ], failures: [], restartRequired: [], signatureMode: 'required', disabledPlugins: [] } };
  };

  onRuntimeEvent(app, {
    type: 'message',
    data: JSON.stringify({ type: 'plugin.changed', pluginID: 'fresh-one', action: 'install', actor: 'op@host' }),
  });
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(calls[0], 'components', 'client-component descriptors refetch FIRST (section clamp before rows repaint)');
  assert.equal(calls[1], 'inv:/api/v1/plugins', 'then the inventory');

  const store = app._state.systemSettingsPlugins;
  assert.deepEqual(store.inventory.map((p) => p.name), [ 'fresh-one' ],
    'the list updates IN PLACE in the store — the settings view repaints from state, not a shell rebuild');
  assert.ok(!calls.includes('render') && !calls.includes('requestRender'),
    'no shell repaint (plan 5-S5: targeted update)');
});

// ---------------------------------------------------------------------------
// 11. Uninstall + enable/disable (campaign 9.1.1 / 9.1.2)
// ---------------------------------------------------------------------------

test('inventory carries the disabled list into the store', async () => {
  let { loadSystemSettingsPlugins, createSystemSettingsPluginsState } =
    await import('../../src/client/state/system-settings-plugins.mjs');

  let state = {};
  await loadSystemSettingsPlugins(state, async () => ({
    data: {
      plugins: [], failures: [], restartRequired: [], signatureMode: 'required',
      disabledPlugins: [ { name: 'sleeping', location: 'sleeping#abc12345', managed: true } ],
    },
  }));

  const store = state.systemSettingsPlugins;
  assert.equal(store.disabledPlugins.length, 1, 'the disabled list unwraps');
  assert.equal(store.disabledPlugins[0].name, 'sleeping');
  assert.equal(store.disabledPlugins[0].location, 'sleeping#abc12345', 'display token, never a raw path');
  assert.deepEqual(createSystemSettingsPluginsState().disabledPlugins, [], 'empty by default');
});

test('loaded cards gain Uninstall (confirm-once) + Disable; unmanaged cards never show Uninstall', async () => {
  // Ruling per plan 9.1.1: unmanaged (built-in) = never uninstallable.
  // Disable applies to loaded plugins regardless of management — stopping
  // platform code at runtime is a legitimate operator action (its files are
  // never touched).
  let { buildPluginsSection } = await import('../../src/client/components/kikx-settings-plugins-section.mjs');
  let { createSystemSettingsPluginsState } = await import('../../src/client/state/system-settings-plugins.mjs');

  const app = makeApp({
    systemSettingsPlugins: {
      ...createSystemSettingsPluginsState(),
      inventory: [
        { name: 'managed-one', location: 'managed-one#aaa', managed: true, manifest: { version: '1.0.0' }, mounted: true, mount: { auth: 'operator' }, subscriptions: null },
        { name: 'bundled-one', location: 'bundled-one#bbb', managed: false, manifest: { version: '0.1.0' }, mounted: false, mount: null, subscriptions: null },
      ],
      disabledPlugins: [ { name: 'sleeping-one', location: 'sleeping-one#ccc', managed: true } ],
      loaded: true,
    },
  });
  let built = buildPluginsSection(app);
  let node = typeof built.build === 'function' ? built.build(document) : built;

  // Collect CARDS first, then read each card's text and actions — element
  // textContent is not modelled in mini-dom, only nodeType-3 text is.
  const cards = [];
  (function collect(n) {
    if (!n) return;
    const cls = String(n.className || '');
    if (cls === 'kikx-settings-plugin-card') cards.push(n);
    for (const c of n.childNodes || []) collect(c);
  })(node);
  assert.equal(cards.length, 3, 'two loaded cards + one disabled card');

  const textOf = (root) => {
    let out = '';
    (function walk(n) {
      if (!n) return;
      if (n.nodeType === 3) out += `${n.textContent || ''} `;
      for (const c of n.childNodes || []) walk(c);
    })(root);
    return out;
  };
  const cardFor = (name) => cards.find((card) => textOf(card).includes(name));
  const actionsOf = (card) => {
    const found = [];
    (function walk(n) {
      if (!n) return;
      const action = n.getAttribute?.('data-action');
      if (action) found.push(action);
      for (const c of n.childNodes || []) walk(c);
    })(card);
    return found;
  };

  const managed = cardFor('managed-one');
  const bundled = cardFor('bundled-one');
  const sleeping = cardFor('sleeping-one');
  assert.ok(managed && bundled && sleeping, 'all three cards render');

  assert.ok(actionsOf(managed).includes('uninstall'), 'the managed loaded card offers Uninstall');
  assert.ok(actionsOf(managed).includes('disable'), 'and Disable');
  assert.ok(!actionsOf(bundled).includes('uninstall'),
    'the built-in NEVER shows Uninstall (plan 9.1.1: built-ins never)');
  assert.ok(actionsOf(bundled).includes('disable'),
    'Disable still applies to built-ins — it never touches files');
  assert.ok(actionsOf(sleeping).includes('enable'), 'the disabled card offers Enable');
  assert.ok(actionsOf(sleeping).includes('uninstall'), 'and Uninstall (managed disabled entry)');

  const text = textOf(node);
  assert.match(text, /Disabled/, 'the disabled card wears the Disabled chip');
  assert.match(text, /sleeping-one/, 'and names the disabled plugin');
});

test('confirm-once: first click arms, second within 5s fires, then re-arms; staleness and other names re-arm', async () => {
  let { nextUninstallAction } = await import('../../src/client/components/kikx-settings-plugins-section.mjs');

  const store = { uninstallConfirm: null };
  const t0 = 1_000_000;
  assert.equal(nextUninstallAction(store, 'alpha', t0), 'arm', 'first contact arms');

  const armed = { uninstallConfirm: { name: 'alpha', at: t0 } };
  assert.equal(nextUninstallAction(armed, 'alpha', t0 + 1_000), 'fire', 'a second click in the window fires');
  assert.equal(nextUninstallAction(armed, 'alpha', t0 + 5_001), 'arm', 'past the 5s window it re-arms — no surprises later');
  assert.equal(nextUninstallAction(armed, 'beta', t0 + 10), 'arm', 'a DIFFERENT name re-arms rather than firing alpha\'s confirmation');
});

test('actions wire the right endpoints, and refresh refetches client components', async () => {
  let { buildPluginsSection } = await import('../../src/client/components/kikx-settings-plugins-section.mjs');
  let { createSystemSettingsPluginsState } = await import('../../src/client/state/system-settings-plugins.mjs');

  const componentCalls = [];
  const app = makeApp({
    systemSettingsPlugins: {
      ...createSystemSettingsPluginsState(),
      inventory: [ { name: 'managed-one', location: 'm#1', managed: true, manifest: { version: '1.0.0' }, mounted: false, mount: null, subscriptions: null } ],
      loaded: true,
    },
  });
  app._loadClientComponents = async () => { componentCalls.push('components'); };
  app._getJSON = async (url) => { componentCalls.push(`inv:${url}`); return { data: { plugins: [], failures: [], restartRequired: [], signatureMode: 'required', disabledPlugins: [] } }; };

  let built = buildPluginsSection(app);
  let node = typeof built.build === 'function' ? built.build(document) : built;
  let uninstallBtn = null;
  let disableBtn = null;
  (function walk(n) {
    if (!n) return;
    if (n.getAttribute?.('data-action') === 'uninstall') uninstallBtn = n;
    if (n.getAttribute?.('data-action') === 'disable') disableBtn = n;
    for (const c of n.childNodes || []) walk(c);
  })(node);
  assert.ok(uninstallBtn, 'the Uninstall control exists');
  assert.ok(disableBtn, 'the Disable control exists');

  // First click: ARMS (endpoint must NOT be called yet).
  uninstallBtn.dispatchEvent(new CustomEvent('click', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const postsAfterArm = app._posts.filter(([ url ]) => url === '/api/v1/plugins/uninstall');
  assert.equal(postsAfterArm.length, 0, 'the FIRST click only arms — confirm-once means no accidental deletion');
  assert.equal(app._state.systemSettingsPlugins.uninstallConfirm?.name, 'managed-one',
    'the armed state lives in the STORE (repaints the label, survives rebuilds)');

  // Second click inside the window FIRES.
  const rebuilt = buildPluginsSection(app);
  const rebuiltNode = typeof rebuilt.build === 'function' ? rebuilt.build(document) : rebuilt;
  let armedLabel = null;
  (function walk(n) {
    if (!n) return;
    if (n.getAttribute?.('data-action') === 'uninstall') armedLabel = n;
    for (const c of n.childNodes || []) walk(c);
  })(rebuiltNode);
  assert.equal(String(armedLabel?.textContent || '').trim(), 'Confirm Uninstall',
    'the rebuilt button wears the armed label');
  armedLabel.dispatchEvent(new CustomEvent('click', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const fired = app._posts.filter(([ url ]) => url === '/api/v1/plugins/uninstall');
  assert.equal(fired.length, 1, 'the second click uninstalls');
  assert.deepEqual(fired[0][1], { name: 'managed-one' });

  // Disable goes straight to the endpoint (no confirm: reversible).
  disableBtn.dispatchEvent(new CustomEvent('click', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const disables = app._posts.filter(([ url ]) => url === '/api/v1/plugins/set-enabled');
  assert.equal(disables.length, 1, 'Disable posts immediately — it is reversible');
  assert.deepEqual(disables[0][1], { name: 'managed-one', enabled: false });

  // Refresh chain: components refetch BEFORE the inventory (a section that
  // vanished must not be selected while old rows still render).
  componentCalls.length = 0;
  const { refreshPluginsData } = await import('../../src/client/components/kikx-settings-plugins-section.mjs');
  await refreshPluginsData(app);
  assert.equal(componentCalls[0], 'components', 'client components refetch FIRST');
  assert.ok(componentCalls.some((entry) => entry.startsWith('inv:')), 'then the inventory');
});
