'use strict';

// Pure unit tests for the shared, driver-agnostic locator builder. No database
// is involved: these pin the line/byte/char/CRLF/Unicode-scalar semantics that
// every driver (PostgreSQL indexed search, SQLite scan fallback) relies on.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildLocator,
  codePointCount,
  contentHash,
  findMatchRanges,
  lineInfoForOffset,
  moveByChars,
} from '../../../src/core/database/document-locators.mjs';

test('findMatchRanges is case-insensitive, non-overlapping and bounded', () => {
  let content = 'Needle and needle and NEEDLE';

  assert.deepEqual(findMatchRanges(content, 'needle', 2), [
    { start: 0, end: 6 },
    { start: 11, end: 17 },
  ]);

  // A query that only matches when lowercased still matches.
  assert.deepEqual(findMatchRanges('ABC', 'abc', 5), [ { start: 0, end: 3 } ]);

  // An empty query never matches (avoids an infinite indexOf(0) loop).
  assert.deepEqual(findMatchRanges('anything', '', 5), []);
});

test('lineInfoForOffset counts CRLF as one break and LF as one break', () => {
  let lf = 'one\ntwo\nthree';
  assert.deepEqual(lineInfoForOffset(lf, 0), { line: 1, column: 0, globalChar: 0 });
  assert.deepEqual(lineInfoForOffset(lf, 4), { line: 2, column: 0, globalChar: 4 });
  assert.deepEqual(lineInfoForOffset(lf, 8), { line: 3, column: 0, globalChar: 8 });

  let crlf = 'one\r\ntwo';
  assert.deepEqual(lineInfoForOffset(crlf, 5), { line: 2, column: 0, globalChar: 4 });

  // A lone CR still breaks the line.
  assert.deepEqual(lineInfoForOffset('a\rb', 2), { line: 2, column: 0, globalChar: 2 });
});

test('lineInfoForOffset counts Unicode scalars, not UTF-16 code units', () => {
  // 'a' + emoji (surrogate pair) + 'b'.
  assert.equal(codePointCount('😀a'), 2);
  assert.deepEqual(lineInfoForOffset('a😀b', 3), { line: 1, column: 2, globalChar: 2 });
});

test('moveByChars walks Unicode scalars and clamps to the string', () => {
  assert.equal(moveByChars('a😀b', 0, 2), 3);
  assert.equal(moveByChars('a😀b', 3, -1), 1);
  assert.equal(moveByChars('abc', 0, -5), 0);
  assert.equal(moveByChars('abc', 1, 0), 1);
  assert.equal(moveByChars('abc', 2, 10), 3);
});

test('buildLocator reports 1-based lines, UTF-8 bytes and scalar chars', () => {
  let content = 'alpha\nbeta needle here\ngamma';
  let start = content.indexOf('needle');
  let locator = buildLocator(
    content,
    { start, end: start + 'needle'.length },
    'needle',
    0,
    { snippetChars: 20, contextLines: 2 },
  );

  assert.equal(locator.matched_text, 'needle');
  assert.equal(locator.field, '@content');
  assert.equal(locator.source, 'content');
  assert.equal(locator.confidence, 'exact');
  assert.equal(locator.range.byte.start, Buffer.byteLength(content.slice(0, start), 'utf8'));
  assert.equal(locator.range.line.start, 2);
  assert.equal(locator.range.line.end, 2);
  // All-BMP text: scalar offsets equal code-unit offsets here.
  assert.equal(locator.range.char.start, start);
  assert.deepEqual(locator.fetch.line_range, { start: 1, end: 4 });
  assert.ok(locator.snippet.text.includes('needle'));
  assert.deepEqual(locator.snippet.highlight, [
    { start: 10, end: 16, unit: 'unicode-scalar' },
  ]);
  assert.equal(
    locator.snippet.text.slice(locator.snippet.highlight[0].start, locator.snippet.highlight[0].end),
    'needle',
  );
});

test('buildLocator separates byte offsets from scalar offsets for non-ASCII text', () => {
  let content = 'é😀needle';
  let start = content.indexOf('needle');
  let locator = buildLocator(
    content,
    { start, end: start + 'needle'.length },
    'needle',
    0,
    { snippetChars: 40, contextLines: 0 },
  );

  // 'é' is 2 UTF-8 bytes / 1 scalar, '😀' is 4 bytes / 1 scalar.
  assert.equal(locator.range.byte.start, 6);
  assert.equal(locator.range.char.start, 2);
  assert.equal(locator.range.column.start, 2);
});

test('buildSnippet is exposed through buildLocator and truncates around long text', () => {
  let content = 'x'.repeat(100) + 'needle' + 'y'.repeat(100);
  let start = content.indexOf('needle');
  let locator = buildLocator(
    content,
    { start, end: start + 'needle'.length },
    'needle',
    0,
    { snippetChars: 10, contextLines: 0 },
  );

  assert.ok(locator.snippet.text.length < content.length);
  assert.equal(locator.snippet.truncated_before, true);
  assert.equal(locator.snippet.truncated_after, true);
  assert.ok(locator.snippet.text.includes('needle'));
});

test('contentHash is a stable SHA-256 of the serialized body', () => {
  let hash = contentHash('{"a":1}');
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(contentHash('{"a":1}'), hash);
  assert.notEqual(contentHash('{"a":2}'), hash);
});
