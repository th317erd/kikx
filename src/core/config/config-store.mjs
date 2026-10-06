'use strict';

import { ConfigError } from './config-error.mjs';
import {
  createDefaultsProvider,
  createObjectProvider,
  createProcessEnvProvider,
  loadJsonEnvFile,
} from './config-providers.mjs';
import { envKeyFor, normalizePropertyPath } from './property-path.mjs';

// Async property accessor. Reads are always awaited so call sites never assume
// a synchronous source, even when the current provider is in-process.
export class ConfigStore {
  static envKeyFor = envKeyFor;

  constructor({ sources = [] } = {}) {
    if (!Array.isArray(sources))
      throw new TypeError('ConfigStore sources must be an array');

    for (const source of sources) {
      if (!source || typeof source.get !== 'function')
        throw new TypeError('ConfigStore sources must expose an async get(propertyPath) function');
    }

    this.sources = [...sources];
  }

  async get(propertyPath) {
    let path = normalizePropertyPath(propertyPath);

    for (const source of this.sources) {
      let value = await source.get(path);
      if (value !== undefined)
        return value;
    }

    return undefined;
  }

  async getWithDefault(propertyPath, defaultValue) {
    let value = await this.get(propertyPath);
    if (value === undefined)
      return defaultValue;

    return value;
  }

  async require(propertyPath) {
    let path = normalizePropertyPath(propertyPath);
    let value = await this.get(path);
    if (value === undefined)
      throw ConfigError.missing(path);

    return value;
  }

  // Resolve an explicit list of property paths through the normal precedence
  // chain, so process-env values are honoured, returning `{ path, value }` in
  // input order. Unlike `list()`, which can only enumerate keys exposed by
  // providers that implement `entries()`, `resolveAll()` can surface
  // process-env-set keys: the process-env provider cannot reverse-map env names
  // back to property paths reliably. Use `resolveAll()`/`get()` for descriptor
  // `configKeys`.
  async resolveAll(propertyPaths = []) {
    if (!Array.isArray(propertyPaths))
      throw new TypeError('ConfigStore.resolveAll expects an array of property paths');

    let results = [];
    for (const propertyPath of propertyPaths) {
      let path = normalizePropertyPath(propertyPath);
      results.push({ path, value: await this.get(path) });
    }

    return results;
  }

  // Merge entries from every source over `prefix`. Sources are visited in
  // precedence order, so the first source to define a path wins. The result is
  // sorted by path. A source without `entries()` is skipped; in particular
  // process-env-set keys never appear here, so use `resolveAll()`/`get()` for
  // known keys.
  async list(prefix = '/') {
    let path = normalizePropertyPath(prefix);
    let merged = new Map();

    for (const source of this.sources) {
      if (typeof source.entries !== 'function')
        continue;

      for await (const entry of source.entries(path)) {
        if (!merged.has(entry.path))
          merged.set(entry.path, entry.value);
      }
    }

    return [...merged.entries()]
      .map(([entryPath, value]) => ({ path: entryPath, value }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }
}

// Wire the standard precedence chain (highest first):
// process.env > json env file > additionalSources > defaults. Defaults are
// genuinely lowest so callers can layer runtime sources above them; explicit
// additional sources therefore override defaults. An explicit `env: null`
// disables the process-env source entirely. The JSON provider is only added
// when a path is supplied.
export async function createConfigStore(options = {}) {
  let sources = [];

  if (options.env !== null)
    sources.push(createProcessEnvProvider(options.env ?? process.env));

  if (options.jsonEnvPath) {
    let document = await loadJsonEnvFile(options.jsonEnvPath);
    sources.push(createObjectProvider(document, { name: 'json-env' }));
  }

  for (const source of options.additionalSources || [])
    sources.push(source);

  sources.push(createDefaultsProvider(options.defaults || {}));

  return new ConfigStore({ sources });
}
