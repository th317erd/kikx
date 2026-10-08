'use strict';

// P3-c: a cache miss opens the session with only the default frame window
// (1000). Hydrating that truncated window and then persisting a messageCount
// recomputed from it lowers the count of a large session (e.g. 5000 -> 1000).
// The window is not authoritative, so a partial window must never decrease the
// persisted count; a complete window still repairs a stale-low count upward.

import assert from 'node:assert/strict';
import test from 'node:test';

import { FrameRuntime } from '../../../src/core/runtime/frame-runtime.mjs';

function createFrameStore() {
  let sessions = new Map();
  let framesBySession = new Map();

  let bucketFor = (sessionID) => {
    if (!framesBySession.has(sessionID))
      framesBySession.set(sessionID, new Map());

    return framesBySession.get(sessionID);
  };

  return {
    seedSession(session) {
      sessions.set(session.id, clone(session));
    },
    seedFrames(sessionID, frames) {
      let bucket = bucketFor(sessionID);
      for (let frame of frames)
        bucket.set(frame.id, clone(frame));
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
    async listFrames(sessionID, options = {}) {
      let all = Array.from(bucketFor(sessionID).values())
        .sort((left, right) => (left.order || 0) - (right.order || 0));
      let limit = Number.isFinite(options.limit) ? options.limit : all.length;
      return all.slice(-limit).map(clone);
    },
    async listScheduledFrames() {
      return [];
    },
    async flush() {},
    async ensureIndexConfigs() {},
    connect(frameEngine, options = {}) {
      let sessionID = options.sessionID;
      let handler = ({ frames }) => {
        let bucket = bucketFor(sessionID);
        for (let frame of frames || [])
          bucket.set(frame.id, clone(frame));
      };
      frameEngine.on('commit', handler);

      return () => frameEngine.off('commit', handler);
    },
  };
}

function createRuntime(store) {
  let index = 0;
  return new FrameRuntime({
    frameStore: store,
    clock: () => 1000 + index,
    idGenerator: () => `id_${++index}`,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  });
}

function messageFrames(count, options = {}) {
  let startOrder = options.startOrder || 1;
  let sessionID = options.sessionID || 'big';
  let frames = [];
  for (let index = 0; index < count; index++) {
    let order = startOrder + index;
    frames.push({
      id: `msg_${order}`,
      type: 'UserMessage',
      sessionID,
      interactionID: `int_${order}`,
      authorType: 'user',
      authorID: 'user_1',
      order,
      timestamp: order,
      createdAt: order,
      hidden: false,
      deleted: false,
      content: { text: `message ${order}` },
    });
  }

  return frames;
}

test('opening a session with more frames than the default window does not lower its persisted messageCount', async () => {
  let store = createFrameStore();
  store.seedSession({ id: 'big', title: 'Big', messageCount: 5000, updatedAt: 1 });
  store.seedFrames('big', messageFrames(1005));

  let runtime = createRuntime(store);
  let entry = await runtime.ensureSessionEntry('big');
  await tick();
  await tick();

  assert.equal(entry.session.messageCount, 5000, 'the in-memory manifest must not be lowered by a partial window');
  let manifest = await store.loadSession('big');
  assert.equal(manifest.messageCount, 5000, 'the persisted manifest must not be lowered by a partial window');
});

test('a complete window still repairs a stale-low persisted messageCount', async () => {
  let store = createFrameStore();
  store.seedSession({ id: 'small', title: 'Small', messageCount: 0, updatedAt: 1 });
  store.seedFrames('small', messageFrames(3, { sessionID: 'small' }));

  let runtime = createRuntime(store);
  let entry = await runtime.ensureSessionEntry('small');
  await tick();
  await tick();

  assert.equal(entry.session.messageCount, 3, 'a full window is authoritative and repairs the count upward');
  let manifest = await store.loadSession('small');
  assert.equal(manifest.messageCount, 3);
});

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
