'use strict';

// The scrollview source counts raw pages from the server, not the loaded client
// window. These tests pin the two failure modes that made the old adapter show
// a single page: page identity is independent of the loaded head array, and a
// tool call/result pair split across a raw-page seam is projected as one head
// on exactly one page.

import assert from 'node:assert/strict';
import test from 'node:test';

import { KikxThreadPageSource } from '../../src/client/components/kikx-thread-page-source.mjs';

function rawPage(index, frames) {
  return {
    pageIndex: index,
    totalPages: 2,
    totalRawFrames: 4,
    frames,
    oldestOrder: frames[0]?.order ?? null,
    newestOrder: frames.at(-1)?.order ?? null,
  };
}

function frames() {
  return {
    0: rawPage(0, [
      { id: 'user_1', type: 'UserMessage', order: 1, authorType: 'user', content: { text: 'first' } },
      {
        id: 'call_2',
        type: 'ShellToolFrame',
        order: 2,
        authorType: 'tool',
        content: { toolName: 'shell', phase: 'call', toolCallID: 't1', text: 'ls' },
      },
    ]),
    1: rawPage(1, [
      {
        id: 'result_3',
        type: 'ShellToolFrame',
        order: 3,
        authorType: 'tool',
        content: { toolName: 'shell', phase: 'result', toolCallID: 't1', toolCallFrameID: 'call_2', text: 'ok' },
      },
      { id: 'user_4', type: 'UserMessage', order: 4, authorType: 'user', content: { text: 'last' } },
    ]),
  };
}

test('the source reports both raw pages and loads a page by stable token', async () => {
  let pages = frames();
  let source = new KikxThreadPageSource({
    pageSize: 2,
    totalRawFrames: 4,
    loadPage: async (index) => pages[index],
    getFilters: () => null,
  });

  assert.equal(source.totalPages, 2);
  assert.equal(source.pageToken(0), '0');
  assert.equal(source.pageIndex('1'), 1);

  let first = await source.loadPage({ pageIndex: 0 });
  assert.equal(first.items.length, 2);
  assert.deepEqual(first.items.map((item) => item.frame.id), [ 'user_1', 'call_2' ]);
});

test('a call/result pair split across pages is projected once, on the call page', async () => {
  let pages = frames();
  let source = new KikxThreadPageSource({
    pageSize: 2,
    totalRawFrames: 4,
    loadPage: async (index) => pages[index],
    getFilters: () => null,
  });

  let first = await source.loadPage({ pageIndex: 0 });
  let second = await source.loadPage({ pageIndex: 1 });
  let firstIDs = first.items.map((item) => item.frame.id);
  let secondIDs = second.items.map((item) => item.frame.id);

  assert.ok(firstIDs.includes('call_2'), 'the call page owns the merged tool head');
  assert.equal(secondIDs.includes('call_2'), false, 'the result page must not duplicate the merged head');
  assert.equal(firstIDs.filter((id) => id === 'call_2').length, 1);
});

test('page height estimates learn from measured pages', () => {
  let source = new KikxThreadPageSource({
    pageSize: 2,
    totalRawFrames: 4,
    loadPage: async () => rawPage(0, []),
    getFilters: () => null,
  });
  let before = source.estimatePageHeight(0);
  source.measured(0, 900);
  assert.equal(source.estimatePageHeight(1), 900);
  assert.notEqual(source.estimatePageHeight(1), before);
});
