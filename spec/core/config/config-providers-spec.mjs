'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDefaultsProvider,
  createObjectProvider,
  createProcessEnvProvider,
  flattenJsonEnv,
  loadJsonEnvFile,
} from '../../../src/core/config/config-providers.mjs';
import { ConfigError } from '../../../src/core/config/config-error.mjs';

async function collect(iterable) {
  let items = [];
  for await (const item of iterable)
    items.push(item);

  return items;
}

test('processEnv provider reads a set key and returns undefined for absent keys', async () => {
  let provider = createProcessEnvProvider({ ORG_AEOR_KIKX_HOST: 'db.internal' });

  assert.equal(provider.name, 'process-env');
  assert.equal(await provider.get('/org/aeor/kikx/host'), 'db.internal');
  assert.equal(await provider.get('org/aeor/kikx/host'), 'db.internal');
  assert.equal(await provider.get('/org/aeor/kikx/missing'), undefined);
});

test('processEnv get is async and returns a Promise', () => {
  let provider = createProcessEnvProvider({ A: '1' });
  let result = provider.get('/a');

  assert.ok(result instanceof Promise);
  return result;
});

test('processEnv entries yields nothing because env keys cannot be reversed', async () => {
  let provider = createProcessEnvProvider({ ORG_AEOR_KIKX_HOST: 'x' });

  assert.deepEqual(await collect(provider.entries('/')), []);
});

test('object provider gets normalized property paths', async () => {
  let provider = createObjectProvider({ '/a/b': 1, 'c/d': 2 });

  assert.equal(provider.name, 'object');
  assert.equal(await provider.get('/a/b'), 1);
  assert.equal(await provider.get('a/b'), 1);
  assert.equal(await provider.get('/c/d'), 2);
  assert.equal(await provider.get('/nope'), undefined);
});

test('object provider snaps a normalized copy at construction time', async () => {
  let document = { '/a/b': 1 };
  let provider = createObjectProvider(document);
  document['/a/b'] = 999;
  document['/a/c'] = 7;

  assert.equal(await provider.get('/a/b'), 1);
  assert.equal(await provider.get('/a/c'), undefined);
});

test('object provider entries filter by path segment and sort by path', async () => {
  let provider = createObjectProvider({
    '/a/two': 2,
    '/a/one': 1,
    '/b/three': 3,
    '/ab/x': 9,
  });

  assert.deepEqual(await collect(provider.entries('/a')), [
    { path: '/a/one', value: 1 },
    { path: '/a/two', value: 2 },
  ]);
  assert.deepEqual(await collect(provider.entries('/b')), [
    { path: '/b/three', value: 3 },
  ]);
  assert.deepEqual(await collect(provider.entries('/')), [
    { path: '/a/one', value: 1 },
    { path: '/a/two', value: 2 },
    { path: '/ab/x', value: 9 },
    { path: '/b/three', value: 3 },
  ]);
});

test('object provider accepts an explicit name', () => {
  let provider = createObjectProvider({}, { name: 'json-env' });

  assert.equal(provider.name, 'json-env');
});

test('object provider rejects non-plain-object documents', () => {
  assert.throws(() => createObjectProvider(null), TypeError);
  assert.throws(() => createObjectProvider(undefined), TypeError);
  assert.throws(() => createObjectProvider([]), TypeError);
  assert.throws(() => createObjectProvider('nope'), TypeError);
  assert.throws(() => createObjectProvider(42), TypeError);
});

test('defaults provider is an object provider named defaults', async () => {
  let provider = createDefaultsProvider({ '/a/b': 'fallback' });

  assert.equal(provider.name, 'defaults');
  assert.equal(await provider.get('/a/b'), 'fallback');
  assert.deepEqual(await collect(provider.entries('/')), [
    { path: '/a/b', value: 'fallback' },
  ]);
});

test('flattenJsonEnv preserves absolute keys', () => {
  let flattened = flattenJsonEnv({ '/org/aeor/kikx/host': 'x' });

  assert.deepEqual(flattened, { '/org/aeor/kikx/host': 'x' });
});

test('flattenJsonEnv recursively flattens nested objects', () => {
  let flattened = flattenJsonEnv({ org: { aeor: { kikx: { host: 'x' } } } });

  assert.deepEqual(flattened, { '/org/aeor/kikx/host': 'x' });
});

test('flattenJsonEnv handles mixed absolute, nested and leaf values', () => {
  let flattened = flattenJsonEnv({
    '/abs/key': 1,
    org: { aeor: { host: 'x', port: 5432 } },
    plain: 'y',
    list: [1, 2],
  });

  assert.deepEqual(flattened, {
    '/abs/key': 1,
    '/org/aeor/host': 'x',
    '/org/aeor/port': 5432,
    '/plain': 'y',
    '/list': [1, 2],
  });
});

test('flattenJsonEnv nests under an absolute key', () => {
  let flattened = flattenJsonEnv({ '/abs': { child: 'v' } });

  assert.deepEqual(flattened, { '/abs/child': 'v' });
});

test('flattenJsonEnv treats an absolute key nested inside a nested object as absolute', () => {
  let flattened = flattenJsonEnv({ org: { '/abs/key': 1 } });

  assert.deepEqual(flattened, { '/abs/key': 1 });
});

test('flattenJsonEnv never pollutes Object.prototype for __proto__ keys', () => {
  let nested = flattenJsonEnv(JSON.parse('{"__proto__":{"polluted":1}}'));

  assert.deepEqual(nested, { '/__proto__/polluted': 1 });
  assert.equal(Object.prototype.polluted, undefined);

  let scalar = flattenJsonEnv(JSON.parse('{"__proto__":1}'));

  assert.deepEqual(scalar, { '/__proto__': 1 });
  assert.equal(Object.prototype.polluted, undefined);
});

test('flattenJsonEnv rejects non-plain-object documents', () => {
  assert.throws(() => flattenJsonEnv(null), TypeError);
  assert.throws(() => flattenJsonEnv([]), TypeError);
  assert.throws(() => flattenJsonEnv('nope'), TypeError);
  assert.throws(() => flattenJsonEnv(42), TypeError);
  assert.throws(() => flattenJsonEnv(undefined), TypeError);
});

test('loadJsonEnvFile parses and flattens valid JSON', async () => {
  let calls = [];
  let fsImpl = {
    async readFile(filePath, encoding) {
      calls.push([filePath, encoding]);
      return JSON.stringify({ org: { aeor: { kikx: { host: 'x' } } } });
    },
  };

  let flattened = await loadJsonEnvFile('/tmp/env.json', { fsImpl });

  assert.deepEqual(flattened, { '/org/aeor/kikx/host': 'x' });
  assert.deepEqual(calls, [['/tmp/env.json', 'utf8']]);
});

test('loadJsonEnvFile returns an empty document for a missing file', async () => {
  let fsImpl = {
    async readFile() {
      let error = new Error('no such file');
      error.code = 'ENOENT';
      throw error;
    },
  };

  assert.deepEqual(await loadJsonEnvFile('/tmp/missing.json', { fsImpl }), {});
});

test('loadJsonEnvFile surfaces non-ENOENT read errors', async () => {
  let fsImpl = {
    async readFile() {
      let error = new Error('permission denied');
      error.code = 'EACCES';
      throw error;
    },
  };

  await assert.rejects(
    () => loadJsonEnvFile('/tmp/denied.json', { fsImpl }),
    (error) => error.code === 'EACCES',
  );
});

test('loadJsonEnvFile throws a typed path-naming error for malformed JSON', async () => {
  let fsImpl = {
    async readFile() {
      return '{ not valid json';
    },
  };

  await assert.rejects(
    () => loadJsonEnvFile('/tmp/broken.json', { fsImpl }),
    (error) => {
      assert.ok(error instanceof ConfigError);
      assert.ok(error instanceof Error);
      assert.equal(error.code, 'config_malformed_json');
      assert.match(error.message, /\/tmp\/broken\.json/);
      return true;
    },
  );
});

test('loadJsonEnvFile rejects a parsed document that is not a plain object', async () => {
  const cases = [
    ['null document', 'null'],
    ['array document', '[]'],
    ['string document', '"x"'],
    ['number document', '42'],
  ];

  for (const [label, text] of cases) {
    let fsImpl = {
      async readFile() {
        return text;
      },
    };

    await assert.rejects(
      () => loadJsonEnvFile('/tmp/bad-doc.json', { fsImpl }),
      (error) => {
        assert.ok(error instanceof ConfigError, label);
        assert.equal(error.code, 'config_invalid_document', label);
        assert.match(error.message, /\/tmp\/bad-doc\.json/, label);
        return true;
      },
    );
  }
});
