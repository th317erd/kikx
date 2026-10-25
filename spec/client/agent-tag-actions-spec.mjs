'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { CORE_TAG_DEFINITIONS } from '../../src/core/tags/tag-definitions.mjs';
import {
  agentTagActionActive,
  agentTagActionClassName,
  agentTagActions,
  agentTagActionTitle,
  priorityTagUpdates,
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


test('repeated clicks define a newest-first OCR priority order', () => {
  let ocr = CORE_TAG_DEFINITIONS.find((definition) => definition.name === 'ocr_score');
  let agents = [
    { id: 'a', tags: [ { target_type: 'agent', name: 'ocr_score', value: 10 } ] },
    { id: 'b', tags: [ { target_type: 'agent', name: 'ocr_score', value: 9 } ] },
    { id: 'c', tags: [] },
  ];

  let makeC = priorityTagUpdates(agents, ocr, 'c');
  assert.equal(makeC.active, true);
  assert.equal(makeC.rank, 1);
  assert.deepEqual(Object.fromEntries(makeC.updates.map((update) => [ update.target_id, update.value ])), {
    a: 9,
    b: 8,
    c: 10,
  });

  let afterC = [
    { id: 'a', tags: [ { target_type: 'agent', name: 'ocr_score', value: 9 } ] },
    { id: 'b', tags: [ { target_type: 'agent', name: 'ocr_score', value: 8 } ] },
    { id: 'c', tags: [ { target_type: 'agent', name: 'ocr_score', value: 10 } ] },
  ];
  let removeA = priorityTagUpdates(afterC, ocr, 'a');
  assert.equal(removeA.active, false);
  assert.deepEqual(Object.fromEntries(removeA.updates.map((update) => [ update.target_id, update.value ])), {
    a: 0,
    b: 9,
  });
});
