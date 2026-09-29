'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HERO_VIEW_TRANSITION_NAME,
  runViewTransition,
  setViewTransitionName,
  supportsViewTransitions,
} from '../../src/client/components/view-transition.mjs';

function win({ reduceMotion = false } = {}) {
  return {
    matchMedia: () => ({ matches: reduceMotion }),
  };
}

test('supportsViewTransitions requires the API and no reduced-motion preference', () => {
  assert.equal(supportsViewTransitions({ startViewTransition() {} }, win()), true);
  assert.equal(supportsViewTransitions({}, win()), false);
  assert.equal(supportsViewTransitions({ startViewTransition() {} }, win({ reduceMotion: true })), false);
  assert.equal(supportsViewTransitions({ startViewTransition() {} }, undefined), true);
});

test('runViewTransition applies immediately when unsupported', async () => {
  let applied = 0;
  let result = await runViewTransition(() => {
    applied++;
    return 'done';
  }, {}, win());

  assert.equal(applied, 1);
  assert.equal(result, 'done');
});

test('runViewTransition runs the change inside startViewTransition when supported', async () => {
  let applied = 0;
  let started = 0;
  let doc = {
    startViewTransition(callback) {
      started++;
      callback();
      return { finished: Promise.resolve() };
    },
  };

  await runViewTransition(() => { applied++; }, doc, win());

  assert.equal(started, 1);
  assert.equal(applied, 1);
});

test('setViewTransitionName sets and clears the element name', () => {
  let element = { style: {} };

  setViewTransitionName(element, HERO_VIEW_TRANSITION_NAME);
  assert.equal(element.style.viewTransitionName, HERO_VIEW_TRANSITION_NAME);

  setViewTransitionName(element, '');
  assert.equal(element.style.viewTransitionName, '');
});

test('setViewTransitionName tolerates missing elements and styles', () => {
  assert.doesNotThrow(() => setViewTransitionName(null, 'x'));
  assert.doesNotThrow(() => setViewTransitionName({}, 'x'));
});
