'use strict';

// Locator construction shared by every driver. Locators are computed in JS over
// the stored serialized body so byte/line/char semantics stay explicit and
// testable, independent of whatever SQL or scan selected the candidates.
// The shapes mirror the AeorDB locator contract: 1-based lines, UTF-8 byte
// offsets, Unicode-scalar char/column offsets, and a `fetch` hint spanning a
// snippet around the match.

import { byteLength, contentHash } from './document-text-utils.mjs';

export { contentHash };

// Case-insensitive substring scan. `String.prototype.toLowerCase` can change
// a string's length for a handful of exotic code points, which would skew the
// offsets below; the ASCII/Unicode ranges Kikx searches (identifiers,
// log/JSON text) are length-preserving, and the numeric offsets are documented
// as driver-local anyway.
export function findMatchRanges(content, query, maxMatches) {
  let lowerContent = content.toLowerCase();
  let lowerQuery = query.toLowerCase();
  let ranges = [];
  if (lowerQuery === '')
    return ranges;

  let from = 0;
  while (ranges.length < maxMatches) {
    let start = lowerContent.indexOf(lowerQuery, from);
    if (start === -1)
      break;

    ranges.push({ start, end: start + lowerQuery.length });
    from = start + lowerQuery.length;
  }

  return ranges;
}

export function buildLocator(content, range, query, index, options) {
  let matchedText = content.slice(range.start, range.end);
  let byteStart = byteLength(content.slice(0, range.start));
  let byteEnd = byteStart + byteLength(matchedText);
  let lineInfo = lineInfoForOffset(content, range.start);
  let matchCharLen = codePointCount(matchedText);
  let snippet = buildSnippet(content, range.start, range.end, options.snippetChars);
  let contextLines = options.contextLines;

  return {
    id: `m_${String(index + 1).padStart(4, '0')}`,
    query,
    matched_text: matchedText,
    score: 1,
    field: '@content',
    operator: 'match',
    source: 'content',
    range: {
      byte: { start: byteStart, end: byteEnd, unit: 'utf8-byte', basis: 'stored-file' },
      char: {
        start: lineInfo.globalChar,
        end: lineInfo.globalChar + matchCharLen,
        unit: 'unicode-scalar',
        basis: 'stored-file-text',
      },
      line: { start: lineInfo.line, end: lineInfo.line, unit: 'line', basis: 'stored-file-text' },
      column: { start: lineInfo.column, end: lineInfo.column + matchCharLen, unit: 'unicode-scalar', basis: 'line' },
    },
    fetch: {
      preferred: 'line_range',
      line_range: {
        start: Math.max(1, lineInfo.line - contextLines),
        end: lineInfo.line + contextLines,
      },
      byte_range: snippet.byte_range,
      char_range: {
        start: lineInfo.globalChar,
        end: lineInfo.globalChar + matchCharLen,
      },
    },
    snippet: snippet.snippet,
    confidence: 'exact',
    scan_status: 'complete',
  };
}

export function buildSnippet(text, matchStart, matchEnd, snippetChars) {
  let beforeChars = Math.trunc(snippetChars / 2);
  let afterChars = snippetChars - beforeChars;
  let snippetStart = moveByChars(text, matchStart, -beforeChars);
  let snippetEnd = moveByChars(text, matchEnd, afterChars);
  let highlightStart = codePointCount(text.slice(snippetStart, matchStart));
  let highlightEnd = highlightStart + codePointCount(text.slice(matchStart, matchEnd));

  return {
    byte_range: {
      start: byteLength(text.slice(0, snippetStart)),
      end: byteLength(text.slice(0, snippetEnd)),
    },
    snippet: {
      text: text.slice(snippetStart, snippetEnd),
      highlight: [ { start: highlightStart, end: highlightEnd, unit: 'unicode-scalar' } ],
      truncated_before: snippetStart > 0,
      truncated_after: snippetEnd < text.length,
    },
  };
}

// Line/column/global-scalar position of a code-unit offset. CRLF is counted as
// a single line break, matching the stored-file line semantics used by ranged
// fetch (a lone LF still breaks the line).
export function lineInfoForOffset(content, offset) {
  let line = 1;
  let column = 0;
  let globalChar = 0;
  let index = 0;

  while (index < offset) {
    let codePoint = content.codePointAt(index);
    let character = String.fromCodePoint(codePoint);
    index += character.length;
    globalChar++;

    if (codePoint === 13) {
      if (content[index] === '\n')
        index++;
      line++;
      column = 0;
    } else if (codePoint === 10) {
      line++;
      column = 0;
    } else {
      column++;
    }
  }

  return { line, column, globalChar };
}

// Move `amount` Unicode scalars from a code-unit offset, clamped to the string.
export function moveByChars(text, index, amount) {
  if (amount === 0)
    return index;

  if (amount < 0) {
    let positions = [];
    for (let cursor = 0; cursor < index; ) {
      positions.push(cursor);
      let codePoint = text.codePointAt(cursor);
      cursor += codePoint > 0xffff ? 2 : 1;
    }

    let target = positions.length + amount;
    return target < 0 ? 0 : positions[target];
  }

  let cursor = index;
  for (let step = 0; step < amount && cursor < text.length; step++) {
    let codePoint = text.codePointAt(cursor);
    cursor += codePoint > 0xffff ? 2 : 1;
  }

  return cursor;
}

export function codePointCount(text) {
  let count = 0;
  for (let index = 0; index < text.length; ) {
    let codePoint = text.codePointAt(index);
    index += codePoint > 0xffff ? 2 : 1;
    count++;
  }

  return count;
}
