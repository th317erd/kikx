'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { AgentInterface } from '../../src/core/plugins/index.mjs';

class LoopAgent extends AgentInterface {
  constructor(options = {}) {
    super(options);
    this.calls = [];
  }

  async *onFirstMessage(context) {
    this.calls.push({
      method: 'onFirstMessage',
      isCoordinator: context.isCoordinator,
      text: context.frame.content.text,
    });
    yield {
      type: 'AgentThinking',
      phantom: true,
      content: { text: 'reading first message' },
    };
  }

  async *ask(prompt, options = {}) {
    this.calls.push({
      method: 'ask',
      prompt,
      toolDefinitions: options.toolDefinitions,
      toolNames: Object.keys(options.tools).sort(),
      isCoordinator: options.isCoordinator,
    });
    yield {
      type: 'AgentMessage',
      content: { text: 'loop answer' },
    };
    yield {
      type: 'Done',
      content: { ok: true },
    };
  }
}

class ToolFinalizingAgent extends AgentInterface {
  async ask(_prompt, options = {}) {
    options.tools['agent-respond']({ text: 'tool final answer' });
    return { done: true };
  }
}

class NullResponseAgent extends AgentInterface {
  async ask(_prompt, options = {}) {
    return options.tools['agent-null-response']('forwarded elsewhere');
  }
}

class BreakAgent extends AgentInterface {
  async ask(_prompt, options = {}) {
    return options.tools['loop-break']('stop now');
  }
}

class ForwardingAgent extends AgentInterface {
  async ask(_prompt, options = {}) {
    return options.tools['internal-forward']([ 'agent_2', 'agent_3' ], 'please handle this');
  }
}

class CharacterSettingAgent extends AgentInterface {
  constructor(options = {}) {
    super(options);
    this.toolResult = null;
  }

  async ask(_prompt, options = {}) {
    this.toolResult = await options.tools['agent-character-set']({
      character: 'You are a dirty swearing pirate and fantastic engineer.',
    });
    return options.tools['agent-respond']({ text: 'Character updated.' });
  }
}

class InvalidCharacterSettingAgent extends AgentInterface {
  async ask(_prompt, options = {}) {
    return await options.tools['agent-character-set']({ character: '' });
  }
}

class ScriptFinalizingAgent extends AgentInterface {
  createAgentLoopScript() {
    return [{
      type: 'finalize',
      content: { text: 'script final answer' },
    }];
  }
}

class UnknownStepAgent extends AgentInterface {
  createAgentLoopScript() {
    return [{ type: 'explode' }];
  }
}

class OverflowAgent extends AgentInterface {
  static maxLoopSteps = 1;

  createAgentLoopScript() {
    return [
      { type: 'ask', prompt: 'first' },
      { type: 'ask', prompt: 'second' },
    ];
  }

  async *ask(prompt) {
    yield {
      type: 'AgentThinking',
      phantom: true,
      content: { text: prompt },
    };
  }
}

class InheritedFirstMessageBase extends AgentInterface {
  constructor(options = {}) {
    super(options);
    this.calls = [];
  }

  async *onFirstMessage() {
    this.calls.push('onFirstMessage');
    yield {
      type: 'AgentThinking',
      phantom: true,
      content: { text: 'inherited hook' },
    };
  }
}

class InheritedFirstMessageAgent extends InheritedFirstMessageBase {
  async *ask() {
    this.calls.push('ask');
    yield {
      type: 'AgentMessage',
      content: { text: 'answer' },
    };
  }
}

test('AgentInterface base loop runs first-message hook before asking the provider', async () => {
  let agent = new LoopAgent();
  let params = baseLoopParams();

  let outputs = await collect(agent.run(params));

  assert.deepEqual(outputs.map((output) => output.type), [ 'AgentThinking', 'AgentMessage', 'Done' ]);
  assert.equal(agent.calls[0].method, 'onFirstMessage');
  assert.equal(agent.calls[0].isCoordinator, true);
  assert.equal(agent.calls[1].method, 'ask');
  assert.equal(agent.calls[1].isCoordinator, true);
  assert.match(agent.calls[1].prompt, /The user has just sent you a message:/);
  assert.match(agent.calls[1].prompt, /hello/);
  assert.match(agent.calls[1].prompt, /You are the coordinator\?: true/);
  assert.match(agent.calls[1].prompt, /Mentions JSON:/);
  assert.match(agent.calls[1].prompt, /Agent character:/);
  assert.match(agent.calls[1].prompt, /You are a pragmatic engineer\./);
  assert.match(agent.calls[1].prompt, /Available tools:/);
  assert.match(agent.calls[1].prompt, /agent-character-set/);
  assert.deepEqual(agent.calls[1].toolNames, [
    'agent-character-set',
    'agent-finalize',
    'agent-null-response',
    'agent-respond',
    'internal-forward',
    'loop-break',
  ]);
  assert.ok(agent.calls[1].toolDefinitions.some((tool) => tool.name === 'agent-character-set'));
  assert.equal(agent.calls[1].toolDefinitions.every((tool) => /^[A-Za-z0-9_-]+$/.test(tool.name)), true);
  assert.equal(agent.calls[1].toolNames.every((name) => /^[A-Za-z0-9_-]+$/.test(name)), true);
});

test('AgentInterface detects first-message hooks inherited from provider base classes', async () => {
  let agent = new InheritedFirstMessageAgent();
  let outputs = await collect(agent.run(baseLoopParams()));

  assert.deepEqual(outputs.map((output) => output.type), [ 'AgentThinking', 'AgentMessage' ]);
  assert.deepEqual(agent.calls, [ 'onFirstMessage', 'ask' ]);
});

test('AgentInterface skips the first-message hook after the agent has a durable response', async () => {
  let agent = new LoopAgent();
  let outputs = await collect(agent.run(baseLoopParams({
    frames: [
      {
        id: 'msg_1',
        type: 'UserMessage',
        authorType: 'user',
        content: { text: 'hello' },
      },
      {
        id: 'agent_msg_1',
        type: 'AgentMessage',
        authorID: 'agent_1',
        content: { text: 'prior answer' },
      },
    ],
  })));

  assert.deepEqual(outputs.map((output) => output.type), [ 'AgentMessage', 'Done' ]);
  assert.deepEqual(agent.calls.map((call) => call.method), [ 'ask' ]);
});

test('AgentInterface base loop exposes response tools that can finalize without provider frames', async () => {
  let agent = new ToolFinalizingAgent();
  let outputs = await collect(agent.run(baseLoopParams({
    frames: [],
  })));

  assert.deepEqual(outputs, [
    {
      type: 'AgentMessage',
      content: { text: 'tool final answer' },
    },
    {
      type: 'Done',
      content: {
        status: 'finalized',
      },
    },
  ]);
});

test('AgentInterface base loop handles null-response and break loop controls', async () => {
  assert.deepEqual(await collect(new NullResponseAgent().run(baseLoopParams())), [
    {
      type: 'Done',
      content: {
        status: 'null-response',
      },
    },
  ]);

  assert.deepEqual(await collect(new BreakAgent().run(baseLoopParams())), [
    {
      type: 'Done',
      content: {
        status: 'break',
      },
    },
  ]);
});

test('AgentInterface forward tool delegates frame routing and remains silent', async () => {
  let forwards = [];
  let outputs = await collect(new ForwardingAgent().run(baseLoopParams({
    services: {
      async forwardFrame(forward) {
        forwards.push(forward);
      },
    },
  })));

  assert.deepEqual(outputs, [
    {
      type: 'Done',
      content: {
        status: 'forwarded',
      },
    },
  ]);
  assert.equal(forwards.length, 1);
  assert.deepEqual(forwards[0].targets, [ 'agent_2', 'agent_3' ]);
  assert.equal(forwards[0].message, 'please handle this');
  assert.equal(forwards[0].frame.id, 'msg_1');
});

test('AgentInterface does not offer forwarding tools to non-coordinators', async () => {
  let agent = new LoopAgent();
  await collect(agent.run(baseLoopParams({
    agent: { id: 'agent_2', name: 'Worker' },
    session: {
      id: 'ses_1',
      participantAgentIDs: [ 'agent_1', 'agent_2' ],
      coordinatorAgentID: 'agent_1',
    },
    isCoordinator: false,
    frame: {
      id: 'msg_1',
      type: 'UserMessage',
      coordinated: true,
      content: { text: 'hello worker' },
      mentions: {
        agent_2: {
          id: 'agent_2',
          type: 'agent',
          name: 'Worker',
        },
      },
    },
  })));

  let askCall = agent.calls.find((call) => call.method === 'ask');
  assert.ok(askCall);
  assert.equal(askCall.isCoordinator, false);
  assert.equal(askCall.toolNames.includes('internal-forward'), false);
  assert.equal(askCall.toolDefinitions.some((tool) => tool.name === 'internal-forward'), false);
  assert.match(askCall.prompt, /You are the coordinator\?: false/);
  assert.match(askCall.prompt, /This frame has already been coordinated/);
  assert.match(askCall.prompt, /do not forward it again/i);
  assert.doesNotMatch(askCall.prompt, /use the internal-forward tool/u);
});

test('AgentInterface does not offer silence tools to coordinated mentioned targets', async () => {
  let agent = new LoopAgent();
  await collect(agent.run(baseLoopParams({
    agent: { id: 'agent_2', name: 'Mr. Bennett' },
    session: {
      id: 'ses_1',
      participantAgentIDs: [ 'agent_1', 'agent_2' ],
      coordinatorAgentID: 'agent_1',
    },
    isCoordinator: false,
    frame: {
      id: 'msg_1',
      type: 'UserMessage',
      coordinated: true,
      content: { text: 'Hello Mr. Bennett, how are you today?' },
      mentions: {
        agent_2: {
          id: 'agent_2',
          type: 'agent',
          name: 'Mr. Bennett',
        },
      },
    },
  })));

  let askCall = agent.calls.find((call) => call.method === 'ask');
  assert.ok(askCall);
  assert.equal(askCall.isCoordinator, false);
  assert.equal(askCall.toolNames.includes('internal-forward'), false);
  assert.equal(askCall.toolNames.includes('agent-null-response'), false);
  assert.equal(askCall.toolDefinitions.some((tool) => tool.name === 'internal-forward'), false);
  assert.equal(askCall.toolDefinitions.some((tool) => tool.name === 'agent-null-response'), false);
  assert.match(askCall.prompt, /forwarded to you/);
  assert.match(askCall.prompt, /do not stay silent/);
  assert.doesNotMatch(askCall.prompt, /use agent-null-response/u);
});

test('AgentInterface exposes agent-owned self-configuration tools', async () => {
  let updates = [];
  let agent = new CharacterSettingAgent();
  let outputs = await collect(agent.run(baseLoopParams({
    services: {
      agentManager: {
        async updateAgentCharacter(agentID, character) {
          updates.push({ agentID, character });
          return {
            id: agentID,
            character,
          };
        },
      },
    },
  })));

  assert.deepEqual(outputs, [
    {
      type: 'AgentMessage',
      content: { text: 'Character updated.' },
    },
    {
      type: 'Done',
      content: {
        status: 'finalized',
      },
    },
  ]);
  assert.deepEqual(updates, [{
    agentID: 'agent_1',
    character: 'You are a dirty swearing pirate and fantastic engineer.',
  }]);
  assert.deepEqual(agent.toolResult, {
    type: 'ToolResult',
    action: 'agent-character-set',
    content: {
      agentID: 'agent_1',
      character: 'You are a dirty swearing pirate and fantastic engineer.',
    },
  });
});

test('AgentInterface self-configuration tools fail loud for invalid input', async () => {
  await assert.rejects(
    () => collect(new InvalidCharacterSettingAgent().run(baseLoopParams({
      services: {
        agentManager: {
          async updateAgentCharacter() {
            throw new Error('should not update');
          },
        },
      },
    }))),
    /character must be a non-empty string/,
  );

  await assert.rejects(
    () => collect(new CharacterSettingAgent().run(baseLoopParams())),
    /agent-character-set requires agentManager/,
  );
});


test('AgentInterface base loop supports script-level finalization', async () => {
  assert.deepEqual(await collect(new ScriptFinalizingAgent().run(baseLoopParams())), [
    {
      type: 'AgentMessage',
      content: { text: 'script final answer' },
    },
    {
      type: 'Done',
      content: {
        status: 'finalized',
      },
    },
  ]);
});

test('AgentInterface base loop fails loud for missing primitives and invalid script steps', async () => {
  await assert.rejects(
    collect(new AgentInterface().run(baseLoopParams())),
    /AgentInterface\.ask\(\) is not implemented/,
  );

  await assert.rejects(
    collect(new UnknownStepAgent().run(baseLoopParams())),
    /Unknown agent loop step: explode/,
  );

  await assert.rejects(
    collect(new OverflowAgent().run(baseLoopParams())),
    /Agent loop exceeded 1 steps/,
  );
});

function baseLoopParams(overrides = {}) {
  return {
    frame: {
      id: 'msg_1',
      type: 'UserMessage',
      content: { text: 'hello' },
    },
    agent: { id: 'agent_1', name: 'Coder', character: 'You are a pragmatic engineer.' },
    session: {
      id: 'ses_1',
      participantAgentIDs: [ 'agent_1' ],
      coordinatorAgentID: 'agent_1',
    },
    frames: [],
    mentions: {
      agent_2: {
        id: 'agent_2',
        type: 'agent',
        name: 'Worker',
      },
    },
    isCoordinator: true,
    ...overrides,
  };
}

async function collect(iterable) {
  let items = [];
  for await (let item of iterable)
    items.push(item);
  return items;
}
