'use strict';

import {
  mergePreferenceLayers,
  normalizePreferences,
  normalizePreferenceKey,
  resolvePreferencesFromSessions,
  SESSION_PREFERENCE_DEFAULTS,
  OCR_IMAGE_PROXY_PREFERENCE,
} from '../../shared/session-preferences.mjs';

// Load a session and all of its ancestors, then fold their own preferences into
// one effective map. `getSession` is an optional synchronous cache lookup (the
// FrameRuntime cache); `loadSession` is the durable fallback. Missing ancestors
// end the walk but do not discard the preferences already found.
export async function resolveEffectivePreferences(sessionID, options = {}) {
  let defaults = options.defaults || SESSION_PREFERENCE_DEFAULTS;
  let cache = options.sessionCache instanceof Map ? options.sessionCache : null;
  let getSession = typeof options.getSession === 'function' ? options.getSession : null;
  let loadSession = typeof options.loadSession === 'function' ? options.loadSession : null;
  let chain = [];
  let seen = new Set();
  let id = normalizeSessionID(sessionID);
  let complete = true;
  let missingSessionID = null;
  let cycleDetected = false;

  while (id) {
    if (seen.has(id)) {
      cycleDetected = true;
      complete = false;
      break;
    }

    seen.add(id);
    let session = await loadCachedSession(id, { cache, getSession, loadSession });
    if (!session?.id) {
      missingSessionID = id;
      complete = false;
      break;
    }

    chain.push(session);
    id = normalizeSessionID(session.parentSessionID);
  }

  let ordered = chain.slice().reverse();
  return {
    sessionID: normalizeSessionID(sessionID),
    preferences: mergePreferenceLayers(ordered.map(storedPreferences), defaults),
    ownPreferences: storedPreferences(ordered.at(-1)),
    chain: ordered.map((session) => session.id),
    complete: complete && chain.length > 0,
    missingSessionID,
    cycleDetected,
  };
}

export function effectivePreference(preferences, key, fallback = undefined) {
  let normalizedKey = normalizePreferenceKey(key);
  if (Object.hasOwn(preferences || {}, normalizedKey))
    return preferences[normalizedKey];

  return fallback;
}

async function loadCachedSession(sessionID, { cache, getSession, loadSession }) {
  if (cache?.has(sessionID))
    return cache.get(sessionID);

  let session = getSession ? getSession(sessionID) : null;
  if (!session && loadSession)
    session = await loadSession(sessionID);

  if (cache && session)
    cache.set(sessionID, session);

  return session || null;
}

function storedPreferences(session) {
  try {
    return normalizePreferences(session?.preferences);
  } catch (_error) {
    // A manually corrupted or future-shaped preference must not take down a
    // session list. Writes are validated, so this only affects legacy/bad data.
    return {};
  }
}

function normalizeSessionID(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

export {
  mergePreferenceLayers,
  normalizePreferences,
  normalizePreferenceKey,
  resolvePreferencesFromSessions,
  SESSION_PREFERENCE_DEFAULTS,
  OCR_IMAGE_PROXY_PREFERENCE,
};
