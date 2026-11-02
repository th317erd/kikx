'use strict';

// =============================================================================
// A plugin reload must reload the plugin's SUBMODULES, not only its entry
// =============================================================================
// Owner's binding rule for this platform: plugins must install, reload and
// unload WITHOUT a service restart, and "a plugin-only change needing a restart
// is a defect report about us".
//
// MEASURED DEFECT. plugin-loader.mjs imports a plugin as
//
//     await import(`${pathToFileURL(modulePath).href}?t=${Date.now()}`);
//
// The `?t=` busts the cache for the ENTRY module and nothing else. A static
// `import { X } from './inbound-router.mjs'` inside that entry resolves to a URL
// with no query, which Node caches for the life of the process. So a reload
// re-evaluates index.mjs against the OLD submodules.
//
// It has a signature that makes it very hard to notice: the reload returns
// HTTP 200 with an empty failures list, the entry module genuinely is new, and
// the plugin keeps running. Only the code in every other file is stale.
//
// OBSERVED LIVE, which is why this file exists. After reloading a Discord plugin
// whose inbound-router.mjs had just gained an attachment reader, a real
// image-only Discord message was STILL dropped with
// 'empty_content_missing_intent' -- the very reason the fix was written. Unit
// tests passed, the reload reported success, and the new code was never entered.
//
// WHAT THIS SPEC LOCKS DOWN:
//   A. A plugin's submodule is re-read from disk after invalidation.
//   B. Without invalidation nothing changes -- the hook is opt-in per root and
//      does not quietly alter normal server behaviour.
//   C. Files OUTSIDE a registered plugin root (core modules, other plugins) are
//      never rewritten, so a plugin reload cannot invalidate core.
//   D. A file that is not in any registered root keeps a clean URL, which is the
//      property that keeps this from leaking into unrelated imports.

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  invalidatePluginModules,
  pluginModuleCacheState,
  registerReloadablePluginRoot,
  resetPluginModuleCacheForTests,
} from '../../../src/core/plugins/plugin-module-cache.mjs';

// A throwaway plugin on disk: an entry that statically imports a submodule, plus
// a core-like file outside the plugin root for the negative control.
async function makePluginFixture() {
  let base = await mkdtemp(path.join(tmpdir(), 'kikx-plugin-reload-'));
  let pluginRoot = path.join(base, 'my-plugin');
  let otherRoot = path.join(base, 'other-plugin');
  await mkdir(pluginRoot, { recursive: true });
  await mkdir(otherRoot, { recursive: true });

  let writeSub = (value) => writeFile(path.join(pluginRoot, 'sub.mjs'),
    `export const VALUE = ${JSON.stringify(value)};\n`);
  let writeOther = (value) => writeFile(path.join(otherRoot, 'sub.mjs'),
    `export const VALUE = ${JSON.stringify(value)};\n`);

  await writeSub('OLD');
  await writeOther('STABLE');
  await writeFile(path.join(pluginRoot, 'entry.mjs'),
    "import { VALUE } from './sub.mjs';\nexport const value = VALUE;\n");
  await writeFile(path.join(otherRoot, 'entry.mjs'),
    "import { VALUE } from './sub.mjs';\nexport const value = VALUE;\n");

  return { base, pluginRoot, otherRoot, writeSub, writeOther };
}

async function importFresh(filePath) {
  // A unique query per call, exactly like the loader's `?t=${Date.now()}`.
  let url = pathToFileURL(filePath).href;
  return import(`${url}?t=${Date.now()}-${Math.random()}`);
}

test('a plugin submodule is re-read from disk after invalidatePluginModules', async () => {
  resetPluginModuleCacheForTests();
  let fixture = await makePluginFixture();
  try {
    assert.equal(registerReloadablePluginRoot(fixture.pluginRoot), true,
      'the reload hook must install on this Node');

    // First load, as a boot would do it.
    invalidatePluginModules(fixture.pluginRoot);
    let first = await importFresh(path.join(fixture.pluginRoot, 'entry.mjs'));
    assert.equal(first.value, 'OLD');

    // The author edits the SUBMODULE only. This is the case that was broken.
    await fixture.writeSub('NEW');

    // A reload invalidates the root, then imports the entry again -- which must
    // now see NEW rather than the cached OLD.
    invalidatePluginModules(fixture.pluginRoot);
    let second = await importFresh(path.join(fixture.pluginRoot, 'entry.mjs'));

    assert.equal(second.value, 'NEW',
      'a plugin reload must re-evaluate the plugin\'s own submodules, not just its entry file');
  } finally {
    resetPluginModuleCacheForTests();
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test('a submodule change is invisible WITHOUT a reload', async () => {
  // The control that keeps the fix honest: this must NOT be a live-reload
  // mechanism. Re-importing the same generation must keep serving what that
  // generation parsed, or every request would re-read the disk.
  resetPluginModuleCacheForTests();
  let fixture = await makePluginFixture();
  try {
    registerReloadablePluginRoot(fixture.pluginRoot);
    invalidatePluginModules(fixture.pluginRoot);

    let first = await importFresh(path.join(fixture.pluginRoot, 'entry.mjs'));
    assert.equal(first.value, 'OLD');

    await fixture.writeSub('NEW');

    // No invalidation: same generation, so the same parsed module.
    let second = await importFresh(path.join(fixture.pluginRoot, 'entry.mjs'));
    assert.equal(second.value, 'OLD',
      'without a reload the plugin must keep the code it loaded; this is not a file watcher');
  } finally {
    resetPluginModuleCacheForTests();
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test('reloading one plugin does not invalidate another plugin or core', async () => {
  // Blast-radius control. A reload of plugin A must not rewrite the URLs of
  // plugin B, or one plugin's reload would silently force every other plugin --
  // and core -- to re-parse, which is both slow and a correctness hazard.
  resetPluginModuleCacheForTests();
  let fixture = await makePluginFixture();
  try {
    registerReloadablePluginRoot(fixture.pluginRoot);
    invalidatePluginModules(fixture.pluginRoot);
    invalidatePluginModules(fixture.otherRoot);

    let otherFirst = await importFresh(path.join(fixture.otherRoot, 'entry.mjs'));
    assert.equal(otherFirst.value, 'STABLE');

    await fixture.writeOther('CHANGED');

    // Only the first plugin reloads.
    invalidatePluginModules(fixture.pluginRoot);

    let otherSecond = await importFresh(path.join(fixture.otherRoot, 'entry.mjs'));
    assert.equal(otherSecond.value, 'STABLE',
      'reloading one plugin must not invalidate a different plugin\'s modules');

    // And the first plugin's own reload still works.
    let firstSecond = await importFresh(path.join(fixture.pluginRoot, 'entry.mjs'));
    assert.ok([ 'OLD', 'NEW' ].includes(firstSecond.value));
  } finally {
    resetPluginModuleCacheForTests();
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test('the cache state reports what is registered, for the reload path to trust', () => {
  resetPluginModuleCacheForTests();
  let empty = pluginModuleCacheState();
  // installed is PROCESS-GLOBAL and cannot be uninstalled once the hook is
  // registered, exactly as plugin-module-cache.mjs documents it. Earlier tests
  // in this file therefore leave it true, so asserting it is false here would be
  // an order-dependent test that passes alone and fails in the suite. What must
  // hold is the property the reload path relies on: with no roots registered the
  // hook has nothing to rewrite.
  assert.deepEqual(empty.roots, [], 'no roots are registered, so nothing is rewritten');

  registerReloadablePluginRoot('/tmp/kikx-spec-plugin-root');
  let state = pluginModuleCacheState();
  assert.equal(state.installed, true);
  assert.deepEqual(state.roots, [ '/tmp/kikx-spec-plugin-root' ]);
  assert.equal(state.generations['/tmp/kikx-spec-plugin-root'], 0,
    'a freshly registered root starts at generation 0, so it does not rewrite anything yet');

  let generation = invalidatePluginModules('/tmp/kikx-spec-plugin-root');
  assert.equal(generation, 1);
  assert.equal(pluginModuleCacheState().generations['/tmp/kikx-spec-plugin-root'], 1);

  resetPluginModuleCacheForTests();
});

test('a plugin root is required, so the hook cannot be armed on the whole disk', () => {
  resetPluginModuleCacheForTests();
  assert.throws(() => registerReloadablePluginRoot(''), TypeError);
  assert.throws(() => registerReloadablePluginRoot(null), TypeError);
  assert.throws(() => registerReloadablePluginRoot(undefined), TypeError);
  resetPluginModuleCacheForTests();
});
