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

// Lazily imported store reference — avoids circular deps in test environments.
// Populated on first call to getPricing() if store is available.
let _storeModels = null;

function getStoreModels() {
  if (_storeModels !== null)
    return _storeModels;

  try {
    // Dynamic import fallback — works in browser + node-test environments where
    // the store may not be globally available.
    // In test environments, store-models may be injected via setPricingStore().
    let storeModule = globalThis.__kikx_store_models__;
    _storeModels    = storeModule || null;
  } catch (_e) {
    _storeModels = null;
  }

  return _storeModels;
}

// Inject a models store accessor for testing or custom environments.
// Expected interface: { getModel(modelID) => { pricePerToken: { input, output, cacheRead?, cacheWrite? } } | null }
export function setPricingStore(storeModels) {
  _storeModels = storeModels;
}

export function getPricing(serviceType, modelID) {
  // First: check model registry for per-model pricing
  if (modelID) {
    try {
      let storeModels = getStoreModels();
      if (storeModels && typeof storeModels.getModel === 'function') {
        let model = storeModels.getModel(modelID);
        if (model && model.pricePerToken) {
          return {
            input:      model.pricePerToken.input      || DEFAULT_PRICING.input,
            output:     model.pricePerToken.output     || DEFAULT_PRICING.output,
            cacheRead:  model.pricePerToken.cacheRead  || DEFAULT_PRICING.cacheRead,
            cacheWrite: model.pricePerToken.cacheWrite || DEFAULT_PRICING.cacheWrite,
          };
        }
      }
    } catch (_e) {
      // Store threw — fall through to hardcoded pricing
    }
  }

  // Fallback: service-level hardcoded pricing
  return (serviceType && SERVICE_PRICING[serviceType]) || DEFAULT_PRICING;
}

export function estimateCost(usage, serviceType, modelID) {
  if (!usage)
    return 0;

  let pricing    = getPricing(serviceType, modelID);
  let input      = ((usage.inputTokens || 0) / 1_000_000) * pricing.input;
  let output     = ((usage.outputTokens || 0) / 1_000_000) * pricing.output;
  let cacheRead  = ((usage.cacheReadInputTokens || 0) / 1_000_000) * pricing.cacheRead;
  let cacheWrite = ((usage.cacheCreationInputTokens || 0) / 1_000_000) * pricing.cacheWrite;

  return input + output + cacheRead + cacheWrite;
}
