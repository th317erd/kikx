'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { CORE_TAG_DEFINITIONS } from '../../src/core/tags/tag-definitions.mjs';
import {
  agentTagActionActive,
  agentTagActionClassName,
  agentTagActions,
  agentTagActionTitle,
  agentTagRankByID,
  nextPriorityTimestamp,
} from '../../src/client/components/agent-tag-actions.mjs';
import { iconNames } from '../../src/client/lib/icons.mjs';

test('agent role actions are derived from tag definitions', () => {
  let actions = agentTagActions(CORE_TAG_DEFINITIONS);
  assert.deepEqual(actions.map((definition) => definition.agentAction.icon), [ 'crown', 'clamp', 'eyeball' ]);
  assert.ok(iconNames().includes('clamp'));
  assert.ok(iconNames().includes('eyeball'));
});

test('tag action state combines the priority tag with legacy role fields', () => {
  let leadership = CORE_TAG_DEFINITIONS.find((definition) => definition.name === 'leadership_score');
  let ocr = CORE_TAG_DEFINITIONS.find((definition) => definition.name === 'ocr_score');
  let ranks = { masterRankByID: new Map([ [ 'agent_1', 2 ] ]) };

  assert.equal(agentTagActionActive({ id: 'agent_1', crownedClock: '0001' }, leadership, ranks), true);
  assert.match(agentTagActionTitle(leadership, true, 2), /Master agent #2/);
  assert.match(agentTagActionClassName({ id: 'agent_1' }, leadership, ranks), /is-master/);
  assert.match(agentTagActionClassName({ id: 'agent_1', tags: [ { name: 'ocr_score', value: 8 } ] }, ocr, {
    tagRankByID: { ocr_score: new Map([ [ 'agent_1', 1 ] ]) },
  }), /is-ocr-bot.*ocr-bot--rank-1/);
});


test('OCR priority is ordered by click timestamp, without shifting other rows', () => {
  let ocr = CORE_TAG_DEFINITIONS.find((definition) => definition.name === 'ocr_score');
  let agents = [
    { id: 'a', tags: [ { name: 'ocr_score', value: 10 }, { name: 'ocr_priority_at', value: 100 } ] },
    { id: 'b', tags: [ { name: 'ocr_score', value: 10 }, { name: 'ocr_priority_at', value: 200 } ] },
    { id: 'c', tags: [] },
  ];

  assert.deepEqual([ ...agentTagRankByID(agents, ocr).entries() ], [ [ 'b', 1 ], [ 'a', 2 ] ]);
  assert.equal(nextPriorityTimestamp(agents, ocr, 150), 201);
  assert.equal(nextPriorityTimestamp(agents, ocr, 500), 500);
});
