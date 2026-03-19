'use strict';

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// =============================================================================
// Cost estimation tests
// =============================================================================

import { estimateCost, getPricing, setPricingStore } from '../../src/client/lib/cost.mjs';

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

  it('should use Anthropic pricing for serviceType "anthropic"', () => {
    let cost = estimateCost({ inputTokens: 1_000_000 }, 'anthropic');
    assert.ok(Math.abs(cost - 3.00) < 0.001);
  });

  it('should use OpenAI pricing for serviceType "openai"', () => {
    let cost = estimateCost({ inputTokens: 1_000_000 }, 'openai');
    assert.ok(Math.abs(cost - 2.50) < 0.001);
  });

  it('should fall back to Anthropic pricing for unknown serviceType', () => {
    let cost = estimateCost({ inputTokens: 1_000_000 }, 'unknown');
    assert.ok(Math.abs(cost - 3.00) < 0.001);
  });

  it('should fall back to Anthropic pricing when serviceType is null', () => {
    let cost = estimateCost({ inputTokens: 1_000_000 }, null);
    assert.ok(Math.abs(cost - 3.00) < 0.001);
  });
});

// =============================================================================
// _loadCosts serviceType derivation tests
// =============================================================================
// Tests the participant → serviceType logic that was fixed (p.type === 'agent'
// was always false since Participant model has no type field; now uses p.agentID).
// =============================================================================

describe('_loadCosts serviceType derivation', () => {
  // Extract the serviceType derivation logic for testing
  function deriveServiceType(participants, getAgent) {
    let serviceType = null;

    if (participants) {
      for (let p of participants) {
        if (p.agentID) {
          let agent = getAgent(p.agentID);
          if (agent && agent.pluginID) {
            if (agent.pluginID === 'claude-agent')
              serviceType = 'anthropic';
            else if (agent.pluginID === 'openai-agent')
              serviceType = 'openai';
          }
          break;
        }
      }
    }

    return serviceType;
  }

  it('should return "anthropic" for claude-agent plugin', () => {
    let participants = [{ agentID: 'agt_1', role: 'member' }];
    let getAgent = (id) => (id === 'agt_1' ? { pluginID: 'claude-agent' } : null);
    assert.equal(deriveServiceType(participants, getAgent), 'anthropic');
  });

  it('should return "openai" for openai-agent plugin', () => {
    let participants = [{ agentID: 'agt_2', role: 'member' }];
    let getAgent = (id) => (id === 'agt_2' ? { pluginID: 'openai-agent' } : null);
    assert.equal(deriveServiceType(participants, getAgent), 'openai');
  });

  it('should return null when no participants', () => {
    assert.equal(deriveServiceType(null, () => null), null);
    assert.equal(deriveServiceType([], () => null), null);
  });

  it('should return null when agent has no pluginID', () => {
    let participants = [{ agentID: 'agt_3', role: 'member' }];
    let getAgent = () => ({ name: 'test' });
    assert.equal(deriveServiceType(participants, getAgent), null);
  });

  it('should return null when agent is not found in store', () => {
    let participants = [{ agentID: 'agt_4', role: 'member' }];
    let getAgent = () => null;
    assert.equal(deriveServiceType(participants, getAgent), null);
  });

  it('should use first participant with agentID', () => {
    let participants = [
      { agentID: 'agt_1', role: 'member' },
      { agentID: 'agt_2', role: 'member' },
    ];
    let getAgent = (id) => {
      if (id === 'agt_1') return { pluginID: 'claude-agent' };
      if (id === 'agt_2') return { pluginID: 'openai-agent' };
      return null;
    };
    assert.equal(deriveServiceType(participants, getAgent), 'anthropic');
  });

  it('should work with Participant model shape (no type field)', () => {
    // Participant model: { id, sessionID, agentID, role }
    // Previously broken: p.type === 'agent' was always false
    let participants = [
      { id: 'prt_abc', sessionID: 'ses_123', agentID: 'agt_1', role: 'member' },
    ];
    let getAgent = () => ({ pluginID: 'claude-agent' });
    assert.equal(deriveServiceType(participants, getAgent), 'anthropic');
  });
});

// =============================================================================
// _handleUsage cost accumulation tests
// =============================================================================
// Tests the incremental cost accumulation logic from SSE usage events.
// =============================================================================

describe('_handleUsage cost accumulation', () => {
  // Simulate the cost accumulation logic from _handleUsage
  function handleUsage({ usage, serviceType, isFinal }, currentCosts) {
    if (!usage)
      return currentCosts;

    // Partial events (non-final) don't update costs
    if (!isFinal)
      return currentCosts;

    let cost = estimateCost(usage, serviceType);

    return {
      global:  currentCosts.global + cost,
      service: currentCosts.service + cost,
      session: currentCosts.session + cost,
    };
  }

  let zeroCosts;

  beforeEach(() => {
    zeroCosts = { global: 0, service: 0, session: 0 };
  });

  it('should not update costs for partial (non-final) usage events', () => {
    let result = handleUsage({
      usage:       { inputTokens: 1000, outputTokens: 0 },
      serviceType: 'anthropic',
      isFinal:     false,
    }, zeroCosts);

    assert.deepEqual(result, zeroCosts);
  });

  it('should update costs for final usage events', () => {
    let result = handleUsage({
      usage:       { inputTokens: 1000, outputTokens: 500 },
      serviceType: 'anthropic',
      isFinal:     true,
    }, zeroCosts);

    assert.ok(result.global > 0);
    assert.ok(result.service > 0);
    assert.ok(result.session > 0);
    assert.equal(result.global, result.service);
    assert.equal(result.global, result.session);
  });

  it('should accumulate costs across multiple final events', () => {
    let usage = { inputTokens: 1000, outputTokens: 500 };
    let first = handleUsage({ usage, serviceType: 'anthropic', isFinal: true }, zeroCosts);
    let second = handleUsage({ usage, serviceType: 'anthropic', isFinal: true }, first);

    assert.ok(second.global > first.global);
    assert.ok(Math.abs(second.global - first.global * 2) < 0.0000001);
  });

  it('should not update costs when usage is null', () => {
    let result = handleUsage({ usage: null, serviceType: 'anthropic', isFinal: true }, zeroCosts);
    assert.deepEqual(result, zeroCosts);
  });

  it('should use correct pricing based on serviceType from SSE', () => {
    let usage = { inputTokens: 1_000_000 };

    let anthropicResult = handleUsage({ usage, serviceType: 'anthropic', isFinal: true }, zeroCosts);
    let openaiResult    = handleUsage({ usage, serviceType: 'openai', isFinal: true }, zeroCosts);

    assert.ok(Math.abs(anthropicResult.global - 3.00) < 0.001);
    assert.ok(Math.abs(openaiResult.global - 2.50) < 0.001);
  });
});

// =============================================================================
// Relative timestamp formatting tests
// =============================================================================
// We test the formatTimestamp logic by importing the session-page module
// and calling its internal function. Since it's module-private, we replicate
// the logic here for unit testing.
// =============================================================================

// =============================================================================
// getPricing — model registry integration
// =============================================================================
// Tests that getPricing() reads from model registry when available,
// and falls back to hardcoded pricing when registry is absent.
// =============================================================================

describe('getPricing — model registry integration', () => {
  // Reset store after each test to avoid cross-test pollution
  let savedStore;

  beforeEach(() => {
    // Detach any store by default
    savedStore = null;
    setPricingStore(null);
  });

  it('should fall back to hardcoded Anthropic pricing when no store set', () => {
    setPricingStore(null);
    let pricing = getPricing('anthropic', 'claude-opus-4-6');
    // Falls back to hardcoded Anthropic: input=3.0, output=15.0
    assert.ok(Math.abs(pricing.input - 3.0) < 0.001);
    assert.ok(Math.abs(pricing.output - 15.0) < 0.001);
  });

  it('should fall back to hardcoded pricing when model not found in registry', () => {
    let mockStore = {
      getModel: (_id) => null, // model not found
    };

    setPricingStore(mockStore);

    let pricing = getPricing('anthropic', 'nonexistent-model');
    // Falls back to Anthropic hardcoded pricing
    assert.ok(Math.abs(pricing.input - 3.0) < 0.001);

    setPricingStore(null);
  });

  it('should use model registry pricing when model is found', () => {
    let mockStore = {
      getModel: (id) => {
        if (id === 'claude-opus-4-6')
          return { pricePerToken: { input: 15.0, output: 75.0 } };

        return null;
      },
    };

    setPricingStore(mockStore);

    let pricing = getPricing('anthropic', 'claude-opus-4-6');
    assert.ok(Math.abs(pricing.input - 15.0) < 0.001);
    assert.ok(Math.abs(pricing.output - 75.0) < 0.001);

    setPricingStore(null);
  });

  it('should use registry pricing for cost estimation when model matches', () => {
    let mockStore = {
      getModel: (id) => {
        if (id === 'claude-haiku-4-5-20251001')
          return { pricePerToken: { input: 0.8, output: 4.0 } };

        return null;
      },
    };

    setPricingStore(mockStore);

    // 1M input tokens at $0.80/M = $0.80
    let cost = estimateCost({ inputTokens: 1_000_000 }, 'anthropic', 'claude-haiku-4-5-20251001');
    assert.ok(Math.abs(cost - 0.8) < 0.001);

    setPricingStore(null);
  });

  it('should fall back to hardcoded pricing when modelID is null', () => {
    let mockStore = {
      getModel: (id) => ({ pricePerToken: { input: 99.0, output: 99.0 } }),
    };

    setPricingStore(mockStore);

    // No modelID passed — should NOT use registry
    let pricing = getPricing('anthropic', null);
    assert.ok(Math.abs(pricing.input - 3.0) < 0.001, 'Should use hardcoded when no modelID');

    setPricingStore(null);
  });

  it('should fall back when store getModel() throws', () => {
    let mockStore = {
      getModel: () => { throw new Error('store error'); },
    };

    setPricingStore(mockStore);

    // Should not crash — fall back to hardcoded
    let pricing;
    assert.doesNotThrow(() => {
      pricing = getPricing('anthropic', 'claude-opus-4-6');
    });

    setPricingStore(null);
  });

  it('should use hardcoded pricing for estimateCost without modelID (backward compat)', () => {
    // Calling estimateCost with 2 args (old signature) should still work
    let cost = estimateCost({ inputTokens: 1_000_000 }, 'anthropic');
    assert.ok(Math.abs(cost - 3.0) < 0.001);
  });
});

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
