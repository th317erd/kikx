'use strict';

// Shared result shaping for search and structured query. The indexed
// PostgreSQL path and the streaming scan path both build their envelopes
// through here, so the result shape cannot drift between drivers.

import { buildLocator, findMatchRanges } from './document-locators.mjs';
import { byteLength, contentHash } from './document-text-utils.mjs';

// `document` is `{ path, body, raw, updated_at, trgmScore? }`. `trgmScore` is
// the optional PostgreSQL trigram similarity; scan-backed drivers omit it and
// score purely on locator hits, exactly as PostgreSQL does without pg_trgm.
export function buildSearchResult(document, query, options) {
  let body = document.body;
  let ranges = options.includeMatches && query ? findMatchRanges(body, query, options.maxMatches) : [];
  let matches = ranges.map((range, index) => buildLocator(body, range, query, index, options));
  let similarityScore = Number(document.trgmScore);

  return {
    path: document.path,
    score: matches.length + (Number.isFinite(similarityScore) ? similarityScore : 0),
    matched_by: matches.length > 0 ? [ 'content' ] : [],
    content_hash: contentHash(body),
    updated_at: Number(document.updated_at),
    size: byteLength(body),
    content_type: document.raw ? 'text/plain' : 'application/json',
    matches,
    matches_truncated: false,
    locator_status: matches.length > 0 ? 'complete' : 'unsupported',
  };
}

// Map a `select` request list to concrete projection fields, or `null` when the
// caller did not ask for a projection. `@`-prefixed names are virtual fields.
export function resolveProjection(select) {
  if (!Array.isArray(select) || select.length === 0)
    return null;

  return select.map(mapSelectField);
}

// `row` is `{ path, body, raw, updated_at }`. With no projection this returns
// the full search-item metadata; otherwise only the requested fields (real
// document fields are parsed out of the serialized body).
export function projectQueryItem(row, projection) {
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

export function mapSelectField(name) {
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
