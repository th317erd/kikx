'use strict';

// =============================================================================
// Configuration Defaults + Merging
// =============================================================================
// Default config values for Kikx Core.
// Embedders override via createKikxCore(config).
// =============================================================================

import path from 'node:path';
import os   from 'node:os';

export const DEFAULT_CONFIG = {
  // Core identification
  name: 'kikx',
  version:      '2.0.0',

  // Environment
  environment:  process.env.NODE_ENV || 'development',

  // Database defaults: SQLite in-memory
  database: {
    dialect:    'sqlite',
    filename:   ':memory:',
    emulateBigIntAutoIncrement: true,
  },

  // Plugin search paths
  plugins: {
    paths:    [],       // Additional plugin directories
    disabled: [],       // Plugin names to skip
    modules:  null,     // Map of { name: module } for in-memory loading (testing)
  },

  // Data directory for persistent storage
  dataDirectory: path.join(os.homedir(), '.config', 'kikx'),

  // Dev mode: deterministic REK for session survival across restarts
  devMode: (process.env.NODE_ENV === 'development' || !process.env.NODE_ENV),
};

export function mergeConfig(defaults, overrides) {
  if (!overrides)
    return { ...defaults };

  let result = {};
  let keys   = new Set([
    ...Object.keys(defaults),
    ...Object.keys(overrides),
  ]);

  for (let key of keys) {
    let defaultValue  = defaults[key];
    let overrideValue = overrides[key];

    // Override not provided — use default
    if (overrideValue === undefined) {
      result[key] = defaultValue;
      continue;
    }

    // Deep merge plain objects (not arrays, not null, not class instances)
    if (
      defaultValue && typeof defaultValue === 'object' && !Array.isArray(defaultValue) &&
      overrideValue && typeof overrideValue === 'object' && !Array.isArray(overrideValue) &&
      Object.getPrototypeOf(defaultValue) === Object.prototype &&
      Object.getPrototypeOf(overrideValue) === Object.prototype
    ) {
      result[key] = mergeConfig(defaultValue, overrideValue);
      continue;
    }

    // Override wins
    result[key] = overrideValue;
  }

  return result;
}
