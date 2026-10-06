#!/usr/bin/env node
'use strict';

// One-time AeorDB -> PostgreSQL document migration.
//
// Copies every non-internal source document verbatim through the generic
// database driver contract (`entries()` + `get()` + `put()`), records a
// size+sha256 manifest, then verifies the target byte-for-byte. The manifest
// is flushed periodically so a long run can be resumed and so a crashed run
// still leaves useful evidence.
//
// This is an ops script, not part of the server: it reads `process.env`
// directly (the `src/` config gate does not apply here) and never touches the
// live AeorDB data files or the production PostgreSQL data directory.
//
// Usage: node scripts/migrate-database.mjs [--help]

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { AeorDBConnection } from '../src/core/aeordb/aeordb-connection.mjs';
import { PostgreSQLConnection } from '../src/core/database/postgresql-connection.mjs';

const DEFAULT_SOURCE_URL = 'http://127.0.0.1:6833';
const DEFAULT_ROOT_KEY_FILE = path.join(os.homedir(), '.local/share/kikx/root_key');
const DEFAULT_MANIFEST = path.join(os.tmpdir(), 'kikx-migrate-manifest.json');
const DEFAULT_CONCURRENCY = 8;

// AeorDB keeps its indexes and configuration under dot-directories named
// `.aeordb-*`; those are storage internals, not user documents.
const INTERNAL_PATTERN = /(^|\/)\.aeordb-/;

const PROGRESS_INTERVAL = 250;
const MANIFEST_FLUSH_INTERVAL = 500;
const ATTEMPTS = 3;

const USAGE = [
  'Usage: node scripts/migrate-database.mjs [--help]',
  '',
  'Migrate every document from an AeorDB source into a PostgreSQL target,',
  'record a size/sha256 manifest and verify the result.',
  '',
  'Environment:',
  '  MIGRATE_SOURCE_URL      AeorDB base URL (default http://127.0.0.1:6833)',
  '  MIGRATE_TARGET_URL      PostgreSQL URL (required unless MIGRATE_DRY_RUN=1)',
  '  MIGRATE_ROOT_KEY_FILE   AeorDB root key file',
  `                          (default ${DEFAULT_ROOT_KEY_FILE})`,
  '  MIGRATE_SOURCE_TOKEN    AeorDB bearer token (skips root-key exchange)',
  '  MIGRATE_MANIFEST        manifest path',
  `                          (default ${DEFAULT_MANIFEST})`,
  `  MIGRATE_CONCURRENCY     worker count (default ${DEFAULT_CONCURRENCY})`,
  '  MIGRATE_LIMIT           migrate only the first N documents (tests)',
  '  MIGRATE_DRY_RUN         1 = enumerate/fetch/hash, no target writes',
  '  MIGRATE_VERIFY_ONLY     1 = verify an existing manifest against the target',
  '  MIGRATE_RESUME          1 = skip put when the source sha256 is unchanged',
].join('\n');

async function main() {
  let args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    return;
  }

  if (args.length > 0)
    throw new Error(`unknown argument: ${args[0]}\n\n${USAGE}`);

  let sourceURL = stripTrailingSlash(process.env.MIGRATE_SOURCE_URL || DEFAULT_SOURCE_URL);
  let targetURL = (process.env.MIGRATE_TARGET_URL || '').trim();
  let dryRun = process.env.MIGRATE_DRY_RUN === '1';
  let verifyOnly = process.env.MIGRATE_VERIFY_ONLY === '1';
  let resume = process.env.MIGRATE_RESUME === '1';
  let manifestPath = process.env.MIGRATE_MANIFEST || DEFAULT_MANIFEST;
  let concurrency = positiveInt(process.env.MIGRATE_CONCURRENCY, DEFAULT_CONCURRENCY);
  let limit = process.env.MIGRATE_LIMIT ? positiveInt(process.env.MIGRATE_LIMIT, null) : null;
  let startedAt = new Date().toISOString();
  let startTime = Date.now();

  let manifest = null;
  if (verifyOnly) {
    manifest = await readManifest(manifestPath);
    if (!targetURL)
      targetURL = manifest.targetURL || '';
  }

  if (!targetURL && !dryRun)
    throw new Error('MIGRATE_TARGET_URL is required unless MIGRATE_DRY_RUN=1');

  let source = null;
  let target = null;

  try {
    source = new AeorDBConnection({
      baseURL: sourceURL,
      token: await resolveSourceToken(sourceURL),
    });
    await source.connect();

    if (!dryRun) {
      target = new PostgreSQLConnection({ url: targetURL });
      await target.connect();
    }

    if (verifyOnly) {
      let result = await verify(target, manifest.docs || {}, concurrency);
      let summary = {
        sourceDocs: 0,
        excluded: 0,
        migrated: 0,
        skipped: 0,
        bytes: sumSizes(manifest.docs || {}),
        verified: result.verified,
        mismatch: result.mismatch,
        missing: result.missing,
        elapsedMs: Date.now() - startTime,
      };

      console.log(`migrate-database: target documents = ${result.targetDocs}`);
      console.log(`SUMMARY ${JSON.stringify(summary)}`);
      if (result.mismatch > 0 || result.missing > 0)
        process.exitCode = 1;

      return;
    }

    let priorDocs = {};
    if (resume) {
      try {
        priorDocs = (await readManifest(manifestPath)).docs || {};
      } catch (_error) {
        priorDocs = {};
      }
    }

    manifest = {
      sourceURL,
      targetURL: dryRun ? null : targetURL,
      startedAt,
      finishedAt: null,
      docs: resume ? { ...priorDocs } : {},
    };

    let allPaths = await enumerate(source);
    let paths = [];
    let excluded = 0;
    for (let path of allPaths) {
      if (INTERNAL_PATTERN.test(path)) {
        excluded++;
        continue;
      }

      paths.push(path);
    }

    if (limit != null)
      paths = paths.slice(0, limit);

    let state = {
      nextIndex: 0,
      processed: 0,
      migrated: 0,
      skipped: 0,
      bytes: 0,
      writeChain: Promise.resolve(),
      failed: false,
    };

    let workerCount = Math.max(1, Math.min(concurrency, paths.length || 1));
    await Promise.all(Array.from({ length: workerCount }, () => copyWorker(state, {
      paths,
      priorDocs,
      manifest,
      manifestPath,
      source,
      target,
      dryRun,
      resume,
      startTime,
    })));
    await state.writeChain;

    let verified = 0;
    let mismatch = 0;
    let missing = 0;
    let targetDocs = 0;
    if (!dryRun) {
      let result = await verify(target, manifest.docs, concurrency);
      verified = result.verified;
      mismatch = result.mismatch;
      missing = result.missing;
      targetDocs = result.targetDocs;
      console.log(`migrate-database: target documents = ${targetDocs}`);
    }

    manifest.finishedAt = new Date().toISOString();
    await writeManifest(manifestPath, manifest);

    let summary = {
      sourceDocs: allPaths.length,
      excluded,
      migrated: state.migrated,
      skipped: state.skipped,
      bytes: state.bytes,
      verified,
      mismatch,
      missing,
      elapsedMs: Date.now() - startTime,
    };

    if (state.failed)
      process.exitCode = 1;

    if (mismatch > 0 || missing > 0)
      process.exitCode = 1;

    console.log(`SUMMARY ${JSON.stringify(summary)}`);
  } finally {
    await target?.close?.().catch(() => {});
    await source?.close?.().catch(() => {});
  }
}

async function copyWorker(state, context) {
  let {
    paths,
    priorDocs,
    manifest,
    manifestPath,
    source,
    target,
    dryRun,
    resume,
    startTime,
  } = context;

  while (true) {
    let index = state.nextIndex++;
    if (index >= paths.length)
      return;

    let path = paths[index];
    try {
      let raw = await withRetry(() => source.get(path, { raw: true }), `read ${path}`);
      if (raw == null)
        throw new Error('source document disappeared mid-run');

      let text = String(raw);
      let sha256 = hash(text);
      let size = Buffer.byteLength(text);
      let prior = priorDocs[path];
      let skipPut = resume && prior && prior.sha256 === sha256 && prior.size === size;

      if (skipPut) {
        state.skipped++;
      } else {
        if (!dryRun)
          await withRetry(() => target.put(path, text, { raw: true }), `write ${path}`);

        manifest.docs[path] = { size, sha256 };
        state.migrated++;
        state.bytes += size;
      }

      state.processed++;
      if (state.processed % PROGRESS_INTERVAL === 0 || state.processed === paths.length)
        logProgress(state.processed, paths.length, state.bytes, startTime);

      if (state.processed % MANIFEST_FLUSH_INTERVAL === 0)
        state.writeChain = state.writeChain.then(() => writeManifest(manifestPath, manifest));
    } catch (error) {
      state.failed = true;
      console.error(`migrate-database: ${path}: ${error.message}`);
    }
  }
}

async function enumerate(source) {
  let paths = [];
  for await (let entry of source.entries('/', { recursive: true })) {
    if (entry?.path)
      paths.push(entry.path);
  }

  return paths;
}

async function verify(target, docs, concurrency) {
  let paths = Object.keys(docs);
  let counts = { verified: 0, mismatch: 0, missing: 0, targetDocs: 0 };
  let nextIndex = 0;

  async function worker() {
    while (true) {
      let index = nextIndex++;
      if (index >= paths.length)
        return;

      let path = paths[index];
      let expected = docs[path];
      let body;
      try {
        body = await withRetry(() => target.get(path, { raw: true }), `verify-read ${path}`);
      } catch (error) {
        counts.mismatch++;
        console.error(`migrate-database: mismatch ${path}: ${error.message}`);
        continue;
      }

      if (body == null) {
        counts.missing++;
        console.error(`migrate-database: missing ${path}`);
        continue;
      }

      let text = String(body);
      if (hash(text) === expected.sha256 && Buffer.byteLength(text) === expected.size) {
        counts.verified++;
      } else {
        counts.mismatch++;
        console.error(`migrate-database: mismatch ${path}`);
      }
    }
  }

  let workerCount = Math.max(1, Math.min(concurrency, paths.length || 1));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  for await (let _entry of target.entries('/', { recursive: true }))
    counts.targetDocs++;

  return counts;
}

async function resolveSourceToken(sourceURL) {
  let explicit = process.env.MIGRATE_SOURCE_TOKEN;
  if (explicit)
    return explicit;

  let keyFile = process.env.MIGRATE_ROOT_KEY_FILE || DEFAULT_ROOT_KEY_FILE;
  let rootKey;
  try {
    rootKey = (await readFile(keyFile, 'utf8')).trim();
  } catch (error) {
    throw new Error(`unable to read root key file ${keyFile}: ${error.message}`);
  }

  if (!rootKey)
    throw new Error(`root key file ${keyFile} is empty`);

  let response;
  try {
    response = await fetch(`${sourceURL}/auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: rootKey }),
    });
  } catch (error) {
    throw new Error(`unable to reach AeorDB at ${sourceURL}: ${error.message}`);
  }

  let body = await response.json().catch(() => ({}));
  if (!response.ok || !body.token) {
    let message = body?.error?.message || body?.message || 'no token';
    throw new Error(`AeorDB token exchange failed (HTTP ${response.status}): ${message}`);
  }

  return body.token;
}

async function withRetry(operation, label) {
  let lastError;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < ATTEMPTS)
        await sleep(200 * 2 ** (attempt - 1));
    }
  }

  throw new Error(`${label} failed after ${ATTEMPTS} attempts: ${lastError?.message || lastError}`);
}

async function readManifest(path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw new Error(`unable to read manifest ${path}: ${error.message}`);
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`manifest ${path} is not valid JSON: ${error.message}`);
  }
}

async function writeManifest(path, manifest) {
  await writeFile(path, JSON.stringify(manifest, null, 2));
}

function logProgress(done, total, bytes, startTime) {
  let elapsed = Date.now() - startTime;
  let rate = elapsed > 0 ? done / (elapsed / 1000) : 0;
  console.log(`migrate-database: ${done}/${total} docs, ${(bytes / 1_000_000).toFixed(1)} MB, ${rate.toFixed(1)} docs/s`);
}

function hash(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function sumSizes(docs) {
  let total = 0;
  for (let path of Object.keys(docs))
    total += docs[path]?.size || 0;

  return total;
}

function positiveInt(value, fallback) {
  if (value === undefined || value === null || value === '')
    return fallback;

  let parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0)
    throw new Error(`expected a positive integer, got "${value}"`);

  return parsed;
}

function stripTrailingSlash(value) {
  return value.replace(/\/+$/g, '');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

try {
  await main();
} catch (error) {
  console.error(`migrate-database: ${error.message}`);
  process.exit(2);
}
