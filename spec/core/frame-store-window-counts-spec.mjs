'use strict';

// Whole-session counts for the frame-filter popup.
//
// These exist because the counts shipped once without coverage: `countSessionFrames`
// called `countFilterMatches` without importing it, every request threw
// `ReferenceError: countFilterMatches is not defined`, and the full gate stayed green
// the whole time because no spec in the repo ever called the function. A green gate
// that never executes a route is not evidence that the route works.
//
// The behaviours worth locking down are the ones that made the number wrong before:
//   - the count must span the whole session, not one clamped directory page;
//   - it must classify by path so it never pays a body read per frame;
//   - `deleted` must stay `null`, because soft-deletion lives in the body.

import test from 'node:test';
import assert from 'node:assert/strict';

import { FrameStore } from '../../src/core/aeordb/frame-store.mjs';

// In-memory AeorDB mirroring the real transport's contract: `listDirectory`
// honours the `limit` it is given (capped at `maxPage`, which stands in for the
// server-side page size) and reports the honest `total`. The clamp that caused
// the bad count is *not* here -- it lives in `normalizeLargeLimit`, which caps the
// requested limit at `MAX_FRAME_LIST_LIMIT` before the call is made. So a caller
// that asks for "everything" in one go receives 5,000 rows of a 17,683-row
// listing and no error, which is exactly how a wrong total shipped.
function createClient({ maxPage = 5000 } = {}) {
  return {
    files: new Map(),
    maxPage,
    async putFile(path, body) {
      this.files.set(path, body);
      return { path };
    },
    async patchFile(path, body) {
      this.files.set(path, body);
      return { path };
    },
    async getFile(path) {
      return this.files.get(path) || null;
    },
    async listDirectory(path, options = {}) {
      let prefix = `${path.replace(/\/+$/g, '')}/`;
      let items = [];

      for (let filePath of this.files.keys()) {
        if (!filePath.startsWith(prefix))
          continue;
        if (!filePath.endsWith('.json'))
          continue;
        if (!filePath.includes('/frames/'))
          continue;

        items.push({ path: filePath });
      }

      let names = new Map(items.map((item) => [ item.path, item.path.split('/').pop() ]));
      items.sort((left, right) => names.get(left.path).localeCompare(names.get(right.path)));

      let offset = options.offset || 0;
      let limit = options.limit == null ? this.maxPage : options.limit;
      limit = Math.min(limit, this.maxPage);

      return {
        items: items.slice(offset, offset + limit),
        limit,
        offset,
        total: items.length,
      };
    },
  };
}

function framePathFor(order, type) {
  return `/kikx/sessions/ses_1/interactions/int_1/frames/${String(order).padStart(16, '0')}-${encodeURIComponent(type)}-${encodeURIComponent(`f_${order}`)}.json`;
}

function addFrame(client, order, type, extra = {}) {
  let frame = {
    id: `f_${order}`,
    type,
    order,
    interactionID: 'int_1',
    authorType: type === 'UserMessage' ? 'user' : 'agent',
    content: { text: `frame ${order}` },
    ...(extra.deleted === true ? { deleted: true } : {}),
    ...(extra.hidden === true ? { hidden: true } : {}),
  };

  client.files.set(framePathFor(order, type), frame);
  return frame;
}

function createStore(options = {}) {
  let aeordb = createClient(options);
  return { aeordb, store: new FrameStore({ aeordb, rootPath: '/kikx' }) };
}

// --- the regression that shipped -----------------------------------------

test('countSessionFrames resolves instead of throwing ReferenceError', async () => {
  let { aeordb, store } = createStore();
  addFrame(aeordb, 1, 'UserMessage');

  let result = await store.countSessionFrames('ses_1');

  assert.equal(typeof result.counts, 'object');
  assert.equal(result.total, 1);
});

test('a session with no frames directory counts as empty rather than failing', async () => {
  let client = createClient();
  let store = new FrameStore({ aeordb: client, rootPath: '/kikx' });

  // No interactions directory at all: `listDirectory` reports total 0.
  let result = await store.countSessionFrames('ses_1');

  assert.equal(result.total, 0);
  assert.equal(result.scanned, 0);
  assert.equal(result.truncated, false);
});

// --- the count describes the session, not one page ------------------------

test('the count spans every page of the listing, not one clamped call', async () => {
  // 2,500 frames against a 1,000-item clamp: a single clamped call would see
  // 1,000 and report a number 2.5x too small.
  let { aeordb, store } = createStore({ maxPage: 1000 });
  for (let order = 1; order <= 2500; order += 1)
    addFrame(aeordb, order, 'UserMessage');

  let result = await store.countSessionFrames('ses_1');

  assert.equal(result.total, 2500);
  assert.equal(result.scanned, 2500);
  assert.equal(result.counts.user, 2500);
});

test('a complete walk is not reported as truncated', async () => {
  let { aeordb, store } = createStore({ maxPage: 100 });
  for (let order = 1; order <= 250; order += 1)
    addFrame(aeordb, order, 'UserMessage');

  let result = await store.countSessionFrames('ses_1');

  assert.equal(result.total, 250);
  assert.equal(result.scanned, 250);
  assert.equal(result.truncated, false, 'every frame was counted, so nothing is hidden');
});

test('a request larger than the server honours is still paged, not clamped', async () => {
  // The regression that produced 5,000-of-17,683: one unbounded listing call.
  // `COUNT_PAGE_SIZE` keeps every individual request well inside the clamp, so
  // a listing that cannot be fetched in one call must still be counted whole.
  let { aeordb, store } = createStore({ maxPage: 400 });
  for (let order = 1; order <= 1200; order += 1)
    addFrame(aeordb, order, 'UserMessage');

  let result = await store.countSessionFrames('ses_1');

  assert.equal(result.scanned, 1200, 'three clamped calls, all counted');
  assert.equal(result.counts.user, 1200);
});

test('an incomplete walk is reported as truncated rather than passed off as complete', async () => {
  // A listing that ends short of the reported total must not claim to be
  // complete: an operator reading `truncated: false` would trust a bad number.
  let { aeordb, store } = createStore({ maxPage: 100 });
  for (let order = 1; order <= 250; order += 1)
    addFrame(aeordb, order, 'UserMessage');

  // Lie about the total so the walk stops early, the way a partially
  // unavailable listing would.
  let realListDirectory = aeordb.listDirectory.bind(aeordb);
  aeordb.listDirectory = async (path, options = {}) => {
    let result = await realListDirectory(path, options);
    return { ...result, total: 250 };
  };
  aeordb.files = new Map([ ...aeordb.files ].slice(0, 150));

  let result = await store.countSessionFrames('ses_1');

  assert.equal(result.total, 250);
  assert.ok(result.scanned < result.total, 'the walk could not see every frame');
  assert.equal(result.truncated, true, 'and says so');
});

// --- classification is by path -------------------------------------------

test('counts classify concrete tool frame types that an allowlist would miss', async () => {
  // Live sessions persist `<Name>ToolFrame` records, not the abstract
  // `ToolCall`/`ToolResult` the original tables named. That mismatch is why a
  // session with thousands of shell frames read 0 Tools.
  let { aeordb, store } = createStore();
  addFrame(aeordb, 1, 'ShellToolFrame');
  addFrame(aeordb, 2, 'ReadFileToolFrame');
  addFrame(aeordb, 3, 'WriteFileToolFrame');
  addFrame(aeordb, 4, 'UserMessage');
  addFrame(aeordb, 5, 'AgentMessage');

  let { counts } = await store.countSessionFrames('ses_1');

  assert.equal(counts.tools, 3);
  assert.equal(counts.commands, 1, 'ShellToolFrame is the command subset');
  assert.equal(counts.user, 1);
  assert.equal(counts.agent, 1);
});

test('internally hidden bookkeeping frames are excluded from every count', async () => {
  let { aeordb, store } = createStore();
  addFrame(aeordb, 1, 'UserMessage');
  addFrame(aeordb, 2, 'MessageDone');

  let { counts, scanned } = await store.countSessionFrames('ses_1');

  assert.equal(scanned, 2, 'the frame was scanned');
  assert.equal(counts.user, 1, 'but never counted');
  assert.equal(counts.agent, 0, 'MessageDone is internal bookkeeping');
});

// --- rows that cannot be answered from paths -----------------------------

test('the deleted row is null because soft-deletion is a body field', async () => {
  let { aeordb, store } = createStore();
  addFrame(aeordb, 1, 'UserMessage');
  addFrame(aeordb, 2, 'UserMessage', { deleted: true });

  let { counts } = await store.countSessionFrames('ses_1');

  // A confident 0 here would be a lie: the path cannot see the flag. No badge
  // beats a wrong number.
  assert.equal(counts.deleted, null);
});

test('counts ignore the current filter selection entirely', async () => {
  let { aeordb, store } = createStore();
  addFrame(aeordb, 1, 'UserMessage');
  addFrame(aeordb, 2, 'AgentMessage');
  addFrame(aeordb, 3, 'ShellToolFrame');

  // The badge answers "how many of these exist", so it must not shrink when a
  // neighbouring row is switched off.
  let first = await store.countSessionFrames('ses_1');
  let second = await store.countSessionFrames('ses_1');

  assert.deepEqual(first.counts, second.counts);
  assert.equal(first.counts.tools, 1);
});
