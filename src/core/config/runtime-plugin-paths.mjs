'use strict';

// Campaign S3 slice 3 (plan 5-S3): "append that directory to
// KIKX_PLUGIN_PATHS via the config store so reload keeps finding it".
// ConfigStore is READ-ONLY — env-derived sources with get/getWithDefault/
// require/resolveAll/list and no writer — so the literal wording has no API.
// The durable seam this implements instead: <cwd>/.kikx/plugin-paths.json,
// UNIONed with the configured list by boot (create-server), reload and the
// inventory's managed-root classification, all deduped by mergePluginPaths.
// Env config is never mutated and never shadows these: the two lists are a
// union, so an operator's KIKX_PLUGIN_PATHS keeps exactly its meaning.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { mergePluginPaths } from '../plugins/plugin-paths.mjs';

const MAX_BYTES = 64 * 1024;

export function runtimePluginPathsFile(cwd = os.homedir()) {
  return path.join(cwd, '.kikx', 'plugin-paths.json');
}

// The configured working root: KIKX_CWD when the deployment sets it, the
// USER'S HOME otherwise — the platform doctrine (create-server baseCWD):
// never the launcher's cwd. The no-process-cwd gate covers this file. Boot
// passes its resolved baseCWD explicitly; route-side consumers resolve the
// same value through this function so they can never disagree.
export async function runtimeRootForConfig(config) {
  try {
    if (config && typeof config.get === 'function') {
      const { KIKX_CWD_PATH } = await import('./config-paths.mjs');
      const cwd = await config.get(KIKX_CWD_PATH);
      if (typeof cwd === 'string' && cwd.trim()) return path.resolve(cwd.trim());
    }
  } catch { /* fall through to the service home */ }
  return os.homedir();
}

export function readRuntimePluginPaths({ cwd = os.homedir() } = {}) {
  try {
    const file = runtimePluginPathsFile(cwd);
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_BYTES) return [];
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry) => typeof entry === 'string' && entry.trim())
      .map((entry) => path.resolve(entry.trim()));
  } catch {
    return []; // missing or corrupt degrades to "no runtime additions"
  }
}

export async function runtimePathsForConfig(config) {
  return readRuntimePluginPaths({ cwd: await runtimeRootForConfig(config) });
}

// Appends a landed plugin directory to the durable list (idempotent — a
// retry install must not duplicate — and atomic: tmp file + rename, so a
// crash mid-write can never truncate the list other readers depend on).
export function appendRuntimePluginPath(dir, { cwd = os.homedir() } = {}) {
  if (typeof dir !== 'string' || !dir.trim()) return readRuntimePluginPaths({ cwd });
  const list = readRuntimePluginPaths({ cwd });
  const resolved = path.resolve(dir.trim());
  if (!list.includes(resolved)) {
    list.push(resolved);
    writeList(list, cwd);
  }
  return list;
}

export function mergeWithRuntimePluginPaths(configured, { cwd = os.homedir() } = {}) {
  return mergePluginPaths(configured || [], readRuntimePluginPaths({ cwd }));
}

// Uninstall (plan 9.1.1): a deleted directory must leave the runtime list in
// the same breath, or the next reload scans a ghost and reports a permanent
// failure for a directory the operator removed on purpose. Idempotent.
export function removeRuntimePluginPath(dir, { cwd = os.homedir() } = {}) {
  if (typeof dir !== 'string' || !dir.trim()) return readRuntimePluginPaths({ cwd });
  const resolved = path.resolve(dir.trim());
  const list = readRuntimePluginPaths({ cwd });
  const next = list.filter((entry) => entry !== resolved);
  if (next.length !== list.length) writeList(next, cwd);
  return next;
}

function writeList(list, cwd) {
  const file = runtimePluginPathsFile(cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(list, null, 2)}\n`);
  fs.renameSync(tmp, file);
}
