#!/usr/bin/env node
'use strict';

// Repeatable verification of the scheduled-frame store path against a live
// AeorDB instance (dev or prod). This is the check that would have caught the
// P9 miss: the store must FIND persisted scheduled frames via global search, and
// must not silently return an empty set when the index is absent.
//
// Usage:
//   node scripts/verify-scheduled-frames.mjs
//   AEORDB_URL=http://127.0.0.1:6833 AEORDB_ROOT_KEY=... node scripts/verify-scheduled-frames.mjs
//   AEORDB_URL=... AEORDB_TOKEN=... node scripts/verify-scheduled-frames.mjs
//
// Env loading: KIKX_ENV_FILE (default .env.dev) supplies AEORDB_URL and
// AEORDB_ROOT_KEY when the process env does not.
//
// Exit 0 = the store path is healthy. Exit 1 = a real problem (with detail).
// Exit 2 = usage/config problem (unreachable, bad/absent credentials).

import { loadEnvFile } from '../src/core/config/env-loader.mjs';
import { AeorDBClient } from '../src/core/aeordb/aeordb-client.mjs';
import { AeorDBFrameStore } from '../src/core/aeordb/aeordb-frame-store.mjs';
import { isPendingScheduledFrame } from '../src/core/aeordb/aeordb-frame-store-normalizers.mjs';

await loadEnvFile(process.env.KIKX_ENV_FILE || '.env.dev');

let baseURL = (process.env.AEORDB_URL || 'http://127.0.0.1:6830').replace(/\/+$/g, '');
let token = process.env.AEORDB_TOKEN || '';

if (!token) {
  let rootKey = process.env.AEORDB_ROOT_KEY || '';
  if (!rootKey) {
    fail(2, 'AEORDB_TOKEN or AEORDB_ROOT_KEY is required (see --help in this file header)');
  }

  let body;
  try {
    let response = await fetch(`${baseURL}/auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: rootKey }),
    });
    body = await response.json().catch(() => ({}));
    if (!response.ok || !body.token)
      fail(2, `token exchange failed (HTTP ${response.status}): ${body?.error || body?.message || 'no token'}`);
  } catch (error) {
    fail(2, `unable to reach AeorDB at ${baseURL}: ${error.message}`);
  }
  token = body.token;
}

let client = new AeorDBClient({ baseURL, token });
let store = new AeorDBFrameStore({ aeordb: client });

// 1. The store must answer without throwing, and every returned frame must carry
//    a scheduledAt and a non-terminal status (the store re-verifies this).
let frames;
try {
  frames = await store.listScheduledFrames({ limit: 500, offset: 0 });
} catch (error) {
  fail(1, `listScheduledFrames threw: ${error.message}`);
}

let bad = frames.filter((frame) => !isPendingScheduledFrame(frame));
if (bad.length > 0)
  fail(1, `listScheduledFrames returned ${bad.length} non-pending frame(s); the store must filter them`);

// 2. Cross-check against the raw global-search endpoint. Important AeorDB
//    behavior: `/files/search` combinator filtering on `scheduledStatus` is
//    index-only and can return non-pending frames, so the authoritative pending
//    set is the body-verified one. The store must equal that, and must never
//    return nothing when bodies confirm candidates exist.
let searchPaths = [];
try {
  let result = await client.searchFiles({
    where: { and: [ { field: 'scheduledAt', op: 'gt', value: 0 } ] },
    limit: 500,
    offset: 0,
  });
  searchPaths = (result?.results || result?.items || []).map((item) => item.path).filter(Boolean);
} catch (error) {
  fail(1, `global search of scheduled frames failed: ${error.status || ''} ${error.message}`.trim());
}

let expectedPending = 0;
for (let path of searchPaths) {
  let body;
  try {
    body = await client.getFile(path);
  } catch (_error) {
    continue;
  }
  let frame = typeof body === 'string' ? JSON.parse(body) : body;
  if (isPendingScheduledFrame(frame))
    expectedPending++;
}

if (frames.length !== expectedPending) {
  fail(1, `store returned ${frames.length} pending frame(s) but body verification of the search results expects ${expectedPending}`);
}

log(`OK: ${baseURL} — store returned ${frames.length} pending scheduled frame(s), matching body verification.`);
process.exit(0);

function log(message) {
  process.stdout.write(`[verify-scheduled-frames] ${message}\n`);
}

function fail(code, message) {
  process.stderr.write(`[verify-scheduled-frames] ERROR: ${message}\n`);
  process.exit(code);
}
