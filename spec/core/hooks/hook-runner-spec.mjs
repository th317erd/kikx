'use strict';

import { describe, it, beforeEach } from 'node:test';
import assert                        from 'node:assert/strict';

import { HookRunner }    from '../../../src/core/hooks/hook-runner.mjs';
import { PluginRegistry } from '../../../src/core/plugin-loader/registry.mjs';

// =============================================================================
// HookRunner
// =============================================================================

describe('HookRunner', () => {
  let registry;
  let runner;

  beforeEach(() => {
    registry = new PluginRegistry();
    runner   = new HookRunner(registry);
  });

  // ---- Construction ----

  it('should construct with a registry', () => {
    assert.ok(runner);
  });

  it('should throw if registry is not provided', () => {
    assert.throws(
      () => new HookRunner(null),
      { message: 'HookRunner requires a PluginRegistry' },
    );
  });

  // ---- run with no handlers ----

  it('should return pass with original message when no handlers registered', async () => {
    let result = await runner.run('prepareMessage', { message: 'hello' });
    assert.equal(result.action, 'pass');
    assert.equal(result.message, 'hello');
  });

  it('should return pass for unregistered hook name', async () => {
    registry.registerHook('otherHook', () => ({ action: 'block' }));
    let result = await runner.run('prepareMessage', { message: 'test' });
    assert.equal(result.action, 'pass');
    assert.equal(result.message, 'test');
  });

  // ---- pass-through handler ----

  it('should pass through when handler returns null', async () => {
    registry.registerHook('prepareMessage', () => null);
    let result = await runner.run('prepareMessage', { message: 'original' });
    assert.equal(result.action, 'pass');
    assert.equal(result.message, 'original');
  });

  it('should pass through when handler returns undefined', async () => {
    registry.registerHook('prepareMessage', () => undefined);
    let result = await runner.run('prepareMessage', { message: 'original' });
    assert.equal(result.action, 'pass');
    assert.equal(result.message, 'original');
  });

  // ---- modify handler ----

  it('should modify message when handler returns modify action', async () => {
    registry.registerHook('prepareMessage', (payload) => ({
      action:  'modify',
      message: payload.message + ' [modified]',
    }));

    let result = await runner.run('prepareMessage', { message: 'hello' });
    assert.equal(result.action, 'pass');
    assert.equal(result.message, 'hello [modified]');
  });

  it('should propagate modifications through multiple handlers', async () => {
    registry.registerHook('prepareMessage', (payload) => ({
      action:  'modify',
      message: payload.message + ' [first]',
    }));

    registry.registerHook('prepareMessage', (payload) => ({
      action:  'modify',
      message: payload.message + ' [second]',
    }));

    let result = await runner.run('prepareMessage', { message: 'start' });
    assert.equal(result.action, 'pass');
    assert.equal(result.message, 'start [first] [second]');
  });

  // ---- block handler ----

  it('should block when handler returns block action', async () => {
    registry.registerHook('prepareMessage', () => ({
      action: 'block',
      reason: 'not allowed',
    }));

    let result = await runner.run('prepareMessage', { message: 'test' });
    assert.equal(result.action, 'block');
    assert.equal(result.reason, 'not allowed');
  });

  it('should stop pipeline at block (subsequent handlers not called)', async () => {
    let secondCalled = false;

    registry.registerHook('prepareMessage', () => ({
      action: 'block',
      reason: 'stopped',
    }));

    registry.registerHook('prepareMessage', () => {
      secondCalled = true;
      return null;
    });

    let result = await runner.run('prepareMessage', { message: 'test' });
    assert.equal(result.action, 'block');
    assert.equal(secondCalled, false);
  });

  // ---- redirect handler ----

  it('should redirect when handler returns redirect action', async () => {
    registry.registerHook('prepareMessage', () => ({
      action:  'redirect',
      target:  'other-session',
      message: 'redirected content',
    }));

    let result = await runner.run('prepareMessage', { message: 'test' });
    assert.equal(result.action, 'redirect');
    assert.equal(result.target, 'other-session');
    assert.equal(result.message, 'redirected content');
  });

  it('should stop pipeline at redirect', async () => {
    let secondCalled = false;

    registry.registerHook('prepareMessage', () => ({
      action: 'redirect',
      target: 'elsewhere',
    }));

    registry.registerHook('prepareMessage', () => {
      secondCalled = true;
      return null;
    });

    await runner.run('prepareMessage', { message: 'test' });
    assert.equal(secondCalled, false);
  });

  // ---- pipeline ordering ----

  it('should execute handlers in registration order', async () => {
    let order = [];

    registry.registerHook('prepareMessage', () => { order.push('first'); return null; });
    registry.registerHook('prepareMessage', () => { order.push('second'); return null; });
    registry.registerHook('prepareMessage', () => { order.push('third'); return null; });

    await runner.run('prepareMessage', { message: 'test' });
    assert.deepEqual(order, ['first', 'second', 'third']);
  });

  // ---- async support ----

  it('should handle async handlers', async () => {
    registry.registerHook('prepareMessage', async (payload) => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return { action: 'modify', message: payload.message + ' [async]' };
    });

    let result = await runner.run('prepareMessage', { message: 'hello' });
    assert.equal(result.message, 'hello [async]');
  });

  // ---- error propagation ----

  it('should propagate handler errors', async () => {
    registry.registerHook('prepareMessage', () => {
      throw new Error('handler failed');
    });

    await assert.rejects(
      () => runner.run('prepareMessage', { message: 'test' }),
      { message: 'handler failed' },
    );
  });

  // ---- payload preservation ----

  it('should pass source and target through payload', async () => {
    let receivedPayload = null;

    registry.registerHook('prepareMessage', (payload) => {
      receivedPayload = payload;
      return null;
    });

    await runner.run('prepareMessage', {
      source:  'user',
      target:  'agent',
      message: 'hello',
      context: { sessionID: 'ses_123' },
    });

    assert.equal(receivedPayload.source, 'user');
    assert.equal(receivedPayload.target, 'agent');
    assert.equal(receivedPayload.message, 'hello');
    assert.equal(receivedPayload.context.sessionID, 'ses_123');
  });

  it('should not mutate the original payload', async () => {
    registry.registerHook('prepareMessage', (payload) => ({
      action:  'modify',
      message: payload.message + ' [changed]',
    }));

    let original = { message: 'original', source: 'user' };
    await runner.run('prepareMessage', original);

    assert.equal(original.message, 'original');
  });
});
