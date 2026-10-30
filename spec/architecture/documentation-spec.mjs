'use strict';

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DOCS_ROOT = path.join(ROOT, 'docs');
const INDEX_PATH = path.join(DOCS_ROOT, 'README.md');

async function walkMarkdown(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return walkMarkdown(entryPath);
    return entry.isFile() && entry.name.endsWith('.md') ? [entryPath] : [];
  }));
  return nested.flat().sort();
}

function withoutFencedCode(markdown) {
  return markdown.replace(/^(```|~~~)[\s\S]*?^\1.*$/gm, '');
}

function relativeMarkdownTargets(markdown) {
  const targets = [];
  const source = withoutFencedCode(markdown);
  const expression = /!?(?:\[[^\]]*\])\(([^)]+)\)/g;
  for (const match of source.matchAll(expression)) {
    let target = match[1].trim();
    if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1);
    target = target.split(/\s+["']/u, 1)[0];
    if (!target || target.startsWith('#') || target.startsWith('/') || /^[a-z][a-z0-9+.-]*:/iu.test(target)) continue;
    const [pathname] = target.split('#', 1);
    if (pathname) targets.push(decodeURIComponent(pathname));
  }
  return targets;
}

test('legacy bot-docs tree has been fully consolidated', async () => {
  await assert.rejects(fs.access(path.join(ROOT, 'bot-docs')));
});

test('the canonical index includes every documentation file', async () => {
  const [documents, index] = await Promise.all([
    walkMarkdown(DOCS_ROOT),
    fs.readFile(INDEX_PATH, 'utf8'),
  ]);
  const missing = documents
    .filter((document) => document !== INDEX_PATH)
    .map((document) => `./${path.relative(DOCS_ROOT, document)}`)
    .filter((relativePath) => !index.includes(relativePath));
  assert.deepEqual(missing, [], `Unindexed documentation:\n${missing.join('\n')}`);
});

test('relative Markdown links in documentation entry points resolve', async () => {
  const documents = [
    ...(await walkMarkdown(DOCS_ROOT)),
    path.join(ROOT, 'README.md'),
    path.join(ROOT, 'TODO.md'),
  ];
  const missing = [];
  for (const document of documents) {
    const markdown = await fs.readFile(document, 'utf8');
    for (const target of relativeMarkdownTargets(markdown)) {
      const resolved = path.resolve(path.dirname(document), target);
      try {
        await fs.access(resolved);
      } catch {
        missing.push(`${path.relative(ROOT, document)} -> ${target}`);
      }
    }
  }
  assert.deepEqual(missing, [], `Unresolved documentation links:\n${missing.join('\n')}`);
});

test('every documentation file declares its authority near the top', async () => {
  const documents = await walkMarkdown(DOCS_ROOT);
  const missing = [];
  for (const document of documents) {
    const head = (await fs.readFile(document, 'utf8')).split('\n').slice(0, 24).join('\n');
    if (!/\b(current|active|completed|superseded|historical|canonical)\b/iu.test(head)) {
      missing.push(path.relative(ROOT, document));
    }
  }
  assert.deepEqual(missing, [], `Documentation without an authority banner:\n${missing.join('\n')}`);
});

test('current docs do not point at retired documentation locations', async () => {
  const documents = await walkMarkdown(DOCS_ROOT);
  const activeDocuments = documents.filter((document) => !document.includes(`${path.sep}history${path.sep}`));
  const forbidden = /bot-docs\/|docs\/(?:architecture|agentic-script|context-compaction|frontend|mythix-translation|proper-agent-behavior)\.md/iu;
  const failures = [];
  for (const document of activeDocuments) {
    const markdown = withoutFencedCode(await fs.readFile(document, 'utf8'));
    if (forbidden.test(markdown)) failures.push(path.relative(ROOT, document));
  }
  assert.deepEqual(failures, [], `Current docs reference retired locations:\n${failures.join('\n')}`);
});

test('current auth documentation rejects the retired backend-proxy model', async () => {
  const authentication = await fs.readFile(path.join(DOCS_ROOT, 'reference/authentication.md'), 'utf8');
  assert.doesNotMatch(authentication, /authentication is delegated to aeordb/iu);
  assert.match(authentication, /driver[- ]neutral/iu);
});
