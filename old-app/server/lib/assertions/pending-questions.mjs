'use strict';

// Pending questions waiting for user response
// Maps assertionId -> { resolve, reject, timeout }
const pendingQuestions = new Map();

/**
 * Store a pending question.
 *
 * @param {string} assertionId - The question's assertion ID
 * @param {function} resolve - Promise resolve function
 * @param {function} reject - Promise reject function
 */
export function setPendingQuestion(assertionId, resolve, reject) {
  pendingQuestions.set(assertionId, { resolve, reject });
}

/**
 * Get a pending question.
 *
 * @param {string} assertionId - The question's assertion ID
 * @returns {object|undefined} The pending question or undefined
 */
export function getPendingQuestion(assertionId) {
  return pendingQuestions.get(assertionId);
}

/**
 * Check if a question is pending.
 *
 * @param {string} assertionId - The question's assertion ID
 * @returns {boolean} True if question is pending
 */
export function hasPendingQuestion(assertionId) {
  return pendingQuestions.has(assertionId);
}

/**
 * Remove a pending question.
 *
 * @param {string} assertionId - The question's assertion ID
 */
export function removePendingQuestion(assertionId) {
  pendingQuestions.delete(assertionId);
}

/**
 * Handle a user's answer to a question.
 * Called from WebSocket message handler.
 *
 * @param {string} assertionId - The question's assertion ID
 * @param {string} answer - The user's answer
 * @returns {boolean} True if question was found and answered
 */
export function answerQuestion(assertionId, answer) {
  let pending = pendingQuestions.get(assertionId);

  if (!pending)
    return false;

  pending.resolve(answer);
  pendingQuestions.delete(assertionId);

  return true;
}

/**
 * Cancel a pending question.
 *
 * @param {string} assertionId - The question's assertion ID
 * @returns {boolean} True if question was found and cancelled
 */
export function cancelQuestion(assertionId) {
  let pending = pendingQuestions.get(assertionId);

  if (!pending)
    return false;

  pending.reject(new Error('Question cancelled'));
  pendingQuestions.delete(assertionId);

  return true;
}
