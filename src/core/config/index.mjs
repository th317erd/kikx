'use strict';

// =============================================================================
// Configuration Defaults + Merging
// =============================================================================

import path from 'node:path';
import os   from 'node:os';

/** @type {Record<string, any>} */
export const DEFAULT_CONFIG = {
  name: 'kikx',
  version:      '2.0.0',
  environment:  process.env.NODE_ENV || 'development',
  database: {
    dialect:    'sqlite',
    filename:   ':memory:',
    emulateBigIntAutoIncrement: true,
  },
  plugins: {
    paths:    [],
    disabled: [],
    modules:  null,
  },
  dataDirectory: path.join(os.homedir(), '.config', 'kikx'),
  devMode: (process.env.NODE_ENV === 'development' || !process.env.NODE_ENV),
};

/**
 * Deep-merge config defaults with overrides.
 * @param {Record<string, any>} defaults
 * @param {Record<string, any>} [overrides]
 * @returns {Record<string, any>}
 */
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

    if (overrideValue === undefined) {
      result[key] = defaultValue;
      continue;
    }

    if (
      defaultValue && typeof defaultValue === 'object' && !Array.isArray(defaultValue) &&
      overrideValue && typeof overrideValue === 'object' && !Array.isArray(overrideValue) &&
      Object.getPrototypeOf(defaultValue) === Object.prototype &&
      Object.getPrototypeOf(overrideValue) === Object.prototype
    ) {
      result[key] = mergeConfig(defaultValue, overrideValue);
      continue;
    }

    result[key] = overrideValue;
  }

  return result;
}
