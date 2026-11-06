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
} from '../state/system-settings-plugins.mjs';

const { button, div, h3, p, span, input } = elements;

const INTERNAL_NOTICE = 'Internal Plugin — cannot be uninstalled';

export function buildPluginsSection(app) {
  const state = (app && app._state) || {};
  const store = ensureSystemSettingsPluginsState(state);

  return div.class('kikx-settings-plugins')(
    div.class('kikx-settings-plugins__column kikx-settings-plugins__installed')(
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
      store.restartRequired.length > 0
        ? p.class('kikx-settings-plugins__restart')(`Restart required for: ${store.restartRequired.join(', ')}`)
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
      p('Registry search arrives with the NPM phase.'),
    ),
  );
}

function buildPluginCard(app, plugin, store) {
  const manifest = (plugin && plugin.manifest && typeof plugin.manifest === 'object') ? plugin.manifest : {};
  const location = plugin && typeof plugin.location === 'string' ? plugin.location : '';
  const cardFailures = (store.failures || []).filter((failure) => failure && location && failure.location === location);
  const mount = plugin && plugin.mount && typeof plugin.mount === 'object' ? plugin.mount : null;

  return div.class('kikx-settings-plugin-card')(
    div.class('kikx-settings-plugin-card__head')(
      span.class('kikx-settings-plugin-card__name')(plugin && plugin.name ? String(plugin.name) : '(unnamed)'),
      manifest.version
        ? span.class('kikx-settings-plugin-card__version')(String(manifest.version))
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
    ),
  );
}

function refresh(app) {
  const state = app && app._state;
  if (!state || typeof app._getJSON !== 'function')
    return Promise.resolve();
  return loadSystemSettingsPlugins(state, (url) => app._getJSON(url)).catch(() => {});
}

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
