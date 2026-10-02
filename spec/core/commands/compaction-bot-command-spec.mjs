'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { CommandRegistry, registerInternalCommands } from '../../../src/core/commands/index.mjs';
import { PluginRegistry } from '../../../src/core/plugins/index.mjs';
import { FrameRouter } from '../../../src/core/routing/index.mjs';
import { FrameRuntime } from '../../../src/core/runtime/frame-runtime.mjs';
import { COMPACTOR_REASON, selectCompactor } from '../../../src/core/compaction/index.mjs';

// End-to-end proof for ruling R8: a routed `/set-compaction-bot` writes
// `session.compactionAgentID` durably, and `selectCompactor` rung 1 then picks
// that session-assigned bot ahead of any window-based fallback.

test('/set-compaction-bot persists the session compaction bot and drives selectCompactor rung 1', async () => {
  let aeordb = createMemoryClient();
  let pluginRegistry = new PluginRegistry({ logger: quietLogger() });
  let commandRegistry = new CommandRegistry({ logger: quietLogger() });
  let router = new FrameRouter({ logger: quietLogger() });
  let runtime;
  let agentManager = {
    async resolveAgent(reference) {
      assert.equal(reference, 'Agent1');
      return { id: 'agent_1', name: 'Agent One' };
    },
  };
  let context = {
    require(name) {
      if (name === 'agentManager')
        return agentManager;

      if (name === 'frameRuntime')
        return runtime;

      if (name === 'commandRegistry')
        return commandRegistry;

      throw new Error(`Unknown service: ${name}`);
    },
  };

  registerInternalCommands({ pluginRegistry, commandRegistry });
  router.loadFromRegistry(pluginRegistry);
  runtime = new FrameRuntime({
    aeordb,
    frameRouter: router,
    services: { context },
    clock: () => 1000,
    idGenerator: createIDGenerator([
      'ses_1', 'int_1', 'msg_1', 'commit_1', 'cmd_1', 'commit_2',
    ]),
  });

  await runtime.createSession({
    title: 'Scratch',
    participantAgentIDs: [ 'agent_1', 'agent_2' ],
  });
  await runtime.appendUserMessage('ses_1', { text: '/set-compaction-bot Agent1', userID: 'usr_1' });
  await runtime.frameRouter.flush();
  await runtime.frameStore.flush();

  let saved = await aeordb.getFile('/kikx/sessions/ses_1/session.json');
  assert.equal(saved.compactionAgentID, 'agent_1');
  assert.equal(runtime.getSession('ses_1').compactionAgentID, 'agent_1');

  let decision = selectCompactor({
    session: saved,
    participantAgentsWithMeta: [
      { id: 'agent_1', window: 32768 },
      { id: 'agent_2', window: 400000 },
    ],
  });

  assert.deepEqual(decision, { agentID: 'agent_1', reason: COMPACTOR_REASON.SESSION });
});

test('/clear-compaction-bot removes the assignment so selection falls through rung 1', async () => {
  let aeordb = createMemoryClient();
  let pluginRegistry = new PluginRegistry({ logger: quietLogger() });
  let commandRegistry = new CommandRegistry({ logger: quietLogger() });
  let router = new FrameRouter({ logger: quietLogger() });
  let runtime;
  let agentManager = {
    async resolveAgent(reference) {
      return { id: reference === 'Agent1' ? 'agent_1' : 'agent_2', name: reference };
    },
  };
  let context = {
    require(name) {
      if (name === 'agentManager')
        return agentManager;

      if (name === 'frameRuntime')
        return runtime;

      if (name === 'commandRegistry')
        return commandRegistry;

      throw new Error(`Unknown service: ${name}`);
    },
  };

  registerInternalCommands({ pluginRegistry, commandRegistry });
  router.loadFromRegistry(pluginRegistry);
  runtime = new FrameRuntime({
    aeordb,
    frameRouter: router,
    services: { context },
    clock: () => 1000,
    idGenerator: createIDGenerator([
      'ses_1', 'int_1', 'msg_1', 'commit_1', 'cmd_1', 'commit_2',
    ]),
  });

  await runtime.createSession({
    title: 'Scratch',
    participantAgentIDs: [ 'agent_1', 'agent_2' ],
  });
  await runtime.updateSession('ses_1', { compactionAgentID: 'agent_1' });
  await runtime.appendUserMessage('ses_1', { text: '/clear-compaction-bot', userID: 'usr_1' });
  await runtime.frameRouter.flush();
  await runtime.frameStore.flush();

  let saved = await aeordb.getFile('/kikx/sessions/ses_1/session.json');
  assert.equal(saved.compactionAgentID, null);

  // Rung 1 is empty now; the auto-assigned first-participant coordinator wins
  // rung 3, proving the cleared field no longer drives selection.
  let decision = selectCompactor({
    session: saved,
    participantAgentsWithMeta: [
      { id: 'agent_1', window: 32768 },
      { id: 'agent_2', window: 400000 },
    ],
  });

  assert.notEqual(decision.reason, COMPACTOR_REASON.SESSION);
  assert.deepEqual(decision, { agentID: 'agent_1', reason: COMPACTOR_REASON.COORDINATOR });
});

function createMemoryClient() {
  return {
    files: new Map(),
    async putFile(path, body) {
      this.files.set(path, JSON.parse(JSON.stringify(body)));
      return { path };
    },
    async getFile(path) {
      return this.files.get(path) || null;
    },
    async listDirectory() {
      return { items: [] };
    },
  };
}

function createIDGenerator(ids) {
  let values = ids.slice();
  let index = 0;
  return () => values.shift() || `generated_${++index}`;
}

function quietLogger() {
  return {
    error() {},
    warn() {},
    log() {},
  };
}
