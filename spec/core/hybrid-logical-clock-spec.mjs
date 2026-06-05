'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { HybridLogicalClock, parseClock } from '../../src/core/clock/hybrid-logical-clock.mjs';

test('HybridLogicalClock creates lexicographically sortable microsecond clocks', () => {
  let now = 1_000;
  let clock = new HybridLogicalClock({
    now: () => now,
    runnerID: 'runner 1',
  });

  let first = clock.tick();
  let second = clock.tick();
  now = 1_001;
  let third = clock.tick();

  assert.equal(first.at, 1_000_000);
  assert.equal(first.clock, '0000000001000000-000000-runner-1');
  assert.equal(second.clock, '0000000001000000-000001-runner-1');
  assert.equal(third.clock, '0000000001001000-000000-runner-1');
  assert.deepEqual([ third.clock, first.clock, second.clock ].sort(), [ first.clock, second.clock, third.clock ]);
});

test('HybridLogicalClock observes remote clocks before ticking again', () => {
  let clock = new HybridLogicalClock({
    now: () => 1_000,
    runnerID: 'local',
  });

  clock.observe('0000000001000000-000005-remote');
  let next = clock.tick();

  assert.equal(next.clock, '0000000001000000-000007-local');
});

test('parseClock rejects malformed clock values', () => {
  assert.equal(parseClock(null), null);
  assert.equal(parseClock('nope'), null);
  assert.equal(parseClock('0000000001000000-notnum-runner'), null);
});
