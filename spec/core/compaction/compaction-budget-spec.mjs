'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_COMPACTION_OUTPUT_RESERVE_TOKENS,
  computeCompactionBudget,
  countCompactionMetadataTokens,
  resolveCompactorWindow,
} from '../../../src/core/compaction/index.mjs';
import { AgentInterface } from '../../../src/core/plugins/index.mjs';

class LiveWindowProvider extends AgentInterface {
  static pluginID = 'live-window';

  resolveContextWindow() {
    return 12000;
  }
}

class ClassWindowProvider extends AgentInterface {
  static pluginID = 'class-window';

  resolveContextWindow() {
    return 9000;
  }
}

class UnknownWindowProvider extends AgentInterface {
  static pluginID = 'unknown-window';

  resolveContextWindow() {
    return null;
  }

  contextWindowFor() {
    return null;
  }
}

test('resolveCompactorWindow prefers the live provider instance', () => {
  let window = resolveCompactorWindow({
    compactorAgent: { id: 'a', pluginID: 'live-window', config: {} },
    provider: new LiveWindowProvider({ config: {} }),
    ProviderClass: LiveWindowProvider,
    catalog: [],
  });

  assert.equal(window, 12000);
});

test('resolveCompactorWindow falls back to the provider class resolver', () => {
  let window = resolveCompactorWindow({
    compactorAgent: { id: 'a', pluginID: 'class-window', config: {} },
    provider: {},
    ProviderClass: ClassWindowProvider,
    catalog: [],
  });

  assert.equal(window, 9000);
});

test('resolveCompactorWindow returns null when nothing finite resolves', () => {
  let window = resolveCompactorWindow({
    compactorAgent: { id: 'a', pluginID: 'unknown-window', config: {} },
    provider: new UnknownWindowProvider({ config: {} }),
    ProviderClass: UnknownWindowProvider,
    catalog: [],
  });

  assert.equal(window, null);
});

test('computeCompactionBudget subtracts instructions, metadata and the output reserve', () => {
  let budget = computeCompactionBudget({
    window: 8000,
    fallbackWindow: 128000,
    instructionTokens: 500,
    metadataTokens: 200,
    outputReserveTokens: 1000,
  });

  assert.equal(budget, 8000 - 500 - 200 - 1000);
  assert.equal(DEFAULT_COMPACTION_OUTPUT_RESERVE_TOKENS, 4096);
});

test('computeCompactionBudget uses the fallback window when the real window is unknown', () => {
  let budget = computeCompactionBudget({
    window: null,
    fallbackWindow: 5000,
    instructionTokens: 100,
    metadataTokens: 50,
    outputReserveTokens: 400,
  });

  assert.equal(budget, 5000 - 100 - 50 - 400);
});

test('computeCompactionBudget never goes below one token', () => {
  let budget = computeCompactionBudget({
    window: 100,
    instructionTokens: 500,
    metadataTokens: 500,
    outputReserveTokens: 500,
  });

  assert.equal(budget, 1);
});

test('countCompactionMetadataTokens estimates the wrapper and metadata JSON', () => {
  let estimateTokens = (text) => Math.max(1, Math.ceil(String(text || '').length / 4));
  let tokens = countCompactionMetadataTokens({
    estimateTokens,
    compactionWindow: { startFrameID: 'a', boundaryFrameID: 'b' },
    frameCount: 3,
  });

  assert.equal(Number.isFinite(tokens), true);
  assert.equal(tokens > 0, true);
  // More frames means a slightly larger metadata JSON, never smaller.
  let tokensMore = countCompactionMetadataTokens({
    estimateTokens,
    compactionWindow: { startFrameID: 'a', boundaryFrameID: 'b' },
    frameCount: 300000,
  });
  assert.equal(tokensMore >= tokens, true);
});
