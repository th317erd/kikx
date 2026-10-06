'use strict';

import {
  DATABASE_DRIVER_PATH,
  KIKX_DATABASE_DRIVER_PATH,
} from '../config/config-paths.mjs';

// Resolve the configured database driver ID. A missing config yields the
// fallback; otherwise the canonical path wins, then the /kikx alias.
export async function resolveConfiguredDriverID(config, fallback = 'aeordb') {
  if (!config)
    return fallback;

  return await config.get(DATABASE_DRIVER_PATH)
    || await config.get(KIKX_DATABASE_DRIVER_PATH)
    || fallback;
}

// A driver is AeorDB only when its ID resolves to `aeordb` (trimmed,
// case-insensitive). This mirrors `resolveDatabaseDriver`: a plugin
// property-path such as `/org/aeor/kikx/plugins/database/postgresql@0.4.5`
// resolves to its trailing driver ID, so `.../database/aeordb@0.9.5` counts as
// AeorDB while `.../database/postgresql@0.4.5` does not.
export function isAeorDBDriver(driverID) {
  let value = String(driverID ?? '').trim();
  if (!value)
    return false;

  let segment = value.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || value;
  return segment.replace(/@.*$/, '').toLowerCase() === 'aeordb';
}

// Resolve the active database driver from configuration. A requested value may
// be a bare driver ID (`aeordb`) or a plugin property-path value such as
// `/org/aeor/kikx/plugins/database/postgresql@0.4.5`; the latter resolves to
// the driver ID registered by that plugin (`postgresql`).
export function resolveDatabaseDriver(registry, requested, options = {}) {
  let defaultDriverID = options.defaultDriverID || 'aeordb';
  let value = typeof requested === 'string' && requested.trim() ? requested.trim() : defaultDriverID;
  let candidates = [ value ];
  let segment = value.replace(/[/\\]+$/, '').split(/[/\\]/).pop();
  if (segment) {
    if (segment !== value)
      candidates.push(segment);

    candidates.push(segment.replace(/@.*$/, ''));
  }

  if (registry && typeof registry.getDatabaseDriver === 'function') {
    for (let candidate of candidates) {
      let DriverClass = registry.getDatabaseDriver(candidate);
      if (DriverClass)
        return { driverID: candidate, DriverClass };
    }
  }

  let error = new Error(`Unknown database driver: ${value}`);
  error.code = 'database_driver_unknown';
  throw error;
}
