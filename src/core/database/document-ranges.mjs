'use strict';

// Driver-agnostic ranged document fetch. Ranges are extracted in JS from an
// already-fetched stored body so the line/char/byte/JSON-pointer semantics are
// explicit and identical across drivers, matching the AeorDB range contract:
//   - lines: 1-based inclusive, CRLF-aware, max_bytes-capped
//   - chars: 0-based inclusive start, exclusive end, Unicode scalars
//   - bytes: 0-based inclusive start, exclusive end, UTF-8, lossy decode
//   - json_pointer: RFC 6901 pointer into the parsed stored JSON
//
// `readDocument(path)` returns `{ body, raw, updated_at }` for a stored
// document or `null` when it does not exist. Drivers supply that reader; this
// module owns every byte/line decision.

import { DatabaseError } from './database-error.mjs';
import { invalidRange, staleDocument } from './document-errors.mjs';
import { basename, normalizePath } from './document-utils.mjs';
import { byteLength, contentHash } from './document-text-utils.mjs';

const DEFAULT_RANGE_MAX_BYTES = 4 * 1024 * 1024;
const ABSOLUTE_RANGE_MAX_BYTES = 16 * 1024 * 1024;

export async function fetchDocumentRanges(readDocument, items, options = {}) {
  if (typeof readDocument !== 'function')
    throw new TypeError('fetchDocumentRanges() requires a readDocument(path) function');
  if (!Array.isArray(items))
    throw new TypeError('getRanges() items must be an array');

  let continueOnError = options.continueOnError === true || options.continue_on_error === true;
  let defaultMaxBytes = options.maxBytes ?? options.max_bytes;
  let results = [];
  let hasErrors = false;

  for (let item of items) {
    try {
      results.push(await fetchOneRange(readDocument, item, defaultMaxBytes));
    } catch (error) {
      if (!continueOnError)
        throw error;

      hasErrors = true;
      results.push(rangeErrorItem(item, error));
    }
  }

  return { items: results, has_errors: hasErrors };
}

async function fetchOneRange(readDocument, item, defaultMaxBytes) {
  if (!item || typeof item !== 'object' || Array.isArray(item))
    throw invalidRange('getRanges() items must be objects');
  if (!item.path || typeof item.path !== 'string')
    throw invalidRange('getRanges() item.path must be a non-empty string');

  let path = normalizePath(item.path);
  let row = await readDocument(path);
  if (!row)
    throw DatabaseError.notFound(path);

  let body = row.body;
  let hash = contentHash(body);
  let updatedAt = Number(row.updated_at);
  if (item.if_content_hash != null && String(item.if_content_hash) !== hash)
    throw staleDocument('File content hash changed');
  if (item.if_updated_at != null && Number(item.if_updated_at) !== updatedAt)
    throw staleDocument('File updated_at changed');

  let range = normalizeRangeSpec(item);
  let maxBytes = item.max_bytes ?? item.maxBytes ?? defaultMaxBytes;
  let extracted = extractRange(body, range, maxBytes);

  return {
    id: item.id ?? null,
    path,
    name: basename(path),
    size: byteLength(body),
    created_at: updatedAt,
    updated_at: updatedAt,
    content_hash: hash,
    content_type: row.raw ? 'text/plain' : 'application/json',
    range: {
      mode: extracted.mode,
      start: extracted.start,
      end: extracted.end,
      pointer: extracted.pointer,
    },
    source_size: byteLength(body),
    content: extracted.content,
    truncated: extracted.truncated,
    status: 'ok',
  };
}

function normalizeRangeSpec(item) {
  let range = item.range && typeof item.range === 'object' ? item.range : item;
  let mode = String(range.mode || range.type || '').trim();
  if (mode === 'line')
    mode = 'lines';
  if (mode === 'char')
    mode = 'chars';
  if (mode === 'byte')
    mode = 'bytes';
  if (mode === 'jsonPointer')
    mode = 'json_pointer';
  if (![ 'lines', 'chars', 'bytes', 'json_pointer' ].includes(mode))
    throw invalidRange('range mode must be lines, chars, bytes, or json_pointer');

  let output = { mode };
  if (mode === 'json_pointer') {
    let pointer = range.pointer ?? range.json_pointer ?? range.jsonPointer;
    if (typeof pointer !== 'string' || pointer === '')
      throw invalidRange('json_pointer range requires pointer');
    output.pointer = pointer;
    return output;
  }

  if (range.start != null)
    output.start = normalizeNonNegativeInteger(range.start, 'start');
  if (range.end != null)
    output.end = normalizeNonNegativeInteger(range.end, 'end');
  return output;
}

function extractRange(text, range, maxBytes) {
  let limit = normalizeMaxBytes(maxBytes);
  if (range.mode === 'lines')
    return extractLines(text, range.start ?? 1, range.end ?? null, limit);
  if (range.mode === 'chars')
    return extractChars(text, range.start ?? 0, range.end ?? null, limit);
  if (range.mode === 'bytes')
    return extractBytes(text, range.start ?? 0, range.end ?? null, limit);
  return extractJSONPointer(text, range.pointer, limit);
}

// A CR is held until we know whether an LF follows, so CRLF counts as one
// break and the newline is attributed to the line it terminates (matching the
// AeorDB line extractor).
function extractLines(text, start, end, limit) {
  if (start < 1)
    throw invalidRange('Line ranges are 1-based; start must be at least 1');
  if (end != null && end < start)
    throw invalidRange('Range end must be greater than or equal to start');

  let out = '';
  let truncated = false;
  let currentLine = 1;
  let pendingCR = false;
  let pendingCRSelected = false;

  for (let index = 0; index < text.length; ) {
    let codePoint = text.codePointAt(index);
    let character = String.fromCodePoint(codePoint);
    index += character.length;

    if (pendingCR) {
      if (character === '\n') {
        if (pendingCRSelected && !pushLimited(out, character, limit)) {
          truncated = true;
          break;
        }
        currentLine++;
        pendingCR = false;
        if (end != null && currentLine > end)
          break;
        continue;
      }

      currentLine++;
      pendingCR = false;
      if (end != null && currentLine > end)
        break;
    }

    let selected = currentLine >= start && (end == null || currentLine <= end);
    if (selected) {
      if (!pushLimited(out, character, limit)) {
        truncated = true;
        break;
      }
      out += character;
    }

    if (character === '\r') {
      pendingCR = true;
      pendingCRSelected = selected;
    } else if (character === '\n') {
      currentLine++;
      if (end != null && currentLine > end)
        break;
    }
  }

  return { mode: 'lines', content: out, truncated, start, end: end ?? null, pointer: null };
}

function extractChars(text, start, end, limit) {
  if (end != null && end < start)
    throw invalidRange('Range end must be greater than or equal to start');

  let out = '';
  let truncated = false;
  let current = 0;

  for (let index = 0; index < text.length; ) {
    if (end != null && current >= end)
      break;

    let codePoint = text.codePointAt(index);
    let character = String.fromCodePoint(codePoint);
    index += character.length;

    if (current >= start) {
      if (!pushLimited(out, character, limit)) {
        truncated = true;
        break;
      }
      out += character;
    }
    current++;
  }

  return { mode: 'chars', content: out, truncated, start, end: end ?? null, pointer: null };
}

function extractBytes(text, start, end, limit) {
  if (end != null && end < start)
    throw invalidRange('Range end must be greater than or equal to start');

  let buffer = Buffer.from(text, 'utf8');
  let clampedStart = Math.min(start, buffer.length);
  let clampedEnd = end == null ? buffer.length : Math.min(end, buffer.length);
  if (clampedEnd < clampedStart)
    clampedEnd = clampedStart;

  let slice = buffer.subarray(clampedStart, clampedEnd);
  let truncated = false;
  if (slice.length > limit) {
    slice = slice.subarray(0, limit);
    truncated = true;
  }

  return { mode: 'bytes', content: slice.toString('utf8'), truncated, start, end: end ?? null, pointer: null };
}

function extractJSONPointer(text, pointer, limit) {
  if (typeof pointer !== 'string' || pointer === '')
    throw invalidRange('json_pointer range requires pointer');

  let value;
  try {
    value = JSON.parse(text);
  } catch (_error) {
    throw invalidRange('Stored file is not valid JSON');
  }

  let selected = resolveJSONPointer(value, pointer);
  if (selected === undefined)
    throw invalidRange(`JSON pointer not found: ${pointer}`);

  let raw = typeof selected === 'string' ? selected : JSON.stringify(selected);
  let truncated = false;
  if (byteLength(raw) > limit) {
    raw = truncateUTF8(raw, limit);
    truncated = true;
  }

  return { mode: 'json_pointer', content: raw, truncated, start: null, end: null, pointer };
}

function resolveJSONPointer(value, pointer) {
  if (pointer === '')
    return value;
  if (!pointer.startsWith('/'))
    return undefined;

  let current = value;
  for (let segment of pointer.slice(1).split('/')) {
    let key = segment.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/.test(key))
        return undefined;
      current = current[Number(key)];
    } else if (current && typeof current === 'object') {
      if (!Object.prototype.hasOwnProperty.call(current, key))
        return undefined;
      current = current[key];
    } else {
      return undefined;
    }

    if (current === undefined)
      return undefined;
  }

  return current;
}

function rangeErrorItem(item, error) {
  let rawPath = item && typeof item.path === 'string' ? normalizePath(item.path) : null;
  return {
    id: item?.id ?? null,
    path: rawPath,
    status: error.code === 'not_found' ? 'not_found' : error.code === 'conflict' ? 'stale' : 'invalid',
    message: error.message,
  };
}

function normalizeMaxBytes(value) {
  if (value == null)
    return DEFAULT_RANGE_MAX_BYTES;

  let number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > ABSOLUTE_RANGE_MAX_BYTES)
    throw invalidRange(`Invalid max_bytes: must be between 1 and ${ABSOLUTE_RANGE_MAX_BYTES}`);

  return number;
}

function normalizeNonNegativeInteger(value, fieldName) {
  let number = Number(value);
  if (!Number.isInteger(number) || number < 0)
    throw invalidRange(`${fieldName} must be a non-negative integer`);

  return number;
}

function pushLimited(out, character, limit) {
  return byteLength(out) + byteLength(character) <= limit;
}

function truncateUTF8(text, maxBytes) {
  let buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= maxBytes)
    return text;

  let end = maxBytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80)
    end--;

  return buffer.subarray(0, end).toString('utf8');
}
