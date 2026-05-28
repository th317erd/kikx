'use strict';

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { PluginRegistry }  from '../../../src/core/plugin-loader/registry.mjs';
import { HookService }     from '../../../src/core/hooks/hook-service.mjs';
import { BasePluginClass } from '../../../src/core/routing/base-plugin-class.mjs';

// =============================================================================
// Phase C4 — HookService Tests
// =============================================================================

describe('HookService (C4)', () => {
  let registry;
  let service;

  beforeEach(() => {
    registry = new PluginRegistry();
    service  = new HookService(registry);
  });

  // ---------------------------------------------------------------------------
  // Construction
  // ---------------------------------------------------------------------------

  describe('construction', () => {
    it('should create with registry', () => {
      assert.ok(service);
    });

    it('should throw without registry', () => {
      assert.throws(() => new HookService(null), /requires/);
    });
  });

  // ---------------------------------------------------------------------------
  // No handlers
  // ---------------------------------------------------------------------------

  describe('no handlers', () => {
    it('should return pass with original message when no handlers registered', async () => {
      let result = await service.run('prepareMessage', {
        source:  'user',
        target:  'agent',
        message: 'hello',
      });

      assert.equal(result.action, 'pass');
      assert.equal(result.message, 'hello');
    });
  });

  // ---------------------------------------------------------------------------
  // Legacy handler compatibility
  // ---------------------------------------------------------------------------

  describe('legacy handler compatibility', () => {
    it('should run legacy handlers registered via registerHook', async () => {
      registry.registerHook('prepareMessage', (payload) => {
        return { action: 'modify', message: payload.message + ' modified' };
      });

      let result = await service.run('prepareMessage', {
        source:  'user',
        target:  'agent',
        message: 'original',
      });

      assert.equal(result.action, 'pass');
      assert.equal(result.message, 'original modified');
    });

    it('should handle legacy block action', async () => {
      registry.registerHook('prepareMessage', () => {
        return { action: 'block', reason: 'spam detected' };
      });

      let result = await service.run('prepareMessage', {
        source:  'user',
        target:  'agent',
        message: 'spam',
      });

      assert.equal(result.action, 'block');
      assert.equal(result.reason, 'spam detected');
    });

    it('should handle legacy redirect action', async () => {
      registry.registerHook('prepareMessage', () => {
        return { action: 'redirect', target: 'other-agent', message: 'redirected' };
      });

      let result = await service.run('prepareMessage', {
        source:  'user',
        target:  'agent',
        message: 'test',
      });

      assert.equal(result.action, 'redirect');
      assert.equal(result.target, 'other-agent');
    });

    it('should handle null return from legacy handler', async () => {
      registry.registerHook('prepareMessage', () => null);

      let result = await service.run('prepareMessage', {
        source:  'user',
        target:  'agent',
        message: 'unchanged',
      });

      assert.equal(result.action, 'pass');
      assert.equal(result.message, 'unchanged');
    });

    it('should chain multiple legacy handlers', async () => {
      registry.registerHook('prepareMessage', (payload) => {
        return { action: 'modify', message: payload.message + ' [first]' };
      });

      registry.registerHook('prepareMessage', (payload) => {
        return { action: 'modify', message: payload.message + ' [second]' };
      });

      let result = await service.run('prepareMessage', {
        source:  'user',
        target:  'agent',
        message: 'start',
      });

      assert.equal(result.message, 'start [first] [second]');
    });
  });

  // ---------------------------------------------------------------------------
  // Routing plugin handlers
  // ---------------------------------------------------------------------------

  describe('routing plugin handlers', () => {
    it('should run plugin handlers registered via registerSelector', async () => {
      class ModifyPlugin extends BasePluginClass {
        async process(next) {
          this._context.message = this._context.message + ' [plugin]';
          return await next(this._context);
        }
      }

      registry.registerSelector('hook:user-to-agent', ModifyPlugin);

      let result = await service.run('prepareMessage', {
        source:  'user',
        target:  'agent',
        message: 'hello',
      });

      assert.equal(result.message, 'hello [plugin]');
    });

    it('should handle block from plugin', async () => {
      class BlockPlugin extends BasePluginClass {
        async process(next, done) {
          this._context.action = 'block';
          this._context.reason = 'blocked by plugin';
          return await done(this._context);
        }
      }

      registry.registerSelector('hook:user-to-agent', BlockPlugin);

      let result = await service.run('prepareMessage', {
        source:  'user',
        target:  'agent',
        message: 'test',
      });

      assert.equal(result.action, 'block');
      assert.equal(result.reason, 'blocked by plugin');
    });

    it('should pass through when plugin calls next without changes', async () => {
      class PassPlugin extends BasePluginClass {
        async process(next) {
          return await next(this._context);
        }
      }

      registry.registerSelector('hook:agent-to-user', PassPlugin);

      let result = await service.run('prepareMessage', {
        source:  'agent',
        target:  'user',
        message: 'unchanged',
      });

      assert.equal(result.action, 'pass');
      assert.equal(result.message, 'unchanged');
    });

    it('should chain multiple plugin handlers', async () => {
      class FirstPlugin extends BasePluginClass {
        async process(next) {
          this._context.message = this._context.message + ' [A]';
          return await next(this._context);
        }
      }

      class SecondPlugin extends BasePluginClass {
        async process(next) {
          this._context.message = this._context.message + ' [B]';
          return await next(this._context);
        }
      }

      registry.registerSelector('hook:agent-to-tool', FirstPlugin);
      registry.registerSelector('hook:agent-to-tool', SecondPlugin);

      let result = await service.run('prepareMessage', {
        source:  'agent',
        target:  'tool',
        message: 'start',
      });

      assert.equal(result.message, 'start [A] [B]');
    });

    it('should stop chain on block', async () => {
      let secondCalled = false;

      class BlockPlugin extends BasePluginClass {
        async process(next, done) {
          this._context.action = 'block';
          return await done(this._context);
        }
      }

      class SecondPlugin extends BasePluginClass {
        async process(next) {
          secondCalled = true;
          return await next(this._context);
        }
      }

      registry.registerSelector('hook:tool-to-agent', BlockPlugin);
      registry.registerSelector('hook:tool-to-agent', SecondPlugin);

      let result = await service.run('prepareMessage', {
        source:  'tool',
        target:  'agent',
        message: 'test',
      });

      assert.equal(result.action, 'block');
      assert.equal(secondCalled, false);
    });
  });

  // ---------------------------------------------------------------------------
  // Mixed handlers (legacy + plugins)
  // ---------------------------------------------------------------------------

  describe('mixed handlers', () => {
    it('should run legacy handlers before plugins', async () => {
      let order = [];

      registry.registerHook('prepareMessage', (payload) => {
        order.push('legacy');
        return { action: 'modify', message: payload.message + ' [legacy]' };
      });

      class PluginHandler extends BasePluginClass {
        async process(next) {
          order.push('plugin');
          this._context.message = this._context.message + ' [plugin]';
          return await next(this._context);
        }
      }

      registry.registerSelector('hook:user-to-agent', PluginHandler);

      let result = await service.run('prepareMessage', {
        source:  'user',
        target:  'agent',
        message: 'start',
      });

      assert.deepEqual(order, ['legacy', 'plugin']);
      assert.equal(result.message, 'start [legacy] [plugin]');
    });

    it('should stop plugins if legacy handler blocks', async () => {
      let pluginCalled = false;

      registry.registerHook('prepareMessage', () => {
        return { action: 'block', reason: 'legacy block' };
      });

      class PluginHandler extends BasePluginClass {
        async process(next) {
          pluginCalled = true;
          return await next(this._context);
        }
      }

      registry.registerSelector('hook:user-to-agent', PluginHandler);

      let result = await service.run('prepareMessage', {
        source:  'user',
        target:  'agent',
        message: 'test',
      });

      assert.equal(result.action, 'block');
      assert.equal(pluginCalled, false);
    });
  });

  // ---------------------------------------------------------------------------
  // Selector mapping
  // ---------------------------------------------------------------------------

  describe('selector mapping', () => {
    it('should map user/agent to hook:user-to-agent', async () => {
      let called = false;

      class TestPlugin extends BasePluginClass {
        async process(next) {
          called = true;
          return await next(this._context);
        }
      }

      registry.registerSelector('hook:user-to-agent', TestPlugin);

      await service.run('prepareMessage', {
        source: 'user', target: 'agent', message: 'test',
      });

      assert.equal(called, true);
    });

    it('should map agent/tool to hook:agent-to-tool', async () => {
      let called = false;

      class TestPlugin extends BasePluginClass {
        async process(next) {
          called = true;
          return await next(this._context);
        }
      }

      registry.registerSelector('hook:agent-to-tool', TestPlugin);

      await service.run('prepareMessage', {
        source: 'agent', target: 'tool', message: 'test',
      });

      assert.equal(called, true);
    });

    it('should NOT match plugins with different hook selector', async () => {
      let called = false;

      class TestPlugin extends BasePluginClass {
        async process(next) {
          called = true;
          return await next(this._context);
        }
      }

      registry.registerSelector('hook:agent-to-user', TestPlugin);

      await service.run('prepareMessage', {
        source: 'user', target: 'agent', message: 'test',
      });

      assert.equal(called, false);
    });
  });

  // ---------------------------------------------------------------------------
  // Error handling
  // ---------------------------------------------------------------------------

  describe('error handling', () => {
    it('should propagate errors from plugin handlers', async () => {
      class ErrorPlugin extends BasePluginClass {
        async process() {
          throw new Error('plugin error');
        }
      }

      registry.registerSelector('hook:user-to-agent', ErrorPlugin);

      await assert.rejects(
        () => service.run('prepareMessage', {
          source: 'user', target: 'agent', message: 'test',
        }),
        /plugin error/,
      );
    });

    it('should propagate errors from legacy handlers', async () => {
      registry.registerHook('prepareMessage', () => {
        throw new Error('legacy error');
      });

      await assert.rejects(
        () => service.run('prepareMessage', {
          source: 'user', target: 'agent', message: 'test',
        }),
        /legacy error/,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Context preservation
  // ---------------------------------------------------------------------------

  describe('context preservation', () => {
    it('should pass hookContext to plugin', async () => {
      let receivedContext = null;

      class ContextPlugin extends BasePluginClass {
        async process(next) {
          receivedContext = this._context.hookContext;
          return await next(this._context);
        }
      }

      registry.registerSelector('hook:user-to-agent', ContextPlugin);

      await service.run('prepareMessage', {
        source:  'user',
        target:  'agent',
        message: 'test',
        context: { sessionID: 'ses_1', interactionID: 'int_1' },
      });

      assert.ok(receivedContext);
      assert.equal(receivedContext.sessionID, 'ses_1');
      assert.equal(receivedContext.interactionID, 'int_1');
    });
  });
});
