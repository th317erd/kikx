'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { AgentRouteFramePlugin } from '../../../src/core/agents/agent-route-frame-plugin.mjs';
import { CommandRegistry } from '../../../src/core/commands/index.mjs';
import { AgentInterface, PluginRegistry } from '../../../src/core/plugins/index.mjs';
import { FrameRouter } from '../../../src/core/routing/index.mjs';
import { FrameRuntime } from '../../../src/core/runtime/frame-runtime.mjs';

class StreamingAgentProvider extends AgentInterface {
  static pluginID = 'streaming-agent';

  async *run(params = {}) {
    params.services.calls.push({
      method: 'response-frame-before-run',
      responseFrame: params.responseFrame,
    });
    params.services.calls.push({
      method: 'run',
      agentID: params.agent.id,
      apiKey: params.secrets.apiKey,
      text: params.frame.content.text,
      responseFrameID: params.responseFrameID,
      responseFrameIDMatchesFrame: params.responseFrameID === params.responseFrame?.id,
      frameTypes: params.frames.map((frame) => frame.type),
      isCoordinator: params.isCoordinator,
      coordinatorAgentID: params.coordinatorAgentID,
      coordinated: params.frame.coordinated === true,
      mentions: params.frame.mentions || {},
    });

    yield {
      id: 'think_1',
      type: 'AgentThinking',
      phantom: true,
      content: {
        text: 'thinking...',
        thinking: { text: 'thinking...' },
      },
    };
    yield {
      type: 'AgentMessage',
      content: {
        text: `Echo: ${params.frame.content.text}`,
        thinking: { text: 'thinking...' },
      },
    };
    yield {
      type: 'Done',
      content: { usage: { inputTokens: 1, outputTokens: 2 } },
    };
  }
}

class ForwardingAgentProvider extends AgentInterface {
  static pluginID = 'forwarding-agent';

  async ask(_prompt, params = {}) {
    params.services.calls.push({
      method: 'ask',
      agentID: params.agent.id,
      isCoordinator: params.isCoordinator,
      coordinated: params.frame.coordinated === true,
    });

    return params.tools['internal-forward']([ 'agent_2', 'agent_3' ], 'forwarded by coordinator');
  }
}

class FailingAgentProvider extends AgentInterface {
  static pluginID = 'failing-agent';

  async *run() {
    throw new Error('provider exploded');
  }
}

test('AgentRouteFramePlugin dispatches normal user messages to invited provider plugins', async () => {
  let runtime = createRuntime({
    session: {
      participantAgentIDs: [ 'agent_1' ],
    },
    agents: new Map([
      [ 'agent_1', {
        id: 'agent_1',
        name: 'Coder',
        pluginID: 'streaming-agent',
        config: { model: 'test-model' },
        secrets: { apiKey: 'sk-test' },
        enabled: true,
      } ],
    ]),
  });

  await runtime.createSession({ title: 'Scratch', participantAgentIDs: [ 'agent_1' ] });
  let phantoms = [];
  runtime.requireSessionEntry('ses_1').frameEngine.on('frame:phantom', ({ frame }) => phantoms.push(frame));

  await runtime.appendUserMessage('ses_1', { text: 'hello', userID: 'usr_1' });

  let frames = await runtime.listFrames('ses_1');
  assert.equal(runtime.services.calls[0].method, 'response-frame-before-run');
  assert.equal(runtime.services.calls[0].responseFrame.id, 'agent_frame_1');
  assert.equal(runtime.services.calls[0].responseFrame.type, 'AgentMessage');
  assert.equal(runtime.services.calls[0].responseFrame.hidden, true);
  assert.deepEqual(runtime.services.calls[0].responseFrame.content, {
    text: '',
    thinking: {
      text: '',
      status: 'pending',
    },
    status: 'streaming',
  });
  assert.deepEqual(runtime.services.calls[1], {
    method: 'run',
    agentID: 'agent_1',
    apiKey: 'sk-test',
    text: 'hello',
    responseFrameID: 'agent_frame_1',
    responseFrameIDMatchesFrame: true,
    frameTypes: [ 'UserMessage', 'AgentMessage' ],
    isCoordinator: true,
    coordinatorAgentID: 'agent_1',
    coordinated: false,
    mentions: {},
  });
  assert.deepEqual(phantoms.map((frame) => frame.type), [ 'AgentThinking' ]);
  assert.deepEqual(frames.map((frame) => frame.type), [ 'UserMessage', 'AgentMessage' ]);
  assert.equal(frames[1].id, 'agent_frame_1');
  assert.equal(frames[1].parentID, 'msg_1');
  assert.equal(frames[1].interactionID, 'int_1');
  assert.equal(frames[1].authorType, 'agent');
  assert.equal(frames[1].authorID, 'agent_1');
  assert.equal(frames[1].hidden, false);
  assert.equal(frames[1].content.text, 'Echo: hello');
  assert.deepEqual(frames[1].content.thinking, {
    text: 'thinking...',
    status: 'complete',
  });
  assert.equal(frames[1].content.status, 'complete');
  assert.equal(phantoms[0].id, 'think_1');
  assert.equal(phantoms[0].responseFrameID, 'agent_frame_1');
  assert.equal(phantoms[0].parentID, 'msg_1');
});

test('AgentRouteFramePlugin dispatches normal user messages only to the session coordinator', async () => {
  let runtime = createRuntime({
    agents: new Map([
      [ 'agent_1', {
        id: 'agent_1',
        name: 'Coder',
        pluginID: 'streaming-agent',
        config: {},
        secrets: { apiKey: 'sk-one' },
        enabled: true,
      } ],
      [ 'agent_2', {
        id: 'agent_2',
        name: 'Reviewer',
        pluginID: 'streaming-agent',
        config: {},
        secrets: { apiKey: 'sk-two' },
        enabled: true,
      } ],
    ]),
  });

  await runtime.createSession({
    title: 'Scratch',
    participantAgentIDs: [ 'agent_1', 'agent_2' ],
    coordinatorAgentID: 'agent_2',
  });
  await runtime.appendUserMessage('ses_1', { text: 'hello', userID: 'usr_1' });

  let calls = runtime.services.calls.filter((call) => call.method === 'run');
  assert.deepEqual(calls.map((call) => call.agentID), [ 'agent_2' ]);
  assert.equal(calls[0].apiKey, 'sk-two');
  assert.equal(calls[0].isCoordinator, true);
  assert.equal(calls[0].coordinatorAgentID, 'agent_2');
});

test('AgentRouteFramePlugin forwards coordinated frames to all mentioned session agents', async () => {
  let runtime = createRuntime({
    agents: new Map([
      [ 'agent_1', {
        id: 'agent_1',
        name: 'Coordinator',
        pluginID: 'streaming-agent',
        config: {},
        secrets: { apiKey: 'sk-one' },
        enabled: true,
      } ],
      [ 'agent_2', {
        id: 'agent_2',
        name: 'Worker A',
        pluginID: 'streaming-agent',
        config: {},
        secrets: { apiKey: 'sk-two' },
        enabled: true,
      } ],
      [ 'agent_3', {
        id: 'agent_3',
        name: 'Worker B',
        pluginID: 'streaming-agent',
        config: {},
        secrets: { apiKey: 'sk-three' },
        enabled: true,
      } ],
    ]),
  });

  await runtime.createSession({
    title: 'Scratch',
    participantAgentIDs: [ 'agent_1', 'agent_2', 'agent_3' ],
    coordinatorAgentID: 'agent_1',
  });
  let entry = runtime.requireSessionEntry('ses_1');
  entry.frameEngine.merge([{
    id: 'msg_1',
    type: 'UserMessage',
    sessionID: 'ses_1',
    interactionID: 'int_1',
    authorType: 'user',
    content: { text: 'hello mentioned agents' },
    mentions: {
      agent_2: { id: 'agent_2', type: 'agent', name: 'Worker A' },
      agent_3: { id: 'agent_3', type: 'agent', name: 'Worker B' },
    },
    coordinated: true,
    hidden: false,
  }]);
  await runtime.frameRouter.flush();

  let calls = runtime.services.calls.filter((call) => call.method === 'run');
  assert.deepEqual(calls.map((call) => call.agentID), [ 'agent_2', 'agent_3' ]);
  assert.deepEqual(calls.map((call) => call.coordinated), [ true, true ]);
  assert.deepEqual(calls.map((call) => Object.keys(call.mentions)), [
    [ 'agent_2', 'agent_3' ],
    [ 'agent_2', 'agent_3' ],
  ]);
  assert.deepEqual(calls.map((call) => call.isCoordinator), [ false, false ]);
});

test('AgentRouteFramePlugin coordinator forward mutates and requeues the original frame', async () => {
  let runtime = createRuntime({
    agents: new Map([
      [ 'agent_1', {
        id: 'agent_1',
        name: 'Coordinator',
        pluginID: 'forwarding-agent',
        config: {},
        secrets: {},
        enabled: true,
      } ],
      [ 'agent_2', {
        id: 'agent_2',
        name: 'Worker A',
        pluginID: 'streaming-agent',
        config: {},
        secrets: { apiKey: 'sk-two' },
        enabled: true,
      } ],
      [ 'agent_3', {
        id: 'agent_3',
        name: 'Worker B',
        pluginID: 'streaming-agent',
        config: {},
        secrets: { apiKey: 'sk-three' },
        enabled: true,
      } ],
    ]),
  });

  await runtime.createSession({
    title: 'Scratch',
    participantAgentIDs: [ 'agent_1', 'agent_2', 'agent_3' ],
    coordinatorAgentID: 'agent_1',
  });
  await runtime.appendUserMessage('ses_1', { text: 'please coordinate this', userID: 'usr_1' });

  let calls = runtime.services.calls.filter((call) => call.method === 'ask' || call.method === 'run');
  assert.deepEqual(calls.map((call) => `${call.method}:${call.agentID}`), [
    'ask:agent_1',
    'run:agent_2',
    'run:agent_3',
  ]);
  assert.equal(calls[0].isCoordinator, true);
  assert.deepEqual(calls.slice(1).map((call) => call.coordinated), [ true, true ]);

  let userFrame = (await runtime.listFrames('ses_1')).find((frame) => frame.type === 'UserMessage');
  assert.equal(userFrame.coordinated, true);
  assert.deepEqual(Object.keys(userFrame.mentions), [ 'agent_2', 'agent_3' ]);
  assert.equal(userFrame.mentions.agent_2.name, 'Worker A');
  assert.equal(userFrame.mentions.agent_3.name, 'Worker B');

  let coordinatorFrame = (await runtime.listFrames('ses_1')).find((frame) => frame.authorID === 'agent_1');
  assert.equal(coordinatorFrame.deleted, true);
  assert.equal(coordinatorFrame.hidden, true);
});

test('AgentRouteFramePlugin does nothing when a session has no invited agents', async () => {
  let runtime = createRuntime();

  await runtime.createSession({ title: 'Scratch' });
  await runtime.appendUserMessage('ses_1', { text: 'hello' });

  assert.deepEqual(runtime.services.calls, []);
  assert.deepEqual((await runtime.listFrames('ses_1')).map((frame) => frame.type), [ 'UserMessage' ]);
});

test('AgentRouteFramePlugin routes coordinator failures without broadcasting to other participants', async () => {
  let runtime = createRuntime({
    session: {
      participantAgentIDs: [ 'agent_disabled', 'agent_missing_provider', 'agent_failing' ],
    },
    agents: new Map([
      [ 'agent_disabled', {
        id: 'agent_disabled',
        name: 'Disabled',
        pluginID: 'streaming-agent',
        config: {},
        secrets: {},
        enabled: false,
      } ],
      [ 'agent_missing_provider', {
        id: 'agent_missing_provider',
        name: 'Missing Provider',
        pluginID: 'missing-provider',
        config: {},
        secrets: {},
        enabled: true,
      } ],
      [ 'agent_failing', {
        id: 'agent_failing',
        name: 'Failing',
        pluginID: 'failing-agent',
        config: {},
        secrets: {},
        enabled: true,
      } ],
    ]),
  });

  await runtime.createSession({
    title: 'Scratch',
    participantAgentIDs: [ 'agent_disabled', 'agent_missing_provider', 'agent_failing' ],
    coordinatorAgentID: 'agent_failing',
  });
  await runtime.appendUserMessage('ses_1', { text: 'hello' });

  let frames = await runtime.listFrames('ses_1');
  assert.deepEqual(frames.map((frame) => frame.type), [ 'UserMessage', 'AgentMessage' ]);
  assert.match(frames[1].content.text, /provider exploded/);
  assert.equal(frames[1].authorID, 'agent_failing');
  assert.equal(frames[1].content.status, 'error');
  assert.equal(frames[1].hidden, false);
  assert.deepEqual(runtime.services.calls.filter((call) => call.method === 'run'), []);
});

test('AgentRouteFramePlugin writes a visible error when the coordinator is disabled', async () => {
  let runtime = createRuntime({
    agents: new Map([
      [ 'agent_disabled', {
        id: 'agent_disabled',
        name: 'Disabled',
        pluginID: 'streaming-agent',
        config: {},
        secrets: {},
        enabled: false,
      } ],
      [ 'agent_enabled', {
        id: 'agent_enabled',
        name: 'Enabled',
        pluginID: 'streaming-agent',
        config: {},
        secrets: { apiKey: 'sk-enabled' },
        enabled: true,
      } ],
    ]),
  });

  await runtime.createSession({
    title: 'Scratch',
    participantAgentIDs: [ 'agent_disabled', 'agent_enabled' ],
    coordinatorAgentID: 'agent_disabled',
  });
  await runtime.appendUserMessage('ses_1', { text: 'hello' });

  let frames = await runtime.listFrames('ses_1');
  assert.deepEqual(frames.map((frame) => frame.type), [ 'UserMessage', 'AgentError' ]);
  assert.equal(frames[1].authorID, 'agent_disabled');
  assert.match(frames[1].content.text, /Agent is disabled: agent_disabled/);
  assert.deepEqual(runtime.services.calls.filter((call) => call.method === 'run'), []);
});

test('AgentRouteFramePlugin requests agent secrets through AgentManager', async () => {
  let calls = [];
  let runtime = createRuntime({
    session: {
      participantAgentIDs: [ 'agent_1' ],
    },
    agentManager: {
      async getAgent(agentID, options) {
        calls.push({ agentID, options });
        return {
          id: agentID,
          name: 'Coder',
          pluginID: 'streaming-agent',
          config: {},
          secrets: { apiKey: 'sk-test' },
          enabled: true,
        };
      },
    },
  });

  await runtime.createSession({ title: 'Scratch', participantAgentIDs: [ 'agent_1' ] });
  await runtime.appendUserMessage('ses_1', { text: 'hello' });

  assert.deepEqual(calls, [{
    agentID: 'agent_1',
    options: { includeSecrets: true },
  }]);
});

function createRuntime(options = {}) {
  let pluginRegistry = new PluginRegistry({ logger: quietLogger() });
  pluginRegistry.registerAgentProvider('streaming-agent', StreamingAgentProvider);
  pluginRegistry.registerAgentProvider('forwarding-agent', ForwardingAgentProvider);
  pluginRegistry.registerAgentProvider('failing-agent', FailingAgentProvider);

  let agents = options.agents || new Map();
  let agentManager = options.agentManager || {
    async getAgent(agentID) {
      return agents.get(agentID) || null;
    },
  };
  let commandRegistry = new CommandRegistry({ logger: quietLogger() });
  let router = new FrameRouter({ logger: quietLogger() });
  router.registerSelector('Type:UserMessage', AgentRouteFramePlugin, AgentRouteFramePlugin.pluginID);

  let services = {
    calls: [],
    pluginRegistry,
    agentManager,
    commandRegistry,
    context: {
      require(name) {
        if (name === 'pluginRegistry')
          return pluginRegistry;

        if (name === 'agentManager')
          return agentManager;

        if (name === 'commandRegistry')
          return commandRegistry;

        throw new Error(`Unknown service: ${name}`);
      },
    },
  };

  let ids = [
    'ses_1',
    'int_1',
    'msg_1',
    'commit_1',
    'agent_frame_1',
    'commit_2',
    'agent_frame_2',
    'commit_3',
    'agent_frame_3',
    'commit_4',
  ];
  let runtime = new FrameRuntime({
    aeordb: createClient(),
    frameRouter: router,
    services,
    clock: () => 1000,
    idGenerator: () => ids.shift(),
  });
  runtime.services = services;
  return runtime;
}

function createClient() {
  return {
    calls: [],
    files: new Map(),
    async putFile(path, body) {
      this.calls.push({ method: 'putFile', path, body });
      this.files.set(path, body);
      return { path };
    },
    async getFile(path) {
      this.calls.push({ method: 'getFile', path });
      return this.files.get(path) || null;
    },
    async listDirectory(path, requestOptions) {
      this.calls.push({ method: 'listDirectory', path, options: requestOptions });
      let prefix = `${path.replace(/\/+$/g, '')}/`;
      return {
        items: [ ...this.files.keys() ]
          .filter((filePath) => filePath.startsWith(prefix))
          .map((filePath) => ({ path: filePath })),
      };
    },
  };
}

function quietLogger() {
  return {
    error() {},
    warn() {},
    log() {},
  };
}
