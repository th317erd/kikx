'use strict';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { BasePluginClass } from '../../../src/core/routing/base-plugin-class.mjs';

// =============================================================================
// Plugin Model Registry Tests
// =============================================================================

describe('BasePluginClass — model registry interface', () => {

  // ---------------------------------------------------------------------------
  // getModels() default
  // ---------------------------------------------------------------------------

  describe('getModels()', () => {

    it('should return empty array by default', () => {
      let result = BasePluginClass.getModels();
      assert.deepEqual(result, []);
    });

    it('should return empty array when called on a subclass that does not override', () => {
      class SubPlugin extends BasePluginClass {}
      let result = SubPlugin.getModels();
      assert.deepEqual(result, []);
    });

    it('should return models when overridden by subclass', () => {
      class ModelPlugin extends BasePluginClass {
        static getModels() {
          return [
            {
              id:              'test-model',
              contextWindow:   100000,
              maxOutputTokens: 8192,
              displayName:     'Test Model',
              description:     'A test model.',
              pricePerToken:   { input: 1.0, output: 5.0 },
              useWhen:         'Testing.',
            },
          ];
        }
      }

      let result = ModelPlugin.getModels();
      assert.equal(result.length, 1);
      assert.equal(result[0].id, 'test-model');
      assert.equal(result[0].contextWindow, 100000);
    });

    it('should not be affected by instance method override', () => {
      // getModels is static — instances should not affect it
      let plugin = new BasePluginClass({});
      // Access static method through constructor
      let result = plugin.constructor.getModels();
      assert.deepEqual(result, []);
    });

    it('should return correct model descriptor shape', () => {
      class ShapePlugin extends BasePluginClass {
        static getModels() {
          return [
            {
              id:              'model-a',
              contextWindow:   200000,
              maxOutputTokens: 16000,
              displayName:     'Model A',
              description:     'A model.',
              pricePerToken:   { input: 3.0, output: 15.0 },
              useWhen:         'Most tasks.',
            },
          ];
        }
      }

      let models = ShapePlugin.getModels();
      let m      = models[0];

      assert.ok(typeof m.id === 'string', 'id should be string');
      assert.ok(typeof m.contextWindow === 'number', 'contextWindow should be number');
      assert.ok(typeof m.maxOutputTokens === 'number', 'maxOutputTokens should be number');
      assert.ok(typeof m.displayName === 'string', 'displayName should be string');
      assert.ok(typeof m.description === 'string', 'description should be string');
      assert.ok(typeof m.pricePerToken === 'object', 'pricePerToken should be object');
      assert.ok(typeof m.pricePerToken.input === 'number', 'pricePerToken.input should be number');
      assert.ok(typeof m.pricePerToken.output === 'number', 'pricePerToken.output should be number');
      assert.ok(typeof m.useWhen === 'string', 'useWhen should be string');
    });
  });

  // ---------------------------------------------------------------------------
  // estimateTokens() default
  // ---------------------------------------------------------------------------

  describe('estimateTokens()', () => {

    it('should return positive integer for normal text', () => {
      let plugin = new BasePluginClass({});
      let result = plugin.estimateTokens('hello world');
      assert.ok(Number.isInteger(result), 'should be integer');
      assert.ok(result > 0, 'should be positive');
    });

    it('should return 0 for null input', () => {
      let plugin = new BasePluginClass({});
      let result = plugin.estimateTokens(null);
      assert.equal(result, 0);
    });

    it('should return 0 for undefined input', () => {
      let plugin = new BasePluginClass({});
      let result = plugin.estimateTokens(undefined);
      assert.equal(result, 0);
    });

    it('should return 0 for empty string', () => {
      let plugin = new BasePluginClass({});
      let result = plugin.estimateTokens('');
      assert.equal(result, 0);
    });

    it('should use chars/4 approximation', () => {
      let plugin = new BasePluginClass({});
      // 400 chars -> ceil(400/4) = 100
      let result = plugin.estimateTokens('a'.repeat(400));
      assert.equal(result, 100);
    });

    it('should ceil fractional token count', () => {
      let plugin = new BasePluginClass({});
      // 5 chars -> ceil(5/4) = 2
      let result = plugin.estimateTokens('hello');
      assert.equal(result, 2);
    });

    it('should accept options param without throwing', () => {
      let plugin = new BasePluginClass({});
      assert.doesNotThrow(() => {
        plugin.estimateTokens('text', { cache: true });
      });
    });
  });

  // ---------------------------------------------------------------------------
  // truncate() default
  // ---------------------------------------------------------------------------

  describe('truncate()', () => {

    it('should return messages unchanged when well under budget', async () => {
      let plugin   = new BasePluginClass({});
      let messages = [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'world' },
      ];
      let result = await plugin.truncate(messages, {
        systemPromptText: '',
        behaviorsText:    '',
        instructionsText: '',
        onOverflow:       async () => {},
      });
      assert.ok(Array.isArray(result));
      // Should still contain the messages (may have same or fewer)
      let contents = result.map((m) => m.content);
      assert.ok(contents.includes('hello') || result.length >= 2);
    });

    it('should return empty array for null messages', async () => {
      let plugin = new BasePluginClass({});
      let result = await plugin.truncate(null, {
        systemPromptText: '',
        behaviorsText:    '',
        instructionsText: '',
        onOverflow:       async () => {},
      });
      assert.deepEqual(result, []);
    });

    it('should return empty array for empty messages', async () => {
      let plugin = new BasePluginClass({});
      let result = await plugin.truncate([], {
        systemPromptText: '',
        behaviorsText:    '',
        instructionsText: '',
        onOverflow:       async () => {},
      });
      assert.deepEqual(result, []);
    });

    it('should call onOverflow when behaviors+instructions exceed 50% cap', async () => {
      let plugin = new BasePluginClass({});

      // Base class uses getModels() -> [] -> fallback contextWindow of 200000
      // 50% cap = 200000 * 4 * 0.50 = 400000 chars
      // We need behaviors+instructions > 400000 chars to trigger overflow
      let bigText     = 'x'.repeat(401000);
      let overflowCalled = false;

      let result = await plugin.truncate(
        [{ role: 'user', content: 'hi' }],
        {
          systemPromptText: '',
          behaviorsText:    bigText,
          instructionsText: '',
          onOverflow:       async (_type) => { overflowCalled = true; },
        },
      );

      assert.ok(overflowCalled, 'onOverflow should have been called');
      assert.ok(Array.isArray(result));
    });

    it('should NOT call onOverflow when behaviors+instructions are exactly at 50% cap', async () => {
      let plugin = new BasePluginClass({});
      // 50% cap = 200000 * 4 * 0.50 = 400000 chars. Exactly at boundary.
      let exactText   = 'x'.repeat(400000);
      let overflowCalled = false;

      await plugin.truncate(
        [{ role: 'user', content: 'hi' }],
        {
          systemPromptText: '',
          behaviorsText:    exactText,
          instructionsText: '',
          onOverflow:       async () => { overflowCalled = true; },
        },
      );

      assert.ok(!overflowCalled, 'onOverflow should NOT be called at exact boundary');
    });

    it('should call onOverflow when behaviors+instructions exceed 50% cap by 1 char', async () => {
      let plugin = new BasePluginClass({});
      let overText   = 'x'.repeat(400001); // 1 over boundary
      let overflowCalled = false;

      await plugin.truncate(
        [{ role: 'user', content: 'hi' }],
        {
          systemPromptText: '',
          behaviorsText:    overText,
          instructionsText: '',
          onOverflow:       async () => { overflowCalled = true; },
        },
      );

      assert.ok(overflowCalled, 'onOverflow should be called at boundary+1');
    });

    it('should truncate large messages (over conversation budget)', async () => {
      let plugin = new BasePluginClass({});

      // Build many messages that exceed default budget
      let messages = [];
      for (let i = 0; i < 10; i++) {
        messages.push({ role: 'user', content: 'u'.repeat(80000) });
        messages.push({ role: 'assistant', content: 'a'.repeat(80000) });
      }
      messages.push({ role: 'user', content: 'final message' });

      let result = await plugin.truncate(messages, {
        systemPromptText: '',
        behaviorsText:    '',
        instructionsText: '',
        onOverflow:       async () => {},
      });

      // Should have fewer messages (or truncation marker)
      let totalChars = result.reduce((sum, m) => {
        return sum + ((typeof m.content === 'string') ? m.content.length : 0);
      }, 0);

      // System prompt = 0 chars, charBudget = 200000*4 - 0 = 800000
      assert.ok(totalChars <= 800000 + 1000, 'Total chars should be within budget + marker overhead');
    });

    it('should truncate individual large messages', async () => {
      let plugin = new BasePluginClass({});

      let messages = [
        { role: 'user', content: 'a'.repeat(15000) },
      ];

      let result = await plugin.truncate(messages, {
        systemPromptText: '',
        behaviorsText:    '',
        instructionsText: '',
        onOverflow:       async () => {},
      });

      assert.ok(result[0].content.includes('[...truncated') ||
                result[0].content.length <= 8000 + 200,
                'Large message should be truncated');
    });

    it('should not mutate the original messages array', async () => {
      let plugin = new BasePluginClass({});

      let originalContent = 'a'.repeat(15000);
      let messages        = [{ role: 'user', content: originalContent }];

      await plugin.truncate(messages, {
        systemPromptText: '',
        behaviorsText:    '',
        instructionsText: '',
        onOverflow:       async () => {},
      });

      assert.equal(messages[0].content, originalContent, 'Original should not be mutated');
    });

    it('should use model contextWindow when available via subclass getModels()', async () => {
      class SmallContextPlugin extends BasePluginClass {
        static getModels() {
          return [{ id: 'tiny-model', contextWindow: 1000, maxOutputTokens: 256 }];
        }
      }

      let plugin = new SmallContextPlugin({});
      plugin._agent = { model: 'tiny-model' };

      // contextWindow=1000 -> charBudget = 1000*4 = 4000 chars
      // Build content that exceeds 4000 chars
      let messages = [];
      for (let i = 0; i < 5; i++) {
        messages.push({ role: 'user', content: 'u'.repeat(1000) });
        messages.push({ role: 'assistant', content: 'a'.repeat(1000) });
      }
      messages.push({ role: 'user', content: 'final' });

      let result = await plugin.truncate(messages, {
        systemPromptText: '',
        behaviorsText:    '',
        instructionsText: '',
        onOverflow:       async () => {},
      });

      let totalChars = result.reduce((sum, m) => {
        return sum + ((typeof m.content === 'string') ? m.content.length : 0);
      }, 0);

      // Should be under ~4000 + some marker overhead
      assert.ok(totalChars <= 4200, `Total chars ${totalChars} should be within small context budget`);
    });

    it('should use first model as fallback when agent model not found', async () => {
      class FallbackPlugin extends BasePluginClass {
        static getModels() {
          return [{ id: 'default-model', contextWindow: 50000, maxOutputTokens: 8000 }];
        }
      }

      let plugin = new FallbackPlugin({});
      plugin._agent = { model: 'nonexistent-model' };

      // Should use first model's contextWindow=50000 -> charBudget = 200000 chars
      let messages = [{ role: 'user', content: 'hello' }];

      let result = await plugin.truncate(messages, {
        systemPromptText: '',
        behaviorsText:    '',
        instructionsText: '',
        onOverflow:       async () => {},
      });

      assert.ok(Array.isArray(result));
    });

    it('should use DEFAULT_CONTEXT_WINDOW fallback when models array is empty', async () => {
      let plugin = new BasePluginClass({});
      // BasePluginClass.getModels() returns [] -> should fall back to 200000

      let messages = [{ role: 'user', content: 'test' }];

      let result = await plugin.truncate(messages, {
        systemPromptText: '',
        behaviorsText:    '',
        instructionsText: '',
        onOverflow:       async () => {},
      });

      assert.ok(Array.isArray(result));
      assert.ok(result.length > 0);
    });
  });
});

// =============================================================================
// BasePluginClass.truncate: adversarial inputs
// =============================================================================

describe('BasePluginClass.truncate: adversarial inputs', () => {
  it('truncate(messages, null) → options defaults apply, does not throw', async () => {
    let plugin   = new BasePluginClass({});
    let messages = [{ role: 'user', content: 'hello' }];

    // options=null → destructuring uses (null || {}) fallback in the impl
    let result = await plugin.truncate(messages, null);
    assert.ok(Array.isArray(result), 'should return array when options is null');
    assert.ok(result.length > 0, 'should return messages when options is null');
  });

  it('onOverflow throws → truncate still returns truncated messages (not rejected)', async () => {
    let plugin = new BasePluginClass({});
    // Trigger overflow: behaviors+instructions > 50% cap (400000 chars for default 200000 window)
    let bigText  = 'x'.repeat(401000);
    let messages = [{ role: 'user', content: 'hello' }];

    // onOverflow throws — should be caught internally
    let result = await plugin.truncate(messages, {
      systemPromptText: '',
      behaviorsText:    bigText,
      instructionsText: '',
      onOverflow:       async () => { throw new Error('boom'); },
    });

    // Must not reject — onOverflow is best-effort
    assert.ok(Array.isArray(result), 'should still return array when onOverflow throws');
  });

  it('contextWindow=0 in getModels() → falls back to DEFAULT_CONTEXT_WINDOW', async () => {
    class ZeroWindowPlugin extends BasePluginClass {
      static getModels() {
        return [{ id: 'zero-model', contextWindow: 0, maxOutputTokens: 256 }];
      }
    }

    let plugin = new ZeroWindowPlugin({});
    plugin._agent = { model: 'zero-model' };

    // contextWindow=0 fails (> 0) check → falls back to 200000 → charBudget = 800000
    // A small message should survive intact
    let messages = [{ role: 'user', content: 'hello zero' }];
    let result   = await plugin.truncate(messages, {});

    assert.ok(Array.isArray(result), 'should return array with zero contextWindow');
    assert.ok(result.length > 0, 'messages should survive fallback to DEFAULT_CONTEXT_WINDOW');
  });

  it('contextWindow=-1 → falls back to DEFAULT_CONTEXT_WINDOW', async () => {
    class NegativeWindowPlugin extends BasePluginClass {
      static getModels() {
        return [{ id: 'neg-model', contextWindow: -1, maxOutputTokens: 256 }];
      }
    }

    let plugin = new NegativeWindowPlugin({});
    plugin._agent = { model: 'neg-model' };

    let messages = [{ role: 'user', content: 'hello negative' }];
    let result   = await plugin.truncate(messages, {});

    assert.ok(Array.isArray(result), 'should return array with negative contextWindow');
    assert.ok(result.length > 0, 'messages should survive fallback to DEFAULT_CONTEXT_WINDOW');
  });

  it("contextWindow='200000' (string) → falls back to DEFAULT_CONTEXT_WINDOW", async () => {
    class StringWindowPlugin extends BasePluginClass {
      static getModels() {
        return [{ id: 'string-model', contextWindow: '200000', maxOutputTokens: 256 }];
      }
    }

    let plugin = new StringWindowPlugin({});
    plugin._agent = { model: 'string-model' };

    // typeof '200000' === 'string' ≠ 'number' → fails the type guard → falls back
    let messages = [{ role: 'user', content: 'hello string' }];
    let result   = await plugin.truncate(messages, {});

    assert.ok(Array.isArray(result), 'should return array with string contextWindow');
    assert.ok(result.length > 0, 'messages should survive fallback to DEFAULT_CONTEXT_WINDOW');
  });

  it('systemPromptText so large charBudget would be negative → clamped to minimum 1024', async () => {
    let plugin = new BasePluginClass({});
    // Default contextWindow = 200000 → charBudget base = 800000 chars
    // systemPromptText of 900000 chars would make budget = 800000 - 900000 = -100000
    // Math.max(1024, -100000) → 1024
    let hugeSystemPrompt = 's'.repeat(900000);
    let messages         = [{ role: 'user', content: 'hi' }];

    // Should not throw — charBudget is clamped to 1024
    let result = await plugin.truncate(messages, {
      systemPromptText: hugeSystemPrompt,
      behaviorsText:    '',
      instructionsText: '',
    });

    assert.ok(Array.isArray(result), 'should return array when systemPrompt is huge');
  });

  it('getModels() returns null → treated as empty array, uses DEFAULT_CONTEXT_WINDOW', async () => {
    class NullModelsPlugin extends BasePluginClass {
      static getModels() {
        return null;
      }
    }

    let plugin   = new NullModelsPlugin({});
    let messages = [{ role: 'user', content: 'hello null models' }];

    // Array.isArray(null) → false → models = [] → falls back to DEFAULT_CONTEXT_WINDOW
    let result = await plugin.truncate(messages, {});

    assert.ok(Array.isArray(result), 'should return array when getModels() returns null');
    assert.ok(result.length > 0, 'messages should survive when getModels() returns null');
  });

  it('getModels() returns non-array object → treated as empty array, uses DEFAULT_CONTEXT_WINDOW', async () => {
    class ObjectModelsPlugin extends BasePluginClass {
      static getModels() {
        return { id: 'some-model', contextWindow: 50000 }; // object, not array
      }
    }

    let plugin   = new ObjectModelsPlugin({});
    let messages = [{ role: 'user', content: 'hello object models' }];

    // Array.isArray({...}) → false → models = [] → falls back to DEFAULT_CONTEXT_WINDOW
    let result = await plugin.truncate(messages, {});

    assert.ok(Array.isArray(result), 'should return array when getModels() returns a non-array object');
    assert.ok(result.length > 0, 'messages should survive when getModels() returns a non-array object');
  });
});
