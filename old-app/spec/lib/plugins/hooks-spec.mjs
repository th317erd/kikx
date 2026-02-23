'use strict';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  HOOK_TYPES,
  executeHook,
  beforeUserMessage,
  afterAgentResponse,
  beforeCommand,
  afterCommand,
  beforeTool,
  afterTool,
} from '../../../server/lib/plugins/hooks.mjs';

describe('Hooks module', () => {
  describe('HOOK_TYPES', () => {
    it('should define BEFORE_USER_MESSAGE', () => {
      assert.equal(HOOK_TYPES.BEFORE_USER_MESSAGE, 'beforeUserMessage');
    });

    it('should define AFTER_AGENT_RESPONSE', () => {
      assert.equal(HOOK_TYPES.AFTER_AGENT_RESPONSE, 'afterAgentResponse');
    });

    it('should define BEFORE_COMMAND', () => {
      assert.equal(HOOK_TYPES.BEFORE_COMMAND, 'beforeCommand');
    });

    it('should define AFTER_COMMAND', () => {
      assert.equal(HOOK_TYPES.AFTER_COMMAND, 'afterCommand');
    });

    it('should define BEFORE_TOOL', () => {
      assert.equal(HOOK_TYPES.BEFORE_TOOL, 'beforeTool');
    });

    it('should define AFTER_TOOL', () => {
      assert.equal(HOOK_TYPES.AFTER_TOOL, 'afterTool');
    });
  });

  describe('executeHook', () => {
    it('should be a function', () => {
      assert.equal(typeof executeHook, 'function');
    });

    it('should return original data when no plugins loaded', async () => {
      // With no plugins installed, the hook should pass through unchanged
      let data   = { test: 'value' };
      let result = await executeHook('beforeUserMessage', data);

      assert.equal(result, data);
    });

    it('should respect AbortSignal', async () => {
      let controller = new AbortController();
      controller.abort();

      await assert.rejects(
        () => executeHook('beforeUserMessage', 'test', {}, controller.signal),
        /aborted/
      );
    });
  });

  describe('hook helper functions', () => {
    it('beforeUserMessage should be a function', () => {
      assert.equal(typeof beforeUserMessage, 'function');
    });

    it('afterAgentResponse should be a function', () => {
      assert.equal(typeof afterAgentResponse, 'function');
    });

    it('beforeCommand should be a function', () => {
      assert.equal(typeof beforeCommand, 'function');
    });

    it('afterCommand should be a function', () => {
      assert.equal(typeof afterCommand, 'function');
    });

    it('beforeTool should be a function', () => {
      assert.equal(typeof beforeTool, 'function');
    });

    it('afterTool should be a function', () => {
      assert.equal(typeof afterTool, 'function');
    });

    it('beforeUserMessage should pass through data when no plugins', async () => {
      let result = await beforeUserMessage('hello', {});
      assert.equal(result, 'hello');
    });

    it('afterAgentResponse should pass through data when no plugins', async () => {
      let response = { content: [{ type: 'text', text: 'Hi' }] };
      let result   = await afterAgentResponse(response, {});
      assert.equal(result, response);
    });

    it('beforeCommand should pass through data when no plugins', async () => {
      let data   = { command: 'test', args: 'arg1' };
      let result = await beforeCommand(data, {});
      assert.equal(result, data);
    });
  });
});
