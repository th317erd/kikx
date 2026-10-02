'use strict';

// Prioritized compaction summaries (P7 / decision D6).
//
// A compaction summary is deliberately organized into three priority sections
// tagged `[high]`, `[medium]` and `[low]` (see agent-compaction-template.mjs).
// This module parses that text into structured sections, renders a subset of
// them for a smaller model, and selects which levels a context window may
// afford. Frames store the parsed form as `content.summaryJSON` alongside the
// verbatim `content.summary` string, so old readers keep working.

export const COMPACTION_LEVELS = [ 'high', 'medium', 'low' ];

// Window thresholds: below the small threshold only `high` survives; below the
// medium threshold `medium` is also kept; otherwise every level is kept.
export const SMALL_CONTEXT_WINDOW_TOKENS = 16384;
export const MEDIUM_CONTEXT_WINDOW_TOKENS = 65536;

export const COMPACTION_SECTION_HEADER = 'Prioritized context memory:';

const SECTION_TAG_PATTERN = /^\s*\[\s*(high|medium|low)\s*\]\s*$/i;

// Parse a priority-tagged summary into `{ high, medium, low, unstructured }`.
// Each section is an array of non-empty, trimmed lines. Lines before the first
// tag are folded into `high` so preamble is never lost. When no tag is found the
// whole text becomes `high` and `unstructured` is true — must-keep material is
// never discarded just because the model ignored the format.
export function parseCompactionSections(text) {
  let source = typeof text === 'string' ? text : '';
  let sections = { high: [], medium: [], low: [] };
  let preamble = [];
  let current = null;
  let found = false;

  for (let rawLine of source.split(/\r?\n/)) {
    let match = rawLine.match(SECTION_TAG_PATTERN);
    if (match) {
      if (!found && preamble.length > 0)
        sections.high.push(...preamble);

      current = match[1].toLowerCase();
      found = true;
      continue;
    }

    let line = rawLine.trim();
    if (line === '')
      continue;

    if (current)
      sections[current].push(line);
    else
      preamble.push(line);
  }

  if (!found)
    return { high: preamble, medium: [], low: [], unstructured: true };

  return { ...sections, unstructured: false };
}

// Render only the requested levels, each reintroduced by its `[level]` tag.
// `high` is always rendered when it has content. A short header is added only
// when more than one level is present, so a single-section render stays terse.
export function renderCompactionSections(sections, { levels } = {}) {
  let parsed = normalizeSections(sections);
  let allowed = normalizeLevels(levels);
  if (!allowed.includes('high'))
    allowed = [ 'high', ...allowed ];

  let present = allowed.filter((level) => parsed[level].length > 0);
  if (present.length === 0)
    return '';

  let lines = [];
  for (let level of present)
    lines.push(`[${level}]`, ...parsed[level]);

  let header = present.length > 1 ? `${COMPACTION_SECTION_HEADER}\n` : '';
  return `${header}${lines.join('\n')}`;
}

// Which levels a model with this context window can afford. Thresholds are
// deliberately conservative: an unknown/null window means we cannot filter, so
// every level is returned rather than risking a loss of must-keep material.
export function selectCompactionLevels(contextWindow) {
  let window = normalizeWindow(contextWindow);
  if (window == null)
    return [ ...COMPACTION_LEVELS ];

  if (window < SMALL_CONTEXT_WINDOW_TOKENS)
    return [ 'high' ];

  if (window < MEDIUM_CONTEXT_WINDOW_TOKENS)
    return [ 'high', 'medium' ];

  return [ ...COMPACTION_LEVELS ];
}

// Build the structured, storable form of a summary string.
export function buildCompactionSummaryJSON(text) {
  return parseCompactionSections(text);
}

// True when a stored JSON summary carries at least one usable section.
export function hasCompactionSections(json) {
  if (!json || typeof json !== 'object')
    return false;

  let parsed = normalizeSections(json);
  return COMPACTION_LEVELS.some((level) => parsed[level].length > 0);
}

// Coerce an arbitrary stored/pre-parsed value into `{ high, medium, low }` line
// arrays. Accepts arrays (already parsed), newline-delimited strings, and the
// parse result itself, so render/has tolerate loosely-shaped input.
function normalizeSections(sections) {
  let value = sections && typeof sections === 'object' ? sections : {};
  let result = { high: [], medium: [], low: [] };
  for (let level of COMPACTION_LEVELS)
    result[level] = normalizeLines(value[level]);

  return result;
}

function normalizeLines(value) {
  if (Array.isArray(value)) {
    let lines = [];
    for (let item of value) {
      let line = typeof item === 'string' ? item.trim() : '';
      if (line !== '')
        lines.push(line);
    }

    return lines;
  }

  if (typeof value === 'string') {
    return value.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '');
  }

  return [];
}

function normalizeLevels(levels) {
  if (!Array.isArray(levels) || levels.length === 0)
    return [ ...COMPACTION_LEVELS ];

  let allowed = [];
  for (let level of COMPACTION_LEVELS) {
    if (levels.includes(level))
      allowed.push(level);
  }

  return allowed.length > 0 ? allowed : [ ...COMPACTION_LEVELS ];
}

function normalizeWindow(value) {
  if (value == null || value === '')
    return null;

  let number = Number(value);
  if (!Number.isFinite(number) || number <= 0)
    return null;

  return number;
}
