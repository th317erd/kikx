'use strict';

import { broadcastToSession } from '../websocket.mjs';

/**
 * Progress assertion handler.
 *
 * Renders a progress bar with percentage and optional status text.
 * Supports real-time updates via WebSocket.
 */
export default {
  name:        'assertion_progress',
  description: 'Show progress indicator',

  /**
   * Execute a progress assertion.
   *
   * @param {object} assertion - The assertion object
   * @param {object} context - Rich execution context
   * @param {function} next - Middleware next function
   * @returns {Promise<any>} Continues immediately
   */
  async execute(assertion, context, next) {
    // Only handle 'progress' assertions
    if (assertion.assertion !== 'progress')
      return next(assertion);

    let { id, name, percentage, label, status } = assertion;

    // Normalize percentage to 0-100
    let normalizedPercentage = Math.max(0, Math.min(100, Number(percentage) || 0));

    // Broadcast progress element to all session participants via WebSocket
    broadcastToSession(context.sessionId, {
      type:      'element_new',
      messageId: context.messageId,
      element: {
        id,
        assertion:  'progress',
        name,
        percentage: normalizedPercentage,
        label:      label || 'Progress',
        status:     status || '',
      },
    });

    // Continue immediately (non-blocking)
    return next({
      ...assertion,
      result: { rendered: true, percentage: normalizedPercentage },
    });
  },
};

/**
 * Helper to broadcast a progress update.
 * Call this from operation handlers to update progress.
 *
 * @param {number} sessionId - Session ID to broadcast to
 * @param {string} messageId - Message ID containing the progress
 * @param {string} elementId - The progress element ID
 * @param {object} updates - Fields to update (percentage, label, status)
 */
export function updateProgress(sessionId, messageId, elementId, updates) {
  broadcastToSession(sessionId, {
    type:      'element_update',
    messageId,
    elementId,
    updates: {
      percentage: updates.percentage !== undefined
        ? Math.max(0, Math.min(100, Number(updates.percentage)))
        : undefined,
      label:  updates.label,
      status: updates.status,
    },
  });
}
