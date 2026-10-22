'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { MOOD_MAX, MOOD_MIN, moodBand, normalizeMood } from '../../src/shared/mood.mjs';

test('normalizeMood accepts a continuous score in the inclusive range', () => {
  assert.equal(normalizeMood(-3), -3);
  assert.equal(normalizeMood(-1.25), -1.25);
  assert.equal(normalizeMood(0), 0);
  assert.equal(normalizeMood(2.5), 2.5);
  assert.equal(normalizeMood(3), 3);
  assert.equal(MOOD_MIN, -3);
  assert.equal(MOOD_MAX, 3);
});

test('normalizeMood rejects missing, non-finite, and out-of-range scores', () => {
  for (let value of [ undefined, null, '', 'no', NaN, Infinity, -3.01, 3.01 ])
    assert.throws(() => normalizeMood(value), TypeError, String(value));
});

test('moodBand uses the requested strict gates', () => {
  assert.equal(moodBand(-3), 'bad');
  assert.equal(moodBand(-1.01), 'bad');
  assert.equal(moodBand(-1), 'meh');
  assert.equal(moodBand(0), 'meh');
  assert.equal(moodBand(1), 'meh');
  assert.equal(moodBand(1.01), 'good');
  assert.equal(moodBand(3), 'good');
  assert.equal(moodBand('nope'), '');
});
