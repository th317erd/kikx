'use strict';

import path from 'node:path';

// Plugin ingestion is additive: the checkout's own plugins are a base layer,
// and configured sites extend it. A machine-local list must not silently erase
// a bundled plugin.
export function mergePluginPaths(...groups) {
  let output = [];
  let seen = new Set();
  for (let group of groups) {
    for (let value of normalizeGroup(group)) {
      let resolved = path.resolve(value);
      if (seen.has(resolved))
        continue;
      seen.add(resolved);
      output.push(resolved);
    }
  }
  return output;
}

function normalizeGroup(group) {
  let values = Array.isArray(group)
    ? group
    : (typeof group === 'string' ? group.split(path.delimiter) : []);
  return values
    .map((value) => typeof value === 'string' ? value.trim() : '')
    .filter(Boolean);
}
