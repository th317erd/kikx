'use strict';

// =============================================================================
// Installed Plugins section — Xenocept-parity cards (campaign S2, plan §5-S2)
// =============================================================================
// Left column: Installed Plugins cards from the inventory store; right column:
// Browse — a stated placeholder until the registry phase (S3) fills it, because
// an empty column that says nothing reads as a bug.
//
// Card contents per plan: name, manifest.version, description, mounts and
// subscriptions summary, `Internal Plugin — cannot be uninstalled` when the
// record is NOT managed (bundled platform code; classification is the server's
// `managed` flag, computed fail-closed), and load failures for that location.
// Actions in this phase: Unload, Reload, Install from path (absolute path,
// honoring the 403 config-gate hint). Uninstall and the enable/disable toggle
// arrive with their own phase (plan §9.5 order).
//
// Realtime-light: every successful action re-fetches the inventory through the
// same store loader, so the cards always show what the server just said.

import { elements } from '../lib/aeor-ui.mjs';
import {
  ensureSystemSettingsPluginsState,
  loadSystemSettingsPlugins,
  searchSystemSettingsPlugins,
  maybeLoadSystemSettingsPluginUpdates,
} from '../state/system-settings-plugins.mjs';

const { button, div, h3, p, span, input } = elements;

const INTERNAL_NOTICE = 'Internal Plugin — cannot be uninstalled';

export function buildPluginsSection(app) {
  const state = (app && app._state) || {};
  const store = ensureSystemSettingsPluginsState(state);

  return div.class('kikx-settings-plugins')(
    div.class('kikx-settings-plugins__column kikx-settings-plugins__installed')(
      // Loud by contract (plan §5-S4): an unsafe deployment says so where an
      // operator would look, not only in a startup log line.
      store.signatureMode === 'unsafe'
        ? p.class('kikx-settings-plugins__banner')('Signature verification disabled — unsafe mode')
        : null,
      h3('Installed Plugins'),
      store.error
        ? p.class('kikx-settings-plugins__error')(store.error)
        : null,
      store.loading && !store.loaded
        ? p.class('kikx-settings-plugins__loading')('Loading plugins…')
        : null,
      store.inventory.length > 0
        ? div.class('kikx-settings-plugins__cards')(
          ...store.inventory.map((plugin) => buildPluginCard(app, plugin, store)),
        )
        : (!store.loading && !store.error
          ? p.class('kikx-settings-plugins__empty')('No plugins are loaded.')
          : null),
      store.failures.length > 0
        ? div.class('kikx-settings-plugins__failures')(
          h3('Load failures'),
          ...store.failures.map((failure) => p.class('kikx-settings-plugins__failure')(
            `${failure && failure.location ? failure.location : 'plugin'}: ${failure && failure.message ? failure.message : 'load failed'}`,
          )),
        )
        : null,
      (store.restartRequired || []).length > 0
        ? p.class('kikx-settings-plugins__restart')(`Restart required for: ${store.restartRequired.join(', ')}`)
        : null,
      // Disabled plugins (9.1.2): their own cards — Enable reverses the
      // flag, Uninstall follows the same confirm-once + managed rules.
      (store.disabledPlugins || []).length > 0
        ? div.class('kikx-settings-plugins__cards')(
          h3('Disabled'),
          ...store.disabledPlugins.map((entry) => buildDisabledCard(app, entry, store)),
        )
        : null,
      div.class('kikx-settings-plugins__install')(
        // NOTE: the chain must be FINALIZED with an empty child call — real
        // elements.js rejects an unfinalized builder as a child (the Node spec
        // stub accepts it, so only the browser lane catches this).
        input.type('text')
          .class('kikx-settings-plugins__path')
          .placeholder('/absolute/path/to/plugin')(),
        button.type('button')
          .class('kikx-settings-plugins__install-btn')
          .onClick(() => runInstallFromPath(app))('Install from path'),
      ),
    ),
    div.class('kikx-settings-plugins__column kikx-settings-plugins__browse')(
      h3('Browse'),
      // Notice mirrors Xenocept's Browse posture: name the keyword honestly
      // and say the dangerous part out loud — installing runs third-party code.
      p.class('kikx-settings-plugins__notice')(
        'Registry packages tagged \'kikx-plugin\'. Installing runs third-party code — review what you install.',
      ),
      div.class('kikx-settings-plugins__search')(
        // The draft lives on the APP (not _state): keystrokes must never
        // trigger a reactive rebuild that would destroy the focused input,
        // and the value must survive rebuilds driven by inventory refreshes.
        input.type('text')
          .class('kikx-settings-plugins__search-input')
          .placeholder('search kikx-plugin packages')
          .value(typeof app.__pluginsBrowseDraft === 'string' ? app.__pluginsBrowseDraft : (store.browseQuery || ''))
          .onInput((event) => {
            try { app.__pluginsBrowseDraft = String(event?.target?.value ?? ''); } catch { /* non-DOM event */ }
          })
          .onKeydown((event) => {
            if (event?.key === 'Enter') void runBrowseSearch(app);
          })(),
        button.type('button')
          .class('kikx-settings-plugins__search-btn')
          .onClick(() => runBrowseSearch(app))('Search'),
      ),
      store.browseError
        ? p.class('kikx-settings-plugins__browse-error')(store.browseError)
        : null,
      store.browseLoading
        ? p.class('kikx-settings-plugins__browse-loading')('Searching…')
        : null,
      (store.browseResults || []).length > 0
        ? div.class('kikx-settings-plugins__results')(
          ...store.browseResults.map((result) => buildBrowseCard(app, result, store)),
        )
        : (!store.browseLoading && store.browseQuery
          ? p.class('kikx-settings-plugins__browse-empty')(
            `No kikx-plugin packages found for “${store.browseQuery}”.`,
          )
          : null),
    ),
  );
}

function buildBrowseCard(app, result, store) {
  const name = result && typeof result.name === 'string' ? result.name : '';
  const version = result && typeof result.version === 'string' ? result.version : null;
  const description = result && typeof result.description === 'string' ? result.description : null;
  const inventory = Array.isArray(store.inventory) ? store.inventory : [];
  const installed = Boolean(name) && inventory.some((plugin) => plugin && plugin.name === name);
  const busy = Boolean(store.installing);
  const mine = Boolean(store.installing) && Boolean(name) && store.installing === (version ? `${name}@${version}` : name);

  return div.class('kikx-settings-plugin-card')(
    div.class('kikx-settings-plugin-card__head')(
      span.class('kikx-settings-plugin-card__name')(name || '(unnamed)'),
      version
        ? span.class('kikx-settings-plugin-card__version')(version)
        : null,
      installed
        ? span.class('kikx-settings-plugin-card__badge kikx-settings-plugin-card__badge--installed')('Installed')
        : null,
    ),
    description
      ? p.class('kikx-settings-plugin-card__desc')(description)
      : null,
    div.class('kikx-settings-plugin-card__actions')(
      button.type('button')['data-action']('install-npm')
        .class('kikx-browse-card__install')
        .disabled(installed || busy)
        .onClick(() => runInstallFromNpm(app, { name, version }))(
        installed ? 'Installed' : (mine ? 'Installing…' : 'Install'),
      ),
    ),
  );
}

function buildPluginCard(app, plugin, store) {
  const manifest = (plugin && plugin.manifest && typeof plugin.manifest === 'object') ? plugin.manifest : {};
  const location = plugin && typeof plugin.location === 'string' ? plugin.location : '';
  const cardFailures = (store.failures || []).filter((failure) => failure && location && failure.location === location);
  const mount = plugin && plugin.mount && typeof plugin.mount === 'object' ? plugin.mount : null;
  // Update chip (S3 slice 6): the store only ever holds strictly-newer
  // latests, so presence alone decides both the chip and the Update action.
  const update = plugin && plugin.name && store.updates && store.updates[plugin.name]
    && typeof store.updates[plugin.name] === 'object'
    ? store.updates[plugin.name]
    : null;
  const busy = Boolean(store.installing);

  return div.class('kikx-settings-plugin-card')(
    div.class('kikx-settings-plugin-card__head')(
      span.class('kikx-settings-plugin-card__name')(plugin && plugin.name ? String(plugin.name) : '(unnamed)'),
      manifest.version
        ? span.class('kikx-settings-plugin-card__version')(String(manifest.version))
        : null,
      update && typeof update.latest === 'string'
        ? span.class('kikx-settings-plugin-card__badge kikx-settings-plugin-card__badge--update')('Update available')
        : null,
      plugin && plugin.managed === false
        ? span.class('kikx-settings-plugin-card__badge kikx-settings-plugin-card__badge--internal')(INTERNAL_NOTICE)
        : null,
    ),
    manifest.description
      ? p.class('kikx-settings-plugin-card__desc')(String(manifest.description))
      : null,
    p.class('kikx-settings-plugin-card__mounts')(
      plugin && plugin.mounted
        ? `Mounted: yes${mount && mount.auth ? ` (${mount.auth})` : ''}${plugin.subscriptions ? ' · subscribed' : ''}`
        : `Mounted: no${plugin && plugin.subscriptions ? ' · subscribed' : ''}`,
    ),
    cardFailures.length > 0
      ? div.class('kikx-settings-plugin-card__failures')(
        ...cardFailures.map((failure) => p.class('kikx-settings-plugin-card__failure')(
          String(failure.message || 'load failed'),
        )),
      )
      : null,
    div.class('kikx-settings-plugin-card__actions')(
      button.type('button')['data-action']('unload')
        .class('kikx-settings-plugin-card__action')
        .onClick(() => runPluginAction(app, 'unload', plugin))('Unload'),
      button.type('button')['data-action']('reload')
        .class('kikx-settings-plugin-card__action')
        .onClick(() => runPluginAction(app, 'reload', plugin))('Reload'),
      update && typeof update.latest === 'string'
        ? button.type('button')['data-action']('update-npm')
          .class('kikx-settings-plugin-card__action')
          .disabled(busy)
          // Reuses the EXACT install pipeline with the RESOLVED version —
          // the plan's wording, and runInstallFromNpm already pins it.
          .onClick(() => runInstallFromNpm(app, { name: plugin.name, version: update.latest }))('Update')
        : null,
      button.type('button')['data-action']('disable')
        .class('kikx-settings-plugin-card__action')
        .disabled(busy)
        // Reversible — no confirm needed. Files are NEVER touched by disable,
        // so it applies to built-ins too (stopping platform code is legal;
        // DELETING it is what management governs).
        .onClick(() => runSetEnabled(app, plugin, false))('Disable'),
      plugin && plugin.managed !== false
        ? button.type('button')['data-action']('uninstall')
          .class('kikx-settings-plugin-card__action')
          .disabled(busy)
          // Confirm-once (9.1.1 approved): first click arms, second fires.
          .onClick(() => runUninstall(app, plugin))(
            isUninstallArmed(store, plugin && plugin.name) ? 'Confirm Uninstall' : 'Uninstall',
          )
        : null,
    ),
  );
}

function refresh(app) {
  const state = app && app._state;
  if (!state || typeof app._getJSON !== 'function')
    return Promise.resolve();
  // Exported as refreshPluginsData for specs. Component descriptors refetch
  // BEFORE the inventory: a section whose plugin just went away must stop
  // being selectable before (or as) its rows repaint — the 9.3.12 clamp.
  return (async () => {
    try {
      if (typeof app._loadClientComponents === 'function')
        await app._loadClientComponents();
    } catch { /* best-effort: the inventory refresh below still runs */ }
    try {
      await loadSystemSettingsPlugins(state, (url) => app._getJSON(url));
    } catch { /* the store records its own errors */ }
    // Every inventory refresh re-derives the update chips: after installing
    // an update the fresh latest equals the new pin and the chip clears.
    maybeLoadSystemSettingsPluginUpdates(app);
  })();
}
export { refresh as refreshPluginsData };

function reportError(app, error) {
  const state = app && app._state;
  if (!state)
    return;
  const store = ensureSystemSettingsPluginsState(state);
  const base = error && error.message ? String(error.message) : 'plugin action failed';
  const hint = error && error.hint ? String(error.hint) : '';
  // Whole-store swap: ReactiveState notifies on top-level assignment only,
  // so a nested `store.error = …` alone would never repaint the section.
  state.systemSettingsPlugins = {
    ...store,
    error: hint && !base.includes(hint) ? `${base} — ${hint}` : base,
  };
}

async function runPluginAction(app, action, plugin) {
  const name = plugin && plugin.name ? String(plugin.name) : '';
  if (!name || typeof app?._postJSON !== 'function')
    return;
  try {
    await app._postJSON(`/api/v1/plugins/${action}`, { name });
  } catch (error) {
    reportError(app, error);
  }
  await refresh(app);
}

async function runInstallFromPath(app) {
  if (typeof app?._postJSON !== 'function')
    return;
  const field = app.querySelector && app.querySelector('.kikx-settings-plugins__path');
  const path = field && typeof field.value === 'string' ? field.value.trim() : '';
  if (!path) {
    reportError(app, new Error('enter an absolute plugin path to install'));
    return;
  }
  if (!path.startsWith('/')) {
    reportError(app, new Error('install path must be absolute'));
    return;
  }
  try {
    await app._postJSON('/api/v1/plugins/install', { path });
    if (field)
      field.value = '';
  } catch (error) {
    reportError(app, error);
  }
  await refresh(app);
}

async function runBrowseSearch(app) {
  const state = app && app._state;
  if (!state || typeof app._getJSON !== 'function')
    return;
  const field = app.querySelector && app.querySelector('.kikx-settings-plugins__search-input');
  const draft = field && typeof field.value === 'string'
    ? field.value
    : (typeof app.__pluginsBrowseDraft === 'string' ? app.__pluginsBrowseDraft : '');
  if (!draft.trim())
    app.__pluginsBrowseDraft = '';
  // The store owns the fetch, the stale-sequence guard and the error copy.
  await searchSystemSettingsPlugins(state, (url) => app._getJSON(url), draft);
}

async function runInstallFromNpm(app, result) {
  const state = app && app._state;
  if (!state || typeof app?._postJSON !== 'function')
    return;
  const name = result && typeof result.name === 'string' ? result.name : '';
  if (!name)
    return;
  // Pin the version the operator SAW — reproducible installs, and the same
  // shape slice 6's Update action will reuse with the resolved version.
  const spec = result.version ? `${name}@${result.version}` : name;
  const store = ensureSystemSettingsPluginsState(state);
  if (store.installing)
    return; // one install at a time — the busy flag is the whole guard
  state.systemSettingsPlugins = { ...store, installing: spec, error: null };
  try {
    await app._postJSON('/api/v1/plugins/install', { npm: spec });
  } catch (error) {
    reportError(app, error);
  }
  const current = ensureSystemSettingsPluginsState(state);
  state.systemSettingsPlugins = { ...current, installing: null };
  await refresh(app);
}

// --- Uninstall + enable/disable (plan 9.1.1 / 9.1.2) -----------------------

export const UNINSTALL_CONFIRM_WINDOW_MS = 5000;

// Confirm-once (9.1.1 approved): 'arm' on first contact, 'fire' only for the
// SAME name inside the window — expiry and name changes re-arm, so a stale
// confirmation can never delete the wrong thing later.
export function nextUninstallAction(store, name, now = Date.now()) {
  const confirm = store && store.uninstallConfirm;
  const armed = Boolean(confirm)
    && confirm.name === name
    && typeof confirm.at === 'number'
    && (now - confirm.at) <= UNINSTALL_CONFIRM_WINDOW_MS;
  return armed ? 'fire' : 'arm';
}

function isUninstallArmed(store, name) {
  return Boolean(store && store.uninstallConfirm && store.uninstallConfirm.name === name
    && typeof name === 'string' && name);
}

export async function runUninstall(app, plugin) {
  const state = app && app._state;
  if (!state || typeof app?._postJSON !== 'function')
    return;
  const name = plugin && typeof plugin.name === 'string' ? plugin.name : '';
  if (!name)
    return;
  const store = ensureSystemSettingsPluginsState(state);
  if (nextUninstallAction(store, name) === 'arm') {
    // Whole-store swap: the repaint is what turns the button into
    // "Confirm Uninstall" — the armed state must never live only in the node.
    state.systemSettingsPlugins = { ...store, uninstallConfirm: { name, at: Date.now() } };
    return;
  }
  state.systemSettingsPlugins = { ...ensureSystemSettingsPluginsState(state), uninstallConfirm: null };
  try {
    await app._postJSON('/api/v1/plugins/uninstall', { name });
  } catch (error) {
    reportError(app, error);
  }
  await refresh(app);
}

export async function runSetEnabled(app, plugin, enabled) {
  const state = app && app._state;
  if (!state || typeof app?._postJSON !== 'function')
    return;
  const name = plugin && typeof plugin.name === 'string' ? plugin.name : '';
  if (!name || typeof enabled !== 'boolean')
    return;
  try {
    await app._postJSON('/api/v1/plugins/set-enabled', { name, enabled });
  } catch (error) {
    reportError(app, error);
  }
  await refresh(app);
}

function buildDisabledCard(app, entry, store) {
  const name = entry && typeof entry.name === 'string' ? entry.name : '';
  const location = entry && typeof entry.location === 'string' ? entry.location : '';
  const busy = Boolean(store.installing);
  return div.class('kikx-settings-plugin-card')(
    div.class('kikx-settings-plugin-card__head')(
      span.class('kikx-settings-plugin-card__name')(name || '(unnamed)'),
      location
        ? span.class('kikx-settings-plugin-card__version')(location)
        : null,
      span.class('kikx-settings-plugin-card__badge kikx-settings-plugin-card__badge--disabled')('Disabled'),
    ),
    div.class('kikx-settings-plugin-card__actions')(
      button.type('button')['data-action']('enable')
        .class('kikx-settings-plugin-card__action')
        .disabled(busy)
        .onClick(() => runSetEnabled(app, entry, true))('Enable'),
      entry && entry.managed !== false
        ? button.type('button')['data-action']('uninstall')
          .class('kikx-settings-plugin-card__action')
          .disabled(busy)
          .onClick(() => runUninstall(app, entry))(
            isUninstallArmed(store, name) ? 'Confirm Uninstall' : 'Uninstall',
          )
        : null,
    ),
  );
}
