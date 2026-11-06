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

// --- managed classification (campaign S2/S4) -------------------------------
//
// The inventory route reports this per record and the future uninstall gate
// consumes it, so it lives beside the path merging it must agree with.
// Definitions (plan §5-S2, owner decision 4): MANAGED = a location under the
// runtime plugin dir (KIKX_PLUGIN_NPM_DIR, when the NPM phase lands it joins
// the roots below) or under an operator-configured KIKX_PLUGIN_PATHS entry.
// The bundled root — platform-shipped plugins merged in first by
// create-server — is NEVER managed, and an unknown root fails CLOSED: an
// uninstall must never act outside ground the deployment named.
import { fileURLToPath } from 'node:url';

export const BUNDLED_PLUGIN_ROOT = fileURLToPath(new URL('../../plugins/', import.meta.url));

function isUnder(candidate, root) {
  if (typeof root !== 'string' || root.trim() === '')
    return false;
  const normalizedRoot = root.endsWith('/') || root.endsWith('\\') ? root : `${root}/`;
  return candidate === root || candidate.startsWith(normalizedRoot);
}

export function isManagedPluginLocation(location, { bundledRoot = BUNDLED_PLUGIN_ROOT, configuredPaths = '' } = {}) {
  if (typeof location !== 'string' || location.trim() === '')
    return false;

  let candidate;
  try {
    candidate = path.resolve(location.trim());
  } catch {
    return false;
  }

  if (isUnder(candidate, path.resolve(bundledRoot)))
    return false;

  const roots = (typeof configuredPaths === 'string' ? configuredPaths.split(path.delimiter) : Array.isArray(configuredPaths) ? configuredPaths : [])
    .map((root) => (typeof root === 'string' ? root.trim() : ''))
    .filter(Boolean);
  for (const root of roots) {
    if (isUnder(candidate, path.resolve(root)))
      return true;
  }

  return false;
}
