'use strict';

// Anthropic pricing per million tokens (default to Sonnet 4 tier)
const PRICING = {
  input:        3.00,
  cacheRead:    0.30,
  cacheWrite:   3.75,
  output:      15.00,
};

export function estimateCost(usage) {
  if (!usage)
    return 0;

  let input      = ((usage.inputTokens || 0) / 1_000_000) * PRICING.input;
  let output     = ((usage.outputTokens || 0) / 1_000_000) * PRICING.output;
  let cacheRead  = ((usage.cacheReadInputTokens || 0) / 1_000_000) * PRICING.cacheRead;
  let cacheWrite = ((usage.cacheCreationInputTokens || 0) / 1_000_000) * PRICING.cacheWrite;

  return input + output + cacheRead + cacheWrite;
}
