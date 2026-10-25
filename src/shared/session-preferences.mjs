'use strict';

// Browser-safe session preference schema and cascading rules.
//
// Preferences are plain key/value pairs stored on a session manifest:
//
//   session.preferences = { "ocr.image_proxy": false, "ui.density": "compact" }
//
// A session's effective preferences are the built-in defaults, then every
// ancestor's own preferences from the root down to the leaf. The nearest
// ancestor with a value wins, and the session's own value wins over all of
// them. Unknown keys are deliberately allowed: preferences are a generic
// escape hatch, not a closed enum.

export const OCR_IMAGE_PROXY_PREFERENCE = 'ocr.image_proxy';

// Security-sensitive defaults live here so server and client resolve the same
// value. `ocr.image_proxy` defaults to ON: a session must explicitly set it to
// false (directly or through an ancestor) to opt out of proxying OCR images.
export const SESSION_PREFERENCE_DEFAULTS = Object.freeze({
  [OCR_IMAGE_PROXY_PREFERENCE]: true,
});

export const MAX_PREFERENCE_KEY_LENGTH = 128;
export const MAX_PREFERENCE_STRING_LENGTH = 10000;

const PREFERENCE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const RESERVED_PREFERENCE_KEYS = new Set([ '__proto__', 'prototype', 'constructor' ]);

export function normalizePreferenceKey(key) {
  if (typeof key !== 'string')
    throw new TypeError('Preference key must be a string');

  let normalized = key.trim();
  if (normalized === '')
    throw new TypeError('Preference key must be a non-empty string');

  if (normalized.length > MAX_PREFERENCE_KEY_LENGTH)
    throw new TypeError(`Preference key must be at most ${MAX_PREFERENCE_KEY_LENGTH} characters`);

  if (RESERVED_PREFERENCE_KEYS.has(normalized))
    throw new TypeError(`Reserved preference key: ${key}`);

  if (!PREFERENCE_KEY_PATTERN.test(normalized))
    throw new TypeError(`Invalid preference key: ${key}`);

  return normalized;
}

export function normalizePreferenceValue(value) {
  if (typeof value === 'boolean')
    return value;

  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new TypeError('Preference number must be finite');

    return value;
  }

  if (typeof value === 'string') {
    if (value.length > MAX_PREFERENCE_STRING_LENGTH)
      throw new TypeError(`Preference string must be at most ${MAX_PREFERENCE_STRING_LENGTH} characters`);

    return value;
  }

  throw new TypeError('Preference value must be a boolean, number, or string');
}

export function normalizePreferences(input) {
  if (input == null)
    return {};

  if (typeof input !== 'object' || Array.isArray(input))
    throw new TypeError('Session preferences must be an object');

  let preferences = {};
  for (let [key, value] of Object.entries(input)) {
    let normalizedKey = normalizePreferenceKey(key);
    preferences[normalizedKey] = normalizePreferenceValue(value);
  }

  return preferences;
}

export function mergePreferenceLayers(layers = [], defaults = SESSION_PREFERENCE_DEFAULTS) {
  let preferences = { ...defaults };
  for (let layer of Array.isArray(layers) ? layers : [])
    Object.assign(preferences, normalizePreferences(layer));

  return preferences;
}

// Resolve a session's effective preferences from already-loaded session
// records. `sessionsByID` may be a Map or an object keyed by session id.
//
// The returned `complete` flag is false when the walk stopped at a missing or
// cyclic ancestor; callers that can load from durable storage should retry with
// a loader instead of treating the partial result as authoritative.
export function resolvePreferencesFromSessions(sessionsByID, sessionID, options = {}) {
  let lookup = createSessionLookup(sessionsByID);
  let defaults = options.defaults || SESSION_PREFERENCE_DEFAULTS;
  let chain = [];
  let seen = new Set();
  let id = normalizeOptionalSessionID(sessionID);
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
    let session = lookup(id);
    if (!session?.id) {
      missingSessionID = id;
      complete = false;
      break;
    }

    chain.push(session);
    id = normalizeOptionalSessionID(session.parentSessionID);
  }

  let ordered = chain.slice().reverse();
  return {
    sessionID: normalizeOptionalSessionID(sessionID),
    preferences: mergePreferenceLayers(ordered.map((session) => session.preferences), defaults),
    ownPreferences: normalizeSafePreferences(ordered.at(-1)?.preferences),
    chain: ordered.map((session) => session.id),
    complete: complete && chain.length > 0,
    missingSessionID,
    cycleDetected,
  };
}

function createSessionLookup(sessionsByID) {
  if (sessionsByID instanceof Map)
    return (sessionID) => sessionsByID.get(sessionID) || null;

  if (sessionsByID && typeof sessionsByID === 'object')
    return (sessionID) => sessionsByID[sessionID] || null;

  return () => null;
}

function normalizeOptionalSessionID(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function normalizeSafePreferences(input) {
  try {
    return normalizePreferences(input);
  } catch (_error) {
    return {};
  }
}
