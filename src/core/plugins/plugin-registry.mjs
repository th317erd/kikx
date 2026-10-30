'use strict';

import { PluginInterface } from './plugin-interface.mjs';
import { AgentInterface } from './agent-interface.mjs';
import { ClassRegistry } from './class-registry.mjs';
import { normalizeConfigFields } from './agent-normalizers.mjs';
import { DatabaseConnectionBase } from '../database/database-connection-base.mjs';
import { normalizeTagDefinition } from '../tags/tag-definitions.mjs';
import {
  CORE_LOOP_CONTROL_ACTIONS,
  LOOP_CONTROL_TERMINALS,
} from './agent-loop-state.mjs';

// The retention vocabulary for plugin-owned index declarations. See
// registerFrameIndex for what each policy promises on unload. Exported so the
// contract is inspectable instead of being spelled out only in a document.
export const FRAME_INDEX_RETENTION_POLICIES = new Set([ 'definition-only', 'retain-data' ]);
export const FRAME_INDEX_RETENTION_DEFAULT = 'definition-only';

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
    this._clientSurfaces = new Map();
    this._promptSections = new Map();
    this._loopControls = new Map();
    this._tagDefinitions = new Map();
    this._frameIndexes = new Map();
    this._pluginServices = new Map();
    this._pluginServiceInstances = new Map();
    this._pluginServiceContext = null;
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

  // Plugin-owned services. Factories run after the core services exist, in
  // dependency order; a service may replace a context service, and unload restores
  // whatever was there before it.
  registerService(name, definition = {}, options = {}) {
    let serviceName = normalizeRequiredString(name, 'service name');
    let factory = typeof definition === 'function' ? definition : definition.factory;
    if (typeof factory !== 'function')
      throw new TypeError(`Service "${serviceName}" requires a factory function`);
    let pluginName = options.pluginName || null;
    let previous = this._pluginServices.get(serviceName);
    let entry = {
      name: serviceName,
      pluginName,
      factory,
      dependsOn: Array.isArray(definition.dependsOn) ? [ ...definition.dependsOn ] : [],
      shutdown: typeof definition.shutdown === 'function' ? definition.shutdown : null,
    };
    this._pluginServices.set(serviceName, entry);
    this._recordOwnership(pluginName, 'service', serviceName, () => {
      if (previous === undefined)
        this._pluginServices.delete(serviceName);
      else
        this._pluginServices.set(serviceName, previous);
    });
    return entry;
  }

  listPluginServices() {
    return [ ...this._pluginServices.values() ].map(({ name, pluginName, dependsOn }) => ({ name, pluginName, dependsOn: [ ...dependsOn ] }));
  }

  async initializePluginServices(context) {
    this._pluginServiceContext = context;
    let pending = new Map(this._pluginServices);
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
        this._pluginServiceInstances.set(name, { ...entry, instance, previous });
        pending.delete(name);
        progressed = true;
      }
      if (!progressed) {
        let names = [ ...pending.keys() ].join(', ');
        throw new Error(`Plugin service dependency cycle or unresolved dependency: ${names}`);
      }
    }
    return this.listPluginServices();
  }

  async releasePluginServices(pluginName) {
    let context = this._pluginServiceContext;
    let entries = [ ...this._pluginServiceInstances.entries() ]
      .filter(([, entry]) => entry.pluginName === pluginName)
      .reverse();
    for (let [name, entry] of entries) {
      this._pluginServiceInstances.delete(name);
      try {
        await entry.shutdown?.(entry.instance, context);
      } catch (error) {
        this.logger?.warn?.(`releasePluginServices("${pluginName}"): shutdown for "${name}" failed: ${error?.message || error}`);
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

  // Schema migrations. The directory is relative to the plugin, resolved by the caller.
  registerPromptSection(name, definition = {}, options = {}) {
    let key = normalizeRequiredString(name, 'prompt section name');
    let text = normalizeRequiredString(definition.text || definition.content, 'prompt section text');
    let pluginName = options.pluginName || null;
    let previous = this._promptSections.get(key);
    let entry = { name: key, text, order: Number.isFinite(Number(definition.order)) ? Number(definition.order) : 100 };
    this._promptSections.set(key, entry);
    this._recordOwnership(pluginName, 'prompt-section', key, () => {
      if (previous === undefined)
        this._promptSections.delete(key);
      else
        this._promptSections.set(key, previous);
    });
    return entry;
  }

  // Loop-control extensions: a plugin may add a named control action, but only by
  // declaring which of the core's fixed terminal states it ends in. The vocabulary is
  // closed on purpose: the loop must stay finite and auditable, so a plugin cannot
  // invent a new way for the loop to continue unseen. See LOOP_CONTROL_TERMINALS.
  registerLoopControl(name, definition = {}, options = {}) {
    let action = normalizeRequiredString(name, 'loop control name');

    if (CORE_LOOP_CONTROL_ACTIONS.has(action))
      throw new TypeError(`Loop control "${action}" collides with a core loop-control action`);

    let terminal = normalizeRequiredString(definition.terminal, `loop control "${action}" terminal`);
    if (!LOOP_CONTROL_TERMINALS.has(terminal))
      throw new TypeError(`Loop control "${action}" declares unknown terminal "${terminal}"; expected one of ${[ ...LOOP_CONTROL_TERMINALS ].sort().join(', ')}`);

    // A control that continues the turn wakes the agent again. That is a bounded single
    // continuation, not an unbounded path, but it must be asked for explicitly so a
    // plugin cannot acquire a self-wake by picking the wrong terminal by accident.
    if (terminal === 'respond' && definition.allowsContinuation !== true)
      throw new TypeError(`Loop control "${action}" uses the "respond" terminal and must set allowsContinuation: true`);

    let pluginName = options.pluginName || definition.pluginName || null;
    let previous = this._loopControls.get(action);
    let entry = {
      action,
      terminal,
      pluginName,
      allowsContinuation: definition.allowsContinuation === true,
      description: typeof definition.description === 'string' ? definition.description : '',
    };
    this._loopControls.set(action, entry);
    this._recordOwnership(pluginName, 'loop-control', action, () => {
      if (previous === undefined)
        this._loopControls.delete(action);
      else
        this._loopControls.set(action, previous);
    });
    return { ...entry };
  }

  listLoopControls() {
    return [ ...this._loopControls.values() ]
      .sort((left, right) => left.action.localeCompare(right.action))
      .map((entry) => ({ ...entry }));
  }

  // Terminal state a plugin-declared action resolves to, or null when the action is not
  // a registered extension. Null means "not a plugin control", not "allowed".
  getLoopControlTerminal(action) {
    let entry = this._loopControls.get(action);
    return entry ? entry.terminal : null;
  }

  listPromptSections() {
    return [ ...this._promptSections.values() ]
      .sort((left, right) => left.order - right.order || left.name.localeCompare(right.name))
      .map((entry) => ({ ...entry }));
  }

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
  mountHttp(pluginId, handler, options = {}) {
    let path = this.getPluginRouter().mount(pluginId, handler, options);
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
  //
  // RETENTION (campaign §4.5, owner ruling D8.4). An index declaration carries an
  // explicit `removeOnUnload` policy, because "unload removes the definition" and
  // "the index stays declared across an unload" are different promises and the
  // platform was silently making the second one: every declaration survived unload.
  //
  //   'definition-only' (default) - unload removes the declaration, so the config
  //       written to the driver stops naming the index. Durable data is untouched.
  //   'retain-data' - unload leaves the declaration in place, so a reinstall finds
  //       its index still declared. Durable data is untouched.
  //
  // Both policies retain durable plugin data. Nothing here deletes documents or
  // drops a physical index; removing data is a separate, explicit purge. The two
  // policies therefore differ ONLY in whether the declaration outlives the unload.
  registerFrameIndex(name, definition = {}, options = {}) {
    if (!name || typeof name !== 'string')
      throw new TypeError('Frame index name must be a non-empty string');

    let removeOnUnload = definition.removeOnUnload === undefined
      ? FRAME_INDEX_RETENTION_DEFAULT
      : definition.removeOnUnload;
    // Fail closed on a typo. A misspelled policy must never be read as the
    // permissive one, and must never be silently replaced by the default: either
    // would decide a data-retention question on the plugin's behalf.
    if (!FRAME_INDEX_RETENTION_POLICIES.has(removeOnUnload))
      throw new TypeError(
        `Frame index "${name}" has an unknown removeOnUnload policy "${String(removeOnUnload)}"; `
        + `expected one of: ${[ ...FRAME_INDEX_RETENTION_POLICIES ].join(', ')}`,
      );

    let normalized = {
      ...definition,
      name,
      removeOnUnload,
    };
    if (!normalized.type)
      throw new TypeError(`Frame index "${name}" requires a type`);
    let pluginName = options.pluginName || definition.pluginName || null;
    let previous = this._frameIndexes.get(name);
    this._frameIndexes.set(name, normalized);
    this._recordOwnership(pluginName, "frame-index", name, () => {
      // A retained declaration outlives the unload on purpose; undoing it here
      // would make the two policies indistinguishable.
      if (removeOnUnload === 'retain-data')
        return;
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
      case 'main-app':
      case 'view':
      case 'sidebar-item':
      case 'toolbar-action':
      case 'settings-panel':
        return this.registerClientSurface(kind, key, descriptor, options);
      default:
        throw new TypeError(`Unknown client component kind: ${kind}`);
    }
  }

  // Main shell and composition surfaces contributed by plugins. The descriptor
  // carries the same tagName/moduleURL contract as frame components; the key is
  // the stable surface id within its kind.
  registerClientSurface(kind, key, descriptor = {}, options = {}) {
    let normalized = normalizeComponentDescriptor(descriptor, {
      kind,
      surfaceID: key,
    });
    let pluginName = options.pluginName || null;
    let mapKey = `${kind}:${normalized.surfaceID}`;
    let previous = this._clientSurfaces.get(mapKey);
    if (previous)
      this.logger.warn?.(`Client surface "${mapKey}" is being overridden`);
    this._clientSurfaces.set(mapKey, normalized);
    this._recordOwnership(pluginName, 'client-surface', mapKey, () => {
      if (previous === undefined)
        this._clientSurfaces.delete(mapKey);
      else
        this._clientSurfaces.set(mapKey, previous);
    });
    return normalized;
  }

  registerMainApp(key, descriptor = {}, options = {}) {
    return this.registerClientSurface('main-app', key, descriptor, options);
  }

  getMainAppDescriptor() {
    return [ ...this._clientSurfaces.values() ].find((descriptor) => descriptor.kind === 'main-app') || null;
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
      ...this._clientSurfaces.values(),
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

  // Class overrides go on the ClassRegistry stack, which attributes by an explicit
  // pluginName option and has no idea an ambient load is in progress. A plugin that
  // calls registry.registerClass() directly - rather than the attributed ctx.registerClass
  // the loader injects - was therefore recorded with pluginName: null and could never be
  // popped by unloadPlugin() or by a failed-load rollback. Fill the ambient owner in here
  // so both scopes behave the same way. An explicit pluginName still wins, and core code
  // (no scope) is unaffected.
  registerClass(...args) {
    let owner = this._loadingPlugin;
    if (owner) {
      if (typeof args[0] === 'string') {
        let options = (args[2] && typeof args[2] === 'object') ? args[2] : {};
        args = optionArgs(args, 2, { pluginName: owner, ...options });
      } else {
        let options = (args[1] && typeof args[1] === 'object') ? args[1] : {};
        args = optionArgs(args, 1, { pluginName: owner, ...options });
      }
    }

    return super.registerClass(...args);
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
  //
  // `since` replays only the ledger entries at or after that index. A failed load
  // passes the depth it snapshotted before it touched anything, so it undoes its own
  // partial registrations without taking down the ones an earlier load made under the
  // same name. A partial release also leaves the lazily created authority and scoped
  // database alone: those belong to the plugin as a whole, and the surviving load's
  // owner still needs them.
  async releasePlugin(pluginName, { logger = this.logger, since = 0 } = {}) {
    if (!pluginName)
      return false;

    let owned = this._pluginOwnership.get(pluginName) || [];
    // A non-zero snapshot means an earlier load already owns part of this ledger, so
    // only the entries added since that snapshot are this load's to undo.
    let partial = Number.isInteger(since) && since > 0;
    let replay = partial ? owned.slice(since) : owned;

    if (partial) {
      if (owned.length > since)
        this._pluginOwnership.set(pluginName, owned.slice(0, since));
    } else {
      this._pluginOwnership.delete(pluginName);
    }

    for (let entry of [ ...replay ].reverse()) {
      try {
        entry.restore();
      } catch (error) {
        logger?.warn?.(`releasePlugin("${pluginName}"): could not undo ${entry.kind} "${String(entry.key)}": ${error?.message || error}`);
      }
    }

    // A partial release leaves the lazily created resources and the service instances
    // alone: they are not registrations, and a surviving load under the same name still
    // needs them. Nothing a failed load registered can own an instance anyway -
    // initializePluginServices() runs after loadPlugins() - so its service entries are
    // fully undone by the ledger replay above.
    if (partial)
      return true;

    await this.releasePluginServices(pluginName);

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

// Replace (or append) the options argument at a fixed position without disturbing the
// positional arguments before it. registerClass takes either (Class, options) or
// (key, Class, options), so the slot differs and passing undefined is not the same as
// omitting for some callers.
function optionArgs(args, index, options) {
  let next = args.slice();
  while (next.length < index) next.push(undefined);
  next[index] = options;
  return next;
}

// Read a service from a context that may implement any of require/get/has or be a plain
// Map. Used by the release path, where throwing would abort an unload.
function readContextEntry(context, name) {
  if (!context)
    return undefined;
  if (typeof context.require === 'function')
    return context.require(name);
  if (typeof context.get === 'function')
    return context.get(name);
  return undefined;
}

function isSubclassOf(candidate, BaseClass) {
  return typeof candidate === 'function'
    && candidate !== BaseClass
    && candidate.prototype instanceof BaseClass;
}

function normalizeComponentDescriptor(descriptor, defaults = {}) {
  let input = normalizeDescriptorInput(descriptor);
  let kind = normalizeRequiredString(input.kind || defaults.kind, 'component kind');
  let surfaceKinds = new Set(['main-app', 'view', 'sidebar-item', 'toolbar-action', 'settings-panel']);
  if (kind !== 'frame' && kind !== 'tool' && kind !== 'agent-config-form' && !surfaceKinds.has(kind))
    throw new TypeError('Component kind must be frame, tool, agent-config-form, main-app, view, sidebar-item, toolbar-action or settings-panel');

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
  else if (kind === 'agent-config-form')
    output.pluginID = normalizeRequiredString(input.pluginID || defaults.pluginID, 'pluginID');
  else
    output.surfaceID = normalizeRequiredString(input.surfaceID || input.id || defaults.surfaceID, 'surface id');

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
