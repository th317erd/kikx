'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { AgentInterface, PluginRegistry } from '../../../src/core/plugins/index.mjs';
import { CommandRegistry } from '../../../src/core/commands/index.mjs';
import { FrameRouter } from '../../../src/core/routing/index.mjs';
import { FrameRuntime } from '../../../src/core/runtime/frame-runtime.mjs';
import { AgentRouteFramePlugin } from '../../../src/core/agents/agent-route-frame-plugin.mjs';
import { haltSessionTree } from '../../../src/core/agents/coordinator-tree-halt.mjs';

// A provider that behaves like a non-streaming vendor adapter: it produces
// NOTHING until its upstream call returns, then yields its whole answer at once.
// `plugins/ocr/index.mjs:64` declares exactly this shape (`streaming:false`), and
// `provider-retry.mjs:62-85` is a bare `for await` passthrough with no cancellation
// awareness, so the only thing that can stop a late result from landing is the
// per-yield gate in the agent loop (agent-route-frame-plugin.mjs:341).
class LateYieldAgentProvider extends AgentInterface {
  static pluginID = 'late-yield-agent';

  async *run(params = {}) {
    params.services.calls.push({
      method: 'late-yield-start',
      agentID: params.agent.id,
    });

    // Signal that the upstream call is genuinely in flight, then block until the
    // test releases it -- this is the window in which a halt must arrive.
    params.services.started?.(params.agent.id);
    await params.services.hold;

    // The halt has already happened by now. These yields arrive LATE.
    yield {
      type: 'AgentMessage',
      content: { text: 'LATE RESULT THAT MUST NOT LAND' },
    };
    yield {
      type: 'Done',
      content: { status: 'finalized' },
    };
  }
}

function deferred() {
  let resolve;
  let promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCondition(predicate, timeoutMS = 500) {
  let deadline = Date.now() + timeoutMS;
  while (Date.now() < deadline) {
    if (predicate())
      return;
    await sleep(1);
  }
  assert.fail('Timed out waiting for condition');
}

function quietLogger() {
  return { error() {}, warn() {}, log() {} };
}

function createRuntime({ services = {} } = {}) {
  let pluginRegistry = new PluginRegistry({ logger: quietLogger() });
  pluginRegistry.registerAgentProvider('late-yield-agent', LateYieldAgentProvider);

  let agents = new Map([
    [ 'agent_z', {
      id: 'agent_z',
      name: 'Zed',
      pluginID: 'late-yield-agent',
      config: {},
      secrets: {},
      enabled: true,
    } ],
    [ 'agent_w', {
      id: 'agent_w',
      name: 'Wren',
      pluginID: 'late-yield-agent',
      config: {},
      secrets: {},
      enabled: true,
    } ],
  ]);

  let commandRegistry = new CommandRegistry({ logger: quietLogger() });
  let router = new FrameRouter({ logger: quietLogger() });
  router.registerSelector('Type:UserMessage', AgentRouteFramePlugin, AgentRouteFramePlugin.pluginID);
  router.registerSelector('Type:AgentMessage', AgentRouteFramePlugin, AgentRouteFramePlugin.pluginID);

  let sharedServices = {
    calls: [],
    pluginRegistry,
    agentManager: {
      async getAgent(agentID) {
        return agents.get(agentID) || null;
      },
    },
    commandRegistry,
    context: {
      require(name) {
        if (name === 'pluginRegistry')
          return pluginRegistry;
        if (name === 'agentManager')
          return sharedServices.agentManager;
        if (name === 'commandRegistry')
          return commandRegistry;
        throw new Error(`Unknown service: ${name}`);
      },
    },
    ...services,
  };

  let ids = [ 'ses_p', 'ses_c', 'ses_g', 'int_1', 'msg_1', 'agent_frame_1', 'commit_1' ];
  let generatedID = 0;
  let runtime = new FrameRuntime({
    aeordb: createClient(),
    frameRouter: router,
    services: sharedServices,
    clock: () => 1000,
    idGenerator: () => ids.shift() || `generated_${++generatedID}`,
  });
  runtime.services = sharedServices;
  return runtime;
}

function createClient() {
  return {
    calls: [],
    files: new Map(),
    async putFile(path, body) {
      this.files.set(path, body);
      return { path };
    },
    async patchFile(path, body) {
      this.files.set(path, { ...(this.files.get(path) || {}), ...body });
      return { path };
    },
    async getFile(path) {
      return this.files.get(path) || null;
    },
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

// P (grandparent) has coordinator Z. C (child) has its own coordinator W. G
// (grandchild) exists to prove the tree shape is three levels deep.
async function buildTree(runtime) {
  await runtime.createSession({
    title: 'P',
    participantAgentIDs: [ 'agent_z' ],
    coordinatorAgentID: 'agent_z',
  });
  await runtime.createSession({
    title: 'C',
    parentSessionID: 'ses_p',
    participantAgentIDs: [ 'agent_w' ],
    coordinatorAgentID: 'agent_w',
  });
  await runtime.createSession({
    title: 'G',
    parentSessionID: 'ses_c',
    participantAgentIDs: [ 'agent_x', 'agent_y' ],
  });
}

function haltServices(runtime) {
  return {
    frameRuntime: runtime,
    agentManager: runtime.services.agentManager,
    processManager: { async suspendSession() { return []; } },
    listSessions: () => runtime.listSessions(),
  };
}

function visibleTexts(runtime, sessionID) {
  return runtime.requireSessionEntry(sessionID).frameEngine.toArray()
    .filter((frame) => frame.type === 'AgentMessage'
      && frame.hidden !== true
      && frame.deleted !== true
      && frame.content?.status !== 'streaming')
    .map((frame) => frame.content?.text)
    .filter((text) => typeof text === 'string' && text !== '');
}

test('a coordinator halting a descendant drops a provider result that arrives after the halt', async () => {
  let hold = deferred();
  let started = deferred();
  let runtime = createRuntime({
    services: {
      hold: hold.promise,
      started: () => started.resolve(),
    },
  });
  await buildTree(runtime);

  // A long provider call begins in the CHILD session.
  let runPromise = runtime.appendUserMessage('ses_c', { text: 'do expensive work', userID: 'usr_1' });
  await started.promise;

  assert.equal(runtime.hasAgentCancellation('ses_c', 'agent_w'), false, 'nothing is cancelled yet');

  // The grandparent's coordinator halts the descendant while the provider call is
  // still on the wire.
  let result = await haltSessionTree({
    actorAgentID: 'agent_z',
    targetSessionID: 'ses_c',
    currentSessionID: 'ses_p',
    includeSubtree: true,
    services: haltServices(runtime),
  });

  assert.equal(result.allowed, true, "Z coordinates P, so P's descendant C is inside Z's authority");
  assert.ok(result.sessionIDs.includes('ses_c'), 'the child session is named as reached');
  assert.equal(runtime.hasAgentCancellation('ses_c', 'agent_w'), true, 'the cancellation flag is set on the in-flight agent');
  assert.equal(runtime.isAgentSuspended('ses_c', 'agent_w'), true, 'a new tool call in that session is gated too, not just the running one');

  // Now let the slow provider return. Its result arrives AFTER the halt.
  hold.resolve();
  let run = await runPromise;
  await runtime.flush();
  await runtime.frameStore.flush();

  // The placeholder the plugin pre-created must have been cleaned up with the
  // 'cancelled' status (agent-route-frame-plugin-base.mjs:304-321), and the late
  // provider output must never have been merged into a visible message.
  let raw = runtime.requireSessionEntry('ses_c').frameEngine.toArray();
  let placeholder = raw.find((frame) => frame.type === 'AgentMessage' && frame.authorID === 'agent_w');
  assert.equal(placeholder?.content?.status, 'cancelled', 'the response placeholder is finalised as cancelled');
  assert.equal(placeholder?.deleted, true, 'the cancelled placeholder is not shown');
  assert.deepEqual(
    visibleTexts(runtime, 'ses_c'),
    [],
    'the late provider result never became a visible message in the halted session',
  );
  assert.equal(
    raw.some((frame) => frame.content?.text === 'LATE RESULT THAT MUST NOT LAND'),
    false,
    'the late text never entered the frame log at all',
  );
});

test('a coordinator refusing to halt an ancestor leaves the ancestor run untouched', async () => {
  let hold = deferred();
  let started = deferred();
  let runtime = createRuntime({
    services: {
      hold: hold.promise,
      started: () => started.resolve(),
    },
  });
  await buildTree(runtime);

  // A run begins in the PARENT session, owned by Z.
  let runPromise = runtime.appendUserMessage('ses_p', { text: 'parent work', userID: 'usr_1' });
  await started.promise;

  // W coordinates C, which is a CHILD of P. Authority flows down, never up, so this
  // must be refused -- and it must be refused before anything is frozen.
  let result = await haltSessionTree({
    actorAgentID: 'agent_w',
    targetSessionID: 'ses_p',
    currentSessionID: 'ses_c',
    includeSubtree: true,
    services: haltServices(runtime),
  });

  assert.equal(result.allowed, false, 'an ancestor is out of scope for a child coordinator');
  assert.equal(result.reason, 'not-coordinator');
  assert.match(result.message, /agent_w/, 'the refusal names the actor');
  assert.deepEqual(result.sessionIDs, [], 'nothing is in scope');
  assert.equal(runtime.hasAgentCancellation('ses_p', 'agent_z'), false, 'the ancestor run is not cancelled');

  // The parent's run survives the refused halt and completes normally.
  hold.resolve();
  let run = await runPromise;
  await runtime.flush();
  await runtime.frameStore.flush();

  assert.ok(run, 'the refused halt let the ancestor turn finish');
  assert.deepEqual(
    visibleTexts(runtime, 'ses_p'),
    [ 'LATE RESULT THAT MUST NOT LAND' ],
    'the parent turn delivered its answer because the halt was refused',
  );
});
