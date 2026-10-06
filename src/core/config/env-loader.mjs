'use strict';

import * as nodeFsPromises from 'node:fs/promises';

import { loadJsonEnvFile } from './config-providers.mjs';
import { envKeyFor } from './property-path.mjs';

// Shared `.env` and JSON-env loaders. These back the dev launchers and replace
// six duplicated copies of the same parsing logic. Both loaders are additive:
// they never overwrite a key that is already present, so real process-env
// values always win, and an earlier-loaded source beats a later one.

// Capture a shallow copy of the ambient environment. Callers in `src/` use this
// instead of touching `process.env` directly; copying prevents them from
// mutating the live environment. `src/core/config/` is the only module allowed
// to read `process.env`, guarded by `spec/core/config/no-process-env-spec.mjs`.
export function snapshotEnvironment(env = process.env) {
  return { ...env };
}

// Parse a `.env`-style file and copy absent keys into `env`. Missing files are
// not an error; any other read failure propagates. Lines are trimmed; blank
// lines and `#` comments are skipped; a line whose first `=` is at index < 1 is
// malformed and skipped. This matches the historical `scripts/dev-watch.mjs`
// loader exactly.
export async function loadEnvFile(envPath, options = {}) {
  let fsImpl = options.fsImpl || nodeFsPromises;
  let env = options.env || process.env;

  let text;
  try {
    text = await fsImpl.readFile(envPath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT')
      return;

    throw error;
  }

  for (const rawLine of text.split(/\r?\n/g)) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#'))
      continue;

    let index = line.indexOf('=');
    if (index < 1)
      continue;

    let key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();

    if (!Object.hasOwn(env, key))
      env[key] = value;
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
