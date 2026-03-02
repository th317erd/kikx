'use strict';

// =============================================================================
// HookRunner
// =============================================================================
// Executes registered hook handlers in pipeline order.
// Each handler receives a payload and returns an action result:
//   - { action: 'pass' }     — continue with no changes
//   - { action: 'modify', message }  — replace message and continue
//   - { action: 'block', reason }    — stop pipeline, block the message
//   - { action: 'redirect', target, message } — redirect message
//   - null/undefined          — treated as pass-through
//
// Pipeline semantics:
//   - Handlers run in registration order
//   - 'modify' propagates to subsequent handlers
//   - 'block' stops the pipeline immediately
//   - 'redirect' stops the pipeline immediately
// =============================================================================

export class HookRunner {
  constructor(registry) {
    if (!registry)
      throw new Error('HookRunner requires a PluginRegistry');

    this._registry = registry;
  }

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
