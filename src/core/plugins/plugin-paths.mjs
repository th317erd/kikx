'use strict';

import os from 'node:os';
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

// --- npm landing (campaign S3) ----------------------------------------------
//
// KIKX_PLUGIN_NPM_DIR when configured, else <cwd>/.kikx/plugins/npm — a root
// OUTSIDE every auto-scanned plugin directory on purpose: a tarball whose
// load later fails must not be rediscovered by the next boot and loaded
// anyway (the install route rolls back on failure, and a stray directory
// inside a scanned root would undo that). The inventory counts this root as
// managed ground, so npm-landed plugins are uninstallable like the rest.
export function resolveNpmPluginBase({ npmDir = '', cwd = os.homedir() } = {}) {
  const configured = typeof npmDir === 'string' ? npmDir.trim() : '';
  const base = configured || path.join(cwd, '.kikx', 'plugins', 'npm');
  return path.resolve(base);
}

// Per-package landing directory. The name has already passed the strict
// registry-name regex (no '..', no leading '-', scoped names nest one level
// exactly as npm itself nests them), so splitting on '/' is safe here.
export function npmPluginDirFor(base, name) {
  return path.resolve(base, ...String(name).split('/'));
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
