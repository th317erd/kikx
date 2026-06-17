'use strict';

import { PluginInterface } from '../plugins/index.mjs';
import { builtInToolComponent } from './tool-client-components.mjs';

const DEFAULT_SEARCH_PATH = '/kikx';
const DEFAULT_SEARCH_LIMIT = 20;
const MAX_SEARCH_LIMIT = 1000;
const DEFAULT_MATCHES_PER_RESULT = 5;
const DEFAULT_SNIPPET_CHARS = 240;
const DEFAULT_CONTEXT_LINES = 2;

export class DatabaseSearchTool extends PluginInterface {
  static pluginID = 'internal:database';
  static featureName = 'search';
  static displayName = 'Search database';
  static description = 'Search AeorDB and return hit locators with snippets and fetch hints.';
  static frameType = 'DatabaseSearchToolFrame';
  static clientComponent = builtInToolComponent('kikx-session-tool-use');
  static riskLevel = 'none';
  static inputSchema = {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Broad fuzzy search query. At least one of query or where is required.',
      },
      where: {
        type: 'object',
        description: 'Structured AeorDB where clause. At least one of query or where is required.',
      },
      path: {
        type: 'string',
        description: 'AeorDB path scope. Defaults to /kikx.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: MAX_SEARCH_LIMIT,
        description: 'Maximum result count.',
      },
      offset: {
        type: 'integer',
        minimum: 0,
        description: 'Result offset.',
      },
      maxMatchesPerResult: {
        type: 'integer',
        minimum: 1,
        maximum: 50,
        description: 'Maximum hit locators to return per result.',
      },
      snippetChars: {
        type: 'integer',
        minimum: 1,
        maximum: 4096,
        description: 'Maximum snippet characters per locator.',
      },
      matchContextLines: {
        type: 'integer',
        minimum: 0,
        description: 'Line context for stored-file fetch hints.',
      },
      maxLocatorScanBytes: {
        type: 'integer',
        minimum: 1,
        description: 'Caller cap for request-time locator scans.',
      },
    },
    additionalProperties: false,
  };
  static help = 'Use database-search to search AeorDB. Results include matches with fetch hints; pass those hints to database-fetch to read only the needed ranges.';

  async _execute(params = {}) {
    let aeordb = resolveAeorDB(this.context);
    if (typeof aeordb.searchFiles !== 'function')
      throw new Error('database-search requires aeordb.searchFiles');

    let search = createLocatorSearchRequest(params, { defaultPath: DEFAULT_SEARCH_PATH });
    let result = await aeordb.searchFiles(search);
    return formatSearchResponse(result, {
      path: search.path,
      query: search.query || null,
      where: search.where || null,
    });
  }
}

export class DatabaseFetchTool extends PluginInterface {
  static pluginID = 'internal:database';
  static featureName = 'fetch';
  static displayName = 'Fetch database ranges';
  static description = 'Fetch AeorDB file ranges by lines, chars, bytes, or JSON Pointer.';
  static frameType = 'DatabaseFetchToolFrame';
  static clientComponent = builtInToolComponent('kikx-session-tool-use');
  static riskLevel = 'none';
  static inputSchema = {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        description: 'Range fetch items. Each item needs path plus range, or a search locator fetch hint.',
        items: {
          type: 'object',
          additionalProperties: true,
        },
      },
      path: {
        type: 'string',
        description: 'Shortcut for one item: AeorDB file path.',
      },
      mode: {
        type: 'string',
        enum: [ 'lines', 'chars', 'bytes', 'json_pointer' ],
        description: 'Shortcut range mode.',
      },
      start: {
        type: 'integer',
        minimum: 0,
        description: 'Shortcut start offset. Lines are 1-based inclusive; chars/bytes are 0-based inclusive.',
      },
      end: {
        type: 'integer',
        minimum: 0,
        description: 'Shortcut end offset. Lines are inclusive; chars/bytes are exclusive.',
      },
      pointer: {
        type: 'string',
        description: 'Shortcut JSON Pointer for json_pointer mode.',
      },
      if_content_hash: {
        type: 'string',
        description: 'Reject as stale if the file content hash changed.',
      },
      if_updated_at: {
        type: 'integer',
        description: 'Reject as stale if the file updated_at timestamp changed.',
      },
      maxBytes: {
        type: 'integer',
        minimum: 1,
        description: 'Cumulative response byte cap.',
      },
      continueOnError: {
        type: 'boolean',
        description: 'Return per-item errors instead of failing the whole batch.',
      },
    },
    additionalProperties: false,
  };
  static help = 'Use database-fetch after database-search, session-search, or output-search. Prefer locator fetch hints and pass if_content_hash/if_updated_at to avoid stale reads.';

  async _execute(params = {}) {
    let aeordb = resolveAeorDB(this.context);
    if (typeof aeordb.fetchFileRanges !== 'function')
      throw new Error('database-fetch requires aeordb.fetchFileRanges');

    let items = normalizeFetchItems(params);
    let result = await aeordb.fetchFileRanges(items, {
      maxBytes: params.maxBytes ?? params.max_bytes,
      continueOnError: params.continueOnError ?? params.continue_on_error ?? true,
    });

    return {
      ...result,
      rangeSemantics: {
        lines: 'start/end are 1-based inclusive line numbers.',
        chars: 'start is 0-based inclusive and end is exclusive.',
        bytes: 'start is 0-based inclusive and end is exclusive.',
        json_pointer: 'pointer is an RFC 6901 JSON Pointer.',
      },
    };
  }
}

export function createLocatorSearchRequest(params = {}, options = {}) {
  let query = normalizeOptionalString(params.query);
  let where = normalizeWhere(params.where);
  if (!query && !where)
    throw new TypeError('search requires query or where');

  let request = {
    path: normalizePath(params.path || options.defaultPath || DEFAULT_SEARCH_PATH),
    limit: clampInteger(params.limit, DEFAULT_SEARCH_LIMIT, 1, MAX_SEARCH_LIMIT),
    offset: clampInteger(params.offset, 0, 0, Number.MAX_SAFE_INTEGER),
    include_matches: params.includeMatches ?? params.include_matches ?? true,
    max_matches_per_result: clampInteger(params.maxMatchesPerResult ?? params.max_matches_per_result, DEFAULT_MATCHES_PER_RESULT, 1, 50),
    snippet_chars: clampInteger(params.snippetChars ?? params.snippet_chars, DEFAULT_SNIPPET_CHARS, 1, 4096),
    match_context_lines: clampInteger(params.matchContextLines ?? params.match_context_lines, DEFAULT_CONTEXT_LINES, 0, 100),
  };

  if (query)
    request.query = query;
  if (where)
    request.where = where;

  let maxLocatorScanBytes = params.maxLocatorScanBytes ?? params.max_locator_scan_bytes;
  if (maxLocatorScanBytes != null)
    request.max_locator_scan_bytes = normalizePositiveInteger(maxLocatorScanBytes, 'maxLocatorScanBytes');

  return request;
}

export function formatSearchResponse(result, context = {}) {
  let results = normalizeSearchResults(result).map((entry) => ({
    ...entry,
    locatorFetchTool: 'database-fetch',
  }));

  return {
    path: context.path || null,
    query: context.query || null,
    where: context.where || null,
    results,
    count: results.length,
    has_more: Boolean(result?.has_more),
    total_count: result?.total_count ?? null,
    next_cursor: result?.next_cursor ?? null,
    prev_cursor: result?.prev_cursor ?? null,
    fetchTool: 'database-fetch',
    fetchInstructions: 'Use database-fetch with a result path plus a match.fetch hint. Include content_hash as if_content_hash or updated_at as if_updated_at when present.',
  };
}

export function normalizeFetchItems(params = {}) {
  let rawItems = Array.isArray(params.items)
    ? params.items
    : [ params ];

  let items = rawItems.map((item, index) => normalizeFetchItem(item, index));
  if (items.length === 0)
    throw new TypeError('database-fetch requires at least one item');

  return items;
}

function normalizeFetchItem(item, index) {
  if (!item || typeof item !== 'object' || Array.isArray(item))
    throw new TypeError('database-fetch items must be objects');

  let match = resolveMatch(item);
  let fetchHint = item.fetch || match?.fetch || null;
  let path = normalizeOptionalString(item.path || match?.path);
  if (!path)
    throw new TypeError('database-fetch item.path is required');

  let output = {
    id: normalizeOptionalString(item.id || match?.id) || `item-${index + 1}`,
    path,
    range: normalizeFetchRange(item.range || rangeFromFetchHint(fetchHint) || item),
  };

  let contentHash = item.if_content_hash ?? item.ifContentHash ?? item.content_hash ?? item.contentHash;
  if (contentHash != null)
    output.if_content_hash = String(contentHash);

  let updatedAt = item.if_updated_at ?? item.ifUpdatedAt ?? item.updated_at ?? item.updatedAt;
  if (updatedAt != null)
    output.if_updated_at = normalizeInteger(updatedAt, 'if_updated_at');

  let maxBytes = item.maxBytes ?? item.max_bytes;
  if (maxBytes != null)
    output.max_bytes = normalizePositiveInteger(maxBytes, 'maxBytes');

  return output;
}

function resolveMatch(item) {
  if (item.match && typeof item.match === 'object')
    return item.match;

  if (Array.isArray(item.matches) && item.matches.length > 0)
    return item.matches[0];

  return null;
}

function rangeFromFetchHint(fetchHint) {
  if (!fetchHint || typeof fetchHint !== 'object' || Array.isArray(fetchHint))
    return null;

  let preferred = normalizeOptionalString(fetchHint.preferred);
  if (preferred === 'json_pointer' && fetchHint.json_pointer)
    return { mode: 'json_pointer', pointer: fetchHint.json_pointer };
  if (preferred === 'line_range' && fetchHint.line_range)
    return { mode: 'lines', ...fetchHint.line_range };
  if (preferred === 'byte_range' && fetchHint.byte_range)
    return { mode: 'bytes', ...fetchHint.byte_range };
  if (preferred === 'char_range' && fetchHint.char_range)
    return { mode: 'chars', ...fetchHint.char_range };

  if (fetchHint.json_pointer)
    return { mode: 'json_pointer', pointer: fetchHint.json_pointer };
  if (fetchHint.line_range)
    return { mode: 'lines', ...fetchHint.line_range };
  if (fetchHint.byte_range)
    return { mode: 'bytes', ...fetchHint.byte_range };
  if (fetchHint.char_range)
    return { mode: 'chars', ...fetchHint.char_range };

  return null;
}

function normalizeFetchRange(range) {
  if (!range || typeof range !== 'object' || Array.isArray(range))
    throw new TypeError('database-fetch range is required');

  let mode = normalizeRangeMode(range.mode || range.type);
  if (mode === 'json_pointer') {
    let pointer = range.pointer ?? range.json_pointer ?? range.jsonPointer;
    if (typeof pointer !== 'string' || pointer === '')
      throw new TypeError('json_pointer range requires pointer');

    return { mode, pointer };
  }

  let output = { mode };
  if (range.start != null)
    output.start = normalizeNonNegativeInteger(range.start, 'start');
  if (range.end != null)
    output.end = mode === 'lines'
      ? normalizePositiveInteger(range.end, 'end')
      : normalizeNonNegativeInteger(range.end, 'end');

  return output;
}

function normalizeRangeMode(value) {
  let mode = String(value || '').trim();
  if (mode === 'line')
    mode = 'lines';
  if (mode === 'char')
    mode = 'chars';
  if (mode === 'byte')
    mode = 'bytes';
  if (mode === 'jsonPointer')
    mode = 'json_pointer';

  if (![ 'lines', 'chars', 'bytes', 'json_pointer' ].includes(mode))
    throw new TypeError('range mode must be lines, chars, bytes, or json_pointer');

  return mode;
}

function normalizeSearchResults(result) {
  let items = Array.isArray(result?.results)
    ? result.results
    : Array.isArray(result?.items) ? result.items : [];

  return items;
}

function normalizeWhere(value) {
  if (value == null)
    return null;

  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('where must be an object');

  return value;
}

function normalizePath(value) {
  let path = normalizeOptionalString(value);
  if (!path)
    throw new TypeError('path must be a non-empty string');

  return path.startsWith('/') ? path : `/${path}`;
}

function normalizeOptionalString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeInteger(value, fieldName) {
  let number = Number(value);
  if (!Number.isInteger(number))
    throw new TypeError(`${fieldName} must be an integer`);

  return number;
}

function normalizePositiveInteger(value, fieldName) {
  let number = normalizeInteger(value, fieldName);
  if (number < 1)
    throw new TypeError(`${fieldName} must be a positive integer`);

  return number;
}

function normalizeNonNegativeInteger(value, fieldName) {
  let number = normalizeInteger(value, fieldName);
  if (number < 0)
    throw new TypeError(`${fieldName} must be a non-negative integer`);

  return number;
}

function clampInteger(value, defaultValue, min, max) {
  let number = Number(value);
  if (!Number.isFinite(number))
    number = defaultValue;

  number = Math.trunc(number);
  return Math.min(max, Math.max(min, number));
}

function resolveAeorDB(context = {}) {
  let service = context.aeordb || context.services?.aeordb || resolveContextService(context, 'aeordb');
  if (!service?.searchFiles && !service?.fetchFileRanges)
    throw new Error('database tools require an aeordb service');

  return service;
}

function resolveContextService(context, name) {
  let appContext = context.services?.context || context.context;
  if (appContext?.has?.(name) && typeof appContext.require === 'function')
    return appContext.require(name);

  if (typeof appContext?.require === 'function') {
    try {
      return appContext.require(name);
    } catch (_error) {
      return null;
    }
  }

  return null;
}
