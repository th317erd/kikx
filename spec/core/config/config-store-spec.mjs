'use strict';

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createDefaultsProvider,
  createObjectProvider,
  createProcessEnvProvider,
} from '../../../src/core/config/config-providers.mjs';
import { ConfigError } from '../../../src/core/config/config-error.mjs';
import { ConfigStore, createConfigStore } from '../../../src/core/config/config-store.mjs';

async function writeTempJson(document) {
  let directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-config-'));
  let filePath = path.join(directory, 'env.json');
  await fs.writeFile(filePath, JSON.stringify(document), 'utf8');
  return { directory, filePath };
}

test('constructor validates that sources is an array of get-providers', () => {
  assert.throws(() => new ConfigStore({ sources: 'nope' }), TypeError);
  assert.throws(() => new ConfigStore({ sources: [{}] }), TypeError);
  assert.throws(() => new ConfigStore({ sources: [null] }), TypeError);
  assert.doesNotThrow(() => new ConfigStore());
  assert.doesNotThrow(() => new ConfigStore({ sources: [createDefaultsProvider({})] }));
});

test('ConfigStore.envKeyFor exposes the pure property-path helper', () => {
  assert.equal(ConfigStore.envKeyFor('/org/aeor/kikx/database/driver'), 'ORG_AEOR_KIKX_DATABASE_DRIVER');
});

test('all ConfigStore reads return Promises, even for the process-env source', async () => {
  let store = new ConfigStore({ sources: [createProcessEnvProvider({ ORG_AEOR_KIKX_HOST: 'x' })] });

  let get = store.get('/org/aeor/kikx/host');
  let getWithDefault = store.getWithDefault('/org/aeor/kikx/host', 'd');
  let require = store.require('/org/aeor/kikx/host');
  let list = store.list('/');

  assert.ok(get instanceof Promise);
  assert.ok(getWithDefault instanceof Promise);
  assert.ok(require instanceof Promise);
  assert.ok(list instanceof Promise);

  assert.equal(await get, 'x');
  assert.equal(await getWithDefault, 'x');
  assert.equal(await require, 'x');
  assert.deepEqual(await list, []);
});

test('precedence: process env > json env file > defaults', async (t) => {
  let { directory, filePath } = await writeTempJson({ org: { aeor: { kikx: { host: 'from-json' } } } });
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  let defaults = { '/org/aeor/kikx/host': 'from-default' };

  let withEnv = await createConfigStore({
    env: { ORG_AEOR_KIKX_HOST: 'from-env' },
    jsonEnvPath: filePath,
    defaults,
  });
  assert.equal(await withEnv.get('/org/aeor/kikx/host'), 'from-env');

  let withJson = await createConfigStore({ env: {}, jsonEnvPath: filePath, defaults });
  assert.equal(await withJson.get('/org/aeor/kikx/host'), 'from-json');

  let withDefaults = await createConfigStore({ env: {}, defaults });
  assert.equal(await withDefaults.get('/org/aeor/kikx/host'), 'from-default');
});

test('createConfigStore with env: null ignores the real process.env', async (t) => {
  let key = 'ORG_AEOR_KIKX_HOST';
  let previous = process.env[key];
  process.env[key] = 'from-real-env';
  t.after(() => {
    if (previous === undefined)
      delete process.env[key];
    else
      process.env[key] = previous;
  });

  let store = await createConfigStore({
    env: null,
    defaults: { '/org/aeor/kikx/host': 'from-default' },
  });

  assert.equal(await store.get('/org/aeor/kikx/host'), 'from-default');
});

test('getWithDefault returns the default only when the path is unresolved', async () => {
  let store = new ConfigStore({ sources: [createDefaultsProvider({ '/a/b': 'resolved' })] });

  assert.equal(await store.getWithDefault('/a/b', 'fallback'), 'resolved');
  assert.equal(await store.getWithDefault('/a/missing', 'fallback'), 'fallback');
  assert.equal(await store.getWithDefault('/a/missing', undefined), undefined);
});

test('require returns the value when present and throws ConfigError.missing when absent', async () => {
  let store = new ConfigStore({ sources: [createDefaultsProvider({ '/a/b': 'value' })] });

  assert.equal(await store.require('/a/b'), 'value');

  await assert.rejects(
    () => store.require('/a/missing'),
    (error) => {
      assert.ok(error instanceof ConfigError);
      assert.ok(error instanceof Error);
      assert.equal(error.name, 'ConfigError');
      assert.equal(error.code, 'config_missing');
      assert.equal(error.propertyPath, '/a/missing');
      return true;
    },
  );
});

test('list merges sources, first source wins duplicates, and sorts by path', async () => {
  let store = new ConfigStore({
    sources: [
      createObjectProvider(
        { '/a/one': 'A1', '/a/two': 'A2', '/b/one': 'B1' },
        { name: 'first' },
      ),
      createDefaultsProvider({ '/a/one': 'D1', '/a/three': 'D3', '/b/two': 'D2' }),
    ],
  });

  assert.deepEqual(await store.list('/a'), [
    { path: '/a/one', value: 'A1' },
    { path: '/a/three', value: 'D3' },
    { path: '/a/two', value: 'A2' },
  ]);

  assert.deepEqual(await store.list('/'), [
    { path: '/a/one', value: 'A1' },
    { path: '/a/three', value: 'D3' },
    { path: '/a/two', value: 'A2' },
    { path: '/b/one', value: 'B1' },
    { path: '/b/two', value: 'D2' },
  ]);
});

test('resolveAll resolves process-env-set values while list cannot enumerate them', async () => {
  let store = await createConfigStore({ env: { ORG_AEOR_KIKX_HOST: 'from-env' } });

  assert.deepEqual(await store.resolveAll(['/org/aeor/kikx/host']), [
    { path: '/org/aeor/kikx/host', value: 'from-env' },
  ]);
  assert.deepEqual(await store.list('/'), []);
});

test('resolveAll normalizes paths, preserves input order and reports undefined for missing', async () => {
  let store = new ConfigStore({ sources: [createDefaultsProvider({ '/a/one': 1, '/a/two': 2 })] });

  assert.deepEqual(await store.resolveAll(['a/two', '/a/one', '/missing']), [
    { path: '/a/two', value: 2 },
    { path: '/a/one', value: 1 },
    { path: '/missing', value: undefined },
  ]);
  assert.deepEqual(await store.resolveAll(), []);
  await assert.rejects(() => store.resolveAll('not-an-array'), TypeError);
});

test('createConfigStore layers additionalSources above defaults but below env and json', async (t) => {
  let { directory, filePath } = await writeTempJson({ org: { aeor: { kikx: { host: 'from-json' } } } });
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  let defaults = { '/org/aeor/kikx/host': 'default' };
  let additionalSources = [
    createObjectProvider(
      { '/org/aeor/kikx/host': 'additional', '/org/aeor/kikx/extra': 'extra' },
      { name: 'extra' },
    ),
  ];

  let withAdditional = await createConfigStore({ env: {}, defaults, additionalSources });
  assert.equal(await withAdditional.get('/org/aeor/kikx/host'), 'additional');
  assert.equal(await withAdditional.get('/org/aeor/kikx/extra'), 'extra');

  let withEnv = await createConfigStore({
    env: { ORG_AEOR_KIKX_HOST: 'from-env' },
    defaults,
    additionalSources,
  });
  assert.equal(await withEnv.get('/org/aeor/kikx/host'), 'from-env');

  let withJson = await createConfigStore({ env: {}, jsonEnvPath: filePath, defaults, additionalSources });
  assert.equal(await withJson.get('/org/aeor/kikx/host'), 'from-json');
});

test('index re-exports the public config surface', async () => {
  let module = await import('../../../src/core/config/index.mjs');
  let expected = [
    'normalizePropertyPath',
    'envKeyFor',
    'joinPropertyPath',
    'ConfigError',
    'createProcessEnvProvider',
    'createObjectProvider',
    'createDefaultsProvider',
    'flattenJsonEnv',
    'loadJsonEnvFile',
    'ConfigStore',
    'createConfigStore',
    'loadEnvFile',
    'loadJsonEnv',
    'loadEnvSources',
    'snapshotEnvironment',
  ];

  for (const name of expected)
    assert.equal(typeof module[name], 'function', `missing export: ${name}`);
});
