'use strict';

import { PluginInterface } from './plugin-interface.mjs';
import { AgentInterface } from './agent-interface.mjs';
import { ClassRegistry } from './class-registry.mjs';
import { normalizeConfigFields } from './agent-normalizers.mjs';
import { DatabaseConnectionBase } from '../database/database-connection-base.mjs';
import { normalizeTagDefinition } from '../tags/tag-definitions.mjs';

// PluginRegistry extends the universal ClassRegistry: tools/providers/selectors/
// components live here, and *any* class can be registered and overridden via the
// inherited stack methods (registerClass / getClass / unregisterPlugin).
export class PluginRegistry extends ClassRegistry {
  constructor(options = {}) {
    super();
    this.logger = options.logger || console;
    this._tools = new Map();
    this._agentProviders = new Map();
    this._databaseDrivers = new Map();
    this._selectors = [];
    this._frameComponents = new Map();
    this._toolComponents = new Map();
    this._agentConfigForms = new Map();
    this._tagDefinitions = new Map();
    this._frameIndexes = new Map();
    this._pluginPaths = new Map();
    // Every registration a plugin made, with a closure that undoes exactly that one
    // registration. Unload replays it in reverse, so an override falls back to what was
    // there before it instead of deleting the key outright.
    this._pluginOwnership = new Map();
  }

  // Record the on-disk root of a loaded plugin so the server can serve its
  // client assets from `<pluginPath>/client/`. Keyed by plugin name AND the
  // plugin IDs it registers, since client descriptors and agent providers
  // reference the plugin by ID (e.g. 'codex-agent') rather than its folder.
  registerPluginPath(pluginName, pluginPath, pluginIDs = []) {
    if (!pluginPath || typeof pluginPath !== 'string')
      return;

    let keys = [ pluginName, ...(Array.isArray(pluginIDs) ? pluginIDs : []) ].filter(Boolean);
    for (let key of keys) {
      let previous = this._pluginPaths.get(key);
      this._pluginPaths.set(key, pluginPath);
      // A plugin id may also be a core path key; restore it rather than delete it.
      this._recordOwnership(pluginName, "plugin-path", key, () => {
        if (previous === undefined)
          this._pluginPaths.delete(key);
        else
          this._pluginPaths.set(key, previous);
      });
    }
  }

  getPluginPath(pluginID) {
    return this._pluginPaths.get(pluginID) || null;
  }

  // Schema migrations. The directory is relative to the plugin, resolved by the caller.
  registerMigrations(pluginId, options = {}) {
    if (!this._pluginMigrations)
      throw new Error('registerMigrations called before the migrations registry was attached');
    let result = this._pluginMigrations.register(pluginId, options);
    this._recordOwnership(pluginId, "migrations", options.directory, () => {
      if (typeof this._pluginMigrations?.unregister === "function")
        this._pluginMigrations.unregister(pluginId);
    });
    return result;
  }

  // A plugin gets a scoped handle, never a pool. Created lazily from the shared pool so
  // a plugin that never touches the database costs nothing.
  getPluginAuthority(pluginId) {
    if (!this._pluginAuthorityFactory)
      throw new Error('authorize() called before the plugin authority was attached');
    if (!this._pluginAuthorities) this._pluginAuthorities = new Map();
    if (!this._pluginAuthorities.has(pluginId))
      this._pluginAuthorities.set(pluginId, this._pluginAuthorityFactory(pluginId));
    return this._pluginAuthorities.get(pluginId);
  }

  setPluginFrameRuntime(runtime) {
    this._pluginFrameRuntime = runtime;
  }

  setPluginAuthorityFactory(factory) {
    this._pluginAuthorityFactory = factory;
  }

  setPluginDatabaseFactory(factory) {
    this._pluginDatabaseFactory = factory;
  }

  getPluginDatabase(pluginId) {
    if (!this._pluginDatabaseFactory)
      throw new Error('db() called before the plugin database factory was attached');
    if (!this._pluginDatabases) this._pluginDatabases = new Map();
    if (!this._pluginDatabases.has(pluginId))
      this._pluginDatabases.set(pluginId, this._pluginDatabaseFactory(pluginId));
    return this._pluginDatabases.get(pluginId);
  }

  setPluginEventBus(bus) {
    this._pluginEventBus = bus;
  }

  listEventSubscriptions() {
    return this._pluginEventBus ? this._pluginEventBus.list() : [];
  }

  setPluginMigrations(migrations) {
    this._pluginMigrations = migrations;
  }

  // HTTP mounting. A plugin gets one mount point; everything below it is its own.
  mountHttp(pluginId, handler) {
    let path = this.getPluginRouter().mount(pluginId, handler);
    this._recordOwnership(pluginId, "http-mount", path, () => {
      this._pluginRouter?.unmount?.(pluginId);
    });
    return path;
  }

  listHttpMounts() {
    return this.getPluginRouter().listMounts();
  }

  setPluginRouter(router) {
    this._pluginRouter = router;
  }

  getPluginRouter() {
    if (!this._pluginRouter)
      throw new Error('mountHttp called before the plugin router was attached');
    return this._pluginRouter;
  }

  registerTool(name, ToolClass, options = {}) {
    if (!name || typeof name !== 'string')
      throw new TypeError('Tool name must be a non-empty string');

    if (!isSubclassOf(ToolClass, PluginInterface))
      throw new TypeError(`Tool "${name}" must extend PluginInterface`);

    let pluginName = options.pluginName || null;

    if (this._tools.has(name))
      this.logger.warn?.(`Tool "${name}" is being overridden`);

    let previous = this._tools.get(name);
    this._tools.set(name, ToolClass);
    this._recordOwnership(pluginName, "tool", name, () => {
      if (previous === undefined)
        this._tools.delete(name);
      else
        this._tools.set(name, previous);
    });
    if (ToolClass.clientComponent) {
      this.registerToolComponent(name, ToolClass.clientComponent, { pluginName });
      if (ToolClass.frameType) {
        this.registerFrameComponent(ToolClass.frameType, {
          ...ToolClass.clientComponent,
          frameType: ToolClass.frameType,
        }, { pluginName });
      }
    }

    return ToolClass;
  }

  getTool(name) {
    return this._tools.get(name) || null;
  }

  getTools() {
    return new Map(this._tools);
  }

  registerAgentProvider(pluginID, AgentClass, options = {}) {
    if (!pluginID || typeof pluginID !== 'string')
      throw new TypeError('Agent provider pluginID must be a non-empty string');

    if (!isSubclassOf(AgentClass, AgentInterface))
      throw new TypeError(`Agent provider "${pluginID}" must extend AgentInterface`);

    let pluginName = options.pluginName || null;

    if (this._agentProviders.has(pluginID))
      this.logger.warn?.(`Agent provider "${pluginID}" is being overridden`);

    let previous = this._agentProviders.get(pluginID);
    this._agentProviders.set(pluginID, AgentClass);
    this._recordOwnership(pluginName, "agent-provider", pluginID, () => {
      if (previous === undefined)
        this._agentProviders.delete(pluginID);
      else
        this._agentProviders.set(pluginID, previous);
    });
    return AgentClass;
  }

  registerAgentType(pluginID, AgentClass, options = {}) {
    return this.registerAgentProvider(pluginID, AgentClass, options);
  }

  getAgentProvider(pluginID) {
    return this._agentProviders.get(pluginID) || null;
  }

  getAgentProviders() {
    return new Map(this._agentProviders);
  }

  listAgentProviderDescriptors() {
    return Promise.all([ ...this._agentProviders.values() ].map(async (AgentClass) => {
      try {
        return await AgentClass.getAgentProviderDescriptor();
      } catch (error) {
        let pluginID = AgentClass.pluginID && AgentClass.pluginID !== 'unknown'
          ? AgentClass.pluginID
          : AgentClass.pluginId;
        this.logger.warn?.(`Failed to resolve agent provider descriptor for "${pluginID || AgentClass.name}": ${error?.message || error}`);

        return {
          pluginID: pluginID || AgentClass.name,
          agentType: AgentClass.agentType || pluginID || AgentClass.name,
          serviceType: AgentClass.serviceType || null,
          displayName: AgentClass.displayName || pluginID || AgentClass.name,
          description: AgentClass.description || '',
          configFields: [],
        };
      }
    }));
  }

  registerDatabaseDriver(driverID, DriverClass, options = {}) {
    if (!driverID || typeof driverID !== 'string')
      throw new TypeError('Database driver ID must be a non-empty string');

    if (!isSubclassOf(DriverClass, DatabaseConnectionBase))
      throw new TypeError(`Database driver "${driverID}" must extend DatabaseConnectionBase`);

    let pluginName = options.pluginName || null;

    if (this._databaseDrivers.has(driverID))
      this.logger.warn?.(`Database driver "${driverID}" is being overridden`);

    let previous = this._databaseDrivers.get(driverID);
    this._databaseDrivers.set(driverID, DriverClass);
    this._recordOwnership(pluginName, "database-driver", driverID, () => {
      if (previous === undefined)
        this._databaseDrivers.delete(driverID);
      else
        this._databaseDrivers.set(driverID, previous);
    });
    return DriverClass;
  }

  getDatabaseDriver(driverID) {
    return this._databaseDrivers.get(driverID) || null;
  }

  getDatabaseDrivers() {
    return new Map(this._databaseDrivers);
  }

  listDatabaseDriverDescriptors() {
    return Promise.all([ ...this._databaseDrivers.values() ].map(async (DriverClass) => {
      try {
        return await DriverClass.getDatabaseDriverDescriptor();
      } catch (error) {
        let driverID = DriverClass.driverID || DriverClass.name;
        this.logger.warn?.(`Failed to resolve database driver descriptor for "${driverID}": ${error?.message || error}`);

        return {
          driverID,
          displayName: DriverClass.displayName || driverID,
          description: DriverClass.description || '',
          capabilities: { ...(DriverClass.capabilities || {}) },
          configFields: normalizeConfigFields(DriverClass.configFields),
          configKeys: Array.isArray(DriverClass.configKeys) ? DriverClass.configKeys.slice() : [],
        };
      }
    }));
  }

  registerSelector(selector, PluginClass, owner = null) {
    if (!selector || (typeof selector !== 'string' && typeof selector !== 'function'))
      throw new TypeError('Selector must be a non-empty string or function');

    if (typeof PluginClass !== 'function')
      throw new TypeError('Selector plugin must be a class/function');

    // Two shapes reach here: a bare plugin name (core registrations) and an
    // options object (the loader attributing a plugin's own registration).
    let pluginName = typeof owner === 'string' ? owner : (owner?.pluginName || null);

    let entry = { selector, PluginClass, pluginName };
    this._selectors.push(entry);
    this._recordOwnership(pluginName, "selector", selector, () => {
      // By identity, not by selector string: another plugin may register the same
      // selector, and splicing by name would remove the wrong entry.
      let index = this._selectors.indexOf(entry);
      if (index !== -1)
        this._selectors.splice(index, 1);
    });
  }

  getSelectors() {
    return this._selectors.slice();
  }

  // Generic client component registration keyed by kind. `frame` and `tool`
  // are keyed by frameType/toolName; `agent-config-form` is keyed by pluginID.
  // A plugin may contribute an index for the frame documents it annotates.
  // FrameStore merges these into each session's interaction index config; the
  // plugin never owns or replaces the core index list.
  registerFrameIndex(name, definition = {}, options = {}) {
    if (!name || typeof name !== 'string')
      throw new TypeError('Frame index name must be a non-empty string');

    let normalized = {
      ...definition,
      name,
    };
    if (!normalized.type)
      throw new TypeError(`Frame index "${name}" requires a type`);
    let pluginName = options.pluginName || definition.pluginName || null;
    let previous = this._frameIndexes.get(name);
    this._frameIndexes.set(name, normalized);
    this._recordOwnership(pluginName, "frame-index", name, () => {
      if (previous === undefined)
        this._frameIndexes.delete(name);
      else
        this._frameIndexes.set(name, previous);
    });
    return normalized;
  }

  getFrameIndexes() {
    return [ ...this._frameIndexes.values() ].map((index) => ({ ...index }));
  }

  registerComponent(kind, key, descriptor = {}, options = {}) {
    switch (kind) {
      case 'frame':
        return this.registerFrameComponent(key, descriptor, options);
      case 'tool':
        return this.registerToolComponent(key, descriptor, options);
      case 'agent-config-form':
        return this.registerAgentConfigForm(key, descriptor, options);
      default:
        throw new TypeError(`Unknown client component kind: ${kind}`);
    }
  }

  registerFrameComponent(frameType, descriptor = {}, options = {}) {
    let normalized = normalizeComponentDescriptor(descriptor, {
      kind: 'frame',
      frameType,
    });

    let pluginName = options.pluginName || null;

    if (this._frameComponents.has(normalized.frameType))
      this.logger.warn?.(`Frame component "${normalized.frameType}" is being overridden`);

    let previous = this._frameComponents.get(normalized.frameType);
    this._frameComponents.set(normalized.frameType, normalized);
    this._recordOwnership(pluginName, "frame-component", normalized.frameType, () => {
      if (previous === undefined)
        this._frameComponents.delete(normalized.frameType);
      else
        this._frameComponents.set(normalized.frameType, previous);
    });
    return normalized;
  }

  registerToolComponent(toolName, descriptor = {}, options = {}) {
    let normalized = normalizeComponentDescriptor(descriptor, {
      kind: 'tool',
      toolName,
    });

    let pluginName = options.pluginName || null;

    if (this._toolComponents.has(normalized.toolName))
      this.logger.warn?.(`Tool component "${normalized.toolName}" is being overridden`);

    let previous = this._toolComponents.get(normalized.toolName);
    this._toolComponents.set(normalized.toolName, normalized);
    this._recordOwnership(pluginName, "tool-component", normalized.toolName, () => {
      if (previous === undefined)
        this._toolComponents.delete(normalized.toolName);
      else
        this._toolComponents.set(normalized.toolName, previous);
    });
    return normalized;
  }

  // A plugin's own agent create/edit form, keyed by the agent provider's
  // pluginID. The client renders this element in place of the generic
  // config fields.
  registerTagDefinition(name, definition = {}, options = {}) {
    let normalized = normalizeTagDefinition({ ...definition, name: definition.name || name }, name);
    if (!normalized.name)
      throw new TypeError('Tag definition name must be a non-empty string');

    let pluginName = options.pluginName || definition.pluginName || null;

    if (this._tagDefinitions.has(normalized.name))
      this.logger.warn?.(`Tag definition "${normalized.name}" is being overridden`);

    let previous = this._tagDefinitions.get(normalized.name);
    this._tagDefinitions.set(normalized.name, normalized);
    this._recordOwnership(pluginName, "tag-definition", normalized.name, () => {
      if (previous === undefined)
        this._tagDefinitions.delete(normalized.name);
      else
        this._tagDefinitions.set(normalized.name, previous);
    });
    return normalized;
  }

  getTagDefinition(name) {
    return this._tagDefinitions.get(name) || null;
  }

  listTagDefinitions() {
    return Array.from(this._tagDefinitions.values()).map((definition) => ({ ...definition }));
  }

  registerAgentConfigForm(pluginID, descriptor = {}, options = {}) {
    let normalized = normalizeComponentDescriptor(descriptor, {
      kind: 'agent-config-form',
      pluginID,
    });

    let pluginName = options.pluginName || null;

    if (this._agentConfigForms.has(normalized.pluginID))
      this.logger.warn?.(`Agent config form "${normalized.pluginID}" is being overridden`);

    let previous = this._agentConfigForms.get(normalized.pluginID);
    this._agentConfigForms.set(normalized.pluginID, normalized);
    this._recordOwnership(pluginName, "agent-config-form", normalized.pluginID, () => {
      if (previous === undefined)
        this._agentConfigForms.delete(normalized.pluginID);
      else
        this._agentConfigForms.set(normalized.pluginID, previous);
    });
    return normalized;
  }

  getFrameComponents() {
    return new Map(this._frameComponents);
  }

  getToolComponents() {
    return new Map(this._toolComponents);
  }

  getAgentConfigForms() {
    return new Map(this._agentConfigForms);
  }

  listClientComponentDescriptors() {
    return [
      ...this._frameComponents.values(),
      ...this._toolComponents.values(),
      ...this._agentConfigForms.values(),
    ].map((descriptor) => ({ ...descriptor }));
  }

  // --- plugin ownership -----------------------------------------------------

  // The registry is shared by core and by every plugin. Without attribution a
  // plugin's tools, selectors, tags and mounts are indistinguishable from core's,
  // so unloading cannot know what to take back and leaves all of it behind: a
  // mount that still serves, a subscription that still receives other sessions'
  // traffic, a migration registration that still claims its directory. Each
  // register method above records what it added and how to remove exactly that.

  // The loader marks the plugin it is currently setting up. A plugin that calls
  // registry.registerTool(...) directly - which both in-repo plugins do - has not
  // named itself, so the ambient scope supplies the owner. Explicit attribution
  // always wins, and core code (no scope) records nothing.
  beginPluginLoad(pluginName) {
    this._loadingPlugin = pluginName || null;
  }

  endPluginLoad() {
    this._loadingPlugin = null;
  }

  _recordOwnership(pluginName, kind, key, restore) {
    let owner = pluginName || this._loadingPlugin;
    if (!owner)
      return;
    pluginName = owner;

    let list = this._pluginOwnership.get(pluginName);
    if (!list) {
      list = [];
      this._pluginOwnership.set(pluginName, list);
    }
    list.push({ kind, key, restore });
  }

  listOwnedRegistrations(pluginName) {
    return (this._pluginOwnership.get(pluginName) || []).map((e) => ({ kind: e.kind, key: e.key }));
  }

  // Undo everything a plugin registered, then release the resources it opened.
  // Reverse order, because the ledger is chronological: the newest registration is
  // the one on top of the stack and must come off first. Never throws - a resource
  // that fails to close must not prevent the rest from being released.
  async releasePlugin(pluginName, { logger = this.logger } = {}) {
    if (!pluginName)
      return false;

    let owned = this._pluginOwnership.get(pluginName) || [];
    this._pluginOwnership.delete(pluginName);

    for (let entry of [ ...owned ].reverse()) {
      try {
        entry.restore();
      } catch (error) {
        logger?.warn?.(`releasePlugin("${pluginName}"): could not undo ${entry.kind} "${String(entry.key)}": ${error?.message || error}`);
      }
    }

    // Lazily created resources are not registrations, so they are not in the ledger,
    // but they hold a pool reference and a cache slot that would outlive the plugin.
    this._pluginAuthorities?.delete(pluginName);

    let handle = this._pluginDatabases?.get(pluginName);
    if (handle) {
      this._pluginDatabases.delete(pluginName);
      try {
        if (typeof handle.close === "function")
          await handle.close();
      } catch (error) {
        logger?.warn?.(`releasePlugin("${pluginName}"): closing the scoped database failed: ${error?.message || error}`);
      }
    }

    return true;
  }
}

function isSubclassOf(candidate, BaseClass) {
  return typeof candidate === 'function'
    && candidate !== BaseClass
    && candidate.prototype instanceof BaseClass;
}

function normalizeComponentDescriptor(descriptor, defaults = {}) {
  let input = normalizeDescriptorInput(descriptor);
  let kind = normalizeRequiredString(input.kind || defaults.kind, 'component kind');
  if (kind !== 'frame' && kind !== 'tool' && kind !== 'agent-config-form')
    throw new TypeError('Component kind must be "frame", "tool" or "agent-config-form"');

  let output = {
    ...input,
    kind,
    tagName: normalizeCustomElementName(input.tagName || input.tag || input.elementName),
    moduleURL: normalizeRequiredString(input.moduleURL || input.module || input.url, 'component moduleURL'),
  };

  if (kind === 'frame')
    output.frameType = normalizeRequiredString(input.frameType || defaults.frameType, 'frameType');
  else if (kind === 'tool')
    output.toolName = normalizeRequiredString(input.toolName || defaults.toolName, 'toolName');
  else
    output.pluginID = normalizeRequiredString(input.pluginID || defaults.pluginID, 'pluginID');

  delete output.tag;
  delete output.elementName;
  delete output.module;
  delete output.url;
  return output;
}

function normalizeDescriptorInput(descriptor) {
  if (typeof descriptor === 'string')
    return { tagName: descriptor };

  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor))
    throw new TypeError('Component descriptor must be an object');

  return { ...descriptor };
}

function normalizeRequiredString(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '')
    throw new TypeError(`${fieldName} must be a non-empty string`);

  return value.trim();
}

function normalizeCustomElementName(value) {
  let name = normalizeRequiredString(value, 'component tagName');
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/.test(name))
    throw new TypeError(`Invalid custom element tagName: ${name}`);

  return name;
}
