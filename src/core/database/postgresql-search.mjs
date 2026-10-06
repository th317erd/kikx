'use strict';

// PostgreSQL search and structured query.
//
// The driver keeps documents in a `documents(path, body, raw, updated_at)`
// table. Candidate selection happens in SQL over a `jsonb` view of non-raw
// documents (so malformed/raw bodies are excluded from structured filters),
// while locators are built in JS from the selected bodies. All user input is
// passed as bound parameters; only identifiers we control appear in SQL text.

import { normalizePath } from './document-utils.mjs';
import { buildLocator, findMatchRanges } from './postgresql-locators.mjs';
import {
  byteLength,
  clampInteger,
  contentHash,
  invalidQuery,
  normalizeOptionalString,
} from './postgresql-utils.mjs';

const DEFAULT_SEARCH_LIMIT = 20;
const MAX_SEARCH_LIMIT = 1000;
const DEFAULT_MATCHES_PER_RESULT = 5;
const HARD_MAX_MATCHES_PER_RESULT = 50;
const DEFAULT_SNIPPET_CHARS = 160;
const HARD_MAX_SNIPPET_CHARS = 4096;
const DEFAULT_MATCH_CONTEXT_LINES = 2;
const MAX_MATCH_CONTEXT_LINES = 100;

// `raw` documents were not necessarily valid JSON, so the jsonb cast is only
// evaluated for non-raw rows. CASE guarantees the untaken branch is never
// evaluated, which is what keeps a malformed/raw body from throwing.
const JSON_DOC = '(CASE WHEN raw THEN NULL ELSE body::jsonb END)';

// Best-effort search acceleration. `pg_trgm` is optional and may not be
// installable by the connecting role; failures are swallowed so search still
// works (just without the GIN index / similarity score). Returns whether the
// extension is available.
export async function ensureSearchIndexes(pool) {
  try {
    await pool.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    await pool.query('CREATE INDEX IF NOT EXISTS documents_body_trgm_idx ON documents USING gin (body gin_trgm_ops)');
    return true;
  } catch (_error) {
    return false;
  }
}

// --- search ----------------------------------------------------------------

export async function searchDocuments(pool, request = {}, options = {}) {
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

  let params = [ ...pathBounds(base) ];
  let clauses = [ 'path COLLATE "C" >= $1', 'path COLLATE "C" < $2' ];

  let queryParamIndex = null;
  if (query) {
    params.push(query.toLowerCase());
    queryParamIndex = params.length;
    clauses.push(`strpos(lower(body), $${queryParamIndex}) > 0`);
  }
  if (where)
    clauses.push(buildWhereSQL(where, params));

  let whereSQL = clauses.join(' AND ');
  let scoreSelect = (options.trigram && queryParamIndex) ? `, similarity(body, $${queryParamIndex}) AS trgm_score` : '';
  let countSQL = `SELECT count(*)::bigint AS total FROM documents WHERE ${whereSQL}`;
  let pageSQL = `SELECT path, body, raw, updated_at${scoreSelect} FROM documents WHERE ${whereSQL} `
    + `ORDER BY path COLLATE "C" LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;

  let [ countResult, pageResult ] = await Promise.all([
    pool.query(countSQL, params),
    pool.query(pageSQL, [ ...params, limit, offset ]),
  ]);

  let total = Number(countResult.rows[0]?.total ?? 0);
  let results = pageResult.rows.map((row) => buildSearchResult(row, query, locatorOptions));

  return {
    results,
    total_count: total,
    has_more: offset + results.length < total,
    next_cursor: null,
    prev_cursor: null,
  };
}

function buildSearchResult(row, query, options) {
  let body = row.body;
  let ranges = options.includeMatches && query ? findMatchRanges(body, query, options.maxMatches) : [];
  let matches = ranges.map((range, index) => buildLocator(body, range, query, index, options));
  let similarityScore = Number(row.trgm_score);

  return {
    path: row.path,
    score: matches.length + (Number.isFinite(similarityScore) ? similarityScore : 0),
    matched_by: matches.length > 0 ? [ 'content' ] : [],
    content_hash: contentHash(body),
    updated_at: Number(row.updated_at),
    size: byteLength(body),
    content_type: row.raw ? 'text/plain' : 'application/json',
    matches,
    matches_truncated: false,
    locator_status: matches.length > 0 ? 'complete' : 'unsupported',
  };
}

// --- query -----------------------------------------------------------------

export async function queryDocuments(pool, request = {}) {
  let base = normalizePath(request.path || '/');
  let where = request.where ?? null;
  if (!where)
    throw invalidQuery('query requires where');

  let limit = clampInteger(request.limit, DEFAULT_SEARCH_LIMIT, 1, MAX_SEARCH_LIMIT);
  let offset = clampInteger(request.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  let select = Array.isArray(request.select) && request.select.length > 0 ? request.select : null;

  let params = [ ...pathBounds(base) ];
  let clauses = [ 'path COLLATE "C" >= $1', 'path COLLATE "C" < $2' ];
  clauses.push(buildWhereSQL(where, params));
  let whereSQL = clauses.join(' AND ');

  let countSQL = `SELECT count(*)::bigint AS total FROM documents WHERE ${whereSQL}`;
  let pageSQL = `SELECT path, body, raw, updated_at FROM documents WHERE ${whereSQL} `
    + `ORDER BY path COLLATE "C" LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;

  let [ countResult, pageResult ] = await Promise.all([
    pool.query(countSQL, params),
    pool.query(pageSQL, [ ...params, limit, offset ]),
  ]);

  let total = Number(countResult.rows[0]?.total ?? 0);
  let projection = select ? select.map(mapSelectField) : null;
  let results = pageResult.rows.map((row) => projectQueryItem(row, projection));

  return {
    results,
    total_count: total,
    has_more: offset + results.length < total,
    next_cursor: null,
    prev_cursor: null,
  };
}

function projectQueryItem(row, projection) {
  let meta = {
    path: row.path,
    size: byteLength(row.body),
    content_type: row.raw ? 'text/plain' : 'application/json',
    updated_at: Number(row.updated_at),
    content_hash: contentHash(row.body),
    score: 1,
    matched_by: [],
  };

  if (!projection)
    return meta;

  let item = {};
  for (let field of projection) {
    if (field === 'path')
      item.path = row.path;
    else if (field === 'updated_at')
      item.updated_at = Number(row.updated_at);
    else if (field === 'size')
      item.size = meta.size;
    else if (field === 'content_type')
      item.content_type = meta.content_type;
    else if (field === 'content_hash')
      item.content_hash = meta.content_hash;
    else if (field === 'score')
      item.score = 1;
    else if (field === 'matched_by')
      item.matched_by = [];
    else
      item[field] = readDocumentField(row, field);
  }

  return item;
}

function readDocumentField(row, field) {
  if (row.raw)
    return undefined;

  try {
    let value = JSON.parse(row.body);
    return value && typeof value === 'object' ? value[field] : undefined;
  } catch (_error) {
    return undefined;
  }
}

function mapSelectField(name) {
  let value = String(name);
  if (!value.startsWith('@'))
    return value;

  return VIRTUAL_FIELDS[value] || value.slice(1);
}

const VIRTUAL_FIELDS = {
  '@path': 'path',
  '@size': 'size',
  '@content_type': 'content_type',
  '@created_at': 'created_at',
  '@updated_at': 'updated_at',
  '@content_hash': 'content_hash',
  '@matched_by': 'matched_by',
  '@score': 'score',
  '@file_key': 'file_key',
  '@record_revision': 'record_revision',
  '@matches': 'matches',
};

// --- where -> SQL ----------------------------------------------------------

export function buildWhereSQL(where, params) {
  if (where == null)
    return 'TRUE';

  if (Array.isArray(where))
    return where.length === 0 ? 'TRUE' : `(${where.map((child) => buildWhereSQL(child, params)).join(' AND ')})`;

  if (typeof where !== 'object')
    throw invalidQuery('where must be an object');

  if (Array.isArray(where.and))
    return where.and.length === 0 ? 'TRUE' : `(${where.and.map((child) => buildWhereSQL(child, params)).join(' AND ')})`;

  if (Array.isArray(where.or))
    return where.or.length === 0 ? 'FALSE' : `(${where.or.map((child) => buildWhereSQL(child, params)).join(' OR ')})`;

  if (where.not != null)
    return `(NOT ${buildWhereSQL(where.not, params)})`;

  return buildConditionSQL(where, params);
}

function buildConditionSQL(condition, params) {
  let { field, op, value } = condition;
  if (typeof field !== 'string' || field === '')
    throw invalidQuery('where condition requires a non-empty field');
  if (typeof op !== 'string' || op === '')
    throw invalidQuery('where condition requires an operator');

  let fieldParam = addParam(params, field);
  let json = `(${JSON_DOC} -> ${fieldParam})`;
  let text = `(${JSON_DOC} ->> ${fieldParam})`;

  switch (op) {
    case 'eq':
      return `${json} = ${jsonParam(params, value)}`;
    case 'ne':
      return `${json} IS DISTINCT FROM ${jsonParam(params, value)}`;
    case 'gt':
      return `${json} > ${jsonParam(params, value)}`;
    case 'gte':
      return `${json} >= ${jsonParam(params, value)}`;
    case 'lt':
      return `${json} < ${jsonParam(params, value)}`;
    case 'lte':
      return `${json} <= ${jsonParam(params, value)}`;
    case 'in': {
      if (!Array.isArray(value))
        throw invalidQuery('where op "in" requires an array value');
      return `${json} IN (SELECT value FROM jsonb_array_elements(${addParam(params, JSON.stringify(value))}::jsonb))`;
    }
    case 'contains':
      return `strpos(${text}, ${addParam(params, String(value ?? ''))}) > 0`;
    case 'prefix':
      return `starts_with(${text}, ${addParam(params, String(value ?? ''))})`;
    case 'exists':
      return `(${JSON_DOC} ? ${fieldParam})`;
    default:
      throw invalidQuery(`unsupported where operator: ${op}`);
  }
}

function jsonParam(params, value) {
  return `${addParam(params, JSON.stringify(value ?? null))}::jsonb`;
}

function addParam(params, value) {
  params.push(value);
  return `$${params.length}`;
}

// --- shared helpers --------------------------------------------------------

function pathBounds(base) {
  // `/` is the only prefix whose `base + '/'` sentinel would not be the lower
  // bound of its descendants; every absolute path already starts with `/`.
  if (base === '/')
    return [ '/', '0' ];
  return [ `${base}/`, `${base}0` ];
}
