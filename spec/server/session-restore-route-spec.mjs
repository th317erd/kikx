'use strict';

// The "show deleted sessions" API: listing with includeDeleted=1 and the
// restore (undelete) route. Frames and the record stay put throughout — this is
// the server half of "we NEVER fully delete anything".

import assert from 'node:assert/strict';
import test from 'node:test';

import { AppContext } from '../../src/core/app/app-context.mjs';
import { createServer } from '../../src/server/create-server.mjs';
import { matchSessionRestoreRoute } from '../../src/server/routes/route-matchers.mjs';

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

// A frame runtime stub whose listSessions honours includeDeleted and whose
// updateSession honours deletedAt, mirroring FrameRuntime's contract.
function createRuntime() {
  let sessions = new Map([
    [ 'ses_live', { id: 'ses_live', title: 'Live', deletedAt: null } ],
    [ 'ses_gone', { id: 'ses_gone', title: 'Gone', deletedAt: 'stamp-1' } ],
  ]);
  return {
    events: [],
    on(type, handler) {
      if (type === 'event')
        this.events.push(handler);
    },
    emit(event) {
      for (let handler of this.events)
        handler(event);
    },
    async listSessions(options = {}) {
      let all = [ ...sessions.values() ];
      return options.includeDeleted === true ? all : all.filter((session) => !session.deletedAt);
    },
    async updateSession(sessionID, input = {}) {
      let session = sessions.get(sessionID);
      if (!session) {
        let error = new Error(`Unknown session: ${sessionID}`);
        error.status = 404;
        throw error;
      }

      if (Object.hasOwn(input, 'deletedAt'))
        session.deletedAt = input.deletedAt || null;
      if (Object.hasOwn(input, 'title'))
        session.title = input.title;

      this.emit({ type: 'session.saved', sessionID, session });
      return session;
    },
  };
}

test('matchSessionRestoreRoute matches only a bare id followed by /restore', () => {
  assert.deepEqual(matchSessionRestoreRoute('/api/v1/sessions/ses_1/restore'), { sessionID: 'ses_1' });
  assert.deepEqual(matchSessionRestoreRoute('/api/v1/sessions/a%2Fb/restore'), { sessionID: 'a/b' });
  assert.equal(matchSessionRestoreRoute('/api/v1/sessions/ses_1'), null);
  assert.equal(matchSessionRestoreRoute('/api/v1/sessions/ses_1/restore/extra'), null);
});

test('GET /api/v1/sessions hides deleted sessions by default', async () => {
  let server = await createServer({ context: new AppContext({ aeordb: {}, frameRuntime: createRuntime() }) });
  let baseURL = await listen(server);

  try {
    let response = await fetch(`${baseURL}/api/v1/sessions`);
    let body = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(body.data.sessions.map((session) => session.id), [ 'ses_live' ]);
  } finally {
    await close(server);
  }
});

test('GET /api/v1/sessions?includeDeleted=1 lists soft-deleted sessions too', async () => {
  let server = await createServer({ context: new AppContext({ aeordb: {}, frameRuntime: createRuntime() }) });
  let baseURL = await listen(server);

  try {
    let response = await fetch(`${baseURL}/api/v1/sessions?includeDeleted=1`);
    let body = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(body.data.sessions.map((session) => session.id).sort(), [ 'ses_gone', 'ses_live' ]);
    let gone = body.data.sessions.find((session) => session.id === 'ses_gone');
    assert.ok(gone.deletedAt, 'the deleted manifest carries its stamp');
  } finally {
    await close(server);
  }
});

test('POST /api/v1/sessions/:id/restore clears deletedAt and returns the session', async () => {
  let server = await createServer({ context: new AppContext({ aeordb: {}, frameRuntime: createRuntime() }) });
  let baseURL = await listen(server);

  try {
    let response = await fetch(`${baseURL}/api/v1/sessions/ses_gone/restore`, { method: 'POST' });
    let body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.data.session.id, 'ses_gone');
    assert.equal(body.data.session.deletedAt, null);

    // It is back in the default (undeleted) listing.
    let listed = await (await fetch(`${baseURL}/api/v1/sessions`)).json();
    assert.deepEqual(listed.data.sessions.map((session) => session.id).sort(), [ 'ses_gone', 'ses_live' ]);
  } finally {
    await close(server);
  }
});

test('restoring an unknown session is a 404', async () => {
  let server = await createServer({ context: new AppContext({ aeordb: {}, frameRuntime: createRuntime() }) });
  let baseURL = await listen(server);

  try {
    let response = await fetch(`${baseURL}/api/v1/sessions/nope/restore`, { method: 'POST' });
    assert.equal(response.status, 404);
  } finally {
    await close(server);
  }
});
