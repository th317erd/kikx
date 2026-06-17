'use strict';

import { PluginInterface } from './plugin-interface.mjs';
import { AgentInterface } from './agent-interface.mjs';

export class PluginRegistry {
  constructor(options = {}) {
    this.logger = options.logger || console;
    this._tools = new Map();
    this._agentProviders = new Map();
    this._selectors = [];
    this._classes = new Map();
    this._frameComponents = new Map();
    this._toolComponents = new Map();
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
    return [ ...this._agentProviders.values() ].map((AgentClass) => AgentClass.getAgentProviderDescriptor());
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

  getFrameComponents() {
    return new Map(this._frameComponents);
  }

  getToolComponents() {
    return new Map(this._toolComponents);
  }

  listClientComponentDescriptors() {
    return [
      ...this._frameComponents.values(),
      ...this._toolComponents.values(),
    ].map((descriptor) => ({ ...descriptor }));
  }

  registerClass(nameOrClass, ClassRef = null) {
    let name = ClassRef ? nameOrClass : nameOrClass?.name;
    let klass = ClassRef || nameOrClass;

    if (!name || typeof name !== 'string')
      throw new TypeError('Class registration requires a class name');

    if (typeof klass !== 'function')
      throw new TypeError(`Class "${name}" must be a function`);

    if (!this._classes.has(name))
      this._classes.set(name, []);

    this._classes.get(name).push(klass);
    return klass;
  }

  getClass(name) {
    let stack = this._classes.get(name);
    if (!stack || stack.length === 0)
      return null;

    return stack[stack.length - 1];
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
  if (kind !== 'frame' && kind !== 'tool')
    throw new TypeError('Component kind must be "frame" or "tool"');

  let output = {
    ...input,
    kind,
    tagName: normalizeCustomElementName(input.tagName || input.tag || input.elementName),
    moduleURL: normalizeRequiredString(input.moduleURL || input.module || input.url, 'component moduleURL'),
  };

  if (kind === 'frame')
    output.frameType = normalizeRequiredString(input.frameType || defaults.frameType, 'frameType');
  else
    output.toolName = normalizeRequiredString(input.toolName || defaults.toolName, 'toolName');

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
