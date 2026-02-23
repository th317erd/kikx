'use strict';

// ============================================================================
// Debug Utilities
// ============================================================================

/**
 * Check if debug mode is enabled.
 * @returns {boolean}
 */
function isDebugEnabled() {
  return sessionStorage.getItem('debug') === 'true';
}

/**
 * Enable or disable debug mode.
 * @param {boolean} enabled
 */
function setDebug(enabled) {
  if (enabled) {
    sessionStorage.setItem('debug', 'true');
    console.log('[Debug] Debug mode ENABLED. Use setDebug(false) to disable.');
  } else {
    sessionStorage.removeItem('debug');
    console.log('[Debug] Debug mode DISABLED.');
  }
}

/**
 * Log a debug message (only if debug mode is enabled).
 * @param {string} category - Category/module name
 * @param {...any} args - Arguments to log
 */
function debug(category, ...args) {
  if (isDebugEnabled())
    console.log(`[${category}]`, ...args);
}

// Expose setDebug globally for console access
window.setDebug = setDebug;

// ============================================================================
// Utilities
// ============================================================================

function escapeHtml(text) {
  let div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Strip <interaction> tags and their content from text.
 */
function stripInteractionTags(text) {
  if (!text) return text;
  let result = text.replace(/<interaction>[\s\S]*?<\/interaction>/g, '');
  return result.replace(/\n{3,}/g, '\n\n').trim();
}

function autoResizeTextarea(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = Math.min(textarea.scrollHeight, 150) + 'px';
}

function formatRelativeDate(dateString) {
  let date    = new Date(dateString);
  let now     = new Date();
  let diffMs  = now - date;
  let diffMin = Math.floor(diffMs / 60000);
  let diffDay = Math.floor(diffMs / 86400000);

  // "just now" only for first 5 minutes
  if (diffMin < 5)
    return 'just now';

  // After 5 minutes, show human readable time
  let timeStr = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  // Today: just show time
  if (diffDay < 1 && date.getDate() === now.getDate())
    return timeStr;

  // Yesterday
  if (diffDay < 2 && date.getDate() === now.getDate() - 1)
    return `yesterday ${timeStr}`;

  // Within a week: show day name
  if (diffDay < 7) {
    let dayName = date.toLocaleDateString([], { weekday: 'short' });
    return `${dayName} ${timeStr}`;
  }

  // Older: show date
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ` ${timeStr}`;
}

// ============================================================================
// Cost Utilities
// ============================================================================

/**
 * Format a token count for human display.
 * @param {number} tokens - Token count
 * @returns {string} Formatted string (e.g., "1.2k", "15k")
 */
function formatTokenCount(tokens) {
  if (tokens < 1000) {
    return tokens.toString();
  } else if (tokens < 10000) {
    return (tokens / 1000).toFixed(1) + 'k';
  } else {
    return Math.round(tokens / 1000) + 'k';
  }
}

/**
 * Calculate API cost from token counts.
 * Claude Sonnet 4 pricing: $3/1M input, $15/1M output
 * @param {number} inputTokens - Input token count
 * @param {number} outputTokens - Output token count
 * @returns {number} Cost in dollars
 */
function calculateCost(inputTokens, outputTokens) {
  let inputCost  = (inputTokens / 1_000_000) * 3;    // $3 per 1M input
  let outputCost = (outputTokens / 1_000_000) * 15;  // $15 per 1M output
  return inputCost + outputCost;
}

/**
 * Format cost for display.
 * @param {number} cost - Cost in dollars
 * @returns {string} Formatted string (e.g., "$0.00", "$0.02", "$1.45")
 */
function formatCost(cost) {
  return '$' + cost.toFixed(2);
}
