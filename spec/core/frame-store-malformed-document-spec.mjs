'use strict';

// Regression coverage for the "one bad document kills the page" defect.
//
// Observed on a real database: a filtered frame window
// (`?f_user=0&f_agent=0&f_question=0&f_session=1&f_tools=0&f_commands=0&f_compaction=0&limit=50`)
// answered HTTP 500 with
//
//   AeorDB multi-fetch returned non-JSON content for .../frames/00…-ShellToolFrame-….json:
//   Bad escaped character in JSON at position 5630
//
// because `readJSONFiles` parsed every document in the batch and re-threw on the
// first failure. One corrupt frame — the *body* was not even the frame the user
// was looking at — took the whole thread down, so the session could not be read
// at all. `limit=1` succeeded only because the poison frame was not on that page.
//
// Three invariants are asserted here:
//
//   1. A page containing a malformed document still returns every readable frame
//      on that page. Silence is not an acceptable substitute for a page, and
//      neither is a 500.
//   2. A document whose corruption has exactly one reading (`\$`, which is not a
//      JSON escape) is repaired and its frame recovered, because losing the user
//      content is worse than recovering it.
//   3. Corruption that cannot be repaired with certainty is not guessed at. It
//      surfaces as a visible load-error at the order its filename implies,
//      because a vanished message is worse than a visible error — and the client
//      already renders that type (`tool-frame-summary.mjs`).

import test from 'node:test';
import assert from 'node:assert/strict';

import { FrameStore } from '../../src/core/aeordb/frame-store.mjs';
import { readJSONFiles } from '../../src/core/aeordb/aeordb-file-utils.mjs';

// In-memory AeorDB. Unlike the shared harness, `fetchFiles` serves a designated
// `raw` body verbatim instead of re-JSON-encoding it, which is the only way the
// malformed bytes reach `JSON.parse` the way they do in the real store.
function createClient() {
  return {
    files: new Map(),
    async putFile(path, body) {
      this.files.set(path, body);
      return { path };
    },
    async getFile(path) {
      return this.files.get(path) || null;
    },
    async fetchFiles(paths) {
      let output = {};
      for (let path of paths) {
        if (!this.files.has(path))
          throw Object.assign(new Error(`missing: ${path}`), { status: 404 });

        let entry = this.files.get(path);
        let content = entry && entry.__raw != null ? entry.__raw : JSON.stringify(entry);
        output[path] = { path, content };
      }

      return output;
    },
    async listDirectory(path, options = {}) {
      let prefix = `${path.replace(/\/+$/g, '')}/`;
      let glob = options.glob || '';
      let items = [];

      for (let filePath of this.files.keys()) {
        if (!filePath.startsWith(prefix) || !filePath.endsWith('.json'))
          continue;
        if (glob === '**/frames/*.json' && !filePath.includes('/frames/'))
          continue;

        items.push({ path: filePath });
      }

      items.sort((left, right) => (
        left.path.split('/').pop().localeCompare(right.path.split('/').pop())
      ));

      let offset = options.offset || 0;
      let limit = options.limit == null ? items.length : options.limit;

      return { items: items.slice(offset, offset + limit), limit, offset, total: items.length };
    },
  };
}

function framePathFor(order, type, id) {
  return `/kikx/sessions/ses_1/interactions/int_1/frames/${String(order).padStart(16, '0')}-${encodeURIComponent(type)}-${encodeURIComponent(id)}.json`;
}

function addFrame(aeordb, order, type, extra = {}) {
  let id = extra.id || `f_${order}`;
  let frame = {
    id,
    type,
    order,
    interactionID: 'int_1',
    authorType: extra.authorType || (type === 'UserMessage' ? 'user' : 'agent'),
    content: extra.content || { text: `frame ${order}` },
  };

  aeordb.files.set(framePathFor(order, type, id), frame);
  return frame;
}

// The realistic corruption: a `\$` escape. JSON does not define it, so the
// document is invalid — but it has exactly one reading, so it is recoverable.
const REPAIRABLE_BODY = '{"id":"f_poison","type":"ShellToolFrame","order":3,'
  + '"interactionID":"int_1","authorType":"agent","content":{"text":"cost \\$12"}}';

// Corruption with more than one possible reading, and therefore not repairable
// by rule: the document is truncated mid-string.
const UNREPAIRABLE_BODY = '{"id":"f_bad","type":"ShellToolFrame","order":3,'
  + '"interactionID":"int_1","authorType":"agent","content":{"text":"cost ';

function addRawFrame(aeordb, order, id, raw) {
  aeordb.files.set(framePathFor(order, 'ShellToolFrame', id), { __raw: raw });
}

function createStore() {
  let aeordb = createClient();
  return { aeordb, store: new FrameStore({ aeordb, rootPath: '/kikx' }) };
}

function onlyFilters(...keys) {
  let filters = {};
  for (let key of [ 'user', 'agent', 'question', 'session', 'tools', 'commands', 'compaction', 'deleted' ])
    filters[key] = keys.includes(key);

  return filters;
}

// --- the page survives a malformed document -------------------------------

test('a malformed document no longer fails the whole filtered page', async () => {
  let { aeordb, store } = createStore();
  addFrame(aeordb, 1, 'UserMessage', { content: { text: 'first' } });
  addFrame(aeordb, 2, 'AgentMessage', { content: { text: 'second' } });
  addRawFrame(aeordb, 3, 'f_poison', REPAIRABLE_BODY);
  addFrame(aeordb, 4, 'UserMessage', { content: { text: 'fourth' } });

  // Before the fix this call threw, and the route answered HTTP 500.
  let window = await store.listFrameWindow('ses_1', {
    limit: 50,
    filters: onlyFilters('user', 'agent', 'tools'),
  });

  // Every frame on the page arrives, including the recovered one.
  assert.deepEqual(
    window.frames.map((frame) => frame?.content?.text),
    [ 'first', 'second', 'cost $12', 'fourth' ]
  );
});

test('a recoverable document is repaired, not discarded', async () => {
  let { aeordb, store } = createStore();
  addRawFrame(aeordb, 3, 'f_poison', REPAIRABLE_BODY);

  let window = await store.listFrameWindow('ses_1', {
    limit: 50,
    filters: onlyFilters('tools'),
  });

  assert.equal(window.frames.length, 1);
  assert.equal(window.frames[0].type, 'ShellToolFrame');
  assert.equal(window.frames[0].content.text, 'cost $12');
});

test('an unreadable frame surfaces visibly at its own order', async () => {
  let { aeordb, store } = createStore();
  addFrame(aeordb, 1, 'UserMessage', { content: { text: 'first' } });
  addRawFrame(aeordb, 3, 'f_bad', UNREPAIRABLE_BODY);
  addFrame(aeordb, 4, 'UserMessage', { content: { text: 'fourth' } });

  let window = await store.listFrameWindow('ses_1', {
    limit: 50,
    filters: onlyFilters('user', 'agent', 'tools'),
  });

  let failures = window.frames.filter((frame) => frame.type === 'FrameLoadError');
  assert.equal(failures.length, 1, 'exactly one load-error marker');

  let [ failure ] = failures;
  assert.equal(failure.sessionID, 'ses_1');
  // Order is parsed from the filename, so the marker sits where the frame was
  // rather than being appended at the end of the thread.
  assert.equal(failure.order, 3);
  assert.match(failure.content.error, /non-JSON content/);
  assert.match(failure.content.path, /ShellToolFrame/);
  // The whole point: the user is told, and told it is not their data's fault.
  assert.match(failure.content.text, /could not be loaded/);

  // The readable siblings are still there, in order, around the marker.
  assert.deepEqual(
    window.frames.map((frame) => frame.order),
    [ 1, 3, 4 ]
  );
});

test('a malformed document does not fail the default unfiltered window', async () => {
  let { aeordb, store } = createStore();
  addFrame(aeordb, 1, 'UserMessage', { content: { text: 'first' } });
  addRawFrame(aeordb, 3, 'f_bad', UNREPAIRABLE_BODY);

  let window = await store.listFrameWindow('ses_1', { limit: 50 });
  let types = window.frames.map((frame) => frame.type);

  assert.ok(types.includes('UserMessage'), 'the readable frame still arrives');
  assert.ok(types.includes('FrameLoadError'), 'the unreadable frame is still reported');
});

// --- parse tolerance is narrow --------------------------------------------

test('readJSONFiles records a bad document per path instead of throwing', async () => {
  let aeordb = createClient();
  aeordb.files.set('/a.json', { ok: true });
  aeordb.files.set('/poison.json', { __raw: '{"text":"cost \\$12"}' });

  let reads = await readJSONFiles(aeordb, [ '/a.json', '/poison.json' ], {
    fallbackOnBatchError: true,
    continueOnError: true,
  });

  assert.equal(reads.length, 2);
  assert.deepEqual(reads[0].value, { ok: true });
  assert.equal(reads[0].error, undefined);

  // The invalid `\$` escape has exactly one reading, so it is repaired and the
  // document is recovered rather than reported.
  assert.deepEqual(reads[1].value, { text: 'cost $12' });
  assert.equal(reads[1].error, undefined);
});

test('readJSONFiles leaves a valid escaped backslash alone', async () => {
  let aeordb = createClient();
  // `\\$` is a literal backslash followed by `$` — valid JSON, and it must not
  // be "repaired" into `\$`, which would silently change stored content.
  aeordb.files.set('/win.json', { __raw: '{"text":"cost \\\\$12"}' });

  let reads = await readJSONFiles(aeordb, [ '/win.json' ], {
    fallbackOnBatchError: true,
    continueOnError: true,
  });

  assert.deepEqual(reads[0].value, { text: 'cost \\$12' });
});

test('readJSONFiles still throws without continueOnError', async () => {
  let aeordb = createClient();
  // Corruption whose repair has more than one reading must not be guessed at:
  // a half-parsed document is worse than an honest failure.
  aeordb.files.set('/bad.json', { __raw: '{"text":"unterminated' });

  await assert.rejects(
    () => readJSONFiles(aeordb, [ '/bad.json' ]),
    /non-JSON content/
  );
});

test('a corrupt document that cannot be repaired is reported, not repaired', async () => {
  let aeordb = createClient();
  aeordb.files.set('/bad.json', { __raw: '{"text":"unterminated' });

  let reads = await readJSONFiles(aeordb, [ '/bad.json' ], {
    fallbackOnBatchError: true,
    continueOnError: true,
  });

  assert.equal(reads[0].value, undefined);
  assert.match(reads[0].error.message, /non-JSON content/);
});
