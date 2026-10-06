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

// Match every shape of raw environment access the gate must reject: dotted,
// optional-chained and bracket notation, a `globalThis` prefix, destructuring
// the environment off `process`, and importing/requiring the `node:process`
// module. Comments are stripped first so prose never trips the gate.
const RAW_ENV_READ_PATTERNS = [
  /(?:globalThis\s*\.\s*)?process\s*\??\.\s*env\b/,
  /\bprocess\s*\[\s*['"]env['"]\s*\]/,
  /\{[^}]*\benv\b[^}]*\}\s*=\s*(?:globalThis\s*\.\s*)?process\b/,
  /\bfrom\s*['"]node:process['"]/,
  /\brequire\s*\(\s*['"]node:process['"]\s*\)/,
];

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^\\:])\/\/[^\n]*/g, '$1');
}

async function collectSourceFiles(dir, { excludeConfig = true } = {}) {
  let entries = await readdir(dir, { withFileTypes: true });
  let files = [];

  for (let entry of entries) {
    let absolute = path.join(dir, entry.name);
    if (absolute.includes(`${path.sep}node_modules${path.sep}`))
      continue;

    if (excludeConfig && (absolute === CONFIG_ROOT || absolute.startsWith(`${CONFIG_ROOT}${path.sep}`)))
      continue;

    if (entry.isDirectory()) {
      for (let file of await collectSourceFiles(absolute, { excludeConfig }))
        files.push(file);

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
    let content = stripComments(await readFile(file, 'utf8'));
    if (RAW_ENV_READ_PATTERNS.some((pattern) => pattern.test(content)))
      offenders.push(path.relative(SRC_ROOT, file));
  }

  assert.deepEqual(offenders, [], `raw process.env reads found in: ${offenders.join(', ')}`);
});

// The same shape of gate for the working directory: the service cwd comes from
// `KIKX_CWD` or the user's home, never from whatever directory the process was
// launched in. Unlike the env gate this one covers `src/core/config/` too.
const RAW_CWD_READ_PATTERNS = [
  /(?:globalThis\s*\.\s*)?process\s*\??\.\s*cwd\s*\(/,
  /\{[^}]*\bcwd\b[^}]*\}\s*=\s*(?:globalThis\s*\.\s*)?process\b/,
];

test('src/ contains no process.cwd() reads', async () => {
  let files = await collectSourceFiles(SRC_ROOT, { excludeConfig: false });
  assert.ok(files.length > 0, 'expected the scan to find source files under src/');

  let offenders = [];
  for (let file of files) {
    let content = stripComments(await readFile(file, 'utf8'));
    if (RAW_CWD_READ_PATTERNS.some((pattern) => pattern.test(content)))
      offenders.push(path.relative(SRC_ROOT, file));
  }

  assert.deepEqual(offenders, [], `process.cwd() reads found in: ${offenders.join(', ')}`);
});
