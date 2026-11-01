'use strict';

// Wiring proof for user-message delivery.
//
// `spec/core/runtime/user-message-delivery-spec.mjs` proves `markFrameDelivered`
// is correct in isolation. This file proves the half that actually matters: that
// the production path - append a user message, let the real router dispatch it,
// let the plugin hand it to a provider - flips the stored delivery state, and
// that a turn which never reaches the provider does not claim delivery.
//
// Without this file, a correct method nobody calls would pass every other test
// in this feature. It goes through FrameRouter on purpose: hand-building the
// plugin context (as a stub would) proves nothing about the wiring.

import assert from 'node:assert/strict';
import test from 'node:test';

import { AgentRouteFramePlugin } from '../../../src/core/agents/agent-route-frame-plugin.mjs';
import { CommandRegistry } from '../../../src/core/commands/index.mjs';
import { AgentInterface, PluginRegistry } from '../../../src/core/plugins/index.mjs';
import { FrameRouter } from '../../../src/core/routing/index.mjs';
import { FrameRuntime } from '../../../src/core/runtime/frame-runtime.mjs';

class RecordingDeliveryProvider extends AgentInterface {
  static pluginID = 'recording-delivery-agent';

  async *run(params = {}) {
    params.services.providerRuns.push(params.frame.id);
    yield { type: 'AgentMessage', content: { text: 'ack' } };
    yield { type: 'Done', content: { usage: { inputTokens: 1, outputTokens: 1 } } };
  }
}

function quietLogger() {
  return { info() {}, warn() {}, error() {}, debug() {} };
}

function createClient() {
  return {
    calls: [],
    files: new Map(),
    async putFile(path, body) { this.files.set(path, body); return { path }; },
    async patchFile(path, body) { this.files.set(path, { ...(this.files.get(path) || {}), ...body }); return { path }; },
    async getFile(path) { return this.files.get(path) || null; },
    async listDirectory(path) {
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
      return { tokensUsed: usage.tokensUsed, createdAt: options?.updatedAt, updatedAt: options?.updatedAt };
    },
  };
}

function createRuntime() {
  let pluginRegistry = new PluginRegistry({ logger: quietLogger() });
  pluginRegistry.registerAgentProvider('recording-delivery-agent', RecordingDeliveryProvider);

  let agents = new Map([
    [ 'agent_1', {
      id: 'agent_1',
      name: 'Delivery Agent',
      pluginID: 'recording-delivery-agent',
      config: { model: 'test-model' },
      secrets: { apiKey: 'sk-test' },
      enabled: true,
    } ],
  ]);
  let agentManager = {
    async getAgent(agentID) { return agents.get(agentID) || null; },
    async listAgents() { return [ ...agents.values() ]; },
  };

  let commandRegistry = new CommandRegistry({ logger: quietLogger() });
  let router = new FrameRouter({ logger: quietLogger() });
  router.registerSelector('Type:UserMessage', AgentRouteFramePlugin, AgentRouteFramePlugin.pluginID);

  let tokenUsage = createTokenUsageStub();
  let services = {
    calls: [],
    providerRuns: [],
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

  let generatedID = 0;
  let runtime = new FrameRuntime({
    aeordb: createClient(),
    frameRouter: router,
    services,
    clock: () => 1000,
    idGenerator: () => `generated_${++generatedID}`,
    logger: quietLogger(),
  });
  runtime.services = services;
  return runtime;
}

test('the production path marks the message received once the provider is fed', async () => {
  let runtime = createRuntime();
  // The harness mints its own session id; never assume one.
  let session = await runtime.createSession({ title: 'Delivery', participantAgentIDs: [ 'agent_1' ] });

  let { frame } = await runtime.appendUserMessage(session.id, {
    text: 'Please implement delivery status',
    userID: 'usr_1',
  });

  // The provider genuinely ran, so "received" is a true statement here.
  assert.deepEqual(runtime.services.providerRuns, [ frame.id ]);

  let stored = runtime.requireSessionEntry(session.id).frameEngine.get(frame.id);
  assert.equal(stored.content.delivery, 'received');
  assert.ok(Number.isFinite(stored.content.deliveryAt));
  // Display-only: the text the model reads is untouched.
  assert.equal(stored.content.text, 'Please implement delivery status');
});

test('a cancelled turn does not claim delivery', async () => {
  let runtime = createRuntime();
  let session = await runtime.createSession({ title: 'Delivery', participantAgentIDs: [ 'agent_1' ] });

  // agent-route-frame-plugin.mjs:322 returns before any provider call.
  runtime.hasAgentCancellation = () => true;

  let { frame } = await runtime.appendUserMessage(session.id, {
    text: 'You should never be fed this',
    userID: 'usr_1',
  });

  assert.deepEqual(runtime.services.providerRuns, []);
  let stored = runtime.requireSessionEntry(session.id).frameEngine.get(frame.id);
  assert.equal(stored.content.delivery, 'neutral');
});

test('a steered turn does not claim delivery', async () => {
  let runtime = createRuntime();
  let session = await runtime.createSession({ title: 'Delivery', participantAgentIDs: [ 'agent_1' ] });

  // agent-route-frame-plugin.mjs:328 returns before any provider call.
  runtime.hasAgentSteering = () => true;

  let { frame } = await runtime.appendUserMessage(session.id, {
    text: 'Steering input, not a fed message',
    userID: 'usr_1',
  });

  assert.deepEqual(runtime.services.providerRuns, []);
  let stored = runtime.requireSessionEntry(session.id).frameEngine.get(frame.id);
  assert.equal(stored.content.delivery, 'neutral');
});
