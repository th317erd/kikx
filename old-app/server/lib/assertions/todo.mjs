'use strict';

import { broadcastToSession } from '../websocket.mjs';

/**
 * TODO assertion handler.
 *
 * Renders a task checklist with status indicators.
 * Supports real-time updates via WebSocket.
 *
 * Item statuses: pending, in_progress, completed
 */
export default {
  name:        'assertion_todo',
  description: 'Display task checklist',

  /**
   * Execute a todo assertion.
   *
   * @param {object} assertion - The assertion object
   * @param {object} context - Rich execution context
   * @param {function} next - Middleware next function
   * @returns {Promise<any>} Continues immediately
   */
  async execute(assertion, context, next) {
    // Only handle 'todo' assertions
    if (assertion.assertion !== 'todo')
      return next(assertion);

    let { id, name, title, items, collapsed } = assertion;

    // Validate items array
    if (!Array.isArray(items)) {
      return next({
        ...assertion,
        result: { error: 'TODO assertion requires "items" array' },
      });
    }

    // Normalize items
    let validStatuses = ['pending', 'in_progress', 'completed'];
    let normalizedItems = items.map((item, index) => ({
      id:     item.id || `item-${index}`,
      text:   item.text || 'Untitled task',
      status: (validStatuses.includes(item.status)) ? item.status : 'pending',
    }));

    // Broadcast todo element to all session participants via WebSocket
    broadcastToSession(context.sessionId, {
      type:      'element_new',
      messageId: context.messageId,
      element: {
        id,
        assertion: 'todo',
        name,
        title:     title || 'Tasks',
        items:     normalizedItems,
        collapsed: collapsed || false,
      },
    });

    // Continue immediately (non-blocking)
    return next({
      ...assertion,
      result: {
        rendered:   true,
        itemCount:  normalizedItems.length,
        completed:  normalizedItems.filter((i) => i.status === 'completed').length,
        inProgress: normalizedItems.filter((i) => i.status === 'in_progress').length,
        pending:    normalizedItems.filter((i) => i.status === 'pending').length,
      },
    });
  },
};

/**
 * Helper to broadcast a TODO item status update.
 * Call this from operation handlers to update task progress.
 *
 * @param {number} sessionId - Session ID to broadcast to
 * @param {string} messageId - Message ID containing the TODO
 * @param {string} elementId - The TODO element ID
 * @param {string} itemId - The item ID to update
 * @param {string} status - New status (pending, in_progress, completed)
 */
export function updateTodoItem(sessionId, messageId, elementId, itemId, status) {
  broadcastToSession(sessionId, {
    type:      'todo_item_update',
    messageId,
    elementId,
    itemId,
    status,
  });
}
