'use strict';

// Read a stylesheet plus its local @imports in cascade order. A split sheet's
// entry point is intentionally small; assertions about rules must inspect the
// bundle, not only the entry file.

import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const IMPORT_PATTERN = /@import\s+url\(\s*["']?([^"')]+)["']?\s*\)\s*;/g;

function importTargets(text) {
  return [ ...text.matchAll(IMPORT_PATTERN) ].map((match) => match[1]);
}

function localImportPath(parent, target) {
  if (!target || /^(?:[a-z]+:)?\/\//i.test(target) || target.startsWith('data:'))
    return null;
  return path.resolve(path.dirname(parent), target.split('?')[0]);
}

export function readCssBundleSync(filePath, seen = new Set()) {
  let absolute = filePath instanceof URL ? fileURLToPath(filePath) : path.resolve(filePath);
  if (seen.has(absolute))
    return '';
  seen.add(absolute);
  let source = readFileSync(absolute, 'utf8');
  let bundle = '';
  for (let target of importTargets(source)) {
    let imported = localImportPath(absolute, target);
    if (!imported || !existsSync(imported))
      continue;
    bundle += readCssBundleSync(imported, seen);
  }
  return bundle + source;
}

export async function readCssBundle(filePath, seen = new Set()) {
  let absolute = filePath instanceof URL ? fileURLToPath(filePath) : path.resolve(filePath);
  if (seen.has(absolute))
    return '';
  seen.add(absolute);
  let source = await readFile(absolute, 'utf8');
  let bundle = '';
  for (let target of importTargets(source)) {
    let imported = localImportPath(absolute, target);
    if (!imported || !existsSync(imported))
      continue;
    bundle += await readCssBundle(imported, seen);
  }
  return bundle + source;
}
