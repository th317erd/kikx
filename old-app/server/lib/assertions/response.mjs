'use strict';

import { broadcastToSession } from '../websocket.mjs';

/**
 * Response assertion handler.
 *
 * Displays a message to the user via WebSocket.
 * This is non-blocking - it sends the message and continues immediately.
 */
export default {
  name:        'assertion_response',
  description: 'Display message to user',

  /**
   * Execute a response assertion.
   *
   * @param {object} assertion - The assertion object
   * @param {object} context - Rich execution context
   * @param {function} next - Middleware next function
   * @returns {Promise<any>} Continues immediately
   */
  async execute(assertion, context, next) {
    // Only handle 'response' assertions
    if (assertion.assertion !== 'response')
      return next(assertion);

    let { id, name, message } = assertion;

    // Broadcast message to user via WebSocket
    broadcastToSession(context.sessionId, {
      type:        'message_append',
      messageId:   context.messageId,
      assertionId: id,
      name:        name,
      content:     message,
    });

    // Continue immediately (non-blocking)
    return next({
      ...assertion,
      result: { sent: true },
    });
  },
};
