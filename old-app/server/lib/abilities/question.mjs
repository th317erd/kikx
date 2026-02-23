'use strict';

// ============================================================================
// Universal Question System
// ============================================================================
// Handles asking users questions with different answer types.

import { randomUUID } from 'crypto';
import { broadcastToSession } from '../websocket.mjs';

// In-memory pending questions (questionId -> resolver)
const pendingQuestions = new Map();

/**
 * Question type validators and coercers.
 */
const questionTypes = {
  binary: {
    validate: (value) => typeof value === 'boolean' || value === 'true' || value === 'false' || value === 1 || value === 0,
    coerce:   (value) => value === true || value === 'true' || value === 1,
  },

  number: {
    validate: (value, options) => {
      let num = parseInt(value, 10);
      if (isNaN(num)) return false;
      if (options.min !== undefined && num < options.min) return false;
      if (options.max !== undefined && num > options.max) return false;
      return true;
    },
    coerce: (value) => parseInt(value, 10),
  },

  float: {
    validate: (value, options) => {
      let num = parseFloat(value);
      if (isNaN(num)) return false;
      if (options.min !== undefined && num < options.min) return false;
      if (options.max !== undefined && num > options.max) return false;
      return true;
    },
    coerce: (value) => parseFloat(value),
  },

  string: {
    validate: (value, options) => {
      if (typeof value !== 'string') return false;
      if (options.minLength !== undefined && value.length < options.minLength) return false;
      if (options.maxLength !== undefined && value.length > options.maxLength) return false;
      if (options.pattern && !new RegExp(options.pattern).test(value)) return false;
      return true;
    },
    coerce: (value) => String(value),
  },
};

/**
 * Ask the user a question and wait for a response.
 *
 * @param {string} prompt - The question to ask
 * @param {Object} options - Question options
 * @param {string} [options.type='string'] - Answer type: binary, number, float, string
 * @param {Array} [options.choices] - Choices for selection (for binary or string)
 * @param {*} [options.defaultValue] - Default value if timeout
 * @param {number} [options.timeout=0] - Timeout in ms (0 = wait forever)
 * @param {number} [options.min] - Minimum value (for number/float)
 * @param {number} [options.max] - Maximum value (for number/float)
 * @param {number} [options.minLength] - Minimum length (for string)
 * @param {number} [options.maxLength] - Maximum length (for string)
 * @param {string} [options.pattern] - Regex pattern (for string)
 * @param {Object} context - Execution context
 * @param {number} context.userId - User ID
 * @param {number} [context.sessionId] - Session ID
 * @returns {Promise<*>} The answer value
 */
export async function askQuestion(prompt, options, context) {
  let questionId = randomUUID();

  let {
    type         = 'string',
    choices      = null,
    defaultValue = null,
    timeout      = 0,
    min          = undefined,
    max          = undefined,
    minLength    = undefined,
    maxLength    = undefined,
    pattern      = undefined,
  } = options;

  // Validate question type
  if (!questionTypes[type])
    throw new Error(`Invalid question type: ${type}`);

  // Broadcast question to all session participants via WebSocket
  broadcastToSession(context.sessionId, {
    type:         'ability_question',
    questionId:   questionId,
    questionType: type,
    prompt:       prompt,
    choices:      choices,
    defaultValue: defaultValue,
    timeout:      timeout,
    min:          min,
    max:          max,
    minLength:    minLength,
    maxLength:    maxLength,
    pattern:      pattern,
    sessionId:    context.sessionId,
  });

  // Wait for answer
  return new Promise((resolve) => {
    pendingQuestions.set(questionId, {
      resolve,
      type,
      options: { min, max, minLength, maxLength, pattern },
      defaultValue,
    });

    // Set timeout if specified
    if (timeout > 0) {
      setTimeout(() => {
        if (pendingQuestions.has(questionId)) {
          pendingQuestions.delete(questionId);

          // Broadcast timeout notification to all session participants
          broadcastToSession(context.sessionId, {
            type:       'ability_question_timeout',
            questionId: questionId,
            sessionId:  context.sessionId,
          });

          resolve(defaultValue);
        }
      }, timeout);
    }
  });
}

/**
 * Handle a question answer from the user.
 *
 * @param {string} questionId - The question ID
 * @param {*} answer - The answer value
 * @returns {boolean} True if answer was accepted
 */
export function handleQuestionAnswer(questionId, answer) {
  let pending = pendingQuestions.get(questionId);

  if (!pending)
    return false; // Unknown or already answered

  let { resolve, type, options } = pending;
  let handler = questionTypes[type];

  // Validate answer
  if (!handler.validate(answer, options)) {
    // Invalid answer - could notify user, but for now just reject
    return false;
  }

  pendingQuestions.delete(questionId);

  // Coerce and resolve
  let coercedAnswer = handler.coerce(answer);
  resolve(coercedAnswer);

  return true;
}

/**
 * Cancel a pending question.
 *
 * @param {string} questionId - The question ID
 * @param {*} [fallbackValue] - Value to resolve with
 */
export function cancelQuestion(questionId, fallbackValue = null) {
  let pending = pendingQuestions.get(questionId);

  if (!pending)
    return;

  pendingQuestions.delete(questionId);
  pending.resolve((fallbackValue !== null) ? fallbackValue : pending.defaultValue);
}

/**
 * Check if a question is pending.
 *
 * @param {string} questionId - The question ID
 * @returns {boolean} True if pending
 */
export function isQuestionPending(questionId) {
  return pendingQuestions.has(questionId);
}

/**
 * Get all pending question IDs.
 *
 * @returns {string[]} Array of question IDs
 */
export function getPendingQuestionIds() {
  return Array.from(pendingQuestions.keys());
}

/**
 * Shortcut: Ask a yes/no question.
 *
 * @param {string} prompt - The question
 * @param {Object} context - Execution context
 * @param {boolean} [defaultValue=false] - Default if timeout
 * @param {number} [timeout=0] - Timeout in ms
 * @returns {Promise<boolean>} The answer
 */
export async function askYesNo(prompt, context, defaultValue = false, timeout = 0) {
  return askQuestion(prompt, {
    type:    'binary',
    choices: ['Yes', 'No'],
    defaultValue,
    timeout,
  }, context);
}

/**
 * Shortcut: Ask for a number.
 *
 * @param {string} prompt - The question
 * @param {Object} context - Execution context
 * @param {Object} [options] - Additional options
 * @returns {Promise<number>} The answer
 */
export async function askNumber(prompt, context, options = {}) {
  return askQuestion(prompt, { type: 'number', ...options }, context);
}

/**
 * Shortcut: Ask for text input.
 *
 * @param {string} prompt - The question
 * @param {Object} context - Execution context
 * @param {Object} [options] - Additional options
 * @returns {Promise<string>} The answer
 */
export async function askText(prompt, context, options = {}) {
  return askQuestion(prompt, { type: 'string', ...options }, context);
}

export default {
  askQuestion,
  handleQuestionAnswer,
  cancelQuestion,
  isQuestionPending,
  getPendingQuestionIds,
  askYesNo,
  askNumber,
  askText,
};
