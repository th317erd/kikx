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
// Browse search (S3): keyword-scoped registry search behind the INVENTORY gate.
export const PLUGINS_SEARCH_URL = '/api/v1/plugins/search';
// Update check (S3 slice 6): one bounded batch against registry metadata.
export const PLUGINS_UPDATES_URL = '/api/v1/plugins/updates';

export function createSystemSettingsPluginsState() {
  return {
    inventory: [],
    failures: [],
    restartRequired: [],
    loading: false,
    error: null,
    loaded: false,
    // Enforcement truth from the server ('required' | 'unsafe'); the section
    // renders the unsafe banner from this (plan §5-S4 — loud by contract).
    signatureMode: null,
    // Browse column (S3 slice 5): last committed query, its results, honest
    // loading/error, a monotonic request sequence that drops stale responses,
    // and the npm spec currently installing (busy button state).
    browseQuery: '',
    browseResults: [],
    browseLoading: false,
    browseError: null,
    browseSeq: 0,
    installing: null,
    // Update chips (S3 slice 6): { [pluginName]: { latest } } — only strictly
    // newer packages appear; lookup failure leaves the map empty (no chip).
    updates: {},
    // Enable/disable (9.1.2): the server's disabled list (display tokens,
    // never raw paths) — these render as their own cards with Enable.
    disabledPlugins: [],
    // Uninstall confirm-once (9.1.1): {name, at} while armed. Store-held so
    // the armed label repaints with the section and survives rebuilds.
    uninstallConfirm: null,
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
    // Re-read the CURRENT store after the await: a Browse search (or an
    // install's busy flag) may have landed mid-flight, and an inventory
    // refresh must never wipe what the operator was browsing.
    const settled = ensureSystemSettingsPluginsState(state);
    state[SYSTEM_SETTINGS_PLUGINS_KEY] = {
      ...settled,
      inventory: Array.isArray(data.plugins) ? data.plugins : [],
      failures: Array.isArray(data.failures) ? data.failures : [],
      restartRequired: Array.isArray(data.restartRequired) ? data.restartRequired : [],
      loading: false,
      error: null,
      loaded: true,
      signatureMode: typeof data.signatureMode === 'string' ? data.signatureMode : null,
      disabledPlugins: Array.isArray(data.disabledPlugins) ? data.disabledPlugins : [],
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

// Browse search (S3 slice 5, plan 5-S3): GET /api/v1/plugins/search?q=…
// through the same injected fetcher shape as the inventory. A monotonic
// request sequence guards the write: only the NEWEST search may land its
// results — network order must never decide the UI. Failure keeps the
// previous results (stale-but-true beats blank) and shows the server
// message verbatim, same rule as the inventory. An empty query clears the
// column and invalidates any in-flight request WITHOUT fetching.
export async function searchSystemSettingsPlugins(state, fetcher, query) {
  if (!state || typeof state !== 'object' || typeof fetcher !== 'function')
    return null;

  const q = String(query ?? '').trim();
  const before = ensureSystemSettingsPluginsState(state);
  const seq = (Number.isFinite(before.browseSeq) ? before.browseSeq : 0) + 1;

  if (!q) {
    state[SYSTEM_SETTINGS_PLUGINS_KEY] = {
      ...before,
      browseQuery: '',
      browseResults: [],
      browseLoading: false,
      browseError: null,
      browseSeq: seq,
    };
    return state[SYSTEM_SETTINGS_PLUGINS_KEY];
  }

  state[SYSTEM_SETTINGS_PLUGINS_KEY] = {
    ...before,
    browseQuery: q,
    browseLoading: true,
    browseError: null,
    browseSeq: seq,
  };

  try {
    const json = await fetcher(`${PLUGINS_SEARCH_URL}?q=${encodeURIComponent(q)}`);
    const current = ensureSystemSettingsPluginsState(state);
    if (current.browseSeq !== seq)
      return current; // a newer search owns the column — this response is dropped whole
    const data = (json && typeof json === 'object' && json.data && typeof json.data === 'object')
      ? json.data
      : (json || {});
    state[SYSTEM_SETTINGS_PLUGINS_KEY] = {
      ...current,
      browseResults: Array.isArray(data.plugins) ? data.plugins : [],
      browseLoading: false,
      browseError: null,
    };
    return state[SYSTEM_SETTINGS_PLUGINS_KEY];
  } catch (error) {
    const current = ensureSystemSettingsPluginsState(state);
    if (current.browseSeq !== seq)
      return current;
    state[SYSTEM_SETTINGS_PLUGINS_KEY] = {
      ...current,
      browseLoading: false,
      browseError: messageOf(error),
    };
    return state[SYSTEM_SETTINGS_PLUGINS_KEY];
  }
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
  ensurePluginsRepaintHook(app);
  const store = state[SYSTEM_SETTINGS_PLUGINS_KEY];
  if (store.loaded || store.loading)
    return;
  void loadSystemSettingsPlugins(state, (url) => app._getJSON(url))
    .then(() => maybeLoadSystemSettingsPluginUpdates(app))
    .catch(() => {});
}

// Owner bug 4 (probe-confirmed 2026-11-11): the inventory fetch COMPLETES
// (two 200s traced) yet "Loading plugins…" never cleared — there was NO
// state→render listener for this store, so completion writes only became
// visible when some unrelated interaction happened to repaint (a tab click).
// Every store-driven surface (loading state, browse results, update chips,
// armed labels, busy flags) was frozen until then. Once-per-page subscription
// beside the visibility hook: any top-level store write requests a render.
function ensurePluginsRepaintHook(app) {
  const state = app && app._state;
  if (!state || typeof state.on !== 'function')
    return;
  if (state.__pluginsRenderHooked === true)
    return;
  state.__pluginsRenderHooked = true;
  state.on(SYSTEM_SETTINGS_PLUGINS_KEY, () => {
    app._requestRender?.('system-settings-plugins');
  });
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
      void loadSystemSettingsPlugins(state, (url) => app._getJSON(url))
        .then(() => maybeLoadSystemSettingsPluginUpdates(app))
        .catch(() => {});
    });
  } catch {
    // Non-DOM environments (specs without a document) simply skip the hook;
    // explicit loads still work.
  }
}

// --- Update system (S3 slice 6, plan 5-S3) ---------------------------------
// Only npm-sourced installs are checked (path installs have no registry to
// ask), version taken from the provenance ref (name@version — the pin that
// was actually installed). The check is deliberately SILENT on failure:
// lookup failure = no chip, never an error banner the operator must clear.
function versionFromSourceRef(ref) {
  const at = String(ref).lastIndexOf('@');
  return at > 0 ? String(ref).slice(at + 1) : null;
}

function npmInstallTargets(store) {
  const targets = [];
  for (const plugin of (Array.isArray(store.inventory) ? store.inventory : [])) {
    const source = plugin && plugin.source;
    if (!source || source.type !== 'npm' || typeof source.ref !== 'string')
      continue;
    if (!plugin || typeof plugin.name !== 'string' || !plugin.name)
      continue;
    targets.push({ name: plugin.name, version: versionFromSourceRef(source.ref) });
  }
  return targets;
}

export async function loadSystemSettingsPluginUpdates(state, requester) {
  if (!state || typeof state !== 'object' || typeof requester !== 'function')
    return null;
  const store = ensureSystemSettingsPluginsState(state);
  const targets = npmInstallTargets(store);
  if (!targets.length)
    return store.updates || {};
  try {
    const json = await requester(PLUGINS_UPDATES_URL, { packages: targets });
    const current = ensureSystemSettingsPluginsState(state);
    const data = (json && typeof json === 'object' && json.data && typeof json.data === 'object')
      ? json.data
      : (json || {});
    const updates = (data.updates && typeof data.updates === 'object') ? data.updates : {};
    state[SYSTEM_SETTINGS_PLUGINS_KEY] = { ...current, updates };
    return updates;
  } catch {
    // Silent by contract (plan 5-S3): a failed lookup leaves the previous
    // (possibly empty) chip map and touches no error slot.
    return ensureSystemSettingsPluginsState(state).updates || {};
  }
}

export function maybeLoadSystemSettingsPluginUpdates(app) {
  const state = app && app._state;
  if (!state || typeof app._postJSON !== 'function')
    return;
  const store = ensureSystemSettingsPluginsState(state);
  if (!npmInstallTargets(store).length)
    return;
  void loadSystemSettingsPluginUpdates(state, (url, body) => app._postJSON(url, body)).catch(() => {});
}
