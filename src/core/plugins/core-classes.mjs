'use strict';

// Core class registration for the universal ClassRegistry.
//
// Every override-worthy core class is registered here under its class name with
// `pluginName: 'core'`. A plugin overrides one by re-registering the same key,
// and `registry.unregisterPlugin('<plugin>')` pops it back to the core class.
//
// Per the kikx2 design: the engine opts into overridability by resolving classes
// through the registry; hardcoded instantiation stays locked down. Security
// critical code (crypto, auth) is intentionally NOT registered here.

import { PluginRegistry } from './plugin-registry.mjs';
import { PluginInterface } from './plugin-interface.mjs';
import { AgentInterface } from './agent-interface.mjs';
import { FrameRouter } from '../routing/frame-router.mjs';
import { FrameRuntime } from '../runtime/frame-runtime.mjs';
import { CompactionService } from '../compaction/compaction-service.mjs';
import { CommandRegistry } from '../commands/command-registry.mjs';

// Classes registered for override. Kept to the classes a plugin has a plausible
// reason to replace (engine/router/runtime/compaction registries), not the whole
// tree, to bound the blast radius.
const CORE_CLASSES = [
  PluginRegistry,
  PluginInterface,
  AgentInterface,
  CommandRegistry,
  FrameRouter,
  FrameRuntime,
  CompactionService,
];

export function registerCoreClasses(registry) {
  if (!registry || typeof registry.registerClass !== 'function')
    throw new TypeError('registerCoreClasses() requires a registry');

  for (let ClassRef of CORE_CLASSES)
    registry.registerClass(ClassRef.name, ClassRef, { pluginName: 'core' });

  return registry;
}

// Resolve a core class through the registry, falling back to the imported class
// when nothing is registered (or the registry is absent). Use at construction
// sites to make a class overridable, e.g.:
//   let Router = resolveCoreClass(registry, 'FrameRouter', FrameRouter);
//   let router = new Router(...);
export function resolveCoreClass(registry, key, Fallback) {
  if (registry && typeof registry.getClass === 'function') {
    let resolved = registry.getClass(key);
    if (resolved)
      return resolved;
  }

  return Fallback;
}
