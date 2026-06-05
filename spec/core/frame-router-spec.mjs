'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { FrameEngine } from '../../src/core/frames/index.mjs';
import { CommandRegistry } from '../../src/core/commands/index.mjs';
import { BaseFramePlugin, FrameRouter, SelectorCompiler } from '../../src/core/routing/index.mjs';
import { SlashCommandFramePlugin } from '../../src/core/commands/index.mjs';

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

test('SlashCommandFramePlugin handles registered slash commands and stops propagation', async () => {
  let events = [];
  let commandRegistry = new CommandRegistry({ logger: quietLogger() });
  let router = new FrameRouter({ logger: quietLogger() });
  let frames = new FrameEngine({
    idGenerator: (() => {
      let ids = [ 'commit_1', 'cmd_1', 'commit_2' ];
      let index = 0;
      return () => ids[index++];
    })(),
    clock: () => 1000,
  });

  class InviteCommand {
    async execute({ args }) {
      events.push(`command:${args}`);
      return {
        message: 'invited Coder',
        data: { agentID: 'agent_1' },
      };
    }
  }

  class AgentPlugin extends BaseFramePlugin {
    async process(next) {
      events.push('agent');
      await next(this.context);
    }
  }

  commandRegistry.registerCommand('invite', InviteCommand);
  router.registerSelector('Type:UserMessage', SlashCommandFramePlugin, 'commands');
  router.registerSelector('Type:UserMessage', AgentPlugin, 'agent');
  router.connectTo(frames, { id: 'ses_1' }, { services: { commandRegistry, clock: () => 1000 } });

  frames.merge([{
    id: 'msg_1',
    type: 'UserMessage',
    sessionID: 'ses_1',
    interactionID: 'int_1',
    content: { text: '/invite Coder' },
  }]);
  await tick();
  await tick();

  assert.deepEqual(events, [ 'command:Coder' ]);
  assert.deepEqual(frames.toArray().map((frame) => frame.type), [ 'UserMessage', 'CommandResult' ]);
  assert.equal(frames.get('cmd_1').content.text, 'invited Coder');
});

test('SlashCommandFramePlugin lets non-commands continue to lower priority plugins', async () => {
  let events = [];
  let router = new FrameRouter({ logger: quietLogger() });
  let frames = new FrameEngine();

  class AgentPlugin extends BaseFramePlugin {
    async process(next) {
      events.push(this.context.newFrame.content.text);
      await next(this.context);
    }
  }

  router.registerSelector('Type:UserMessage', SlashCommandFramePlugin, 'commands');
  router.registerSelector('Type:UserMessage', AgentPlugin, 'agent');
  router.connectTo(frames, { id: 'ses_1' }, { services: { commandRegistry: new CommandRegistry() } });

  frames.merge([{
    id: 'msg_1',
    type: 'UserMessage',
    sessionID: 'ses_1',
    interactionID: 'int_1',
    content: { text: 'hello agent' },
  }]);
  await tick();

  assert.deepEqual(events, [ 'hello agent' ]);
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
