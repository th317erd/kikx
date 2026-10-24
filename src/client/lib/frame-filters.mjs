'use strict';

// Pure filter state for the thread "eyeball" popup.
//
// The popup is a list of checkboxes, one per category of frame. A frame is
// rendered when any one of the categories it belongs to is enabled. Frames can
// belong to more than one category (a Question authored by an agent is both
// `question` and `agent`), so enabling `question` alone is enough to show every
// question, even with `agent` off.
//
// `hidden` is not an ordinary category: it is a *gate*, and it is the one row
// that starts OFF. Frames marked hidden are internal bookkeeping - composer
// drafts, frame groups, scheduled question deadlines, undispatched session
// invites - and have never been rendered in a thread. Defaulting the gate on
// would dump that machinery into every conversation on first load, so the gate
// defaults off and the reveal is opt-in.
//
// Because the gate is not a category, the three bulk gestures (pinned row,
// Ctrl+Click, Shift+Click) act on the categories only and leave the gate where
// the user put it. Otherwise "select all" would silently turn the reveal on.
//
// Kept free of DOM and of the frame registry so both the popup and the thread
// renderer can import it, and so the click patterns are unit-testable.

// Display order for the popup's category rows, after the pinned "all" row.
// Each of these starts on.
export const CATEGORY_ROWS = [
  { key: 'user', label: 'User' },
  { key: 'agent', label: 'Agent' },
  { key: 'question', label: 'Question' },
  { key: 'child-sessions', label: 'Child Sessions' },
  { key: 'tools', label: 'Tools' },
  { key: 'commands', label: 'Commands' },
  { key: 'compaction', label: 'Compaction' },
];

// The reveal gate, rendered below the categories and separated from them. It
// starts off; see the header comment for why.
export const HIDDEN_ROW = { key: 'hidden', label: 'Hidden' };

// Every row, in render order: categories then the gate.
export const FILTER_ROWS = [ ...CATEGORY_ROWS, HIDDEN_ROW ];

export const CATEGORY_KEYS = CATEGORY_ROWS.map((row) => row.key);
export const FILTER_KEYS = FILTER_ROWS.map((row) => row.key);

export function defaultFrameFilters() {
  let filters = {};
  for (let key of CATEGORY_KEYS)
    filters[key] = true;
  filters[HIDDEN_ROW.key] = false;

  return filters;
}

// Normalize anything coming out of state into a complete, boolean map. Absent
// or non-boolean values fall back to that row's default, so a state object from
// an older session neither hides the whole thread nor switches the hidden
// reveal on behind the user's back.
export function normalizeFrameFilters(filters) {
  let source = filters && typeof filters === 'object' ? filters : {};
  let normal = {};
  for (let key of CATEGORY_KEYS)
    normal[key] = typeof source[key] === 'boolean' ? source[key] : true;
  normal[HIDDEN_ROW.key] = typeof source[HIDDEN_ROW.key] === 'boolean'
    ? source[HIDDEN_ROW.key]
    : false;

  return normal;
}

export function cloneFrameFilters(filters) {
  return { ...normalizeFrameFilters(filters) };
}

function isKnownKey(key) {
  return FILTER_KEYS.includes(key);
}

// Plain click: flip exactly one row.
export function toggleFilter(filters, key) {
  let next = cloneFrameFilters(filters);
  if (isKnownKey(key))
    next[key] = !next[key];

  return next;
}

// Ctrl+Click: the clicked row becomes the only enabled row.
//
// When the clicked row is the Hidden gate, the gate turns on and every category
// turns off, which would show nothing. An isolated gate therefore leaves the
// categories untouched and just switches the reveal on - clicking Hidden means
// "show me the hidden ones", not "show me only the hidden ones".
export function onlyFilter(filters, key) {
  let next = cloneFrameFilters(filters);
  if (!isKnownKey(key))
    return next;

  if (key === HIDDEN_ROW.key) {
    next[key] = true;
    return next;
  }

  for (let other of CATEGORY_KEYS)
    next[other] = other === key;

  return next;
}

// Shift+Click turns every category on; passing false clears them. The Hidden
// gate is deliberately untouched: a bulk gesture must not reveal internal
// frames as a side effect.
export function allFilters(filters, value = true) {
  let next = cloneFrameFilters(filters);
  for (let key of CATEGORY_KEYS)
    next[key] = value === true;

  return next;
}

// "Every category is on" - the gate is not a category, so it is not consulted.
export function everyFilterOn(filters) {
  let normal = normalizeFrameFilters(filters);
  return CATEGORY_KEYS.every((key) => normal[key] === true);
}

export function noFilterOn(filters) {
  let normal = normalizeFrameFilters(filters);
  return CATEGORY_KEYS.every((key) => normal[key] === false);
}

// Pinned row click: all on when anything is off, all off when everything is on.
// This is what makes the pinned checkbox a master toggle rather than a second
// "turn everything on" button.
export function toggleAllFilters(filters) {
  return allFilters(filters, !everyFilterOn(filters));
}

// 'on' | 'off' | 'mixed' - drives checked / indeterminate on the pinned row.
// Describes the categories only; the Hidden gate has its own checkbox.
export function filterSummary(filters) {
  if (everyFilterOn(filters))
    return 'on';
  if (noFilterOn(filters))
    return 'off';

  return 'mixed';
}

function hasSessionReference(frame) {
  let references = frame?.content?.references;
  if (!Array.isArray(references))
    return false;

  return references.some((reference) => reference?.type === 'session'
    && typeof reference.id === 'string'
    && reference.id.trim() !== '');
}

// Every category a frame belongs to, excluding the hidden gate. A frame can be
// in several.
export function classifyFrame(frame) {
  if (!frame)
    return [];

  let keys = new Set();
  let type = frame.type;
  let authorType = frame.authorType;

  if (authorType === 'user' || type === 'UserMessage' || type === 'UserDraft')
    keys.add('user');
  if (authorType === 'agent' || type === 'AgentMessage' || type === 'AgentProgress')
    keys.add('agent');
  if (type === 'Question')
    keys.add('question');
  if (type === 'ToolCall' || type === 'ToolResult')
    keys.add('tools');
  if (type === 'CommandResult')
    keys.add('commands');
  if (type === 'CompactionFrame')
    keys.add('compaction');
  if (hasSessionReference(frame))
    keys.add('child-sessions');

  // Return in popup display order so callers never depend on Set insertion
  // order, and so a frame's primary category leads.
  return FILTER_KEYS.filter((key) => keys.has(key));
}

// True when the filter set would render this frame. The hidden gate is applied
// first; an unclassifiable frame is shown whenever any filter is enabled, so a
// future frame type is never invisible by accident, while clearing every row
// still empties the thread.
export function frameMatchesFilters(frame, filters) {
  if (!frame)
    return false;

  let normal = normalizeFrameFilters(filters);
  if (frame.hidden === true && normal[HIDDEN_ROW.key] !== true)
    return false;

  let keys = classifyFrame(frame);
  if (keys.length === 0)
    return CATEGORY_KEYS.some((key) => normal[key] === true);

  return keys.some((key) => normal[key] === true);
}

// Apply the categories to an already-visibility-filtered list.
export function applyFrameFilters(frames, filters) {
  let normal = normalizeFrameFilters(filters);
  return (Array.isArray(frames) ? frames : []).filter((frame) => frameMatchesFilters(frame, normal));
}

// Should the thread renderer keep frames marked hidden? Only when the user has
// asked for them, so the untouched default view is unchanged for people who
// never open the popup.
export function wantsHiddenFrames(filters) {
  return normalizeFrameFilters(filters)[HIDDEN_ROW.key] === true;
}

// Per-row counts for the popup. Counts describe the data, not the current
// selection: a hidden user message counts toward both User and Hidden, because
// it genuinely is both.
export function filterCounts(frames) {
  let counts = {};
  for (let key of FILTER_KEYS)
    counts[key] = 0;

  for (let frame of Array.isArray(frames) ? frames : []) {
    if (!frame)
      continue;

    if (frame.hidden === true)
      counts[HIDDEN_ROW.key] += 1;

    for (let key of classifyFrame(frame)) {
      if (isKnownKey(key))
        counts[key] += 1;
    }
  }

  return counts;
}

// Stable signature of a filter set, so the shell can skip repainting the thread
// when a click did not actually change anything.
export function frameFiltersSignature(filters) {
  let normal = normalizeFrameFilters(filters);
  return FILTER_KEYS.map((key) => (normal[key] ? '1' : '0')).join('');
}
