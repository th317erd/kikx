'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_EFFECTIVE_CONTEXT_WINDOW_TOKENS,
  resolveEffectiveContextWindow,
  resolveSessionWindows,
  smallestParticipantWindow,
} from '../../../src/core/compaction/index.mjs';
import { AgentInterface, PluginRegistry } from '../../../src/core/plugins/index.mjs';

class WindowProvider extends AgentInterface {
  static pluginID = 'window-provider';

  static getModels() {
    return [ { id: 'model-a', contextWindow: 40000 } ];
  }

  resolveContextWindow(params = {}) {
    this.context = params;
    return 50000;
  }
}

class NoResolverProvider extends AgentInterface {
  static pluginID = 'no-resolver';

  static getModels() {
    return [ { id: 'legacy', contextWindow: 120000 } ];
  }

  contextWindowFor() {
    return null;
  }

  resolveContextWindow() {
    return null;
  }
}

test('resolveEffectiveContextWindow prefers the config override', () => {
  let window = resolveEffectiveContextWindow({
    agent: { id: 'a', pluginID: 'window-provider', config: { model: 'model-a', contextWindowTokens: 9000 } },
    providerClass: WindowProvider,
    catalog: [ { pluginID: 'window-provider', id: 'model-a', contextWindow: 40000 } ],
  });

  assert.equal(window, 9000);
});

test('resolveEffectiveContextWindow uses the provider resolver before the catalog', () => {
  let window = resolveEffectiveContextWindow({
    agent: { id: 'a', pluginID: 'window-provider', config: { model: 'model-a' } },
    providerClass: WindowProvider,
    catalog: [ { pluginID: 'window-provider', id: 'model-a', contextWindow: 40000 } ],
  });

  assert.equal(window, 50000);
});

test('resolveEffectiveContextWindow falls back to the catalog for providers without a resolver', () => {
  let window = resolveEffectiveContextWindow({
    agent: { id: 'a', pluginID: 'no-resolver', config: { model: 'legacy' } },
    providerClass: NoResolverProvider,
    catalog: [ { pluginID: 'no-resolver', id: 'legacy', contextWindow: 120000 } ],
  });

  assert.equal(window, 120000);
});

test('resolveEffectiveContextWindow returns a finite default when nothing resolves', () => {
  let window = resolveEffectiveContextWindow({
    agent: { id: 'a', pluginID: 'unknown-provider', config: {} },
    providerClass: null,
    catalog: [],
  });

  assert.equal(window, DEFAULT_EFFECTIVE_CONTEXT_WINDOW_TOKENS);
  assert.equal(Number.isFinite(window), true);
});

test('resolveEffectiveContextWindow ignores an invalid provider result and keeps falling back', () => {
  class BadWindowProvider extends AgentInterface {
    static pluginID = 'bad-window';
    resolveContextWindow() {
      return null;
    }
  }

  let window = resolveEffectiveContextWindow({
    agent: { id: 'a', pluginID: 'bad-window', config: { model: 'legacy' } },
    providerClass: BadWindowProvider,
    catalog: [ { pluginID: 'bad-window', id: 'legacy', contextWindow: 64000 } ],
  });

  assert.equal(window, 64000);
});

test('smallestParticipantWindow returns the minimum across participants', () => {
  let smallest = smallestParticipantWindow({
    agents: [
      { id: 'big', window: 200000 },
      { id: 'small', window: 32768 },
      { id: 'mid', window: 65536 },
    ],
  });

  assert.equal(smallest, 32768);
});

test('smallestParticipantWindow resolves windows for entries without a precomputed value', () => {
  let smallest = smallestParticipantWindow({
    agents: [
      { agent: { id: 'big', pluginID: 'window-provider', config: { model: 'model-a', contextWindowTokens: 100000 } } },
      { agent: { id: 'small', pluginID: 'catalog-only', config: { model: 'legacy' } } },
    ],
    catalog: [ { pluginID: 'catalog-only', id: 'legacy', contextWindow: 24000 } ],
  });

  assert.equal(smallest, 24000);
});

test('smallestParticipantWindow returns null for no participants', () => {
  assert.equal(smallestParticipantWindow({ agents: [] }), null);
  assert.equal(smallestParticipantWindow({}), null);
});

test('resolveSessionWindows loads participants and reports per-agent meta and the smallest window', async () => {
  let pluginRegistry = new PluginRegistry();
  pluginRegistry.registerAgentProvider('window-provider', WindowProvider);
  pluginRegistry.registerAgentProvider('no-resolver', NoResolverProvider);
  let agents = new Map([
    [ 'big', { id: 'big', pluginID: 'window-provider', config: { model: 'model-a' }, enabled: true } ],
    [ 'small', { id: 'small', pluginID: 'no-resolver', config: { model: 'legacy' }, enabled: true } ],
    [ 'gone', null ],
  ]);
  let agentManager = {
    async getAgent(agentID) {
      return agents.get(agentID) || null;
    },
    listModels() {
      return [
        { pluginID: 'window-provider', id: 'model-a', contextWindow: 40000 },
        { pluginID: 'no-resolver', id: 'legacy', contextWindow: 24000 },
      ];
    },
  };
  let result = await resolveSessionWindows({
    session: { id: 'ses_1', participantAgentIDs: [ 'big', 'small', 'gone' ] },
    agentManager,
    pluginRegistry,
    catalog: agentManager.listModels(),
  });

  assert.deepEqual(result.participants.map((participant) => participant.agent.id), [ 'big', 'small' ]);
  assert.deepEqual(result.participants.map((participant) => participant.window), [ 50000, 24000 ]);
  assert.equal(result.smallestWindow, 24000);
});
