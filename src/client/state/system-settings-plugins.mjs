'use strict';

// =============================================================================
// System Settings → Plugins: the inventory store (campaign S2, plan §5-S2)
// =============================================================================
// A leaf state module, deliberately fetcher-injected so the contract is testable
// without a server: `{ inventory, failures, restartRequired, loading, error,
// loaded }`.
//
// Truth rules pinned by spec/client/system-settings-plugins-spec.mjs:
//   - every call flips `loading` on and off honestly (no spinner-free fetches);
//   - the response unwraps `{ data: { plugins, failures, restartRequired } }`;
//   - an operator 401/403 surfaces the SERVER message (plus its hint) verbatim
//     — one honest sentence beats a generic "failed", and this view's whole
//     permission story is that sentence;
//   - an error NEVER wipes a loaded inventory (stale-but-true beats blank);
//   - the store hydrates when the view opens, and re-fetches on
//     visibilitychange→visible ("realtime-light"); cross-client realtime is S5.

export const SYSTEM_SETTINGS_PLUGINS_KEY = 'systemSettingsPlugins';
export const PLUGINS_INVENTORY_URL = '/api/v1/plugins';

export function createSystemSettingsPluginsState() {
  return {
    inventory: [],
    failures: [],
    restartRequired: [],
    loading: false,
    error: null,
    loaded: false,
  };
}

export function ensureSystemSettingsPluginsState(state) {
  if (!state || typeof state !== 'object')
    return createSystemSettingsPluginsState();
  if (!state[SYSTEM_SETTINGS_PLUGINS_KEY] || typeof state[SYSTEM_SETTINGS_PLUGINS_KEY] !== 'object')
    state[SYSTEM_SETTINGS_PLUGINS_KEY] = createSystemSettingsPluginsState();
  return state[SYSTEM_SETTINGS_PLUGINS_KEY];
}

function messageOf(error) {
  const base = error && error.message ? String(error.message) : 'plugin inventory unavailable';
  const hint = error && error.hint ? String(error.hint) : '';
  return hint && !base.includes(hint) ? `${base} — ${hint}` : base;
}

export async function loadSystemSettingsPlugins(state, fetcher) {
  if (!state || typeof state !== 'object' || typeof fetcher !== 'function')
    return null;

  const before = ensureSystemSettingsPluginsState(state);
  // Whole-object replacement: ReactiveState notifies on top-level assignment
  // only, and a store swap is what repaints the section.
  state[SYSTEM_SETTINGS_PLUGINS_KEY] = { ...before, loading: true, error: null };

  try {
    const json = await fetcher(PLUGINS_INVENTORY_URL);
    const data = (json && typeof json === 'object' && json.data && typeof json.data === 'object')
      ? json.data
      : (json || {});
    state[SYSTEM_SETTINGS_PLUGINS_KEY] = {
      inventory: Array.isArray(data.plugins) ? data.plugins : [],
      failures: Array.isArray(data.failures) ? data.failures : [],
      restartRequired: Array.isArray(data.restartRequired) ? data.restartRequired : [],
      loading: false,
      error: null,
      loaded: true,
    };
  } catch (error) {
    const current = ensureSystemSettingsPluginsState(state);
    state[SYSTEM_SETTINGS_PLUGINS_KEY] = {
      ...current,
      loading: false,
      error: messageOf(error),
      // Keep whatever was previously loaded — the cards stay readable while
      // the denial/failure message shows above them.
      loaded: current.loaded === true,
    };
  }
  return state[SYSTEM_SETTINGS_PLUGINS_KEY];
}

// Called when the System Settings view opens. First open kicks the fetch;
// the visibility hook installs exactly once per page (the listener closure
// holds `app`, which lives as long as the page does).
export function maybeLoadSystemSettingsPlugins(app) {
  const state = app && app._state;
  if (!state || typeof app._getJSON !== 'function')
    return;
  ensureSystemSettingsPluginsState(state);
  ensureInventoryVisibilityHook(app);
  const store = state[SYSTEM_SETTINGS_PLUGINS_KEY];
  if (store.loaded || store.loading)
    return;
  void loadSystemSettingsPlugins(state, (url) => app._getJSON(url)).catch(() => {});
}

function ensureInventoryVisibilityHook(app) {
  const state = app._state;
  if (state.__pluginsInventoryVisibilityHooked === true)
    return;
  state.__pluginsInventoryVisibilityHooked = true;
  try {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible')
        return;
      const store = state[SYSTEM_SETTINGS_PLUGINS_KEY];
      if (!store || store.loaded !== true)
        return;
      void loadSystemSettingsPlugins(state, (url) => app._getJSON(url)).catch(() => {});
    });
  } catch {
    // Non-DOM environments (specs without a document) simply skip the hook;
    // explicit loads still work.
  }
}
