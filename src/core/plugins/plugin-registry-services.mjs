'use strict';

// Plugin service registration, dependency-ordered initialization, and unload.
// The registry keeps thin wrappers; the state machine lives here.

import { normalizeRequiredString, readContextEntry } from './plugin-registry-helpers.mjs';

  // Plugin-owned services. Factories run after the core services exist, in
  // dependency order; a service may replace a context service, and unload restores
  // whatever was there before it.
export function registerPluginService(registry, name, definition = {}, options = {}) {
    let serviceName = normalizeRequiredString(name, 'service name');
    let factory = typeof definition === 'function' ? definition : definition.factory;
    if (typeof factory !== 'function')
      throw new TypeError(`Service "${serviceName}" requires a factory function`);
    let pluginName = options.pluginName || null;
    let previous = registry._pluginServices.get(serviceName);
    let entry = {
      name: serviceName,
      pluginName,
      factory,
      dependsOn: Array.isArray(definition.dependsOn) ? [ ...definition.dependsOn ] : [],
      shutdown: typeof definition.shutdown === 'function' ? definition.shutdown : null,
    };
    registry._pluginServices.set(serviceName, entry);
    registry._recordOwnership(pluginName, 'service', serviceName, () => {
      if (previous === undefined)
        registry._pluginServices.delete(serviceName);
      else
        registry._pluginServices.set(serviceName, previous);
    });
    return entry;
  }

export function listPluginServices(registry) {
    return [ ...registry._pluginServices.values() ].map(({ name, pluginName, dependsOn }) => ({ name, pluginName, dependsOn: [ ...dependsOn ] }));
  }

export async function initializePluginServices(registry, context) {
    registry._pluginServiceContext = context;
    let pending = new Map(registry._pluginServices);
    while (pending.size > 0) {
      let progressed = false;
      for (let [name, entry] of pending) {
        if (entry.dependsOn.some((dependency) => pending.has(dependency)))
          continue;
        let missing = entry.dependsOn.filter((dependency) => !context.has?.(dependency));
        if (missing.length > 0)
          throw new Error(`Service "${name}" requires missing service(s): ${missing.join(', ')}`);
        let instance = await entry.factory(context);
        let previous = context.has?.(name) ? context.require(name) : undefined;
        context.set(name, instance);
        registry._pluginServiceInstances.set(name, { ...entry, instance, previous });
        pending.delete(name);
        progressed = true;
      }
      if (!progressed) {
        let names = [ ...pending.keys() ].join(', ');
        throw new Error(`Plugin service dependency cycle or unresolved dependency: ${names}`);
      }
    }
    return registry.listPluginServices();
  }

export async function releasePluginServices(registry, pluginName) {
    let context = registry._pluginServiceContext;
    let entries = [ ...registry._pluginServiceInstances.entries() ]
      .filter(([, entry]) => entry.pluginName === pluginName)
      .reverse();
    for (let [name, entry] of entries) {
      registry._pluginServiceInstances.delete(name);
      try {
        await entry.shutdown?.(entry.instance, context);
      } catch (error) {
        registry.logger?.warn?.(`releasePluginServices("${pluginName}"): shutdown for "${name}" failed: ${error?.message || error}`);
      }
      // Only restore when the instance in the context is still ours. A later load may
      // have replaced it, and stomping that would break the plugin that now owns it.
      //
      // The lookup must go through a reader that tolerates a partial context: this line
      // previously guarded `has` with optional chaining but called `require` unguarded,
      // so any context without `require` threw out of releasePluginServices - aborting
      // unloadPlugin() after its subscriptions were already dropped, and breaking the
      // "never throws" contract releasePlugin() promises.
      if (context?.has?.(name) && readContextEntry(context, name) === entry.instance) {
        if (entry.previous === undefined)
          context.delete?.(name);
        else
          context.set?.(name, entry.previous);
      }
    }
    return entries.length;
  }
