'use strict';

// Writes index configuration documents through the active driver's
// `configureIndexes` hook when it implements one. Drivers without index support
// inherit the base no-op. Callers that pass a raw client (the historical fake
// clients used by the frame-store specs) only expose `putFile`, so the
// per-document fallback loop is retained for them.
export async function writeIndexConfigs(db, configs) {
  if (typeof db?.configureIndexes === 'function') {
    await db.configureIndexes(configs);
    return;
  }

  for (let config of configs)
    await db.putFile(config.path, config.body);
}
