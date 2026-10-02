'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { createServer } from '../../src/server/create-server.mjs';
import { AppContext } from '../../src/core/app/app-context.mjs';

// P8 server route: POST /api/v1/sessions/:id/compaction/:frameID/retry. It
// resolves the live frame engine, calls `retryCompaction`, and returns the
// overwritten frame; an unknown frame is a 404 before any compaction runs.

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

function createFrameRuntime() {
  let calls = [];
  let knownFrames = new Map([
    [ 'cmp_1', { id: 'cmp_1', type: 'CompactionFrame', sessionID: 'ses_1', content: { status: 'complete' } } ],
  ]);
  let session = { id: 'ses_1', participantAgentIDs: [ 'agent_1' ] };
  let frameEngine = {
    get(frameID) {
      return knownFrames.get(frameID) || null;
    },
  };

  return {
    calls,
    requireSessionEntry(sessionID) {
      calls.push({ method: 'requireSessionEntry', sessionID });
      if (sessionID !== 'ses_1') {
        let error = new Error(`Unknown session: ${sessionID}`);
        error.status = 404;
        throw error;
      }

      return { session, frameEngine };
    },
    routerServices() {
      return { frameRuntime: this };
    },
  };
}

function createCompactionService() {
  let calls = [];
  return {
    calls,
    async retryCompaction(input) {
      calls.push(input);
      // Simulate overwrite-in-place: same frame id, new status.
      return {
        ...input.frameEngine.get(input.compactionFrameID),
        content: { status: 'complete', summary: 'retried' },
      };
    },
  };
}

test('POST /api/v1/sessions/:id/compaction/:frameID/retry returns the updated frame', async () => {
  let frameRuntime = createFrameRuntime();
  let compactionService = createCompactionService();
  let server = createServer({
    context: new AppContext({
      aeordb: {},
      frameRuntime,
      compactionService,
    }),
  });
  let baseURL = await listen(server);

  try {
    let response = await fetch(`${baseURL}/api/v1/sessions/ses_1/compaction/cmp_1/retry`, { method: 'POST' });
    let body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.data.frame.id, 'cmp_1');
    assert.equal(body.data.frame.content.summary, 'retried');
    assert.equal(compactionService.calls.length, 1);
    assert.equal(compactionService.calls[0].session.id, 'ses_1');
    assert.equal(compactionService.calls[0].compactionFrameID, 'cmp_1');
  } finally {
    await close(server);
  }
});

test('POST /api/v1/sessions/:id/compaction/:frameID/retry 404s an unknown frame', async () => {
  let frameRuntime = createFrameRuntime();
  let compactionService = createCompactionService();
  let server = createServer({
    context: new AppContext({
      aeordb: {},
      frameRuntime,
      compactionService,
    }),
  });
  let baseURL = await listen(server);

  try {
    let response = await fetch(`${baseURL}/api/v1/sessions/ses_1/compaction/missing/retry`, { method: 'POST' });
    let body = await response.json();

    assert.equal(response.status, 404);
    assert.match(body.error.message, /Unknown compaction frame: missing/);
    // The service must not have been called for an unknown frame.
    assert.deepEqual(compactionService.calls, []);
  } finally {
    await close(server);
  }
});

test('POST compaction retry 404s an unknown session before touching the frame', async () => {
  let frameRuntime = createFrameRuntime();
  let compactionService = createCompactionService();
  let server = createServer({
    context: new AppContext({
      aeordb: {},
      frameRuntime,
      compactionService,
    }),
  });
  let baseURL = await listen(server);

  try {
    let response = await fetch(`${baseURL}/api/v1/sessions/missing/compaction/cmp_1/retry`, { method: 'POST' });
    let body = await response.json();

    assert.equal(response.status, 404);
    assert.match(body.error.message, /Unknown session: missing/);
    assert.deepEqual(compactionService.calls, []);
  } finally {
    await close(server);
  }
});
