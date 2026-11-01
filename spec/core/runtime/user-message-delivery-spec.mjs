'use strict';

// Delivery status for a message a person typed.
//
// The feature is one stored key (`content.delivery`) with two values and one
// transition. What makes it worth a spec is that every wrong implementation
// still *looks* right: `content.status = 'complete'` also "works" until you
// notice it durably closes the frame, and marking on route-entry instead of
// pre-provider also "works" until a cancelled turn claims delivery. The
// negatives below are the point of the file.

import assert from 'node:assert/strict';
import test from 'node:test';

import { FrameRuntime } from '../../../src/core/runtime/frame-runtime.mjs';
import { frameToModelTurn } from '../../../src/core/plugins/agent-model-context.mjs';

function createFrameStore() {
  let sessions = new Map();
  let framesBySession = new Map();
  let bucketFor = (sessionID) => {
    if (!framesBySession.has(sessionID))
      framesBySession.set(sessionID, new Map());
    return framesBySession.get(sessionID);
  };

  return {
    async saveSession(session) { sessions.set(session.id, clone(session)); },
    async saveSessionManifest(session) { sessions.set(session.id, clone(session)); },
    async loadSession(sessionID) { return sessions.has(sessionID) ? clone(sessions.get(sessionID)) : null; },
    async listSessions() { return [ ...sessions.values() ].map(clone); },
    async listFrames(sessionID) { return [ ...bucketFor(sessionID).values() ].map(clone); },
    async listScheduledFrames() { return []; },
    // `findRawFrame` reads this when a frame has aged out of the live engine.
    async listFrameWindow(sessionID, options = {}) {
      let frames = [ ...bucketFor(sessionID).values() ].map(clone);
      let start = frames.findIndex((frame) => frame.id === options.start);
      if (start < 0)
        return { frames: [] };
      return { frames: frames.slice(start, start + (options.limit || frames.length)) };
    },
    async flush() {},
    async ensureIndexConfigs() {},
    connect(engine, options = {}) {
      let bucket = bucketFor(options.sessionID);
      let handler = ({ frames }) => {
        for (let frame of frames || [])
          bucket.set(frame.id, clone(frame));
      };
      engine.on('commit', handler);
      return () => engine.off('commit', handler);
    },
  };
}

function createRuntime() {
  let index = 0;
  return new FrameRuntime({
    frameStore: createFrameStore(),
    clock: () => 1000 + index,
    idGenerator: () => `id_${++index}`,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  });
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

async function seeded(overrides = {}) {
  let runtime = createRuntime();
  await runtime.createSession({ id: 'ses_1', title: 'Delivery' });
  let entry = await runtime.ensureSessionEntry('ses_1');
  let frame = {
    id: 'msg_1',
    type: 'UserMessage',
    sessionID: 'ses_1',
    authorType: 'user',
    authorID: 'usr_1',
    hidden: false,
    deleted: false,
    timestamp: 1,
    createdAt: 1,
    updatedAt: 1,
    content: { text: 'Please implement it.', delivery: 'neutral' },
    ...overrides,
  };
  entry.frameEngine.merge([ frame ], { authorType: 'user', authorID: 'usr_1' });
  return { runtime, entry, frame };
}

test('a newly appended user message starts neutral', async () => {
  let runtime = createRuntime();
  await runtime.createSession({ id: 'ses_1', title: 'Delivery' });
  // #appendFrame returns an envelope, not a bare frame.
  let { frame } = await runtime.appendUserMessage('ses_1', { text: 'hello there' });

  assert.equal(frame.type, 'UserMessage');
  assert.equal(frame.content.delivery, 'neutral');
  assert.equal(frame.content.deliveryAt, undefined);
});

test('a caller cannot assert delivery through input.content', async () => {
  // If `input.content.delivery` were honoured, any append path could claim the
  // agent received a message no agent ever saw.
  let runtime = createRuntime();
  await runtime.createSession({ id: 'ses_1', title: 'Delivery' });
  let { frame } = await runtime.appendUserMessage('ses_1', {
    text: 'hello there',
    content: { delivery: 'received', deliveryAt: 1 },
  });

  assert.equal(frame.content.delivery, 'neutral');
  assert.equal(frame.content.deliveryAt, undefined);
});

test('a non-UserMessage frame type is never given a delivery state', async () => {
  // The content builder serves every appended frame type, and a transport
  // message is written under its own registered type. Owner scope: delivery is
  // a promise about a message this person typed here, so transport frames must
  // stay untouched.
  let runtime = createRuntime();
  await runtime.createSession({ id: 'ses_1', title: 'Delivery' });
  // A registered built-in type; an unregistered name throws by design.
  let { frame } = await runtime.appendFrame('ses_1', { type: 'AgentMessage', text: 'hello' });

  assert.equal(frame.type, 'AgentMessage');
  assert.equal(frame.content.delivery, undefined);
});

test('marking delivery moves neutral to received exactly once', async () => {
  let { runtime } = await seeded();
  let merged = await runtime.markFrameDelivered('ses_1', 'msg_1');

  assert.equal(merged.content.delivery, 'received');
  assert.ok(Number.isFinite(merged.content.deliveryAt));
  // The person's text is untouched: this is a status write, not an edit.
  assert.equal(merged.content.text, 'Please implement it.');
});

test('marking delivery is idempotent, so a retry cannot emit a second commit', async () => {
  let { runtime, entry } = await seeded();
  let commits = [];
  entry.frameEngine.on('commit', ({ frames }) => {
    for (let frame of frames || [])
      commits.push(frame.id);
  });

  let first = await runtime.markFrameDelivered('ses_1', 'msg_1');
  let second = await runtime.markFrameDelivered('ses_1', 'msg_1');

  assert.equal(first.content.deliveryAt, second.content.deliveryAt);
  assert.equal(commits.filter((id) => id === 'msg_1').length, 1);
});

test('hidden, deleted, non-user and agent-authored frames are never marked', async () => {
  // A coordination wake is persisted as a hidden UserMessage; a transport
  // message is written under its own registered type. Neither is a moment where
  // a person's own message reached an agent.
  let cases = [
    { hidden: true },
    { deleted: true },
    { type: 'AgentMessage' },
    { authorType: 'agent' },
  ];

  for (let overrides of cases) {
    let { runtime } = await seeded(overrides);
    let merged = await runtime.markFrameDelivered('ses_1', 'msg_1');
    assert.equal(merged, null, `expected null for ${JSON.stringify(overrides)}`);
  }
});

test('marking delivery does not close the frame lifecycle', async () => {
  // The hazard this guards: `content.status = 'complete'` is in
  // TERMINAL_CONTENT_STATUSES (frame-engine.mjs:18-29), and
  // normalizeLifecycleState reads it on every merge, durably stamping
  // `state.lifecycle.status = 'closed'` on a message the person authored.
  let { runtime, entry } = await seeded();
  let merged = await runtime.markFrameDelivered('ses_1', 'msg_1');
  let stored = entry.frameEngine.get('msg_1');

  assert.equal(stored.state?.lifecycle?.status ?? null, null);
  assert.equal(merged.state?.lifecycle?.status ?? null, null);
  assert.equal(stored.content.status, undefined);
});

test('the negative control: writing content.status does close the lifecycle', async () => {
  // Without this, the guard above would pass even if the normalizer were never
  // consulted at all. Same fixture, one different key.
  let { entry } = await seeded();
  // Full frame required: `merge()` silently skips any input lacking `type`
  // (frame-engine.mjs:71-72). A control without it changes nothing and would
  // "pass" while proving the opposite of what it claims.
  entry.frameEngine.merge([ {
    id: 'msg_1',
    type: 'UserMessage',
    sessionID: 'ses_1',
    authorType: 'user',
    authorID: 'usr_1',
    content: { status: 'complete' },
  } ], {
    authorType: 'user',
    authorID: 'usr_1',
  });
  let stored = entry.frameEngine.get('msg_1');

  assert.equal(stored.state?.lifecycle?.status, 'closed');
  assert.equal(stored.state?.lifecycle?.reason, 'complete');
});

test('the delivery vocabulary does not leak into the generic frame status', async () => {
  // `success` already means "this tool step succeeded". If `frameStatus()` ever
  // reports success for a delivered message, the bubble claims a tool result.
  let { frameStatus } = await import('../../../src/client/components/tool-frame-summary.mjs');
  let { runtime } = await seeded();
  let merged = await runtime.markFrameDelivered('ses_1', 'msg_1');

  assert.notEqual(frameStatus(merged), 'success');
  assert.equal(merged.content.status, undefined);
});

test('delivery is display-only: the model turn is byte-identical', async () => {
  let plain = {
    id: 'msg_x',
    type: 'UserMessage',
    authorType: 'user',
    content: { text: 'hello there', delivery: 'neutral' },
  };
  let delivered = {
    ...plain,
    content: { text: 'hello there', delivery: 'received', deliveryAt: 1234 },
  };

  assert.deepEqual(frameToModelTurn(delivered), frameToModelTurn(plain));
});

test('a silent delivery merge does not route the frame again', async () => {
  // `silent` is load-bearing (frame-router.mjs:41,56,171): a non-silent merge
  // would re-enter the router off the very message that started the turn.
  let routed = [];
  let runtime = createRuntime();
  runtime.frameRouter = {
    enqueueCommit(...args) { routed.push(args); },
    async flush() {},
  };
  await runtime.createSession({ id: 'ses_1', title: 'Delivery' });
  let entry = await runtime.ensureSessionEntry('ses_1');
  entry.frameEngine.merge([ {
    id: 'msg_1',
    type: 'UserMessage',
    sessionID: 'ses_1',
    authorType: 'user',
    authorID: 'usr_1',
    hidden: false,
    deleted: false,
    timestamp: 1,
    createdAt: 1,
    updatedAt: 1,
    content: { text: 'Please implement it.', delivery: 'neutral' },
  } ], { authorType: 'user', authorID: 'usr_1' });

  await runtime.markFrameDelivered('ses_1', 'msg_1');
  assert.equal(entry.frameEngine.get('msg_1').content.delivery, 'received');
  assert.equal(routed.length, 0);
});
