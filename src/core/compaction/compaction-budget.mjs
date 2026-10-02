'use strict';

// Compactor request budgeting (P4, ruling R2/R4).
//
// The compaction request must fit the SELECTED compactor's real context window,
// not the process-wide default. The accounting subtracts everything that must
// ride along with the (potentially chunked) input:
//
//   budget = window - instructionTokens - metadataTokens - outputReserve
//
// Resolution lives here so the service stays a thin orchestrator and the math is
// independently testable.

import {
  DEFAULT_EFFECTIVE_CONTEXT_WINDOW_TOKENS,
  resolveEffectiveContextWindow,
} from './effective-windows.mjs';

// Room the compactor's own completion needs. Exported so callers and specs share
// one default.
export const DEFAULT_COMPACTION_OUTPUT_RESERVE_TOKENS = 4096;

// The selected compactor's effective window, or null when unknown. Prefers the
// live provider instance, then the provider class, then shared per-agent
// resolution against the model catalog. The shared resolver's bare default is
// treated as "unknown" so a caller-configured fallback budget still wins.
export function resolveCompactorWindow({ compactorAgent, provider, ProviderClass, catalog } = {}) {
  let config = compactorAgent?.config || {};
  let context = { config, baseUrl: config.baseUrl };

  let live = callResolveContextWindow(provider, context);
  if (live != null)
    return live;

  let fromClass = callResolveContextWindow(ProviderClass, context);
  if (fromClass != null)
    return fromClass;

  let resolved = normalizePositiveInteger(resolveEffectiveContextWindow({
    agent: compactorAgent,
    providerClass: ProviderClass,
    catalog,
  }));
  if (resolved == null || resolved === DEFAULT_EFFECTIVE_CONTEXT_WINDOW_TOKENS)
    return null;

  return resolved;
}

// Available input-token budget after the fixed overhead. `fallbackWindow` is the
// legacy config value used only when the real window cannot be determined.
export function computeCompactionBudget({
  window,
  fallbackWindow,
  instructionTokens = 0,
  metadataTokens = 0,
  outputReserveTokens = DEFAULT_COMPACTION_OUTPUT_RESERVE_TOKENS,
} = {}) {
  let effectiveWindow = normalizePositiveInteger(
    window,
    normalizePositiveInteger(fallbackWindow, 1),
  );
  let overhead = normalizeNonNegativeInteger(instructionTokens, 0)
    + normalizeNonNegativeInteger(metadataTokens, 0)
    + normalizeNonNegativeInteger(outputReserveTokens, 0);

  return Math.max(1, effectiveWindow - overhead);
}

// The fixed prompt overhead other than instructions and the input: the wrapper
// text plus the metadata JSON. `frameCount` is part of the JSON, so it is
// included.
export function countCompactionMetadataTokens({ estimateTokens, compactionWindow, frameCount = 0 } = {}) {
  let estimate = typeof estimateTokens === 'function' ? estimateTokens : defaultEstimate;
  let metadata = [
    'Compaction metadata JSON:',
    JSON.stringify({
      sessionID: 'x',
      frameCount,
      startFrameID: compactionWindow?.startFrameID || '',
      boundaryFrameID: compactionWindow?.boundaryFrameID || '',
      contextTokenBudget: 1,
    }, null, 2),
    '',
    'Return only the compacted context memory. Do not wrap it in commentary about the compaction process.',
    '',
    'Context memory to compact:',
  ].join('\n');

  return estimate(metadata);
}

function callResolveContextWindow(target, context) {
  if (!target || typeof target.resolveContextWindow !== 'function')
    return null;

  try {
    return normalizePositiveInteger(target.resolveContextWindow(context));
  } catch (_error) {
    return null;
  }
}

function defaultEstimate(value) {
  let text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return Math.max(1, Math.ceil(text.length / 4));
}

function normalizePositiveInteger(value, fallback) {
  if (value == null)
    return fallback;

  let number = Number(value);
  return Number.isFinite(number) && number >= 1 ? Math.trunc(number) : fallback;
}

function normalizeNonNegativeInteger(value, fallback) {
  if (value == null)
    return fallback;

  let number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : fallback;
}
