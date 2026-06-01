'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldSubmitComposerKey } from '../../src/client/components/composer-keyboard.mjs';

test('shouldSubmitComposerKey allows plain Enter', () => {
  assert.equal(shouldSubmitComposerKey({ key: 'Enter' }), true);
});

test('shouldSubmitComposerKey lets Shift+Enter create a newline', () => {
  assert.equal(shouldSubmitComposerKey({ key: 'Enter', shiftKey: true }), false);
});

test('shouldSubmitComposerKey ignores modified Enter shortcuts', () => {
  assert.equal(shouldSubmitComposerKey({ key: 'Enter', altKey: true }), false);
  assert.equal(shouldSubmitComposerKey({ key: 'Enter', ctrlKey: true }), false);
  assert.equal(shouldSubmitComposerKey({ key: 'Enter', metaKey: true }), false);
});

test('shouldSubmitComposerKey ignores non-Enter and composing events', () => {
  assert.equal(shouldSubmitComposerKey({ key: 'a' }), false);
  assert.equal(shouldSubmitComposerKey({ key: 'Enter', isComposing: true }), false);
  assert.equal(shouldSubmitComposerKey(null), false);
});
