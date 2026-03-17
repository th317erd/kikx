'use strict';

// Per-service pricing ($ per million tokens)
const SERVICE_PRICING = {
  anthropic: {
    input:      3.00,
    cacheRead:  0.30,
    cacheWrite: 3.75,
    output:    15.00,
  },
  openai: {
    input:      2.50,
    cacheRead:  1.25,
    cacheWrite: 2.50,
    output:    10.00,
  },
};

// Fallback pricing when serviceType is unknown
const DEFAULT_PRICING = SERVICE_PRICING.anthropic;

export function getPricing(serviceType) {
  return (serviceType && SERVICE_PRICING[serviceType]) || DEFAULT_PRICING;
}

export function estimateCost(usage, serviceType) {
  if (!usage)
    return 0;

  let pricing    = getPricing(serviceType);
  let input      = ((usage.inputTokens || 0) / 1_000_000) * pricing.input;
  let output     = ((usage.outputTokens || 0) / 1_000_000) * pricing.output;
  let cacheRead  = ((usage.cacheReadInputTokens || 0) / 1_000_000) * pricing.cacheRead;
  let cacheWrite = ((usage.cacheCreationInputTokens || 0) / 1_000_000) * pricing.cacheWrite;

  return input + output + cacheRead + cacheWrite;
}
