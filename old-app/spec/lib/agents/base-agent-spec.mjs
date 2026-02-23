'use strict';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { BaseAgent } from '../../../server/lib/agents/base-agent.mjs';

describe('BaseAgent', () => {
  describe('constructor', () => {
    it('should initialize with default values', () => {
      let agent = new BaseAgent();

      assert.equal(agent.apiKey, undefined);
      assert.equal(agent.apiUrl, undefined);
      assert.equal(agent.system, '');
      assert.deepEqual(agent.tools, []);
    });

    it('should accept configuration options', () => {
      let tools = [{ name: 'test_tool' }];
      let agent = new BaseAgent({
        apiKey: 'test-key',
        apiUrl: 'https://test.api',
        system: 'You are a test agent',
        tools:  tools,
      });

      assert.equal(agent.apiKey, 'test-key');
      assert.equal(agent.apiUrl, 'https://test.api');
      assert.equal(agent.system, 'You are a test agent');
      assert.equal(agent.tools, tools);
    });
  });

  describe('sendMessage', () => {
    it('should throw "not implemented" error', async () => {
      let agent = new BaseAgent();

      await assert.rejects(
        () => agent.sendMessage([]),
        /must be implemented/
      );
    });
  });

  describe('sendMessageStream', () => {
    it('should throw "not implemented" error', async () => {
      let agent    = new BaseAgent();
      let iterator = agent.sendMessageStream([]);

      await assert.rejects(
        () => iterator.next(),
        /must be implemented/
      );
    });
  });

  describe('executeTool', () => {
    it('should throw error for unknown tool', async () => {
      let agent = new BaseAgent();

      await assert.rejects(
        () => agent.executeTool('unknown_tool', {}),
        /not found/
      );
    });

    it('should throw error for tool without execute function', async () => {
      let agent = new BaseAgent({
        tools: [{ name: 'no_execute_tool' }],
      });

      await assert.rejects(
        () => agent.executeTool('no_execute_tool', {}),
        /no execute function/
      );
    });

    it('should execute tool with execute function', async () => {
      let agent = new BaseAgent({
        tools: [{
          name:    'test_tool',
          execute: async (input) => `Result: ${input.value}`,
        }],
      });

      let result = await agent.executeTool('test_tool', { value: 42 });

      assert.equal(result, 'Result: 42');
    });

    it('should pass abort signal to tool', async () => {
      let receivedSignal = null;
      let agent = new BaseAgent({
        tools: [{
          name:    'signal_tool',
          execute: async (input, signal) => {
            receivedSignal = signal;
            return 'done';
          },
        }],
      });

      let controller = new AbortController();
      await agent.executeTool('signal_tool', {}, controller.signal);

      assert.equal(receivedSignal, controller.signal);
    });
  });

  describe('getToolDefinitions', () => {
    it('should return empty array when no tools', () => {
      let agent = new BaseAgent();

      assert.deepEqual(agent.getToolDefinitions(), []);
    });

    it('should return tool definitions in API format', () => {
      let agent = new BaseAgent({
        tools: [{
          name:         'my_tool',
          description:  'A test tool',
          input_schema: { type: 'object', properties: {} },
          execute:      async () => 'result',
        }],
      });

      let defs = agent.getToolDefinitions();

      assert.deepEqual(defs, [{
        name:         'my_tool',
        description:  'A test tool',
        input_schema: { type: 'object', properties: {} },
      }]);
    });

    it('should handle inputSchema alias', () => {
      let agent = new BaseAgent({
        tools: [{
          name:        'alias_tool',
          description: 'Uses inputSchema instead',
          inputSchema: { type: 'object' },
        }],
      });

      let defs = agent.getToolDefinitions();

      assert.deepEqual(defs[0].input_schema, { type: 'object' });
    });
  });

  describe('setTools', () => {
    it('should replace tools array', () => {
      let agent = new BaseAgent({ tools: [{ name: 'old' }] });
      let newTools = [{ name: 'new' }];

      agent.setTools(newTools);

      assert.equal(agent.tools, newTools);
    });
  });

  describe('addTool', () => {
    it('should add a tool', () => {
      let agent = new BaseAgent();
      let tool  = { name: 'added_tool' };

      agent.addTool(tool);

      assert.ok(agent.tools.includes(tool));
    });

    it('should replace tool with same name', () => {
      let agent    = new BaseAgent({ tools: [{ name: 'tool', version: 1 }] });
      let newTool  = { name: 'tool', version: 2 };

      agent.addTool(newTool);

      assert.equal(agent.tools.length, 1);
      assert.equal(agent.tools[0].version, 2);
    });
  });
});
