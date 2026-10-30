'use strict';

// Integration coverage for filtered frame windows.
//
// These run against a real FrameStore with an in-memory AeorDB stand-in, so
// they exercise the actual path listing, ordering, hydration and paging rather
// than a mock of the filter predicate. The point of the feature is that
// filtering happens where the frames are, so the tests have to go through the
// store.

import test from 'node:test';
import assert from 'node:assert/strict';

import { FrameStore } from '../../src/core/aeordb/frame-store.mjs';

// In-memory AeorDB with the two behaviours the window code depends on:
// basename-sorted listing (frame names are zero-padded order prefixes, so this
// is chronological) and prefix + glob filtering.
function createClient() {
  return {
    files: new Map(),
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
    async fetchFiles(paths) {
      let output = {};
      for (let path of paths) {
        if (!this.files.has(path)) {
          let error = new Error(`missing: ${path}`);
          error.status = 404;
          throw error;
        }

        output[path] = { path, content: JSON.stringify(this.files.get(path)) };
      }

      return output;
    },
    async listDirectory(path, options = {}) {
      let prefix = `${path.replace(/\/+$/g, '')}/`;
      let items = [];

      for (let filePath of this.files.keys()) {
        if (!filePath.startsWith(prefix))
          continue;
        if (!filePath.endsWith('.json'))
          continue;

        let name = filePath.split('/').pop();
        let glob = options.glob || '';
        if (glob === '**/frames/*.json' && !filePath.includes('/frames/'))
          continue;
        if (glob === '**/session.json')
          continue;

        // Support the single-type glob used for pushdown: **/frames/*-<Type>-*.json
        let typed = /^\*\*\/frames\/\*-([^-]+)-\*\.json$/.exec(glob);
        if (typed) {
          if (!filePath.includes('/frames/'))
            continue;
          if (!name.includes(`-${typed[1]}-`))
            continue;
        }

        // Encode the frame type into the path the way `framePath` does.
        items.push({ path: filePath });
      }

      items.sort((left, right) => {
        let leftName = left.path.split('/').pop();
        let rightName = right.path.split('/').pop();
        return leftName.localeCompare(rightName);
      });

      let offset = options.offset || 0;
      let limit = options.limit == null ? items.length : options.limit;

      return {
        items: items.slice(offset, offset + limit),
        limit,
        offset,
        total: items.length,
      };
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
    ...(extra.deleted === true ? { deleted: true } : {}),
    ...(extra.hidden === true ? { hidden: true } : {}),
  };

  aeordb.files.set(framePathFor(order, type, id), frame);
  return frame;
}

function createStore() {
  let aeordb = createClient();
  return { aeordb, store: new FrameStore({ aeordb, rootPath: '/kikx' }) };
}

function defaultFilters() {
  return { user: true, agent: true, question: true, session: true, tools: true, commands: true, compaction: true, deleted: false };
}

function onlyFilters(...keys) {
  let filters = {};
  for (let key of [ 'user', 'agent', 'question', 'session', 'tools', 'commands', 'compaction', 'deleted' ])
    filters[key] = keys.includes(key);

  return filters;
}

// --- default path is untouched -------------------------------------------

test('an unfiltered window still drops soft-deleted frames', async () => {
  let { aeordb, store } = createStore();
  addFrame(aeordb, 1, 'UserMessage', { content: { text: 'keep' } });
  addFrame(aeordb, 2, 'UserMessage', { deleted: true, content: { text: 'gone' } });

  let window = await store.listFrameWindow('ses_1', { limit: 10 });

  assert.equal(window.frames.length, 1);
  assert.equal(window.frames[0].content.text, 'keep');
  assert.equal(window.filtered, undefined, 'the default path is not a filtered window');
});

// --- the deleted gate ----------------------------------------------------

test('asking for deleted frames returns them instead of stripping them', async () => {
  let { aeordb, store } = createStore();
  addFrame(aeordb, 1, 'UserMessage', { content: { text: 'keep' } });
  addFrame(aeordb, 2, 'UserMessage', { deleted: true, content: { text: 'gone' } });

  let window = await store.listFrameWindow('ses_1', {
    limit: 10,
    filters: onlyFilters('user', 'deleted'),
  });

  assert.equal(window.filtered, true);
  assert.equal(window.frames.length, 2);
  assert.deepEqual(window.frames.map((frame) => frame.content.text), [ 'keep', 'gone' ]);
});

test('a deleted frame stays hidden while the Deleted gate is off', async () => {
  let { aeordb, store } = createStore();
  addFrame(aeordb, 1, 'UserMessage', { content: { text: 'keep' } });
  addFrame(aeordb, 2, 'UserMessage', { deleted: true, content: { text: 'gone' } });

  let window = await store.listFrameWindow('ses_1', {
    limit: 10,
    filters: onlyFilters('user'),
  });

  assert.deepEqual(window.frames.map((frame) => frame.content.text), [ 'keep' ]);
});

test('hidden frames are revealed by the Hidden gate', async () => {
  let { aeordb, store } = createStore();
  addFrame(aeordb, 1, 'UserMessage', { content: { text: 'visible' } });
  addFrame(aeordb, 2, 'UserMessage', { hidden: true, content: { text: 'hidden' } });
  addFrame(aeordb, 3, 'UserMessage', { hidden: true, deleted: true, content: { text: 'hidden and deleted' } });

  let hiddenOff = await store.listFrameWindow('ses_1', {
    limit: 10,
    filters: onlyFilters('user'),
  });
  assert.deepEqual(hiddenOff.frames.map((frame) => frame.content.text), [ 'visible' ]);

  let hiddenOn = await store.listFrameWindow('ses_1', {
    limit: 10,
    filters: onlyFilters('user', 'deleted'),
  });
  assert.deepEqual(hiddenOn.frames.map((frame) => frame.content.text), [ 'visible', 'hidden', 'hidden and deleted' ]);
});

// --- type pushdown -------------------------------------------------------

test('a single selected category narrows by frame type on the server', async () => {
  let { aeordb, store } = createStore();
  addFrame(aeordb, 1, 'UserMessage');
  addFrame(aeordb, 2, 'AgentMessage');
  addFrame(aeordb, 3, 'ToolCall', { content: { toolName: 'read_file' } });
  addFrame(aeordb, 4, 'UserMessage');

  let window = await store.listFrameWindow('ses_1', {
    limit: 10,
    filters: onlyFilters('user'),
  });

  assert.deepEqual(window.frames.map((frame) => frame.type), [ 'UserMessage', 'UserMessage' ]);
  assert.deepEqual(window.frames.map((frame) => frame.order), [ 1, 4 ]);
});

test('a multi-type category keeps both of its frame types', async () => {
  let { aeordb, store } = createStore();
  addFrame(aeordb, 1, 'ToolCall', { content: { toolName: 'a' } });
  addFrame(aeordb, 2, 'ToolResult', { content: { toolCallID: 'a' } });
  addFrame(aeordb, 3, 'UserMessage');

  let window = await store.listFrameWindow('ses_1', {
    limit: 10,
    filters: onlyFilters('tools'),
  });

  assert.deepEqual(window.frames.map((frame) => frame.type), [ 'ToolCall', 'ToolResult' ]);
});

// --- the property that makes this server-side ---------------------------

test('a window of matches skips over non-matching frames', async () => {
  let { aeordb, store } = createStore();
  // 50 agent messages, with three user messages buried in the middle.
  for (let order = 1; order <= 50; order++) {
    if (order === 20 || order === 30 || order === 40)
      addFrame(aeordb, order, 'UserMessage');
    else
      addFrame(aeordb, order, 'AgentMessage');
  }

  let window = await store.listFrameWindow('ses_1', {
    limit: 3,
    filters: onlyFilters('user'),
  });

  // The three user frames are not contiguous: a raw slice of 3 would have
  // returned agent messages and this is exactly what a client-side filter
  // cannot see.
  assert.deepEqual(window.frames.map((frame) => frame.order), [ 20, 30, 40 ]);
  assert.equal(window.total, 50, 'total stays the raw total for growth bounds');
});

test('hasMore describes older MATCHES, not older rows', async () => {
  let { aeordb, store } = createStore();
  for (let order = 1; order <= 40; order++) {
    if (order % 10 === 0)
      addFrame(aeordb, order, 'UserMessage');
    else
      addFrame(aeordb, order, 'AgentMessage');
  }

  let first = await store.listFrameWindow('ses_1', {
    limit: 2,
    filters: onlyFilters('user'),
  });

  assert.equal(first.frames.length, 2);
  assert.equal(first.hasMore, true, 'older matches remain');

  // Page backwards from the oldest order we were given.
  let second = await store.listFrameWindow('ses_1', {
    limit: 2,
    before: first.oldestOrder,
    filters: onlyFilters('user'),
  });

  assert.deepEqual(second.frames.map((frame) => frame.order), [ 10, 20 ]);
  assert.equal(second.hasMore, false, 'no older matches remain');
});

test('a filter that matches nothing reports no matches and no false paging', async () => {
  let { aeordb, store } = createStore();
  addFrame(aeordb, 1, 'UserMessage');
  addFrame(aeordb, 2, 'AgentMessage');

  let window = await store.listFrameWindow('ses_1', {
    limit: 10,
    filters: onlyFilters('commands'),
  });

  assert.deepEqual(window.frames, []);
  assert.equal(window.hasMore, false);
  assert.equal(window.total, 2);
  assert.equal(window.exhausted, true, 'the scan reached the start of the session');
});

test('an empty category selection selects nothing', async () => {
  let { aeordb, store } = createStore();
  addFrame(aeordb, 1, 'UserMessage');

  let window = await store.listFrameWindow('ses_1', { limit: 10, filters: onlyFilters() });

  assert.deepEqual(window.frames, []);
  assert.equal(window.hasMore, false);
});

// --- ordering ------------------------------------------------------------

test('a filtered window is ascending, like the unfiltered one', async () => {
  let { aeordb, store } = createStore();
  addFrame(aeordb, 1, 'UserMessage');
  addFrame(aeordb, 2, 'AgentMessage');
  addFrame(aeordb, 3, 'UserMessage');

  let window = await store.listFrameWindow('ses_1', {
    limit: 10,
    filters: onlyFilters('user'),
  });

  let orders = window.frames.map((frame) => frame.order);
  assert.deepEqual(orders, [ ...orders ].sort((a, b) => a - b));
});

// --- search --------------------------------------------------------------

test('the query narrows the window to matching frames', async () => {
  let { aeordb, store } = createStore();
  addFrame(aeordb, 1, 'UserMessage', { content: { text: 'deploy the service' } });
  addFrame(aeordb, 2, 'UserMessage', { content: { text: 'roll back the service' } });
  addFrame(aeordb, 3, 'AgentMessage', { content: { text: 'deployed' } });

  let window = await store.listFrameWindow('ses_1', {
    limit: 10,
    filters: defaultFilters(),
    query: 'deploy',
  });

  assert.deepEqual(window.frames.map((frame) => frame.order), [ 1, 3 ]);
});

test('the query supports wildcards across matches', async () => {
  let { aeordb, store } = createStore();
  addFrame(aeordb, 1, 'UserMessage', { content: { text: 'please deploy the service now' } });
  addFrame(aeordb, 2, 'UserMessage', { content: { text: 'nothing here' } });

  let window = await store.listFrameWindow('ses_1', {
    limit: 10,
    filters: defaultFilters(),
    query: 'deploy*now',
  });

  assert.deepEqual(window.frames.map((frame) => frame.order), [ 1 ]);
});

test('a query with no matches yields an empty window, not an error', async () => {
  let { aeordb, store } = createStore();
  addFrame(aeordb, 1, 'UserMessage', { content: { text: 'deploy' } });

  let window = await store.listFrameWindow('ses_1', {
    limit: 10,
    filters: defaultFilters(),
    query: 'absent',
  });

  assert.deepEqual(window.frames, []);
  assert.equal(window.hasMore, false);
});

// --- anchors -------------------------------------------------------------

test('a filtered anchored load starts at the requested frame', async () => {
  let { aeordb, store } = createStore();
  addFrame(aeordb, 1, 'UserMessage', { id: 'f_1' });
  addFrame(aeordb, 2, 'AgentMessage', { id: 'f_2' });
  addFrame(aeordb, 3, 'UserMessage', { id: 'f_3' });
  addFrame(aeordb, 4, 'UserMessage', { id: 'f_4' });

  let window = await store.listFrameWindow('ses_1', {
    limit: 1,
    start: 'f_3',
    filters: onlyFilters('user'),
  });

  assert.equal(window.startFound, true);
  assert.deepEqual(window.frames.map((frame) => frame.order), [ 3 ]);
});
