'use strict';

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
