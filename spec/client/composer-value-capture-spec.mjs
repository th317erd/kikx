'use strict';

// Extra defense: a textarea value assignment is not guaranteed to emit `input`.
// The composer capture wrapper emits `valuechange` before the property changes,
// so a render or cleanup path cannot erase text without first handing the old
// value to the draft controller.

import assert from 'node:assert/strict';
import test from 'node:test';

import { installComposerValueCapture } from '../../src/client/components/composer-value-capture.mjs';

function fakeTextarea() {
  let events = [];
  let node = {
    value: '',
    addEventListener(type, listener) {
      if (type === 'valuechange')
        this._listener = listener;
    },
    dispatchEvent(event) {
      events.push(event);
      return this._listener ? this._listener(event) : true;
    },
    _events: events,
  };
  return node;
}

test('valuechange reports the previous and next value before assignment', () => {
  let textarea = fakeTextarea();
  let seen = [];
  textarea.addEventListener('valuechange', (event) => seen.push(event.detail));
  let uninstall = installComposerValueCapture(textarea);
  textarea.value = 'hello';
  textarea.value = '';

  assert.deepEqual(seen, [
    { previous: '', value: 'hello', source: 'property' },
    { previous: 'hello', value: '', source: 'property' },
  ]);
  uninstall();
});

test('uninstall restores the original value property', () => {
  let textarea = fakeTextarea();
  let uninstall = installComposerValueCapture(textarea);
  uninstall();
  textarea.value = 'after';
  assert.equal(textarea.value, 'after');
});
