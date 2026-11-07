'use strict';

import '../../support/test-env.mjs';

// Campaign S3 slice 3 (plan 5-S3): "append that directory to
// KIKX_PLUGIN_PATHS via the config store so reload keeps finding it".
// ConfigStore is READ-ONLY (env-derived: get/getWithDefault/require/
// resolveAll/list), so the literal wording has no API — the durable seam is
// <cwd>/.kikx/plugin-paths.json, merged with KIKX_PLUGIN_PATHS by boot,
// reload and the inventory's managed-root classification. Env config still
// wins nothing and loses nothing: the two lists are a UNION, deduped by
// mergePluginPaths.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  runtimePluginPathsFile,
  readRuntimePluginPaths,
  appendRuntimePluginPath,
  mergeWithRuntimePluginPaths,
} from '../../../src/core/config/runtime-plugin-paths.mjs';

function tmpCwd(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kikx-rpp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('missing runtime file reads as an empty list', (t) => {
  const cwd = tmpCwd(t);
  assert.deepEqual(readRuntimePluginPaths({ cwd }), []);
  assert.equal(runtimePluginPathsFile(cwd), path.join(cwd, '.kikx', 'plugin-paths.json'));
});

test('append persists, dedupes, and survives a fresh read', (t) => {
  const cwd = tmpCwd(t);
  const dir = path.join(cwd, '.kikx', 'plugins', 'npm', 'kikx-echo');
  appendRuntimePluginPath(dir, { cwd });
  appendRuntimePluginPath(dir, { cwd }); // idempotent — a retry install must not duplicate
  appendRuntimePluginPath(path.join(cwd, 'plugins', 'other'), { cwd });

  const fresh = readRuntimePluginPaths({ cwd });
  assert.equal(fresh.length, 2, 'deduped by resolved path');
  assert.ok(fresh.includes(path.resolve(dir)));
  assert.ok(fs.existsSync(runtimePluginPathsFile(cwd)), 'the list is durable on disk');
});

test('a corrupt runtime file degrades to empty, never throws', (t) => {
  const cwd = tmpCwd(t);
  fs.mkdirSync(path.dirname(runtimePluginPathsFile(cwd)), { recursive: true });
  fs.writeFileSync(runtimePluginPathsFile(cwd), '{not json');
  assert.deepEqual(readRuntimePluginPaths({ cwd }), []);
  // and a later append repairs it
  appendRuntimePluginPath(path.join(cwd, 'x'), { cwd });
  assert.equal(readRuntimePluginPaths({ cwd }).length, 1);
});

test('merge unions configured and runtime paths, deduped and absolute', (t) => {
  const cwd = tmpCwd(t);
  const shared = path.join(cwd, 'plugins', 'shared');
  appendRuntimePluginPath(shared, { cwd });
  appendRuntimePluginPath(path.join(cwd, '.kikx', 'plugins', 'npm', 'a'), { cwd });

  const merged = mergeWithRuntimePluginPaths(['plugins', shared], { cwd });
  assert.ok(merged.includes(path.resolve('plugins')), 'configured paths survive');
  assert.ok(merged.includes(path.resolve(shared)), 'deduped overlap appears once');
  assert.equal(merged.filter((p) => p === path.resolve(shared)).length, 1);
  assert.ok(merged.some((p) => p.endsWith(path.join('.kikx', 'plugins', 'npm', 'a'))), 'runtime additions join');
});
