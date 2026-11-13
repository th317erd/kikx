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
  return store;
}
