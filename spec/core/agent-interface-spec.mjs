'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { FrameEngine } from '../../src/core/frames/index.mjs';
import {
  AGENTIC_SCRIPT_NAME,
  AgentInterface,
  PluginInterface,
  PluginRegistry,
} from '../../src/core/plugins/index.mjs';
import { ToolExecutionService } from '../../src/core/tools/index.mjs';

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
      startBrief: this.buildStartBrief(options).text,
      messageBrief: this.buildMessageBrief(options).text,
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
    options.tools['end-turn']({ text: 'tool final answer' });
    return { done: true };
  }
}

class DeferringDirectAgent extends AgentInterface {
  constructor(options = {}) {
    super(options);
    this.calls = [];
  }

  async ask(_prompt, options = {}) {
    this.calls.push(options.step?.type || 'ask');
    return {
      type: 'AgentMessage',
      content: {
        text: 'Next step: should I continue reading src/core/plugins/agent-interface.mjs as planned?',
      },
    };
  }
}

class PermissionSeekingDirectAgent extends AgentInterface {
  constructor(options = {}) {
    super(options);
    this.calls = [];
  }

  async ask(_prompt, options = {}) {
    this.calls.push(options.step?.type || 'ask');
    return {
      type: 'AgentMessage',
      content: {
        text: 'Before I start changing files, please tell me which small fix you want first.',
      },
    };
  }
}

class EndTurnSummaryAgent extends AgentInterface {
  async ask(_prompt, options = {}) {
    options.tools['end-turn']({
      summary: 'Finished the child task.\n\n- Implemented the change.\n- Ran the focused spec.',
      details: 'Focused spec passed.',
    });
    return { done: true };
  }
}

class ContinueTurnAgent extends AgentInterface {
  async ask(_prompt, options = {}) {
    return options.tools['continue-turn']({
      text: 'I started the work and will continue shortly.',
      delayMs: 0,
      nextAction: 'Run the next smoke check.',
      mood: 0.5,
      moodWord: 'Hopeful',
    });
  }
}

class ToolFinalizingProviderFrameAgent extends AgentInterface {
  async *ask(_prompt, options = {}) {
    options.tools['end-turn']({ text: 'tool final answer' });
    yield {
      id: 'provider_frame_1',
      type: 'AgentMessage',
      content: {
        text: 'provider fallback answer',
        thinking: {
          text: 'provider thinking',
          status: 'complete',
        },
        model: 'test-model',
        status: 'complete',
        toolResults: [
          {
            toolName: 'web-search',
            result: {
              resultCount: 2,
            },
          },
        ],
      },
    };
    yield {
      type: 'Done',
      content: {
        usage: {
          totalTokens: 12,
        },
      },
    };
  }
}

class EndTurnSilentAgent extends AgentInterface {
  async ask(_prompt, options = {}) {
    return options.tools['end-turn']({});
  }
}

class StopAgent extends AgentInterface {
  async ask(_prompt, options = {}) {
    return options.tools['stop']('stop now');
  }
}

class ForwardingAgent extends AgentInterface {
  async ask(_prompt, options = {}) {
    return options.tools['route']({ recipients: [ 'agent_2', 'agent_3' ], note: 'please handle this' });
  }
}

class CharacterSettingAgent extends AgentInterface {
  constructor(options = {}) {
    super(options);
    this.toolResult = null;
  }

  async ask(_prompt, options = {}) {
    this.toolResult = await options.tools['set-character']({
      character: 'You are a dirty swearing pirate and fantastic engineer.',
      compressedCharacter: 'Pirate engineer; direct and technical.',
    });
    return options.tools['end-turn']({ text: 'Character updated.' });
  }
}

class InvalidCharacterSettingAgent extends AgentInterface {
  async ask(_prompt, options = {}) {
    return await options.tools['set-character']({ character: '' });
  }
}

class MissingCompressedCharacterSettingAgent extends AgentInterface {
  async ask(_prompt, options = {}) {
    return await options.tools['set-character']({
      character: 'You are a careful engineer.',
    });
  }
}

class OverLimitCompressedCharacterSettingAgent extends AgentInterface {
  async ask(_prompt, options = {}) {
    return await options.tools['set-character']({
      character: 'You are a careful engineer.',
      compressedCharacter: 'x'.repeat(401),
    });
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

class GlobalEchoTool extends PluginInterface {
  static pluginID = 'test';
  static featureName = 'global-echo';
  static description = 'Echo a value through a registered global tool.';
  static riskLevel = 'none';
  static inputSchema = {
    type: 'object',
    properties: {
      text: { type: 'string' },
    },
    required: [ 'text' ],
    additionalProperties: false,
  };

  async _execute(params) {
    return {
      text: params.text,
      agentID: params._agentID,
      sessionID: params._sessionID,
      frameID: params._frameID,
    };
  }
}

class GlobalToolCallingAgent extends AgentInterface {
  constructor(options = {}) {
    super(options);
    this.toolResult = null;
    this.askCall = null;
    this.askCalls = [];
  }

  async ask(_prompt, options = {}) {
    let askCall = {
      stepType: options.step?.type || 'ask',
      prompt: _prompt,
      startBrief: this.buildStartBrief(options).text,
      messageBrief: this.buildMessageBrief(options).text,
      toolDefinitions: options.toolDefinitions,
      toolNames: Object.keys(options.tools).sort(),
    };
    this.askCalls.push(askCall);
    this.askCall = askCall;
    this.toolResult = await options.tools['global-echo']({ text: 'hello' });
    return options.tools['end-turn']({ text: this.toolResult.text });
  }
}

class ProgressThenToolAgent extends AgentInterface {
  constructor(options = {}) {
    super(options);
    this.toolResult = null;
  }

  async ask(_prompt, options = {}) {
    await options.tools['progress']({ text: 'I will echo the requested value now.', mood: 1.5, moodWord: 'Focused' });
    this.toolResult = await options.tools['global-echo']({ text: 'hello' });
    return options.tools['end-turn']({ text: this.toolResult.text });
  }
}

test('the agentic script name is stable', () => {
  assert.equal(AGENTIC_SCRIPT_NAME, 'agentic script');
});

test('AgentInterface asks with the raw trigger message and builds two-tier briefs', async () => {
  let agent = new LoopAgent();
  await collect(agent.run(baseLoopParams()));

  let askCall = agent.calls.find((call) => call.method === 'ask');
  // The provider receives the raw message text (Brief B wraps it), not a monolith.
  assert.equal(askCall.prompt, 'hello');
  assert.match(askCall.startBrief, /^Kikx Advanced Agent Harness - v/);
  assert.match(askCall.startBrief, /Precepts — always-on dispositions, not rules or gates/);
  assert.ok(askCall.messageBrief.startsWith('hello'));
  assert.match(askCall.messageBrief, /Turn context — from /);
});

test('AgentInterface base loop runs first-message hook before asking the provider', async () => {
  let agent = new LoopAgent();
  let params = baseLoopParams();

  let outputs = await collect(agent.run(params));

  assert.deepEqual(outputs.map((output) => output.type), [ 'AgentThinking', 'AgentMessage', 'Done' ]);
  assert.equal(agent.calls[0].method, 'onFirstMessage');
  assert.equal(agent.calls[0].isCoordinator, true);
  assert.equal(agent.calls[1].method, 'ask');
  assert.equal(agent.calls[1].isCoordinator, true);
  // The provider receives the raw message text; the two-tier shape is applied
  // by the model-context assembly (covered in agent-model-context-spec).
  assert.equal(agent.calls[1].prompt, 'hello');
  // Brief A: version banner, character, precepts, tools.
  assert.match(agent.calls[1].startBrief, /Kikx Advanced Agent Harness - v/);
  assert.match(agent.calls[1].startBrief, /Precepts — always-on dispositions, not rules or gates/);
  assert.match(agent.calls[1].startBrief, /Orient:/);
  assert.match(agent.calls[1].startBrief, /Proof: never claim done/i);
  assert.match(agent.calls[1].startBrief, /continue-turn/);
  assert.match(agent.calls[1].startBrief, /Character: You are a pragmatic engineer\./);
  assert.match(agent.calls[1].startBrief, /Behavior — MANDATORY:/);
  // Brief B: sender, message, compact state.
  assert.ok(agent.calls[1].messageBrief.startsWith('hello'));
  assert.match(agent.calls[1].messageBrief, /Turn context — from /);
  assert.match(agent.calls[1].messageBrief, /todo:/);
  assert.match(agent.calls[1].messageBrief, /cwd:/);
  assert.match(agent.calls[1].messageBrief, /coord:/);
  assert.match(agent.calls[1].messageBrief, /parties:/);
  // The old monolith must not appear anywhere.
  assert.doesNotMatch(agent.calls[1].startBrief, /Kikx agentic coordination loop/);
  assert.doesNotMatch(agent.calls[1].messageBrief, /Kikx agentic coordination loop/);
  assert.deepEqual(agent.calls[1].toolNames, [
    'continue-turn',
    'end-turn',
    'help',
    'progress',
    'route',
    'set-character',
    'stop',
  ]);
  assert.equal(agent.calls[1].toolNames.includes('agent-null-response'), false);
  assert.ok(agent.calls[1].toolDefinitions.some((tool) => tool.name === 'set-character'));
  assert.ok(agent.calls[1].toolDefinitions.some((tool) => tool.name === 'progress'));
  assert.equal(agent.calls[1].toolDefinitions.every((tool) => /^[A-Za-z0-9_-]+$/.test(tool.name)), true);
  assert.equal(agent.calls[1].toolNames.every((name) => /^[A-Za-z0-9_-]+$/.test(name)), true);

  // P6/D2: the character tool schema requires a length-limited compressed form.
  let characterTool = agent.calls[1].toolDefinitions.find((tool) => tool.name === 'set-character');
  assert.deepEqual(characterTool.parameters.required, [ 'character', 'compressedCharacter' ]);
  assert.equal(characterTool.parameters.properties.compressedCharacter.maxLength, 400);
});

test('AgentInterface exposes registered global plugin tools to agent turns', async () => {
  let pluginRegistry = new PluginRegistry({ logger: { warn() {} } });
  pluginRegistry.registerTool('global-echo', GlobalEchoTool);
  pluginRegistry.registerTool('legacy:bad-name', GlobalEchoTool);

  let agent = new GlobalToolCallingAgent();
  let outputs = await collect(agent.run(baseLoopParams({
    services: { pluginRegistry },
  })));

  assert.deepEqual(agent.toolResult, {
    text: 'hello',
    agentID: 'agent_1',
    sessionID: 'ses_1',
    frameID: 'msg_1',
  });
  assert.equal(agent.askCall.toolNames.includes('global-echo'), true);
  assert.equal(agent.askCall.toolNames.includes('legacy:bad-name'), false);
  let echoDefinition = agent.askCall.toolDefinitions.find((tool) => tool.name === 'global-echo');
  assert.ok(echoDefinition);
  assert.equal(echoDefinition.parameters.properties.session_id.type, 'string');
  assert.equal(echoDefinition.parameters.additionalProperties, false);
  assert.equal(agent.askCall.toolDefinitions.some((tool) => tool.name === 'legacy:bad-name'), false);
  assert.equal(outputs.some((output) => output.type === 'AgentMessage' && output.content.text === 'hello'), true);
});

test('AgentInterface hides write-file from review-only roles by default', async () => {
  let pluginRegistry = new PluginRegistry({ logger: { warn() {} } });
  pluginRegistry.registerTool('write-file', GlobalEchoTool);
  pluginRegistry.registerTool('read-file', GlobalEchoTool);

  let agent = new LoopAgent();
  await collect(agent.run(baseLoopParams({
    agent: {
      id: 'agis_qa_tester',
      name: 'QA Tester',
      character: 'You are a QA reviewer.',
    },
    services: { pluginRegistry },
  })));

  let askCall = agent.calls.find((call) => call.method === 'ask');
  assert.equal(askCall.toolNames.includes('write-file'), false);
  assert.equal(askCall.toolDefinitions.some((tool) => tool.name === 'write-file'), false);
  assert.equal(askCall.toolNames.includes('read-file'), true);
});

test('AgentInterface keeps write-file available to implementers and explicit overrides', async () => {
  let pluginRegistry = new PluginRegistry({ logger: { warn() {} } });
  pluginRegistry.registerTool('write-file', GlobalEchoTool);

  let implementer = new LoopAgent();
  await collect(implementer.run(baseLoopParams({
    agent: {
      id: 'subagent_oakhurst',
      name: 'Subagent Oakhurst',
      character: 'You are an implementation engineer.',
    },
    services: { pluginRegistry },
  })));
  let implementerAsk = implementer.calls.find((call) => call.method === 'ask');
  assert.equal(implementerAsk.toolNames.includes('write-file'), true);

  let reassignedReviewer = new LoopAgent();
  await collect(reassignedReviewer.run(baseLoopParams({
    agent: {
      id: 'ux_guru',
      name: 'UX Reviewer',
      character: 'You are a UX reviewer reassigned to patch a specific defect.',
      config: {
        permissions: {
          writeFile: true,
        },
      },
    },
    services: { pluginRegistry },
  })));
  let reviewerAsk = reassignedReviewer.calls.find((call) => call.method === 'ask');
  assert.equal(reviewerAsk.toolNames.includes('write-file'), true);
});

test('AgentInterface hides delegation tools from child-session agents', async () => {
  let pluginRegistry = new PluginRegistry({ logger: { warn() {} } });
  pluginRegistry.registerTool('global-echo', GlobalEchoTool);
  pluginRegistry.registerTool('session-create', GlobalEchoTool);
  pluginRegistry.registerTool('session-invite-agents', GlobalEchoTool);

  let agent = new GlobalToolCallingAgent();
  await collect(agent.run(baseLoopParams({
    session: {
      id: 'ses_child',
      participantAgentIDs: [ 'agent_1' ],
      coordinatorAgentID: 'agent_1',
      parentSessionID: 'ses_root',
      generation: 1,
    },
    services: { pluginRegistry },
  })));

  let firstAsk = agent.askCalls[0];
  assert.equal(firstAsk.toolNames.includes('global-echo'), true);
  assert.equal(firstAsk.toolNames.includes('session-create'), false);
  assert.equal(firstAsk.toolNames.includes('session-invite-agents'), false);
  assert.equal(firstAsk.toolDefinitions.some((tool) => tool.name === 'session-create'), false);
  assert.equal(firstAsk.toolDefinitions.some((tool) => tool.name === 'session-invite-agents'), false);
  assert.match(firstAsk.startBrief, /Delegation: this is a delegated child session/);
  assert.match(firstAsk.startBrief, /Do not create more sessions/);
});

test('AgentInterface routes registered global plugin tools through the tool executor service', async () => {
  let pluginRegistry = new PluginRegistry({ logger: { warn() {} } });
  pluginRegistry.registerTool('global-echo', GlobalEchoTool);
  let calls = [];
  let toolExecutor = {
    async executeTool(call) {
      calls.push(call);
      return {
        text: call.input.text,
        agentID: call.context.agent.id,
        sessionID: call.context.session.id,
        frameID: call.context.frame.id,
      };
    },
  };

  let agent = new GlobalToolCallingAgent();
  await collect(agent.run(baseLoopParams({
    services: {
      pluginRegistry,
      toolExecutor,
    },
  })));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].toolName, 'global-echo');
  assert.equal(calls[0].ToolClass, GlobalEchoTool);
  assert.deepEqual(calls[0].input, { text: 'hello' });
  assert.equal(calls[0].context.agent.id, 'agent_1');
  assert.deepEqual(agent.toolResult, {
    text: 'hello',
    agentID: 'agent_1',
    sessionID: 'ses_1',
    frameID: 'msg_1',
  });
});

test('AgentInterface persists progress frames before registered tool calls', async () => {
  let pluginRegistry = new PluginRegistry({ logger: { warn() {} } });
  pluginRegistry.registerTool('global-echo', GlobalEchoTool);

  let now = 1_000_000;
  let frameEngine = new FrameEngine({
    clock: () => now,
    runnerID: 'test-runner',
    idGenerator: (() => {
      let index = 0;
      return () => `frame_${++index}`;
    })(),
  });
  let visibleBeforeTool = [];
  let toolExecutor = {
    async executeTool(call) {
      visibleBeforeTool = frameEngine.toArray()
        .filter((frame) => frame.hidden === false)
        .map((frame) => ({
          type: frame.type,
          text: frame.content?.text,
          mood: frame.content?.mood,
          moodWord: frame.content?.moodWord,
        }));
      return {
        text: call.input.text,
        agentID: call.context.agent.id,
        sessionID: call.context.session.id,
        frameID: call.context.frame.id,
      };
    },
  };

  let agent = new ProgressThenToolAgent();
  let outputs = await collect(agent.run(baseLoopParams({
    responseFrameID: 'agent_response_1',
    frameEngine,
    services: {
      pluginRegistry,
      toolExecutor,
      clock: () => ++now,
    },
  })));

  assert.deepEqual(visibleBeforeTool, [{
    type: 'AgentProgress',
    text: 'I will echo the requested value now.',
    mood: 1.5,
    moodWord: 'Focused',
  }]);
  assert.equal(agent.toolResult.text, 'hello');
  assert.equal(outputs.some((output) => output.type === 'AgentMessage' && output.content.text === 'hello'), true);
  assert.deepEqual(frameEngine.toArray().map((frame) => frame.type), [ 'AgentProgress' ]);
});

test('ToolExecutionService runs tool public execute path with agent context metadata', async () => {
  let result = await new ToolExecutionService().executeTool({
    toolName: 'global-echo',
    ToolClass: GlobalEchoTool,
    input: { text: 'hello' },
    context: baseLoopParams(),
  });

  assert.deepEqual(result, {
    text: 'hello',
    agentID: 'agent_1',
    sessionID: 'ses_1',
    frameID: 'msg_1',
  });
});

test('AgentInterface prompt includes session participant names without secrets', async () => {
  let agent = new LoopAgent();
  await collect(agent.run(baseLoopParams({
    session: {
      id: 'ses_1',
      participantAgentIDs: [ 'agent_1', 'agent_2' ],
      coordinatorAgentID: 'agent_1',
    },
    participantAgents: [
      {
        id: 'agent_1',
        name: 'Iron-Hand McGuffin',
        pluginID: 'codex-agent',
        secrets: { apiKey: 'sk-should-not-appear' },
        character: 'secret-ish personality should not be in roster',
      },
      {
        id: 'agent_2',
        name: 'Mr. Bennett',
        pluginID: 'codex-agent',
        config: { model: 'gpt-test' },
      },
    ],
  })));

  let askCall = agent.calls.find((call) => call.method === 'ask');
  assert.ok(askCall);
  assert.match(askCall.messageBrief, /Iron-Hand McGuffin/);
  assert.match(askCall.messageBrief, /Mr\. Bennett/);
  assert.doesNotMatch(askCall.messageBrief, /sk-should-not-appear/);
  assert.doesNotMatch(askCall.messageBrief, /gpt-test/);
  assert.doesNotMatch(askCall.messageBrief, /secret-ish personality/);
  assert.doesNotMatch(askCall.startBrief, /sk-should-not-appear/);
});

test('AgentInterface prompt describes agent-authored trigger frames accurately', async () => {
  let agent = new LoopAgent();
  await collect(agent.run(baseLoopParams({
    agent: { id: 'agent_1', name: 'Coder' },
    session: {
      id: 'ses_1',
      participantAgentIDs: [ 'agent_1', 'agent_2' ],
      coordinatorAgentID: 'agent_1',
    },
    frame: {
      id: 'agent_msg_1',
      type: 'AgentMessage',
      authorType: 'agent',
      authorID: 'agent_2',
      authorDisplayName: 'Reviewer',
      content: { text: 'Coder, can you sanity-check this?' },
      agentRoute: {
        rootFrameID: 'msg_1',
        sourceFrameID: 'msg_1',
        path: [ 'agent_2' ],
      },
    },
    isCoordinator: true,
  })));

  let askCall = agent.calls.find((call) => call.method === 'ask');
  assert.ok(askCall);
  // Brief B starts with the agent-authored message and labels the sender afterward.
  assert.ok(askCall.messageBrief.startsWith('Coder, can you sanity-check this?'));
  assert.match(askCall.messageBrief, /Turn context — from Reviewer /);
  // Only 2 parties (two agents) are present, so no coordinator preamble (D3).
  assert.doesNotMatch(askCall.startBrief, /COORDINATOR PREAMBLE/);
});

test('AgentInterface detects first-message hooks inherited from provider base classes', async () => {
  let agent = new InheritedFirstMessageAgent();
  let outputs = await collect(agent.run(baseLoopParams()));

  assert.deepEqual(outputs.map((output) => output.type), [ 'AgentThinking', 'AgentMessage', 'Done' ]);
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

test('AgentInterface converts avoidable deferral questions to continuations', async () => {
  let agent = new DeferringDirectAgent();
  let outputs = await collect(agent.run(baseLoopParams({
    frames: [],
  })));

  assert.deepEqual(agent.calls, [ 'ask' ]);
  // Fix A: the stalling draft is suppressed (no visible frame, no canned meta
  // sentence); the agent answers via the immediate continuation instead.
  assert.deepEqual(outputs, [
    { type: 'SuppressFinalFrame' },
    {
      type: 'Done',
      content: {
        status: 'respond-and-continue',
        continuation: {
          delayMs: 0,
          continuationPrompt: 'Your previous draft stopped to ask the user whether to continue or which obvious safe next step to take. The user expects you to infer the next safe implied step and continue without asking for permission. Continue now. Use tools if needed. Ask only if there is a real blocker, a destructive/risky action, or a genuinely important decision that cannot be inferred.',
        },
      },
    },
  ]);
});

test('AgentInterface converts permission-seeking file-change deferrals to continuations', async () => {
  let agent = new PermissionSeekingDirectAgent();
  let outputs = await collect(agent.run(baseLoopParams({
    frames: [],
  })));

  assert.deepEqual(agent.calls, [ 'ask' ]);
  assert.equal(outputs[0].type, 'SuppressFinalFrame');
  assert.equal(outputs[1].type, 'Done');
  assert.equal(outputs[1].content.status, 'respond-and-continue');
});

test('AgentInterface base loop preserves provider frame metadata after response-tool finalization', async () => {
  let agent = new ToolFinalizingProviderFrameAgent();
  let outputs = await collect(agent.run(baseLoopParams({
    frames: [],
  })));

  assert.deepEqual(outputs, [
    {
      id: 'provider_frame_1',
      type: 'AgentMessage',
      content: {
        text: 'tool final answer',
        thinking: {
          text: 'provider thinking',
          status: 'complete',
        },
        model: 'test-model',
        status: 'complete',
        toolResults: [
          {
            toolName: 'web-search',
            result: {
              resultCount: 2,
            },
          },
        ],
      },
    },
    {
      type: 'Done',
      content: {
        status: 'finalized',
        usage: {
          totalTokens: 12,
        },
      },
    },
  ]);
});

test('AgentInterface base loop supports continue-turn control', async () => {
  assert.deepEqual(await collect(new ContinueTurnAgent().run(baseLoopParams())), [
    {
      type: 'AgentMessage',
      content: {
        text: 'I started the work and will continue shortly.',
        nextAction: 'Run the next smoke check.',
        mood: 0.5,
        moodWord: 'Hopeful',
      },
    },
    {
      type: 'Done',
      content: {
        status: 'respond-and-continue',
        continuation: {
          delayMs: 0,
          continuationPrompt: 'Run the next smoke check.',
        },
      },
    },
  ]);
});

test('end-turn with a summary notifies the nearest non-self coordinator after the report', async () => {
  let child = {
    id: 'ses_child',
    parentSessionID: 'ses_parent',
    participantAgentIDs: [ 'agent_1' ],
    coordinatorAgentID: 'agent_1',
  };
  let parent = {
    id: 'ses_parent',
    participantAgentIDs: [ 'agent_2' ],
    coordinatorAgentID: 'agent_2',
  };
  let postedFrames = [];
  let sequence = [];
  let sessions = new Map([ [ child.id, child ], [ parent.id, parent ] ]);
  let runtime = {
    async ensureSessionEntry(id) {
      return {
        session: sessions.get(id) || null,
        frameEngine: id === parent.id
          ? {
            merge(frames) {
              postedFrames.push(...frames);
              sequence.push('notice');
              return frames;
            },
          }
          : { merge: (frames) => frames },
      };
    },
    getSession(id) {
      return sessions.get(id) || null;
    },
    frameStore: { async flush() {} },
    syncSessionManifestFromEngine() {},
    nextClockStamp() {
      return { at: 123, clock: null };
    },
    idGenerator() {
      return 'notice-frame';
    },
  };

  let outputs = [];
  for await (let output of new EndTurnSummaryAgent().run(baseLoopParams({
    session: child,
    services: { frameRuntime: runtime },
  }))) {
    outputs.push(output);
    sequence.push(output.type);
  }

  assert.deepEqual(outputs.map((output) => output.type), [ 'AgentMessage', 'Done' ]);
  assert.deepEqual(sequence, [ 'AgentMessage', 'notice', 'Done' ]);
  assert.equal(postedFrames.length, 1);
  assert.equal(postedFrames[0].sessionID, parent.id);
  assert.equal(postedFrames[0].authorID, 'agent_1');
  assert.equal(postedFrames[0].targetAgentID, 'agent_2');
  assert.match(postedFrames[0].content.text, /Bot agent_1 in session ses_child has stopped/);
  assert.match(postedFrames[0].content.text, /Finished the child task/);
  assert.match(postedFrames[0].content.text, /Coordinator validation required/);
});

test('a failed coordinator notice does not prevent the final end-turn report', async () => {
  let child = {
    id: 'ses_child',
    parentSessionID: 'ses_parent',
    participantAgentIDs: [ 'agent_1' ],
    coordinatorAgentID: 'agent_1',
  };
  let parent = {
    id: 'ses_parent',
    participantAgentIDs: [ 'agent_2' ],
    coordinatorAgentID: 'agent_2',
  };
  let sessions = new Map([ [ child.id, child ], [ parent.id, parent ] ]);
  let warnings = [];
  let runtime = {
    async ensureSessionEntry(id) {
      return {
        session: sessions.get(id) || null,
        frameEngine: { merge: (frames) => frames },
      };
    },
    getSession(id) {
      return sessions.get(id) || null;
    },
    frameStore: {
      async flush() {
        throw new Error('store unavailable');
      },
    },
    nextClockStamp() {
      return { at: 123, clock: null };
    },
    idGenerator() {
      return 'notice-frame';
    },
  };

  let outputs = await collect(new EndTurnSummaryAgent().run(baseLoopParams({
    session: child,
    services: {
      frameRuntime: runtime,
      logger: { warn(message) { warnings.push(message); } },
    },
  })));

  assert.deepEqual(outputs.map((output) => output.type), [ 'AgentMessage', 'Done' ]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Unable to notify the coordinator/);
  assert.match(warnings[0], /store unavailable/);
});

test('AgentInterface base loop ends the turn silently for end-turn with no text and handles stop', async () => {
  // `end-turn` with no text is the replacement for the removed silence tool:
  // the loop finalizes with an empty final frame and no visible report.
  assert.deepEqual(await collect(new EndTurnSilentAgent().run(baseLoopParams({
    session: {
      id: 'ses_1',
      participantAgentIDs: [ 'agent_1', 'agent_2' ],
      coordinatorAgentID: 'agent_1',
    },
  }))), [
    {
      type: 'AgentMessage',
      content: {},
    },
    {
      type: 'Done',
      content: {
        status: 'finalized',
      },
    },
  ]);

  assert.deepEqual(await collect(new StopAgent().run(baseLoopParams())), [
    {
      type: 'Done',
      content: {
        status: 'break',
      },
    },
  ]);
});

test('AgentInterface base loop forwards provider Done usage through the agent loop', async () => {
  class UsageAgent extends AgentInterface {
    constructor(options = {}) {
      super(options);
      this.calls = 0;
    }

    async ask(_prompt, options = {}) {
      this.calls++;

      if (this.calls === 1) {
        options.tools['end-turn']({ text: 'usage answer' });
        return {
          type: 'Done',
          content: {
            usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
          },
        };
      }

      options.tools['end-turn']({ text: 'usage answer' });
      return { type: 'Done', content: {} };
    }
  }

  let outputs = await collect(new UsageAgent().run(baseLoopParams({ frames: [] })));

  assert.deepEqual(outputs, [
    {
      type: 'AgentMessage',
      content: { text: 'usage answer' },
    },
    {
      type: 'Done',
      content: {
        status: 'finalized',
        usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
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
  assert.equal(askCall.toolNames.includes('route'), false);
  assert.equal(askCall.toolDefinitions.some((tool) => tool.name === 'route'), false);
  assert.match(askCall.messageBrief, /coord:   false/);
  assert.match(askCall.messageBrief, /hello worker/);
  assert.doesNotMatch(askCall.startBrief, /COORDINATOR PREAMBLE/);
});

test('AgentInterface exposes the dual-verb turn tools to coordinated mentioned targets', async () => {
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
      authorType: 'user',
      authorID: 'usr_1',
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
  assert.equal(askCall.toolNames.includes('route'), false);
  assert.equal(askCall.toolNames.includes('end-turn'), true);
  assert.equal(askCall.toolNames.includes('continue-turn'), true);
  assert.equal(askCall.toolNames.some((name) => name.startsWith('agent-')), false);
  assert.equal(askCall.toolDefinitions.some((tool) => tool.name === 'route'), false);
  assert.equal(askCall.toolDefinitions.some((tool) => tool.name === 'end-turn'), true);
  assert.match(askCall.messageBrief, /coord:   false/);
  assert.match(askCall.messageBrief, /Hello Mr\. Bennett, how are you today\?/);
  assert.match(askCall.messageBrief, /End every turn one of two ways:/);
});

test('AgentInterface offers no silence tool below 3 parties; the dual-verb turn phrase still applies', async () => {
  // One user + one agent = 2 parties. The old silence tool is gone entirely, so
  // there is nothing to withhold; silence is now the text-less `end-turn`.
  let agent = new LoopAgent();
  await collect(agent.run(baseLoopParams({
    agent: { id: 'agent_1', name: 'Gemma', character: 'Careful.' },
    session: {
      id: 'ses_1',
      participantAgentIDs: [ 'agent_1' ],
      coordinatorAgentID: 'agent_1',
    },
    isCoordinator: true,
    frame: {
      id: 'msg_1',
      type: 'UserMessage',
      authorType: 'user',
      authorID: 'usr_1',
      content: { text: 'Hello! How are you today Gemma?' },
    },
  })));

  let askCall = agent.calls.find((call) => call.method === 'ask');
  assert.ok(askCall);
  assert.equal(askCall.toolNames.includes('agent-null-response'), false);
  assert.equal(askCall.toolDefinitions.some((tool) => tool.name === 'agent-null-response'), false);
  assert.doesNotMatch(askCall.startBrief, /agent-null-response/);
  assert.doesNotMatch(askCall.messageBrief, /agent-null-response/);
  assert.match(askCall.messageBrief, /End every turn one of two ways:/);
  assert.match(askCall.messageBrief, /- end-turn — with a REQUIRED short summary of goals completed/);
});

test('AgentInterface exposes agent-owned self-configuration tools', async () => {
  let updates = [];
  let agent = new CharacterSettingAgent();
  let outputs = await collect(agent.run(baseLoopParams({
    services: {
      agentManager: {
        async updateAgentCharacter(agentID, character, characterCompressed) {
          updates.push({ agentID, character, characterCompressed });
          return {
            id: agentID,
            character,
            characterCompressed,
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
    characterCompressed: 'Pirate engineer; direct and technical.',
  }]);
  assert.deepEqual(agent.toolResult, {
    type: 'ToolResult',
    action: 'set-character',
    content: {
      agentID: 'agent_1',
      character: 'You are a dirty swearing pirate and fantastic engineer.',
      characterCompressed: 'Pirate engineer; direct and technical.',
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
    () => collect(new MissingCompressedCharacterSettingAgent().run(baseLoopParams({
      services: {
        agentManager: {
          async updateAgentCharacter() {
            throw new Error('should not update');
          },
        },
      },
    }))),
    /compressedCharacter must be a non-empty string/,
  );

  await assert.rejects(
    () => collect(new OverLimitCompressedCharacterSettingAgent().run(baseLoopParams({
      services: {
        agentManager: {
          async updateAgentCharacter() {
            throw new Error('should not update');
          },
        },
      },
    }))),
    /compressedCharacter must be 400 characters or fewer/,
  );

  await assert.rejects(
    () => collect(new CharacterSettingAgent().run(baseLoopParams())),
    /set-character requires agentManager/,
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
      authorType: 'user',
      authorID: 'usr_1',
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
    tokenUsage: {
      'openai/chatgpt/codex-agent': {
        tokensUsed: 42,
        createdAt: 'first',
        updatedAt: 'now',
      },
    },
    totalTokensUsed: 42,
    ...overrides,
  };
}

async function collect(iterable) {
  let items = [];
  for await (let item of iterable)
    items.push(item);
  return items;
}


test('providers can record the final model prompt against the trigger user message', async () => {
  let calls = [];
  let runtime = {
    async recordModelPrompt(sessionID, frameID, prompt) {
      calls.push({ sessionID, frameID, prompt });
      return { id: frameID };
    },
  };
  let agent = new AgentInterface({
    services: { frameRuntime: runtime },
    agent: { id: 'agent_1', name: 'Zav' },
  });
  let frame = {
    id: 'msg_1',
    type: 'UserMessage',
    authorType: 'user',
    hidden: false,
    sessionID: 'ses_1',
    content: { text: 'Please implement it.' },
  };

  await agent.recordModelPrompt(
    [ { role: 'user', content: 'Message from Wyatt:\nPlease implement it.' } ],
    { userFrame: frame, session: { id: 'ses_1' }, agent: { id: 'agent_1', name: 'Zav' } },
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].sessionID, 'ses_1');
  assert.equal(calls[0].frameID, 'msg_1');
  assert.equal(calls[0].prompt.userText, 'Please implement it.');
  assert.equal(calls[0].prompt.agentName, 'Zav');
  assert.deepEqual(calls[0].prompt.messages, [
    { role: 'user', content: 'Message from Wyatt:\nPlease implement it.' },
  ]);
});

test('providers skip prompt recording for hidden internal wakes', async () => {
  let calls = 0;
  let agent = new AgentInterface({
    services: { frameRuntime: { async recordModelPrompt() { calls++; } } },
  });
  await agent.recordModelPrompt([ { role: 'user', content: 'internal' } ], {
    userFrame: { id: 'wake', type: 'UserMessage', authorType: 'user', hidden: true, content: { text: 'internal' } },
    session: { id: 'ses_1' },
  });
  assert.equal(calls, 0);
});

test('providers do not record compaction or one-shot prompts against a user message', async () => {
  let calls = 0;
  let agent = new AgentInterface({
    services: { frameRuntime: { async recordModelPrompt() { calls++; } } },
  });
  let frame = { id: 'msg_1', type: 'UserMessage', authorType: 'user', hidden: false, sessionID: 'ses_1', content: { text: 'Please commit.' } };
  for (let flags of [ { compaction: true }, { oneShot: true }, { rawPrompt: true } ]) {
    await agent.recordModelPrompt([ { role: 'user', content: 'huge compaction prompt' } ], {
      userFrame: frame,
      session: { id: 'ses_1' },
      ...flags,
    });
  }
  assert.equal(calls, 0);
});
