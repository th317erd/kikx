'use strict';

// Writes index configuration documents through the active driver's
// `configureIndexes` hook.
//
// The gate is the driver's declared capability, not `typeof configureIndexes`.
// The old probe was true for every driver because the base class defined the
// hook as a no-op, so "implements" and "inherits the no-op" were the same test
// and an unsupported driver looked like a configured one. A driver that does not
// advertise `indexDocuments` now reports `{ applied: false, scanFallback: true }`
// so the caller can say the index does not exist instead of assuming coverage.
//
// Callers that pass a raw client (the historical fake clients used by the
// frame-store specs) only expose `putFile`, so the per-document loop is retained
// for them; it genuinely persists the documents, so it is not a fallback.
export async function writeIndexConfigs(db, configs) {
  let driver = db?.constructor?.driverID || null;

  if (typeof db?.supports === 'function' && !db.supports('indexDocuments'))
    return { applied: false, driver, reason: 'capability_unsupported', scanFallback: true };

  if (typeof db?.configureIndexes === 'function') {
    let result = await db.configureIndexes(configs);
    return result?.applied === false ? { ...result, scanFallback: true } : result;
  }

  for (let config of configs)
    await db.putFile(config.path, config.body);
  return { applied: true, driver, via: 'putFile', count: configs.length };
}
