'use strict';

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ENV_FILE_OWNED_KEYS_ENV_KEY,
  ENV_FILE_PATH_ENV_KEY,
  loadEnvFileWithProvenance,
  parseEnvFileText,
  readOwnedKeys,
} from '../../../src/core/config/env-loader.mjs';
import {
  refreshEnvFromFile,
  resolveEnvFileForRefresh,
} from '../../../src/core/config/env-refresh.mjs';

// These tests cover the defect the plugin lifecycle depends on: the launchers
// load `.env.dev` once, before spawning the server, so a key written to that
// file afterwards was invisible to the running process forever. A plugin reload
// could not see a newly added bot token, which made "reload" insufficient and
// left a restart as the only cure - exactly the regression that must not exist.
//
// Every test drives a real temp file through the real loaders. Nothing is
// mocked except the filesystem read failure, which cannot be provoked portably.

async function makeTempDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-env-refresh-'));
}

test('parseEnvFileText applies the documented line rules', () => {
  let entries = parseEnvFileText([
    '# comment',
    '',
    'PLAIN=value',
    'SPACED =  padded  ',
    'MALFORMED',
    '=no-key',
    'CRLF=carried',
  ].join('\r\n'));

  assert.deepEqual(entries, [
    [ 'PLAIN', 'value' ],
    [ 'SPACED', 'padded' ],
    [ 'CRLF', 'carried' ],
  ]);
});

test('loadEnvFileWithProvenance records the file path and the keys it set', async (t) => {
  let directory = await makeTempDir();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let envPath = path.join(directory, '.env.dev');
  await fs.writeFile(envPath, 'KIKX_DISCORD_BOT_TOKEN=abc\nKIKX_PORT=3003\n', 'utf8');

  // KIKX_PORT is already set, so the file must not own it.
  let env = { KIKX_PORT: '3025' };
  let result = await loadEnvFileWithProvenance(envPath, { env });

  assert.equal(env.KIKX_DISCORD_BOT_TOKEN, 'abc');
  assert.equal(env.KIKX_PORT, '3025', 'a pre-existing key must not be overridden');
  assert.deepEqual(result.owned, [ 'KIKX_DISCORD_BOT_TOKEN' ]);
  assert.equal(env[ENV_FILE_PATH_ENV_KEY], envPath);
  assert.deepEqual(readOwnedKeys(env), [ 'KIKX_DISCORD_BOT_TOKEN' ]);
});

test('provenance accumulates across repeated loads so the outer launcher is not erased', async (t) => {
  let directory = await makeTempDir();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let envPath = path.join(directory, '.env.dev');
  await fs.writeFile(envPath, 'A=1\nB=2\n', 'utf8');

  let env = { A: 'from-shell' };
  await loadEnvFileWithProvenance(envPath, { env });
  // Second load happens in the spawned process, where every file key is already
  // present; it must not wipe the provenance the first load recorded.
  await loadEnvFileWithProvenance(envPath, { env });

  assert.deepEqual(readOwnedKeys(env), [ 'B' ]);
});

test('readOwnedKeys treats corrupt provenance as "nothing is owned"', () => {
  assert.deepEqual(readOwnedKeys({}), []);
  assert.deepEqual(readOwnedKeys({ [ENV_FILE_OWNED_KEYS_ENV_KEY]: 'not json' }), []);
  assert.deepEqual(readOwnedKeys({ [ENV_FILE_OWNED_KEYS_ENV_KEY]: '{"a":1}' }), []);
  assert.deepEqual(
    readOwnedKeys({ [ENV_FILE_OWNED_KEYS_ENV_KEY]: '["A",7,null,"B"]' }),
    [ 'A', 'B' ],
  );
});

test('resolveEnvFileForRefresh prefers an explicit path, then provenance, then .env.dev', () => {
  assert.equal(
    resolveEnvFileForRefresh({ env: { [ENV_FILE_PATH_ENV_KEY]: '/tmp/from-provenance.env' } }),
    '/tmp/from-provenance.env',
  );
  assert.equal(
    resolveEnvFileForRefresh({
      env: { [ENV_FILE_PATH_ENV_KEY]: '/tmp/from-provenance.env' },
      envFile: '/tmp/explicit.env',
    }),
    '/tmp/explicit.env',
  );
  // No cwd option: the relative default is returned as-is, so `readFile` resolves
  // it against the process working directory at read time - the same directory the
  // boot load used - without this module calling `process.cwd()`.
  assert.equal(resolveEnvFileForRefresh({ env: {} }), '.env.dev');
  assert.equal(
    resolveEnvFileForRefresh({ env: {}, cwd: '/tmp' }),
    path.join('/tmp', '.env.dev'),
  );
});

test('refreshEnvFromFile adds keys written after boot - the plugin-reload defect', async (t) => {
  let directory = await makeTempDir();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let envPath = path.join(directory, '.env.dev');

  // Boot: file has a public key only.
  await fs.writeFile(envPath, 'KIKX_DISCORD_PUBLIC_KEY=pub\n', 'utf8');
  let env = {};
  await loadEnvFileWithProvenance(envPath, { env });

  // Seventeen hours later an operator appends the bot token. Before this fix the
  // running process could never see it, and a plugin reload came up tokenless.
  await fs.appendFile(envPath, 'KIKX_DISCORD_BOT_TOKEN=tok\n', 'utf8');

  let report = await refreshEnvFromFile({ env });

  assert.equal(report.skipped, null);
  assert.deepEqual(report.added, [ 'KIKX_DISCORD_BOT_TOKEN' ]);
  assert.equal(env.KIKX_DISCORD_BOT_TOKEN, 'tok');
  // The new key is promoted to file-owned so the next refresh may update it.
  assert.deepEqual(readOwnedKeys(env), [ 'KIKX_DISCORD_BOT_TOKEN', 'KIKX_DISCORD_PUBLIC_KEY' ]);
});

test('refreshEnvFromFile updates a file-owned key and pins a shell override', async (t) => {
  let directory = await makeTempDir();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let envPath = path.join(directory, '.env.dev');
  await fs.writeFile(envPath, 'KIKX_PORT=3003\nKIKX_AUTH_PUBLIC_URL=http://127.0.0.1:3001\n', 'utf8');

  // KIKX_PORT came from the shell (a probe on another port); the auth URL came
  // from the file. Same file, same reload, opposite outcomes - which is the whole
  // point of tracking provenance.
  let env = { KIKX_PORT: '3025' };
  await loadEnvFileWithProvenance(envPath, { env });

  await fs.writeFile(
    envPath,
    'KIKX_PORT=3003\nKIKX_AUTH_PUBLIC_URL=https://kikx2.taraani.org\n',
    'utf8',
  );

  let report = await refreshEnvFromFile({ env });

  assert.deepEqual(report.added, []);
  assert.deepEqual(report.updated, [ 'KIKX_AUTH_PUBLIC_URL' ]);
  assert.deepEqual(report.pinned, [ 'KIKX_PORT' ]);
  assert.equal(env.KIKX_AUTH_PUBLIC_URL, 'https://kikx2.taraani.org');
  assert.equal(env.KIKX_PORT, '3025', 'the shell override must survive a reload');
});

test('refreshEnvFromFile reports a missing or empty file instead of throwing', async (t) => {
  let directory = await makeTempDir();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  let missing = await refreshEnvFromFile({ env: {}, envFile: path.join(directory, 'absent.env') });
  assert.equal(missing.skipped, 'empty');
  assert.deepEqual(missing.added, []);

  let emptyPath = path.join(directory, 'blank.env');
  await fs.writeFile(emptyPath, '# nothing here\n', 'utf8');
  let empty = await refreshEnvFromFile({ env: {}, envFile: emptyPath });
  assert.equal(empty.skipped, 'empty');
});

test('refreshEnvFromFile reports an unreadable file instead of throwing', async () => {
  let fsImpl = {
    async readFile() {
      let error = new Error('permission denied');
      error.code = 'EACCES';
      throw error;
    },
  };

  let report = await refreshEnvFromFile({ env: {}, envFile: '/tmp/denied.env', fsImpl });

  assert.equal(report.skipped, 'unreadable');
  assert.match(report.error, /permission denied/);
});

test('refreshEnvFromFile is a no-op when disabled', async () => {
  let report = await refreshEnvFromFile({ env: { A: '1' }, enabled: false });
  assert.equal(report.skipped, 'disabled');
  assert.deepEqual(report.added, []);
});

// The invariant the owner actually asked for: configuration changes take effect
// on reload. This asserts the store sees a post-boot key without any process
// restart, using the real ConfigStore over the real process-env provider.
test('a ConfigStore sees a key written after boot, after a refresh and no restart', async (t) => {
  let { createConfigStore } = await import('../../../src/core/config/config-store.mjs');
  let key = 'KIKX_REFRESH_VISIBILITY_PROBE';
  let previous = process.env[key];
  t.after(() => {
    if (previous === undefined)
      delete process.env[key];
    else
      process.env[key] = previous;
  });

  delete process.env[key];

  // A store built before the key exists, exactly like the boot-time one.
  let config = await createConfigStore({ env: process.env });
  assert.equal(await config.get('/kikx/refresh/visibility/probe'), undefined);

  let directory = await makeTempDir();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let envPath = path.join(directory, '.env.dev');
  await fs.writeFile(envPath, `${key}=visible-after-reload\n`, 'utf8');

  let report = await refreshEnvFromFile({ env: process.env, envFile: envPath });
  assert.deepEqual(report.added, [ key ]);

  // Same store instance, no restart: the live lookup must now resolve.
  assert.equal(await config.get('/kikx/refresh/visibility/probe'), 'visible-after-reload');
});
