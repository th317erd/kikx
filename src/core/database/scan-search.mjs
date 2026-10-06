'use strict';

// Generic scan-backed search/query for drivers without a searchable index
// (plan §D2). Candidates come from the driver's streaming `entries(prefix)`
// and `getMany(paths)` contract, so whole tables are never materialized into a
// single array: paths are read and documents loaded in bounded batches, and
// each document is matched and turned into locators one at a time.
//
// The envelope, locator shape, and (where supported) the `where` operators are
// shared with the PostgreSQL indexed path through `document-results.mjs`.
//
// `where` subset evaluated here mirrors the PostgreSQL `buildWhereSQL` dialect:
//   - combinators:  `{ and: [...] }`, `{ or: [...] }`, `{ not: {...} }`, or an
//                   array (implicit AND)
//   - conditions:   `{ field, op, value }`
//   - operators:    eq, ne, gt, gte, lt, lte, in, contains, prefix, exists
// Numeric/string comparisons use natural JS ordering; JSON (jsonb) type-crossing
// ordering is not reproduced (documented limitation, D8 shape+usability parity).

import { normalizePath } from './document-utils.mjs';
import { buildSearchResult, projectQueryItem, resolveProjection } from './document-results.mjs';
import { invalidQuery } from './document-errors.mjs';
import { byteLength, clampInteger, normalizeOptionalString } from './document-text-utils.mjs';
import { findMatchRanges } from './document-locators.mjs';

const DEFAULT_SEARCH_LIMIT = 20;
const MAX_SEARCH_LIMIT = 1000;
const DEFAULT_MATCHES_PER_RESULT = 5;
const HARD_MAX_MATCHES_PER_RESULT = 50;
const DEFAULT_SNIPPET_CHARS = 160;
const HARD_MAX_SNIPPET_CHARS = 4096;
const DEFAULT_MATCH_CONTEXT_LINES = 2;
const MAX_MATCH_CONTEXT_LINES = 100;

// How many candidate paths we fetch bodies for at once. Bounds memory while
// keeping the number of round-trips per scan reasonable.
const READ_BATCH_SIZE = 100;

export async function scanSearch(source, request = {}) {
  let base = normalizePath(request.path || '/');
  let query = normalizeOptionalString(request.query);
  let where = request.where ?? null;
  if (!query && !where)
    throw invalidQuery('search requires query or where');

  let includeMatches = request.include_matches === true;
  let limit = clampInteger(request.limit, DEFAULT_SEARCH_LIMIT, 1, MAX_SEARCH_LIMIT);
  let offset = clampInteger(request.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  let maxMatches = clampInteger(request.max_matches_per_result, DEFAULT_MATCHES_PER_RESULT, 1, HARD_MAX_MATCHES_PER_RESULT);
  let snippetChars = clampInteger(request.snippet_chars, DEFAULT_SNIPPET_CHARS, 16, HARD_MAX_SNIPPET_CHARS);
  let contextLines = clampInteger(request.match_context_lines, DEFAULT_MATCH_CONTEXT_LINES, 0, MAX_MATCH_CONTEXT_LINES);
  let locatorOptions = { includeMatches, maxMatches, snippetChars, contextLines };
  let maxScanBytes = normalizeMaxScanBytes(request.max_locator_scan_bytes);
  if (where)
    validateWhere(where);

  let scannedBytes = 0;
  let matched = 0;
  let results = [];
  let truncated = false;

  await forEachCandidate(source, base, (document) => {
    if (maxScanBytes != null && scannedBytes >= maxScanBytes) {
      truncated = true;
      return false;
    }

    scannedBytes += byteLength(document.body);
    if (where && !evaluateWhere(parseDocument(document), where))
      return true;

    if (query && findMatchRanges(document.body, query, 1).length === 0)
      return true;

    let index = matched++;
    if (index >= offset && results.length < limit)
      results.push(buildSearchResult(document, query, locatorOptions));

    return true;
  });

  // When `max_locator_scan_bytes` stops the scan early, `total_count` reflects
  // only the documents examined so far and `has_more` is forced true: the cap
  // trades an exact total for a bounded amount of I/O, which is the point of
  // the option. Without a cap every candidate is examined for an exact total.
  return {
    results,
    total_count: matched,
    has_more: truncated || offset + results.length < matched,
    next_cursor: null,
    prev_cursor: null,
  };
}

export async function scanQuery(source, request = {}) {
  let base = normalizePath(request.path || '/');
  let where = request.where ?? null;
  if (!where)
    throw invalidQuery('query requires where');

  let limit = clampInteger(request.limit, DEFAULT_SEARCH_LIMIT, 1, MAX_SEARCH_LIMIT);
  let offset = clampInteger(request.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  let projection = resolveProjection(request.select);
  validateWhere(where);

  let matched = 0;
  let results = [];
  await forEachCandidate(source, base, (document) => {
    if (!evaluateWhere(parseDocument(document), where))
      return true;

    let index = matched++;
    if (index >= offset && results.length < limit)
      results.push(projectQueryItem(document, projection));

    return true;
  });

  return {
    results,
    total_count: matched,
    has_more: offset + results.length < matched,
    next_cursor: null,
    prev_cursor: null,
  };
}

// Eagerly validate a `where` expression. PostgreSQL builds SQL up front, so a
// malformed condition throws even when no documents match; the scan path must
// validate before iterating so its failure mode is identical instead of only
// surfacing on the first (or any) candidate.
export function validateWhere(where) {
  if (where == null)
    return;

  if (Array.isArray(where)) {
    for (let child of where)
      validateWhere(child);
    return;
  }

  if (typeof where !== 'object')
    throw invalidQuery('where must be an object');

  if (Array.isArray(where.and)) {
    for (let child of where.and)
      validateWhere(child);
    return;
  }

  if (Array.isArray(where.or)) {
    for (let child of where.or)
      validateWhere(child);
    return;
  }

  if (where.not != null) {
    validateWhere(where.not);
    return;
  }

  let { field, op, value } = where;
  if (typeof field !== 'string' || field === '')
    throw invalidQuery('where condition requires a non-empty field');
  if (typeof op !== 'string' || op === '')
    throw invalidQuery('where condition requires an operator');
  if (!SUPPORTED_OPERATORS.has(op))
    throw invalidQuery(`unsupported where operator: ${op}`);
  if (op === 'in' && !Array.isArray(value))
    throw invalidQuery('where op "in" requires an array value');
}

const SUPPORTED_OPERATORS = new Set([ 'eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'contains', 'prefix', 'exists' ]);

// Evaluate the supported `where` subset against a parsed JSON document. `null`
// (raw or unparseable body) never matches a field condition, mirroring the
// PostgreSQL `jsonb` NULL semantics.
export function evaluateWhere(document, where) {
  if (where == null)
    return true;

  if (Array.isArray(where))
    return where.length === 0 ? true : where.every((child) => evaluateWhere(document, child));

  if (typeof where !== 'object')
    throw invalidQuery('where must be an object');

  if (Array.isArray(where.and))
    return where.and.length === 0 ? true : where.and.every((child) => evaluateWhere(document, child));

  if (Array.isArray(where.or))
    return where.or.length === 0 ? false : where.or.some((child) => evaluateWhere(document, child));

  if (where.not != null)
    return !evaluateWhere(document, where.not);

  return evaluateCondition(document, where);
}

function evaluateCondition(document, condition) {
  let { field, op, value } = condition;
  if (typeof field !== 'string' || field === '')
    throw invalidQuery('where condition requires a non-empty field');
  if (typeof op !== 'string' || op === '')
    throw invalidQuery('where condition requires an operator');

  let present = Boolean(document) && typeof document === 'object' && !Array.isArray(document)
    && Object.prototype.hasOwnProperty.call(document, field);
  let actual = present ? document[field] : undefined;

  switch (op) {
    case 'eq':
      return deepEqual(actual, value ?? null);
    case 'ne':
      return !deepEqual(actual, value ?? null);
    case 'gt':
      return compareValues(actual, value) > 0;
    case 'gte':
      return compareValues(actual, value) >= 0;
    case 'lt':
      return compareValues(actual, value) < 0;
    case 'lte':
      return compareValues(actual, value) <= 0;
    case 'in':
      if (!Array.isArray(value))
        throw invalidQuery('where op "in" requires an array value');
      return value.some((candidate) => deepEqual(actual, candidate));
    case 'contains':
      return present && actual != null && toText(actual).includes(String(value ?? ''));
    case 'prefix':
      return present && actual != null && toText(actual).startsWith(String(value ?? ''));
    case 'exists':
      return present;
    default:
      throw invalidQuery(`unsupported where operator: ${op}`);
  }
}

// Iterate every descendant path under `base` in bounded batches and hand each
// loaded document to `visit`. Returning `false` from `visit` stops the scan.
async function forEachCandidate(source, base, visit) {
  let batch = [];
  let stopped = false;

  for await (let entry of source.entries(base, { recursive: true, glob: '**' })) {
    batch.push(entry.path);
    if (batch.length < READ_BATCH_SIZE)
      continue;

    stopped = !(await visitBatch(source, batch, visit));
    batch = [];
    if (stopped)
      break;
  }

  if (!stopped && batch.length > 0)
    await visitBatch(source, batch, visit);
}

async function visitBatch(source, paths, visit) {
  let documents = await source.getMany(paths);
  for (let path of paths) {
    let entry = documents[path];
    if (!entry)
      continue;

    let document = toDocument(entry, path);
    if (await visit(document) === false)
      return false;
  }

  return true;
}

function toDocument(entry, path) {
  let body = typeof entry.content === 'string' ? entry.content : JSON.stringify(entry.content ?? null);
  return {
    path: entry.path || path,
    body,
    raw: entry.raw === true || entry.raw === 1,
    updated_at: Number(entry.updated_at ?? 0),
  };
}

function parseDocument(document) {
  if (document.raw)
    return null;

  try {
    return JSON.parse(document.body);
  } catch (_error) {
    return null;
  }
}

function normalizeMaxScanBytes(value) {
  if (value == null)
    return null;

  let number = Number(value);
  if (!Number.isInteger(number) || number < 1)
    throw invalidQuery('max_locator_scan_bytes must be a positive integer');

  return number;
}

function deepEqual(left, right) {
  if (left === right)
    return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object')
    return false;
  if (Array.isArray(left) !== Array.isArray(right))
    return false;

  if (Array.isArray(left)) {
    if (left.length !== right.length)
      return false;
    return left.every((item, index) => deepEqual(item, right[index]));
  }

  let leftKeys = Object.keys(left);
  let rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length)
    return false;

  return leftKeys.every((key) => Object.prototype.hasOwnProperty.call(right, key) && deepEqual(left[key], right[key]));
}

// Ordered comparison for the range operators. Returns NaN for value pairs we
// cannot order (missing field, mixed types); every NaN comparison is then false,
// which matches SQL's "NULL comparison is not true".
function compareValues(actual, value) {
  if (actual == null)
    return NaN;
  if (typeof actual === 'number' && typeof value === 'number')
    return actual - value;
  if (typeof actual === 'string' && typeof value === 'string')
    return actual < value ? -1 : actual > value ? 1 : 0;

  return NaN;
}

function toText(value) {
  if (typeof value === 'string')
    return value;
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value);

  return JSON.stringify(value);
}
