'use strict';

// Hard cap from AGENTS.md: 800 lines per hand-written source file. This is a
// guard, not a style preference: the requested failure text is the refactoring
// directive itself so a red CI run tells the next bot exactly what to do.
//
// Scope: hand-written source under src/. Dependencies, vendored components, and
// generated files are excluded by pruning node_modules/vendor and limiting the
// scan to source extensions. Tests/data files are not production source.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SOURCE_ROOT = path.join(ROOT, 'src');
const SOURCE_EXTENSIONS = new Set([ '.mjs', '.js', '.cjs', '.css' ]);
const SKIP_DIRECTORIES = new Set([ 'node_modules', 'vendor' ]);
const HARD_CAP = 800;

function lineCount(text) {
  if (text === '')
    return 0;
  let count = text.split(/\r?\n/).length;
  return text.endsWith('\n') ? count - 1 : count;
}

async function sourceFiles(directory) {
  let entries = await readdir(directory, { withFileTypes: true });
  let files = [];
  for (let entry of entries) {
    if (entry.name.startsWith('.') || SKIP_DIRECTORIES.has(entry.name))
      continue;
    let fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await sourceFiles(fullPath));
      continue;
    }
    if (!entry.isFile() || !SOURCE_EXTENSIONS.has(path.extname(entry.name)))
      continue;
    files.push(fullPath);
  }
  return files;
}

test('hand-written source files stay under the 800-line hard cap', async () => {
  let violations = [];
  for (let file of await sourceFiles(SOURCE_ROOT)) {
    let lines = lineCount(await readFile(file, 'utf8'));
    if (lines > HARD_CAP)
      violations.push({ file: path.relative(ROOT, file), lines });
  }

  violations.sort((left, right) => right.lines - left.lines || left.file.localeCompare(right.file));
  let failures = violations.map(({ file, lines }) => (
    `${file} is over 800 lines (${lines} lines); please split it apart, and refactor it into smaller files until it is under the 800 line hard cap (preferably under the 500 soft-cap).`
  ));

  assert.equal(
    failures.length,
    0,
    `Source files exceed the 800-line hard cap:\n${failures.join('\n')}`,
  );
});
