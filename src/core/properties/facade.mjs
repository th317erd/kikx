'use strict';

// Properties-store P2 (plan §2-§3): THE FACADE IS THE ONLY WAY non-core
// callers reach the store. Relative keys resolve into the caller's own
// namespace (plugins: /plugins/<fqid>/…) with NO declaration — the dynamic-
// properties relaxation — and are forced into the caller's own scope, so a
// plugin can never name someone else's rows. Absolute keys run the gauntlet:
// core-owned sensitivity registry + grants (deny-wins, default-deny) +
// structured DENY LOGGING (owner: "we do want to log such things"). core is
// server code: ambient absolute access, no relative form. HTTP user
// identities never reach this layer — P3 keeps the scope rules at the
// transport.
//
// Methods are PLAIN (not async) on purpose: caller/key validation throws
// SYNCHRONOUSLY so sync call sites and specs observe a real throw, while
// store operations return their promises as usual.

import { normalizePropertyKey, normalizePropertyPrefix, isAbsolutePropertyKey } from './keys.mjs';
import { normalizeScope, PropertyStoreError } from './store.mjs';
import { normalizePluginID, GrantsRegistry } from './grants.mjs';
import { validateDeclaredValue } from './schemas.mjs';
import { CorePropertyRegistry } from './registry.mjs';

const GLOBAL_SCOPE = Object.freeze({ type: 'global', id: '' });

// CALCULATE step (owner Q1, inspired by AeorDB's "paths are calculated FOR
// the permission system first"): {current} is the ONE server-interpreted
// token — resolved from the authenticated identity (P3 routes pass it) — and
// it refuses wherever no identity exists (plugins always; core unless one is
// passed). A hostile identity is refused, never spliced. ({UUID} is NOT
// server-interpreted: the requester substitutes a real id before the request;
// grant PATTERNs may use {uuid} segments — grants.mjs.)
function resolveTokens(key, { caller, identity }) {
  if (!key.includes('{current}'))
    return key;
  if (!caller.isCore || typeof identity !== 'string' || identity === '')
    throw new PropertyStoreError('property_token_unresolved', caller.isCore
      ? '{current} needs an identity — pass one, or request a concrete key'
      : 'plugin callers have no user identity — {current} cannot resolve');
  let segment;
  try {
    segment = normalizePropertyKey(identity);
  } catch (error) {
    throw new PropertyStoreError('property_token_unresolved',
      `identity ${JSON.stringify(identity)} is not a usable path segment: ${error.message}`);
  }
  if (segment.includes('/'))
    throw new PropertyStoreError('property_token_unresolved',
      `identity ${JSON.stringify(identity)} is not a single path segment`);
  const resolved = normalizePropertyKey(key.split('{current}').join(segment));
  if (resolved.includes('{current}'))
    throw new PropertyStoreError('property_token_unresolved',
      'identity itself contained the token — refusing to recurse');
  return resolved;
}

function parseCaller(caller) {
  if (caller === 'core')
    return { token: 'core', isCore: true, pluginID: null };
  if (typeof caller === 'string' && caller.startsWith('plugin:')) {
    try {
      const id = normalizePluginID(caller.slice('plugin:'.length));
      return { token: `plugin:${id}`, isCore: false, pluginID: id };
    } catch (error) {
      throw new PropertyStoreError('property_caller_invalid',
        `bad plugin caller ${JSON.stringify(caller)}: ${error.message}`);
    }
  }
  throw new PropertyStoreError('property_caller_invalid',
    `unknown caller class ${JSON.stringify(caller)} — HTTP identities never reach the facade`);
}

export function createPropertiesFacade({ store, registry = null, grants = null, logger = console } = {}) {
  if (!store)
    throw new PropertyStoreError('property_facade_unavailable', 'a properties facade needs a store');
  const sensitivityRegistry = registry || new CorePropertyRegistry();
  const grantsRegistry = grants || new GrantsRegistry();

  function denyAndThrow(caller, action, key, reason) {
    // Structured, single-line, and it must NEVER throw into the request path
    // (a hostile logger downgrades a 403 into a 500).
    try {
      logger?.warn?.(`[properties-deny] caller=${caller} action=${action} key=${key} decision=deny reason=${reason}`);
    } catch {
      // deliberately swallowed
    }
    throw new PropertyStoreError('property_denied',
      `properties ${action} denied: ${caller} on ${key} (${reason})`);
  }

  // Returns the FINAL {key, scope} the store will see — tokens resolved,
  // then the form (relative/absolute) decided.
  function resolve(caller, action, scopeArg, keyRaw, options = {}) {
    const requested = normalizePropertyKey(keyRaw);
    const key = normalizePropertyKey(resolveTokens(requested, {
      caller,
      identity: options.identity,
    }));
    if (!isAbsolutePropertyKey(key)) {
      if (caller.isCore)
        throw new PropertyStoreError('property_caller_invalid',
          'core callers have no plugin namespace — use absolute keys');
      // Own namespace: forced FQID prefix AND forced scope. The caller's
      // scope argument is ignored — isolation, not preference. The FQID
      // already carries its leading slash, so '/plugins' + id is canonical
      // (store normalization would collapse a double slash anyway).
      return {
        key: `/plugins${caller.pluginID}/${key}`,
        scope: { type: 'plugin', id: caller.pluginID },
        declaredKey: key, // the RELATIVE name — schema lookup on writes
      };
    }
    if (caller.isCore)
      return { key, scope: normalizeScope(scopeArg || GLOBAL_SCOPE), declaredKey: null };

    // Absolute + plugin: core-owned sensitivity + grants.
    const level = sensitivityRegistry.lookup(key);
    const decision = grantsRegistry.evaluate(caller.token, action, key);
    if (!decision.allowed) {
      if (decision.reason === 'deny')
        denyAndThrow(caller.token, action, key, 'deny');
      const publicReadIsFree = decision.reason === 'no-grant' && action === 'read' && level === 'public';
      if (!publicReadIsFree)
        denyAndThrow(caller.token, action, key, decision.reason);
    }
    // v1 scope forcing (plan open-concern #1): plugin absolute access is
    // GLOBAL-scoped. Grants gate the key; account/session rows stay on the
    // core + HTTP-identity paths, so a granted plugin can never read another
    // user's rows by naming their scope.
    return { key, scope: GLOBAL_SCOPE, declaredKey: null };
  }

  // Plan §4: a DECLARED own key validates its value server-side on writes;
  // undeclared dynamic keys never hit this path (the relaxation).
  function assertSchemaAllows(caller, target, value) {
    if (caller.isCore || target.declaredKey === null)
      return;
    const schemas = typeof grantsRegistry.getSchemas === 'function'
      ? grantsRegistry.getSchemas(caller.pluginID)
      : null;
    const schema = schemas ? schemas[target.declaredKey] : null;
    if (schema)
      validateDeclaredValue(schema, value, target.declaredKey);
  }

  return {
    read(callerRaw, scope, key, options = {}) {
      const caller = parseCaller(callerRaw);
      const target = resolve(caller, 'read', scope, key, options);
      return store.get(target.scope, target.key);
    },

    write(callerRaw, scope, key, value, options = {}) {
      const caller = parseCaller(callerRaw);
      const target = resolve(caller, 'write', scope, key, options);
      assertSchemaAllows(caller, target, value);
      return store.put(target.scope, target.key, value, {
        ...options,
        updatedBy: options.updatedBy ?? caller.token, // audit seam (plan §10.7)
      });
    },

    remove(callerRaw, scope, key, options = {}) {
      const caller = parseCaller(callerRaw);
      const target = resolve(caller, 'write', scope, key, options); // deletion is a write-class action
      return store.delete(target.scope, target.key, {
        expectedVersion: options.expectedVersion ?? null,
        updatedBy: options.updatedBy ?? caller.token,
      });
    },

    list(callerRaw, scope, prefixRaw, options = {}) {
      const caller = parseCaller(callerRaw);
      const requestedPrefix = normalizePropertyPrefix(prefixRaw);
      const prefix = normalizePropertyPrefix(resolveTokens(requestedPrefix, {
        caller,
        identity: options.identity,
      }));
      if (!caller.isCore) {
        // Absolute listing would leak key names past per-key grants (v1):
        // plugins list their own namespace only; the attempt is denied AND logged.
        if (isAbsolutePropertyKey(prefix))
          denyAndThrow(caller.token, 'list', prefix, 'absolute-prefix');
        return store.list({ type: 'plugin', id: caller.pluginID },
          `/plugins${caller.pluginID}/${prefix}`);
      }
      if (prefix !== '' && !isAbsolutePropertyKey(prefix))
        throw new PropertyStoreError('property_caller_invalid', 'core list needs an absolute prefix');
      return store.list(normalizeScope(scope || GLOBAL_SCOPE), prefix);
    },
  };
}

// The setup-context binding: every method pre-bound to one plugin caller.
// Validation is CALL-time (never factory-time) so a booted plugin that simply
// never declared pluginID — or a direct loadPlugins harness with no facade —
// still LOADS; properties are just unusable, loudly per call.
export function pluginPropertiesAPI(facade, pluginID) {
  let caller = null;
  if (typeof pluginID === 'string' && pluginID !== '') {
    try {
      caller = `plugin:${normalizePluginID(pluginID)}`;
    } catch {
      caller = null;
    }
  }
  const guard = () => {
    if (!facade)
      throw new PropertyStoreError('property_facade_unavailable',
        'properties are unavailable in this context');
    if (!caller)
      throw new PropertyStoreError('property_plugin_id_invalid',
        'declare pluginID in manifest.json to use properties');
    return caller;
  };
  return {
    // Block bodies on purpose: `facade.read(guard(), …)` would dereference
    // `facade` (null in a direct-load harness) BEFORE guard() could refuse.
    read: (scope, key, options) => { const caller = guard(); return facade.read(caller, scope, key, options); },
    write: (scope, key, value, options) => { const caller = guard(); return facade.write(caller, scope, key, value, options); },
    remove: (scope, key, options) => { const caller = guard(); return facade.remove(caller, scope, key, options); },
    list: (scope, prefix, options) => { const caller = guard(); return facade.list(caller, scope, prefix, options); },
  };
}
