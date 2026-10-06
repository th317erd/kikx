'use strict';

import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Grep-gate: every environment read must go through the ConfigStore (or, for
// ambient snapshots, `snapshotEnvironment`). Only `src/core/config/` may touch
// `process.env` directly. This test genuinely reads every `.mjs`/`.js` file
// under `src/` and fails with the offending paths, so a new raw read cannot
// slip in unnoticed.
const SRC_ROOT = fileURLToPath(new URL('../../../src/', import.meta.url));
const CONFIG_ROOT = path.join(SRC_ROOT, 'core', 'config');

async function collectSourceFiles(dir) {
  let entries = await readdir(dir, { withFileTypes: true });
  let files = [];

  for (let entry of entries) {
    let absolute = path.join(dir, entry.name);
    if (absolute.includes(`${path.sep}node_modules${path.sep}`))
      continue;

    if (absolute === CONFIG_ROOT || absolute.startsWith(`${CONFIG_ROOT}${path.sep}`))
      continue;

    if (entry.isDirectory()) {
      files.push(...await collectSourceFiles(absolute));
      continue;
    }

    if (entry.isFile() && (entry.name.endsWith('.mjs') || entry.name.endsWith('.js')))
      files.push(absolute);
  }

  return files;
}

test('src/ contains no raw process.env reads outside the config module', async () => {
  let files = await collectSourceFiles(SRC_ROOT);
  assert.ok(files.length > 0, 'expected the scan to find source files under src/');

  let offenders = [];
  for (let file of files) {
    let content = await readFile(file, 'utf8');
    if (content.includes('process.env'))
      offenders.push(path.relative(SRC_ROOT, file));
  }

  assert.deepEqual(offenders, [], `raw process.env reads found in: ${offenders.join(', ')}`);
});
