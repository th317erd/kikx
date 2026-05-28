'use strict';

import { PluginRegistry }  from '../../src/core/plugin-loader/registry.mjs';
import { PluginInterface } from '../../src/core/plugin-loader/plugin-interface.mjs';

// =============================================================================
// Test helper for setup(provide) pattern
// =============================================================================
// Creates a fresh PluginRegistry with core classes registered, then calls
// setup(provide) with the registry and context.
// Returns the registry for inspection.
// =============================================================================

export function callSetupWithProvide(setupFn, context) {
  let registry = new PluginRegistry();
  registry.registerClass(PluginInterface, { pluginName: 'core' });
  setupFn((cb) => cb({ registry, context: context || null }));
  return registry;
}
