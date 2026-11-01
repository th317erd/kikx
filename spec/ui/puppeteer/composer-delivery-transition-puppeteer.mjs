'use strict';

// Plan V7: a message typed into the real composer goes NEUTRAL, then RECEIVED
// once the agent is actually fed it — asserted on the rendered DOM in Chromium.
//
// WHY THIS FILE COULD NOT EXIST BEFORE, AND WHY IT CAN NOW
// The previous three specs each stop short of this:
//   * `spec/server/user-message-delivery-route-spec.mjs` crosses the real HTTP
//     route against the real FrameRuntime, but its world ends at the runtime -
//     no browser ever renders the result.
//   * `spec/ui/puppeteer/user-message-delivery-puppeteer.mjs` renders both
//     states in a real browser, but seeds frames directly and emits
//     `frame.updated` by hand - nothing is typed and no provider is fed.
//   * `spec/ui/puppeteer/composer-delivery-neutral-puppeteer.mjs` types into the
//     real composer but can only assert the neutral half, because the default
//     stagehand fixture pre-resolves the plugin load
//     (`stagehand-test-utils.mjs:208` `pluginLoadPromise: Promise.resolve()`)
//     and its stub `appendUserMessage` (`:444`) writes no `delivery` key.
//
// That last limit was recorded in the evidence doc as "not provable on this
// harness". It is not a property of the harness - it is a property of the
// DEFAULT harness. `startStagehandUIServer` accepts a caller-supplied
// `frameRuntime` (`:189`) and `createServer` only constructs its own runtime
// when the context has none (`create-server.mjs:485`). So this spec hands the
// fixture the production stack - real FrameStore over an in-memory AeorDB, real
// FrameRuntime, real FrameRouter, real AgentRouteFramePlugin - and keeps only
// the provider double. The transition is then produced by production code
// (`agent-route-frame-plugin.mjs:341` -> `frame-runtime-prompts.mjs:85`), not
// re-implemented in a stub.
//
// DETERMINISM, NOT SLEEPING
// The runtime appends with `flushRouter: false`, so routing continues after the
// 201 and "neutral" could otherwise be a race the browser happens to win. The
// agent lookup the plugin performs immediately before feeding the provider is
// parked behind an explicit gate, so "the provider has not been fed" is a held
// state this spec releases on purpose. No polling for a transient, no timers
// standing in for ordering.
//
// WHAT IS PINNED
//   1. the typed bubble renders neutral, with no accent, caption or label,
//      while `providerRuns` is still empty - neutral means "not fed yet", not
//      "unstyled".
//   2. the same DOM node becomes received after the gate opens.
//   3. the accent equals the delivery token (not merely "some 3px inset"), and
//      only once the 180ms shell transition has settled.
//   4. the stored frame carries `received` + a finite `deliveryAt`, so the
//      picture the browser shows is the state the server actually holds.

import assert from 'node:assert/strict';
import test from 'node:test';

import puppeteer from 'puppeteer-core';

import { findChromeExecutable, startStagehandUIServer } from '../stagehand/stagehand-test-utils.mjs';
import { FrameStore } from '../../../src/core/aeordb/frame-store.mjs';
import { FrameRuntime } from '../../../src/core/runtime/frame-runtime.mjs';
import { FrameRouter } from '../../../src/core/routing/index.mjs';
import { AgentInterface, PluginRegistry } from '../../../src/core/plugins/index.mjs';
import { CommandRegistry } from '../../../src/core/commands/index.mjs';
import { AgentRouteFramePlugin } from '../../../src/core/agents/agent-route-frame-plugin.mjs';

// Ambient plugin discovery would load real selectors into this fixture and make
// the routing assertions environment-dependent. Same isolation the route spec
// uses, and the reason this file can register its selector explicitly below.
delete process.env.KIKX_PLUGIN_PATHS;

const TYPED_TEXT = 'typed message that goes from neutral to received';
const RECEIVED_LABEL = 'Received by the agent';

function quietLogger() {
  return { info() {}, warn() {}, error() {}, debug() {} };
}

// Only the database is substituted. FrameStore, the serialisers, the runtime,
// the router and the plugin are the shipped code - which is the whole point.
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

// A provider double only: it records that it was fed and yields a plain reply.
// It stands in for a model, not for the delivery logic.
class RecordingProvider extends AgentInterface {
  static pluginID = 'recording-v7-agent';

  async *run(params = {}) {
    params.services?.providerRuns?.push(params.frame.id);
    yield { type: 'AgentMessage', content: { text: 'acknowledged' } };
    yield { type: 'Done', content: { usage: { inputTokens: 1, outputTokens: 1 } } };
  }
}

// One-way gate with an explicit release. The plugin awaits this during the agent
// lookup that precedes the provider call, so the spec controls WHEN the message
// is fed instead of hoping to sample the instant before it.
function createGate() {
  let release;
  let opened = new Promise((resolve) => { release = resolve; });
  return { opened, release() { release(); } };
}

async function startProductionStack() {
  let gate = createGate();
  let aeordb = createAeorDB();
  let store = new FrameStore({ aeordb, rootPath: '/kikx' });

  let pluginRegistry = new PluginRegistry({ logger: quietLogger() });
  pluginRegistry.registerAgentProvider('recording-v7-agent', RecordingProvider);

  let agents = [ {
    id: 'agent_1',
    name: 'Receiving Agent',
    pluginID: 'recording-v7-agent',
    config: { model: 'test-model' },
    secrets: { apiKey: 'sk-test' },
    enabled: true,
  } ];

  let agentManager = {
    async getAgent(agentID, options) {
      // Only the secrets-carrying lookup - the one immediately before the
      // provider is constructed - is parked. Parking earlier reads would make
      // the assertion pass for the wrong reason.
      if (options?.includeSecrets)
        await gate.opened;
      return agents.find((candidate) => candidate.id === agentID) || null;
    },
    async listAgents() { return agents.slice(); },
    async listProviders() { return []; },
    async listTagDefinitions() { return []; },
    async resolveAgent(reference) { return agents.find((agent) => agent.id === reference) || null; },
  };

  let commandRegistry = new CommandRegistry({ logger: quietLogger() });
  let router = new FrameRouter({ logger: quietLogger() });
  // Registered explicitly rather than discovered, so this fixture cannot be
  // influenced by whatever plugins happen to sit on disk.
  router.registerSelector('Type:UserMessage', AgentRouteFramePlugin, AgentRouteFramePlugin.pluginID);

  let services = {
    providerRuns: [],
    pluginRegistry,
    agentManager,
    commandRegistry,
    tokenUsage: { async addTokens() { return {}; } },
    context: {
      require(name) {
        if (name === 'pluginRegistry') return pluginRegistry;
        if (name === 'agentManager') return agentManager;
        if (name === 'commandRegistry') return commandRegistry;
        if (name === 'tokenUsage') return services.tokenUsage;
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

  let session = await runtime.createSession({
    title: 'Typed delivery transition',
    participantAgentIDs: [ 'agent_1' ],
  });

  return { gate, runtime, session, services };
}

// Everything about the bubble is read in one evaluate, so the attributes and the
// computed style cannot come from two different renders.
function readBubble(page, needle) {
  return page.evaluate((text) => {
    let items = [ ...document.querySelectorAll('kikx-frame-item') ];
    let item = items.find((candidate) => candidate.innerText.includes(text));
    if (!item)
      return { present: false, seen: items.map((candidate) => candidate.innerText.slice(0, 40)) };

    let bubble = item.querySelector('kikx-user-message-frame');
    let content = item.querySelector('.kikx-frame__content--user-message');
    return {
      present: true,
      frameID: item.getAttribute('data-frame-id'),
      dataDelivery: item.getAttribute('data-delivery'),
      hasModifierClass: item.classList.contains('kikx-frame--delivery-received'),
      boxShadow: getComputedStyle(item).boxShadow,
      animating: item.getAnimations().some((animation) => animation.playState === 'running'),
      afterContent: content ? getComputedStyle(content, '::after').content : null,
      bubbleDelivery: bubble ? bubble.getAttribute('data-delivery') : null,
      ariaLabel: bubble ? bubble.getAttribute('aria-label') : null,
      connected: item.isConnected,
    };
  }, needle);
}

// No generated content computes as `normal` or `none`; real content is a quoted
// string such as `"Received"`. Normalising both absences to '' keeps "exactly no
// caption" honest instead of asserting a literal Chrome never returns.
function captionText(value) {
  if (!value || value === 'none' || value === 'normal')
    return '';
  return String(value).replace(/^['"]|['"]$/g, '');
}

// The accent fades in over the shell's `box-shadow 180ms ease`
// (styles/app.css:941), so a single sample after the class lands is mid-flight
// and would be indistinguishable from a broken colour token. Wait for a
// non-animating sample that actually satisfies the predicate.
async function waitForSettledShadow(page, needle, isSettled) {
  let deadline = Date.now() + 5000;
  let last = null;
  while (Date.now() < deadline) {
    let sample = await readBubble(page, needle);
    last = sample;
    if (sample.present && !sample.animating && sample.boxShadow && isSettled(sample.boxShadow))
      return sample.boxShadow;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`delivery accent never settled within 5000ms, last=${JSON.stringify(last)}`);
}

// Pin the COLOUR, not merely the presence of an inset. A hardcoded grey 3px
// inset would satisfy "a 3px opaque inset exists", which is exactly the defect a
// prior negative control caught. The probe carries the token inside the item, so
// both values come from the same serialisation path.
function resolveTokenShadow(page, frameID) {
  return page.evaluate((id) => {
    let item = document.querySelector(`kikx-frame-item[data-frame-id="${id}"]`);
    let probe = document.createElement('div');
    probe.style.position = 'absolute';
    probe.style.width = '0';
    probe.style.height = '0';
    probe.style.boxShadow = 'inset 3px 0 0 var(--kikx-frame-delivery-color)';
    item.appendChild(probe);
    let tokenShadow = getComputedStyle(probe).boxShadow;
    probe.remove();
    return tokenShadow;
  }, frameID);
}

test('a typed message flips from neutral to received in the browser when the agent is fed', async (t) => {
  let chromePath = findChromeExecutable();
  if (!chromePath) { t.skip('Puppeteer delivery transition coverage requires Chrome'); return; }

  let { gate, runtime, session, services } = await startProductionStack();

  // The browser fixture is handed the PRODUCTION runtime. `createServer` only
  // builds its own when the context has none (`create-server.mjs:485`), so every
  // frame this page shows is produced by the shipped stack.
  let fixture = await startStagehandUIServer({ frameRuntime: runtime });
  let browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: 'new',
    args: [ '--no-sandbox', '--disable-setuid-sandbox' ],
  });

  try {
    let page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.evaluateOnNewDocument(() => {
      sessionStorage.setItem('kikx.auth.session', JSON.stringify({
        token: 'v7-delivery-token',
        refresh_token: 'v7-delivery-refresh',
      }));
    });

    await page.goto(`${fixture.baseURL}/?session=${session.id}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForFunction(() => document.querySelector('kikx-app')?._startupSettled === true, { timeout: 20000 });

    // ---- the real send path: composer -> POST /api/v1/sessions/:id/messages --
    await page.click('textarea[name="message"]');
    await page.keyboard.type(TYPED_TEXT);
    await page.keyboard.press('Enter');

    await page.waitForFunction((text) => (
      [ ...document.querySelectorAll('kikx-frame-item') ].some((item) => item.innerText.includes(text))
    ), { timeout: 20000 }, TYPED_TEXT);

    // ---- neutral, while the provider has provably not been fed --------------
    let before = await readBubble(page, TYPED_TEXT);
    assert.equal(before.present, true, `the typed message must render; saw: ${JSON.stringify(before.seen)}`);
    assert.ok(before.frameID, 'the rendered frame must expose its id');

    assert.deepEqual(services.providerRuns, [], 'the provider must not have been fed yet');
    assert.equal(before.dataDelivery, 'neutral', 'a typed message must render with an explicit neutral delivery');
    assert.equal(before.hasModifierClass, false, 'a neutral message must not carry the received modifier');
    assert.equal(before.boxShadow, 'none', 'a neutral message must not paint the delivery accent');
    assert.equal(captionText(before.afterContent), '', 'a neutral message must not show the Received caption');
    assert.equal(before.bubbleDelivery, null, 'the bubble must not claim a delivery state while neutral');
    assert.equal(before.ariaLabel, null, 'a neutral message must not announce itself as received');
    assert.equal(before.connected, true, 'the item must be a live node, not a detached copy');

    // The stored frame is neutral too: the picture and the state agree.
    let storedBefore = runtime.requireSessionEntry(session.id).frameEngine.get(before.frameID);
    assert.equal(storedBefore.content.delivery, 'neutral');
    assert.equal(Object.hasOwn(storedBefore.content, 'deliveryAt'), false, 'a neutral frame carries no deliveryAt key');

    // ---- release the agent lookup: the provider is now fed ------------------
    gate.release();

    await page.waitForFunction((text) => {
      let item = [ ...document.querySelectorAll('kikx-frame-item') ].find((candidate) => candidate.innerText.includes(text));
      return item?.getAttribute('data-delivery') === 'received';
    }, { timeout: 20000 }, TYPED_TEXT);

    let settledShadow = await waitForSettledShadow(
      page,
      TYPED_TEXT,
      (shadow) => shadow.includes('inset') && !shadow.startsWith('none') && !shadow.includes('/ 0.'),
    );

    let after = await readBubble(page, TYPED_TEXT);
    assert.equal(after.present, true);
    // Same node, not a re-rendered replacement: the existing bubble is updated in
    // place by `frame.updated`.
    assert.equal(after.frameID, before.frameID, 'the same frame must transition in place');
    assert.equal(after.connected, true, 'the item must still be a live node after the update');

    assert.equal(after.dataDelivery, 'received');
    assert.equal(after.hasModifierClass, true, 'the received modifier must be applied');
    assert.equal(captionText(after.afterContent), 'Received', 'the Received caption must be shown');
    assert.equal(after.bubbleDelivery, 'received', 'the bubble must carry the delivery state');
    assert.equal(after.ariaLabel, RECEIVED_LABEL, 'the bubble must announce that the agent received it');

    // The inset must BE the delivery token, not any inset.
    let tokenShadow = await resolveTokenShadow(page, after.frameID);
    assert.equal(
      settledShadow,
      tokenShadow,
      `the settled inset must use the delivery token, painted=${settledShadow} token=${tokenShadow}`,
    );

    // ---- the picture matches the state the server actually holds ------------
    assert.deepEqual(services.providerRuns, [ before.frameID ], 'the provider must have been fed this exact frame');
    let storedAfter = runtime.requireSessionEntry(session.id).frameEngine.get(after.frameID);
    assert.equal(storedAfter.content.delivery, 'received');
    assert.equal(Number.isFinite(storedAfter.content.deliveryAt), true, 'a received frame must carry a real deliveryAt');
  } finally {
    await browser.close();
    await fixture.close();
  }
});
