'use strict';

import { describe, it, beforeEach } from 'node:test';
import assert                       from 'node:assert/strict';

import { AgentInterface } from '../../src/core/plugins/agent-interface.mjs';
import { PluginInterface } from '../../src/core/plugin-loader/plugin-interface.mjs';

// =============================================================================
// Helpers
// =============================================================================

class TestAgent extends AgentInterface {
  static pluginId    = 'test-agent';
  static featureName = 'test';
  static displayName = 'Test Agent';
  static description = 'A test agent for unit tests';
  static agentType   = 'test';

  async *_createGenerator(params) {
    yield { type: 'message', content: { html: '<p>Hello from test agent</p>' }, authorType: 'agent', authorID: 'test-id' };
    yield { type: 'done', content: {} };
  }
}

function createMockAgent(overrides = {}) {
  return {
    name:         'Test Agent',
    pluginID:     'test-agent',
    instructions: 'Be helpful and concise.',
    ...overrides,
  };
}

// =============================================================================
// Class Hierarchy
// =============================================================================

describe('AgentInterface — class hierarchy', () => {
  it('should extend PluginInterface', () => {
    assert.ok(AgentInterface.prototype instanceof PluginInterface);
  });

  it('should have null static metadata by default', () => {
    assert.equal(AgentInterface.pluginId, null);
    assert.equal(AgentInterface.featureName, null);
    assert.equal(AgentInterface.displayName, null);
    assert.equal(AgentInterface.description, null);
    assert.equal(AgentInterface.agentType, null);
  });

  it('should allow subclasses to override static metadata', () => {
    assert.equal(TestAgent.pluginId, 'test-agent');
    assert.equal(TestAgent.featureName, 'test');
    assert.equal(TestAgent.displayName, 'Test Agent');
    assert.equal(TestAgent.description, 'A test agent for unit tests');
    assert.equal(TestAgent.agentType, 'test');
  });

  it('should have agentType as an additional static property beyond PluginInterface', () => {
    // PluginInterface does NOT have agentType
    assert.equal(PluginInterface.agentType, undefined);
    // AgentInterface DOES
    assert.equal(AgentInterface.agentType, null);
  });
});

// =============================================================================
// Construction
// =============================================================================

describe('AgentInterface — construction', () => {
  it('should create an instance with context', () => {
    let context  = { type: 'test-context' };
    let instance = new TestAgent(context);
    assert.ok(instance instanceof AgentInterface);
    assert.ok(instance instanceof PluginInterface);
    assert.equal(instance._context, context);
  });

  it('should create an instance with null context', () => {
    let instance = new TestAgent(null);
    assert.ok(instance instanceof AgentInterface);
    assert.equal(instance._context, null);
  });
});

// =============================================================================
// execute()
// =============================================================================

describe('AgentInterface — execute()', () => {
  let agent;

  beforeEach(() => {
    agent = new TestAgent(null);
  });

  it('should return an async generator', async () => {
    let generator = await agent.execute({
      messages: [],
      agent:    createMockAgent(),
      session:  {},
      context:  null,
    });

    // Async generators have a next method and Symbol.asyncIterator
    assert.equal(typeof generator.next, 'function');
    assert.equal(typeof generator.return, 'function');
    assert.equal(typeof generator[Symbol.asyncIterator], 'function');
  });

  it('should yield blocks when iterated', async () => {
    let generator = await agent.execute({
      messages: [],
      agent:    createMockAgent(),
      session:  {},
      context:  null,
    });

    let blocks = [];

    for await (let block of generator)
      blocks.push(block);

    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].type, 'message');
    assert.equal(blocks[0].content.html, '<p>Hello from test agent</p>');
    assert.equal(blocks[0].authorType, 'agent');
    assert.equal(blocks[0].authorID, 'test-id');
    assert.equal(blocks[1].type, 'done');
  });

  it('should complete (done=true) after all blocks are yielded', async () => {
    let generator = await agent.execute({
      messages: [],
      agent:    createMockAgent(),
      session:  {},
      context:  null,
    });

    await generator.next(); // message
    await generator.next(); // done

    let final = await generator.next();
    assert.equal(final.done, true);
  });
});

// =============================================================================
// _createGenerator()
// =============================================================================

describe('AgentInterface — _createGenerator()', () => {
  it('should throw not-implemented on base AgentInterface', async () => {
    let base      = new AgentInterface(null);
    let generator = await base.execute({});

    await assert.rejects(
      () => generator.next(),
      { message: 'AgentInterface._createGenerator() not implemented' },
    );
  });

  it('should use the subclass name in the error message', async () => {
    class CustomAgent extends AgentInterface {}

    let instance  = new CustomAgent(null);
    let generator = await instance.execute({});

    await assert.rejects(
      () => generator.next(),
      { message: 'CustomAgent._createGenerator() not implemented' },
    );
  });

  it('should work when subclass overrides _createGenerator', async () => {
    let agent     = new TestAgent(null);
    let generator = await agent.execute({ messages: [], agent: createMockAgent(), session: {}, context: null });

    let first = await generator.next();
    assert.equal(first.value.type, 'message');
    assert.equal(first.done, false);
  });
});

// =============================================================================
// Yield protocol — tool-call and tool-result round-trip
// =============================================================================

describe('AgentInterface — yield protocol', () => {
  it('should pass tool results back via yield protocol', async () => {
    class ToolAgent extends AgentInterface {
      static pluginId    = 'tool-agent';
      static featureName = 'tool-test';
      static agentType   = 'tool-test';

      async *_createGenerator(params) {
        let result = yield { type: 'tool-call', content: { toolName: 'bash', arguments: { command: 'echo hi' } }, authorType: 'agent', authorID: 'tool-id' };
        yield { type: 'message', content: { html: `<p>Tool said: ${result.content.output}</p>` }, authorType: 'agent', authorID: 'tool-id' };
        yield { type: 'done', content: {} };
      }
    }

    let agent     = new ToolAgent(null);
    let generator = await agent.execute({ messages: [], agent: createMockAgent({ pluginID: 'tool-agent' }), session: {}, context: null });

    let first = await generator.next();
    assert.equal(first.value.type, 'tool-call');
    assert.equal(first.value.content.toolName, 'bash');

    // Pass tool result back
    let second = await generator.next({ type: 'tool-result', content: { output: 'hello' } });
    assert.equal(second.value.type, 'message');
    assert.ok(second.value.content.html.includes('hello'));

    let third = await generator.next();
    assert.equal(third.value.type, 'done');

    let fourth = await generator.next();
    assert.equal(fourth.done, true);
  });

  it('should handle multiple sequential tool calls', async () => {
    class MultiToolAgent extends AgentInterface {
      static pluginId    = 'multi-tool-agent';
      static featureName = 'multi-tool';
      static agentType   = 'multi-tool';

      async *_createGenerator(params) {
        let result1 = yield { type: 'tool-call', content: { toolName: 'bash', arguments: { command: 'ls' } }, authorType: 'agent', authorID: 'mt-id' };
        let result2 = yield { type: 'tool-call', content: { toolName: 'bash', arguments: { command: 'pwd' } }, authorType: 'agent', authorID: 'mt-id' };
        yield { type: 'message', content: { html: `<p>${result1.content.output} + ${result2.content.output}</p>` }, authorType: 'agent', authorID: 'mt-id' };
        yield { type: 'done', content: {} };
      }
    }

    let agent     = new MultiToolAgent(null);
    let generator = await agent.execute({ messages: [], agent: createMockAgent({ pluginID: 'multi-tool-agent' }), session: {}, context: null });

    let first = await generator.next();
    assert.equal(first.value.content.toolName, 'bash');
    assert.equal(first.value.content.arguments.command, 'ls');

    let second = await generator.next({ type: 'tool-result', content: { output: 'file.txt' } });
    assert.equal(second.value.content.toolName, 'bash');
    assert.equal(second.value.content.arguments.command, 'pwd');

    let third = await generator.next({ type: 'tool-result', content: { output: '/home' } });
    assert.equal(third.value.type, 'message');
    assert.ok(third.value.content.html.includes('file.txt'));
    assert.ok(third.value.content.html.includes('/home'));

    let fourth = await generator.next();
    assert.equal(fourth.value.type, 'done');
  });

  it('should support reflection blocks', async () => {
    class ReflectiveAgent extends AgentInterface {
      static pluginId    = 'reflective-agent';
      static featureName = 'reflective';
      static agentType   = 'reflective';

      async *_createGenerator(params) {
        yield { type: 'reflection', content: { text: 'Let me think about this...' }, hidden: true, authorType: 'agent', authorID: 'r-id' };
        yield { type: 'message', content: { html: '<p>I have an answer.</p>' }, authorType: 'agent', authorID: 'r-id' };
        yield { type: 'done', content: {} };
      }
    }

    let agent     = new ReflectiveAgent(null);
    let generator = await agent.execute({ messages: [], agent: createMockAgent(), session: {}, context: null });

    let first = await generator.next();
    assert.equal(first.value.type, 'reflection');
    assert.equal(first.value.content.text, 'Let me think about this...');
    assert.equal(first.value.hidden, true);

    let second = await generator.next();
    assert.equal(second.value.type, 'message');
  });
});

// =============================================================================
// getSystemPrompt()
// =============================================================================

describe('AgentInterface — getSystemPrompt()', () => {
  let instance;

  beforeEach(() => {
    instance = new TestAgent(null);
  });

  it('should return base prompt when agent has no instructions', () => {
    let prompt = instance.getSystemPrompt({ name: 'Agent' }, null);
    assert.ok(prompt.includes('You are a helpful assistant.'));
    assert.ok(!prompt.includes('undefined'));
  });

  it('should append agent instructions to base prompt', () => {
    let prompt = instance.getSystemPrompt({ name: 'Agent', instructions: 'Always respond in French.' }, null);
    assert.ok(prompt.includes('You are a helpful assistant.'));
    assert.ok(prompt.includes('Always respond in French.'));
  });

  it('should handle null agent gracefully', () => {
    let prompt = instance.getSystemPrompt(null, null);
    assert.ok(prompt.includes('You are a helpful assistant.'));
  });

  it('should handle agent with empty instructions', () => {
    let prompt = instance.getSystemPrompt({ name: 'Agent', instructions: '' }, null);
    assert.ok(prompt.includes('You are a helpful assistant.'));
    // Empty string is falsy, so instructions should not be appended
    assert.ok(!prompt.includes('\n\n'));
  });
});

// =============================================================================
// assembleMessages()
// =============================================================================

describe('AgentInterface — assembleMessages()', () => {
  it('should return messages as-is in base implementation', () => {
    let instance = new TestAgent(null);
    let messages = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
    ];

    let result = instance.assembleMessages(messages, 'system prompt');
    assert.deepEqual(result, messages);
    assert.equal(result, messages); // Same reference — no copy
  });

  it('should return empty array when given empty array', () => {
    let instance = new TestAgent(null);
    let result   = instance.assembleMessages([], 'system prompt');
    assert.deepEqual(result, []);
  });
});

// =============================================================================
// validateConfig()
// =============================================================================

describe('AgentInterface — validateConfig()', () => {
  let instance;

  beforeEach(() => {
    instance = new TestAgent(null);
  });

  it('should return valid for agent with name and pluginID', () => {
    let result = instance.validateConfig({ name: 'My Agent', pluginID: 'test-agent' });
    assert.deepEqual(result, { valid: true });
  });

  it('should return invalid when agent has no name', () => {
    let result = instance.validateConfig({ pluginID: 'test-agent' });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) => error.includes('name')));
  });

  it('should return invalid when agent has no pluginID', () => {
    let result = instance.validateConfig({ name: 'My Agent' });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) => error.includes('pluginID')));
  });

  it('should return multiple errors when agent is missing both', () => {
    let result = instance.validateConfig({});
    assert.equal(result.valid, false);
    assert.equal(result.errors.length, 2);
  });

  it('should return invalid when agent is null', () => {
    let result = instance.validateConfig(null);
    assert.equal(result.valid, false);
    assert.ok(result.errors.length > 0);
  });

  it('should return invalid when agent is undefined', () => {
    let result = instance.validateConfig(undefined);
    assert.equal(result.valid, false);
    assert.ok(result.errors.length > 0);
  });
});

// =============================================================================
// getCapabilities()
// =============================================================================

describe('AgentInterface — getCapabilities()', () => {
  it('should return default capabilities (all false)', () => {
    let instance     = new TestAgent(null);
    let capabilities = instance.getCapabilities();

    assert.deepEqual(capabilities, {
      streaming:  false,
      toolCalls:  false,
      reflection: false,
      images:     false,
    });
  });

  it('should allow subclass to override capabilities', () => {
    class AdvancedAgent extends AgentInterface {
      static pluginId    = 'advanced-agent';
      static featureName = 'advanced';
      static agentType   = 'advanced';

      async *_createGenerator() {
        yield { type: 'done', content: {} };
      }

      getCapabilities() {
        return {
          streaming:  true,
          toolCalls:  true,
          reflection: true,
          images:     false,
        };
      }
    }

    let instance     = new AdvancedAgent(null);
    let capabilities = instance.getCapabilities();

    assert.equal(capabilities.streaming, true);
    assert.equal(capabilities.toolCalls, true);
    assert.equal(capabilities.reflection, true);
    assert.equal(capabilities.images, false);
  });
});

// =============================================================================
// Multiple interactions (no shared state)
// =============================================================================

describe('AgentInterface — multiple interactions', () => {
  it('should create independent generators with no shared state', async () => {
    let agent = new TestAgent(null);
    let params = { messages: [], agent: createMockAgent(), session: {}, context: null };

    let generator1 = await agent.execute(params);
    let generator2 = await agent.execute(params);

    // Both should independently yield their blocks
    let first1 = await generator1.next();
    let first2 = await generator2.next();

    assert.equal(first1.value.type, 'message');
    assert.equal(first2.value.type, 'message');

    // Advancing one should not affect the other
    let second1 = await generator1.next();
    assert.equal(second1.value.type, 'done');

    // generator2 should still be at its second position
    let second2 = await generator2.next();
    assert.equal(second2.value.type, 'done');
  });
});

// =============================================================================
// Generator cleanup (hard-break)
// =============================================================================

describe('AgentInterface — generator cleanup', () => {
  it('should support generator.return() for hard-break', async () => {
    let agent     = new TestAgent(null);
    let generator = await agent.execute({ messages: [], agent: createMockAgent(), session: {}, context: null });

    // Start iterating
    let first = await generator.next();
    assert.equal(first.value.type, 'message');

    // Hard-break — kernel destroys generator (e.g., permission needed)
    let result = await generator.return();
    assert.equal(result.done, true);

    // Subsequent calls should also be done
    let after = await generator.next();
    assert.equal(after.done, true);
  });

  it('should support generator.throw() for error injection', async () => {
    let agent     = new TestAgent(null);
    let generator = await agent.execute({ messages: [], agent: createMockAgent(), session: {}, context: null });

    await generator.next(); // message

    await assert.rejects(
      () => generator.throw(new Error('kernel error')),
      { message: 'kernel error' },
    );

    // Generator should be done after throw
    let after = await generator.next();
    assert.equal(after.done, true);
  });
});

// =============================================================================
// Index re-export
// =============================================================================

describe('AgentInterface — index re-export', () => {
  it('should be importable from plugins/index.mjs', async () => {
    let { AgentInterface: Imported } = await import('../../src/core/plugins/index.mjs');
    assert.equal(Imported, AgentInterface);
  });
});
