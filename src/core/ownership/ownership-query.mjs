'use strict';

// Turning the ownership rule into an indexed query.
//
// The rule itself lives in session-ownership.mjs: a viewer may see items owned
// by { viewer } union its ancestors. The set is small — it is the depth of the
// session tree, typically 1 to 10 — which is exactly what makes it a good
// index predicate and a terrible table scan.
//
// Why this file exists at all: filtering ownership *after* loading every row
// means loading every row. On the reference database that is ~20k frames per
// sidebar render, which is both too slow and a pattern that gets worse every
// day the product is used. The scoping field has to be declared as an index
// (see the anchor list in spec/ownership/README.md) and this module builds the
// `where` clause that the index can answer directly.
//
// The `where` grammar here is the one AeorDB actually evaluates:
//   combinators: { and: [...] }, { or: [...] }, { not: {...} }, bare array
//   operators:   eq, ne, gt, gte, lt, lte, in, contains, prefix, exists
// (documented at src/core/database/scan-search.mjs:11-18 and exercised at
// src/core/aeordb/frame-store-scheduled.mjs:34-38). `in` is supported, which is
// the operator this whole design rests on.

import { normalizeSessionID } from './session-ownership.mjs';

/** The field an owned record stores its owning session in. */
export const OWNER_FIELD = 'ownerSessionID';

// An `in` list of unbounded length is a poor request and can exceed the
// server's limit (scan-search clamps `limit` to 1000). Chunk it: 64 is large
// enough that a normal tree is one chunk and small enough to stay well clear.
export const OWNER_IN_CHUNK_SIZE = 64;

/** Dedupe, trim, drop blanks, preserve order. */
export function normalizeOwnerIDs(ownerIDs) {
  let seen = new Set();
  let out = [];

  for (let value of Array.isArray(ownerIDs) ? ownerIDs : []) {
    let id = normalizeSessionID(value);
    if (!id || seen.has(id))
      continue;

    seen.add(id);
    out.push(id);
  }

  return out;
}

/** Split a normalized owner list into `in`-sized chunks. */
export function chunkOwnerIDs(ownerIDs, size = OWNER_IN_CHUNK_SIZE) {
  let ids = normalizeOwnerIDs(ownerIDs);
  let width = Number.isInteger(size) && size > 0 ? size : OWNER_IN_CHUNK_SIZE;
  let chunks = [];

  for (let i = 0; i < ids.length; i += width)
    chunks.push(ids.slice(i, i + width));

  return chunks;
}

/**
 * The `where` clause selecting records owned by any of `ownerIDs`.
 *
 * Returns `null` for an empty scope — and callers must treat `null` as "no
 * rows", never as "no filter". An empty owner set means the viewer owns
 * nothing and may see nothing; a query with no `where` would return the whole
 * database and hand a session every other session's agents.
 */
export function buildOwnerScopeWhere(ownerIDs, field = OWNER_FIELD, size = OWNER_IN_CHUNK_SIZE) {
  let chunks = chunkOwnerIDs(ownerIDs, size);
  if (chunks.length === 0)
    return null;

  let conditions = chunks.map((value) => ({ field, op: 'in', value }));

  if (conditions.length === 1)
    return conditions[0];

  // More than one chunk: union. `or` is evaluated by the same dialect.
  return { or: conditions };
}

/**
 * A query request ready to hand to a store's search, with the scope baked in.
 * `path` is the store's index root; `extra` is merged into the conjunction.
 */
export function buildScopedQuery(ownerIDs, options = {}) {
  let where = buildOwnerScopeWhere(ownerIDs, options.field, options.size);
  if (!where)
    return null;

  let extra = Array.isArray(options.extra) ? options.extra.filter(Boolean) : [];
  let combined = extra.length > 0
    ? { and: [ ...extra, where ] }
    : where;

  let request = { where: combined };

  if (options.path)
    request.path = options.path;

  if (Number.isInteger(options.limit))
    request.limit = options.limit;

  if (Number.isInteger(options.offset))
    request.offset = options.offset;

  return request;
}

/**
 * Read the owning session off a record, tolerating the field names in use.
 * Mirrors sessionIDOf in src/client/state/session-scope.mjs so a row filtered
 * on the server and the same row filtered in the browser agree.
 */
export function ownerSessionIDOf(record) {
  if (record == null || typeof record !== 'object')
    return '';

  return normalizeSessionID(record.ownerSessionID)
    || normalizeSessionID(record.ownerSessionId)
    || normalizeSessionID(record.sessionID)
    || normalizeSessionID(record.sessionId);
}

/**
 * Defence in depth for the rows the index returns.
 *
 * An index predicate is a query, and a query can be wrong: a stale index, a
 * chunked `or` that a driver flattens differently, a caller that passes the
 * wrong field name. This re-filters with the same rule, in memory, over rows
 * that are already in hand — it costs O(rows returned), not O(table).
 *
 * Order is preserved: this filters, it never re-sorts.
 */
export function filterOwnedRows(ownerIDs, rows, field) {
  let allowed = new Set(normalizeOwnerIDs(ownerIDs));

  return (Array.isArray(rows) ? rows : []).filter((row) => {
    let owner = field ? normalizeSessionID(row?.[field]) : ownerSessionIDOf(row);
    return owner ? allowed.has(owner) : false;
  });
}
