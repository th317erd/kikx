'use strict';

import { describe, it } from 'node:test';
import assert            from 'node:assert/strict';

import { BasePluginClass, DEFAULT_COMPACTION_PROMPT } from '../../../src/core/routing/base-plugin-class.mjs';

// =============================================================================
// Helpers
// =============================================================================

function createContext(overrides) {
  return { logger: console, changes: [], ...overrides };
}

function createPlugin(overrides) {
  return new BasePluginClass(createContext(overrides));
}

// =============================================================================
// shouldCompact()
// =============================================================================

describe('BasePluginClass — shouldCompact()', () => {
  it('should return { compact: false } by default', () => {
    let plugin = createPlugin();
    let result = plugin.shouldCompact({
      totalChars:      50000,
      estimatedTokens: 12000,
      contextWindow:   200000,
      modelID:         'claude-sonnet-4-20250514',
      sessionID:       'ses_abc123',
    });

    assert.strictEqual(result.compact, false);
  });

  it('should return an empty reason string by default', () => {
    let plugin = createPlugin();
    let result = plugin.shouldCompact({});

    assert.strictEqual(result.reason, '');
  });

  it('should accept no arguments without error', () => {
    let plugin = createPlugin();
    let result = plugin.shouldCompact();

    assert.strictEqual(result.compact, false);
    assert.strictEqual(result.reason, '');
  });

  it('should accept null stats without error', () => {
    let plugin = createPlugin();
    let result = plugin.shouldCompact(null);

    assert.strictEqual(result.compact, false);
  });

  it('should be overridable by a subclass', () => {
    class CompactingPlugin extends BasePluginClass {
      shouldCompact(stats) {
        if (stats && stats.estimatedTokens > 100000)
          return { compact: true, reason: 'token limit exceeded' };

        return { compact: false, reason: '' };
      }
    }

    let plugin = new CompactingPlugin(createContext());
    let result = plugin.shouldCompact({ estimatedTokens: 150000 });

    assert.strictEqual(result.compact, true);
    assert.strictEqual(result.reason, 'token limit exceeded');
  });
});

// =============================================================================
// getCompactionPrompt()
// =============================================================================

describe('BasePluginClass — getCompactionPrompt()', () => {
  it('should return the DEFAULT_COMPACTION_PROMPT string', () => {
    let plugin = createPlugin();
    let result = plugin.getCompactionPrompt({});

    assert.strictEqual(result, DEFAULT_COMPACTION_PROMPT);
  });

  it('should return a non-empty string', () => {
    let plugin = createPlugin();
    let result = plugin.getCompactionPrompt({});

    assert.strictEqual(typeof result, 'string');
    assert.ok(result.length > 0);
  });

  it('should accept no arguments without error', () => {
    let plugin = createPlugin();
    let result = plugin.getCompactionPrompt();

    assert.strictEqual(result, DEFAULT_COMPACTION_PROMPT);
  });

  it('should be overridable by a subclass', () => {
    class CustomPromptPlugin extends BasePluginClass {
      getCompactionPrompt(_stats) {
        return 'Custom compaction instructions here.';
      }
    }

    let plugin = new CustomPromptPlugin(createContext());
    let result = plugin.getCompactionPrompt({});

    assert.strictEqual(result, 'Custom compaction instructions here.');
  });
});

// =============================================================================
// getMaxCompactionTokens()
// =============================================================================

describe('BasePluginClass — getMaxCompactionTokens()', () => {
  it('should return 8000 by default', () => {
    let plugin = createPlugin();
    let result = plugin.getMaxCompactionTokens({});

    assert.strictEqual(result, 8000);
  });

  it('should accept no arguments without error', () => {
    let plugin = createPlugin();
    let result = plugin.getMaxCompactionTokens();

    assert.strictEqual(result, 8000);
  });

  it('should accept null stats without error', () => {
    let plugin = createPlugin();
    let result = plugin.getMaxCompactionTokens(null);

    assert.strictEqual(result, 8000);
  });

  it('should be overridable by a subclass', () => {
    class LargeContextPlugin extends BasePluginClass {
      getMaxCompactionTokens(stats) {
        if (stats && stats.contextWindow > 100000)
          return 16000;

        return 8000;
      }
    }

    let plugin = new LargeContextPlugin(createContext());
    let result = plugin.getMaxCompactionTokens({ contextWindow: 200000 });

    assert.strictEqual(result, 16000);
  });
});

// =============================================================================
// _createSingleTurn()
// =============================================================================

describe('BasePluginClass — _createSingleTurn()', () => {
  it('should throw "not implemented" error by default', async () => {
    let plugin = createPlugin();

    await assert.rejects(
      () => plugin._createSingleTurn([], { maxTokens: 8000, systemPrompt: 'Compact this.' }),
      { message: '_createSingleTurn() not implemented — override in agent plugin' },
    );
  });

  it('should throw when called with no arguments', async () => {
    let plugin = createPlugin();

    await assert.rejects(
      () => plugin._createSingleTurn(),
      { message: '_createSingleTurn() not implemented — override in agent plugin' },
    );
  });

  it('should return a promise (async method)', () => {
    let plugin = createPlugin();
    let result = plugin._createSingleTurn([], {});

    assert.ok(result instanceof Promise);

    // Catch the expected rejection so it doesn't become an unhandled rejection
    result.catch(() => {});
  });

  it('should be overridable by a subclass', async () => {
    class MockLLMPlugin extends BasePluginClass {
      async _createSingleTurn(messages, options) {
        return { content: 'Compacted summary.', usage: { outputTokens: 100 } };
      }
    }

    let plugin = new MockLLMPlugin(createContext());
    let result = await plugin._createSingleTurn(
      [{ role: 'user', content: 'Hello world' }],
      { maxTokens: 8000, systemPrompt: 'Compact.' },
    );

    assert.strictEqual(result.content, 'Compacted summary.');
    assert.strictEqual(result.usage.outputTokens, 100);
  });
});

// =============================================================================
// DEFAULT_COMPACTION_PROMPT export
// =============================================================================

describe('DEFAULT_COMPACTION_PROMPT — named export', () => {
  it('should be a non-empty string', () => {
    assert.strictEqual(typeof DEFAULT_COMPACTION_PROMPT, 'string');
    assert.ok(DEFAULT_COMPACTION_PROMPT.length > 0);
  });

  it('should contain key compaction instructions', () => {
    assert.ok(DEFAULT_COMPACTION_PROMPT.includes('compact/compress'));
    assert.ok(DEFAULT_COMPACTION_PROMPT.includes('file paths'));
    assert.ok(DEFAULT_COMPACTION_PROMPT.includes('gradient of resolution'));
  });

  it('should be importable as a named export alongside BasePluginClass', async () => {
    let module = await import('../../../src/core/routing/base-plugin-class.mjs');
    assert.ok('DEFAULT_COMPACTION_PROMPT' in module);
    assert.ok('BasePluginClass' in module);
    assert.strictEqual(module.DEFAULT_COMPACTION_PROMPT, DEFAULT_COMPACTION_PROMPT);
  });
});
