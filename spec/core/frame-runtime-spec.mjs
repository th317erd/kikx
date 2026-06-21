'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { CommandRegistry, registerInternalCommands } from '../../src/core/commands/index.mjs';
import { PluginRegistry } from '../../src/core/plugins/index.mjs';
import { FrameRouter } from '../../src/core/routing/index.mjs';
import { FrameRuntime } from '../../src/core/runtime/frame-runtime.mjs';

function createClient(options = {}) {
  let calls = [];
  return {
    calls,
    files: new Map(),
    async putFile(path, body) {
      calls.push({ method: 'putFile', path, body });
      this.files.set(path, body);

      if (options.failPut)
        throw new Error(options.failPut);

      return { path };
    },
    async getFile(path) {
      calls.push({ method: 'getFile', path });
      return this.files.get(path) || null;
    },
    async listDirectory(path, requestOptions) {
      calls.push({ method: 'listDirectory', path, options: requestOptions });
      let prefix = `${path.replace(/\/+$/g, '')}/`;
      let items = [];
      for (let filePath of this.files.keys()) {
        if (!filePath.startsWith(prefix))
          continue;

        if ((requestOptions?.glob === '*/session.json' || requestOptions?.glob === '**/session.json') && !/^\/kikx\/sessions\/[^/]+\/session\.json$/.test(filePath))
          continue;

        if (requestOptions?.glob === '**/frames/*.json' && !filePath.includes('/frames/'))
          continue;

        items.push({ path: filePath });
      }
      return { items };
    },
  };
}

function createRuntime(options = {}) {
  let ids = options.ids || [ 'ses_1', 'int_1', 'msg_1', 'commit_1' ];
  let index = 0;

  return new FrameRuntime({
    aeordb: options.aeordb || createClient(),
    clock: () => options.now || 1000,
    runnerID: options.runnerID || 'runtime',
    idGenerator: () => ids[index++],
  });
}

test('FrameRuntime creates sessions and writes AeorDB index configs', async () => {
  let aeordb = createClient();
  let runtime = createRuntime({ aeordb, ids: [ 'ses_1' ] });

  let session = await runtime.createSession({
    title: 'Scratch',
    organizationID: 'org_1',
    createdByUserID: 'usr_1',
  });

  assert.equal(session.id, 'ses_1');
  assert.equal(session.title, 'Scratch');
  assert.equal(session.messageCount, 0);
  assert.equal(session.createdByAgentID, null);
  assert.equal(session.parentSessionID, null);
  assert.equal(session.generation, 0);
  assert.equal(runtime.getSession('ses_1'), session);
  assert.deepEqual(aeordb.calls.map((call) => call.path), [
    '/kikx/sessions/.aeordb-config/indexes.json',
    '/kikx/sessions/ses_1/interactions/.aeordb-config/indexes.json',
    '/kikx/sessions/ses_1/values/.aeordb-config/indexes.json',
    '/kikx/sessions/ses_1/tool-log/.aeordb-config/indexes.json',
    '/kikx/sessions/ses_1/session.json',
  ]);
});

test('FrameRuntime defaults session titles to numbered names', async () => {
  let now = 1000;
  let runtime = new FrameRuntime({
    aeordb: createClient(),
    clock: () => now++,
    idGenerator: (() => {
      let ids = [ 'ses_1', 'ses_2' ];
      let index = 0;
      return () => ids[index++];
    })(),
  });

  let first = await runtime.createSession();
  let second = await runtime.createSession();

  assert.equal(first.title, 'Session 1');
  assert.equal(second.title, 'Session 2');
  assert.equal(first.createdAt, 1_000_000);
  assert.equal(second.createdAt, 1_001_000);
});

test('FrameRuntime records agent-created child session lineage', async () => {
  let aeordb = createClient();
  let runtime = createRuntime({ aeordb, ids: [ 'ses_child' ] });

  let session = await runtime.createSession({
    title: 'Child',
    createdByAgentID: 'agent_1',
    parentSessionID: 'ses_parent',
    generation: 1,
  });

  assert.equal(session.createdByAgentID, 'agent_1');
  assert.equal(session.parentSessionID, 'ses_parent');
  assert.equal(session.generation, 1);
  assert.equal(aeordb.files.get('/kikx/sessions/ses_child/session.json').generation, 1);
});

test('FrameRuntime renames sessions and persists the manifest', async () => {
  let aeordb = createClient();
  let runtime = createRuntime({ aeordb, ids: [ 'ses_1' ], now: 1000 });

  await runtime.createSession();
  runtime.clock = () => 2000;
  let session = await runtime.updateSession('ses_1', { title: 'Project Alpha' });

  assert.equal(session.title, 'Project Alpha');
  assert.equal(session.updatedAt, 2_000_000);
  assert.equal(session.updatedClock, '0000000002000000-000000-runtime');
  assert.equal(runtime.getSession('ses_1'), session);
  assert.equal(aeordb.calls.at(-1).path, '/kikx/sessions/ses_1/session.json');
  assert.equal(aeordb.calls.at(-1).body.title, 'Project Alpha');
});

test('FrameRuntime lists sessions from AeorDB instead of active memory', async () => {
  let aeordb = createClient();
  aeordb.files.set('/kikx/sessions/ses_1/session.json', { id: 'ses_1', title: 'Persisted', updatedAt: 2_000_000 });
  let runtime = createRuntime({ aeordb, ids: [ 'active_1' ] });

  await runtime.createSession({ title: 'Active only' });
  let sessions = await runtime.listSessions({ limit: 25 });

  assert.deepEqual(sessions.map((session) => session.title), [ 'Persisted', 'Active only' ]);
  assert.ok(aeordb.calls.some((call) => call.method === 'listDirectory' && call.options.limit === 25));
});

test('FrameRuntime lazily opens persisted sessions for frames and messages', async () => {
  let aeordb = createClient();
  aeordb.files.set('/kikx/sessions/ses_1/session.json', { id: 'ses_1', title: 'Persisted', updatedAt: 1000 });
  aeordb.files.set('/kikx/sessions/ses_1/interactions/int_1/frames/0000000000000001-UserMessage-msg_1.json', {
    id: 'msg_1',
    type: 'UserMessage',
    sessionID: 'ses_1',
    interactionID: 'int_1',
    order: 1,
    content: { text: 'existing' },
    hidden: false,
  });
  let runtime = createRuntime({ aeordb, ids: [ 'int_2', 'msg_2', 'commit_2' ] });

  assert.deepEqual((await runtime.listFrames('ses_1')).map((frame) => frame.id), [ 'msg_1' ]);
  let result = await runtime.appendUserMessage('ses_1', { text: 'next' });

  assert.equal(result.frame.id, 'msg_2');
  assert.equal(result.commit.order, 2);
  assert.deepEqual((await runtime.listFrames('ses_1')).map((frame) => frame.id), [ 'msg_1', 'msg_2' ]);
});

test('FrameRuntime hydrates persisted sessions beyond the old 250-frame window', async () => {
  let aeordb = createClient();
  aeordb.files.set('/kikx/sessions/ses_1/session.json', { id: 'ses_1', title: 'Persisted', updatedAt: 1000 });

  for (let index = 1; index <= 300; index++) {
    let padded = String(index).padStart(16, '0');
    aeordb.files.set(`/kikx/sessions/ses_1/interactions/int_${index}/frames/${padded}-UserMessage-msg_${index}.json`, {
      id: `msg_${index}`,
      type: 'UserMessage',
      sessionID: 'ses_1',
      interactionID: `int_${index}`,
      order: index,
      hidden: false,
      content: { text: `message ${index}` },
    });
  }

  let runtime = createRuntime({ aeordb });
  let frames = await runtime.listFrames('ses_1');

  assert.equal(frames.length, 300);
  assert.equal(frames[0].id, 'msg_1');
  assert.equal(frames.at(-1).id, 'msg_300');
  assert.deepEqual((await runtime.listFrames('ses_1', { limit: 3, offset: 250 })).map((frame) => frame.id), [
    'msg_251',
    'msg_252',
    'msg_253',
  ]);
});

test('FrameRuntime recovers stale streaming agent responses and running tool calls', async () => {
  let aeordb = createClient();
  aeordb.files.set('/kikx/sessions/ses_1/session.json', { id: 'ses_1', title: 'Kikx', updatedAt: 1000 });
  aeordb.files.set('/kikx/sessions/ses_1/interactions/int_1/frames/0000000000000001-UserMessage-msg_1.json', {
    id: 'msg_1',
    type: 'UserMessage',
    sessionID: 'ses_1',
    interactionID: 'int_1',
    order: 1,
    hidden: false,
    deleted: false,
    content: { text: 'read docs' },
  });
  aeordb.files.set('/kikx/sessions/ses_1/interactions/int_1/frames/0000000000000002-AgentMessage-agent_pending.json', {
    id: 'agent_pending',
    type: 'AgentMessage',
    sessionID: 'ses_1',
    interactionID: 'int_1',
    parentID: 'msg_1',
    authorType: 'agent',
    authorID: 'agent_1',
    order: 2,
    hidden: true,
    deleted: false,
    content: {
      text: '',
      status: 'streaming',
      thinking: { status: 'pending' },
    },
  });
  aeordb.files.set('/kikx/sessions/ses_1/interactions/int_1/frames/0000000000000003-ShellToolFrame-tool_call.json', {
    id: 'tool_call',
    type: 'ShellToolFrame',
    sessionID: 'ses_1',
    interactionID: 'int_1',
    parentID: 'agent_pending',
    authorType: 'agent',
    authorID: 'agent_1',
    order: 3,
    hidden: false,
    deleted: false,
    content: {
      toolName: 'exec',
      phase: 'call',
      toolCallID: 'call_1',
      status: 'running',
    },
    state: { status: 'running' },
  });
  let runtime = createRuntime({ aeordb, ids: [ 'commit_recovery' ], now: 2000 });

  let result = await runtime.recoverStaleRuntimeFrames({ sessionLimit: 10 });
  let frames = await runtime.listFrames('ses_1');
  let agentFrame = frames.find((frame) => frame.id === 'agent_pending');
  let toolFrame = frames.find((frame) => frame.id === 'tool_call');

  assert.equal(result.recoveredAgentResponses, 1);
  assert.equal(result.recoveredToolCalls, 1);
  assert.equal(agentFrame.hidden, false);
  assert.equal(agentFrame.content.status, 'error');
  assert.equal(agentFrame.content.error.recovered, true);
  assert.match(agentFrame.content.text, /recovered this agent response/);
  assert.equal(toolFrame.content.status, 'failed');
  assert.equal(toolFrame.state.status, 'failed');
  assert.equal(toolFrame.content.error.recovered, true);
  assert.ok(aeordb.calls.some((call) => call.method === 'putFile' && call.path.includes('agent_pending.json')));
  assert.ok(aeordb.calls.some((call) => call.method === 'putFile' && call.path.includes('tool_call.json')));
});

test('FrameRuntime appends user messages through FrameEngine and AeorDBFrameStore', async () => {
  let aeordb = createClient();
  let runtime = createRuntime({ aeordb, ids: [ 'ses_1', 'int_1', 'msg_1', 'commit_1' ] });

  await runtime.createSession({ title: 'Scratch' });
  let result = await runtime.appendUserMessage('ses_1', {
    text: 'hello',
    userID: 'usr_1',
    authorDisplayName: 'Wyatt',
  });

  assert.equal(result.frame.id, 'msg_1');
  assert.equal(result.frame.type, 'UserMessage');
  assert.equal(result.frame.hidden, false);
  assert.equal(result.frame.authorDisplayName, 'Wyatt');
  assert.equal(result.frame.content.text, 'hello');
  assert.equal(result.commit.id, 'commit_1');
  assert.equal(result.commit.order, 1);
  assert.equal(result.session.messageCount, 1);
  assert.deepEqual((await runtime.listFrames('ses_1')).map((frame) => frame.id), [ 'msg_1' ]);
  assert.ok(aeordb.calls.some((call) => call.path === '/kikx/sessions/ses_1/commits/0000000000000001-commit_1.json'));
  assert.ok(aeordb.calls.some((call) => call.path === '/kikx/sessions/ses_1/interactions/int_1/frames/0000000000000001-UserMessage-msg_1.json'));
  assert.equal(aeordb.calls.at(-1).path, '/kikx/sessions/ses_1/session.json');
  assert.equal(aeordb.calls.at(-1).body.messageCount, 1);
});

test('FrameRuntime idempotently persists invited agent participants on session manifests', async () => {
  let aeordb = createClient();
  let runtime = createRuntime({ aeordb, ids: [ 'ses_1' ], now: 1000 });

  await runtime.createSession({ title: 'Scratch' });
  let first = await runtime.inviteAgentToSession('ses_1', {
    id: 'agent_1',
    name: 'Coder',
  }, { invitedAt: 2000 });
  let second = await runtime.inviteAgentToSession('ses_1', {
    id: 'agent_1',
    name: 'Coder',
  }, { invitedAt: 3000 });

  assert.equal(first.alreadyParticipant, false);
  assert.equal(second.alreadyParticipant, true);
  assert.deepEqual(second.session.participantAgentIDs, [ 'agent_1' ]);
  assert.equal(first.session.coordinatorAgentID, 'agent_1');
  assert.equal(second.session.coordinatorAgentID, 'agent_1');
  assert.equal(second.session.updatedAt, 3000);
  assert.equal(aeordb.calls.at(-1).path, '/kikx/sessions/ses_1/session.json');
  assert.deepEqual(aeordb.calls.at(-1).body.participantAgentIDs, [ 'agent_1' ]);
  assert.equal(aeordb.calls.at(-1).body.coordinatorAgentID, 'agent_1');
});

test('FrameRuntime assigns the first invited agent as coordinator and preserves it for later invites', async () => {
  let aeordb = createClient();
  let runtime = createRuntime({ aeordb, ids: [ 'ses_1' ], now: 1000 });

  await runtime.createSession({ title: 'Scratch' });
  let first = await runtime.inviteAgentToSession('ses_1', {
    id: 'agent_1',
    name: 'Coder',
  }, { invitedAt: 2000 });
  let second = await runtime.inviteAgentToSession('ses_1', {
    id: 'agent_2',
    name: 'Reviewer',
  }, { invitedAt: 3000 });

  assert.equal(first.session.coordinatorAgentID, 'agent_1');
  assert.equal(second.session.coordinatorAgentID, 'agent_1');
  assert.deepEqual(second.session.participantAgentIDs, [ 'agent_1', 'agent_2' ]);
});

test('FrameRuntime normalizes coordinator manifests when participant input is provided', async () => {
  let runtime = createRuntime({ ids: [ 'ses_1', 'ses_2', 'ses_3' ] });

  let empty = await runtime.createSession({
    title: 'Empty',
    participantAgentIDs: [],
    coordinatorAgentID: 'agent_missing',
  });
  let first = await runtime.createSession({
    title: 'First',
    participantAgentIDs: [ 'agent_1', 'agent_2' ],
  });
  let explicit = await runtime.createSession({
    title: 'Explicit',
    participantAgentIDs: [ 'agent_1', 'agent_2' ],
    coordinatorAgentID: 'agent_2',
  });

  assert.equal(empty.coordinatorAgentID, null);
  assert.equal(first.coordinatorAgentID, 'agent_1');
  assert.equal(explicit.coordinatorAgentID, 'agent_2');
});

test('FrameRuntime routes user messages through the configured frame router', async () => {
  let routed = [];
  let aeordb = createClient();
  let runtime = new FrameRuntime({
    aeordb,
    clock: () => 1000,
    idGenerator: (() => {
      let ids = [ 'ses_1', 'int_1', 'msg_1', 'commit_1' ];
      let index = 0;
      return () => ids[index++];
    })(),
    frameRouter: {
      connectTo(frameEngine, session, options) {
        let handler = ({ commit }) => routed.push({ sessionID: session.id, commitID: commit.id, services: options.services });
        frameEngine.on('commit', handler);
        return () => frameEngine.off('commit', handler);
      },
    },
    services: { commandRegistry: {} },
  });

  await runtime.createSession({ title: 'Scratch' });
  await runtime.appendUserMessage('ses_1', { text: 'hello' });

  assert.equal(routed.length, 1);
  assert.equal(routed[0].sessionID, 'ses_1');
  assert.equal(routed[0].commitID, 'commit_1');
  assert.equal(routed[0].services.frameRuntime, runtime);
});

test('FrameRuntime defers frames with scheduledAt until the scheduled queue dispatches them', async () => {
  let routed = [];
  let now = 1000;
  let aeordb = createClient();
  let router = new FrameRouter({ logger: quietLogger() });

  class ObserverPlugin {
    constructor(context = {}) {
      this.context = context;
    }

    async process(next) {
      routed.push({
        frameID: this.context.newFrame.id,
        scheduledDispatch: this.context.commit.scheduledDispatch === true,
      });
      await next(this.context);
    }
  }

  router.registerSelector('Type:UserMessage', ObserverPlugin, 'observer');
  let runtime = new FrameRuntime({
    aeordb,
    frameRouter: router,
    clock: () => now,
    idGenerator: (() => {
      let ids = [ 'ses_1', 'commit_1', 'commit_2', 'commit_3' ];
      let index = 0;
      return () => ids[index++];
    })(),
  });

  await runtime.createSession({ title: 'Scratch' });
  let entry = runtime.requireSessionEntry('ses_1');
  entry.frameEngine.merge([{
    id: 'scheduled_msg_1',
    type: 'UserMessage',
    sessionID: 'ses_1',
    interactionID: 'int_1',
    authorType: 'system',
    authorID: 'test',
    scheduledAt: 2000,
    scheduledStatus: 'pending',
    hidden: false,
    content: { text: 'later' },
  }], {
    authorType: 'system',
    authorID: 'test',
  });
  await runtime.frameRouter.flush();

  assert.deepEqual(routed, []);

  now = 2000;
  let dispatched = await runtime.processScheduledFrames();
  await runtime.frameRouter.flush();
  await runtime.frameStore.flush();

  assert.deepEqual(routed, [{
    frameID: 'scheduled_msg_1',
    scheduledDispatch: true,
  }]);
  assert.equal(dispatched[0].id, 'scheduled_msg_1');
  assert.equal(entry.frameEngine.get('scheduled_msg_1').scheduledStatus, 'fired');
});

test('FrameRuntime reloads unfired scheduled frames from AeorDB before dispatch', async () => {
  let routed = [];
  let now = 2000;
  let aeordb = createClient();
  aeordb.files.set('/kikx/sessions/ses_1/session.json', { id: 'ses_1', title: 'Persisted', updatedAt: 1000 });
  aeordb.files.set('/kikx/sessions/ses_1/interactions/int_1/frames/0000000000000001-UserMessage-scheduled_msg_1.json', {
    id: 'scheduled_msg_1',
    type: 'UserMessage',
    sessionID: 'ses_1',
    interactionID: 'int_1',
    order: 1,
    authorType: 'system',
    authorID: 'test',
    scheduledAt: 1500,
    scheduledStatus: 'pending',
    hidden: false,
    content: { text: 'persisted later' },
  });
  let router = new FrameRouter({ logger: quietLogger() });

  class ObserverPlugin {
    constructor(context = {}) {
      this.context = context;
    }

    async process(next) {
      routed.push(this.context.newFrame.id);
      await next(this.context);
    }
  }

  router.registerSelector('Type:UserMessage', ObserverPlugin, 'observer');
  let runtime = new FrameRuntime({
    aeordb,
    frameRouter: router,
    clock: () => now,
    idGenerator: (() => {
      let ids = [ 'commit_1', 'commit_2' ];
      let index = 0;
      return () => ids[index++];
    })(),
  });

  await runtime.loadScheduledFrames();
  await runtime.processScheduledFrames();

  assert.deepEqual(routed, [ 'scheduled_msg_1' ]);
  assert.equal(runtime.requireSessionEntry('ses_1').frameEngine.get('scheduled_msg_1').scheduledStatus, 'fired');
});

test('FrameRuntime emits runtime events for persistent and phantom frames', async () => {
  let events = [];
  let aeordb = createClient();
  let runtime = new FrameRuntime({
    aeordb,
    clock: () => 1000,
    idGenerator: (() => {
      let ids = [ 'ses_1', 'int_1', 'msg_1', 'commit_1', 'phantom_1', 'agent_1', 'commit_2' ];
      let index = 0;
      return () => ids[index++];
    })(),
  });
  runtime.on('event', (event) => events.push(event));

  await runtime.createSession({ title: 'Scratch' });
  await runtime.appendUserMessage('ses_1', { text: 'hello', userID: 'usr_1' });
  let entry = runtime.requireSessionEntry('ses_1');
  entry.frameEngine.merge([{
    id: 'phantom_1',
    type: 'AgentThinking',
    sessionID: 'ses_1',
    interactionID: 'int_1',
    parentID: 'msg_1',
    phantom: true,
    content: { text: 'thinking' },
  }]);
  entry.frameEngine.merge([{
    id: 'agent_1',
    type: 'AgentMessage',
    sessionID: 'ses_1',
    interactionID: 'int_1',
    parentID: 'msg_1',
    hidden: false,
    content: { text: 'hello back' },
  }]);

  assert.deepEqual(events.map((event) => event.type), [
    'session.saved',
    'frame.added',
    'commit',
    'session.saved',
    'frame.phantom',
    'frame.added',
    'commit',
  ]);
  assert.equal(events[1].sessionID, 'ses_1');
  assert.equal(events[1].frame.type, 'UserMessage');
  assert.equal(events[4].frame.type, 'AgentThinking');
  assert.equal(events[4].frame.phantom, true);
  assert.equal(events[5].frame.type, 'AgentMessage');
});

test('FrameRuntime routes /invite through internal command before lower priority agent routes', async () => {
  let result = await routeInviteMessage('/invite Coder', 'Coder');

  assert.deepEqual(result.agentRoutes, []);
  assert.deepEqual(result.session.participantAgentIDs, [ 'agent_1' ]);
  assert.equal(result.session.coordinatorAgentID, 'agent_1');
  assert.deepEqual(result.frames.map((frame) => frame.type), [ 'UserMessage', 'CommandResult' ]);
  assert.equal(result.frames[1].content.text, 'Coder joined this session.');
});

test('FrameRuntime appendUserMessage waits for routed command frames to persist before returning', async () => {
  let result = await routeInviteMessage('/invite Coder', 'Coder', { skipPostAppendWait: true });

  assert.deepEqual(result.frames.map((frame) => frame.type), [ 'UserMessage', 'CommandResult' ]);
  assert.ok(result.savedFramePaths.some((path) => path.includes('-CommandResult-')));
});

test('FrameRuntime routes normal messages to participants invited in the same active session', async () => {
  let aeordb = createClient();
  let pluginRegistry = new PluginRegistry({ logger: quietLogger() });
  let commandRegistry = new CommandRegistry({ logger: quietLogger() });
  let router = new FrameRouter({ logger: quietLogger() });
  let observed = [];
  let runtime;

  class ParticipantObserverPlugin {
    constructor(context = {}) {
      this.context = context;
    }

    async process(next) {
      if (!this.context.newFrame.content.text.startsWith('/')) {
        observed.push({
          text: this.context.newFrame.content.text,
          participantAgentIDs: this.context.session.participantAgentIDs?.slice() || [],
        });
      }
      await next(this.context);
    }
  }

  let agentManager = {
    async resolveAgent(reference) {
      assert.equal(reference, 'Coder');
      return { id: 'agent_1', name: 'Coder' };
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
  pluginRegistry.registerSelector('Type:UserMessage', ParticipantObserverPlugin, 'participant-observer');
  router.loadFromRegistry(pluginRegistry);

  let ids = [ 'ses_1', 'int_1', 'invite_1', 'commit_1', 'cmd_1', 'commit_2', 'int_2', 'msg_1', 'commit_3' ];
  runtime = new FrameRuntime({
    aeordb,
    frameRouter: router,
    services: { context },
    clock: () => 1000,
    idGenerator: () => ids.shift(),
  });

  await runtime.createSession({ title: 'Scratch' });
  await runtime.appendUserMessage('ses_1', { text: '/invite Coder', userID: 'usr_1' });
  await runtime.appendUserMessage('ses_1', { text: 'hello', userID: 'usr_1' });

  assert.deepEqual(observed, [{
    text: 'hello',
    participantAgentIDs: [ 'agent_1' ],
  }]);
});

test('FrameRuntime supports spaced and quoted agent names in /invite', async () => {
  assert.equal((await routeInviteMessage('/invite Agent With Spaces', 'Agent With Spaces')).frames[1].content.status, 'ok');
  assert.equal((await routeInviteMessage('/invite "Agent With Spaces"', 'Agent With Spaces')).frames[1].content.status, 'ok');
  assert.equal((await routeInviteMessage("/invite 'Agent With Spaces'", 'Agent With Spaces')).frames[1].content.status, 'ok');
  assert.equal((await routeInviteMessage('/invite Mr. Bennett', 'Mr. Bennett')).frames[1].content.status, 'ok');
  assert.equal((await routeInviteMessage('/invite "Mr. Bennett"', 'Mr. Bennett')).frames[1].content.status, 'ok');
  assert.equal((await routeInviteMessage("/invite 'Mr. Bennett'", 'Mr. Bennett')).frames[1].content.status, 'ok');
});

test('FrameRuntime reports malformed quoted /invite arguments as command errors', async () => {
  let result = await routeInviteMessage('/invite "Agent With Spaces', null);

  assert.deepEqual(result.agentRoutes, []);
  assert.equal(result.frames[1].type, 'CommandResult');
  assert.equal(result.frames[1].content.status, 'error');
  assert.match(result.frames[1].content.text, /Usage: \/invite/);
});

test('FrameRuntime routes /compact to manual compaction without a generic command result', async () => {
  let aeordb = createClient();
  let pluginRegistry = new PluginRegistry({ logger: quietLogger() });
  let commandRegistry = new CommandRegistry({ logger: quietLogger() });
  let router = new FrameRouter({ logger: quietLogger() });
  let compactionCalls = [];
  let runtime;
  let context = {
    require(name) {
      if (name === 'commandRegistry')
        return commandRegistry;

      if (name === 'frameRuntime')
        return runtime;

      if (name === 'compactionService') {
        return {
          startManualCompaction(input) {
            compactionCalls.push({
              sessionID: input.session.id,
              triggerFrameID: input.triggerFrame.id,
            });
            input.frameEngine.merge([{
              id: 'manual_compaction_1',
              type: 'CompactionFrame',
              sessionID: input.session.id,
              interactionID: 'compact_1',
              parentID: input.triggerFrame.id,
              authorType: 'system',
              authorID: 'internal:compaction',
              hidden: false,
              deleted: false,
              content: {
                kind: 'compaction_frame',
                status: 'running',
                text: 'Compacting session context...',
              },
            }], {
              authorType: 'system',
              authorID: 'internal:compaction',
            });
            return Promise.resolve();
          },
        };
      }

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
    idGenerator: createIDGenerator([ 'ses_1', 'int_1', 'msg_1', 'commit_1', 'manual_commit_1' ]),
  });

  await runtime.createSession({ title: 'Scratch' });
  await runtime.appendUserMessage('ses_1', { text: '/compact', userID: 'usr_1' });
  await runtime.frameRouter.flush();
  await runtime.frameStore.flush();

  let frames = await runtime.listFrames('ses_1');
  assert.deepEqual(compactionCalls, [{ sessionID: 'ses_1', triggerFrameID: 'msg_1' }]);
  assert.deepEqual(frames.map((frame) => frame.type), [ 'UserMessage', 'CompactionFrame' ]);
  assert.equal(frames[1].content.status, 'running');
});

async function routeInviteMessage(text, expectedReference, options = {}) {
  let aeordb = createClient();
  let pluginRegistry = new PluginRegistry({ logger: quietLogger() });
  let commandRegistry = new CommandRegistry({ logger: quietLogger() });
  let router = new FrameRouter({ logger: quietLogger() });
  let agentRoutes = [];

  class AgentRoutePlugin {
    constructor(context = {}) {
      this.context = context;
    }

    async process(next) {
      agentRoutes.push(this.context.newFrame.id);
      await next(this.context);
    }
  }

  let agentManager = {
    async resolveAgent(reference) {
      assert.equal(reference, expectedReference);
      return { id: 'agent_1', name: expectedReference };
    },
  };
  let ids = [ 'ses_1', 'int_1', 'msg_1', 'commit_1', 'cmd_1', 'commit_2' ];
  let runtime;
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
  pluginRegistry.registerSelector('Type:UserMessage', AgentRoutePlugin, 'agent');
  router.loadFromRegistry(pluginRegistry);

  runtime = new FrameRuntime({
    aeordb,
    frameRouter: router,
    services: { context },
    clock: () => 1000,
    idGenerator: () => ids.shift(),
  });

  await runtime.createSession({ title: 'Scratch' });
  await runtime.appendUserMessage('ses_1', { text, userID: 'usr_1' });
  if (!options.skipPostAppendWait) {
    await tick();
    await tick();
    await runtime.frameStore.flush();
  }

  let session = await aeordb.getFile('/kikx/sessions/ses_1/session.json');
  let frames = await runtime.listFrames('ses_1');

  return {
    agentRoutes,
    frames,
    session,
    savedFramePaths: aeordb.calls
      .filter((call) => call.method === 'putFile' && call.path.includes('/frames/'))
      .map((call) => call.path),
  };
}

test('FrameRuntime rejects invalid session and message inputs', async () => {
  let runtime = createRuntime();

  await assert.rejects(
    () => runtime.createSession({ title: '' }),
    /title must be a non-empty string/,
  );

  await runtime.createSession({ title: 'Scratch' });

  await assert.rejects(
    () => runtime.appendUserMessage('missing', { text: 'hello' }),
    /Unknown session/,
  );

  await assert.rejects(
    () => runtime.appendUserMessage('ses_1', { text: '   ' }),
    /text must be a non-empty string/,
  );

  await assert.rejects(
    () => runtime.updateSession('missing', { title: 'New title' }),
    /Unknown session/,
  );

  await assert.rejects(
    () => runtime.updateSession('ses_1', { title: '   ' }),
    /title must be a non-empty string/,
  );
});

test('FrameRuntime surfaces AeorDB persistence failures', async () => {
  let aeordb = createClient({ failPut: 'disk is gone' });
  let runtime = createRuntime({ aeordb, ids: [ 'ses_1' ] });

  await assert.rejects(
    () => runtime.createSession({ title: 'Scratch' }),
    /disk is gone/,
  );
});

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

function createIDGenerator(ids = []) {
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
