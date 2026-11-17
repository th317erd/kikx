'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { buildLoopDoneContent } from '../../../src/core/plugins/agent-loop-state.mjs';

// P5(b) data link (plan §12.2(6)): the route can only honor the
// turn-completion hook if the Done content tells it whether a control tool
// finalized the turn. end-turn sets state.finalized (agent-loop-tools.mjs:53)
// but the state never previously reached output.content. Contract: emitted
// ONLY when true; absent = false (keeps non-finalized paths byte-identical).

test('emits finalized: true when the loop state is finalized', () => {
  let content = buildLoopDoneContent({ finalized: true }, { status: 'finalized' });
  assert.equal(content.finalized, true);
  assert.equal(content.status, 'finalized');
});

test('omits finalized for a turn that never ran a control tool (absent = false)', () => {
  let content = buildLoopDoneContent({}, { status: 'plain' });
  assert.ok(!content.finalized);
  assert.equal(Object.hasOwn(content, 'finalized'), false);
});

test('keeps usage passthrough alongside finalized', () => {
  let content = buildLoopDoneContent(
    { finalized: false, usage: { inputTokens: 3, outputTokens: 1 } },
    { status: 'plain' },
  );
  assert.deepEqual(content.usage, { inputTokens: 3, outputTokens: 1 });
  assert.ok(!content.finalized);
});
