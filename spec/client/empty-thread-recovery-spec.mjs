'use strict';

// An empty thread must offer a way out, not a sentence pointing at a header
// control the user may not associate with the emptiness.
//
// Observed failure state: `kikx-navigation.mjs:342-349` catches a load error,
// writes `state.status = error.message`, and re-renders. With no frames loaded,
// `buildFrameThread` fell through to "No messages yet." So the user saw an error
// in the statusline and an empty thread claiming the session was empty, and the
// only remedy was to find the frame-filter popup in the header. Worse, when
// frames existed but every category was off, the empty state contained only
// prose — "Open the frame filter (the eye in the header) and turn categories
// back on." — with nothing to press. Prose is not an affordance.
//
// These assertions are about behaviour: the button is rendered, it is labelled,
// and pressing it calls the app handler that is already bound
// (`kikx-app.mjs:245`). They deliberately do not assert a class name, so a
// restyle of the empty state cannot silently drop the fix.

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

import { installDom } from './support/mini-dom.mjs';

register(new URL('./support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);

const { document } = installDom();
document.addEventListener = () => {};
document.removeEventListener = () => {};
globalThis.document = document;

const { buildFrameThread } = await import('../../src/client/components/kikx-shell-builders.mjs');

// --- helpers ---------------------------------------------------------------

// Minimal app stand-in. `buildFrameThread` reads `_state` and calls handlers;
// `_clearFrameFilters` is bound on the real app to `clearFrameFilters(app)`,
// which resets every filter category.
function createApp(state = {}) {
  let calls = { clearFrameFilters: 0 };
  let app = {
    _state: {
      selectedSessionID: 'ses_1',
      framesBySessionID: {},
      frameFilters: {
        user: true, agent: true, question: true, session: true,
        tools: true, commands: true, compaction: true, deleted: false,
      },
      status: '',
      statusKind: 'ready',
      ...state,
    },
    _clearFrameFilters: () => { calls.clearFrameFilters += 1; },
    _createSession: () => {},
  };

  return { app, calls };
}

function walk(node, predicate, found = []) {
  if (!node || typeof node !== 'object')
    return found;

  if (predicate(node))
    found.push(node);

  for (let child of node.childNodes || [])
    walk(child, predicate, found);

  return found;
}

function buttons(root) {
  return walk(root, (node) => String(node?.tagName || '').toUpperCase() === 'BUTTON');
}

function textOf(node) {
  return String(node?.textContent || '').replace(/\s+/g, ' ').trim();
}

function press(node) {
  node.dispatchEvent({ type: 'click' });
}

// --- the error state ------------------------------------------------------

test('a failed load does not masquerade as an empty session', () => {
  let { app } = createApp({
    statusKind: 'error',
    status: 'AeorDB multi-fetch returned non-JSON content for /x.json',
  });

  let text = textOf(buildFrameThread(app));

  assert.match(text, /could not be loaded/);
  assert.match(text, /non-JSON content/, 'the real cause is shown, not swallowed');
  assert.doesNotMatch(text, /No messages yet/, 'an unreadable session is not an empty one');
});

test('the error state offers a real "Show all frames" control', () => {
  let { app, calls } = createApp({ statusKind: 'error', status: 'boom' });

  let [ action ] = buttons(buildFrameThread(app));

  assert.ok(action, 'the error empty state contains a button');
  assert.equal(textOf(action), 'Show all frames');

  press(action);

  assert.equal(calls.clearFrameFilters, 1, 'pressing it clears the frame filters');
});

// --- the filtered state ---------------------------------------------------

test('a filtered-out thread offers a real control, not just prose', () => {
  // The session holds a frame, but the only frame is soft-deleted and the
  // Deleted row is off, so nothing is renderable. `hasAnyFrames` counts
  // soft-deleted frames deliberately, which is what distinguishes "you
  // filtered it away" from "there is nothing here".
  let frames = [ { id: 'f_1', type: 'UserMessage', deleted: true, content: { text: 'gone' } } ];
  let { app, calls } = createApp({
    framesBySessionID: { ses_1: frames },
    frameFilters: {
      user: true, agent: true, question: true, session: true,
      tools: true, commands: true, compaction: true, deleted: false,
    },
  });

  let root = buildFrameThread(app);

  assert.match(textOf(root), /No frames match the current filters/);

  let [ action ] = buttons(root);
  assert.ok(action, 'the filtered empty state contains a button');
  assert.equal(textOf(action), 'Show all frames');

  press(action);

  assert.equal(calls.clearFrameFilters, 1);
});

// --- genuinely empty ------------------------------------------------------

test('a session with no frames at all keeps its invite hint and adds no filter control', () => {
  let { app } = createApp({ statusKind: 'ready' });
  let root = buildFrameThread(app);

  assert.match(textOf(root), /No messages yet/);
  // There is nothing to un-filter, so offering the control would be noise.
  assert.equal(buttons(root).length, 0);
});
