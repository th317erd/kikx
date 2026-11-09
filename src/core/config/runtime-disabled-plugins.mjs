'use strict';

// Campaign enable/disable persistence (plan §9.1.2 — decided in scope
// 2026-11-05). A RUNTIME FILE, for the same class of reason as
// runtime-plugin-paths: ConfigStore is read-only, and the tag store is
// constructed AFTER the boot plugin load (create-server 262 loads plugins,
// 428 builds tagsStore) — a tag-backed set could never be honoured at
// startup, which is the entire point of the loader honouring it.
// Location: <service root>/.kikx/plugin-disabled.json, atomic writes,
// corrupt reads degrade to empty.
//
// Every entry carries BOTH identities: `name` (UI/route identity — what the
// card is labelled) and `location` (the directory — what the loader skips by
// basename via pluginNameFromPath, and where Enable reloads from). A disable
// without a location is refused: Enable would have nowhere to load from and
// the loader nothing to match.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const MAX_BYTES = 64 * 1024;

export function disabledPluginsFile(cwd = os.homedir()) {
  return path.join(cwd, '.kikx', 'plugin-disabled.json');
}

export function readDisabledPlugins({ cwd = os.homedir() } = {}) {
  try {
    const file = disabledPluginsFile(cwd);
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_BYTES) return [];
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry) => entry && typeof entry.name === 'string' && entry.name
        && typeof entry.location === 'string' && entry.location)
      .map((entry) => ({ name: entry.name, location: entry.location }));
  } catch {
    return []; // missing or corrupt degrades to "nothing disabled"
  }
}

function writeList(list, cwd) {
  const file = disabledPluginsFile(cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(list, null, 2)}\n`);
  fs.renameSync(tmp, file); // atomic: a crash mid-write cannot truncate the set
}

export function setPluginDisabled(name, location, disabled, { cwd = os.homedir() } = {}) {
  if (typeof name !== 'string' || !name.trim())
    throw new Error('disabled set requires a plugin name');
  if (typeof location !== 'string' || !location.trim())
    throw new Error('disabled set requires the plugin location');
  const list = readDisabledPlugins({ cwd });
  const rest = list.filter((entry) => entry.name !== name);
  if (disabled) {
    rest.push({ name, location });
    rest.sort((a, b) => a.name.localeCompare(b.name)); // stable file for diffs/tests
  }
  writeList(rest, cwd);
  return rest;
}

export function getDisabledPlugin(name, { cwd = os.homedir() } = {}) {
  return readDisabledPlugins({ cwd }).find((entry) => entry.name === name) || null;
}

export function removePluginDisabled(name, { cwd = os.homedir() } = {}) {
  return setPluginDisabled(name, '/removed', false, { cwd });
}

// Loader skip keys (plan 9.1.2): the loader matches DIRECTORY BASNAMES via
// pluginNameFromPath, while the UI/routes speak the plugin's name — derive
// the basename set here so boot/reload/install cannot each invent a subtly
// different spelling.
export function disabledSkipKeys({ cwd = os.homedir() } = {}) {
  return readDisabledPlugins({ cwd }).map((entry) => path.basename(entry.location));
}
