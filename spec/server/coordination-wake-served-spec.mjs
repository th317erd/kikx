'use strict';

// Served-bytes proof for coordination-wake visibility.
//
// The unit specs prove the predicate, the card, and the filter chain in
// isolation. None of them prove that a real HTTP request to a real server,
// backed by the real FrameStore, actually returns the invite wake. That is the
// hop the owner's bug lived in: the text was stored, and the browser never
// received it.
//
// So this spec wires the production stack and nothing else:
//
//   createServer (src/server/create-server.mjs)         real
//   handleSessionRoutes -> GET /api/v1/sessions/:id/frames
//   FrameRuntime.listFrameWindow -> store.listFrameWindow   real
//   FrameStore + real serializers/normalizers           real
//
// The only substitute is AeorDB itself, replaced by an in-memory file map
// because no database runs in this spec lane. It implements the client surface
// FrameStore calls (putFile/getFile/fetchFiles/listDirectory), so the store code
// under test is the shipped code.
//
// What it pins:
//   - the invite wake appears in the served window JSON, with its text, and
//   - it still carries hidden:true (compaction/recovery semantics unchanged), and
//   - a hidden bookkeeping frame is still absent from the same response.

import assert from 'node:assert/strict';
import test from 'node:test';

import { AppContext } from '../../src/core/app/app-context.mjs';
import { FrameStore } from '../../src/core/aeordb/frame-store.mjs';
import { serializeFrame } from '../../src/core/aeordb/frame-store-serialization.mjs';
import { FrameRuntime } from '../../src/core/runtime/frame-runtime.mjs';
import { createServer } from '../../src/server/create-server.mjs';

delete process.env.KIKX_PLUGIN_PATHS;

const SESSION_ID = 'ses_visibility';
const INVITE_TEXT = 'You have been invited to "Bot message visibility" by Zav. '
  + 'Kikx-Node-Eng, review the session context now and wait for the coordinator\'s '
  + 'assignment before changing files.';

// In-memory stand-in for AeorDB's file API.
//
// Paths are hierarchical (`/kikx/sessions/<id>/...`), and listDirectory must
// answer with a `total`, because `listFrameWindow` uses the directory total to
// seek the tail rather than paging blindly. Getting `total` wrong here would
// make the window come back empty for a reason that has nothing to do with
// visibility, so the fake computes it from the real path set.
function createAeorDB() {
  let files = new Map();
  return {
    files,
    async putFile(path, body) {
      files.set(path, body);
      return { path };
    },
    async patchFile(path, body) {
      files.set(path, body);
      return { path };
    },
    async getFile(path) {
      return files.has(path) ? files.get(path) : null;
    },
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

      // AeorDB sorts by basename; frame filenames are zero-padded order
      // prefixes, so that is also chronological.
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

function inviteWake(id = 'wake_invite') {
  return {
    id,
    type: 'UserMessage',
    sessionID: SESSION_ID,
    interactionID: `int_${id}`,
    authorType: 'system',
    authorID: 'internal:session-invite',
    authorDisplayName: 'Kikx session invite',
    targetAgentID: 'agent_worker',
    hidden: true,
    deleted: false,
    scheduledAt: 3,
    scheduledStatus: 'fired',
    content: {
      text: INVITE_TEXT,
      status: 'scheduled',
      agentID: 'agent_worker',
      agentName: 'Kikx-Node-Eng',
      invite: true,
    },
  };
}

function bookkeepingWake(id = 'wake_recovery') {
  return {
    id,
    type: 'UserMessage',
    sessionID: SESSION_ID,
    interactionID: `int_${id}`,
    authorType: 'system',
    authorID: 'internal:runtime-recovery',
    targetAgentID: 'agent_worker',
    hidden: true,
    deleted: false,
    content: { text: 'Resume the interrupted turn.' },
  };
}

function ownerMessage(id = 'msg_owner') {
  return {
    id,
    type: 'UserMessage',
    sessionID: SESSION_ID,
    interactionID: `int_${id}`,
    authorType: 'user',
    authorID: 'user_owner',
    hidden: false,
    deleted: false,
    content: { text: 'Show me the messages between bots.' },
  };
}

// Seed the store directly, the way a committed wake is persisted: through
// FrameStore's own path helpers and serializer, so the on-disk shape under test
// is the shipped shape.
async function seed(store) {
  await store.saveSession({
    id: SESSION_ID,
    title: 'Bot message visibility',
    participantAgentIDs: [ 'agent_worker' ],
    coordinatorAgentID: 'agent_zav',
    messageCount: 3,
    createdAt: 1,
    updatedAt: 4,
  });

  let frames = [ ownerMessage(), inviteWake(), bookkeepingWake() ];
  for (let index = 0; index < frames.length; index++) {
    let frame = { ...frames[index], order: index + 1, createdAt: index + 1, updatedAt: index + 1 };
    let path = store.framePath(SESSION_ID, frame);
    // `serializeFrame` is a module-level export, NOT a FrameStore method: the
    // class only re-exports it. Calling `store.serializeFrame` therefore yielded
    // `undefined` and this spec used to persist the raw frame, which lacks the
    // `contentText`/`hiddenIndex` fields production writes. Use the shipped
    // serializer so the on-disk shape under test is the shape a real wake has.
    await store.aeordb.putFile(path, serializeFrame(SESSION_ID, frame));
  }
}

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
    if (!server.listening) {
      resolve();
      return;
    }

    server.close((error) => error ? reject(error) : resolve());
  });
}

async function startServer() {
  let aeordb = createAeorDB();
  let store = new FrameStore({ aeordb, rootPath: '/kikx' });
  await seed(store);

  let runtime = new FrameRuntime({
    frameStore: store,
    clock: () => 100,
    idGenerator: () => `gen_${Math.random().toString(16).slice(2)}`,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  });

  let server = await createServer({
    context: new AppContext({
      aeordb,
      db: aeordb,
      frameStore: store,
      frameRuntime: runtime,
    }),
  });

  return { server, baseURL: await listen(server), store };
}

test('GET frames serves the invite wake with its instruction, and still marks it hidden', async () => {
  let { server, baseURL } = await startServer();

  try {
    let response = await fetch(`${baseURL}/api/v1/sessions/${SESSION_ID}/frames?limit=50`);
    assert.equal(response.status, 200);

    let body = await response.json();
    let frames = body?.data?.frames;
    assert.ok(Array.isArray(frames), 'the window response must carry a frames array');

    let served = frames.find((frame) => frame.id === 'wake_invite');
    assert.ok(served, `the invite wake must be served; got ids: ${frames.map((frame) => frame.id).join(', ')}`);

    // The owner's complaint, directly: the instruction text is in the payload
    // the browser receives.
    assert.match(served.content.text, /You have been invited to "Bot message visibility" by Zav\./);
    assert.match(served.content.text, /review the session context now/);

    // Visibility is presentation only. Compaction and recovery read this flag,
    // so it must be untouched by the change that made the frame transportable.
    assert.equal(served.hidden, true);

    // The owner's own message is unaffected.
    assert.ok(frames.some((frame) => frame.id === 'msg_owner'));

    // The negative: hidden bookkeeping is still not served, so the widening did
    // not become "send every hidden frame to the browser".
    assert.equal(
      frames.some((frame) => frame.id === 'wake_recovery'),
      false,
      'a hidden non-wake frame must not be served',
    );
  } finally {
    await close(server);
  }
});

test('GET frames with filters serves the invite wake under the User row', async () => {
  let { server, baseURL } = await startServer();

  try {
    let response = await fetch(
      `${baseURL}/api/v1/sessions/${SESSION_ID}/frames?limit=50&f_user=1&f_agent=1&f_question=1&f_session=1&f_tools=1&f_commands=1&f_compaction=1`,
    );
    assert.equal(response.status, 200);

    let frames = (await response.json())?.data?.frames || [];
    assert.ok(
      frames.some((frame) => frame.id === 'wake_invite'),
      'the filtered window must include the invite wake, since it is filed under User',
    );

    // Unchecking User is a real instruction to hide it.
    let hiddenByFilter = await fetch(
      `${baseURL}/api/v1/sessions/${SESSION_ID}/frames?limit=50&f_user=0&f_agent=1&f_question=1&f_session=1&f_tools=1&f_commands=1&f_compaction=1`,
    );
    let filtered = (await hiddenByFilter.json())?.data?.frames || [];
    assert.equal(
      filtered.some((frame) => frame.id === 'wake_invite'),
      false,
      'with User unchecked the wake must be filtered out like any other User frame',
    );
  } finally {
    await close(server);
  }
});
