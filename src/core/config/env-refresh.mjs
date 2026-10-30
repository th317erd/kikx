'use strict';

import path from 'node:path';

import {
  ENV_FILE_OWNED_KEYS_ENV_KEY,
  ENV_FILE_PATH_ENV_KEY,
  loadEnvFile,
  readOwnedKeys,
} from './env-loader.mjs';

// Reload-time environment refresh.
//
// The ConfigStore's process-env provider reads `process.env` live on every
// `get()` (see `config-providers.mjs`), so a key present in the environment is
// visible immediately to anything that asks the store. The problem this module
// solves is narrower: the launchers load `.env.dev` once, before spawning the
// server, so a key added to that file afterwards is invisible to the running
// process forever. That is what made a plugin reload unable to see a bot token
// written seventeen hours after boot, and it is the regression the owner is
// defending: installing, reloading or removing a plugin must never require a
// service restart.
//
// The rule is deliberately conservative, because refreshing the environment
// from a file is an obvious way to break a deliberate override:
//
//   1. A key absent from the environment is added. The file is the only source
//      that could supply it, so there is nothing to contradict.
//   2. A key the file owns - recorded as such at boot by
//      `loadEnvFileWithProvenance` - is updated, because the file is where it
//      came from and the file is the source of truth for it.
//   3. Any other key is pinned and left alone. This is what keeps
//      `KIKX_PORT=3025 npm run dev` on port 3025 after a reload instead of
//      being dragged back to whatever `.env.dev` says.
//
// A missing file is not an error; it is a skip with a reason. Nothing here
// throws, because a reload that failed on an unreadable env file would turn a
// permissions problem into a broken plugin lifecycle.

// Resolve the env file to refresh. An explicit option wins, then provenance
// recorded at boot, then the documented dev default. A relative path is left
// relative on purpose: `readFile` resolves it against the process working
// directory at read time, which is exactly how the boot load resolved it, so
// the refresh reads the same file without this module reading `process.cwd()`
// (forbidden under `src/` by spec/core/config/no-process-env-spec.mjs).
export function resolveEnvFileForRefresh(options = {}) {
  let env = options.env || process.env;
  let candidate = options.envFile || env[ENV_FILE_PATH_ENV_KEY] || '.env.dev';
  return options.cwd ? path.resolve(options.cwd, candidate) : candidate;
}

// Re-read the env file into `env`. Returns a report rather than logging, so the
// caller can put it in an HTTP response and a test can assert on it.
//
// `added`   - new keys, now present
// `updated` - file-owned keys whose value changed
// `pinned`  - keys in the file that were set from outside and left untouched
// `skipped` - why the refresh did nothing, when it did nothing
export async function refreshEnvFromFile(options = {}) {
  let env = options.env || process.env;

  if (options.enabled === false)
    return { path: null, skipped: 'disabled', added: [], updated: [], pinned: [] };

  let envPath = resolveEnvFileForRefresh({ ...options, env });

  // Parse the file through the existing additive loader into a scratch object.
  // Starting empty means nothing is skipped as "already present", so the result
  // is exactly the file's contents with last-assignment-wins for a duplicated
  // key - the same semantics the boot load would have had.
  let fileValues = {};
  try {
    await loadEnvFile(envPath, { env: fileValues, fsImpl: options.fsImpl });
  } catch (error) {
    return {
      path: envPath,
      skipped: 'unreadable',
      error: String(error?.message || error),
      added: [],
      updated: [],
      pinned: [],
    };
  }

  let fileKeys = Object.keys(fileValues);
  if (!fileKeys.length)
    return { path: envPath, skipped: 'empty', added: [], updated: [], pinned: [] };

  let owned = new Set(readOwnedKeys(env));
  let added = [];
  let updated = [];
  let pinned = [];

  for (const key of fileKeys) {
    let value = fileValues[key];

    if (!Object.hasOwn(env, key)) {
      env[key] = value;
      owned.add(key);
      added.push(key);
      continue;
    }

    if (!owned.has(key)) {
      pinned.push(key);
      continue;
    }

    if (env[key] !== value) {
      env[key] = value;
      updated.push(key);
    }
  }

  // Widened provenance, so a key first supplied by this refresh counts as
  // file-owned on the next one. Pinned keys are deliberately not added: they
  // are not the file's to change.
  if (added.length)
    env[ENV_FILE_OWNED_KEYS_ENV_KEY] = JSON.stringify([...owned].sort());

  return { path: envPath, skipped: null, added, updated, pinned };
}
