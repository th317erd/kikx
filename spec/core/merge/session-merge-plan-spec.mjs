'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  defaultSummaryTokensFor,
  planSessionCompactions,
  sessionMergeOrder,
} from '../../../src/core/merge/session-merge-plan.mjs';

test('merge priority starts with the target, then the largest source', () => {
  let order = sessionMergeOrder([
    { sessionID: 'small', tokens: 10 },
    { sessionID: 'target', tokens: 5 },
    { sessionID: 'large', tokens: 100 },
    { sessionID: 'medium', tokens: 40 },
  ], 'target');

  assert.deepEqual(order.map((entry) => entry.sessionID), [ 'target', 'large', 'medium', 'small' ]);
});

test('nothing is compacted when the full merge already fits', () => {
  let plan = planSessionCompactions({
    sessions: [
      { sessionID: 'target', tokens: 20 },
      { sessionID: 'source', tokens: 30 },
    ],
    targetSessionID: 'target',
    budgetTokens: 100,
  });

  assert.equal(plan.fitsWithoutCompaction, true);
  assert.deepEqual(plan.selectedSessionIDs, []);
});

test('the minimum priority prefix is selected when the merge does not fit', () => {
  let plan = planSessionCompactions({
    sessions: [
      { sessionID: 'target', tokens: 80 },
      { sessionID: 'source-a', tokens: 20 },
      { sessionID: 'source-b', tokens: 30 },
    ],
    targetSessionID: 'target',
    budgetTokens: 50,
    summaryTokensFor: () => 4,
  });

  assert.equal(plan.fitsWithoutCompaction, false);
  assert.deepEqual(plan.selectedSessionIDs, [ 'target', 'source-b' ]);
  assert.ok(plan.projectedTokens <= 50);
  assert.equal(defaultSummaryTokensFor({ tokens: 100 }, 1000), 100);
  assert.equal(defaultSummaryTokensFor({ tokens: 10000 }, 1000), 512);
});
