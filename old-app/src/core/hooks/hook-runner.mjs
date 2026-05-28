'use strict';

// =============================================================================
// HookRunner
// =============================================================================

/**
 * @typedef {object} HookResult
 * @property {'pass'|'block'|'modify'|'redirect'} action
 * @property {string} [message]
 * @property {string} [reason]
 * @property {string} [target]
 */

export class HookRunner {
  /**
   * @param {object} registry - PluginRegistry instance
   */
  constructor(registry) {
    if (!registry)
      throw new Error('HookRunner requires a PluginRegistry');

    /** @type {object} */
    this._registry = registry;
  }

  /**
   * Execute hook pipeline.
   * @param {string} hookName
   * @param {object} payload
   * @param {string} payload.message
   * @returns {Promise<HookResult>}
   */
  async run(hookName, payload) {
    let handlers = this._registry.getHookHandlers(hookName);

    if (!handlers.length)
      return { action: 'pass', message: payload.message };

    let current = { ...payload };

    for (let handler of handlers) {
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

    return { action: 'pass', message: current.message };
  }
}
