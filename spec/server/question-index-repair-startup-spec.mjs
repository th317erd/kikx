'use strict';

import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { AppContext } from '../../src/core/app/app-context.mjs';
import { QuestionsStore } from '../../src/core/questions/index.mjs';
import { createServer } from '../../src/server/create-server.mjs';

/**
 * Startup integration: the index repair must actually run during
 * `createServer()`, must be awaited by the readiness gate, and must never stop
 * a boot when it fails.
 *
 * These assertions are about the wiring, which unit specs cannot see: the
 * repair function itself is covered by question-index-repair-spec.mjs.
 */

// A db double that behaves like the production driver: in-memory documents plus
// the `list`/`listDirectory`/file verbs every store path uses.
function createMemoryDB(seed = {}) {
  let files = new Map(Object.entries(seed));

  return {
    files,
    async get(path) {
      return files.has(path) ? clone(files.get(path)) : null;
    },
    async put(path, body) {
      files.set(path, clone(body));
      return { path };
    },
    async delete(path) {
      files.delete(path);
      return { path };
    },
    async getFile(path) {
      if (!files.has(path))
        throw Object.assign(new Error(`missing ${path}`), { status: 404 });

      return clone(files.get(path));
    },
    async putFile(path, body) {
      files.set(path, clone(body));
      return { path };
    },
    async listDirectory(path, options = {}) {
      let prefix = path.endsWith('/') ? path : `${path}/`;
      let recursive = Number(options.depth) < 0;
      let glob = options.glob || null;
      let pattern = glob ? new RegExp(`^${glob.replace(/\./g, '\\.').replace(/\*/g, '[^/]*')}$`) : null;
      let items = [];

      for (let key of files.keys()) {
        if (!key.startsWith(prefix))
          continue;

        let rest = key.slice(prefix.length);
        if (!recursive && rest.includes('/'))
          continue;

        if (pattern && !pattern.test(rest.split('/').pop()))
          continue;

        items.push({ path: key });
      }

      return { items, total: items.length, hasMore: false };
    },
  };
}

function questionDoc(id, overrides = {}) {
  return {
    id,
    groupID: 'group_1',
    index: 1,
    status: 'open',
    mode: 'wait',
    sessionID: 'session_1',
    agentID: 'agent_1',
    interactionID: null,
    frameID: null,
    toolCallFrameID: null,
    toolOutputID: null,
    todoIDs: [],
    focusAtAsk: null,
    contextRefs: [],
    text: `Question ${id}?`,
    priority: 'normal',
    answer: null,
    answeredAt: null,
    answeredClock: null,
    answeredByUserID: null,
    answerFrameID: null,
    dismissalReason: null,
    askedAt: 1000,
    askedClock: null,
    createdAt: 1000,
    updatedAt: 1000,
    readAt: null,
    deleted: false,
    ...overrides,
  };
}

async function bootWith(db) {
  let warnings = [];
  let errors = [];
  let logger = {
    warn: (...args) => warnings.push(args.map(String).join(' ')),
    error: (...args) => errors.push(args.map(String).join(' ')),
    log: () => {},
    info: () => {},
    debug: () => {},
  };

  let context = new AppContext({
    db,
    questionsStore: new QuestionsStore({ db }),
    // Fixture-style: plugins are not loaded, so the runtime and routers come
    // from the defaults `createServer` already builds.
    pluginLoadPromise: Promise.resolve(),
  });

  let server = await createServer({ context, logger });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  return { server, context, logger, warnings, errors };
}

function closeServer(server) {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

test('startup repairs a corrupt open index before the server is ready', async () => {
  // Two questions exist as docs, but the index lost one of them — the exact
  // corruption that made a question permanently invisible to the Inbox.
  let db = createMemoryDB({
    '/kikx/questions/q_1.json': questionDoc('q_1'),
    '/kikx/questions/q_2.json': questionDoc('q_2', { index: 2 }),
    '/kikx/questions/index/open.json': {
      ids: [ 'q_1' ],
      summaries: [
        {
          id: 'q_1',
          groupID: 'group_1',
          index: 1,
          status: 'open',
          mode: 'wait',
          sessionID: 'session_1',
          agentID: 'agent_1',
          text: 'Question q_1?',
          priority: 'normal',
          askedAt: 1000,
          askedClock: null,
          readAt: null,
          contextRefs: [],
        },
      ],
      updatedAt: 1000,
    },
  });

  let { server, context, warnings } = await bootWith(db);

  try {
    let repair = await context.require('questionIndexRepairPromise');

    assert.equal(repair.repaired, 1, 'the missing id was restored at startup');
    assert.equal(context.get('startupReady'), true, 'readiness waited for the repair');

    let index = db.files.get('/kikx/questions/index/open.json');
    assert.deepEqual(index.ids.sort(), [ 'q_1', 'q_2' ], 'the index lists both questions again');

    let listed = await context.require('questionsStore').listOpen();
    assert.deepEqual(listed.ids.sort(), [ 'q_1', 'q_2' ]);

    assert.ok(
      warnings.some((line) => /repaired the ask-user question index/.test(line)),
      'a repair is logged, so it is observable in production',
    );
  } finally {
    await closeServer(server);
  }
});

test('startup leaves a healthy index alone', async () => {
  let db = createMemoryDB({
    '/kikx/questions/q_1.json': questionDoc('q_1'),
  });

  // The first boot has no index at all, so building one is a legitimate
  // repair — the no-churn property applies from the second boot onward.
  let { server, context } = await bootWith(db);
  let firstRepair = await context.require('questionIndexRepairPromise');
  await closeServer(server);

  assert.equal(firstRepair.repaired, 1, 'first boot builds the missing index');
  assert.ok(db.files.has('/kikx/questions/index/open.json'));

  let indexBefore = JSON.stringify(db.files.get('/kikx/questions/index/open.json'));
  let second = await bootWith(db);

  try {
    let repair = await second.context.require('questionIndexRepairPromise');

    assert.equal(repair.unchanged, true, 'second boot: nothing to repair');
    assert.equal(repair.repaired, 0);
    assert.equal(
      JSON.stringify(db.files.get('/kikx/questions/index/open.json')),
      indexBefore,
      'a healthy index is not rewritten on boot',
    );
  } finally {
    await closeServer(second.server);
  }
});

test('a repair failure is contained and does not block startup', async () => {
  let db = createMemoryDB({
    '/kikx/questions/q_1.json': questionDoc('q_1'),
  });

  // Make every scan throw: the repair must catch it, log, and let boot finish.
  db.listDirectory = async () => {
    throw new Error('db unavailable');
  };

  let { server, context, errors } = await bootWith(db);

  try {
    let repair = await context.require('questionIndexRepairPromise');

    assert.equal(repair.repaired, 0);
    assert.ok(repair.error, 'the failure is reported, not swallowed silently');
    assert.equal(context.get('startupReady'), true, 'readiness still flips');
    assert.ok(
      errors.some((line) => /ask-user index repair failed/.test(line)),
      'the failure is logged at error level',
    );

    // The server is genuinely serving, not merely constructed.
    let status = await getStatus(server);
    assert.equal(status, 200);
  } finally {
    await closeServer(server);
  }
});

function getStatus(server) {
  let { port } = server.address();

  return new Promise((resolve, reject) => {
    let request = http.get({ host: '127.0.0.1', port, path: '/health' }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });

    request.on('error', reject);
  });
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
