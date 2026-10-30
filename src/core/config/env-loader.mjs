'use strict';

import * as nodeFsPromises from 'node:fs/promises';

import { loadJsonEnvFile } from './config-providers.mjs';
import { envKeyFor } from './property-path.mjs';

// Shared `.env` and JSON-env loaders. These back the dev launchers and replace
// six duplicated copies of the same parsing logic. Both loaders are additive:
// they never overwrite a key that is already present, so real process-env
// values always win, and an earlier-loaded source beats a later one.

// Provenance channel. A launcher loads `.env.dev` in one process and spawns the
// server in another, so "which keys did the file actually set?" cannot live in
// module state. It travels in the environment instead: the path of the loaded
// file plus the key names the file was allowed to set. `env-refresh.mjs` reads
// both to decide what a reload may update. Without this, a reload cannot tell a
// key the file owns (safe to update) from a key an operator exported on purpose
// (must stay pinned).
export const ENV_FILE_PATH_ENV_KEY = 'KIKX_ENV_FILE';
export const ENV_FILE_OWNED_KEYS_ENV_KEY = 'KIKX_ENV_FILE_OWNED_KEYS';

// Capture a shallow copy of the ambient environment. Callers in `src/` use this
// instead of touching `process.env` directly; copying prevents them from
// mutating the live environment. `src/core/config/` is the only module allowed
// to read `process.env`, guarded by `spec/core/config/no-process-env-spec.mjs`.
export function snapshotEnvironment(env = process.env) {
  return { ...env };
}

// Parse `.env` text into `[key, value]` pairs. Lines are trimmed; blank lines
// and `#` comments are skipped; a line whose first `=` is at index < 1 is
// malformed and skipped. This matches the historical `scripts/dev-watch.mjs`
// loader exactly. Shared by the loader and the provenance-aware variant so the
// two can never disagree about which keys a file contains.
export function parseEnvFileText(text) {
  let entries = [];

  for (const rawLine of String(text).split(/\r?\n/g)) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#'))
      continue;

    let index = line.indexOf('=');
    if (index < 1)
      continue;

    entries.push([line.slice(0, index).trim(), line.slice(index + 1).trim()]);
  }

  return entries;
}

// Read and parse an env file. Returns `null` for a missing file so callers can
// distinguish "nothing to load" from "empty file"; any other read failure
// propagates.
async function readEnvEntries(envPath, fsImpl = nodeFsPromises) {
  let text;
  try {
    text = await fsImpl.readFile(envPath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT')
      return null;

    throw error;
  }

  return parseEnvFileText(text);
}

// Parse a `.env`-style file and copy absent keys into `env`. Missing files are
// not an error; any other read failure propagates. See `parseEnvFileText` for
// the line rules.
export async function loadEnvFile(envPath, options = {}) {
  let fsImpl = options.fsImpl || nodeFsPromises;
  let env = options.env || process.env;

  let entries = await readEnvEntries(envPath, fsImpl);
  if (entries === null)
    return;

  for (const [key, value] of entries) {
    if (!Object.hasOwn(env, key))
      env[key] = value;
  }
}

// `loadEnvFile` plus provenance. Records the file path and the key names the
// file was allowed to set, so a later in-process reload can re-read the file
// and update exactly those keys. Both records are unions with whatever an
// outer launcher already recorded: the dev stack loads `.env.dev` twice (the
// outer supervisor and the Kikx wrapper), and the second load must not erase
// the first one's provenance just because every key was already present.
export async function loadEnvFileWithProvenance(envPath, options = {}) {
  let fsImpl = options.fsImpl || nodeFsPromises;
  let env = options.env || process.env;

  let entries = await readEnvEntries(envPath, fsImpl);
  if (entries === null)
    return { path: envPath, owned: [] };

  let owned = new Set(readOwnedKeys(env));
  for (const [key, value] of entries) {
    if (Object.hasOwn(env, key))
      continue;

    env[key] = value;
    owned.add(key);
  }

  env[ENV_FILE_PATH_ENV_KEY] = envPath;
  env[ENV_FILE_OWNED_KEYS_ENV_KEY] = JSON.stringify([...owned].sort());

  return { path: envPath, owned: [...owned].sort() };
}

// Decode the recorded owned-key list. A corrupt or absent value yields no
// owned keys, which is the conservative reading: nothing may be updated.
export function readOwnedKeys(env = process.env) {
  let raw = env[ENV_FILE_OWNED_KEYS_ENV_KEY];
  if (typeof raw !== 'string' || !raw)
    return [];

  try {
    let parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((key) => typeof key === 'string' && key) : [];
  } catch (_error) {
    return [];
  }
}

// Load a JSON env document through the config providers and copy absent env
// keys into `env`. Property paths map to env keys via `envKeyFor`, so
// `/org/aeor/kikx/database/driver` becomes `ORG_AEOR_KIKX_DATABASE_DRIVER`.
// A missing file yields no keys.
export async function loadJsonEnv(envPath, options = {}) {
  let fsImpl = options.fsImpl || nodeFsPromises;
  let env = options.env || process.env;

  let document = await loadJsonEnvFile(envPath, { fsImpl });

  for (const [propertyPath, value] of Object.entries(document)) {
    let key = envKeyFor(propertyPath);
    if (!Object.hasOwn(env, key))
      env[key] = value;
  }
}

// Load the optional `.env` file first, then the optional JSON env document, so
// the `.env` source wins on a colliding key. Returns the target env object.
export async function loadEnvSources(options = {}) {
  let fsImpl = options.fsImpl || nodeFsPromises;
  let env = options.env || process.env;

  if (options.envFile)
    await loadEnvFile(options.envFile, { env, fsImpl });

  if (options.jsonEnvFile)
    await loadJsonEnv(options.jsonEnvFile, { env, fsImpl });

  return env;
}
