'use strict';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FrameController } from '../../../src/server/controllers/frame-controller.mjs';

// =============================================================================
// FrameController — compaction summary stripping tests
// =============================================================================
// The list() endpoint must null out content.summary for compaction frames so
// that large summaries are not sent in bulk listing responses.  The client
// lazy-loads the full summary via the single-frame GET endpoint.
// =============================================================================

function buildController(frames) {
  let controller = Object.create(FrameController.prototype);

  controller.getFramePersistence = () => ({
    loadFrames: async () => ({
      toArray: () => frames,
    }),
  });

  return controller;
}

function callList(controller, sessionID) {
  return controller.list({
    params: { sessionID: sessionID || 'ses_test' },
    query:  {},
  });
}

// ---------------------------------------------------------------------------
// Compaction summary stripping in list()
// ---------------------------------------------------------------------------

describe('FrameController.list() compaction summary stripping', () => {

  it('nulls out summary on compaction frames', async () => {
    let frames = [
      {
        id:      'frm_1',
        type:    'compaction',
        content: { summary: 'A very long summary...', tokenCount: 42 },
      },
    ];

    let controller = buildController(frames);
    let result     = await callList(controller);

    let returned = result.data.frames[0];
    assert.equal(returned.content.summary, null);
    assert.equal(returned.content.tokenCount, 42, 'other content fields are preserved');
  });

  it('leaves non-compaction frames unchanged', async () => {
    let originalContent = { html: '<p>hello</p>', text: 'hello' };
    let frames = [
      {
        id:      'frm_2',
        type:    'user-message',
        content: originalContent,
      },
    ];

    let controller = buildController(frames);
    let result     = await callList(controller);

    let returned = result.data.frames[0];
    assert.deepStrictEqual(returned.content, originalContent);
  });

  it('handles mixed frame types correctly', async () => {
    let frames = [
      {
        id:      'frm_a',
        type:    'user-message',
        content: { html: '<p>hi</p>' },
      },
      {
        id:      'frm_b',
        type:    'compaction',
        content: { summary: 'huge text', tokenCount: 100 },
      },
      {
        id:      'frm_c',
        type:    'agent-message',
        content: { html: '<p>reply</p>' },
      },
      {
        id:      'frm_d',
        type:    'compaction',
        content: { summary: 'another huge text', tokenCount: 200, extra: true },
      },
    ];

    let controller = buildController(frames);
    let result     = await callList(controller);

    let returned = result.data.frames;

    // user-message — untouched
    assert.deepStrictEqual(returned[0].content, { html: '<p>hi</p>' });

    // compaction — summary nulled, rest preserved
    assert.equal(returned[1].content.summary, null);
    assert.equal(returned[1].content.tokenCount, 100);

    // agent-message — untouched
    assert.deepStrictEqual(returned[2].content, { html: '<p>reply</p>' });

    // second compaction — summary nulled, rest preserved
    assert.equal(returned[3].content.summary, null);
    assert.equal(returned[3].content.tokenCount, 200);
    assert.equal(returned[3].content.extra, true);
  });

  it('skips compaction frames with null content', async () => {
    let frames = [
      {
        id:      'frm_e',
        type:    'compaction',
        content: null,
      },
    ];

    let controller = buildController(frames);
    let result     = await callList(controller);

    let returned = result.data.frames[0];
    assert.equal(returned.content, null);
  });

  it('skips compaction frames with undefined content', async () => {
    let frames = [
      {
        id:   'frm_f',
        type: 'compaction',
      },
    ];

    let controller = buildController(frames);
    let result     = await callList(controller);

    let returned = result.data.frames[0];
    assert.equal(returned.content, undefined);
  });

  it('handles compaction frames that already have no summary field', async () => {
    let frames = [
      {
        id:      'frm_g',
        type:    'compaction',
        content: { tokenCount: 50 },
      },
    ];

    let controller = buildController(frames);
    let result     = await callList(controller);

    let returned = result.data.frames[0];
    assert.equal(returned.content.summary, null);
    assert.equal(returned.content.tokenCount, 50);
  });

  it('returns empty array when no frames exist', async () => {
    let controller = buildController([]);
    let result     = await callList(controller);

    assert.deepStrictEqual(result.data.frames, []);
  });
});
