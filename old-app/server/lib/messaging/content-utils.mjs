'use strict';

// ============================================================================
// Content Utilities
// ============================================================================
// Pure utility functions for content processing shared between
// messages.mjs and messages-stream.mjs routes.

import { getRegisteredFunctionClass } from '../interactions/index.mjs';

/**
 * Deduplicate consecutive identical paragraphs.
 * Claude sometimes repeats text before and after interaction tags.
 *
 * @param {string} text - Text to deduplicate
 * @returns {string} Text with duplicate paragraphs removed
 */
export function deduplicateParagraphs(text) {
  if (!text) return text;

  let paragraphs = text.split(/\n\n+/);
  let seen       = new Set();
  let result     = [];

  for (let para of paragraphs) {
    let trimmed = para.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      result.push(para);
    }
  }

  return result.join('\n\n');
}

/**
 * Strip <interaction> tags and their content from text.
 * Returns the cleaned text with tags removed and duplicates removed.
 *
 * @param {string} text - Text potentially containing <interaction> tags
 * @returns {string} Text with interaction tags removed
 */
export function stripInteractionTags(text) {
  if (!text) return text;

  // Match <interaction>...</interaction> including content (with or without attributes)
  // Uses non-greedy match and handles multiline
  let result = text.replace(/<interaction(?:\s[^>]*)?>[\s\S]*?<\/interaction>/g, '');

  // Clean up extra whitespace left behind
  result = result.replace(/\n{3,}/g, '\n\n').trim();

  // Deduplicate paragraphs (Claude sometimes repeats text before/after interaction)
  result = deduplicateParagraphs(result);

  return result;
}

/**
 * Replace <interaction> tags with explanatory notes for the AI.
 * This prevents the AI from trying to duplicate interactions that were already handled.
 *
 * For update_prompt interactions: replaces with a note saying the prompt was already updated
 * For other interactions: strips them entirely (they were already executed)
 *
 * @param {string} text - Text potentially containing <interaction> tags
 * @returns {string} Text with interaction tags replaced/removed
 */
export function replaceInteractionTagsWithNote(text) {
  if (!text) return text;

  // Check if this contains an update_prompt interaction
  let hasUpdatePrompt = /<interaction(?:\s[^>]*)?>[\s\S]*?"target_property":\s*"update_prompt"[\s\S]*?<\/interaction>/i.test(text);

  if (hasUpdatePrompt) {
    // Replace update_prompt interaction with a note
    let result = text.replace(
      /<interaction(?:\s[^>]*)?>[\s\S]*?<\/interaction>/g,
      '\n\n[System: This prompt answer was submitted via the inline input and has already been processed. Do NOT send an update_prompt interaction - the prompt is already updated.]'
    );
    return result.replace(/\n{3,}/g, '\n\n').trim();
  }

  // For other interactions, just strip them
  return stripInteractionTags(text);
}

/**
 * Check if content is ONLY interaction tags (no visible text).
 * Used to mark such messages as hidden.
 *
 * @param {string} text - Text to check
 * @returns {boolean} True if content is only interaction tags
 */
export function isInteractionOnly(text) {
  if (!text) return true;

  let stripped = stripInteractionTags(text);
  return stripped.trim().length === 0;
}

/**
 * Convert raw API error messages to user-friendly messages.
 */
export function getFriendlyErrorMessage(rawMessage) {
  if (!rawMessage) return 'An unexpected error occurred. Please try again.';

  // Rate limit errors
  if (rawMessage.includes('429') || rawMessage.includes('rate_limit')) {
    return 'The AI service is currently busy. Please wait a moment and try again.';
  }

  // Authentication errors
  if (rawMessage.includes('401') || rawMessage.includes('authentication') || rawMessage.includes('invalid_api_key')) {
    return 'There was an authentication issue with the AI service. Please check your API key.';
  }

  // Overloaded errors
  if (rawMessage.includes('overloaded') || rawMessage.includes('529')) {
    return 'The AI service is temporarily overloaded. Please try again in a few moments.';
  }

  // Timeout errors
  if (rawMessage.includes('timeout') || rawMessage.includes('ETIMEDOUT')) {
    return 'The request timed out. Please try again.';
  }

  // Network errors
  if (rawMessage.includes('ECONNREFUSED') || rawMessage.includes('network')) {
    return 'Unable to connect to the AI service. Please check your connection.';
  }

  // Generic - don't expose raw JSON/technical details
  if (rawMessage.includes('{') || rawMessage.length > 200) {
    return 'An error occurred while processing your request. Please try again.';
  }

  return rawMessage;
}

/**
 * Get the banner config for a function by name.
 * Returns null if the function doesn't have a banner config.
 *
 * @param {string} functionName - The function name (targetProperty)
 * @returns {Object|null} Banner config or null
 */
export function getFunctionBannerConfig(functionName) {
  let FunctionClass = getRegisteredFunctionClass(functionName);
  if (!FunctionClass) return null;

  try {
    let reg = FunctionClass.register();
    return reg.banner || null;
  } catch {
    return null;
  }
}

/**
 * Convert HML element to assertion format for pipeline execution.
 * Note: websearch is handled by the interaction system, not HML pipeline.
 */
export function elementToAssertion(element) {
  switch (element.type) {
    case 'websearch':
      // Websearch is handled by the interaction system via <interaction> tags,
      // not through HML element execution. Return null to skip pipeline execution.
      return null;

    case 'bash':
      return {
        id:        element.id,
        assertion: 'command',
        name:      'bash',
        message:   element.content,
        ...element.attributes,
      };

    case 'ask':
      return {
        id:        element.id,
        assertion: 'question',
        name:      'ask',
        message:   element.content,
        mode:      (element.attributes.timeout) ? 'timeout' : 'demand',
        timeout:   (element.attributes.timeout) ? parseInt(element.attributes.timeout, 10) * 1000 : undefined,
        default:   element.attributes.default,
        options:   element.attributes.options?.split(',').map((s) => s.trim()),
      };

    default:
      return null;
  }
}
