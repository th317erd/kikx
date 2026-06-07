'use strict';

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildHealthURL,
  collectWatchFiles,
  fingerprintFiles,
  isHealthy,
  isWatchableFile,
  loadEnvFile,
  shouldIgnoreWatchPath,
} from '../../scripts/dev-watch.mjs';

test('dev-watch ignores generated/runtime directories and watches source-like files', () => {
  assert.equal(shouldIgnoreWatchPath('/tmp/kikx/node_modules/pkg/index.mjs'), true);
  assert.equal(shouldIgnoreWatchPath('/tmp/kikx/.git/index'), true);
  assert.equal(shouldIgnoreWatchPath('/tmp/kikx/.aeordb/kikx.aeordb'), true);
  assert.equal(shouldIgnoreWatchPath('/tmp/kikx/src/server/index.mjs'), false);

  assert.equal(isWatchableFile('/tmp/kikx/src/server/index.mjs'), true);
  assert.equal(isWatchableFile('/tmp/kikx/src/client/styles/app.css'), true);
  assert.equal(isWatchableFile('/tmp/kikx/package.json'), true);
  assert.equal(isWatchableFile('/tmp/kikx/.env.dev'), true);
  assert.equal(isWatchableFile('/tmp/kikx/tmp/output.log'), false);
});

test('dev-watch recursively collects watchable files in stable order', async () => {
  let root = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-dev-watch-'));
  try {
    await fs.mkdir(path.join(root, 'src', 'server'), { recursive: true });
    await fs.mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true });
    await fs.mkdir(path.join(root, '.aeordb'), { recursive: true });
    await fs.writeFile(path.join(root, 'package.json'), '{}\n');
    await fs.writeFile(path.join(root, '.env.dev'), 'KIKX_PORT=3001\n');
    await fs.writeFile(path.join(root, 'src', 'server', 'index.mjs'), 'export {};\n');
    await fs.writeFile(path.join(root, 'node_modules', 'pkg', 'index.mjs'), 'ignored\n');
    await fs.writeFile(path.join(root, '.aeordb', 'kikx.aeordb'), 'ignored\n');

    let files = await collectWatchFiles([
      'src',
      'package.json',
      '.env.dev',
      'missing',
    ], { cwd: root });

    assert.deepEqual(files.map((filePath) => path.relative(root, filePath)), [
      '.env.dev',
      'package.json',
      path.join('src', 'server', 'index.mjs'),
    ]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('dev-watch fingerprints file metadata and detects changes', async () => {
  let root = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-dev-watch-'));
  try {
    let filePath = path.join(root, 'index.mjs');
    await fs.writeFile(filePath, 'one\n');

    let first = await fingerprintFiles([ filePath ]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await fs.writeFile(filePath, 'two\nmore\n');
    let second = await fingerprintFiles([ filePath ]);

    assert.notEqual(first, second);
    assert.equal(await fingerprintFiles([ filePath ]), second);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('dev-watch builds the Kikx health URL from host and port', () => {
  assert.equal(buildHealthURL('127.0.0.1', 3001), 'http://127.0.0.1:3001/health');
  assert.equal(buildHealthURL('localhost', '3002'), 'http://localhost:3002/health');
});

test('dev-watch loads .env-style defaults without replacing existing environment', async () => {
  let root = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-dev-watch-env-'));
  let envPath = path.join(root, '.env.dev');
  let originalExisting = process.env.KIKX_DEV_WATCH_EXISTING;
  let originalLoaded = process.env.KIKX_DEV_WATCH_LOADED;
  try {
    process.env.KIKX_DEV_WATCH_EXISTING = 'already-set';
    delete process.env.KIKX_DEV_WATCH_LOADED;
    await fs.writeFile(envPath, [
      '# comment',
      'KIKX_DEV_WATCH_EXISTING=from-file',
      'KIKX_DEV_WATCH_LOADED=from-file',
      '',
    ].join('\n'));

    await loadEnvFile(envPath);

    assert.equal(process.env.KIKX_DEV_WATCH_EXISTING, 'already-set');
    assert.equal(process.env.KIKX_DEV_WATCH_LOADED, 'from-file');
  } finally {
    restoreEnv('KIKX_DEV_WATCH_EXISTING', originalExisting);
    restoreEnv('KIKX_DEV_WATCH_LOADED', originalLoaded);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('dev-watch treats failed health probes as unhealthy', async () => {
  assert.equal(await isHealthy('http://127.0.0.1:1/health', {
    async fetchImpl() {
      throw new Error('connect ECONNREFUSED');
    },
  }), false);

  assert.equal(await isHealthy('http://127.0.0.1:3001/health', {
    async fetchImpl() {
      return { ok: true };
    },
  }), true);
});

function restoreEnv(name, value) {
  if (value == null) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}
