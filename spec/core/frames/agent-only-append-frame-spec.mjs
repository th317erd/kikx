'use strict';

// =============================================================================
// appendFrame() — an end-to-end proof, not a unit test of the pieces
// =============================================================================
// The pieces above (a class flag, a predicate, a router branch) are only worth
// anything if a plugin can actually cause all of them at once. This spec drives
// the real FrameRuntime with a plugin registered in a real PluginRegistry, then
// asks the three questions the owner asked:
//
//   1. Is the frame a DiscordFrame rather than a UserMessage?
//   2. Is it absent from the session thread?
//   3. Does the agent still receive it?
//
// A unit test of any one of these can pass while the feature is inert, which is
// exactly the failure mode this work exists to correct.
// =============================================================================

import assert from 'node:assert/strict';
import test from 'node:test';

import { PluginRegistry } from '../../../src/core/plugins/index.mjs';
import { registerCoreClasses } from '../../../src/core/plugins/core-classes.mjs';
import { FrameRuntime } from '../../../src/core/runtime/frame-runtime.mjs';
import { createTypedFrame } from '../../../src/core/frames/frame-types/index.mjs';
import { shouldRouteToAgents } from '../../../src/core/agents/agent-route/targeting.mjs';
import { frameToModelTurn } from '../../../src/core/plugins/agent-model-context.mjs';
import { frameMatchesWindowFilters, defaultFrameWindowFilters } from '../../../src/shared/frame-window-filters.mjs';
import { isThreadVisibleFrame } from '../../../src/shared/coordination-visibility.mjs';

function createClient() {
  let files = new Map();
  return {
    files,
    async putFile(path, body) {
      files.set(path, body);
      return { path };
    },
    async getFile(path) {
      return files.get(path) || null;
    },
    async listDirectory(path, requestOptions) {
      let prefix = `${path.replace(/\/+$/g, '')}/`;
      let items = [];
      for (let filePath of files.keys()) {
        if (!filePath.startsWith(prefix))
          continue;

        if (requestOptions?.glob === '*/session.json' && !/^\/kikx\/sessions\/[^/]+\/session\.json$/.test(filePath))
          continue;

        if (requestOptions?.glob === '**/frames/*.json' && !filePath.includes('/frames/'))
          continue;

        items.push({ path: filePath });
      }
      return { items };
    },
  };
}

function createFixture() {
  let registry = new PluginRegistry();
  registerCoreClasses(registry);

  let UserMessageBase = registry.getClass('FrameTypeUserMessage');
  assert.equal(typeof UserMessageBase, 'function', 'core must register FrameTypeUserMessage');

  // Exactly what kikx-plugin-discord does in its index.mjs.
  class FrameTypeDiscordFrame extends UserMessageBase {
    static agentOnly = true;
  }
  registry.registerClass('FrameTypeDiscordFrame', FrameTypeDiscordFrame);

  let ids = [ 'ses_1', 'int_1', 'msg_1', 'commit_1', 'int_2', 'msg_2', 'commit_2' ];
  let index = 0;
  let runtime = new FrameRuntime({
    aeordb: createClient(),
    pluginRegistry: registry,
    clock: () => 1000,
    runnerID: 'runtime',
    idGenerator: () => ids[index++],
  });

  return { registry, runtime };
}

async function createSession(runtime) {
  return runtime.createSession({
    title: 'Discord',
    organizationID: 'org_1',
    createdByUserID: 'usr_1',
  });
}

test('a plugin-registered type is written as that type and marked agent-only', async () => {
  let { runtime } = createFixture();
  let session = await createSession(runtime);

  let result = await runtime.appendFrame(session.id, {
    type: 'DiscordFrame',
    text: '[discord:th317erd] hello from discord',
    authorID: 'discord:1234',
    authorDisplayName: 'th317erd',
    content: { discord: { messageID: 'm1', channelID: 'c1', authorName: 'th317erd' } },
    flushRouter: false,
  });

  let frame = result.frame;
  assert.equal(frame.type, 'DiscordFrame', 'the frame must carry its own type');
  assert.equal(frame.agentOnly, true, 'the class declaration must be stamped on the record');
  assert.equal(frame.authorID, 'discord:1234');
  // The name is the bare handle. A " (Discord)" suffix was the old attempt at
  // attribution and made the owner look like somebody else.
  assert.equal(frame.authorDisplayName, 'th317erd');
  assert.equal(frame.hidden, false, 'hidden is not the mechanism - it would deafen the bot');
});

test('an ordinary user message is unchanged by the new path', async () => {
  let { runtime } = createFixture();
  let session = await createSession(runtime);

  let result = await runtime.appendUserMessage(session.id, {
    text: 'typed by the owner',
    userID: 'usr_1',
    flushRouter: false,
  });

  let frame = result.frame;
  assert.equal(frame.type, 'UserMessage');
  // Absent, not false: every pre-existing user message must serialise identically.
  assert.equal('agentOnly' in frame, false);
});

test('the frame is invisible in the thread and still reaches the agent', async () => {
  let { runtime, registry } = createFixture();
  let session = await createSession(runtime);

  let { frame: written } = await runtime.appendFrame(session.id, {
    type: 'DiscordFrame',
    text: '[discord:th317erd] hello from discord',
    authorID: 'discord:1234',
    authorDisplayName: 'th317erd',
    flushRouter: false,
  });

  // Read it back the way production does: the model-context path resolves the
  // plugin registry from services and passes it to the factory, which is how the
  // plugin's class is found. Passing no registry here would resolve
  // FrameTypeDefault and drop the frame - a real dependency, asserted below rather
  // than hidden.
  let typed = createTypedFrame(written, { registry });

  // 1. Not in the thread - and the Hidden gate must not reveal it either.
  assert.equal(isThreadVisibleFrame(written), false);
  assert.equal(frameMatchesWindowFilters(written, defaultFrameWindowFilters()), false);
  assert.equal(
    frameMatchesWindowFilters(written, { ...defaultFrameWindowFilters(), deleted: true }),
    false,
    'the Hidden gate reveals bookkeeping, not agent traffic',
  );

  // 2. Still delivered to the agent. Both halves matter: the router must route it,
  //    and it must project into a model turn. `hidden: true` would fail both.
  assert.deepEqual(typed.toAgentMessage({}), {
    role: 'user',
    content: '[discord:th317erd] hello from discord',
  });
  assert.equal(
    shouldRouteToAgents({ change: { operation: 'create' } }, written),
    true,
    'an agent-only frame must still wake the agent',
  );

  // The same two facts through the production projection entry point, so this is
  // not just the class API agreeing with itself.
  assert.deepEqual(
    frameToModelTurn(written, { registry }),
    { role: 'user', content: '[discord:th317erd] hello from discord' },
  );

  // Measured dependency, not an assumption: agent delivery needs the plugin's frame
  // type to be registered. Resolved without a registry the type falls back to
  // FrameTypeDefault and contributes nothing. That is acceptable - an unloaded
  // plugin should not silently keep feeding the model - but it must be known.
  assert.equal(frameToModelTurn(written), null);
});

test('an unregistered frame type is refused instead of silently becoming Default', async () => {
  let { runtime } = createFixture();
  let session = await createSession(runtime);

  await assert.rejects(
    () => runtime.appendFrame(session.id, { type: 'DiscordFramee', text: 'typo' }),
    /is not registered/,
  );
});

test('a caller cannot declare its own frame agent-only', async () => {
  let { runtime } = createFixture();
  let session = await createSession(runtime);

  // UserMessage is registered and is NOT agent-only. Passing agentOnly: true in the
  // input must not be honoured - otherwise any plugin could hide its frames from the
  // session while claiming they are transport traffic.
  let result = await runtime.appendFrame(session.id, {
    type: 'UserMessage',
    text: 'not from a transport',
    agentOnly: true,
    flushRouter: false,
  });

  assert.equal(result.frame.agentOnly, undefined);
  assert.equal(isThreadVisibleFrame(result.frame), true);
});
