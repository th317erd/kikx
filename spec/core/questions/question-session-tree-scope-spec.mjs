'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { QuestionsStore } from '../../../src/core/questions/index.mjs';
import { queryQuestions } from '../../../src/core/questions/question-query.mjs';

// A THREE-LEVEL tree plus a sibling and an unrelated root. Single- and
// two-level fixtures both pass on the broken code because the bug collapses a
// tree-scoped read to exactly the session named; only a grandchild proves the
// walk actually descends.
//
//   root
//   ├── childA
//   │   └── grandchildA
//   └── childB            (sibling of childA — must stay invisible to childA)
//   unrelated             (separate root — invisible to everyone above)
const SESSIONS = [
  { id: 'root', parentSessionID: null },
  { id: 'childA', parentSessionID: 'root' },
  { id: 'grandchildA', parentSessionID: 'childA' },
  { id: 'childB', parentSessionID: 'root' },
  { id: 'unrelated', parentSessionID: null },
];

const QUESTION_IDS = [ 'q_root', 'q_childA', 'q_grandchildA', 'q_childB', 'q_unrelated' ];
const GROUP_IDS = [ 'g_root', 'g_childA', 'g_grandchildA', 'g_childB', 'g_unrelated' ];

function createLister(sessions = SESSIONS) {
  return {
    calls: 0,
    async listSessions() {
      this.calls++;
      return sessions.map((session) => ({ ...session }));
    },
  };
}

function createClient() {
  return {
    files: new Map(),
    async getFile(path) {
      if (!this.files.has(path)) {
        let error = new Error('Not found');
        error.status = 404;
        throw error;
      }

      return this.files.get(path);
    },
    async putFile(path, body) {
      this.files.set(path, JSON.parse(JSON.stringify(body)));
      return { path };
    },
    async deleteFile(path) {
      this.files.delete(path);
      return { path };
    },
    async list(path, options = {}) {
      let prefix = path.endsWith('/') ? path : `${path}/`;
      let glob = options.glob || null;
      let pattern = glob ? new RegExp(`^${glob.replace(/\./g, '\\.').replace(/\*/g, '[^/]*')}$`) : null;
      let items = [];

      for (let key of this.files.keys()) {
        if (!key.startsWith(prefix))
          continue;

        let rest = key.slice(prefix.length);
        if (rest.includes('/'))
          continue;

        if (pattern && !pattern.test(rest))
          continue;

        items.push({ path: key });
      }

      return { items, total: items.length, hasMore: false };
    },
  };
}

/**
 * Seed one open question per session through the real write path, so the open
 * index the read path consumes is the real one rather than a hand-written
 * fixture that could drift from the store's own shape.
 */
async function seedTree({ sessionLister } = {}) {
  let aeordb = createClient();
  let ids = [
    GROUP_IDS[0], QUESTION_IDS[0],
    GROUP_IDS[1], QUESTION_IDS[1],
    GROUP_IDS[2], QUESTION_IDS[2],
    GROUP_IDS[3], QUESTION_IDS[3],
    GROUP_IDS[4], QUESTION_IDS[4],
  ];
  let queue = [ ...ids ];
  let now = 1000;
  let options = {
    aeordb,
    clock: () => now++,
    idGenerator: () => {
      let next = queue.shift();
      if (!next)
        throw new Error('idGenerator exhausted');

      return next;
    },
  };

  if (sessionLister)
    options.sessionLister = sessionLister;

  let store = new QuestionsStore(options);

  let pairs = [
    [ 'root', QUESTION_IDS[0] ],
    [ 'childA', QUESTION_IDS[1] ],
    [ 'grandchildA', QUESTION_IDS[2] ],
    [ 'childB', QUESTION_IDS[3] ],
    [ 'unrelated', QUESTION_IDS[4] ],
  ];

  for (let [ sessionID, text ] of pairs) {
    await store.createQuestions({
      questions: [ { text: `Question from ${sessionID}?` } ],
      mode: 'wait',
      sessionID,
      agentID: `agent_${sessionID}`,
    });
  }

  return { store, aeordb };
}

function sessionIDsOf(result) {
  return [ ...new Set(result.summaries.map((summary) => summary.sessionID)) ].sort();
}

async function visibleIDs(store, filters) {
  let result = await store.listOpen(filters);
  return result.summaries.map((summary) => summary.id).sort();
}

test('an ancestor three levels up sees a grandchild question, and nothing from a sibling or unrelated session', async () => {
  let lister = createLister();
  let { store } = await seedTree({ sessionLister: lister });

  let visible = await visibleIDs(store, { rootSessionID: 'root', includeDescendants: true });

  // Root is two levels above grandchildA. On the broken code this array is
  // `[ 'q_root' ]` — the grandchild is invisible from its own grandparent,
  // which is the exact failure that lost the owner's two live decisions.
  assert.deepEqual(visible, [ 'q_childA', 'q_childB', 'q_grandchildA', 'q_root' ]);
  assert.equal(lister.calls > 0, true, 'the tree walk must actually consult the session lister');
});

test('a sibling subtree never sees the other branch, even though both hang off the same root', async () => {
  let { store } = await seedTree({ sessionLister: createLister() });

  let visible = await visibleIDs(store, { rootSessionID: 'childB', includeDescendants: true });

  assert.deepEqual(visible, [ 'q_childB' ]);
});

test('an unrelated root sees only itself', async () => {
  let { store } = await seedTree({ sessionLister: createLister() });

  let visible = await visibleIDs(store, { rootSessionID: 'unrelated', includeDescendants: true });

  assert.deepEqual(visible, [ 'q_unrelated' ]);
});

test('without includeDescendants a session still sees only its own questions', async () => {
  let { store } = await seedTree({ sessionLister: createLister() });

  let visible = await visibleIDs(store, { sessionID: 'root' });

  assert.deepEqual(visible, [ 'q_root' ]);
});

test('listVisibleQuestions walks root -> child -> grandchild and reports every visible session', async () => {
  let { store } = await seedTree({ sessionLister: createLister() });

  let result = await store.listVisibleQuestions({ sessionID: 'root' });

  assert.deepEqual([ ...result.sessionIDs ].sort(), [ 'childA', 'childB', 'grandchildA', 'root' ]);
  assert.equal(result.total, 4);
  assert.deepEqual(result.questions.map((question) => question.id).sort(), [
    'q_childA', 'q_childB', 'q_grandchildA', 'q_root',
  ]);
});

test('a store with no way to enumerate sessions throws instead of answering as if the tree were empty', async () => {
  // No sessionLister and the db client has no frameStore: this is precisely the
  // production wiring that shipped. Returning `[]` here is what turned "I
  // cannot see the tree" into the false claim "the tree has no descendants".
  let aeordb = createClient();
  let store = new QuestionsStore({ aeordb });

  await assert.rejects(
    () => store.listOpen({ rootSessionID: 'root', includeDescendants: true }),
    (error) => {
      assert.equal(error.name, 'SessionTreeUnavailableError');
      assert.match(error.message, /session tree/i);
      return true;
    },
  );

  // Exception, deliberately: this path is a precondition on the caller's OWN
  // session, where "self only" is a correct (strictly narrower) answer even
  // without the wider tree. Throwing here would stop questions being asked at
  // all. What must NOT happen is degrading silently, so the narrowing is
  // reported on the response instead of being invisible.
  let visible = await store.listVisibleQuestions({ sessionID: 'root' });
  assert.deepEqual(visible.sessionIDs, [ 'root' ]);
  assert.equal(visible.sessionTreeWarning?.code, 'SESSION_TREE_UNAVAILABLE');
  assert.equal(visible.sessionTreeWarning?.reason, 'not-wired');
  assert.match(visible.sessionTreeWarning?.message, /session tree/i);
});

test('listVisibleQuestions reports a read tree as a null warning, so the warning field means something', async () => {
  let { store } = await seedTree({ sessionLister: createLister() });

  let result = await store.listVisibleQuestions({ sessionID: 'root' });

  // Without this, a permanently-null field would be indistinguishable from a
  // healthy read and the warning would rot into decoration.
  assert.equal(result.sessionTreeWarning, null);
  assert.deepEqual([ ...result.sessionIDs ].sort(), [ 'childA', 'childB', 'grandchildA', 'root' ]);
});

test('a tree that fails to list is also reported as a warning rather than an empty set', async () => {
  let { store } = await seedTree({
    sessionLister: {
      async listSessions() {
        throw new Error('session index is corrupt');
      },
    },
  });

  let visible = await store.listVisibleQuestions({ sessionID: 'root' });
  assert.deepEqual(visible.sessionIDs, [ 'root' ]);
  assert.equal(visible.sessionTreeWarning?.reason, 'list-failed');
});

test('a lister that throws is surfaced, not swallowed into an empty tree', async () => {
  let { store } = await seedTree({
    sessionLister: {
      async listSessions() {
        throw new Error('session index is corrupt');
      },
    },
  });

  await assert.rejects(
    () => store.listOpen({ rootSessionID: 'root', includeDescendants: true }),
    /session index is corrupt|session tree/i,
  );
});

test('scope=all enumerates every session, including the grandchild and the unrelated root', async () => {
  let { store } = await seedTree({ sessionLister: createLister() });

  let result = await queryQuestions(store, { scope: 'all', status: 'open' });

  assert.deepEqual([ ...result.sessionIDs ].sort(), [
    'childA', 'childB', 'grandchildA', 'root', 'unrelated',
  ]);
  assert.equal(result.total, 5);
  assert.deepEqual(result.questions.map((question) => question.id).sort(), [
    'q_childA', 'q_childB', 'q_grandchildA', 'q_root', 'q_unrelated',
  ]);
});

test('scope=tree from the root includes the grandchild but excludes the sibling branch', async () => {
  let { store } = await seedTree({ sessionLister: createLister() });

  let result = await queryQuestions(store, { scope: 'tree', sessionID: 'childA', status: 'open' });

  assert.deepEqual([ ...result.sessionIDs ].sort(), [ 'childA', 'grandchildA' ]);
  assert.deepEqual(result.questions.map((question) => question.id).sort(), [
    'q_childA', 'q_grandchildA',
  ]);
});

test('session resolution is lazy, so a store built before the runtime exists still sees the tree', async () => {
  // This is the reason the wiring is a resolver function rather than a captured
  // instance. create-server.mjs sets questionsStore BEFORE frameRuntime, so a
  // store that snapshotted the runtime at construction would hold undefined
  // forever and quietly reproduce the original bug.
  let aeordb = createClient();
  let services = new Map();
  let store = new QuestionsStore({
    aeordb,
    // Stands in for context.get('frameRuntime'): undefined until it is set.
    sessionLister: () => services.get('frameRuntime'),
    idGenerator: () => 'q_root',
  });

  await store.createQuestions({
    questions: [ { text: 'Question from root?' } ],
    mode: 'wait',
    sessionID: 'root',
    agentID: 'agent_root',
  });

  // Before the runtime is registered the store must refuse rather than pretend
  // the tree is empty.
  await assert.rejects(
    () => store.listOpen({ rootSessionID: 'root', includeDescendants: true }),
    (error) => error.name === 'SessionTreeUnavailableError',
  );

  // Registering it afterwards is enough: no reconstruction, no restart.
  services.set('frameRuntime', createLister());

  let visible = await visibleIDs(store, { rootSessionID: 'root', includeDescendants: true });
  assert.deepEqual(visible, [ 'q_root' ]);
});

test('scope=session needs no session tree at all', async () => {
  // Guard, not a bug detector: naming one session must not depend on the tree.
  // This holds before and after the fix, and it protects the reordering that
  // lets the tree walk throw for tree scopes without breaking session scope.
  let { store } = await seedTree();

  let result = await queryQuestions(store, { scope: 'session', sessionID: 'grandchildA', status: 'open' });

  assert.deepEqual(result.questions.map((question) => question.id), [ 'q_grandchildA' ]);
});
