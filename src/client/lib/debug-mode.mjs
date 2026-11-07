'use strict';

import { loadServerVersion } from '../state/server-version.mjs';
import { setActiveScrollTelemetry, startScrollTelemetry } from './scroll-telemetry.mjs';

export const DEBUG_MODE_STORAGE_KEY = 'kikx.debug';

export function readDebugMode() {
  let override = debugQueryOverride();
  if (override != null) {
    writeDebugMode(override);
    return override;
  }

  try {
    return globalThis.localStorage?.getItem(DEBUG_MODE_STORAGE_KEY) === '1';
  } catch (_error) {
    return false;
  }
}

export function writeDebugMode(enabled) {
  try {
    if (enabled)
      globalThis.localStorage?.setItem(DEBUG_MODE_STORAGE_KEY, '1');
    else
      globalThis.localStorage?.removeItem(DEBUG_MODE_STORAGE_KEY);
  } catch (_error) {}
}

export function setDebugMode(app, enabled) {
  let next = enabled === true;
  writeDebugMode(next);
  if (app?._state)
    app._state.debugMode = next;
  app?.classList?.toggle?.('kikx-debug-mode', next);
  // The statusbar version cell belongs to debug sessions only (owner task,
  // 2026-11-07), so the one fetch is kicked HERE rather than at boot.
  if (next)
    void loadServerVersion(app);
  // Scroll telemetry streams to the server ONLY while debug mode is on — the
  // owner's real-time scrollview debugging channel (owner ask, 2026-11-07).
  if (next)
    startScrollTelemetry(app);
  else
    setActiveScrollTelemetry(app, false);
  return next;
}

export function toggleDebugMode(app) {
  return setDebugMode(app, app?._state?.debugMode !== true);
}

function debugQueryOverride() {
  try {
    let value = new URLSearchParams(globalThis.location?.search || '').get('debug');
    if (value === '1' || value === 'true')
      return true;
    if (value === '0' || value === 'false')
      return false;
  } catch (_error) {}
  return null;
}
