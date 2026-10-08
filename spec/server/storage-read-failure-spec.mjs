'use strict';

// S4: storage read failures. A failing AeorDB read must surface as a 500 JSON
// error (never a hang or a partial 200), and at the runtime layer a failed
// hydration must not leave a broken session entry cached.

import assert from 'node:assert/strict';
import test from 'node:test';

import { AppContext } from '../../src/core/app/app-context.mjs';
import { FrameRuntime } from '../../src/core/runtime/frame-runtime.mjs';
import { createServer } from '../../src/server/create-server.mjs';

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
    server.close((error) => error ? reject(error) : resolve());
  });
}

function createRuntime(overrides = {}) {
  return {
    async listSessions() {
      throw new Error('session storage unavailable');
    },
    async listFrameWindow() {
      throw new Error('frame storage unavailable');
    },
    async listFrames() {
      throw new Error('frame storage unavailable');
    },
    ...overrides,
  };
}

test('a failing frame read is reported as a 500 JSON error', async () => {
  let server = await createServer({ context: new AppContext({ aeordb: {}, frameRuntime: createRuntime() }) });
  let baseURL = await listen(server);

  try {
    let response = await fetch(`${baseURL}/api/v1/sessions/ses_1/frames`);
    let body = await response.json();

    assert.equal(response.status, 500);
    assert.deepEqual(body, { error: { message: 'frame storage unavailable' } });
  } finally {
    await close(server);
  }
});

test('a failing legacy offset frame read is reported as a 500 JSON error', async () => {
  let server = await createServer({ context: new AppContext({ aeordb: {}, frameRuntime: createRuntime() }) });
  let baseURL = await listen(server);

  try {
    let response = await fetch(`${baseURL}/api/v1/sessions/ses_1/frames?offset=0&limit=25`);
    assert.equal(response.status, 500);
    assert.equal((await response.json()).error.message, 'frame storage unavailable');
  } finally {
    await close(server);
  }
});

test('a failing session list is reported as a 500 and does not poison later reads', async () => {
  let failing = true;
  let runtime = createRuntime({
    async listSessions() {
      if (failing)
        throw new Error('session storage unavailable');
      return [ { id: 'ses_1', title: 'Recovered' } ];
    },
  });
  let server = await createServer({ context: new AppContext({ aeordb: {}, frameRuntime: runtime }) });
  let baseURL = await listen(server);

  try {
    let failed = await fetch(`${baseURL}/api/v1/sessions`);
    assert.equal(failed.status, 500);
    assert.equal((await failed.json()).error.message, 'session storage unavailable');

    failing = false;
    let recovered = await fetch(`${baseURL}/api/v1/sessions`);
    assert.equal(recovered.status, 200);
    assert.deepEqual((await recovered.json()).data.sessions, [ { id: 'ses_1', title: 'Recovered' } ]);
  } finally {
    await close(server);
  }
});

function createFrameStore() {
  return {
    failListFrames: true,
    sessions: new Map([ [ 'ses_1', { id: 'ses_1', title: 'One', messageCount: 0 } ] ]),
    async loadSession(sessionID) {
      return this.sessions.get(sessionID) || null;
    },
    async listFrames() {
      if (this.failListFrames)
        throw new Error('storage read failed');

      return [ { id: 'f1', type: 'UserMessage', content: { text: 'hi' } } ];
    },
    connect() {
      return () => {};
    },
    async saveSession() {},
    async saveSessionManifest() {},
    async flush() {},
  };
}

test('a failed hydration does not cache a broken session entry, and a retry succeeds', async () => {
  let store = createFrameStore();
  let runtime = new FrameRuntime({
    frameStore: store,
    clock: () => 1000,
    idGenerator: () => 'generated',
  });

  await assert.rejects(() => runtime.ensureSessionEntry('ses_1'), /storage read failed/);
  assert.equal(runtime.sessions.has('ses_1'), false, 'a partially hydrated entry must not be cached');

  store.failListFrames = false;
  let entry = await runtime.ensureSessionEntry('ses_1');
  assert.equal(entry.session.id, 'ses_1');
  assert.equal(entry.framesLoaded, true);
  assert.equal(entry.frameEngine.get('f1')?.id, 'f1');
});

test('a failed frame-window reload keeps the previously loaded entry usable', async () => {
  let store = createFrameStore();
  store.failListFrames = false;
  let runtime = new FrameRuntime({
    frameStore: store,
    clock: () => 1000,
    idGenerator: () => 'generated',
  });

  let first = await runtime.ensureSessionEntry('ses_1', { frameLimit: 10 });
  assert.equal(first.framesLoaded, true);
  assert.equal(first.framesLoadedLimit, 10);

  store.failListFrames = true;
  await assert.rejects(() => runtime.ensureSessionEntry('ses_1', { frameLimit: 20 }), /storage read failed/);

  // The entry stays usable and still advertises its old, complete window so a
  // later retry can load the wider one.
  let entry = runtime.sessions.get('ses_1');
  assert.equal(entry.framesLoaded, true);
  assert.equal(entry.framesLoadedLimit, 10);

  store.failListFrames = false;
  let reloaded = await runtime.ensureSessionEntry('ses_1', { frameLimit: 20 });
  assert.equal(reloaded.framesLoadedLimit, 20);
});
