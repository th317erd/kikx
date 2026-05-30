'use strict';

import { PluginInterface } from './plugin-interface.mjs';

export class PluginRegistry {
  constructor(options = {}) {
    this.logger = options.logger || console;
    this._tools = new Map();
    this._selectors = [];
    this._classes = new Map();
  }

  registerTool(name, ToolClass) {
    if (!name || typeof name !== 'string')
      throw new TypeError('Tool name must be a non-empty string');

    if (!isSubclassOf(ToolClass, PluginInterface))
      throw new TypeError(`Tool "${name}" must extend PluginInterface`);

    if (this._tools.has(name))
      this.logger.warn?.(`Tool "${name}" is being overridden`);

    this._tools.set(name, ToolClass);
    return ToolClass;
  }

  getTool(name) {
    return this._tools.get(name) || null;
  }

  getTools() {
    return new Map(this._tools);
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

