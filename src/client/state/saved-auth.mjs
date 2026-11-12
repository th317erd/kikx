'use strict';

// Boot-time auth reader, extracted from kikx-state.mjs (2026-11-11) to stay
// under the 800-line hard cap: the durable/legacy/shared token candidates
// plus the migration-on-read write. kikx-state RE-EXPORTS these three names
// so kikx-json-api and the auth-persistence specs keep importing unchanged.

export const AUTH_STORAGE_KEY = 'kikx.auth.session';
export const AUTH_SHARED_STORAGE_KEY = 'kikx.auth.shared';

// Boot-time auth read.
//
// Owner decision (2026-11-05): "tokens aren't attached to a _browser
// session_, and instead just expire naturally (after 30 days)". The durable
// home is localStorage under the same key — closing the browser must not sign
// you out. sessionStorage survives only as a LEGACY candidate (pre-change
// tabs, and the specs that still seed it directly), and the shared rotation
// key stays a candidate so one tab's rotation supersedes a stale copy
// anywhere. The previous rule — "never use localStorage to authenticate a tab
// that has no session at all" — is deliberately reversed: a fresh tab IS a
// returning user now, and the server's 30-day refresh-token window is the
// only expiry that matters (auth-service default refreshTTLSeconds = 2592000,
// sliding on each rotation).
//
// Exported for the persistence specs: it is a pure reader over the injected
// globals plus one migration write.
export function loadSavedAuth() {
  let durable = readStoredAuth(globalThis.localStorage, AUTH_STORAGE_KEY);
  let legacy = readStoredAuth(globalThis.sessionStorage, AUTH_STORAGE_KEY);
  let shared = readStoredAuth(globalThis.localStorage, AUTH_SHARED_STORAGE_KEY);

  let best = durable?.token ? durable : null;
  for (let candidate of [ legacy, shared ]) {
    if (candidate?.token && (!best || authExpiry(candidate) > authExpiry(best)))
      best = candidate;
  }

  // Migrate on read: whichever candidate won, the durable slot must hold it,
  // so the next cold start never depends on sessionStorage or the shared key
  // again. `best === durable` (the common case) is the same object, so this
  // writes nothing.
  if (best && best !== durable) {
    try {
      globalThis.localStorage?.setItem(AUTH_STORAGE_KEY, JSON.stringify(best));
    } catch (_error) {}
  }

  return best || {};
}

function readStoredAuth(storage, key) {
  try {
    return JSON.parse(storage?.getItem(key) || '{}') || {};
  } catch (_error) {
    return {};
  }
}

function authExpiry(auth) {
  let value = Number(auth?.expires_at);
  return Number.isFinite(value) ? value : 0;
}

