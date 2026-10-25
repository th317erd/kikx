'use strict';

// Client view of the frame filter popup.
//
// The row definitions and the matching semantics live in
// `src/shared/frame-window-filters.mjs` so the popup and the server store can
// never disagree about which frames a given set of checkboxes admits. This
// module adds only what the browser needs: mutation helpers for the checkbox
// UI, the pinned-row summary, and the query-string encoding that tells the
// server which frames to send.
//
// It deliberately does NOT filter rendered frames. Filtering is a transport
// concern here: the client holds a bounded window of a lazy-loaded session, so
// a local predicate would answer "no frames match" while matching frames sat
// unread on disk, and paging would walk raw rows instead of matches.

import {
  FRAME_FILTER_CATEGORY_KEYS,
  FRAME_FILTER_GATE_KEYS,
  FRAME_FILTER_KEYS,
  FRAME_FILTER_ROWS,
  defaultFrameWindowFilters,
  frameFilterCategories,
  frameFilterCounts,
  frameMatchesQuery,
  frameMatchesWindowFilters,
  frameQueryMatchesText,
  frameSearchText,
  normalizeFrameQuery,
  normalizeWindowFilters,
  windowFiltersAreDefault,
} from '../../shared/frame-window-filters.mjs';

export const CATEGORY_ROWS = FRAME_FILTER_ROWS.filter((row) => row.kind === 'category');
export const DELETED_ROW = FRAME_FILTER_ROWS.find((row) => row.kind === 'gate')
  || { key: 'deleted', label: 'Deleted', kind: 'gate' };
export const FILTER_ROWS = FRAME_FILTER_ROWS;
export const CATEGORY_KEYS = FRAME_FILTER_CATEGORY_KEYS;
export const GATE_KEYS = FRAME_FILTER_GATE_KEYS;
export const FILTER_KEYS = FRAME_FILTER_KEYS;

export {
  frameFilterCategories,
  frameFilterCounts,
  frameMatchesQuery,
  frameMatchesWindowFilters,
  frameQueryMatchesText,
  frameSearchText,
  normalizeFrameQuery,
  windowFiltersAreDefault,
};

export function defaultFrameFilters() {
  return defaultFrameWindowFilters();
}

export function normalizeFrameFilters(filters) {
  return normalizeWindowFilters(filters);
}

export function cloneFrameFilters(filters) {
  return { ...normalizeWindowFilters(filters) };
}

export function toggleFilter(filters, key) {
  let next = normalizeWindowFilters(filters);
  if (!FILTER_KEYS.includes(key))
    return next;

  next[key] = !next[key];
  return next;
}

// Ctrl-click semantics: exactly this category, and only this one.
//
// Gate rows are left untouched, because they widen rather than select — a
// person narrowing to "just Sessions" does not also mean "and forget that I
// turned deleted frames on". Narrowing to nothing (clicking an already-solo
// category) restores every category so the view cannot become empty by
// accident.
export function onlyFilter(filters, key) {
  let normal = normalizeWindowFilters(filters);

  // Ctrl+Click on a gate row means "this reveal, on" — it must not clear the
  // category selection, or isolating the reveal would empty the thread.
  if (GATE_KEYS.includes(key)) {
    normal[key] = true;
    return normal;
  }

  if (!CATEGORY_KEYS.includes(key))
    return normal;

  let alreadySolo = CATEGORY_KEYS.every((candidate) => normal[candidate] === (candidate === key));
  if (alreadySolo)
    return allFilters(normal, true);

  for (let candidate of CATEGORY_KEYS)
    normal[candidate] = candidate === key;

  return normal;
}

export function allFilters(filters, value = true) {
  let next = normalizeWindowFilters(filters);
  for (let key of CATEGORY_KEYS)
    next[key] = value === true;

  return next;
}

// True when every CATEGORY is on. The pinned row governs the categories only;
// the gate rows are not selectors and must not make the master row read
// "mixed" merely because Deleted is off.
export function everyFilterOn(filters) {
  let normal = normalizeWindowFilters(filters);
  return CATEGORY_KEYS.every((key) => normal[key] === true);
}

// True when anything at all is narrowing the shell: the search text, a
// category the popup switched off, or the Deleted reveal. The header's clear
// button is only meaningful when this is true, so it stays out of the way
// otherwise instead of sitting there as a dead control.
export function stateHasFilters(state = {}) {
  if (normalizeFrameQuery(state?.sessionSearch) !== '')
    return true;
  if (state?.showDeletedSessions === true)
    return true;
  if (state?.frameFilters?.[DELETED_ROW.key] === true)
    return true;

  return !everyFilterOn(state?.frameFilters);
}

export function noFilterOn(filters) {
  let normal = normalizeWindowFilters(filters);
  return CATEGORY_KEYS.every((key) => normal[key] === false);
}

// Pinned-row toggle: if anything is off, turn everything on; otherwise turn
// everything off. The three-state rendering (indeterminate) lives in the popup.
export function toggleAllFilters(filters) {
  let normal = normalizeWindowFilters(filters);
  return allFilters(normal, !everyFilterOn(normal));
}

export function filterSummary(filters) {
  let normal = normalizeWindowFilters(filters);
  if (everyFilterOn(normal))
    return 'on';
  if (noFilterOn(normal))
    return 'off';

  return 'mixed';
}

// Short label for the button's title, e.g. "All frames" or "Sessions + 2 more",
// so a person can tell what is hidden without opening the popup.
export function filterButtonSummary(filters) {
  let normal = normalizeWindowFilters(filters);
  let selected = CATEGORY_KEYS.filter((key) => normal[key] === true);
  let labelFor = (key) => FILTER_ROWS.find((row) => row.key === key)?.label || key;

  let parts = [];
  if (selected.length === CATEGORY_KEYS.length)
    parts.push('All frames');
  else if (selected.length === 0)
    parts.push('No frames');
  else if (selected.length === 1)
    parts.push(labelFor(selected[0]));
  else
    parts.push(`${labelFor(selected[0])} + ${selected.length - 1} more`);

  if (normal[DELETED_ROW.key] === true)
    parts.push('with deleted');

  return parts.join(', ');
}

// The wire format the frames endpoint understands: one `f_<key>` flag per row
// that differs from its default, plus `q` for the search. Sending only deltas
// keeps the URL short and keeps "no params" meaning "the default view", which
// is also the server's fast path.
export function frameFilterSearchParams(filters, query = '') {
  let normal = normalizeWindowFilters(filters);
  let defaults = defaultFrameWindowFilters();
  let params = new URLSearchParams();

  for (let key of FILTER_KEYS) {
    if (normal[key] !== defaults[key])
      params.set(`f_${key}`, normal[key] === true ? '1' : '0');
  }

  let normalizedQuery = normalizeFrameQuery(query);
  if (normalizedQuery !== '')
    params.set('q', normalizedQuery);

  return params;
}

// Stable identity for the filter set plus query, used to decide whether a
// reload is actually needed. Changing a checkbox must refetch; re-rendering the
// same state must not.
export function frameFiltersSignature(filters, query = '') {
  let normal = normalizeWindowFilters(filters);
  let parts = FILTER_KEYS.map((key) => `${key}:${normal[key] === true ? 1 : 0}`);
  parts.push(`q:${normalizeFrameQuery(query)}`);
  return parts.join(',');
}

// --- compatibility aliases -------------------------------------------------
//
// The popup and its specs were written against the previous client-side module,
// which used these names. They are kept as thin aliases of the shared
// implementation rather than reimplemented, so there is still exactly one
// predicate in the codebase.

export const classifyFrame = frameFilterCategories;
export const filterCounts = frameFilterCounts;
export const wantsDeletedFrames = (filters) => normalizeWindowFilters(filters).deleted === true;
export const frameMatchesFilters = (frame, filters, query = '') => (
  frameMatchesWindowFilters(frame, filters, query)
);

// Does a frame pass the current filter set? Used only to explain an empty
// already-loaded window; it never decides what the server sends.
export function applyFrameFilters(frames, filters, query = '') {
  let normal = normalizeWindowFilters(filters);
  return (Array.isArray(frames) ? frames : []).filter((frame) => frameMatchesWindowFilters(frame, normal, query));
}
