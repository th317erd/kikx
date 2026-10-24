'use strict';

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
