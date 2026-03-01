'use strict';

import { describe, it, before, after } from 'node:test';
import assert                           from 'node:assert/strict';

import { ClaudeAgent, setup }   from '../../plugins/claude-agent/index.mjs';
import { AgentInterface }       from '../../src/core/plugins/agent-interface.mjs';
import { PluginInterface }      from '../../src/core/plugin-loader/plugin-interface.mjs';

// =============================================================================
// Helpers
// =============================================================================

// Create mock SDK stream events matching the Anthropic streaming format.
// Each event is a parsed JSON object with a `type` field.
function createMockEvents(overrides = {}) {
  let {
    text       = '<p>Hello, world!</p>',
    toolCalls  = [],
    thinking   = null,
    inputTokens  = 100,
    outputTokens = 42,
  } = overrides;

  let events = [];

  // message_start
  events.push({
    type:    'message_start',
    message: {
      id:    'msg_mock_123',
      type:  'message',
      role:  'assistant',
      model: 'claude-sonnet-4-20250514',
      usage: { input_tokens: inputTokens, output_tokens: 0 },
    },
  });

  let index = 0;

  // thinking block (if present)
  if (thinking) {
    events.push({
      type:          'content_block_start',
      index,
      content_block: { type: 'thinking', thinking: '' },
    });

    events.push({
      type:  'content_block_delta',
      index,
      delta: { type: 'thinking_delta', thinking },
    });

    events.push({ type: 'content_block_stop', index });
    index++;
  }

  // text block (if present)
  if (text) {
    events.push({
      type:          'content_block_start',
      index,
      content_block: { type: 'text', text: '' },
    });

    events.push({
      type:  'content_block_delta',
      index,
      delta: { type: 'text_delta', text },
    });

    events.push({ type: 'content_block_stop', index });
    index++;
  }

  // tool_use blocks
  for (let tc of toolCalls) {
    events.push({
      type:          'content_block_start',
      index,
      content_block: { type: 'tool_use', id: tc.id || `toolu_${index}`, name: tc.name },
    });

    events.push({
      type:  'content_block_delta',
      index,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(tc.input || {}) },
    });

    events.push({ type: 'content_block_stop', index });
    index++;
  }

  // message_delta + message_stop
  events.push({
    type:  'message_delta',
    delta: { stop_reason: toolCalls.length > 0 ? 'tool_use' : 'end_turn' },
    usage: { output_tokens: outputTokens },
  });

  events.push({ type: 'message_stop' });

  return events;
}

// Testable subclass that overrides _createStream to return mock events
// (replaces the old TestableClaudeAgent that mocked _streamAPI)
class TestableClaudeAgent extends ClaudeAgent {
  constructor(context, mockEvents) {
    super(context);
    this._mockEvents = mockEvents || [];
    this._apiCalls   = [];
  }

  _createClient(_apiKey) {
    // Return a mock client — we override _createStream so it's not used
    return { messages: { stream: () => {} } };
  }

  async *_createStream(_client, systemPrompt, messages, options) {
    this._apiCalls.push({ systemPrompt, messages, options });

    let events = Array.isArray(this._mockEvents[0]) && Array.isArray(this._mockEvents[0])
      ? (this._mockEvents.shift() || [])
      : this._mockEvents;

    for (let event of events)
      yield event;
  }
}

// Multi-turn testable agent: each _createStream call returns the next event set
class MultiTurnTestableAgent extends ClaudeAgent {
  constructor(context, eventSets) {
    super(context);
    this._eventSets = eventSets;
    this._callIndex = 0;
    this._apiCalls  = [];
  }

  _createClient(_apiKey) {
    return { messages: { stream: () => {} } };
  }

  async *_createStream(_client, systemPrompt, messages, options) {
    this._apiCalls.push({ systemPrompt, messages, options });
    let events = this._eventSets[this._callIndex++] || [];

    for (let event of events)
      yield event;
  }
}

function createMockAgent(overrides = {}) {
  return {
    id:              'agent-001',
    name:            'test-claude',
    pluginID:        'claude-agent',
    encryptedAPIKey: 'mock-encrypted-key',
    instructions:    'Be helpful and concise.',
    model:           'claude-sonnet-4-20250514',
    ...overrides,
  };
}

// =============================================================================
// Static Metadata
// =============================================================================

describe('ClaudeAgent - static metadata', () => {
  it('should have pluginId set to "claude-agent"', () => {
    assert.equal(ClaudeAgent.pluginId, 'claude-agent');
  });

  it('should have featureName set to "chat"', () => {
    assert.equal(ClaudeAgent.featureName, 'chat');
  });

  it('should have displayName set to "Claude"', () => {
    assert.equal(ClaudeAgent.displayName, 'Claude');
  });

  it('should have description set correctly', () => {
    assert.equal(ClaudeAgent.description, 'Anthropic Claude AI agent');
  });

  it('should have agentType set to "claude"', () => {
    assert.equal(ClaudeAgent.agentType, 'claude');
  });
});

// =============================================================================
// Class Hierarchy
// =============================================================================

describe('ClaudeAgent - class hierarchy', () => {
  it('should extend AgentInterface', () => {
    assert.ok(ClaudeAgent.prototype instanceof AgentInterface);
  });

  it('should extend PluginInterface (transitively)', () => {
    assert.ok(ClaudeAgent.prototype instanceof PluginInterface);
  });

  it('should create an instance with context', () => {
    let ctx      = { type: 'test' };
    let instance = new ClaudeAgent(ctx);
    assert.ok(instance instanceof ClaudeAgent);
    assert.equal(instance._context, ctx);
  });
});

// =============================================================================
// getCapabilities()
// =============================================================================

describe('ClaudeAgent - getCapabilities()', () => {
  it('should return correct capabilities', () => {
    let instance     = new ClaudeAgent(null);
    let capabilities = instance.getCapabilities();

    assert.deepEqual(capabilities, {
      streaming:  true,
      toolCalls:  true,
      reflection: true,
      images:     false,
    });
  });

  it('should return streaming as true', () => {
    let instance = new ClaudeAgent(null);
    assert.equal(instance.getCapabilities().streaming, true);
  });

  it('should return images as false', () => {
    let instance = new ClaudeAgent(null);
    assert.equal(instance.getCapabilities().images, false);
  });
});

// =============================================================================
// getSystemPrompt()
// =============================================================================

describe('ClaudeAgent - getSystemPrompt()', () => {
  let instance;

  before(() => {
    instance = new ClaudeAgent(null);
  });

  it('should include HTML output instruction', () => {
    let prompt = instance.getSystemPrompt({}, null);
    assert.ok(prompt.includes('Output your responses in HTML format'));
    assert.ok(prompt.includes('Do not use markdown'));
  });

  it('should include base helpful assistant instruction', () => {
    let prompt = instance.getSystemPrompt({}, null);
    assert.ok(prompt.includes('You are a helpful assistant.'));
  });

  it('should append agent instructions when present', () => {
    let prompt = instance.getSystemPrompt({ instructions: 'Always speak like a pirate.' }, null);
    assert.ok(prompt.includes('Always speak like a pirate.'));
    assert.ok(prompt.includes('You are a helpful assistant.'));
    assert.ok(prompt.includes('HTML format'));
  });

  it('should not append instructions when agent has none', () => {
    let prompt = instance.getSystemPrompt({}, null);
    let parts  = prompt.split('\n\n');
    assert.equal(parts.length, 2);
  });

  it('should handle null agent gracefully', () => {
    let prompt = instance.getSystemPrompt(null, null);
    assert.ok(prompt.includes('You are a helpful assistant.'));
    assert.ok(prompt.includes('HTML format'));
  });

  it('should mention standard HTML tags in instruction', () => {
    let prompt = instance.getSystemPrompt({}, null);
    assert.ok(prompt.includes('p, strong, em, code, pre, ul, ol, li, h1-h6, table'));
  });
});

// =============================================================================
// validateConfig()
// =============================================================================

describe('ClaudeAgent - validateConfig()', () => {
  let instance;

  before(() => {
    instance = new ClaudeAgent(null);
  });

  it('should return valid for complete agent config', () => {
    let result = instance.validateConfig(createMockAgent());
    assert.deepEqual(result, { valid: true });
  });

  it('should require encryptedAPIKey', () => {
    let result = instance.validateConfig(createMockAgent({ encryptedAPIKey: null }));
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('encryptedAPIKey')));
  });

  it('should call super.validateConfig (check name)', () => {
    let result = instance.validateConfig({ pluginID: 'claude-agent', encryptedAPIKey: 'key' });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('name')));
  });

  it('should call super.validateConfig (check pluginID)', () => {
    let result = instance.validateConfig({ name: 'test-agent', encryptedAPIKey: 'key' });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('pluginID')));
  });

  it('should fail for null agent', () => {
    let result = instance.validateConfig(null);
    assert.equal(result.valid, false);
  });
});

// =============================================================================
// assembleMessages()
// =============================================================================

describe('ClaudeAgent - assembleMessages()', () => {
  let instance;

  before(() => {
    instance = new ClaudeAgent(null);
  });

  it('should convert user message frames to Anthropic format', () => {
    let messages = [{
      type:       'message',
      content:    { html: '<p>Hello</p>' },
      authorType: 'user',
      authorID:   'user-1',
    }];

    let result = instance.assembleMessages(messages, '');
    assert.equal(result.length, 1);
    assert.equal(result[0].role, 'user');
    assert.equal(result[0].content, '<p>Hello</p>');
  });

  it('should convert agent message frames to assistant role', () => {
    let messages = [{
      type:       'message',
      content:    { html: '<p>Hi there</p>' },
      authorType: 'agent',
      authorID:   'agent-1',
    }];

    let result = instance.assembleMessages(messages, '');
    assert.equal(result.length, 1);
    assert.equal(result[0].role, 'assistant');
    assert.equal(result[0].content, '<p>Hi there</p>');
  });

  it('should convert tool-call frames to assistant with tool_use', () => {
    let messages = [{
      type:       'tool-call',
      content:    { toolName: 'bash', arguments: { command: 'ls' }, toolUseId: 'toolu_001' },
      authorType: 'agent',
      authorID:   'agent-1',
    }];

    let result = instance.assembleMessages(messages, '');
    assert.equal(result.length, 1);
    assert.equal(result[0].role, 'assistant');
    assert.ok(Array.isArray(result[0].content));
    assert.equal(result[0].content[0].type, 'tool_use');
    assert.equal(result[0].content[0].name, 'bash');
    assert.equal(result[0].content[0].id, 'toolu_001');
    assert.deepEqual(result[0].content[0].input, { command: 'ls' });
  });

  it('should convert tool-result frames to user with tool_result', () => {
    let messages = [{
      type:    'tool-result',
      content: { toolUseId: 'toolu_001', output: 'file.txt' },
    }];

    let result = instance.assembleMessages(messages, '');
    assert.equal(result.length, 1);
    assert.equal(result[0].role, 'user');
    assert.ok(Array.isArray(result[0].content));
    assert.equal(result[0].content[0].type, 'tool_result');
    assert.equal(result[0].content[0].tool_use_id, 'toolu_001');
    assert.equal(result[0].content[0].content, 'file.txt');
  });

  it('should skip reflection frames (not sent to API)', () => {
    let messages = [{
      type:       'reflection',
      content:    { text: 'thinking...' },
      hidden:     true,
      authorType: 'agent',
      authorID:   'agent-1',
    }];

    let result = instance.assembleMessages(messages, '');
    assert.equal(result.length, 0);
  });

  it('should handle empty messages array', () => {
    let result = instance.assembleMessages([], '');
    assert.deepEqual(result, []);
  });

  it('should handle null messages', () => {
    let result = instance.assembleMessages(null, '');
    assert.deepEqual(result, []);
  });

  it('should pass through messages already in Anthropic format', () => {
    let messages = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' },
    ];

    let result = instance.assembleMessages(messages, '');
    assert.equal(result.length, 2);
    assert.equal(result[0].role, 'user');
    assert.equal(result[0].content, 'Hello');
    assert.equal(result[1].role, 'assistant');
    assert.equal(result[1].content, 'Hi');
  });

  it('should merge consecutive same-role messages', () => {
    let messages = [
      { role: 'user', content: 'Hello' },
      { role: 'user', content: 'How are you?' },
    ];

    let result = instance.assembleMessages(messages, '');
    assert.equal(result.length, 1);
    assert.equal(result[0].role, 'user');
    assert.ok(result[0].content.includes('Hello'));
    assert.ok(result[0].content.includes('How are you?'));
  });
});

// =============================================================================
// Generator — text content
// =============================================================================

describe('ClaudeAgent - generator (text content)', () => {
  it('should yield a message block from text content', async () => {
    let events   = createMockEvents({ text: '<p>Hello, world!</p>' });
    let agent    = new TestableClaudeAgent(null, events);
    let mockConf = createMockAgent();

    let generator = await agent.execute({
      messages: [],
      agent:    mockConf,
      session:  {},
      context:  null,
      apiKey:   'sk-test-key',
    });

    let first = await generator.next();
    assert.equal(first.value.type, 'message');
    assert.equal(first.value.content.html, '<p>Hello, world!</p>');
    assert.equal(first.value.authorType, 'agent');
    assert.equal(first.value.authorID, 'agent-001');
  });

  it('should yield a done block with usage stats', async () => {
    let events = createMockEvents({
      text:         '<p>Done</p>',
      inputTokens:  200,
      outputTokens: 50,
    });

    let agent     = new TestableClaudeAgent(null, events);
    let generator = await agent.execute({
      messages: [],
      agent:    createMockAgent(),
      session:  {},
      context:  null,
      apiKey:   'sk-test-key',
    });

    await generator.next();
    let done = await generator.next();
    assert.equal(done.value.type, 'done');
    assert.equal(done.value.content.usage.inputTokens, 200);
    assert.equal(done.value.content.usage.outputTokens, 50);
  });

  it('should handle empty response (no text, no tools)', async () => {
    let events = createMockEvents({ text: null, toolCalls: [] });
    let agent  = new TestableClaudeAgent(null, events);

    let generator = await agent.execute({
      messages: [],
      agent:    createMockAgent(),
      session:  {},
      context:  null,
      apiKey:   'sk-test-key',
    });

    let first = await generator.next();
    assert.equal(first.value.type, 'done');
  });
});

// =============================================================================
// Generator — tool calls
// =============================================================================

describe('ClaudeAgent - generator (tool calls)', () => {
  it('should yield a tool-call block from tool_use content', async () => {
    let events = createMockEvents({
      text:      null,
      toolCalls: [{ id: 'toolu_abc', name: 'bash', input: { command: 'echo hi' } }],
    });

    let agent     = new TestableClaudeAgent(null, events);
    let generator = await agent.execute({
      messages: [],
      agent:    createMockAgent(),
      session:  {},
      context:  null,
      apiKey:   'sk-test-key',
    });

    let first = await generator.next();
    assert.equal(first.value.type, 'tool-call');
    assert.equal(first.value.content.toolName, 'bash');
    assert.deepEqual(first.value.content.arguments, { command: 'echo hi' });
    assert.equal(first.value.content.toolUseId, 'toolu_abc');
  });

  it('should handle tool result passed back into generator', async () => {
    let firstEvents = createMockEvents({
      text:      null,
      toolCalls: [{ id: 'toolu_001', name: 'bash', input: { command: 'ls' } }],
    });

    let secondEvents = createMockEvents({
      text:      '<p>Here are your files.</p>',
      toolCalls: [],
    });

    let agent     = new MultiTurnTestableAgent(null, [firstEvents, secondEvents]);
    let generator = await agent.execute({
      messages: [],
      agent:    createMockAgent(),
      session:  {},
      context:  null,
      apiKey:   'sk-test-key',
    });

    let first = await generator.next();
    assert.equal(first.value.type, 'tool-call');

    let second = await generator.next({
      type:    'tool-result',
      content: { output: 'file.txt\nREADME.md', toolUseId: 'toolu_001' },
    });

    assert.equal(second.value.type, 'message');
    assert.equal(second.value.content.html, '<p>Here are your files.</p>');

    let done = await generator.next();
    assert.equal(done.value.type, 'done');
  });

  it('should handle multi-block response (text + tool_use)', async () => {
    let events = createMockEvents({
      text:      '<p>Let me check that for you.</p>',
      toolCalls: [{ id: 'toolu_multi', name: 'search', input: { query: 'test' } }],
    });

    let secondEvents = createMockEvents({ text: '<p>Found it!</p>' });
    let agent        = new MultiTurnTestableAgent(null, [events, secondEvents]);

    let generator = await agent.execute({
      messages: [],
      agent:    createMockAgent(),
      session:  {},
      context:  null,
      apiKey:   'sk-test-key',
    });

    let first = await generator.next();
    assert.equal(first.value.type, 'message');
    assert.equal(first.value.content.html, '<p>Let me check that for you.</p>');

    let second = await generator.next();
    assert.equal(second.value.type, 'tool-call');
    assert.equal(second.value.content.toolName, 'search');

    let third = await generator.next({
      type:    'tool-result',
      content: { output: 'result data', toolUseId: 'toolu_multi' },
    });

    assert.equal(third.value.type, 'message');
    assert.equal(third.value.content.html, '<p>Found it!</p>');
  });
});

// =============================================================================
// Generator — reflection / thinking
// =============================================================================

describe('ClaudeAgent - generator (reflection)', () => {
  it('should yield reflection block from thinking content', async () => {
    let events = createMockEvents({
      thinking: 'Let me think about this carefully...',
      text:     '<p>My answer is 42.</p>',
    });

    let agent     = new TestableClaudeAgent(null, events);
    let generator = await agent.execute({
      messages: [],
      agent:    createMockAgent(),
      session:  {},
      context:  null,
      apiKey:   'sk-test-key',
    });

    let first = await generator.next();
    assert.equal(first.value.type, 'reflection');
    assert.equal(first.value.content.text, 'Let me think about this carefully...');
    assert.equal(first.value.hidden, true);

    let second = await generator.next();
    assert.equal(second.value.type, 'message');
    assert.equal(second.value.content.html, '<p>My answer is 42.</p>');
  });
});

// =============================================================================
// Generator — error handling
// =============================================================================

describe('ClaudeAgent - generator (error handling)', () => {
  it('should throw when no API key is available', async () => {
    let agent = new ClaudeAgent(null);

    let generator = await agent.execute({
      messages: [],
      agent:    createMockAgent({ encryptedAPIKey: null }),
      session:  {},
      context:  null,
    });

    await assert.rejects(
      () => generator.next(),
      { message: /No API key available/ },
    );
  });

  it('should handle API error gracefully', async () => {
    class ErrorAgent extends ClaudeAgent {
      _createClient() { return {}; }
      async *_createStream() {
        throw new Error('Anthropic API error 429: Rate limited');
      }
    }

    let agent     = new ErrorAgent(null);
    let generator = await agent.execute({
      messages: [],
      agent:    createMockAgent(),
      session:  {},
      context:  null,
      apiKey:   'sk-test-key',
    });

    await assert.rejects(
      () => generator.next(),
      { message: /Anthropic API error 429/ },
    );
  });
});

// =============================================================================
// API call format
// =============================================================================

describe('ClaudeAgent - API call format', () => {
  it('should pass system prompt to _createStream', async () => {
    let events = createMockEvents({ text: '<p>Hi</p>' });
    let agent  = new TestableClaudeAgent(null, events);

    let generator = await agent.execute({
      messages: [],
      agent:    createMockAgent({ instructions: 'Be brief.' }),
      session:  {},
      context:  null,
      apiKey:   'sk-test',
    });

    for await (let _block of generator) { /* consume */ }

    assert.ok(agent._apiCalls[0].systemPrompt.includes('You are a helpful assistant.'));
    assert.ok(agent._apiCalls[0].systemPrompt.includes('HTML format'));
    assert.ok(agent._apiCalls[0].systemPrompt.includes('Be brief.'));
  });

  it('should pass model from agent config to options', async () => {
    let events = createMockEvents({ text: '<p>Hi</p>' });
    let agent  = new TestableClaudeAgent(null, events);

    let generator = await agent.execute({
      messages: [],
      agent:    createMockAgent({ model: 'claude-opus-4-20250514' }),
      session:  {},
      context:  null,
      apiKey:   'sk-test',
    });

    for await (let _block of generator) { /* consume */ }

    assert.equal(agent._apiCalls[0].options.model, 'claude-opus-4-20250514');
  });

  it('should assemble messages in Anthropic format before API call', async () => {
    let events = createMockEvents({ text: '<p>Reply</p>' });
    let agent  = new TestableClaudeAgent(null, events);

    let generator = await agent.execute({
      messages: [
        { type: 'message', content: { html: '<p>User says hi</p>' }, authorType: 'user', authorID: 'u1' },
        { type: 'message', content: { html: '<p>Agent replies</p>' }, authorType: 'agent', authorID: 'a1' },
      ],
      agent:   createMockAgent(),
      session: {},
      context: null,
      apiKey:  'sk-test',
    });

    for await (let _block of generator) { /* consume */ }

    let sentMessages = agent._apiCalls[0].messages;
    assert.equal(sentMessages.length, 2);
    assert.equal(sentMessages[0].role, 'user');
    assert.equal(sentMessages[0].content, '<p>User says hi</p>');
    assert.equal(sentMessages[1].role, 'assistant');
    assert.equal(sentMessages[1].content, '<p>Agent replies</p>');
  });
});

// =============================================================================
// Multiple sequential generator calls
// =============================================================================

describe('ClaudeAgent - multiple sequential calls', () => {
  it('should create independent generators with no shared state', async () => {
    let events1 = createMockEvents({ text: '<p>Response 1</p>' });
    let events2 = createMockEvents({ text: '<p>Response 2</p>' });

    let agent1 = new TestableClaudeAgent(null, events1);
    let agent2 = new TestableClaudeAgent(null, events2);

    let params = {
      messages: [],
      agent:    createMockAgent(),
      session:  {},
      context:  null,
      apiKey:   'sk-test',
    };

    let gen1 = await agent1.execute(params);
    let gen2 = await agent2.execute(params);

    let first1 = await gen1.next();
    let first2 = await gen2.next();

    assert.equal(first1.value.content.html, '<p>Response 1</p>');
    assert.equal(first2.value.content.html, '<p>Response 2</p>');
  });
});

// =============================================================================
// setup() export
// =============================================================================

describe('ClaudeAgent - setup() function', () => {
  it('should export a setup function', () => {
    assert.equal(typeof setup, 'function');
  });

  it('should register ClaudeAgent on context agentTypes', () => {
    let agentTypes = new Map();
    let context    = {
      getProperty: (key) => (key === 'agentTypes') ? agentTypes : null,
      setProperty: () => {},
    };

    let teardown = setup({ context });

    assert.equal(agentTypes.get('claude'), ClaudeAgent);
    assert.equal(typeof teardown, 'function');
  });

  it('should create agentTypes map if not present', () => {
    let storedProps = {};
    let context     = {
      getProperty: () => null,
      setProperty: (key, val) => { storedProps[key] = val; },
    };

    let teardown = setup({ context });

    assert.ok(storedProps.agentTypes instanceof Map);
    assert.equal(storedProps.agentTypes.get('claude'), ClaudeAgent);
    assert.equal(typeof teardown, 'function');
  });

  it('should return a teardown closure that removes registration', () => {
    let agentTypes = new Map();
    let context    = {
      getProperty: (key) => (key === 'agentTypes') ? agentTypes : null,
      setProperty: () => {},
    };

    let teardown = setup({ context });
    assert.equal(agentTypes.has('claude'), true);

    teardown();
    assert.equal(agentTypes.has('claude'), false);
  });
});

// =============================================================================
// Generator cleanup
// =============================================================================

describe('ClaudeAgent - generator cleanup', () => {
  it('should support generator.return() for hard-break', async () => {
    let events    = createMockEvents({ text: '<p>Hello</p>' });
    let agent     = new TestableClaudeAgent(null, events);
    let generator = await agent.execute({
      messages: [],
      agent:    createMockAgent(),
      session:  {},
      context:  null,
      apiKey:   'sk-test',
    });

    let first = await generator.next();
    assert.equal(first.value.type, 'message');

    let result = await generator.return();
    assert.equal(result.done, true);

    let after = await generator.next();
    assert.equal(after.done, true);
  });
});
