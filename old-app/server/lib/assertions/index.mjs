'use strict';

// Import assertion handlers
import commandHandler from './command.mjs';
import questionHandler from './question.mjs';
import responseHandler from './response.mjs';
import thinkingHandler from './thinking.mjs';

// Import element assertion handlers
import linkHandler from './link.mjs';
import todoHandler from './todo.mjs';
import progressHandler from './progress.mjs';

// Assertion handlers registry (local, for markup processing)
const assertionHandlers = new Map();

// Register all assertion handlers
assertionHandlers.set('command', commandHandler);
assertionHandlers.set('link', linkHandler);
assertionHandlers.set('progress', progressHandler);
assertionHandlers.set('question', questionHandler);
assertionHandlers.set('response', responseHandler);
assertionHandlers.set('thinking', thinkingHandler);
assertionHandlers.set('todo', todoHandler);

/**
 * Get an assertion handler by type.
 *
 * @param {string} type - Assertion type
 * @returns {Object|null} Handler or null
 */
export function getAssertionHandlerByType(type) {
  return assertionHandlers.get(type) || null;
}

/**
 * Get all registered assertion handlers.
 *
 * @returns {Array} All handlers
 */
export function getAllAssertionHandlers() {
  return Array.from(assertionHandlers.values());
}

/**
 * Assertion types and their behaviors.
 */
export const ASSERTION_TYPES = {
  command:  'command',   // Execute a function/plugin
  question: 'question',  // Prompt user for input
  response: 'response',  // Display message to user
  thinking: 'thinking',  // Show processing status
  stream:   'stream',    // Real-time output stream

  // Interactive elements
  link:     'link',      // Render clickable link
  todo:     'todo',      // Display task checklist
  progress: 'progress',  // Show progress indicator
};

/**
 * Assertion type descriptions for help system.
 */
export const ASSERTION_DESCRIPTIONS = {
  command:  'Execute a command or function',
  question: 'Prompt user for input',
  response: 'Display message to user',
  thinking: 'Show processing status',
  stream:   'Real-time output stream',
  link:     'Render clickable link (external, internal, or clipboard)',
  todo:     'Display task checklist with status updates',
  progress: 'Show progress indicator with percentage',
};

/**
 * Get handler for an assertion type.
 *
 * @param {string} assertionType - The assertion type
 * @returns {object|null} The handler or null
 */
export function getAssertionHandler(assertionType) {
  switch (assertionType) {
    case 'command':
      return commandHandler;
    case 'question':
      return questionHandler;
    case 'response':
      return responseHandler;
    case 'thinking':
      return thinkingHandler;
    case 'link':
      return linkHandler;
    case 'todo':
      return todoHandler;
    case 'progress':
      return progressHandler;
    default:
      return null;
  }
}

/**
 * Get all assertion types with descriptions.
 *
 * @returns {Array<{type: string, description: string}>}
 */
export function getAllAssertionTypes() {
  return Object.entries(ASSERTION_TYPES).map(([key, type]) => ({
    type,
    description: ASSERTION_DESCRIPTIONS[key] || type,
  }));
}

export default {
  ASSERTION_TYPES,
  ASSERTION_DESCRIPTIONS,
  getAssertionHandler,
  getAllAssertionTypes,
};
