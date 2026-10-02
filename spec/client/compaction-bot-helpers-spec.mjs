'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COMPACTION_BOT_ICON,
  compactionBotButtonAriaLabel,
  compactionBotButtonTitle,
  compactionBotRankByAgentID,
} from '../../src/client/components/compaction-bot-helpers.mjs';

test('COMPACTION_BOT_ICON is a compact glyph distinct from the crown', () => {
  assert.equal(COMPACTION_BOT_ICON, '⊟');
  assert.notEqual(COMPACTION_BOT_ICON, '♛');
});

test('compactionBotRankByAgentID ranks newest designation #1 and skips the rest', () => {
  let ranks = compactionBotRankByAgentID([
    { id: 'a', compactionCrownedClock: '0001', compactionCrownedAt: 1 },
    { id: 'b', compactionCrownedClock: '0003', compactionCrownedAt: 3 },
    { id: 'c', compactionCrownedClock: '0002', compactionCrownedAt: 2 },
    { id: 'd', crownedClock: '0009', crownedAt: 9 },
  ]);

  assert.equal(ranks.get('b'), 1);
  assert.equal(ranks.get('c'), 2);
  assert.equal(ranks.get('a'), 3);
  assert.equal(ranks.has('d'), false);
});

test('compactionBotRankByAgentID caps at the rolling top-3', () => {
  let agents = [];
  for (let index = 1; index <= 5; index++)
    agents.push({ id: `b${index}`, compactionCrownedClock: String(index).padStart(4, '0'), compactionCrownedAt: index });

  let ranks = compactionBotRankByAgentID(agents);
  assert.equal(ranks.size, 3);
  assert.equal(ranks.get('b5'), 1);
  assert.equal(ranks.has('b1'), false);
});

test('compaction bot button titles and aria labels reflect the rank', () => {
  assert.equal(compactionBotButtonTitle(2), 'Compaction bot #2 (click to clear)');
  assert.equal(compactionBotButtonTitle(0), 'Set as compaction bot');
  assert.equal(compactionBotButtonAriaLabel(2), 'Compaction bot number 2');
  assert.equal(compactionBotButtonAriaLabel(0), 'Set as compaction bot');
});
