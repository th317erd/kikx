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
      frameType: params.frame.type,
      frameAuthorID: params.frame.authorID || null,
      agentRoute: params.frame.agentRoute || null,
      responseFrameAgentRoute: params.responseFrame?.agentRoute || null,
      text: params.frame.content.text,
      responseFrameID: params.responseFrameID,
      responseFrameIDMatchesFrame: params.responseFrameID === params.responseFrame?.id,
      frameTypes: params.frames.map((frame) => frame.type),
      isCoordinator: params.isCoordinator,
      coordinatorAgentID: params.coordinatorAgentID,
      coordinated: params.frame.coordinated === true,
      mentions: params.frame.mentions || {},
      participantAgents: params.participantAgents,
    });

    if (params.frame.type === 'AgentMessage') {
      yield {
        type: 'Done',
        content: {
          status: 'null-response',
          usage: { inputTokens: 1, outputTokens: 0 },
        },
      };
      return;
    }

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
      frameType: params.frame.type,
      frameAuthorID: params.frame.authorID || null,
      isCoordinator: params.isCoordinator,
      coordinated: params.frame.coordinated === true,
    });

    return params.tools['internal-forward']([ 'agent_2', 'agent_3' ], 'forwarded by coordinator');
  }
}

class ServiceForwardingAgentProvider extends AgentInterface {
  static pluginID = 'service-forwarding-agent';

  async *run(params = {}) {
    let priorCalls = params.services.calls.filter((call) => call.method === 'service-forward').length;
    params.services.calls.push({
      method: 'service-forward',
      agentID: params.agent.id,
      isCoordinator: params.isCoordinator,
      coordinated: params.frame.coordinated === true,
    });

    if (priorCalls > 0)
      throw new Error('forward loop detected');

    await params.services.forwardFrame({
      frame: params.frame,
      targets: [ params.agent.id ],
      message: 'target agent attempted to re-forward',
    });

    yield {
      type: 'Done',
      content: {
        status: 'forwarded',
      },
    };
  }
}

class NullResponseAgentProvider extends AgentInterface {
  static pluginID = 'null-response-agent';

  async *run(params = {}) {
    params.services.calls.push({
      method: 'null-response',
      agentID: params.agent.id,
      isCoordinator: params.isCoordinator,
      coordinated: params.frame.coordinated === true,
    });

    yield {
      type: 'Done',
      content: {
        status: 'null-response',
      },
    };
  }
}

class FailingAgentProvider extends AgentInterface {
  static pluginID = 'failing-agent';

  async *run() {
    throw new Error('provider exploded');
  }
}

class ContinuingAgentProvider extends AgentInterface {
  static pluginID = 'continuing-agent';

  async *run(params = {}) {
    params.services.calls.push({
      method: 'continuing-run',
      agentID: params.agent.id,
      frameType: params.frame.type,
      parentID: params.frame.parentID || null,
      targetAgentID: params.frame.targetAgentID || null,
      text: params.frame.content?.text || '',
    });

    if (params.frame.authorID === 'internal:agent-continuation') {
      yield {
        type: 'AgentMessage',
        content: {
          text: 'Continued after timer.',
        },
      };
      yield {
        type: 'Done',
        content: {
          status: 'finalized',
        },
      };
      return;
    }

    yield {
      type: 'AgentMessage',
      content: {
        text: 'Initial response before the boomerang.',
      },
    };
    yield {
      type: 'Done',
      content: {
        status: 'respond-and-continue',
        continuation: {
          delayMs: 0,
          continuationPrompt: 'Please run the next step now.',
        },
      },
    };
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
  assert.equal(runtime.services.calls[0].responseFrame.authorDisplayName, 'Coder');
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
    frameType: 'UserMessage',
    frameAuthorID: 'usr_1',
    agentRoute: null,
    responseFrameAgentRoute: {
      rootFrameID: 'msg_1',
      sourceFrameID: 'msg_1',
      path: [ 'agent_1' ],
    },
    text: 'hello',
    responseFrameID: 'agent_frame_1',
    responseFrameIDMatchesFrame: true,
    frameTypes: [ 'UserMessage', 'AgentMessage' ],
    isCoordinator: true,
    coordinatorAgentID: 'agent_1',
    coordinated: false,
    mentions: {},
    participantAgents: [
      {
        id: 'agent_1',
        name: 'Coder',
        pluginID: 'streaming-agent',
      },
    ],
  });
  assert.deepEqual(phantoms.map((frame) => frame.type), [ 'AgentThinking' ]);
  assert.deepEqual(frames.map((frame) => frame.type), [ 'UserMessage', 'AgentMessage' ]);
  assert.equal(frames[1].id, 'agent_frame_1');
  assert.equal(frames[1].parentID, 'msg_1');
  assert.equal(frames[1].interactionID, 'int_1');
  assert.equal(frames[1].authorType, 'agent');
  assert.equal(frames[1].authorID, 'agent_1');
  assert.equal(frames[1].authorDisplayName, 'Coder');
  assert.equal(frames[1].hidden, false);
  assert.equal(frames[1].content.text, 'Echo: hello');
  assert.deepEqual(frames[1].content.thinking, {
    text: 'thinking...',
    status: 'complete',
  });
  assert.equal(frames[1].content.status, 'complete');
  assert.deepEqual(frames[0].tokenUsage, {
    'streaming-agent': {
      createdAt: 1000,
      inputTokens: 1,
      readTokens: 1,
      tokensUsed: 1,
      updatedAt: 1000,
    },
  });
  assert.deepEqual(frames[1].tokenUsage, {
    'streaming-agent': {
      createdAt: 1000,
      inputTokens: 1,
      outputTokens: 2,
      readTokens: 1,
      tokensUsed: 3,
      updatedAt: 1000,
      writeTokens: 2,
    },
  });
  assert.deepEqual(runtime.services.tokenUsage.calls, [{
    serviceKey: 'streaming-agent',
    usage: {
      inputTokens: 1,
      outputTokens: 2,
      readTokens: 1,
      serviceKey: '',
      tokensUsed: 3,
      tracked: false,
      writeTokens: 2,
    },
    options: { updatedAt: 1000 },
  }]);
  assert.equal(phantoms[0].id, 'think_1');
  assert.equal(phantoms[0].responseFrameID, 'agent_frame_1');
  assert.equal(phantoms[0].parentID, 'msg_1');
  assert.equal(phantoms[0].authorDisplayName, 'Coder');
});

test('AgentRouteFramePlugin dispatches normal user messages to all session agents with coordinator first', async () => {
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

  let calls = runtime.services.calls
    .filter((call) => call.method === 'run' && call.frameType === 'UserMessage');
  let userCalls = calls.filter((call) => call.frameType === 'UserMessage');
  assert.deepEqual(userCalls.map((call) => call.agentID), [ 'agent_2', 'agent_1' ]);
  assert.equal(userCalls[0].apiKey, 'sk-two');
  assert.equal(userCalls[0].isCoordinator, true);
  assert.equal(userCalls[0].coordinatorAgentID, 'agent_2');
  assert.deepEqual(userCalls[0].responseFrameAgentRoute.path, [ 'agent_2' ]);
  assert.equal(userCalls[1].apiKey, 'sk-one');
  assert.equal(userCalls[1].isCoordinator, false);
  assert.equal(userCalls[1].coordinatorAgentID, 'agent_2');
  assert.deepEqual(userCalls[1].responseFrameAgentRoute.path, [ 'agent_1' ]);
});

test('AgentRouteFramePlugin broadcasts visible agent messages to other session agents', async () => {
  let runtime = createRuntime({
    agents: new Map([
      [ 'agent_1', {
        id: 'agent_1',
        name: 'Speaker',
        pluginID: 'streaming-agent',
        config: {},
        secrets: { apiKey: 'sk-one' },
        enabled: true,
      } ],
      [ 'agent_2', {
        id: 'agent_2',
        name: 'Listener A',
        pluginID: 'streaming-agent',
        config: {},
        secrets: { apiKey: 'sk-two' },
        enabled: true,
      } ],
      [ 'agent_3', {
        id: 'agent_3',
        name: 'Listener B',
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
    id: 'agent_msg_1',
    type: 'AgentMessage',
    sessionID: 'ses_1',
    interactionID: 'int_1',
    parentID: 'user_msg_1',
    authorType: 'agent',
    authorID: 'agent_1',
    authorDisplayName: 'Speaker',
    hidden: false,
    content: {
      text: 'Agent one has a point.',
      status: 'complete',
    },
    agentRoute: {
      rootFrameID: 'user_msg_1',
      sourceFrameID: 'user_msg_1',
      path: [ 'agent_1' ],
    },
  }]);
  await runtime.frameRouter.flush();

  let calls = runtime.services.calls
    .filter((call) => call.method === 'run' && call.frameType === 'AgentMessage');
  assert.deepEqual(calls.map((call) => call.agentID), [ 'agent_2', 'agent_3' ]);
  assert.deepEqual(calls.map((call) => call.frameType), [ 'AgentMessage', 'AgentMessage' ]);
  assert.deepEqual(calls.map((call) => call.frameAuthorID), [ 'agent_1', 'agent_1' ]);
  assert.deepEqual(calls.map((call) => call.text), [
    'Agent one has a point.',
    'Agent one has a point.',
  ]);
  assert.deepEqual(calls.map((call) => call.responseFrameAgentRoute.path), [
    [ 'agent_1', 'agent_2' ],
    [ 'agent_1', 'agent_3' ],
  ]);
});

test('AgentRouteFramePlugin ignores hidden and streaming agent message placeholders', async () => {
  let runtime = createRuntime({
    agents: new Map([
      [ 'agent_1', {
        id: 'agent_1',
        name: 'Speaker',
        pluginID: 'streaming-agent',
        config: {},
        secrets: { apiKey: 'sk-one' },
        enabled: true,
      } ],
      [ 'agent_2', {
        id: 'agent_2',
        name: 'Listener',
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
    coordinatorAgentID: 'agent_1',
  });
  let entry = runtime.requireSessionEntry('ses_1');
  entry.frameEngine.merge([{
    id: 'hidden_agent_msg',
    type: 'AgentMessage',
    sessionID: 'ses_1',
    interactionID: 'int_1',
    parentID: 'user_msg_1',
    authorType: 'agent',
    authorID: 'agent_1',
    hidden: true,
    content: {
      text: '',
      status: 'streaming',
    },
    agentRoute: {
      rootFrameID: 'user_msg_1',
      sourceFrameID: 'user_msg_1',
      path: [ 'agent_1' ],
    },
  }, {
    id: 'visible_streaming_agent_msg',
    type: 'AgentMessage',
    sessionID: 'ses_1',
    interactionID: 'int_1',
    parentID: 'user_msg_1',
    authorType: 'agent',
    authorID: 'agent_1',
    hidden: false,
    content: {
      text: 'partial',
      status: 'streaming',
    },
    agentRoute: {
      rootFrameID: 'user_msg_1',
      sourceFrameID: 'user_msg_1',
      path: [ 'agent_1' ],
    },
  }]);
  await runtime.frameRouter.flush();

  assert.deepEqual(runtime.services.calls.filter((call) => call.method === 'run'), []);
});

test('AgentRouteFramePlugin broadcasts second-hop agent responses to other participants', async () => {
  let runtime = createRuntime({
    agents: new Map([
      [ 'agent_1', {
        id: 'agent_1',
        name: 'Speaker',
        pluginID: 'streaming-agent',
        config: {},
        secrets: { apiKey: 'sk-one' },
        enabled: true,
      } ],
      [ 'agent_2', {
        id: 'agent_2',
        name: 'Listener A',
        pluginID: 'streaming-agent',
        config: {},
        secrets: { apiKey: 'sk-two' },
        enabled: true,
      } ],
      [ 'agent_3', {
        id: 'agent_3',
        name: 'Listener B',
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
    id: 'agent_reply_1',
    type: 'AgentMessage',
    sessionID: 'ses_1',
    interactionID: 'int_1',
    parentID: 'agent_msg_1',
    authorType: 'agent',
    authorID: 'agent_2',
    authorDisplayName: 'Listener A',
    hidden: false,
    content: {
      text: 'Replying to the first agent.',
      status: 'complete',
    },
    agentRoute: {
      rootFrameID: 'user_msg_1',
      sourceFrameID: 'agent_msg_1',
      path: [ 'agent_1', 'agent_2' ],
    },
  }]);
  await runtime.frameRouter.flush();

  let calls = runtime.services.calls
    .filter((call) => call.method === 'run' && call.frameType === 'AgentMessage');
  assert.deepEqual(calls.map((call) => call.agentID), [ 'agent_1', 'agent_3' ]);
  assert.deepEqual(calls.map((call) => call.frameAuthorID), [ 'agent_2', 'agent_2' ]);
});

test('AgentRouteFramePlugin passes all session agent names without secrets to providers', async () => {
  let runtime = createRuntime({
    agents: new Map([
      [ 'agent_1', {
        id: 'agent_1',
        name: 'Iron-Hand McGuffin',
        pluginID: 'streaming-agent',
        config: { model: 'coordinator-model' },
        secrets: { apiKey: 'sk-one' },
        enabled: true,
      } ],
      [ 'agent_2', {
        id: 'agent_2',
        name: 'Mr. Bennett',
        pluginID: 'streaming-agent',
        config: { model: 'target-model' },
        secrets: { apiKey: 'sk-two' },
        enabled: true,
      } ],
    ]),
  });

  await runtime.createSession({
    title: 'Scratch',
    participantAgentIDs: [ 'agent_1', 'agent_2' ],
    coordinatorAgentID: 'agent_1',
  });
  await runtime.appendUserMessage('ses_1', { text: 'what is your favorite color?', userID: 'usr_1' });

  let call = runtime.services.calls.find((entry) => entry.method === 'run');
  assert.ok(call);
  assert.deepEqual(call.participantAgents, [
    {
      id: 'agent_1',
      name: 'Iron-Hand McGuffin',
      pluginID: 'streaming-agent',
    },
    {
      id: 'agent_2',
      name: 'Mr. Bennett',
      pluginID: 'streaming-agent',
    },
  ]);
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
    id: 'user_msg_1',
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

  let calls = runtime.services.calls
    .filter((call) => call.method === 'run' && call.frameType === 'UserMessage');
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

  let calls = runtime.services.calls
    .filter((call) => (call.method === 'ask' || call.method === 'run') && call.frameType === 'UserMessage');
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

test('AgentRouteFramePlugin rejects forwarded-frame requeue from non-coordinator targets', async () => {
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
        name: 'Mr. Bennett',
        pluginID: 'service-forwarding-agent',
        config: {},
        secrets: {},
        enabled: true,
      } ],
    ]),
  });

  await runtime.createSession({
    title: 'Scratch',
    participantAgentIDs: [ 'agent_1', 'agent_2' ],
    coordinatorAgentID: 'agent_1',
  });
  let entry = runtime.requireSessionEntry('ses_1');
  entry.frameEngine.merge([{
    id: 'user_msg_1',
    type: 'UserMessage',
    sessionID: 'ses_1',
    interactionID: 'int_1',
    authorType: 'user',
    content: { text: 'Mr. Bennett, are you there?' },
    mentions: {
      agent_2: { id: 'agent_2', type: 'agent', name: 'Mr. Bennett' },
    },
    coordinated: true,
    hidden: false,
  }]);
  await runtime.frameRouter.flush();

  let calls = runtime.services.calls.filter((call) => call.method === 'service-forward');
  assert.deepEqual(calls, [{
    method: 'service-forward',
    agentID: 'agent_2',
    isCoordinator: false,
    coordinated: true,
  }]);

  let frames = await runtime.listFrames('ses_1');
  let userFrame = frames.find((frame) => frame.id === 'user_msg_1');
  assert.equal(userFrame.coordinated, true);
  assert.deepEqual(Object.keys(userFrame.mentions), [ 'agent_2' ]);

  let agentFrames = frames.filter((frame) => frame.authorID === 'agent_2');
  assert.equal(agentFrames.length, 1);
  assert.equal(agentFrames[0].hidden, false);
  assert.equal(agentFrames[0].deleted, false);
  assert.equal(agentFrames[0].content.status, 'error');
  assert.match(agentFrames[0].content.text, /Only the session coordinator can forward frames/);
});

test('AgentRouteFramePlugin cleans up silent response placeholders', async () => {
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
        name: 'Mr. Bennett',
        pluginID: 'null-response-agent',
        config: {},
        secrets: {},
        enabled: true,
      } ],
    ]),
  });

  await runtime.createSession({
    title: 'Scratch',
    participantAgentIDs: [ 'agent_1', 'agent_2' ],
    coordinatorAgentID: 'agent_1',
  });
  let entry = runtime.requireSessionEntry('ses_1');
  entry.frameEngine.merge([{
    id: 'user_msg_1',
    type: 'UserMessage',
    sessionID: 'ses_1',
    interactionID: 'int_1',
    authorType: 'user',
    content: { text: 'This is already handled elsewhere.' },
    mentions: {
      agent_2: { id: 'agent_2', type: 'agent', name: 'Mr. Bennett' },
    },
    coordinated: true,
    hidden: false,
  }]);
  await runtime.frameRouter.flush();

  let calls = runtime.services.calls.filter((call) => call.method === 'null-response');
  assert.deepEqual(calls, [{
    method: 'null-response',
    agentID: 'agent_2',
    isCoordinator: false,
    coordinated: true,
  }]);

  let agentFrames = (await runtime.listFrames('ses_1')).filter((frame) => frame.authorID === 'agent_2');
  assert.equal(agentFrames.length, 1);
  assert.equal(agentFrames[0].hidden, true);
  assert.equal(agentFrames[0].deleted, true);
  assert.equal(agentFrames[0].content.status, 'null-response');
});

test('AgentRouteFramePlugin schedules respond-and-continue as a generic scheduled target frame', async () => {
  let runtime = createRuntime({
    agents: new Map([
      [ 'agent_1', {
        id: 'agent_1',
        name: 'Worker',
        pluginID: 'continuing-agent',
        config: {},
        secrets: {},
        enabled: true,
      } ],
      [ 'agent_2', {
        id: 'agent_2',
        name: 'Observer',
        pluginID: 'null-response-agent',
        config: {},
        secrets: {},
        enabled: true,
      } ],
    ]),
  });

  await runtime.createSession({
    title: 'Scratch',
    participantAgentIDs: [ 'agent_1', 'agent_2' ],
    coordinatorAgentID: 'agent_1',
  });
  await runtime.appendUserMessage('ses_1', { text: 'start and keep working' });

  await runtime.processScheduledFrames();
  await runtime.frameRouter.flush();
  await runtime.frameStore.flush();

  let frames = await runtime.listFrames('ses_1');
  let continuationFrame = frames.find((frame) => frame.authorID === 'internal:agent-continuation');
  assert.equal(continuationFrame.type, 'UserMessage');
  assert.equal(continuationFrame.hidden, true);
  assert.equal(continuationFrame.targetAgentID, 'agent_1');
  assert.equal(continuationFrame.parentID, 'agent_frame_1');
  assert.equal(continuationFrame.scheduledStatus, 'fired');
  assert.equal(continuationFrame.scheduledAt, 1000);
  assert.equal(continuationFrame.content.continuationPrompt, 'Please run the next step now.');
  assert.match(continuationFrame.content.text, /scheduled respond-and-continue prompt has fired/);

  let calls = runtime.services.calls.filter((call) => call.method === 'continuing-run');
  assert.deepEqual(calls.map((call) => `${call.agentID}:${call.frameType}`), [
    'agent_1:UserMessage',
    'agent_1:UserMessage',
  ]);
  assert.equal(calls[1].targetAgentID, 'agent_1');

  let continuedFrame = frames.find((frame) => frame.parentID === continuationFrame.id && frame.type === 'AgentMessage');
  assert.equal(continuedFrame.authorID, 'agent_1');
  assert.equal(continuedFrame.content.text, 'Continued after timer.');
});

test('AgentRouteFramePlugin does nothing when a session has no invited agents', async () => {
  let runtime = createRuntime();

  await runtime.createSession({ title: 'Scratch' });
  await runtime.appendUserMessage('ses_1', { text: 'hello' });

  assert.deepEqual(runtime.services.calls, []);
  assert.deepEqual((await runtime.listFrames('ses_1')).map((frame) => frame.type), [ 'UserMessage' ]);
});

test('AgentRouteFramePlugin routes individual agent failures without stopping other participants', async () => {
  let runtime = createRuntime({
    agents: new Map([
      [ 'agent_failing', {
        id: 'agent_failing',
        name: 'Failing',
        pluginID: 'failing-agent',
        config: {},
        secrets: {},
        enabled: true,
      } ],
      [ 'agent_worker', {
        id: 'agent_worker',
        name: 'Worker',
        pluginID: 'streaming-agent',
        config: {},
        secrets: { apiKey: 'sk-worker' },
        enabled: true,
      } ],
    ]),
  });

  await runtime.createSession({
    title: 'Scratch',
    participantAgentIDs: [ 'agent_failing', 'agent_worker' ],
    coordinatorAgentID: 'agent_failing',
  });
  await runtime.appendUserMessage('ses_1', { text: 'hello' });

  let frames = await runtime.listFrames('ses_1');
  let firstPassAgentFrames = frames.filter((frame) => frame.parentID === 'msg_1' && frame.type === 'AgentMessage');
  assert.equal(frames[0].type, 'UserMessage');
  assert.equal(firstPassAgentFrames.length, 2);
  assert.match(firstPassAgentFrames[0].content.text, /provider exploded/);
  assert.equal(firstPassAgentFrames[0].authorID, 'agent_failing');
  assert.equal(firstPassAgentFrames[0].authorDisplayName, 'Failing');
  assert.equal(firstPassAgentFrames[0].content.status, 'error');
  assert.equal(firstPassAgentFrames[0].hidden, false);
  assert.deepEqual(firstPassAgentFrames[0].agentRoute.path, [ 'agent_failing' ]);
  assert.equal(firstPassAgentFrames[1].authorID, 'agent_worker');
  assert.equal(firstPassAgentFrames[1].authorDisplayName, 'Worker');
  assert.equal(firstPassAgentFrames[1].content.text, 'Echo: hello');
  assert.deepEqual(firstPassAgentFrames[1].agentRoute.path, [ 'agent_worker' ]);

  let secondPassAgentFrames = frames.filter((frame) => frame.type === 'AgentMessage' && frame.parentID !== 'msg_1');
  assert.deepEqual(secondPassAgentFrames.map((frame) => frame.agentRoute.path), [
    [ 'agent_failing', 'agent_worker' ],
    [ 'agent_worker', 'agent_failing' ],
    [ 'agent_worker', 'agent_failing' ],
  ]);
  assert.deepEqual(
    runtime.services.calls
      .filter((call) => call.method === 'run' && call.frameType === 'UserMessage')
      .map((call) => call.agentID),
    [ 'agent_worker' ],
  );
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
  let firstPassFrames = frames.filter((frame) => frame.parentID === 'msg_1' || frame.type === 'UserMessage');
  assert.deepEqual(firstPassFrames.map((frame) => frame.type), [ 'UserMessage', 'AgentError', 'AgentMessage' ]);
  assert.equal(firstPassFrames[1].authorID, 'agent_disabled');
  assert.equal(firstPassFrames[1].authorDisplayName, 'Disabled');
  assert.match(firstPassFrames[1].content.text, /Agent is disabled: agent_disabled/);
  assert.equal(firstPassFrames[2].authorID, 'agent_enabled');
  assert.equal(firstPassFrames[2].authorDisplayName, 'Enabled');
  assert.equal(firstPassFrames[2].content.text, 'Echo: hello');
  assert.deepEqual(firstPassFrames[2].agentRoute.path, [ 'agent_enabled' ]);

  let deliveryErrors = frames.filter((frame) => frame.parentID === firstPassFrames[2].id && frame.type === 'AgentError');
  assert.equal(deliveryErrors.length, 1);
  assert.equal(deliveryErrors[0].authorID, 'agent_disabled');
  assert.match(deliveryErrors[0].content.text, /Agent is disabled: agent_disabled/);
  assert.deepEqual(
    runtime.services.calls
      .filter((call) => call.method === 'run' && call.frameType === 'UserMessage')
      .map((call) => call.agentID),
    [ 'agent_enabled' ],
  );
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
  pluginRegistry.registerAgentProvider('service-forwarding-agent', ServiceForwardingAgentProvider);
  pluginRegistry.registerAgentProvider('null-response-agent', NullResponseAgentProvider);
  pluginRegistry.registerAgentProvider('failing-agent', FailingAgentProvider);
  pluginRegistry.registerAgentProvider('continuing-agent', ContinuingAgentProvider);

  let agents = options.agents || new Map();
  let agentManager = options.agentManager || {
    async getAgent(agentID) {
      return agents.get(agentID) || null;
    },
  };
  let commandRegistry = new CommandRegistry({ logger: quietLogger() });
  let router = new FrameRouter({ logger: quietLogger() });
  router.registerSelector('Type:UserMessage', AgentRouteFramePlugin, AgentRouteFramePlugin.pluginID);
  router.registerSelector('Type:AgentMessage', AgentRouteFramePlugin, AgentRouteFramePlugin.pluginID);

  let tokenUsage = options.tokenUsage || createTokenUsageStub();
  let services = {
    calls: [],
    tokenUsage,
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

        if (name === 'tokenUsage')
          return tokenUsage;

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
  let generatedID = 0;
  let runtime = new FrameRuntime({
    aeordb: createClient(),
    frameRouter: router,
    services,
    clock: () => 1000,
    idGenerator: () => ids.shift() || `generated_${++generatedID}`,
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
    async patchFile(path, body) {
      this.calls.push({ method: 'patchFile', path, body });
      this.files.set(path, {
        ...(this.files.get(path) || {}),
        ...body,
      });
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

function createTokenUsageStub() {
  return {
    calls: [],
    async addTokens(serviceKey, usage, options) {
      this.calls.push({ serviceKey, usage, options });
      return {
        tokensUsed: usage.tokensUsed,
        createdAt: options?.updatedAt,
        updatedAt: options?.updatedAt,
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
