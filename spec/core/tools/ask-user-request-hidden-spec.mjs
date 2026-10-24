'use strict';

// The bot's ask-user request is not shown in the thread.
//
// A question arrives twice: once as a tool call frame rendering `ask-user({...})`
// with the question's raw JSON in it, and once as a Question frame the user can
// actually answer. The second is the question. The first is the agent's plumbing,
// and the owner asked for it to stop showing up.
//
// The line to be careful about is that this must hide the REQUEST and not the
// QUESTION. `ask-user-tool.mjs` stamps `hidden` on the Question frame it emits,
// and that frame is the surface the whole feature operates on — hiding it would
// hide the thing being asked. So these tests assert both halves:
//
//   ask-user call/result frames -> hidden
//   ask-user Question frames    -> visible
//   every other tool            -> visible

import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('../../client/support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);

test('the ask-user call frame is hidden, and every other tool is not', async () => {
  // The decision is exported for exactly this reason: it is a policy, and a
  // policy is worth asserting directly rather than inferring from a rendered
  // thread.
  const { hidesToolCallFrames } = await import('../../../src/core/tools/tool-execution-service.mjs');

  assert.equal(hidesToolCallFrames('ask-user'), true, 'the request is not rendered');
  assert.equal(hidesToolCallFrames('exec'), false, 'an ordinary tool call stays visible');
  assert.equal(hidesToolCallFrames('read-file'), false);
  assert.equal(hidesToolCallFrames('ask-user ', false), false,
    'matching is exact — a tool that merely looks like it must not be hidden');
  assert.equal(hidesToolCallFrames(''), false, 'an unnamed tool must not be hidden by accident');
  assert.equal(hidesToolCallFrames(undefined), false);
  assert.equal(hidesToolCallFrames(null), false);

  // Some call sites hand the class rather than the name. Without this the same
  // tool would be hidden or visible depending on which caller emitted it.
  assert.equal(hidesToolCallFrames(undefined, { featureName: 'ask-user' }), true,
    'a call site that passes only the tool class still hides the request');
  assert.equal(hidesToolCallFrames(undefined, { featureName: 'exec' }), false);
});

test('both the call frame and the result frame are hidden', async () => {
  // A hidden call with a visible result would still leak the request into the
  // thread, and worse, would render a result with no call above it.
  const source = await import('node:fs')
    .then((fs) => fs.readFileSync(
      new URL('../../../src/core/tools/tool-execution-service.mjs', import.meta.url),
      'utf8',
    ));

  let hiddenAssignments = source.match(/hidden: hidesToolCallFrames\(toolName, ToolClass\)/g) || [];
  assert.equal(hiddenAssignments.length, 2,
    'the call recorder and the result recorder must both consult the policy');

  assert.doesNotMatch(source, /hidden: false,\n    deleted: false,\n    content: \{\n      toolName,/,
    'neither tool frame may hard-code visible again');
});

test('hiding the request never hides the question', async () => {
  // The Question frame is emitted by the ask-user tool itself, and it is the
  // surface the user answers on. It must stay visible even though it comes from
  // the same tool whose call frames are hidden.
  const source = await import('node:fs')
    .then((fs) => fs.readFileSync(
      new URL('../../../src/core/tools/ask-user-tool.mjs', import.meta.url),
      'utf8',
    ));

  // Asserted against the source because the Question frame is built inside an
  // async method that needs a whole tool context to reach. What matters is the
  // literal it stamps, and that is a one-line, load-bearing fact.
  assert.match(source, /type: 'Question',[\s\S]{0,800}?hidden: false,/,
    'the Question frame must stay visible — it IS the question');

  const { AskUserTool } = await import('../../../src/core/tools/ask-user-tool.mjs');
  assert.equal(typeof AskUserTool, 'function', 'and the tool that emits it still loads');
});
