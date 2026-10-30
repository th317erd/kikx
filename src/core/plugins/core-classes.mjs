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
import { FRAME_TYPE_REGISTRATIONS } from '../frames/frame-types/index.mjs';
import { DatabaseConnectionBase } from '../database/database-connection-base.mjs';
import { SQLiteConnection } from '../database/sqlite-connection.mjs';
import { PostgreSQLConnection } from '../database/postgresql-connection.mjs';
import { AeorDBConnection } from '../aeordb/aeordb-connection.mjs';

// Keys that a real construction site asks the registry for. Everything in
// CORE_CLASSES is *registered* for override, but registration is only half the
// contract: a key becomes effective only where the running system resolves it
// instead of importing the class directly. This list is the audited second half.
//
// Audited 2026-10-30 against every `new CoreClass()` and every `extends`:
//   FrameRouter        create-server.mjs -> resolveCoreClass('FrameRouter')
//   FrameRuntime       create-server.mjs -> resolveCoreClass('FrameRuntime')
//   CompactionService  create-server.mjs -> resolveCoreClass('CompactionService')
//   CommandRegistry    create-server.mjs -> resolveCoreClass('CommandRegistry')
//
// Deliberately NOT here, because no construction site resolves them:
//   PluginInterface, AgentInterface, DatabaseConnectionBase
//     Every consumer imports the class and `extends` it, or subclasses it at
//     module load (SQLiteConnection/PostgreSQLConnection/AeorDBConnection all
//     `extends DatabaseConnectionBase` at parse time). Database drivers are chosen
//     through registerDatabaseDriver(), a separate registry, not through
//     getClass(). An override on these keys is accepted and does nothing.
//   FrameType<Type>
//     createTypedFrame() reads registry.getClass() only when a caller passes a
//     registry. The only production path is AgentInterface.buildModelMessages(),
//     and both providers that call it (ollama, codex) invoke
//     `this.constructor.buildModelMessages(params)` with no options, so `registry`
//     is always null. The frame-type override therefore never takes effect today.
//
// These keys are reported by ClassRegistry.listInertOverrides() so an operator is
// told the override did not apply, instead of inferring it from a registry row.
export const CONSUMED_CLASS_KEYS = Object.freeze([
  'FrameRouter',
  'FrameRuntime',
  'CompactionService',
  'CommandRegistry',
]);

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
  DatabaseConnectionBase,
];

export function registerCoreClasses(registry) {
  if (!registry || typeof registry.registerClass !== 'function')
    throw new TypeError('registerCoreClasses() requires a registry');

  for (let ClassRef of CORE_CLASSES)
    registry.registerClass(ClassRef.name, ClassRef, { pluginName: 'core' });

  registerFrameTypeClasses(registry);

  // Declare which keys a construction site actually resolves, so an override on a
  // key that nothing resolves is reported as inert instead of being accepted
  // silently. Registration alone promises more than the engine delivers.
  if (typeof registry.setConsumedKeys === 'function')
    registry.setConsumedKeys(CONSUMED_CLASS_KEYS);

  // Register the built-in AeorDB and SQLite drivers so a default boot never
  // depends on a user plugin. SQLiteConnection imports `node:sqlite` lazily, so
  // registering it does not load the experimental module. PluginRegistry guards
  // the driver type; a plain ClassRegistry without the plural driver registry is
  // left untouched.
  if (typeof registry.registerDatabaseDriver === 'function') {
    registry.registerDatabaseDriver('aeordb', AeorDBConnection);
    registry.registerDatabaseDriver('sqlite', SQLiteConnection);
    registry.registerDatabaseDriver('postgresql', PostgreSQLConnection);
  }

  return registry;
}

// Register the frame-type class hierarchy under `FrameType<Type>` keys so a
// plugin can override or add a frame type through the same registry. Called by
// registerCoreClasses() at the shared bootstrap path.
export function registerFrameTypeClasses(registry, { pluginName = 'core' } = {}) {
  if (!registry || typeof registry.registerClass !== 'function')
    throw new TypeError('registerFrameTypeClasses() requires a registry');

  for (let [ key, ClassRef ] of Object.entries(FRAME_TYPE_REGISTRATIONS))
    registry.registerClass(key, ClassRef, { pluginName });

  return registry;
}

// Resolve a core class through the registry, falling back to the imported class
// when nothing is registered (or the registry is absent). Use at construction
// sites to make a class overridable, e.g.:
//   let Router = resolveCoreClass(registry, 'FrameRouter', FrameRouter);
//   let router = new Router(...);
export function resolveCoreClass(registry, key, Fallback) {
  let resolved = null;
  if (registry && typeof registry.getClass === 'function')
    resolved = registry.getClass(key);

  let ClassRef = resolved || Fallback;

  // Record what this instance is being built from, so a later override or a later
  // unload can be told apart from a change that actually took effect. Without this the
  // registry row says "FrameRouter is the plugin's class" while the router serving
  // requests was constructed earlier from core - and nothing anywhere says so.
  if (registry && typeof registry.noteClassResolved === 'function')
    registry.noteClassResolved(key, ClassRef);

  return ClassRef;
}
