'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COMPACTION_LEVELS,
  MEDIUM_CONTEXT_WINDOW_TOKENS,
  SMALL_CONTEXT_WINDOW_TOKENS,
  buildCompactionSummaryJSON,
  hasCompactionSections,
  parseCompactionSections,
  renderCompactionSections,
  selectCompactionLevels,
} from '../../../src/core/compaction/index.mjs';

const TAGGED = [
  '[high]',
  'Keep /tmp/project/app.mjs',
  'Decision: ship P7',
  '',
  '[medium]',
  'Rationale: smaller bots need high-only',
  '',
  '[low]',
  'Chit chat about lunch',
].join('\n');

test('parseCompactionSections splits tagged output into ordered line arrays', () => {
  let parsed = parseCompactionSections(TAGGED);
  assert.deepEqual(parsed.high, [ 'Keep /tmp/project/app.mjs', 'Decision: ship P7' ]);
  assert.deepEqual(parsed.medium, [ 'Rationale: smaller bots need high-only' ]);
  assert.deepEqual(parsed.low, [ 'Chit chat about lunch' ]);
  assert.equal(parsed.unstructured, false);
});

test('parseCompactionSections tolerates whitespace and case in tags', () => {
  let parsed = parseCompactionSections('  [HIGH]\na\n  [ Medium ]\nb\n[low]\nc');
  assert.deepEqual(parsed.high, [ 'a' ]);
  assert.deepEqual(parsed.medium, [ 'b' ]);
  assert.deepEqual(parsed.low, [ 'c' ]);
});

test('parseCompactionSections folds untagged text into high and flags unstructured', () => {
  let parsed = parseCompactionSections('plain summary\nsecond line');
  assert.deepEqual(parsed.high, [ 'plain summary', 'second line' ]);
  assert.deepEqual(parsed.medium, []);
  assert.deepEqual(parsed.low, []);
  assert.equal(parsed.unstructured, true);
});

test('parseCompactionSections folds preamble before the first tag into high', () => {
  let parsed = parseCompactionSections('intro line\n[high]\nkeep this\n[medium]\nmaybe');
  assert.deepEqual(parsed.high, [ 'intro line', 'keep this' ]);
  assert.deepEqual(parsed.medium, [ 'maybe' ]);
  assert.deepEqual(parsed.low, []);
  assert.equal(parsed.unstructured, false);
});

test('parseCompactionSections treats missing sections as empty', () => {
  let parsed = parseCompactionSections('[high]\nonly high');
  assert.deepEqual(parsed.high, [ 'only high' ]);
  assert.deepEqual(parsed.medium, []);
  assert.deepEqual(parsed.low, []);
});

test('parseCompactionSections handles empty and non-string input', () => {
  assert.deepEqual(parseCompactionSections(''), { high: [], medium: [], low: [], unstructured: true });
  assert.deepEqual(parseCompactionSections(null), { high: [], medium: [], low: [], unstructured: true });
});

test('selectCompactionLevels maps windows to allowed levels at the thresholds', () => {
  assert.deepEqual(selectCompactionLevels(8192), [ 'high' ]);
  assert.deepEqual(selectCompactionLevels(SMALL_CONTEXT_WINDOW_TOKENS - 1), [ 'high' ]);
  assert.deepEqual(selectCompactionLevels(SMALL_CONTEXT_WINDOW_TOKENS), [ 'high', 'medium' ]);
  assert.deepEqual(selectCompactionLevels(32768), [ 'high', 'medium' ]);
  assert.deepEqual(selectCompactionLevels(MEDIUM_CONTEXT_WINDOW_TOKENS - 1), [ 'high', 'medium' ]);
  assert.deepEqual(selectCompactionLevels(MEDIUM_CONTEXT_WINDOW_TOKENS), [ ...COMPACTION_LEVELS ]);
  assert.deepEqual(selectCompactionLevels(200000), [ ...COMPACTION_LEVELS ]);
});

test('selectCompactionLevels never filters an unknown or invalid window', () => {
  assert.deepEqual(selectCompactionLevels(null), [ ...COMPACTION_LEVELS ]);
  assert.deepEqual(selectCompactionLevels(undefined), [ ...COMPACTION_LEVELS ]);
  assert.deepEqual(selectCompactionLevels(0), [ ...COMPACTION_LEVELS ]);
  assert.deepEqual(selectCompactionLevels('not-a-number'), [ ...COMPACTION_LEVELS ]);
});

test('renderCompactionSections reintroduces tags and always keeps high', () => {
  let sections = parseCompactionSections(TAGGED);

  let highOnly = renderCompactionSections(sections, { levels: [ 'high' ] });
  assert.match(highOnly, /\[high\]/);
  assert.match(highOnly, /Keep \/tmp\/project\/app\.mjs/);
  assert.doesNotMatch(highOnly, /\[medium\]/);
  assert.doesNotMatch(highOnly, /\[low\]/);
  // A single level gets no header.
  assert.doesNotMatch(highOnly, /Prioritized context memory/);

  let all = renderCompactionSections(sections, { levels: [ 'high', 'medium', 'low' ] });
  assert.match(all, /Prioritized context memory:/);
  assert.match(all, /\[high\]/);
  assert.match(all, /\[medium\]/);
  assert.match(all, /\[low\]/);
});

test('renderCompactionSections defaults to every level and handles empty input', () => {
  let sections = parseCompactionSections(TAGGED);
  let all = renderCompactionSections(sections);
  assert.match(all, /\[low\]/);
  assert.equal(renderCompactionSections({ high: [], medium: [], low: [] }, { levels: [ 'high' ] }), '');
  assert.equal(renderCompactionSections(null, { levels: [ 'high' ] }), '');
});

test('buildCompactionSummaryJSON and hasCompactionSections describe the stored shape', () => {
  let json = buildCompactionSummaryJSON(TAGGED);
  assert.equal(json.unstructured, false);
  assert.equal(json.high.length, 2);
  assert.equal(hasCompactionSections(json), true);
  assert.equal(hasCompactionSections(buildCompactionSummaryJSON('')), false);
  assert.equal(hasCompactionSections(null), false);
});
