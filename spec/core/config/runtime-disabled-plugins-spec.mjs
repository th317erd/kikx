'use strict';

import '../../support/test-env.mjs';

// Campaign enable/disable persistence (plan §9.1.2, decided in scope). The
// store is a RUNTIME FILE, deliberately not the tag store: tagsStore is
// constructed AFTER the boot plugin load (create-server 262 loads, 428 builds
// tags), so a tag-backed disabled set could never be honoured at startup —
// and ConfigStore is read-only. Same seam family as plugin-paths.json:
// <service root>/.kikx/plugin-disabled.json, atomic writes, corrupt → empty.
//
// Each entry keeps BOTH identities: `name` (what the UI and routes call it)
// and `location` (the directory — what the loader skips by basename, and
// where Enable reloads from).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  disabledPluginsFile,
  readDisabledPlugins,
  setPluginDisabled,
  getDisabledPlugin,
  removePluginDisabled,
  disabledSkipKeys,
} from '../../../src/core/config/runtime-disabled-plugins.mjs';

function tmpCwd(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kikx-dis-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('missing file reads as an empty list; the file lives under .kikx/', (t) => {
  const cwd = tmpCwd(t);
  assert.deepEqual(readDisabledPlugins({ cwd }), []);
  assert.equal(disabledPluginsFile(cwd), path.join(cwd, '.kikx', 'plugin-disabled.json'));
});

test('disable records name AND location; enable removes the entry; idempotent both ways', (t) => {
  const cwd = tmpCwd(t);
  const location = path.join(cwd, 'plugins', 'alpha');

  setPluginDisabled('alpha', location, true, { cwd });
  setPluginDisabled('alpha', location, true, { cwd }); // re-disable: one entry, not two
  let list = readDisabledPlugins({ cwd });
  assert.equal(list.length, 1, 'idempotent');
  assert.deepEqual(list[0], { name: 'alpha', location });

  const entry = getDisabledPlugin('alpha', { cwd });
  assert.ok(entry, 'lookup by name powers Enable and uninstall');
  assert.equal(entry.location, location, 'the location is what Enable reloads from');

  setPluginDisabled('alpha', location, false, { cwd });
  assert.deepEqual(readDisabledPlugins({ cwd }), [], 'enable clears the entry');
  assert.equal(getDisabledPlugin('alpha', { cwd }), null);
  assert.ok(fs.existsSync(disabledPluginsFile(cwd)), 'the file itself survives as an empty list');
});

test('multiple entries coexist and removal of one keeps the others', (t) => {
  const cwd = tmpCwd(t);
  setPluginDisabled('alpha', '/p/alpha', true, { cwd });
  setPluginDisabled('beta', '/p/beta', true, { cwd });
  assert.equal(readDisabledPlugins({ cwd }).length, 2);
  removePluginDisabled('alpha', { cwd });
  const rest = readDisabledPlugins({ cwd });
  assert.equal(rest.length, 1);
  assert.equal(rest[0].name, 'beta');
});

test('disabling without a location is refused — Enable would have nowhere to load from', (t) => {
  const cwd = tmpCwd(t);
  assert.throws(() => setPluginDisabled('alpha', '', true, { cwd }), /location/);
  assert.throws(() => setPluginDisabled('', '/p/x', true, { cwd }), /name/);
  assert.deepEqual(readDisabledPlugins({ cwd }), []);
});

test('a corrupt file degrades to empty and the next write repairs it', (t) => {
  const cwd = tmpCwd(t);
  fs.mkdirSync(path.dirname(disabledPluginsFile(cwd)), { recursive: true });
  fs.writeFileSync(disabledPluginsFile(cwd), '{broken json');
  assert.deepEqual(readDisabledPlugins({ cwd }), []);
  setPluginDisabled('alpha', '/p/alpha', true, { cwd });
  assert.equal(readDisabledPlugins({ cwd }).length, 1, 'a later disable overwrites the corruption');
});

test('disabledSkipKeys derives loader basenames from stored locations', (t) => {
  const cwd = tmpCwd(t);
  assert.deepEqual(disabledSkipKeys({ cwd }), [], 'empty set, empty keys');
  setPluginDisabled('alpha', '/srv/plugs/alpha', true, { cwd });
  setPluginDisabled('@scope/pkg', '/srv/plugs/pkgdir', true, { cwd });
  // The loader matches pluginNameFromPath (directory basename), NOT the
  // display name — the derivation lives in ONE place so callers cannot drift.
  assert.deepEqual(disabledSkipKeys({ cwd }).sort(), [ 'alpha', 'pkgdir' ]);
});
