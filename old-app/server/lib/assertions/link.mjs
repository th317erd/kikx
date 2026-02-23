'use strict';

import { broadcastToSession } from '../websocket.mjs';

/**
 * Link assertion handler.
 *
 * Renders a clickable link with three modes:
 * - external: Opens URL in new tab
 * - internal: Scrolls to another message
 * - clipboard: Copies text to clipboard
 */
export default {
  name:        'assertion_link',
  description: 'Render clickable link',

  /**
   * Execute a link assertion.
   *
   * @param {object} assertion - The assertion object
   * @param {object} context - Rich execution context
   * @param {function} next - Middleware next function
   * @returns {Promise<any>} Continues immediately
   */
  async execute(assertion, context, next) {
    // Only handle 'link' assertions
    if (assertion.assertion !== 'link')
      return next(assertion);

    let { id, name, mode, url, messageId, text, label } = assertion;

    // Validate mode and required fields
    let validModes = ['external', 'internal', 'clipboard'];

    if (!validModes.includes(mode)) {
      return next({
        ...assertion,
        result: { error: `Invalid link mode. Valid modes: ${validModes.join(', ')}` },
      });
    }

    if (mode === 'external' && !url) {
      return next({
        ...assertion,
        result: { error: 'External link requires "url" field' },
      });
    }

    if (mode === 'internal' && !messageId) {
      return next({
        ...assertion,
        result: { error: 'Internal link requires "messageId" field' },
      });
    }

    if (mode === 'clipboard' && !text) {
      return next({
        ...assertion,
        result: { error: 'Clipboard link requires "text" field' },
      });
    }

    // Broadcast link element to user via WebSocket
    broadcastToSession(context.sessionId, {
      type:        'element_new',
      messageId:   context.messageId,
      element: {
        id,
        assertion: 'link',
        name,
        mode,
        url,
        messageId,
        text,
        label: label || ((mode === 'clipboard') ? 'Copy to clipboard' : (url || messageId)),
      },
    });

    // Continue immediately (non-blocking)
    return next({
      ...assertion,
      result: { rendered: true, mode },
    });
  },
};
