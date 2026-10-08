'use strict';

// P3-a: both the scheduled-frame wake dispatch and appendUserMessage() capture a
// session entry, then await (the router flush / cancelAutonomousWakes). Ordinary
// LRU pressure during that await can evict the runtime, detaching the captured
// engine so the later merge never reaches the store. These specs hold each await
// open, push a newer session through the cap, and assert the frame still
// persisted.

import assert from 'node:assert/strict';
import test from 'node:test';

import { FrameRuntime } from '../../../src/core/runtime/frame-runtime.mjs';

// A minimal in-memory frame store that persists committed frames and records
// whether eviction detached each engine's commit listener.
function createFrameStore() {
  let sessions = new Map();
  let framesBySession = new Map();
  let connections = [];

  let bucketFor = (sessionID) => {
    if (!framesBySession.has(sessionID))
      framesBySession.set(sessionID, new Map());

    return framesBySession.get(sessionID);
  };

  return {
    get connections() {
      return connections;
    },
    frames(sessionID) {
      return Array.from(bucketFor(sessionID).values());
    },
    async saveSession(session) {
      sessions.set(session.id, clone(session));
    },
    async saveSessionManifest(session) {
      sessions.set(session.id, clone(session));
    },
    async loadSession(sessionID) {
      let session = sessions.get(sessionID);
      return session ? clone(session) : null;
    },
    async listSessions() {
      return Array.from(sessions.values()).map(clone);
    },
    async listFrames(sessionID) {
      return Array.from(bucketFor(sessionID).values()).map(clone);
    },
    async listScheduledFrames() {
      return [];
    },
    async flush() {},
    async ensureIndexConfigs() {},
    connect(frameEngine, options = {}) {
      let sessionID = options.sessionID;
      let connection = { sessionID, frameEngine, disconnected: false };
      connections.push(connection);

      let handler = ({ frames }) => {
        let bucket = bucketFor(sessionID);
        for (let frame of frames || [])
          bucket.set(frame.id, clone(frame));
      };
      frameEngine.on('commit', handler);

      return () => {
        connection.disconnected = true;
        frameEngine.off('commit', handler);
      };
    },
  };
}

function createRuntime(store, options = {}) {
  let index = 0;
  return new FrameRuntime({
    frameStore: store,
    frameRouter: options.frameRouter || null,
    sessionRuntimeLimit: options.sessionRuntimeLimit ?? 1,
    clock: () => 1000 + index,
    idGenerator: () => `id_${++index}`,
    logger: quietLogger(),
  });
}

function quietLogger() {
  return { info() {}, warn() {}, error() {}, debug() {} };
}

function deferred() {
  let resolve;
  let promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function createGatedRouter() {
  let gate = deferred();
  let reached = deferred();
  return {
    enqueued: [],
    reached: reached.promise,
    connectTo() {
      return () => {};
    },
    enqueue(frameEngine, commit, session) {
      this.enqueued.push({ frameEngine, commit, session });
      reached.resolve();
    },
    flush() {
      return gate.promise;
    },
    release() {
      gate.resolve();
    },
  };
}

test('a scheduled wake is persisted as fired even if LRU pressure evicts the session while the router flushes', async () => {
  let store = createFrameStore();
  let router = createGatedRouter();
  let runtime = createRuntime(store, { frameRouter: router, sessionRuntimeLimit: 1 });
  let session = await runtime.createSession({ title: 'Timers' });

  let entry = await runtime.ensureSessionEntry(session.id);
  entry.frameEngine.merge([{
    id: 'wake_1',
    type: 'UserMessage',
    sessionID: session.id,
    authorType: 'system',
    authorID: 'test',
    scheduledAt: 1,
    scheduledStatus: 'pending',
    content: { text: 'wake up' },
  }], {
    authorType: 'system',
    authorID: 'test',
  });
  await runtime.frameStore.flush();
  assert.equal(runtime.scheduledFrames.entries.has('wake_1'), true, 'the pending wake must be tracked');

  let processing = runtime.processScheduledFrames();
  await router.reached;

  // While dispatch is parked on the router flush, a newer session pushes the
  // timer session over the one-entry cap. Without a pin it is detached here.
  await runtime.createSession({ title: 'Other' });

  router.release();
  await processing;

  let stored = store.frames(session.id).find((frame) => frame.id === 'wake_1');
  assert.equal(stored?.scheduledStatus, 'fired', 'the fired wake status must reach the store');
  assert.equal(stored?.scheduledFiredAt != null, true);
});

test('a user message append is persisted even if LRU pressure evicts the session during cancelAutonomousWakes', async () => {
  let store = createFrameStore();
  let runtime = createRuntime(store, { sessionRuntimeLimit: 1 });
  let session = await runtime.createSession({ title: 'Chat' });

  // Park appendUserMessage() on its cancelAutonomousWakes() await so the LRU
  // cap can be exercised in the middle of the method.
  let cancelGate = deferred();
  let cancelReached = deferred();
  runtime.cancelAutonomousWakes = async () => {
    cancelReached.resolve();
    await cancelGate.promise;
    return 0;
  };

  let appending = runtime.appendUserMessage(session.id, { text: 'hello' });
  await cancelReached.promise;

  await runtime.createSession({ title: 'Other' });

  cancelGate.resolve();
  let result = await appending;

  let stored = store.frames(session.id).find((frame) => frame.id === result.frame.id);
  assert.ok(stored, 'the user message must be persisted even though the session was under eviction pressure');
  assert.equal(stored.content.text, 'hello');
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
