'use strict';

import { PluginInterface } from './plugin-interface.mjs';
import { AgentInterface } from './agent-interface.mjs';
import { ClassRegistry } from './class-registry.mjs';
import { normalizeConfigFields } from './agent-normalizers.mjs';
import { DatabaseConnectionBase } from '../database/database-connection-base.mjs';

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
    this._pluginPaths = new Map();
  }

  // Record the on-disk root of a loaded plugin so the server can serve its
  // client assets from `<pluginPath>/client/`. Keyed by plugin name AND the
  // plugin IDs it registers, since client descriptors and agent providers
  // reference the plugin by ID (e.g. 'codex-agent') rather than its folder.
  registerPluginPath(pluginName, pluginPath, pluginIDs = []) {
    if (!pluginPath || typeof pluginPath !== 'string')
      return;

    let keys = [ pluginName, ...(Array.isArray(pluginIDs) ? pluginIDs : []) ].filter(Boolean);
    for (let key of keys)
      this._pluginPaths.set(key, pluginPath);
  }

  getPluginPath(pluginID) {
    return this._pluginPaths.get(pluginID) || null;
  }

  registerTool(name, ToolClass) {
    if (!name || typeof name !== 'string')
      throw new TypeError('Tool name must be a non-empty string');

    if (!isSubclassOf(ToolClass, PluginInterface))
      throw new TypeError(`Tool "${name}" must extend PluginInterface`);

    if (this._tools.has(name))
      this.logger.warn?.(`Tool "${name}" is being overridden`);

    this._tools.set(name, ToolClass);
    if (ToolClass.clientComponent) {
      this.registerToolComponent(name, ToolClass.clientComponent);
      if (ToolClass.frameType) {
        this.registerFrameComponent(ToolClass.frameType, {
          ...ToolClass.clientComponent,
          frameType: ToolClass.frameType,
        });
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

  registerAgentProvider(pluginID, AgentClass) {
    if (!pluginID || typeof pluginID !== 'string')
      throw new TypeError('Agent provider pluginID must be a non-empty string');

    if (!isSubclassOf(AgentClass, AgentInterface))
      throw new TypeError(`Agent provider "${pluginID}" must extend AgentInterface`);

    if (this._agentProviders.has(pluginID))
      this.logger.warn?.(`Agent provider "${pluginID}" is being overridden`);

    this._agentProviders.set(pluginID, AgentClass);
    return AgentClass;
  }

  registerAgentType(pluginID, AgentClass) {
    return this.registerAgentProvider(pluginID, AgentClass);
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

  registerDatabaseDriver(driverID, DriverClass) {
    if (!driverID || typeof driverID !== 'string')
      throw new TypeError('Database driver ID must be a non-empty string');

    if (!isSubclassOf(DriverClass, DatabaseConnectionBase))
      throw new TypeError(`Database driver "${driverID}" must extend DatabaseConnectionBase`);

    if (this._databaseDrivers.has(driverID))
      this.logger.warn?.(`Database driver "${driverID}" is being overridden`);

    this._databaseDrivers.set(driverID, DriverClass);
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

  registerSelector(selector, PluginClass, pluginName = null) {
    if (!selector || (typeof selector !== 'string' && typeof selector !== 'function'))
      throw new TypeError('Selector must be a non-empty string or function');

    if (typeof PluginClass !== 'function')
      throw new TypeError('Selector plugin must be a class/function');

    this._selectors.push({ selector, PluginClass, pluginName });
  }

  getSelectors() {
    return this._selectors.slice();
  }

  // Generic client component registration keyed by kind. `frame` and `tool`
  // are keyed by frameType/toolName; `agent-config-form` is keyed by pluginID.
  registerComponent(kind, key, descriptor = {}) {
    switch (kind) {
      case 'frame':
        return this.registerFrameComponent(key, descriptor);
      case 'tool':
        return this.registerToolComponent(key, descriptor);
      case 'agent-config-form':
        return this.registerAgentConfigForm(key, descriptor);
      default:
        throw new TypeError(`Unknown client component kind: ${kind}`);
    }
  }

  registerFrameComponent(frameType, descriptor = {}) {
    let normalized = normalizeComponentDescriptor(descriptor, {
      kind: 'frame',
      frameType,
    });

    if (this._frameComponents.has(normalized.frameType))
      this.logger.warn?.(`Frame component "${normalized.frameType}" is being overridden`);

    this._frameComponents.set(normalized.frameType, normalized);
    return normalized;
  }

  registerToolComponent(toolName, descriptor = {}) {
    let normalized = normalizeComponentDescriptor(descriptor, {
      kind: 'tool',
      toolName,
    });

    if (this._toolComponents.has(normalized.toolName))
      this.logger.warn?.(`Tool component "${normalized.toolName}" is being overridden`);

    this._toolComponents.set(normalized.toolName, normalized);
    return normalized;
  }

  // A plugin's own agent create/edit form, keyed by the agent provider's
  // pluginID. The client renders this element in place of the generic
  // config fields.
  registerAgentConfigForm(pluginID, descriptor = {}) {
    let normalized = normalizeComponentDescriptor(descriptor, {
      kind: 'agent-config-form',
      pluginID,
    });

    if (this._agentConfigForms.has(normalized.pluginID))
      this.logger.warn?.(`Agent config form "${normalized.pluginID}" is being overridden`);

    this._agentConfigForms.set(normalized.pluginID, normalized);
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
