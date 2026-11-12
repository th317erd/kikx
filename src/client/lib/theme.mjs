'use strict';

// Primary theme (owner, 2026-11-11): "This app is VERY gray... set up a
// theme where the primary color can be chosen from the rainbow: red,
// orange, yellow, green, cyan, blue, purple, pink" — applied to buttons and
// other primary elements.
//
// Architecture: ONE CSS custom property carries the whole feature.
//   --kikx-accent   set INLINE on <html> from this module (palette-validated,
//                   localStorage-persisted — same discipline as kikx.debug).
//   --accent        aliased in the stylesheet to var(--kikx-accent), which
//                   retargets EVERY AEOR framework consumer at once (tab-view
//                   active/focus, links, aeor-button primary, components.css)
//                   without touching vendor files.
//   The 26 hardcoded primary blues (#3d6cff) across the stylesheets are
//   var(--kikx-accent), so Send, selected cards, question submit, focus
//   rings and outlines all follow the choice.
// Semantic colors (STOP red, Installed green, Update amber, error red) are
// deliberately NOT themed — they carry meaning, not style.

export const THEME_STORAGE_KEY = 'kikx.theme';

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

export function readThemeID() {
  try {
    const stored = globalThis.localStorage?.getItem(THEME_STORAGE_KEY);
    return isThemeID(stored) ? stored : DEFAULT_THEME_ID;
  } catch (_error) {
    return DEFAULT_THEME_ID;
  }
}

export function writeThemeID(id) {
  try {
    globalThis.localStorage?.setItem(THEME_STORAGE_KEY, isThemeID(id) ? id : DEFAULT_THEME_ID);
  } catch (_error) {}
}

// ONE property on ONE node — everything else derives in CSS.
export function applyTheme(root, id) {
  const target = root || globalThis.document?.documentElement;
  try {
    target?.style?.setProperty('--kikx-accent', themeHex(id));
  } catch (_error) {}
}

// Boot: read + validate + apply before first paint; returns the id for state.
export function initTheme(root) {
  const id = readThemeID();
  applyTheme(root, id);
  return id;
}

// The picker's action: persist, repaint via state (next paint renders the
// pressed ring), and apply IMMEDIATELY — the whole app recolors with zero
// reload and zero re-render.
export function setPrimaryTheme(state, id, root) {
  const next = isThemeID(id) ? id : DEFAULT_THEME_ID;
  writeThemeID(next);
  applyTheme(root, next);
  if (state && typeof state === 'object')
    state.themeID = next;
  return next;
}
