'use strict';

import { BasePluginClass } from '../routing/base-plugin-class.mjs';

// =============================================================================
// HookService
// =============================================================================

export class HookService {
  /**
   * @param {object} registry - PluginRegistry instance
   */
  constructor(registry) {
    if (!registry)
      throw new Error('HookService requires a PluginRegistry');

    /** @type {object} */
    this._registry = registry;
  }

  /**
   * Execute hook pipeline.
   * Returns: { action: 'pass'|'block'|'redirect', message, reason?, target? }
   * @param {string} hookName
   * @param {object} payload
   * @param {string} [payload.source]
   * @param {string} [payload.target]
   * @param {string} [payload.message]
   * @param {object} [payload.context]
   * @returns {Promise<{ action: 'pass'|'block'|'redirect', message?: string, reason?: string, target?: string }>}
   */
  async run(hookName, payload) {
    let hookSelector = this._toSelector(hookName, payload);
    let plugins      = this._getPluginsForHook(hookSelector);

    let legacyHandlers = this._registry.getHookHandlers(hookName);

    if (plugins.length === 0 && legacyHandlers.length === 0)
      return { action: 'pass', message: payload.message };

    let current = { ...payload };

    // Run legacy handlers first
    for (let handler of legacyHandlers) {
      let result = await handler(current);

      if (!result)
        continue;

      if (result.action === 'block')
        return result;

      if (result.action === 'modify') {
        current.message = result.message;
        continue;
      }

      if (result.action === 'redirect')
        return result;
    }

    // Run routing plugin handlers
    for (let PluginClass of plugins) {
      let pluginContext = {
        source:      current.source,
        target:      current.target,
        message:     current.message,
        hookContext: current.context || {},
        action:      null,
        reason:      null,
      };

      let result = await this._runPlugin(PluginClass, pluginContext);

      if (result.action === 'block')
        return { action: 'block', reason: result.reason || 'Blocked by hook plugin' };

      if (result.action === 'redirect')
        return { action: 'redirect', target: result.target, message: result.message };

      if (result.message !== undefined)
        current.message = result.message;
    }

    return { action: 'pass', message: current.message };
  }

  /**
   * @param {string} hookName
   * @param {object} payload
   * @returns {string}
   */
  _toSelector(hookName, payload) {
    let source = payload && payload.source;
    let target = payload && payload.target;

    if (source && target)
      return `hook:${source}-to-${target}`;

    return `hook:${hookName}`;
  }

  /**
   * @param {string} hookSelector
   * @returns {Function[]}
   */
  _getPluginsForHook(hookSelector) {
    let selectors = this._registry.getSelectors();
    let plugins   = [];

    for (let entry of selectors) {
      if (entry.selector === hookSelector)
        plugins.push(entry.PluginClass);
    }

    return plugins;
  }

  /**
   * @param {Function} PluginClass
   * @param {object} context
   * @returns {Promise<{ action: string, message?: string, reason?: string, target?: string }>}
   */
  async _runPlugin(PluginClass, context) {
    let plugin = new PluginClass(context);
    let result = { action: 'pass', message: context.message };

    let nextCalled = false;

    let next = async (ctx) => {
      nextCalled = true;

      if (ctx && ctx.message !== undefined)
        result.message = ctx.message;

      if (ctx && ctx.action)
        result.action = ctx.action;

      if (ctx && ctx.reason)
        result.reason = ctx.reason;
    };

    let done = async (ctx) => {
      if (ctx && ctx.action)
        result.action = ctx.action;

      if (ctx && ctx.reason)
        result.reason = ctx.reason;

      if (ctx && ctx.message !== undefined)
        result.message = ctx.message;
    };

    try {
      await plugin.process(next, done);
    } catch (error) {
      throw error;
    }

    return result;
  }
}
