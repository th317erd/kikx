'use strict';

import { BasePluginClass } from '../../routing/base-plugin-class.mjs';

// =============================================================================
// Hooks Plugin (Infrastructure)
// =============================================================================
// Demonstrates hook-as-routing-plugin pattern. Provides base classes for
// hook plugins that intercept message flow at specific lifecycle points.
//
// Hook selectors:
//   'hook:user-to-agent'  — intercept user messages before agent execution
//   'hook:agent-to-user'  — intercept agent messages before frame emission
//   'hook:agent-to-tool'  — intercept tool calls before execution
//   'hook:tool-to-agent'  — intercept tool results before agent receives them
//
// Plugin developers create subclasses and register them via registerSelector().
// The HookService invokes matched plugins during InteractionLoop processing.
//
// Example usage (in a plugin's setup function):
//   class MyHook extends BasePluginClass {
//     async process(next, done) {
//       // Modify the message
//       this.context.message = this.context.message.toUpperCase();
//       return await next(this.context);
//
//       // Or block:
//       // this.context.action = 'block';
//       // this.context.reason = 'Not allowed';
//       // return await done(this.context);
//     }
//   }
//   registerSelector('hook:user-to-agent', MyHook);
// =============================================================================

// No internal hooks are registered by default — this module provides
// the infrastructure. External plugins register their own hooks via
// registerSelector() with hook:* selectors.

export function setup() {
  // Infrastructure-only — no default registrations
}
