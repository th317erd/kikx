'use strict';

// ============================================================================
// Hero Markup Language (HML) - Server-Side Parser
// ============================================================================
// Extracts executable elements from AI response text for server-side processing.
// Display elements are left in place for frontend rendering.

// Executable element types that require server processing
const EXECUTABLE_ELEMENTS = ['websearch', 'bash', 'ask'];

/**
 * Parse attributes from an element's attribute string.
 *
 * @param {string} attrString - Raw attribute string (e.g., 'timeout="30s" cwd="/path"')
 * @returns {Object} Parsed attributes
 */
function parseAttributes(attrString) {
  if (!attrString || !attrString.trim()) return {};

  let attrs   = {};
  let pattern = /(\w+)=["']([^"']*)["']/g;
  let match;

  while ((match = pattern.exec(attrString)) !== null) {
    attrs[match[1]] = match[2];
  }

  return attrs;
}

/**
 * Extract executable elements from AI response text.
 *
 * Finds all <websearch>, <bash>, and <ask> elements and extracts them
 * for server-side execution.
 *
 * @param {string} text - AI response text with HML markup
 * @returns {Array} Array of extracted elements with metadata
 */
export function extractExecutableElements(text) {
  if (!text) return [];

  let elements = [];

  // Pattern to match executable elements: <type attrs>content</type>
  // Using a more permissive pattern that handles multi-line content
  let elementTypes = EXECUTABLE_ELEMENTS.join('|');
  let pattern      = new RegExp(
    `<(${elementTypes})([^>]*)>([\\s\\S]*?)<\\/\\1>`,
    'gi'
  );

  let match;
  while ((match = pattern.exec(text)) !== null) {
    elements.push({
      type:       match[1].toLowerCase(),
      attributes: parseAttributes(match[2]),
      content:    match[3].trim(),
      fullMatch:  match[0],
      index:      match.index,
      length:     match[0].length,
    });
  }

  return elements;
}

/**
 * Replace an element in text with a result element.
 *
 * @param {string} text - Original text
 * @param {Object} element - Element that was executed
 * @param {Object} result - Execution result
 * @returns {string} Text with element replaced by result
 */
export function replaceWithResult(text, element, result) {
  let status     = (result.success) ? 'success' : 'error';
  let resultHtml = `<result for="${element.type}" status="${status}">${escapeHtml(result.content)}</result>`;

  return text.replace(element.fullMatch, resultHtml);
}

/**
 * Replace multiple elements with their results.
 *
 * @param {string} text - Original text
 * @param {Array} results - Array of { element, result } pairs
 * @returns {string} Text with all elements replaced
 */
export function injectResults(text, results) {
  // Sort by index descending so replacements don't affect later indices
  let sorted = [...results].sort((a, b) => b.element.index - a.element.index);

  let output = text;
  for (let { element, result } of sorted) {
    output = replaceWithResult(output, element, result);
  }

  return output;
}

/**
 * Check if text contains any executable elements.
 *
 * @param {string} text - Text to check
 * @returns {boolean} True if executable elements are present
 */
export function hasExecutableElements(text) {
  if (!text) return false;

  let elementTypes = EXECUTABLE_ELEMENTS.join('|');
  let pattern      = new RegExp(`<(${elementTypes})\\b`, 'i');

  return pattern.test(text);
}

/**
 * Convert an HML element to an assertion-style object for the pipeline.
 *
 * This bridges HML elements to the existing assertion processing system.
 *
 * @param {Object} element - Parsed HML element
 * @returns {Object} Assertion-compatible object
 */
export function elementToAssertion(element) {
  switch (element.type) {
    case 'websearch':
      return {
        assertion: 'command',
        name:      'websearch',
        args:      { query: element.content, ...element.attributes },
      };

    case 'bash':
      return {
        assertion: 'command',
        name:      'bash',
        args:      { command: element.content, ...element.attributes },
      };

    case 'ask':
      return {
        assertion: 'question',
        demand:    element.attributes.demand === 'true',
        timeout:   element.attributes.timeout,
        default:   element.attributes.default,
        options:   element.attributes.options?.split(',').map((s) => s.trim()),
        message:   element.content,
      };

    default:
      return null;
  }
}

/**
 * Simple HTML escape for result content.
 */
function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export default {
  extractExecutableElements,
  replaceWithResult,
  injectResults,
  hasExecutableElements,
  elementToAssertion,
};
