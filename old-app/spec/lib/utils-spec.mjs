'use strict';

// ============================================================================
// Utility Functions Tests
// ============================================================================
// Tests for public/js/utils.js functions

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createDOM, destroyDOM, getDocument, getWindow } from '../helpers/dom-helpers.mjs';

// ============================================================================
// Test Setup - Mock the utility functions (they're in browser JS)
// ============================================================================

// escapeHtml implementation
function escapeHtml(text) {
  const doc = getDocument();
  const div = doc.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// stripInteractionTags implementation
function stripInteractionTags(text) {
  if (!text) return text;
  let result = text.replace(/<interaction>[\s\S]*?<\/interaction>/g, '');
  return result.replace(/\n{3,}/g, '\n\n').trim();
}

// formatTokenCount implementation
function formatTokenCount(tokens) {
  if (tokens < 1000) {
    return tokens.toString();
  } else if (tokens < 10000) {
    return (tokens / 1000).toFixed(1) + 'k';
  } else {
    return Math.round(tokens / 1000) + 'k';
  }
}

// calculateCost implementation
function calculateCost(inputTokens, outputTokens) {
  let inputCost  = (inputTokens / 1_000_000) * 3;
  let outputCost = (outputTokens / 1_000_000) * 15;
  return inputCost + outputCost;
}

// formatCost implementation
function formatCost(cost) {
  return '$' + cost.toFixed(2);
}

// formatRelativeDate implementation (simplified for testing)
function formatRelativeDate(dateString, now = new Date()) {
  let date    = new Date(dateString);
  let diffMs  = now - date;
  let diffMin = Math.floor(diffMs / 60000);
  let diffDay = Math.floor(diffMs / 86400000);

  if (diffMin < 5)
    return 'just now';

  let timeStr = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  if (diffDay < 1 && date.getDate() === now.getDate())
    return timeStr;

  if (diffDay < 2 && date.getDate() === now.getDate() - 1)
    return `yesterday ${timeStr}`;

  if (diffDay < 7) {
    let dayName = date.toLocaleDateString([], { weekday: 'short' });
    return `${dayName} ${timeStr}`;
  }

  return date.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ` ${timeStr}`;
}

// ============================================================================
// Tests: escapeHtml
// ============================================================================

describe('escapeHtml', () => {
  beforeEach(() => createDOM());
  afterEach(() => destroyDOM());

  it('should escape HTML special characters', () => {
    assert.strictEqual(escapeHtml('<script>alert("xss")</script>'), '&lt;script&gt;alert("xss")&lt;/script&gt;');
  });

  it('should escape ampersands', () => {
    assert.strictEqual(escapeHtml('Tom & Jerry'), 'Tom &amp; Jerry');
  });

  it('should escape angle brackets', () => {
    assert.strictEqual(escapeHtml('<div>content</div>'), '&lt;div&gt;content&lt;/div&gt;');
  });

  it('should handle empty string', () => {
    assert.strictEqual(escapeHtml(''), '');
  });

  it('should handle plain text unchanged', () => {
    assert.strictEqual(escapeHtml('Hello World'), 'Hello World');
  });

  it('should escape quotes in attributes context', () => {
    const result = escapeHtml('value="test"');
    assert.ok(result.includes('"'), 'Should preserve quotes (not in attribute context)');
  });
});

// ============================================================================
// Tests: stripInteractionTags
// ============================================================================

describe('stripInteractionTags', () => {
  it('should remove single interaction tag', () => {
    const input = 'Hello <interaction>{"type":"test"}</interaction> World';
    const result = stripInteractionTags(input);
    assert.strictEqual(result, 'Hello  World');
  });

  it('should remove multiple interaction tags', () => {
    const input = 'A <interaction>1</interaction> B <interaction>2</interaction> C';
    const result = stripInteractionTags(input);
    assert.strictEqual(result, 'A  B  C');
  });

  it('should handle multiline interaction content', () => {
    const input = 'Before <interaction>\n{\n  "multi": "line"\n}\n</interaction> After';
    const result = stripInteractionTags(input);
    assert.strictEqual(result, 'Before  After');
  });

  it('should collapse multiple newlines to two', () => {
    const input = 'Line 1\n\n\n\n\nLine 2';
    const result = stripInteractionTags(input);
    assert.strictEqual(result, 'Line 1\n\nLine 2');
  });

  it('should handle null input', () => {
    assert.strictEqual(stripInteractionTags(null), null);
  });

  it('should handle undefined input', () => {
    assert.strictEqual(stripInteractionTags(undefined), undefined);
  });

  it('should handle empty string', () => {
    assert.strictEqual(stripInteractionTags(''), '');
  });

  it('should trim whitespace from result', () => {
    const input = '  <interaction>data</interaction>  content  ';
    const result = stripInteractionTags(input);
    assert.strictEqual(result, 'content');
  });

  it('should handle text with no interaction tags', () => {
    const input = 'Plain text without tags';
    const result = stripInteractionTags(input);
    assert.strictEqual(result, 'Plain text without tags');
  });
});

// ============================================================================
// Tests: formatTokenCount
// ============================================================================

describe('formatTokenCount', () => {
  it('should format small numbers as-is', () => {
    assert.strictEqual(formatTokenCount(0), '0');
    assert.strictEqual(formatTokenCount(100), '100');
    assert.strictEqual(formatTokenCount(999), '999');
  });

  it('should format thousands with one decimal', () => {
    assert.strictEqual(formatTokenCount(1000), '1.0k');
    assert.strictEqual(formatTokenCount(1500), '1.5k');
    assert.strictEqual(formatTokenCount(2345), '2.3k');
    assert.strictEqual(formatTokenCount(9999), '10.0k');
  });

  it('should format large numbers without decimal', () => {
    assert.strictEqual(formatTokenCount(10000), '10k');
    assert.strictEqual(formatTokenCount(15000), '15k');
    assert.strictEqual(formatTokenCount(100000), '100k');
    assert.strictEqual(formatTokenCount(1000000), '1000k');
  });

  it('should round large numbers correctly', () => {
    assert.strictEqual(formatTokenCount(10499), '10k');
    assert.strictEqual(formatTokenCount(10500), '11k');
  });
});

// ============================================================================
// Tests: calculateCost
// ============================================================================

describe('calculateCost', () => {
  it('should calculate cost for zero tokens', () => {
    assert.strictEqual(calculateCost(0, 0), 0);
  });

  it('should calculate cost for input tokens only', () => {
    // 1M input tokens = $3
    assert.strictEqual(calculateCost(1_000_000, 0), 3);
  });

  it('should calculate cost for output tokens only', () => {
    // 1M output tokens = $15
    assert.strictEqual(calculateCost(0, 1_000_000), 15);
  });

  it('should calculate combined cost correctly', () => {
    // 1M input ($3) + 1M output ($15) = $18
    assert.strictEqual(calculateCost(1_000_000, 1_000_000), 18);
  });

  it('should handle typical usage amounts', () => {
    // 10k input + 2k output
    // Input: 10000 / 1M * 3 = 0.03
    // Output: 2000 / 1M * 15 = 0.03
    const cost = calculateCost(10000, 2000);
    assert.ok(Math.abs(cost - 0.06) < 0.001, `Expected ~0.06, got ${cost}`);
  });

  it('should handle small token counts', () => {
    // 100 input + 50 output
    const cost = calculateCost(100, 50);
    const expected = (100 / 1_000_000) * 3 + (50 / 1_000_000) * 15;
    assert.strictEqual(cost, expected);
  });
});

// ============================================================================
// Tests: formatCost
// ============================================================================

describe('formatCost', () => {
  it('should format zero cost', () => {
    assert.strictEqual(formatCost(0), '$0.00');
  });

  it('should format small costs', () => {
    assert.strictEqual(formatCost(0.01), '$0.01');
    assert.strictEqual(formatCost(0.05), '$0.05');
  });

  it('should format typical costs', () => {
    assert.strictEqual(formatCost(0.12), '$0.12');
    assert.strictEqual(formatCost(1.50), '$1.50');
    assert.strictEqual(formatCost(10.99), '$10.99');
  });

  it('should round to two decimal places', () => {
    assert.strictEqual(formatCost(0.001), '$0.00');
    assert.strictEqual(formatCost(0.005), '$0.01');
    assert.strictEqual(formatCost(0.999), '$1.00');
  });

  it('should handle large costs', () => {
    assert.strictEqual(formatCost(100.00), '$100.00');
    assert.strictEqual(formatCost(1234.56), '$1234.56');
  });
});

// ============================================================================
// Tests: formatRelativeDate
// ============================================================================

describe('formatRelativeDate', () => {
  it('should show "just now" for recent times', () => {
    const now = new Date('2024-01-15T12:00:00');
    const recent = new Date('2024-01-15T11:58:00').toISOString();
    assert.strictEqual(formatRelativeDate(recent, now), 'just now');
  });

  it('should show "just now" for times less than 5 minutes ago', () => {
    const now = new Date('2024-01-15T12:00:00');
    const fourMinAgo = new Date('2024-01-15T11:56:00').toISOString();
    assert.strictEqual(formatRelativeDate(fourMinAgo, now), 'just now');
  });

  it('should show time for today after 5 minutes', () => {
    const now = new Date('2024-01-15T12:00:00');
    const earlier = new Date('2024-01-15T10:30:00').toISOString();
    const result = formatRelativeDate(earlier, now);
    assert.ok(result.includes(':'), `Expected time format, got: ${result}`);
    assert.ok(!result.includes('yesterday'), 'Should not say yesterday');
  });

  it('should show "yesterday" for yesterday', () => {
    const now = new Date('2024-01-15T12:00:00');
    const yesterday = new Date('2024-01-14T10:30:00').toISOString();
    const result = formatRelativeDate(yesterday, now);
    assert.ok(result.includes('yesterday'), `Expected yesterday, got: ${result}`);
  });

  it('should show day name for dates within a week', () => {
    const now = new Date('2024-01-15T12:00:00'); // Monday
    const threeDaysAgo = new Date('2024-01-12T10:30:00').toISOString(); // Friday
    const result = formatRelativeDate(threeDaysAgo, now);
    assert.ok(result.includes('Fri'), `Expected day name, got: ${result}`);
  });

  it('should show date for older dates', () => {
    const now = new Date('2024-01-15T12:00:00');
    const twoWeeksAgo = new Date('2024-01-01T10:30:00').toISOString();
    const result = formatRelativeDate(twoWeeksAgo, now);
    assert.ok(result.includes('Jan'), `Expected month, got: ${result}`);
  });
});
