'use strict';

// ============================================================================
// Hero Markup Language (HML) - Executor
// ============================================================================
// Processes HML elements extracted from AI responses through the assertion pipeline.

import { v4 as uuidv4 } from 'uuid';
import { extractExecutableElements, elementToAssertion, injectResults, hasExecutableElements } from './parser.mjs';
import { executePipeline } from '../pipeline/index.mjs';

/**
 * Process text containing HML elements.
 *
 * Extracts executable elements, runs them through the pipeline,
 * and returns text with results injected.
 *
 * @param {string} text - AI response text with HML elements
 * @param {Object} context - Execution context (session, user, etc.)
 * @param {Object} callbacks - Optional callbacks for state updates
 * @returns {Promise<Object>} { text, results }
 */
export async function processMarkup(text, context, callbacks = {}) {
  // Extract executable elements
  let elements = extractExecutableElements(text);

  if (elements.length === 0) {
    return { text, results: [], modified: false };
  }

  // Convert elements to assertions
  let assertions = [];
  for (let element of elements) {
    let assertion = elementToAssertion(element);

    if (assertion) {
      assertion.id      = uuidv4();
      assertion.element = element; // Keep reference to original element
      assertions.push(assertion);
    }
  }

  if (assertions.length === 0) {
    return { text, results: [], modified: false };
  }

  // Execute assertions through the pipeline
  let operationBlock = {
    mode:       'sequential',
    assertions: assertions,
  };

  let pipelineResults = await executePipeline(operationBlock, context, callbacks);

  // Map results back to elements
  let resultPairs = [];
  for (let assertion of assertions) {
    let pipelineResult = pipelineResults.results?.find((r) => r.id === assertion.id);
    let result         = pipelineResult?.result || { success: false, content: 'Execution failed' };

    // Normalize result format
    if (typeof result === 'string') {
      result = { success: true, content: result };
    } else if (result.error) {
      result = { success: false, content: result.message || result.error };
    } else if (!result.hasOwnProperty('success')) {
      result = { success: true, content: JSON.stringify(result) };
    }

    resultPairs.push({
      element: assertion.element,
      result:  result,
    });
  }

  // Inject results back into text
  let processedText = injectResults(text, resultPairs);

  return {
    text:     processedText,
    results:  resultPairs,
    modified: true,
  };
}

/**
 * Process text and emit real-time updates via WebSocket.
 *
 * @param {string} text - AI response text with HML elements
 * @param {Object} context - Execution context
 * @param {function} broadcast - Function to broadcast WebSocket messages
 * @returns {Promise<Object>} { text, results, modified }
 */
export async function processMarkupWithBroadcast(text, context, broadcast) {
  let callbacks = {
    onAssertionStart: (assertion) => {
      broadcast({
        type:        'hml:element:start',
        elementType: assertion.element?.type,
        elementId:   assertion.id,
      });
    },

    onAssertionComplete: (assertion, result) => {
      broadcast({
        type:        'hml:element:complete',
        elementType: assertion.element?.type,
        elementId:   assertion.id,
        result:      result,
      });
    },

    onAssertionError: (assertion, error) => {
      broadcast({
        type:        'hml:element:error',
        elementType: assertion.element?.type,
        elementId:   assertion.id,
        error:       error.message,
      });
    },
  };

  return processMarkup(text, context, callbacks);
}

/**
 * Check if text contains executable HML elements.
 * Re-exported from parser for convenience.
 */
export { hasExecutableElements };

export default {
  processMarkup,
  processMarkupWithBroadcast,
  hasExecutableElements,
};
