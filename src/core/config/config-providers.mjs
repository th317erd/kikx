'use strict';

import * as nodeFsPromises from 'node:fs/promises';

import { ConfigError } from './config-error.mjs';
import { envKeyFor, joinPropertyPath, normalizePropertyPath } from './property-path.mjs';

// A configuration provider exposes `async get(propertyPath)` and an optional
// async generator `entries(prefix)`. Providers are ordered by precedence when
// handed to `ConfigStore`: earlier sources win. `entries` is optional: a source
// without it contributes nothing to `list()`. Provider values are
// shallow-copied from the source document, so nested value references are
// shared with the caller rather than deep-cloned.

// The process environment is the highest-precedence source. Env key names are
// derived from property paths via `envKeyFor`, so `get` is a synchronous lookup
// wrapped in a Promise. `entries()` yields nothing: an env key name cannot be
// reversed back to a property path reliably (the sanitizing is lossy).
export function createProcessEnvProvider(env = process.env) {
  return {
    name: 'process-env',
    async get(propertyPath) {
      let key = envKeyFor(propertyPath);
      if (Object.hasOwn(env, key))
        return env[key];

      return undefined;
    },
    async *entries() {
      // Env key names cannot be reversed to property paths reliably.
    },
  };
}

// A provider over a plain object whose keys are already property paths. The
// document is copied and normalized, so later mutation of the caller's object
// cannot change provider output. `entries(prefix)` matches by path segment.
export function createObjectProvider(document, options = {}) {
  if (!isPlainObject(document))
    throw new TypeError('createObjectProvider expects a plain object document');

  let name = options.name || 'object';
  let entries = [];

  for (const [key, value] of Object.entries(document))
    entries.push({ path: normalizePropertyPath(key), value });

  entries.sort(compareByPath);
  let byPath = new Map(entries.map((entry) => [entry.path, entry.value]));

  return {
    name,
    async get(propertyPath) {
      let path = normalizePropertyPath(propertyPath);
      return byPath.get(path);
    },
    async *entries(prefix = '/') {
      let normalizedPrefix = normalizePropertyPath(prefix);
      for (const entry of entries) {
        if (isUnderPrefix(entry.path, normalizedPrefix))
          yield entry;
      }
    },
  };
}

export function createDefaultsProvider(values) {
  return createObjectProvider(values, { name: 'defaults' });
}

// Recursively flatten a nested env document into absolute property-path keys.
// A key already starting with `/` is absolute; otherwise it is appended to the
// parent path. Values that are not plain objects are leaves, including arrays
// and other non-plain objects. Flattening shallow-copies leaves: nested value
// references are shared with the source, not deep-cloned.
//
//   { org: { aeor: { kikx: { host: 'x' } } } } -> { '/org/aeor/kikx/host': 'x' }
export function flattenJsonEnv(document) {
  if (!isPlainObject(document))
    throw new TypeError('flattenJsonEnv expects a plain object');

  let flattened = {};
  flattenInto(flattened, '/', document);
  return flattened;
}

// Read, parse and flatten a JSON env document. A missing file is not an error
// (returns an empty document); malformed JSON is a clear, path-naming error.
export async function loadJsonEnvFile(envPath, options = {}) {
  let fsImpl = options.fsImpl || nodeFsPromises;
  let text;

  try {
    text = await fsImpl.readFile(envPath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT')
      return {};

    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`Malformed JSON env file at ${envPath}: ${error.message}`, {
      code: 'config_malformed_json',
    });
  }

  if (!isPlainObject(parsed)) {
    throw new ConfigError(
      `Invalid JSON env document at ${envPath}: expected a JSON object, received ${describeValue(parsed)}`,
      { code: 'config_invalid_document' },
    );
  }

  return flattenJsonEnv(parsed);
}

function flattenInto(target, basePath, node) {
  for (const [key, value] of Object.entries(node)) {
    let path = pathForKey(basePath, key);

    if (isPlainObject(value))
      flattenInto(target, path, value);
    else
      target[path] = value;
  }
}

function pathForKey(basePath, key) {
  if (key.startsWith('/'))
    return normalizePropertyPath(key);

  return joinPropertyPath(basePath, key);
}

function isUnderPrefix(path, prefix) {
  if (prefix === '/')
    return true;

  return path === prefix || path.startsWith(`${prefix}/`);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object')
    return false;

  let prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function describeValue(value) {
  if (value === null)
    return 'null';

  if (Array.isArray(value))
    return 'array';

  return typeof value;
}

function compareByPath(a, b) {
  if (a.path < b.path)
    return -1;

  if (a.path > b.path)
    return 1;

  return 0;
}
