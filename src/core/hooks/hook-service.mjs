'use strict';

import { BasePluginClass } from '../routing/base-plugin-class.mjs';

// =============================================================================
// HookService
// =============================================================================
// Routing-plugin-based replacement for HookRunner. Executes hook handlers
// registered via registerSelector() using BasePluginClass instances.
//
// Hook selectors:
//   'hook:user-to-agent'   — before agent execution
//   'hook:agent-to-user'   — before message frame emission
//   'hook:agent-to-tool'   — before tool execution
//   'hook:tool-to-agent'   — before tool result passed to generator
//
// Hook plugins extend BasePluginClass. Their process(next, done) method
// receives context with { source, target, message, hookContext }.
// To block: call done() with context.action = 'block'
// To modify: update context.message and call next()
//
// Also supports legacy function handlers registered via registerHook()
// by wrapping them in adapter plugin instances.
//
// Pipeline semantics match HookRunner:
//   - Handlers run in registration order
//   - 'block' stops the pipeline immediately
//   - 'modify' propagates to subsequent handlers
//   - 'redirect' stops the pipeline immediately
// =============================================================================

export class HookService {
  constructor(registry) {
    if (!registry)
      throw new Error('HookService requires a PluginRegistry');

    this._registry = registry;
  }

  // ---------------------------------------------------------------------------
  // run — Execute hook pipeline
  // ---------------------------------------------------------------------------
  // Returns: { action: 'pass'|'block'|'redirect', message, reason?, target? }
  // Same interface as HookRunner.run() for backward compatibility.
  // ---------------------------------------------------------------------------

  async run(hookName, payload) {
    // Get routing-plugin handlers for this hook selector
    let hookSelector = this._toSelector(hookName, payload);
    let plugins      = this._getPluginsForHook(hookSelector);

    // Also get legacy function handlers
    let legacyHandlers = this._registry.getHookHandlers(hookName);

    // If no handlers of any kind, pass through
    if (plugins.length === 0 && legacyHandlers.length === 0)
      return { action: 'pass', message: payload.message };

    // Build combined handler list: legacy handlers first (for compatibility),
    // then routing plugins
    let current = { ...payload };

    // Run legacy handlers first (preserves existing registration order)
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

      // If message was modified by the plugin, propagate
      if (result.message !== undefined)
        current.message = result.message;
    }

    return { action: 'pass', message: current.message };
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  _toSelector(hookName, payload) {
    let source = payload && payload.source;
    let target = payload && payload.target;

    if (source && target)
      return `hook:${source}-to-${target}`;

    return `hook:${hookName}`;
  }

  _getPluginsForHook(hookSelector) {
    let selectors = this._registry.getSelectors();
    let plugins   = [];

    for (let entry of selectors) {
      if (entry.selector === hookSelector)
        plugins.push(entry.PluginClass);
    }

    return plugins;
  }

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
