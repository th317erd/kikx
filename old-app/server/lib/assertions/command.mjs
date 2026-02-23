'use strict';

import { callSystemMethod, getSystemMethod } from '../interactions/functions/system.mjs';

/**
 * Command assertion handler.
 *
 * Executes the named command/function via the InteractionBus.
 * This handler routes to @system methods.
 */
export default {
  name:        'assertion_command',
  description: 'Execute a command/function via InteractionBus',

  /**
   * Execute a command assertion.
   *
   * @param {object} assertion - The assertion object { id, assertion, name, message }
   * @param {object} context - Rich execution context
   * @param {function} next - Middleware next function
   * @returns {Promise<any>} The command result
   */
  async execute(assertion, context, next) {
    // Only handle 'command' assertions
    if (assertion.assertion !== 'command')
      return next(assertion);

    // Check if system method exists
    let method = getSystemMethod(assertion.name);

    if (!method) {
      // No method found for this command name
      let result = {
        error:   true,
        message: `Unknown command: ${assertion.name}`,
      };

      return next({ ...assertion, result });
    }

    try {
      // Execute via InteractionBus
      let result = await callSystemMethod(assertion.name, {
        message: assertion.message,
        ...assertion,
      }, {
        sessionId: context.sessionId,
        userId:    context.userId,
      });

      // Attach result and continue
      return next({ ...assertion, result });

    } catch (error) {
      // Method threw an error
      let result = {
        error:   true,
        message: error.message,
      };

      return next({ ...assertion, result });
    }
  },
};
