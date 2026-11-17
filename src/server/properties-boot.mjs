'use strict';

// Properties store boot seam (plan: docs/plans/properties-store.md P1).
//
// The properties table must exist BEFORE plugins load: a plugin's setup() /
// onInit() may write properties, and both run INSIDE create-server's boot
// load (pluginLoadPromise), before plugin migrations. This cannot ride the
// document driver — that is resolved only AFTER the load (a plugin may even
// register the driver) — so the store owns its own connection and DDL as
// core boot work, ahead of the load promise.
//
// Precedence (plan P3, pinned): create-server options.* > properties > env
// defaults. An injected options.propertiesStore skips the open entirely
// (harnesses/embedders). Extracted from create-server so that file stays
// under the 800-line hard cap.

import { openPropertiesStore } from '../core/properties/store.mjs';
import { createPropertiesFacade } from '../core/properties/facade.mjs';
import { CorePropertyRegistry } from '../core/properties/registry.mjs';
import { GrantsRegistry } from '../core/properties/grants.mjs';
import { KIKX_PROPERTIES_ENCRYPTION_KEY_PATH } from '../core/config/index.mjs';

export async function ensurePropertiesStore({
  context,
  options,
  config,
  databaseURL = null,
  databasePath = null,
}) {
  if (context.has('propertiesStore'))
    return context.require('propertiesStore');

  if (options.propertiesStore) {
    context.set('propertiesStore', options.propertiesStore);
    // The HTTP routes and plugin setup talk to the FACADE, never the raw
    // store — an injected store must register the full aside too (measured:
    // theme test got 503 property_store unavailable with store-only
    // injection, 2026-11-14; the P1 seam predates the P2 facade).
    ensurePropertiesAside(context, options.propertiesStore, options);
    return options.propertiesStore;
  }

  const propertiesOptions = options.properties || {};
  const store = await openPropertiesStore({
    driver: propertiesOptions.driver || (databaseURL ? 'postgresql' : 'sqlite'),
    url: databaseURL || null,
    filename: propertiesOptions.filename || databasePath || undefined,
    encryptionKey: propertiesOptions.encryptionKey
      ?? await config.get(KIKX_PROPERTIES_ENCRYPTION_KEY_PATH),
    logger: options.logger || console,
  });
  context.set('propertiesStore', store);
  // Record that THIS context owns the open. A caller-injected store is the
  // caller's to close; an opened one is ours. Without the marker the shutdown
  // path cannot tell the two apart, and closing an injected store would kill
  // a handle the embedder still expects to use.
  context.set(PROPERTIES_OWNED_KEY, true);
  ensurePropertiesAside(context, store, options);

  return store;
}

// Marks a context whose properties store was OPENED here (not injected).
// Exported so create-server's close handler can test it without re-deriving
// ownership from the options it no longer has in hand.
export const PROPERTIES_OWNED_KEY = 'propertiesStoreOwned';

// Close the properties store IF this context owns it, and detach it so a
// reused context cannot be handed a closed handle. Idempotent: SqlPropertiesStore
// flips `closed` before awaiting, so a second call is a no-op.
//
// Deliberately best-effort and never throws: this runs inside a server 'close'
// listener, where a rejection would become an unhandled rejection during
// shutdown. A store that fails to close is a leaked socket, not a failed test.
//
// Why ownership tracking rather than closing unconditionally: several suites
// boot more than one server from ONE context (session-preferences-route-spec
// 4 boots / 1 context; question-index-repair-startup-spec 2 / 1). Closing on
// every server close would leave the next server holding a dead pool.
export async function closeOwnedPropertiesStore(context) {
  if (!context.has(PROPERTIES_OWNED_KEY))
    return false;
  context.delete(PROPERTIES_OWNED_KEY);
  if (!context.has('propertiesStore'))
    return false;

  const store = context.require('propertiesStore');
  context.delete('propertiesStore');
  try {
    await store?.close?.();
    return true;
  } catch {
    return false;
  }
}

// Grants + facade registration, shared by the INJECTED and the OPENED store
// paths: the HTTP layer only ever talks to the facade, so whichever way the
// store arrived, the aside must exist before plugins load (P2). Extracted so
// injection can never skip it again.
function ensurePropertiesAside(context, store, options) {
  // P2: grants + facade also exist BEFORE plugins load — setup() may use
  // ctx.properties, and the loader registers each manifest's `access` block
  // during its own load. The registry stash gives unloadPlugin (reload,
  // disable, uninstall) the only handle every unload path already shares.
  if (!context.has('propertiesGrants'))
    context.set('propertiesGrants', new GrantsRegistry());
  const grants = context.require('propertiesGrants');
  if (context.has('pluginRegistry'))
    context.require('pluginRegistry')._propertiesGrants = grants;
  if (!context.has('propertiesFacade'))
    context.set('propertiesFacade', createPropertiesFacade({
      store,
      registry: new CorePropertyRegistry(),
      grants,
      logger: options.logger || console,
    }));
}
