'use strict';

// =============================================================================
// Server version, fetched once when Debug Mode is turned on (owner task 2)
// =============================================================================
// The statusbar renders plain values (statusbar-stats.mjs: the shell rebuilds
// every paint), so the version only needs to LAND IN STATE — the next render
// picks it up. The fetch is kicked from setDebugMode(true): the cell exists
// for debug sessions only, so an unconditional boot fetch would be a request
// every user never benefits from.
//
// Truth rules (pinned in spec/client/statusbar-stats-spec.mjs): no cell before
// /health answers (never "undefined"), one cell after, and one request per
// page — the flag guards re-entry across toggles.

export async function loadServerVersion(app) {
  const state = app && app._state;
  if (!state || typeof app._getJSON !== 'function')
    return null;

  if (typeof state.kikxVersion === 'string' && state.kikxVersion !== '')
    return state.kikxVersion;
  if (state.kikxVersionRequested === true)
    return null;

  state.kikxVersionRequested = true;
  try {
    const health = await app._getJSON('/health');
    // /health answers flat ({ ok, ready, version, ... }); accept a data-wrapped
    // shape too so the cell survives a future envelope change.
    const version = (health && typeof health === 'object' && typeof health.version === 'string')
      ? health.version
      : (health?.data && typeof health.data.version === 'string' ? health.data.version : null);
    if (version) {
      state.kikxVersion = version;
      app._requestRender?.('server-version');
      return version;
    }
    return null;
  } catch {
    // A failed probe leaves the cell unbuilt (spec pins "no undefined") and the
    // requested flag stays set: debug toggles do not become retry storms.
    return null;
  }
}
