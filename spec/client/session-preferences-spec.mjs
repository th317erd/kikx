'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

import { installDom } from './support/mini-dom.mjs';
import { OCR_IMAGE_PROXY_PREFERENCE } from '../../src/shared/session-preferences.mjs';

// kikx-state reaches the browser-only AEOR UI through /vendor paths; the shared
// loader plus mini DOM is the same harness the other state specs use.
register(new URL('./support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);
installDom();

const {
  getSessionEffectivePreferences,
  getSessionPreference,
} = await import('../../src/client/state/kikx-state.mjs');

test('client effective preferences cascade from ancestors and prefer the nearest value', () => {
  let state = {
    sessionDetailsByID: {
      root: { id: 'root', parentSessionID: null, preferences: { [OCR_IMAGE_PROXY_PREFERENCE]: false, theme: 'dark' } },
      child: { id: 'child', parentSessionID: 'root', preferences: { theme: 'blue' } },
      grandchild: { id: 'grandchild', parentSessionID: 'child', preferences: {} },
    },
  };

  assert.deepEqual(getSessionEffectivePreferences(state, 'grandchild'), {
    [OCR_IMAGE_PROXY_PREFERENCE]: false,
    theme: 'blue',
  });
  assert.equal(getSessionPreference(state, 'grandchild', OCR_IMAGE_PROXY_PREFERENCE), false);
  assert.equal(getSessionPreference(state, 'grandchild', OCR_IMAGE_PROXY_PREFERENCE, true), false);
  assert.equal(getSessionPreference(state, 'grandchild', 'unknown.key', 'fallback'), 'fallback');
});

test('client falls back to server-supplied effective preferences when an ancestor is not loaded', () => {
  let state = {
    sessionDetailsByID: {
      orphan: {
        id: 'orphan',
        parentSessionID: 'missing_parent',
        preferences: { theme: 'blue' },
        effectivePreferences: { [OCR_IMAGE_PROXY_PREFERENCE]: false, theme: 'dark', inherited: true },
      },
    },
  };

  assert.deepEqual(getSessionEffectivePreferences(state, 'orphan'), {
    [OCR_IMAGE_PROXY_PREFERENCE]: false,
    theme: 'dark',
    inherited: true,
  });
});
