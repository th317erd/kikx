'use strict';

import { broadcastToSession } from '../websocket.mjs';
import {
  setPendingQuestion,
  hasPendingQuestion,
  removePendingQuestion,
} from './pending-questions.mjs';

// Re-export answer/cancel functions for convenience
export { answerQuestion, cancelQuestion } from './pending-questions.mjs';

/**
 * Question assertion handler.
 *
 * Prompts the user for input via WebSocket.
 *
 * Supports two modes:
 * - "demand": Wait forever until user responds (default)
 * - "timeout": Wait for specified time, then use default value
 *
 * For timeout mode, a default value MUST be provided.
 */
export default {
  name:        'assertion_question',
  description: 'Prompt user for input',

  /**
   * Execute a question assertion.
   *
   * @param {object} assertion - The assertion object
   * @param {object} context - Rich execution context
   * @param {function} next - Middleware next function
   * @returns {Promise<any>} The user's answer
   */
  async execute(assertion, context, next) {
    // Only handle 'question' assertions
    if (assertion.assertion !== 'question')
      return next(assertion);

    let {
      id,
      name,
      message,
      mode     = 'demand',   // 'demand' (wait forever) or 'timeout' (with default)
      timeout  = 30000,      // Default 30s timeout for timeout mode
      options  = null,       // Optional predefined answers
    } = assertion;

    // Default value - REQUIRED for timeout mode
    let defaultValue = assertion.default;

    // Validate timeout mode has a default
    if (mode === 'timeout' && defaultValue === undefined) {
      console.warn(`Question "${id}" is in timeout mode but has no default value. Using empty string.`);
      defaultValue = '';
    }

    // Broadcast question to user via WebSocket
    broadcastToSession(context.sessionId, {
      type:        'question_prompt',
      messageId:   context.messageId,
      assertionId: id,
      question:    message,
      options:     options,
      mode:        mode,
      timeout:     (mode === 'timeout') ? timeout : 0,
      default:     defaultValue,
    });

    // Create promise that resolves when user answers
    let answer = await new Promise((resolve, reject) => {
      // Store resolver for this question
      setPendingQuestion(id, resolve, reject);

      // Set up timeout only for timeout mode
      if (mode === 'timeout' && timeout > 0) {
        setTimeout(() => {
          if (hasPendingQuestion(id)) {
            removePendingQuestion(id);
            // Timeout mode - resolve with default value
            resolve(defaultValue);
          }
        }, timeout);
      }
      // For demand mode, we wait forever (no timeout)
    });

    // Clean up
    removePendingQuestion(id);

    // Attach answer and continue
    return next({
      ...assertion,
      result: { answer },
    });
  },
};
