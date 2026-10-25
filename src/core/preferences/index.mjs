'use strict';

export {
  effectivePreference,
  mergePreferenceLayers,
  normalizePreferences,
  normalizePreferenceKey,
  resolveEffectivePreferences,
  resolvePreferencesFromSessions,
  SESSION_PREFERENCE_DEFAULTS,
  OCR_IMAGE_PROXY_PREFERENCE,
} from './session-preferences.mjs';
export {
  MAX_PREFERENCE_KEY_LENGTH,
  MAX_PREFERENCE_STRING_LENGTH,
  normalizePreferenceValue,
} from '../../shared/session-preferences.mjs';
