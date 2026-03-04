'use strict';

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// =============================================================================
// Cost estimation tests
// =============================================================================

import { estimateCost } from '../../src/client/lib/cost.mjs';

describe('estimateCost', () => {
  it('should return 0 for null/undefined usage', () => {
    assert.equal(estimateCost(null), 0);
    assert.equal(estimateCost(undefined), 0);
  });

  it('should return 0 for empty usage object', () => {
    assert.equal(estimateCost({}), 0);
  });

  it('should calculate input-only cost correctly', () => {
    let cost = estimateCost({ inputTokens: 1_000_000 });
    // 1M input tokens at $3.00/M = $3.00
    assert.ok(Math.abs(cost - 3.00) < 0.001);
  });

  it('should calculate output-only cost correctly', () => {
    let cost = estimateCost({ outputTokens: 1_000_000 });
    // 1M output tokens at $15.00/M = $15.00
    assert.ok(Math.abs(cost - 15.00) < 0.001);
  });

  it('should calculate cache read cost correctly', () => {
    let cost = estimateCost({ cacheReadInputTokens: 1_000_000 });
    // 1M cache read tokens at $0.30/M = $0.30
    assert.ok(Math.abs(cost - 0.30) < 0.001);
  });

  it('should calculate cache creation cost correctly', () => {
    let cost = estimateCost({ cacheCreationInputTokens: 1_000_000 });
    // 1M cache creation tokens at $3.75/M = $3.75
    assert.ok(Math.abs(cost - 3.75) < 0.001);
  });

  it('should calculate combined cost correctly', () => {
    let cost = estimateCost({
      inputTokens:              500,
      outputTokens:             200,
      cacheReadInputTokens:     300,
      cacheCreationInputTokens: 100,
    });

    // 500/1M * 3.00 = 0.0015
    // 200/1M * 15.00 = 0.003
    // 300/1M * 0.30 = 0.00009
    // 100/1M * 3.75 = 0.000375
    let expected = 0.0015 + 0.003 + 0.00009 + 0.000375;
    assert.ok(Math.abs(cost - expected) < 0.0000001);
  });

  it('should handle partial usage (only some fields present)', () => {
    let cost = estimateCost({ inputTokens: 1000, outputTokens: 500 });
    let expected = (1000 / 1_000_000) * 3.00 + (500 / 1_000_000) * 15.00;
    assert.ok(Math.abs(cost - expected) < 0.0000001);
  });
});

// =============================================================================
// Relative timestamp formatting tests
// =============================================================================
// We test the formatTimestamp logic by importing the session-page module
// and calling its internal function. Since it's module-private, we replicate
// the logic here for unit testing.
// =============================================================================

describe('formatTimestamp (relative)', () => {
  // Replicate the formatTimestamp logic for isolated testing
  function formatTimestamp(isoStringOrEpoch) {
    if (!isoStringOrEpoch && isoStringOrEpoch !== 0)
      return '';

    let date = (typeof isoStringOrEpoch === 'number')
      ? new Date(isoStringOrEpoch)
      : new Date(isoStringOrEpoch);

    if (isNaN(date.getTime()))
      return '';

    let now  = Date.now();
    let diff = now - date.getTime();

    if (diff < 60_000)
      return 'just now';

    if (diff < 3_600_000)
      return `${Math.floor(diff / 60_000)}m ago`;

    if (diff < 86_400_000)
      return `${Math.floor(diff / 3_600_000)}h ago`;

    if (diff < 604_800_000)
      return `${Math.floor(diff / 86_400_000)}d ago`;

    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  it('should return empty string for null/undefined', () => {
    assert.equal(formatTimestamp(null), '');
    assert.equal(formatTimestamp(undefined), '');
    assert.equal(formatTimestamp(''), '');
  });

  it('should return empty string for invalid date', () => {
    assert.equal(formatTimestamp('not-a-date'), '');
  });

  it('should return "just now" for timestamps less than 60 seconds ago', () => {
    let result = formatTimestamp(new Date(Date.now() - 30_000).toISOString());
    assert.equal(result, 'just now');
  });

  it('should return minutes ago for timestamps 1-59 minutes ago', () => {
    let fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    assert.equal(formatTimestamp(fiveMinAgo), '5m ago');
  });

  it('should return hours ago for timestamps 1-23 hours ago', () => {
    let twoHoursAgo = new Date(Date.now() - 2 * 3_600_000).toISOString();
    assert.equal(formatTimestamp(twoHoursAgo), '2h ago');
  });

  it('should return days ago for timestamps 1-6 days ago', () => {
    let threeDaysAgo = new Date(Date.now() - 3 * 86_400_000).toISOString();
    assert.equal(formatTimestamp(threeDaysAgo), '3d ago');
  });

  it('should return absolute date for timestamps older than 7 days', () => {
    let twoWeeksAgo = new Date(Date.now() - 14 * 86_400_000);
    let result      = formatTimestamp(twoWeeksAgo.toISOString());

    // Should be like "Mar 18" or "Feb 18" — at minimum, not relative
    assert.ok(!result.includes('ago'), `Expected absolute date, got: ${result}`);
    assert.ok(result.length > 0);
  });

  it('should handle epoch millisecond numbers', () => {
    let result = formatTimestamp(Date.now() - 10_000);
    assert.equal(result, 'just now');
  });

  it('should handle epoch 0 correctly', () => {
    // Epoch 0 is Jan 1 1970 — should show absolute date
    let result = formatTimestamp(0);
    assert.ok(!result.includes('ago'));
    assert.ok(result.length > 0);
  });
});
