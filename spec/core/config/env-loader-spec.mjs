'use strict';

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  loadEnvFile,
  loadEnvSources,
  loadJsonEnv,
} from '../../../src/core/config/env-loader.mjs';

async function makeTempDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-env-loader-'));
}

function restoreEnv(name, value) {
  if (value === undefined)
    delete process.env[name];
  else
    process.env[name] = value;
}

test('loadEnvFile loads new keys, skips comments/blank/malformed lines and handles CRLF', async (t) => {
  let directory = await makeTempDir();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let envPath = path.join(directory, '.env');
  await fs.writeFile(envPath, [
    '# comment',
    '',
    'EXISTING=from-file',
    'NEW=from-file',
    'WITH_SPACES =  spaced value  ',
    'MALFORMED',
    '=no-key',
    'CRLF=carried',
    '',
  ].join('\r\n'));

  let env = { EXISTING: 'already-set' };
  await loadEnvFile(envPath, { env });

  assert.equal(env.EXISTING, 'already-set');
  assert.equal(env.NEW, 'from-file');
  assert.equal(env.WITH_SPACES, 'spaced value');
  assert.equal(env.CRLF, 'carried');
  assert.equal(Object.hasOwn(env, 'MALFORMED'), false);
  assert.equal(Object.hasOwn(env, ''), false);
});

test('loadEnvFile is a no-op for a missing file', async () => {
  let env = {};
  await loadEnvFile('/tmp/definitely-missing-kikx-env-loader', { env });
  assert.deepEqual(env, {});
});

test('loadEnvFile propagates a non-ENOENT read error', async () => {
  let fsImpl = {
    async readFile() {
      let error = new Error('permission denied');
      error.code = 'EACCES';
      throw error;
    },
  };

  await assert.rejects(
    () => loadEnvFile('/tmp/denied-kikx.env', { env: {}, fsImpl }),
    (error) => error.code === 'EACCES',
  );
});

test('loadEnvFile defaults to process.env and never overrides real environment values', async (t) => {
  let existingKey = 'KIKX_ENV_LOADER_EXISTING';
  let loadedKey = 'KIKX_ENV_LOADER_LOADED';
  let previousExisting = process.env[existingKey];
  let previousLoaded = process.env[loadedKey];

  let directory = await makeTempDir();
  t.after(async () => {
    restoreEnv(existingKey, previousExisting);
    restoreEnv(loadedKey, previousLoaded);
    await fs.rm(directory, { recursive: true, force: true });
  });

  process.env[existingKey] = 'from-process';
  delete process.env[loadedKey];

  let envPath = path.join(directory, '.env');
  await fs.writeFile(envPath, `${existingKey}=from-file\n${loadedKey}=from-file\n`, 'utf8');
  await loadEnvFile(envPath);

  assert.equal(process.env[existingKey], 'from-process');
  assert.equal(process.env[loadedKey], 'from-file');
});

test('loadJsonEnv maps property paths to env keys and keeps existing keys', async (t) => {
  let directory = await makeTempDir();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let envPath = path.join(directory, 'env.json');
  await fs.writeFile(envPath, JSON.stringify({
    '/org/aeor/kikx/database/driver': 'absolute-driver',
    '/org/aeor/kikx/database/name': 'absolute-name',
    org: { aeor: { kikx: { database: { pool: 'json-pool' } } } },
  }), 'utf8');

  let env = { ORG_AEOR_KIKX_DATABASE_DRIVER: 'from-real-env' };
  await loadJsonEnv(envPath, { env });

  assert.equal(env.ORG_AEOR_KIKX_DATABASE_DRIVER, 'from-real-env');
  assert.equal(env.ORG_AEOR_KIKX_DATABASE_NAME, 'absolute-name');
  assert.equal(env.ORG_AEOR_KIKX_DATABASE_POOL, 'json-pool');
});

test('loadJsonEnv is a no-op for a missing file', async () => {
  let env = {};
  await loadJsonEnv('/tmp/definitely-missing-kikx-env-loader.json', { env });
  assert.deepEqual(env, {});
});

test('loadEnvSources loads .env before the JSON document so .env wins a collision', async (t) => {
  let directory = await makeTempDir();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let envFile = path.join(directory, '.env');
  let jsonEnvFile = path.join(directory, 'env.json');
  await fs.writeFile(envFile, 'ORG_AEOR_KIKX_DATABASE_DRIVER=from-dotenv\n', 'utf8');
  await fs.writeFile(jsonEnvFile, JSON.stringify({
    org: { aeor: { kikx: { database: { driver: 'from-json', host: 'json-host' } } } },
  }), 'utf8');

  let env = {};
  let returned = await loadEnvSources({ env, envFile, jsonEnvFile });

  assert.equal(returned, env);
  assert.equal(env.ORG_AEOR_KIKX_DATABASE_DRIVER, 'from-dotenv');
  assert.equal(env.ORG_AEOR_KIKX_DATABASE_HOST, 'json-host');
});

test('loadEnvSources returns the target env untouched when no files are given', async () => {
  let env = { PRESET: 'kept' };
  assert.equal(await loadEnvSources({ env }), env);
  assert.deepEqual(env, { PRESET: 'kept' });
});
