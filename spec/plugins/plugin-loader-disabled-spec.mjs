'use strict';

import '../support/test-env.mjs';

// Campaign enable/disable (plan §9.1.2): the LOADER honours a disabled set —
// a disabled plugin is skipped BEFORE the signature gate and the import, so
// it never loads, never executes, and never lands in the failure list (it is
// absent by CHOICE, not broken). Callers (boot, reload, install) pass the
// skip keys derived from <service root>/.kikx/plugin-disabled.json.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadPlugins } from '../../src/core/plugins/plugin-loader.mjs';
import { PluginRegistry } from '../../src/core/plugins/index.mjs';

const silent = { warn() {}, info() {}, error() {}, debug() {} };
const commands = { register() {}, get() { return null; }, list() { return []; } };

function makeRegistry() {
  return new PluginRegistry({ logger: silent });
}

function writePlugin(root, name) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ main: 'index.mjs' }));
  fs.writeFileSync(path.join(dir, 'index.mjs'), `
    export const pluginName = ${JSON.stringify(name)};
    export function setup(provide) {
      provide((ctx) => {
        const PluginInterface = ctx.registry.getClass('PluginInterface');
        class T extends PluginInterface { async run() { return 'ok'; } }
        ctx.registry.registerTool(${JSON.stringify(`${name}-tool`)}, T);
      });
    }
  `);
  return dir;
}

function tmpRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kikx-disload-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('disabledNames skips the directory silently: not loaded, no failure entry', async (t) => {
  const root = tmpRoot(t);
  const disabledDir = writePlugin(root, 'disabled-probe');
  writePlugin(root, 'enabled-probe');
  const registry = makeRegistry();

  const loaded = await loadPlugins({
    pluginPaths: root,
    registry,
    commandRegistry: commands,
    context: {},
    logger: silent,
    disabledNames: [ 'disabled-probe' ],
  });

  assert.equal(loaded.length, 1, 'only the enabled plugin loads');
  assert.equal(loaded[0].pluginName, 'enabled-probe');
  assert.ok(registry._pluginRegistrations?.has('enabled-probe'));
  assert.ok(!registry._pluginRegistrations?.has('disabled-probe'), 'the disabled one stays out');
  assert.equal(registry.getTool('disabled-probe-tool'), null, 'and registers nothing');
  const failures = (registry._pluginLoadErrors || []).map((e) => e.location).join(' ');
  assert.ok(!failures.includes('disabled-probe'),
    'a disabled plugin is not a load failure — absence by choice, never an error');
  assert.ok(fs.existsSync(disabledDir), 'skipping loads nothing and deletes nothing');
});

test('without disabledNames (or with an empty set) everything loads — the option is additive', async (t) => {
  const root = tmpRoot(t);
  writePlugin(root, 'plain-one');

  const bare = makeRegistry();
  const loadedBare = await loadPlugins({ pluginPaths: root, registry: bare, commandRegistry: commands, context: {}, logger: silent });
  assert.equal(loadedBare.length, 1, 'no option = old behaviour');

  const empty = makeRegistry();
  const loadedEmpty = await loadPlugins({
    pluginPaths: root, registry: empty, commandRegistry: commands, context: {}, logger: silent, disabledNames: [],
  });
  assert.equal(loadedEmpty.length, 1, 'an empty set changes nothing');
});

test('the skip matches directory basenames (what pluginNameFromPath derives)', async (t) => {
  const root = tmpRoot(t);
  writePlugin(root, 'dir-name-probe');
  const registry = makeRegistry();

  await loadPlugins({
    pluginPaths: root,
    registry,
    commandRegistry: commands,
    context: {},
    logger: silent,
    disabledNames: new Set([ 'dir-name-probe' ]),
  });

  assert.ok(!registry._pluginRegistrations?.has('dir-name-probe'),
    'a Set works as well as an array, matched by directory basename');
});
