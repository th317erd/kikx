'use strict';

import { describe, it, beforeEach } from 'node:test';
import assert                       from 'node:assert/strict';

import { PrimerAssembler }  from '../../src/core/primer/index.mjs';
import { PluginRegistry }   from '../../src/core/plugin-loader/registry.mjs';

// =============================================================================
// Helpers
// =============================================================================

function createMockContext(overrides = {}) {
  let properties = new Map();

  let context = {
    getProperty:  (key) => properties.get(key) || null,
    setProperty:  (key, value) => properties.set(key, value),
    ...overrides,
  };

  return { context, properties };
}

// =============================================================================
// PrimerAssembler
// =============================================================================

describe('PrimerAssembler', () => {
  let registry;
  let context;
  let properties;
  let assembler;

  beforeEach(() => {
    registry = new PluginRegistry();
    ({ context, properties } = createMockContext());
    properties.set('pluginRegistry', registry);
    assembler = new PrimerAssembler(context);
  });

  // ---------------------------------------------------------------------------
  // assemble()
  // ---------------------------------------------------------------------------

  describe('assemble', () => {
    it('should return content wrapped with instruction boundaries', () => {
      let result = assembler.assemble({});
      assert.ok(result.startsWith('--- START OF INSTRUCTIONS ---\n'));
      assert.ok(result.endsWith('\n--- END OF INSTRUCTIONS ---'));
    });

    it('should include core instructions when no agent or plugins', () => {
      let result = assembler.assemble({});
      assert.ok(result.includes('You are an AI assistant running inside Kikx'));
      assert.ok(result.includes('OUTPUT FORMAT:'));
      assert.ok(result.includes('TOOL DISCOVERY:'));
      assert.ok(result.includes('THINKING:'));
      assert.ok(result.includes('USER PROMPTS:'));
    });

    it('should include agent instructions when present', () => {
      let agent  = { instructions: 'You are a coding assistant. Be helpful.' };
      let result = assembler.assemble(agent);
      assert.ok(result.includes('You are a coding assistant. Be helpful.'));
    });

    it('should include agent dmSummary when present', () => {
      let agent  = { dmSummary: 'This agent specializes in data analysis.' };
      let result = assembler.assemble(agent);
      assert.ok(result.includes('This agent specializes in data analysis.'));
    });

    it('should include both agent instructions and dmSummary', () => {
      let agent = {
        instructions: 'Be concise.',
        dmSummary:    'Expert in Python.',
      };

      let result = assembler.assemble(agent);
      assert.ok(result.includes('Be concise.'));
      assert.ok(result.includes('Expert in Python.'));
    });

    it('should include plugin-registered instructions', () => {
      registry.registerInstructions('test-plugin', 'Use test-plugin:run to execute tests.');
      let result = assembler.assemble({});
      assert.ok(result.includes('Use test-plugin:run to execute tests.'));
    });

    it('should sort plugin instructions by priority', () => {
      registry.registerInstructions('low-priority', 'LOW PRIORITY CONTENT', { priority: 200 });
      registry.registerInstructions('high-priority', 'HIGH PRIORITY CONTENT', { priority: 10 });

      let result     = assembler.assemble({});
      let highIndex  = result.indexOf('HIGH PRIORITY CONTENT');
      let lowIndex   = result.indexOf('LOW PRIORITY CONTENT');

      assert.ok(highIndex < lowIndex, 'High priority should appear before low priority');
    });

    it('should include core + plugins + agent in correct order', () => {
      registry.registerInstructions('my-plugin', 'PLUGIN INSTRUCTION HERE', { priority: 80 });
      let agent = { instructions: 'AGENT INSTRUCTION HERE' };

      let result      = assembler.assemble(agent);
      let coreIndex   = result.indexOf('You are an AI assistant running inside Kikx');
      let pluginIndex = result.indexOf('PLUGIN INSTRUCTION HERE');
      let agentIndex  = result.indexOf('AGENT INSTRUCTION HERE');

      assert.ok(coreIndex >= 0, 'Core instructions should be present');
      assert.ok(pluginIndex >= 0, 'Plugin instructions should be present');
      assert.ok(agentIndex >= 0, 'Agent instructions should be present');
      assert.ok(coreIndex < pluginIndex, 'Core should come before plugin');
      assert.ok(pluginIndex < agentIndex, 'Plugin should come before agent');
    });

    it('should handle null agent gracefully', () => {
      let result = assembler.assemble(null);
      assert.ok(result.includes('--- START OF INSTRUCTIONS ---'));
      assert.ok(result.includes('--- END OF INSTRUCTIONS ---'));
    });

    it('should handle undefined agent gracefully', () => {
      let result = assembler.assemble(undefined);
      assert.ok(result.includes('--- START OF INSTRUCTIONS ---'));
    });

    it('should handle agent with no instructions or dmSummary', () => {
      let result = assembler.assemble({ name: 'test-agent' });
      assert.ok(result.includes('You are an AI assistant running inside Kikx'));
      assert.ok(!result.includes('undefined'));
    });

    it('should work when pluginRegistry is not on context', () => {
      properties.delete('pluginRegistry');
      let result = assembler.assemble({});
      assert.ok(result.includes('--- START OF INSTRUCTIONS ---'));
      assert.ok(result.includes('You are an AI assistant running inside Kikx'));
    });

    it('should include multiple plugin instructions', () => {
      registry.registerInstructions('plugin-a', 'INSTRUCTION A');
      registry.registerInstructions('plugin-b', 'INSTRUCTION B');

      let result = assembler.assemble({});
      assert.ok(result.includes('INSTRUCTION A'));
      assert.ok(result.includes('INSTRUCTION B'));
    });

    // -------------------------------------------------------------------------
    // Abilities injection
    // -------------------------------------------------------------------------

    it('should include abilities section when agent has abilities', () => {
      let agent = {
        instructions:  'Be helpful.',
        getAbilities:  () => 'Never deploy on Fridays.',
        hasAbilities:  () => true,
      };

      let result = assembler.assemble(agent);
      assert.ok(result.includes('--- ABILITIES ---'));
      assert.ok(result.includes('Never deploy on Fridays.'));
      assert.ok(result.includes('--- END ABILITIES ---'));
    });

    it('should NOT include abilities section when agent has no abilities', () => {
      let agent = {
        instructions:  'Be helpful.',
        getAbilities:  () => null,
        hasAbilities:  () => false,
      };

      let result = assembler.assemble(agent);
      assert.ok(!result.includes('--- ABILITIES ---'));
      assert.ok(!result.includes('--- END ABILITIES ---'));
    });

    it('should place abilities section after agent instructions', () => {
      let agent = {
        instructions:  'AGENT INSTRUCTIONS HERE',
        getAbilities:  () => 'ABILITIES TEXT HERE',
        hasAbilities:  () => true,
      };

      let result        = assembler.assemble(agent);
      let instrIndex    = result.indexOf('AGENT INSTRUCTIONS HERE');
      let abilitiesIndex = result.indexOf('ABILITIES TEXT HERE');

      assert.ok(instrIndex >= 0, 'Agent instructions should be present');
      assert.ok(abilitiesIndex >= 0, 'Abilities text should be present');
      assert.ok(instrIndex < abilitiesIndex, 'Instructions should come before abilities');
    });

    it('should wrap abilities text in clear delimiters', () => {
      let agent = {
        getAbilities:  () => 'Rule 1: Check tests.\nRule 2: No force push.',
        hasAbilities:  () => true,
      };

      let result = assembler.assemble(agent);
      assert.ok(result.includes('--- ABILITIES ---\nRule 1: Check tests.\nRule 2: No force push.\n--- END ABILITIES ---'));
    });

    it('should append abilities reminder footer when abilities exist', () => {
      let agent = {
        getAbilities:  () => 'Some ability text.',
        hasAbilities:  () => true,
      };

      let result = assembler.assemble(agent);
      assert.ok(result.includes('Remember to check each user request against your ABILITIES before proceeding.'));
    });

    it('should NOT append abilities reminder footer when no abilities', () => {
      let agent = {
        getAbilities:  () => null,
        hasAbilities:  () => false,
      };

      let result = assembler.assemble(agent);
      assert.ok(!result.includes('Remember to check each user request against your ABILITIES'));
    });

    it('should still work with null agent (no abilities section)', () => {
      let result = assembler.assemble(null);
      assert.ok(!result.includes('--- ABILITIES ---'));
      assert.ok(result.includes('--- START OF INSTRUCTIONS ---'));
    });

    it('should work with agent that has instructions but no abilities methods', () => {
      let agent  = { instructions: 'Be helpful.' };
      let result = assembler.assemble(agent);
      assert.ok(result.includes('Be helpful.'));
      assert.ok(!result.includes('--- ABILITIES ---'));
    });

    // -------------------------------------------------------------------------
    // Management instructions (always present)
    // -------------------------------------------------------------------------

    it('should always include management instructions even when agent has no abilities', () => {
      let agent = {
        instructions:  'Be helpful.',
        getAbilities:  () => null,
        hasAbilities:  () => false,
      };

      let result = assembler.assemble(agent);
      assert.ok(result.includes('memory:updateAgentConfig'));
    });

    it('should mention memory:updateAgentConfig in management instructions', () => {
      let agent = {
        instructions:  'Be helpful.',
        getAbilities:  () => 'Some ability.',
        hasAbilities:  () => true,
      };

      let result = assembler.assemble(agent);
      assert.ok(result.includes('memory:updateAgentConfig'));
      assert.ok(result.includes('abilities'));
    });
  });

  // ---------------------------------------------------------------------------
  // wrapMessage()
  // ---------------------------------------------------------------------------

  describe('wrapMessage', () => {
    it('should concatenate primer and user message with blank line', () => {
      let result = assembler.wrapMessage('PRIMER', 'Hello');
      assert.equal(result, 'PRIMER\n\nHello');
    });

    it('should return user message when primer is null', () => {
      let result = assembler.wrapMessage(null, 'Hello');
      assert.equal(result, 'Hello');
    });

    it('should return user message when primer is empty string', () => {
      let result = assembler.wrapMessage('', 'Hello');
      assert.equal(result, 'Hello');
    });

    it('should return primer when user message is null', () => {
      let result = assembler.wrapMessage('PRIMER', null);
      assert.equal(result, 'PRIMER');
    });

    it('should return primer when user message is empty string', () => {
      let result = assembler.wrapMessage('PRIMER', '');
      assert.equal(result, 'PRIMER');
    });

    it('should return empty string when both are null', () => {
      let result = assembler.wrapMessage(null, null);
      assert.equal(result, '');
    });

    it('should return empty string when both are empty', () => {
      let result = assembler.wrapMessage('', '');
      assert.equal(result, '');
    });
  });
});

// =============================================================================
// PluginRegistry — Instructions
// =============================================================================

describe('PluginRegistry — Instructions', () => {
  let registry;

  beforeEach(() => {
    registry = new PluginRegistry();
  });

  it('should register and retrieve instructions', () => {
    registry.registerInstructions('test-plugin', 'Use this tool wisely.');
    let instructions = registry.getInstructions();
    assert.equal(instructions.length, 1);
    assert.equal(instructions[0].pluginName, 'test-plugin');
    assert.equal(instructions[0].content, 'Use this tool wisely.');
    assert.equal(instructions[0].priority, 100);
  });

  it('should default priority to 100', () => {
    registry.registerInstructions('my-plugin', 'Do something.');
    assert.equal(registry.getInstructions()[0].priority, 100);
  });

  it('should accept custom priority', () => {
    registry.registerInstructions('core-plugin', 'Core stuff.', { priority: 10 });
    assert.equal(registry.getInstructions()[0].priority, 10);
  });

  it('should accept priority of 0', () => {
    registry.registerInstructions('system', 'System instruction.', { priority: 0 });
    assert.equal(registry.getInstructions()[0].priority, 0);
  });

  it('should sort by priority ascending', () => {
    registry.registerInstructions('low', 'Low priority.', { priority: 200 });
    registry.registerInstructions('high', 'High priority.', { priority: 10 });
    registry.registerInstructions('default', 'Default priority.');

    let instructions = registry.getInstructions();
    assert.equal(instructions[0].pluginName, 'high');
    assert.equal(instructions[1].pluginName, 'default');
    assert.equal(instructions[2].pluginName, 'low');
  });

  it('should throw if content is empty string', () => {
    assert.throws(
      () => registry.registerInstructions('bad', ''),
      { message: 'Instruction content must be a non-empty string' },
    );
  });

  it('should throw if content is null', () => {
    assert.throws(
      () => registry.registerInstructions('bad', null),
      { message: 'Instruction content must be a non-empty string' },
    );
  });

  it('should throw if content is not a string', () => {
    assert.throws(
      () => registry.registerInstructions('bad', 123),
      { message: 'Instruction content must be a non-empty string' },
    );
  });

  it('should return a defensive copy from getInstructions', () => {
    registry.registerInstructions('plugin-a', 'Instruction A.');
    let instructions = registry.getInstructions();
    instructions.push({ pluginName: 'fake', content: 'Injected.', priority: 0 });

    assert.equal(registry.getInstructions().length, 1);
  });

  it('should allow multiple instructions from same plugin', () => {
    registry.registerInstructions('plugin-a', 'First instruction.');
    registry.registerInstructions('plugin-a', 'Second instruction.');

    let instructions = registry.getInstructions();
    assert.equal(instructions.length, 2);
  });
});

// =============================================================================
// InteractionLoop — Primer Helpers
// =============================================================================

describe('InteractionLoop — Primer Helpers', () => {
  // We test _isFirstMessage and _injectPrimer by importing the class
  // and calling the methods directly (they're stateless helpers).

  let InteractionLoop;

  beforeEach(async () => {
    let module = await import('../../src/core/interaction/index.mjs');
    InteractionLoop = module.InteractionLoop;
  });

  describe('_isFirstMessage', () => {
    // Create a minimal instance with a mock context
    function createLoop() {
      return new InteractionLoop({
        getProperty: () => null,
      });
    }

    it('should return true for empty frames', () => {
      let loop = createLoop();
      assert.equal(loop._isFirstMessage([]), true);
    });

    it('should return true for single user-message with no assistant reply', () => {
      let loop   = createLoop();
      let frames = [
        { type: 'user-message', deleted: false },
      ];

      assert.equal(loop._isFirstMessage(frames), true);
    });

    it('should return false when assistant message exists', () => {
      let loop   = createLoop();
      let frames = [
        { type: 'user-message', deleted: false },
        { type: 'message', deleted: false },
      ];

      assert.equal(loop._isFirstMessage(frames), false);
    });

    it('should return false for multiple user messages', () => {
      let loop   = createLoop();
      let frames = [
        { type: 'user-message', deleted: false },
        { type: 'message', deleted: false },
        { type: 'user-message', deleted: false },
      ];

      assert.equal(loop._isFirstMessage(frames), false);
    });

    it('should ignore deleted frames', () => {
      let loop   = createLoop();
      let frames = [
        { type: 'user-message', deleted: true },
        { type: 'message', deleted: true },
        { type: 'user-message', deleted: false },
      ];

      assert.equal(loop._isFirstMessage(frames), true);
    });

    it('should not count non-message frame types', () => {
      let loop   = createLoop();
      let frames = [
        { type: 'tool-call', deleted: false },
        { type: 'tool-result', deleted: false },
        { type: 'user-message', deleted: false },
      ];

      assert.equal(loop._isFirstMessage(frames), true);
    });
  });

  describe('_injectPrimer', () => {
    function createLoop() {
      return new InteractionLoop({
        getProperty: () => null,
      });
    }

    it('should return primer-only message for empty array', () => {
      let loop   = createLoop();
      let result = loop._injectPrimer([], 'PRIMER');
      assert.deepEqual(result, [{ role: 'user', content: 'PRIMER' }]);
    });

    it('should return primer-only message for null', () => {
      let loop   = createLoop();
      let result = loop._injectPrimer(null, 'PRIMER');
      assert.deepEqual(result, [{ role: 'user', content: 'PRIMER' }]);
    });

    it('should prepend primer to first user message content', () => {
      let loop     = createLoop();
      let messages = [{ role: 'user', content: 'Hello' }];
      let result   = loop._injectPrimer(messages, 'PRIMER');

      assert.equal(result.length, 1);
      assert.equal(result[0].role, 'user');
      assert.equal(result[0].content, 'PRIMER\n\nHello');
    });

    it('should only modify the first user message', () => {
      let loop     = createLoop();
      let messages = [
        { role: 'user', content: 'First' },
        { role: 'assistant', content: 'Reply' },
        { role: 'user', content: 'Second' },
      ];

      let result = loop._injectPrimer(messages, 'PRIMER');
      assert.equal(result[0].content, 'PRIMER\n\nFirst');
      assert.equal(result[2].content, 'Second');
    });

    it('should not mutate the original messages array', () => {
      let loop     = createLoop();
      let original = [{ role: 'user', content: 'Hello' }];
      let result   = loop._injectPrimer(original, 'PRIMER');

      assert.equal(original[0].content, 'Hello');
      assert.notEqual(original, result);
    });

    it('should handle user message with empty content', () => {
      let loop     = createLoop();
      let messages = [{ role: 'user', content: '' }];
      let result   = loop._injectPrimer(messages, 'PRIMER');
      assert.equal(result[0].content, 'PRIMER\n\n');
    });

    it('should handle user message with null content', () => {
      let loop     = createLoop();
      let messages = [{ role: 'user', content: null }];
      let result   = loop._injectPrimer(messages, 'PRIMER');
      assert.equal(result[0].content, 'PRIMER\n\n');
    });

    it('should skip non-user messages until finding a user message', () => {
      let loop     = createLoop();
      let messages = [
        { role: 'assistant', content: 'Intro' },
        { role: 'user', content: 'Question' },
      ];

      let result = loop._injectPrimer(messages, 'PRIMER');
      assert.equal(result[0].content, 'Intro');
      assert.equal(result[1].content, 'PRIMER\n\nQuestion');
    });
  });
});

// =============================================================================
// PluginLoader — registerInstructions via context
// =============================================================================

describe('PluginLoader — registerInstructions via context', () => {
  let PluginLoader;
  let PluginRegistry;

  beforeEach(async () => {
    let module = await import('../../src/core/plugin-loader/index.mjs');
    PluginLoader   = module.PluginLoader;
    PluginRegistry = module.PluginRegistry;
  });

  it('should expose registerInstructions in plugin context', async () => {
    let receivedContext = null;

    let loader = new PluginLoader({ type: 'test-context' });
    let module = {
      setup: (context) => {
        receivedContext = context;
      },
    };

    await loader.loadPlugin('instruction-test', module);
    assert.ok(typeof receivedContext.registerInstructions === 'function');
  });

  it('should curry pluginName into registerInstructions', async () => {
    let loader = new PluginLoader({ type: 'test-context' });
    let module = {
      setup: (context) => {
        context.registerInstructions('Test instruction content.');
      },
    };

    await loader.loadPlugin('my-plugin', module);

    let registry     = loader.getRegistry();
    let instructions = registry.getInstructions();

    assert.equal(instructions.length, 1);
    assert.equal(instructions[0].pluginName, 'my-plugin');
    assert.equal(instructions[0].content, 'Test instruction content.');
  });

  it('should pass options through to registerInstructions', async () => {
    let loader = new PluginLoader({ type: 'test-context' });
    let module = {
      setup: (context) => {
        context.registerInstructions('High priority content.', { priority: 10 });
      },
    };

    await loader.loadPlugin('priority-plugin', module);

    let registry     = loader.getRegistry();
    let instructions = registry.getInstructions();

    assert.equal(instructions[0].priority, 10);
  });
});
