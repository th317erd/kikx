'use strict';

// A pure module with a passing spec is not a delivered feature unless a
// production entry point imports or registers it. These assertions are small,
// but they catch the exact orphaned-module failure mode reported in feedback
// fc025dad: the feature code and its spec both pass while nothing calls it.

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const ROOT = new URL('../../', import.meta.url);
const createServer = await fs.readFile(new URL('src/server/create-server.mjs', ROOT), 'utf8');
const builtInTools = await fs.readFile(new URL('src/core/tools/register-built-in-tools.mjs', ROOT), 'utf8');
const questionStore = await fs.readFile(new URL('src/core/questions/questions-store.mjs', ROOT), 'utf8');

test('session merge code is reachable from the server and the built-in tool registry', () => {
  assert.match(createServer, /from '\.\.\/core\/merge\/index\.mjs'/);
  assert.match(createServer, /new SessionMergeService\(/);
  assert.match(createServer, /context\.set\('sessionMergeService'/);
  assert.match(builtInTools, /from '\.\/session-merge-tools\.mjs'/);
  assert.match(builtInTools, /\[ 'session-merge', SessionMergeTool \]/);
  assert.match(builtInTools, /\[ 'session-merge-status', SessionMergeStatusTool \]/);
});

test('the question store is wired to a live session-tree source, not a dead snapshot', () => {
  assert.match(questionStore, /sessionLister/);
  assert.match(createServer, /sessionLister:\s*\(\)\s*=>\s*context\.get\('frameRuntime'\)/);
});

test('the bundled plugin root and configured plugin sites are additive', () => {
  assert.match(createServer, /mergePluginPaths\(DEFAULT_BUNDLED_PLUGIN_ROOT, configuredPluginPaths\)/);
  assert.match(createServer, /DEFAULT_BUNDLED_PLUGIN_ROOT = fileURLToPath\(new URL\('\.\.\/\.\.\/plugins\/', import\.meta\.url\)\)/);
});
