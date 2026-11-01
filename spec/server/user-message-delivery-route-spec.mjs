'use strict';

// Route-seam proof for user-message delivery.
//
// WHY THIS EXISTS ALONGSIDE THE TWO WIRING/HARNESS SPECS
// `spec/core/agents/user-message-delivery-wiring-spec.mjs` proves
// appendUserMessage -> router -> plugin -> provider by calling the runtime
// directly. It never crosses HTTP. `spec/server/create-server-spec.mjs` does
// cross HTTP, but only against a stub runtime whose appendUserMessage is a
// canned object - so it proves the route *delegates*, not that a real
// FrameRuntime stamps `neutral` on what the route stored.
//
// That gap is real and this file closes it: a real POST through the real route
// against the real FrameRuntime and the real FrameStore, asserted from the
// runtime's own engine rather than from the response body alone.
//
// WHAT IS PINNED
//   1. the neutral default is written by the runtime, not by the client: the
//      stored frame carries content.delivery === 'neutral'.
//   2. `deliveryAt` is ABSENT (not null, not 0) while neutral. A timestamp on an
//      undelivered message would claim delivery happened at time zero.
//   3. neutral genuinely means "not fed yet": while the agent's lookup is
//      parked, the provider has not run, and the stored state is still neutral.
//      Without this half, "neutral" could be a constant that never flips.
//   4. the same frame becomes `received` with a real `deliveryAt` once the
//      provider is fed, through the production hook - no test calls
//      markFrameDelivered.
//   5. a message nobody is fed stays neutral forever: a session with no
//      participant agent produces no provider run and no delivery claim.
//
// DETERMINISM, NOT SLEEPING
// The route appends with `flushRouter: false` (session-routes.mjs:456), so agent
// routing continues in the background after the 201. A bare immediate read of
// the frame would therefore race the provider. The harness parks the FIRST
// await inside routeAgent (`agentManager.getAgent`, :243) behind a gate, which
// makes "before the provider is fed" an observable state instead of a guess:
// release the gate, await router.flush(), and the transition is causally
// ordered. No timers, no retry loops, no assertions on wall-clock timing.

import assert from 'node:assert/strict';
import test from 'node:test';

import { AppContext } from '../../src/core/app/app-context.mjs';
import { AgentInterface, PluginRegistry } from '../../src/core/plugins/index.mjs';
import { CommandRegistry } from '../../src/core/commands/index.mjs';
import { FrameRouter } from '../../src/core/routing/index.mjs';
import { FrameStore } from '../../src/core/aeordb/frame-store.mjs';
import { FrameRuntime } from '../../src/core/runtime/frame-runtime.mjs';
import { createServer } from '../../src/server/create-server.mjs';

// Isolate from ambient plugin discovery, exactly as create-server-spec.mjs does:
// a KIKX_PLUGIN_PATHS in the environment would otherwise load real selectors
// into this fixture and make the routing assertions environment-dependent.
delete process.env.KIKX_PLUGIN_PATHS;

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

// In-memory stand-in for AeorDB's file API. Only the database is substituted;
// FrameStore, the serializers and the runtime are the shipped code.
function createAeorDB() {
  let files = new Map();
  return {
    files,
    async putFile(path, body) { files.set(path, body); return { path }; },
    async patchFile(path, body) { files.set(path, body); return { path }; },
    async getFile(path) { return files.has(path) ? files.get(path) : null; },
    async deleteFile(path) { files.delete(path); return { path }; },
    async fetchFiles(paths) {
      let output = {};
      for (let path of paths) {
        if (!files.has(path)) {
          let error = new Error(`missing: ${path}`);
          error.status = 404;
          throw error;
        }

        output[path] = { path, content: JSON.stringify(files.get(path)) };
      }

      return output;
    },
    async listDirectory(path, options = {}) {
      let prefix = `${String(path).replace(/\/+$/g, '')}/`;
      let glob = typeof options.glob === 'string' ? options.glob : '';

      let names = [ ...files.keys() ].filter((filePath) => {
        if (!filePath.startsWith(prefix))
          return false;

        let rest = filePath.slice(prefix.length);
        if (glob === '**/frames/*.json')
          return rest.includes('/frames/') && rest.endsWith('.json');
        if (glob === '**/session.json')
          return /^[^/]+\/session\.json$/.test(rest);
        return rest.endsWith('.json');
      });

      // AeorDB sorts by basename; frame filenames are zero-padded order
      // prefixes, so that is also chronological.
      names.sort((left, right) => left.split('/').pop().localeCompare(right.split('/').pop()));

      let offset = Number(options.offset) || 0;
      let limit = Number.isFinite(Number(options.limit)) ? Number(options.limit) : names.length;
      return {
        items: names.slice(offset, offset + limit).map((filePath) => ({ path: filePath })),
        limit,
        offset,
        total: names.length,
      };
    },
  };
}

// A one-way gate with an explicit release. The provider/agent lookup awaits
// `opened`, so "the agent has not been handed the message" is a state this spec
// can hold open and then end - not a timing window it hopes to sample.
function createGate() {
  let release;
  let opened = new Promise((resolve) => { release = resolve; });
  return {
    opened,
    release() { release(); },
  };
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      let address = server.address();
      resolve(`http://${address.address}:${address.port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }

    server.close((error) => error ? reject(error) : resolve());
  });
}

function postMessage(baseURL, sessionID, body) {
  return fetch(`${baseURL}/api/v1/sessions/${encodeURIComponent(sessionID)}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// Builds the production stack. `agents` is deliberately a parameter so a test
// can mount a session with no routable agent and prove the neutral path is not
// a constant that flips on its own.
async function startStack({ withAgent = true, gate = null } = {}) {
  let aeordb = createAeorDB();
  let store = new FrameStore({ aeordb, rootPath: '/kikx' });

  let pluginRegistry = new PluginRegistry({ logger: quietLogger() });
  pluginRegistry.registerAgentProvider('recording-delivery-agent', RecordingDeliveryProvider);

  let agents = withAgent
    ? new Map([ [ 'agent_1', {
      id: 'agent_1',
      name: 'Delivery Agent',
      pluginID: 'recording-delivery-agent',
      config: { model: 'test-model' },
      secrets: { apiKey: 'sk-test' },
      enabled: true,
    } ] ])
    : new Map();

  let agentManager = {
    async getAgent(agentID, options) {
      if (options?.includeSecrets && gate)
        await gate.opened;
      return agents.get(agentID) || null;
    },
    async listAgents() { return [ ...agents.values() ]; },
  };

  let commandRegistry = new CommandRegistry({ logger: quietLogger() });
  let router = new FrameRouter({ logger: quietLogger() });
  let { AgentRouteFramePlugin } = await import('../../src/core/agents/agent-route-frame-plugin.mjs');
  router.registerSelector('Type:UserMessage', AgentRouteFramePlugin, AgentRouteFramePlugin.pluginID);

  let tokenUsage = {
    async addTokens(serviceKey, usage, options) {
      return { tokensUsed: usage.tokensUsed, createdAt: options?.updatedAt, updatedAt: options?.updatedAt };
    },
  };

  let services = {
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
    frameStore: store,
    frameRouter: router,
    services,
    clock: () => 1000,
    idGenerator: () => `generated_${++generatedID}`,
    logger: quietLogger(),
  });
  runtime.services = services;

  let server = await createServer({
    context: new AppContext({
      aeordb,
      db: aeordb,
      frameStore: store,
      frameRuntime: runtime,
    }),
  });

  return { server, baseURL: await listen(server), runtime, services, store };
}

function storedFrame(runtime, sessionID, frameID) {
  return runtime.requireSessionEntry(sessionID).frameEngine.get(frameID);
}

test('POST messages stores delivery:neutral with no deliveryAt, then flips to received once the provider is fed', async () => {
  let gate = createGate();
  let { server, baseURL, runtime, services } = await startStack({ gate });

  try {
    // A real session through the real runtime, so the route writes into the
    // same engine this spec later reads.
    let session = await runtime.createSession({
      title: 'Delivery route',
      participantAgentIDs: [ 'agent_1' ],
    });

    let response = await postMessage(baseURL, session.id, {
      text: 'Please implement delivery status',
      userID: 'usr_1',
    });

    assert.equal(response.status, 201);
    let body = await response.json();
    let responseFrame = body?.data?.frame;
    assert.ok(responseFrame?.id, 'the route must return the committed frame');

    // ---- the neutral half, asserted on the stored frame -------------------
    // Read from the runtime's engine on purpose: the response body is what the
    // route returned, and a bug that returned a stamped-up copy while storing
    // something else would pass a response-only assertion.
    let stored = storedFrame(runtime, session.id, responseFrame.id);
    assert.ok(stored, 'the message must be stored in the session engine');
    assert.equal(stored.type, 'UserMessage');
    assert.equal(stored.content.delivery, 'neutral');

    // Absent, not null and not 0: an undelivered message must carry no delivery
    // timestamp at all. `?? null` comparisons would not catch that distinction.
    assert.equal(
      Object.hasOwn(stored.content, 'deliveryAt'),
      false,
      'a neutral message must not carry a deliveryAt key at all',
    );
    assert.equal(Object.hasOwn(responseFrame.content, 'deliveryAt'), false);

    // Neutral is a live state, not a constant: the agent lookup is still parked,
    // so the provider has provably not been fed this message yet.
    assert.deepEqual(services.providerRuns, [], 'the provider must not have run while the lookup is parked');

    // ---- the received half ------------------------------------------------
    gate.release();
    await runtime.frameRouter.flush();

    assert.deepEqual(
      services.providerRuns,
      [ responseFrame.id ],
      'the provider must be fed exactly this frame once the turn proceeds',
    );

    let delivered = storedFrame(runtime, session.id, responseFrame.id);
    assert.equal(delivered.content.delivery, 'received');
    assert.ok(Number.isFinite(delivered.content.deliveryAt), 'a received message must record when it was received');

    // Display-only: the text the model reads is byte-identical to what was sent.
    assert.equal(delivered.content.text, 'Please implement delivery status');
  } finally {
    await close(server);
  }
});

test('a message in a session with no routable agent stays neutral and claims no delivery time', async () => {
  // No gate here: with no participant agent there is nothing to park, and the
  // point is that the turn completes without any provider being fed.
  let { server, baseURL, runtime, services } = await startStack({ withAgent: false });

  try {
    let session = await runtime.createSession({ title: 'No agents' });

    let response = await postMessage(baseURL, session.id, { text: 'anyone there?', userID: 'usr_1' });
    assert.equal(response.status, 201);
    let body = await response.json();
    let frameID = body.data.frame.id;

    // Let routing finish rather than assuming it already has. If delivery were
    // stamped at route entry, this flush is exactly where it would show up.
    await runtime.frameRouter.flush();

    assert.deepEqual(services.providerRuns, [], 'no provider can be fed without a routable agent');

    let stored = storedFrame(runtime, session.id, frameID);
    assert.equal(stored.content.delivery, 'neutral');
    assert.equal(
      Object.hasOwn(stored.content, 'deliveryAt'),
      false,
      'a message that was never fed must not claim a delivery time',
    );
  } finally {
    await close(server);
  }
});
