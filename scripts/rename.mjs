'use strict';

// =============================================================================
// rename.mjs — Kikx → Kikx rename script
// =============================================================================
// Three-pass approach:
//   1. Content replacement (ordered, specific-to-generic)
//   2. File renames (files with "hero" in their name)
//   3. Directory renames (bottom-up, deepest first)
//
// Usage:
//   node scripts/rename.mjs --dry-run   # Preview changes
//   node scripts/rename.mjs             # Execute changes
// =============================================================================

import { readdir, readFile, writeFile, rename, stat } from 'node:fs/promises';
import { join, relative, basename, dirname }          from 'node:path';

const DRY_RUN    = process.argv.includes('--dry-run');
const PROJECT_ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

// =============================================================================
// Directories to skip entirely
// =============================================================================

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.claude',
  'package-lock.json',
]);

// =============================================================================
// File extensions to process for content replacement
// =============================================================================

const TEXT_EXTENSIONS = new Set([
  '.mjs', '.js', '.cjs', '.ts',
  '.json',
  '.html', '.htm',
  '.css',
  '.yaml', '.yml',
  '.md',
  '.conf',
  '.service',
  '.logrotate',
  '.sh',
  '.txt',
  '.eslintrc',
]);

function isTextFile(filePath) {
  let ext = filePath.slice(filePath.lastIndexOf('.'));

  if (TEXT_EXTENSIONS.has(ext))
    return true;

  // Handle dotfiles like .eslintrc.cjs
  let base = basename(filePath);

  if (base === '.eslintrc.cjs')
    return true;

  return false;
}

// =============================================================================
// Content replacement rules (ordered, specific first)
// =============================================================================
// Each rule: [pattern, replacement]
// Patterns are RegExp objects with 'g' flag.
// Order matters — specific matches must come before generic ones.
// =============================================================================

function buildReplacementRules() {
  return [
    // -----------------------------------------------------------------------
    // False-positive protection: spothero must be preserved.
    // We handle this by temporarily replacing it, then restoring.
    // Instead, we use negative lookbehind/lookahead in our patterns.
    // -----------------------------------------------------------------------

    // --- Specific compound identifiers first ---

    // Class/function names
    [/\bcreateHeroCore\b/g,   'createKikxCore'],
    [/\bHeroCore\b/g,         'KikxCore'],

    // Package names in JSON
    [/"name":\s*"hero"/g,     '"name": "kikx"'],
    [/"kikx-claude-agent"/g,  '"kikx-claude-agent"'],

    // Config identifiers
    [/name:\s*'hero'/g,       "name: 'kikx'"],

    // Cookie / token names
    [/\bhero_token\b/g,       'kikx_token'],

    // JWT secret identifier
    [/\bhero-jwt-secret\b/g,  'kikx-jwt-secret'],

    // App name in application.mjs
    [/\bhero-v2\b/g,          'kikx-v2'],

    // HTML custom elements: <kikx-xxx> and </kikx-xxx>
    // Must not match spothero
    [/(?<!spot)<kikx-/g,      '<kikx-'],
    [/(?<!spot)<\/kikx-/g,    '</kikx-'],

    // HML prompt tag
    [/\bhero-hml-prompt\b/g,  'kikx-hml-prompt'],

    // Component class names (e.g., KikxApplication, KikxLoginPage)
    [/\bHero([A-Z][a-zA-Z]*)/g, 'Kikx$1'],

    // Import paths with kikx-
    [/(?<=["'`/])kikx-(?!.*spothero)/g, 'kikx-'],

    // --- System paths ---

    // Config directory
    [/\.config\/kikx\b/g,     '.config/kikx'],

    // System paths
    [/\/opt\/kikx\b/g,        '/opt/kikx'],
    [/\/opt\/kikx-client\b/g, '/opt/kikx-client'],
    [/\/var\/log\/kikx\b/g,   '/var/log/kikx'],

    // Domain names
    [/\bhero\.com\b/g,        'kikx.com'],

    // Database files
    [/\bhero\.db\b/g,         'kikx.db'],
    [/\bhero\.sqlite\b/g,     'kikx.sqlite'],

    // Service file reference
    [/\bhero\.service\b/g,    'kikx.service'],
    [/\bhero\.logrotate\b/g,  'kikx.logrotate'],

    // URL path segments: /kikx/ but not /spothero/
    [/(?<!spot)\/kikx\//g,    '/kikx/'],

    // --- Generic word-boundary replacements (last) ---

    // SyslogIdentifier=kikx, Description=kikx etc.
    [/(?<=[=:])kikx\b/g,      'kikx'],

    // Prose: "Kikx " at word boundary (but not spothero)
    // Using lookbehind to exclude 'spot' prefix
    [/(?<![a-zA-Z])Hero(?=[\s.,;:!?\n\r\-\/\\])/g, 'Kikx'],

    // Lowercase kikx in prose/identifiers (careful with lookbehind)
    // Only match standalone 'hero' not preceded by alphabetic (excludes spothero)
    [/(?<![a-zA-Z])hero(?=[\s.,;:!?\n\r\-\/\\])/g, 'kikx'],
  ];
}

// =============================================================================
// Pass 1: Content replacement
// =============================================================================

async function replaceContent(filePath, rules) {
  let content;

  try {
    content = await readFile(filePath, 'utf8');
  } catch {
    return { changed: false };
  }

  let original = content;

  for (let [pattern, replacement] of rules) {
    // Reset lastIndex for global regexes
    pattern.lastIndex = 0;
    content = content.replace(pattern, replacement);
  }

  if (content === original)
    return { changed: false };

  let rel = relative(PROJECT_ROOT, filePath);

  if (DRY_RUN) {
    console.log(`[content] ${rel}`);
    return { changed: true };
  }

  await writeFile(filePath, content, 'utf8');
  console.log(`[content] ${rel}`);

  return { changed: true };
}

// =============================================================================
// Walk the file tree
// =============================================================================

async function walk(directory) {
  let results = { files: [], directories: [] };
  let entries;

  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return results;
  }

  for (let entry of entries) {
    let fullPath = join(directory, entry.name);

    if (SKIP_DIRS.has(entry.name))
      continue;

    if (entry.isDirectory()) {
      results.directories.push(fullPath);

      let sub = await walk(fullPath);
      for (let f of sub.files) results.files.push(f);
      for (let d of sub.directories) results.directories.push(d);
    } else if (entry.isFile()) {
      results.files.push(fullPath);
    }
  }

  return results;
}

// =============================================================================
// Pass 2: File renames
// =============================================================================

function getNewFileName(filePath) {
  let name = basename(filePath);

  // Don't rename if "hero" is part of "spothero"
  if (name.includes('spothero'))
    return null;

  if (!name.toLowerCase().includes('hero'))
    return null;

  let newName = name
    .replace(/kikx-/g,  'kikx-')
    .replace(/Kikx/g,   'Kikx')
    .replace(/kikx\./g, 'kikx.')
    .replace(/kikx/g,   'kikx');

  if (newName === name)
    return null;

  return join(dirname(filePath), newName);
}

// =============================================================================
// Pass 3: Directory renames (deepest first)
// =============================================================================

function getNewDirName(dirPath) {
  let name = basename(dirPath);

  if (name.includes('spothero'))
    return null;

  if (!name.toLowerCase().includes('hero'))
    return null;

  let newName = name
    .replace(/kikx-/g,  'kikx-')
    .replace(/Kikx/g,   'Kikx')
    .replace(/kikx/g,   'kikx');

  if (newName === name)
    return null;

  return join(dirname(dirPath), newName);
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`  Kikx → Kikx rename script`);
  console.log(`  Project: ${PROJECT_ROOT}`);
  console.log(`  Mode: ${DRY_RUN ? 'DRY RUN (no changes)' : 'LIVE (writing changes)'}`);
  console.log(`${'='.repeat(70)}\n`);

  let rules = buildReplacementRules();
  let tree  = await walk(PROJECT_ROOT);

  // -------------------------------------------------------------------------
  // Pass 1: Content replacement
  // -------------------------------------------------------------------------
  console.log('--- Pass 1: Content replacement ---\n');

  let contentChanges = 0;

  for (let filePath of tree.files) {
    if (!isTextFile(filePath))
      continue;

    let result = await replaceContent(filePath, rules);

    if (result.changed)
      contentChanges++;
  }

  console.log(`\n  ${contentChanges} files with content changes\n`);

  // -------------------------------------------------------------------------
  // Pass 2: File renames
  // -------------------------------------------------------------------------
  console.log('--- Pass 2: File renames ---\n');

  let fileRenames = 0;

  for (let filePath of tree.files) {
    let newPath = getNewFileName(filePath);

    if (!newPath)
      continue;

    let relOld = relative(PROJECT_ROOT, filePath);
    let relNew = relative(PROJECT_ROOT, newPath);

    if (DRY_RUN) {
      console.log(`[file] ${relOld} → ${relNew}`);
    } else {
      await rename(filePath, newPath);
      console.log(`[file] ${relOld} → ${relNew}`);
    }

    fileRenames++;
  }

  console.log(`\n  ${fileRenames} files renamed\n`);

  // -------------------------------------------------------------------------
  // Pass 3: Directory renames (deepest first)
  // -------------------------------------------------------------------------
  console.log('--- Pass 3: Directory renames ---\n');

  // Sort directories deepest first (longest path first)
  let dirsToRename = [];

  for (let dirPath of tree.directories) {
    let newPath = getNewDirName(dirPath);

    if (newPath)
      dirsToRename.push({ from: dirPath, to: newPath });
  }

  dirsToRename.sort((a, b) => b.from.length - a.from.length);

  let dirRenames = 0;

  for (let { from, to } of dirsToRename) {
    let relOld = relative(PROJECT_ROOT, from);
    let relNew = relative(PROJECT_ROOT, to);

    if (DRY_RUN) {
      console.log(`[dir] ${relOld} → ${relNew}`);
    } else {
      await rename(from, to);
      console.log(`[dir] ${relOld} → ${relNew}`);
    }

    dirRenames++;
  }

  console.log(`\n  ${dirRenames} directories renamed\n`);

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  console.log(`${'='.repeat(70)}`);
  console.log(`  Summary:`);
  console.log(`    Content changes: ${contentChanges} files`);
  console.log(`    File renames:    ${fileRenames} files`);
  console.log(`    Dir renames:     ${dirRenames} directories`);
  console.log(`  Mode: ${DRY_RUN ? 'DRY RUN — no files were modified' : 'LIVE — all changes applied'}`);
  console.log(`${'='.repeat(70)}\n`);
}

main().catch((error) => {
  console.error('Rename script failed:', error);
  process.exit(1);
});
