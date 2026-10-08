'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { FrameRuntime } from '../../src/core/runtime/frame-runtime.mjs';

// A minimal in-memory frame store that persists frames when the runtime's commit
// handler fires, so an evicted session can be rehydrated from storage exactly as
// AeorDBFrameStore rehydrates it. `connections` records every engine attachment
// and whether eviction detached it.
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
    sessionRuntimeLimit: options.sessionRuntimeLimit ?? 3,
    clock: () => 1000 + index,
    idGenerator: () => `id_${++index}`,
  });
}

test('FrameRuntime evicts least-recently-used session runtimes beyond the cap', async () => {
  let store = createFrameStore();
  let runtime = createRuntime(store, { sessionRuntimeLimit: 3 });
  let sessionIDs = [];

  for (let index = 0; index < 8; index++) {
    let session = await runtime.createSession({ title: `Session ${index}` });
    sessionIDs.push(session.id);
  }

  assert.ok(runtime.sessions.size <= 3, `expected <= 3 live runtimes, got ${runtime.sessions.size}`);
  assert.equal(runtime.sessions.has(sessionIDs[0]), false, 'the oldest runtime must be evicted');
  assert.equal(runtime.sessions.has(sessionIDs.at(-1)), true, 'the newest runtime must stay resident');
});

test('FrameRuntime eviction detaches engine listeners and the disconnect store', async () => {
  let store = createFrameStore();
  let runtime = createRuntime(store, { sessionRuntimeLimit: 2 });

  for (let index = 0; index < 5; index++)
    await runtime.createSession({ title: `Session ${index}` });

  let live = store.connections.filter((connection) => !connection.disconnected);
  let dead = store.connections.filter((connection) => connection.disconnected);

  assert.equal(live.length, 2);
  assert.equal(dead.length, 3);

  for (let connection of dead) {
    assert.equal(connection.frameEngine.listenerCount('commit'), 0, 'eviction must detach commit listeners');
    assert.equal(connection.frameEngine.listenerCount('frame:phantom'), 0, 'eviction must detach phantom listeners');
  }

  for (let connection of live) {
    // The runtime itself plus the frame store both listen for commits.
    assert.ok(connection.frameEngine.listenerCount('commit') >= 2);
    assert.equal(connection.frameEngine.listenerCount('frame:phantom'), 1);
  }
});

test('an evicted session rehydrates and still streams committed frames', async () => {
  let store = createFrameStore();
  let runtime = createRuntime(store, { sessionRuntimeLimit: 1 });
  let first = await runtime.createSession({ title: 'First' });
  await runtime.appendUserMessage(first.id, { text: 'hello' });
  await runtime.frameStore.flush();

  // Creating the second session is the access that evicts the first.
  let second = await runtime.createSession({ title: 'Second' });
  assert.equal(runtime.sessions.has(first.id), false);
  assert.equal(runtime.sessions.has(second.id), true);

  let events = [];
  runtime.on('event', (event) => events.push(event));

  let entry = await runtime.ensureSessionEntry(first.id);
  assert.equal(entry.session.id, first.id);
  assert.deepEqual(entry.frameEngine.toArray().map((frame) => frame.content?.text), [ 'hello' ]);

  let result = await runtime.appendUserMessage(first.id, { text: 'again' });
  assert.equal(result.frame.content.text, 'again');
  assert.equal(entry.frameEngine.get(result.frame.id).content.text, 'again');
  assert.ok(
    events.some((event) => event.type === 'frame.added' && event.sessionID === first.id && event.frame.id === result.frame.id),
    'a rehydrated session must emit its frame events like any live runtime',
  );
  assert.ok(store.frames(first.id).some((frame) => frame.content?.text === 'again'));
});

test('pinned runtimes are protected from eviction and released on unpin', async () => {
  let store = createFrameStore();
  let runtime = createRuntime(store, { sessionRuntimeLimit: 2 });
  let first = await runtime.createSession({ title: 'First' });
  runtime.pinSession(first.id);

  await runtime.createSession({ title: 'Second' });
  await runtime.createSession({ title: 'Third' });

  assert.equal(runtime.sessions.has(first.id), true, 'a pinned runtime must not be evicted');
  assert.equal(runtime.sessions.size, 2);

  runtime.unpinSession(first.id);
  let fourth = await runtime.createSession({ title: 'Fourth' });

  assert.equal(runtime.sessions.size <= 2, true);
  assert.equal(runtime.sessions.has(first.id), false, 'after unpin the runtime is evictable again');
  assert.equal(runtime.sessions.has(fourth.id), true);
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
