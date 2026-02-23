'use strict';

import { broadcastToSession } from '../websocket.mjs';

/**
 * Thinking assertion handler.
 *
 * Displays a thinking/processing status to the user via WebSocket.
 * This is non-blocking - it sends the status and continues immediately.
 */
export default {
  name:        'assertion_thinking',
  description: 'Show processing status',

  /**
   * Execute a thinking assertion.
   *
   * @param {object} assertion - The assertion object
   * @param {object} context - Rich execution context
   * @param {function} next - Middleware next function
   * @returns {Promise<any>} Continues immediately
   */
  async execute(assertion, context, next) {
    // Only handle 'thinking' assertions
    if (assertion.assertion !== 'thinking')
      return next(assertion);

    let { id, name, message } = assertion;

    // Broadcast thinking status to user via WebSocket
    broadcastToSession(context.sessionId, {
      type:        'assertion_update',
      messageId:   context.messageId,
      assertionId: id,
      assertion:   'thinking',
      name:        name,
      status:      'running',
      preview:     message,
    });

    // Continue immediately (non-blocking)
    return next({
      ...assertion,
      result: { displayed: true },
    });
  },
};
