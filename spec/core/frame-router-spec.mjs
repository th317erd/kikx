'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { FrameEngine } from '../../src/core/frames/index.mjs';
import { BaseFramePlugin, FrameRouter, SelectorCompiler } from '../../src/core/routing/index.mjs';

test('SelectorCompiler matches PascalCase frame types and nested properties', () => {
  let matcher = SelectorCompiler.compile('Type:ToolCall[content.toolName=shell:execute]');

  assert.equal(matcher({
    type: 'ToolCall',
    content: { toolName: 'shell:execute' },
  }), true);
  assert.equal(matcher({
    type: 'ToolCall',
    content: { toolName: 'websearch:search' },
  }), false);
});

test('FrameRouter routes matching commit frames through middleware chain', async () => {
  let events = [];
  let router = new FrameRouter({ logger: quietLogger() });
  let frames = new FrameEngine({ idGenerator: () => 'commit_1' });

  class FirstPlugin extends BaseFramePlugin {
    async process(next) {
      events.push(`first:${this.context.newFrame.id}`);
      await next(this.context);
    }
  }

  class SecondPlugin extends BaseFramePlugin {
    async process(next) {
      events.push(`second:${this.context.newFrame.type}`);
      await next(this.context);
    }
  }

  router.registerSelector('Type:UserMessage', FirstPlugin, 'first');
  router.registerSelector('Type:*', SecondPlugin, 'second');
  router.connectTo(frames);

  frames.merge([{ id: 'msg_1', type: 'UserMessage', hidden: false }]);
  await tick();

  assert.deepEqual(events, [ 'first:msg_1', 'second:UserMessage' ]);
});

test('FrameRouter ignores silent commits', async () => {
  let routed = 0;
  let router = new FrameRouter({ logger: quietLogger() });
  let frames = new FrameEngine();

  class CountPlugin extends BaseFramePlugin {
    async process(next) {
      routed++;
      await next(this.context);
    }
  }

  router.registerSelector('*', CountPlugin);
  router.connectTo(frames);

  frames.merge([{ id: 'msg_1', type: 'UserMessage' }], { silent: true });
  await tick();

  assert.equal(routed, 0);
});

test('FrameRouter continues when a plugin throws or forgets next', async () => {
  let events = [];
  let router = new FrameRouter({ logger: quietLogger() });
  let frames = new FrameEngine();

  class ThrowPlugin extends BaseFramePlugin {
    async process() {
      events.push('throw');
      throw new Error('boom');
    }
  }

  class ForgetPlugin extends BaseFramePlugin {
    async process() {
      events.push('forget');
    }
  }

  class LastPlugin extends BaseFramePlugin {
    async process(next) {
      events.push('last');
      await next(this.context);
    }
  }

  router.registerSelector('*', ThrowPlugin);
  router.registerSelector('*', ForgetPlugin);
  router.registerSelector('*', LastPlugin);
  router.connectTo(frames);

  frames.merge([{ id: 'msg_1', type: 'UserMessage' }]);
  await tick();

  assert.deepEqual(events, [ 'throw', 'forget', 'last' ]);
});

function quietLogger() {
  return {
    error() {},
    warn() {},
    log() {},
  };
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

