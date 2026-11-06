'use strict';

// =============================================================================
// Owner-approved fixes (2026-11-06): session portals, answer visibility, mirror
// =============================================================================
// Ruling, in the owner's shape: session cards are for SESSION FRAMES only
// ("session portals"); an answer frame must show the original question and the
// answer, with the origin as a plain LINK to the session and message where the
// agent asked — no heavy card inside a UserMessage; and navigating into the
// session already on the stack must not build the infinite mirror
// (Session 1 > Session 1 > Session 1...).
//
// The defect chain this pins: `frameContentDescriptor` let ANY session
// reference override the descriptor to `kikx-sub-session-frame`, so a question
// wake answer (which carries "this session" provenance) rendered as a LIVE
// portal of the very session it sat in — hiding the Q+A entirely — and clicking
// the portal stacked another copy of the same session in the stack.

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

import { installDom } from './support/mini-dom.mjs';

register(new URL('./support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);
const { document } = installDom();
globalThis.document = document;

const { frameContentDescriptor } = await import('../../src/client/components/kikx-frame-item-helpers.mjs');
await import('../../src/client/components/kikx-user-message-frame.mjs');
const { pushThread, normalizeNavigationStack, createNavigationStack } =
  await import('../../src/client/state/navigation-stack.mjs');

function wakeFrame(overrides = {}) {
  return {
    id: 'wake-1',
    type: 'UserMessage',
    sessionID: 'sess-1',
    interactionID: 'question:q-1',
    parentID: 'question-frame-1',
    hidden: false,
    deleted: false,
    content: {
      text: 'The user answered your question (you asked 18h ago):\n\nQ: Should we?\nA: Yes\n\n'
        + 'References from when you asked:\n- session sess-1: Session 1',
      references: [
        { type: 'question', id: 'q-1' },
        { type: 'session', id: 'sess-1', label: 'Session 1' },
      ],
    },
    ...overrides,
  };
}

function collectText(root) {
  let text = '';
  (function walk(node) {
    if (!node) return;
    if (node.nodeType === 3) text += `${node.textContent || ''} `;
    for (const child of node.childNodes || []) walk(child);
  })(root);
  return text;
}

function findNode(root, predicate) {
  if (!root) return null;
  if (predicate(root)) return root;
  for (const child of root.childNodes || []) {
    const hit = findNode(child, predicate);
    if (hit) return hit;
  }
  return null;
}

// ---------------------------------------------------------------------------
// A. Portals are reserved for session frames
// ---------------------------------------------------------------------------

test('a session reference must NOT hijack the descriptor of a non-session frame', () => {
  let descriptor = frameContentDescriptor(wakeFrame(), {});
  assert.ok(descriptor, 'a descriptor is produced');
  assert.notEqual(descriptor.kind, 'sub-session',
    'session portals are reserved for SessionFrames — a wake answer renders its own content');
  assert.notEqual(descriptor.tagName, 'kikx-sub-session-frame',
    'the live portal element must never be selected for a UserMessage');
});

test('a Session frame with a session reference still portals', () => {
  let descriptor = frameContentDescriptor({
    id: 'sess-frame',
    type: 'Session',
    sessionID: 'sess-1',
    content: { references: [ { type: 'session', id: 'sess-child', label: 'Child' } ] },
  }, {});
  assert.equal(descriptor.kind, 'sub-session',
    'SessionFrames keep their portal — cards are reserved for them, not stripped');
  assert.equal(descriptor.tagName, 'kikx-sub-session-frame');
});

test('a tool result with a session reference still portals (existing contract)', () => {
  let descriptor = frameContentDescriptor({
    id: 'tool-1',
    type: 'ShellToolFrame',
    sessionID: 'sess-1',
    content: {
      toolName: 'shell',
      references: [ { type: 'session', id: 'child-1', label: 'Child session' } ],
    },
  }, {});
  assert.equal(descriptor.kind, 'sub-session',
    'tool results that discovered a child session are the feature original home — untouched');
});

// ---------------------------------------------------------------------------
// B. Answer frames show question + answer + a plain origin link
// ---------------------------------------------------------------------------

test('answer frames render Q + A and a plain origin link, never the heavy card', () => {
  let element = document.createElement('kikx-user-message-frame');
  element.updateFrame(wakeFrame(), {});

  let text = collectText(element);
  assert.match(text, /Q: Should we\?/, 'the original question must be visible');
  assert.match(text, /A: Yes/, 'the answer must be visible');
  assert.match(text, /References from when you asked/,
    'plain-text references stay (they cost nothing)');

  let link = findNode(element, (node) => node.localName === 'a'
    && String(node.getAttribute?.('href') || '').includes('message=question-frame-1'));
  assert.ok(link, 'a plain link to the asking session AND message must exist');
  assert.equal(link.getAttribute('href'), '?session=sess-1#message=question-frame-1',
    'the origin link targets the session and the question frame');

  let portal = findNode(element, (node) => node.localName === 'kikx-sub-session-frame');
  assert.equal(portal, null, 'no portal inside a UserMessage — owner ruling');

  let plain = document.createElement('kikx-user-message-frame');
  plain.updateFrame({ id: 'u2', type: 'UserMessage', sessionID: 'sess-1', content: { text: 'hello' } }, {});
  assert.equal(findNode(plain, (node) => node.localName === 'a'), null,
    'a message with no question interaction gains no origin link (no dead affordance)');
});

// ---------------------------------------------------------------------------
// C. pushThread is idempotent; normalize heals mirror stacks
// ---------------------------------------------------------------------------

test('pushThread refuses to stack the session already on top (mirror guard)', () => {
  let stack = createNavigationStack();
  let once = pushThread(stack, 'S1');
  assert.equal(once.length, 2, 'first entry pushes');

  let twice = pushThread(once, 'S1');
  assert.equal(twice.length, 2,
    're-entering the current session must be a no-op — this is the infinite mirror');

  let deeper = pushThread(twice, 'S2');
  assert.equal(deeper.length, 3, 'a DIFFERENT session still drills in');
});

test('normalize collapses consecutive session repeats but keeps real history', () => {
  let mirror = normalizeNavigationStack([
    { sessionID: null, collapsed: true },
    { sessionID: 'S1', collapsed: false },
    { sessionID: 'S1', collapsed: false },
    { sessionID: 'S1', collapsed: false },
  ]);
  assert.deepEqual(mirror.map((entry) => entry.sessionID), [ null, 'S1' ],
    'an already-shared mirror URL heals to a single entry');

  let realHistory = normalizeNavigationStack([
    { sessionID: null, collapsed: true },
    { sessionID: 'S1', collapsed: false },
    { sessionID: 'S2', collapsed: false },
    { sessionID: 'S1', collapsed: false },
  ]);
  assert.deepEqual(realHistory.map((entry) => entry.sessionID), [ null, 'S1', 'S2', 'S1' ],
    'non-consecutive repeats are real navigation history and must survive');
});
