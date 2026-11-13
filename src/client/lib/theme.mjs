'use strict';

// Primary theme (owner, 2026-11-11): "This app is VERY gray... set up a
// theme where the primary color can be chosen from the rainbow: red,
// orange, yellow, green, cyan, blue, purple, pink" — applied to buttons and
// other primary elements.
//
// MIGRATED 2026-11-13 (plan P4, properties store): the choice must FOLLOW
// THE USER, so it is the account-scoped property
// /core/user/theme/primary_color over the P3 HTTP surface. HARD CUT (owner
// ruling — "I am the only user in the world currently"): localStorage is
// dead code, no import of old values. Boot paints default blue; the account
// fetch (kicked from startupLoads after auth, mirroring loadServerVersion)
// swaps the accent when it lands; the picker persists over PUT instantly.
// Signed-out or fetch-failed stays default blue with NO error surface.
//
// Architecture: ONE CSS custom property carries the whole feature.
//   --kikx-accent   set INLINE on <html> from this module (palette-validated).
//   --accent        aliased in the stylesheet to var(--kikx-accent), which
//                   retargets EVERY AEOR framework consumer at once (tab-view
//                   active/focus, links, aeor-button primary, components.css)
//                   without touching vendor files.
//   The 26 hardcoded primary blues (#3d6cff) across the stylesheets are
//   var(--kikx-accent), so Send, selected cards, question submit, focus
//   rings and outlines all follow the choice.
// Semantic colors (STOP red, Installed green, Update amber, error red) are
// deliberately NOT themed — they carry meaning, not style.

export const THEME_PROPERTY_KEY = '/core/user/theme/primary_color';
export const THEME_PROPERTIES_URL = '/api/v1/properties';

export const THEME_PALETTE = Object.freeze([
  { id: 'red', label: 'Red', hex: '#d43f3f' },
  { id: 'orange', label: 'Orange', hex: '#d97025' },
  { id: 'yellow', label: 'Yellow', hex: '#c9a227' },
  { id: 'green', label: 'Green', hex: '#2fae5f' },
  { id: 'cyan', label: 'Cyan', hex: '#22a7bd' },
  { id: 'blue', label: 'Blue', hex: '#3d6cff' },
  { id: 'purple', label: 'Purple', hex: '#9a55d6' },
  { id: 'pink', label: 'Pink', hex: '#d8558f' },
]);

export const DEFAULT_THEME_ID = 'blue';

// Hexes are tuned to sit on the dark shell (#101214 / #171c21) — readable
// as borders, solid enough as button fills with white text.
const DEFAULT_HEX = THEME_PALETTE.find((entry) => entry.id === DEFAULT_THEME_ID).hex;

export function themeHex(id) {
  const entry = THEME_PALETTE.find((color) => color.id === id);
  return entry ? entry.hex : DEFAULT_HEX;
}

export function isThemeID(id) {
  return THEME_PALETTE.some((color) => color.id === id);
}

// ONE property on ONE node — everything else derives in CSS.
export function applyTheme(root, id) {
  const target = root || globalThis.document?.documentElement;
  try {
    target?.style?.setProperty('--kikx-accent', themeHex(id));
  } catch (_error) {}
}

// Boot (state init, pre-paint): default blue, period — the account value
// arrives later via loadAccountTheme. Returns the id for state.
export function initTheme(root) {
  applyTheme(root, DEFAULT_THEME_ID);
  return DEFAULT_THEME_ID;
}

// The account fetch: one request per page (guard flag, server-version
// pattern), silent on every failure class — 404 never-set, cleared row,
// invalid id, signed-out 401, network. The default blue simply holds.
// `root` is optional (tests inject one; the browser uses document).
export async function loadAccountTheme(app, root) {
  const state = app && app._state;
  if (!state || typeof app._getJSON !== 'function')
    return null;
  if (state.themeAccountRequested === true)
    return null;
  state.themeAccountRequested = true;
  try {
    const response = await app._getJSON(
      `${THEME_PROPERTIES_URL}?key=${encodeURIComponent(THEME_PROPERTY_KEY)}`);
    const value = response?.data?.value;
    if (isThemeID(value)) {
      state.themeID = value;
      applyTheme(root, value);
      app._requestRender?.('account-theme');
      return value;
    }
    return null;
  } catch (_error) {
    return null;
  }
}

// The picker's action: apply IMMEDIATELY (the whole app recolors with zero
// reload and zero re-render), record in state (the pressed ring), and
// persist to the ACCOUNT property — best-effort: a rejected PUT never
// throws into the click path, and there is deliberately NO local fallback
// (hard cut: the server keeps the last durable choice, nothing browser-local).
// Accepts the app ({ _state, _putJSON }) or a bare state object (paint only).
export function setPrimaryTheme(app, id, root) {
  const next = isThemeID(id) ? id : DEFAULT_THEME_ID;
  applyTheme(root, next);
  const state = app && typeof app === 'object' ? (app._state ?? app) : null;
  if (state && typeof state === 'object')
    state.themeID = next;
  if (app && typeof app._putJSON === 'function') {
    void app._putJSON(THEME_PROPERTIES_URL, { key: THEME_PROPERTY_KEY, value: next })
      .catch(() => { /* silent: the visual already applied; server holds the durable value */ });
  }
  return next;
}
