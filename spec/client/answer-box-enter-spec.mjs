'use strict';

// Enter submits the answer, exactly as it does in the main message composer.
//
// Owner report, verbatim: "Pressing enter should submit this answer, just like
// the main 'Message' area for the user already does (and Shift + Enter and
// Alt + Enter should do a newline instead of submit)".
//
// The bug is structural rather than a typo. The answer box is a <textarea> in a
// <form>, and a textarea's HTML default for Enter is "insert a newline" — it
// never submits. So the box silently ignored the key everyone presses, while
// the composer next to it submitted. Two inputs, two different keymaps.
//
// What this spec pins:
//   1. Enter submits.
//   2. Shift+Enter, Alt+Enter (and Ctrl/Meta, and an in-progress IME
//      composition) insert a newline and do NOT submit.
//   3. The rule is the shared one from composer-keyboard.mjs, not a second
//      hand-rolled copy — asserted directly, so the two surfaces cannot drift.
//   4. Both surfaces are covered: the inline Question frame and the Inbox card
//      render the same form, and fixing only one would leave the user's
//      annoyance present in the other.

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

import { installDom } from './support/mini-dom.mjs';

register(new URL('./support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);

installDom();

const { KikxQuestionFrame } = await import('../../src/client/components/kikx-question-frame.mjs');
const { shouldSubmitComposerKey } = await import('../../src/client/components/composer-keyboard.mjs');

// --- DOM helpers (mini-dom has no querySelector engine; walk the tree) ------

function walk(node, out = []) {
  for (let child of node?.childNodes || []) {
    out.push(child);
    walk(child, out);
  }
  return out;
}

function byTag(node, tagName) {
  return walk(node).filter((child) => child.localName === tagName);
}

function appSpy(result = { ok: true, delivered: true }) {
  let calls = [];
  return {
    calls,
    app: {
      _submitQuestionAnswer(questionID, text, options) {
        calls.push({ questionID, text, options });
        return Promise.resolve(result);
      },
    },
  };
}

function mountFrame(appState = {}) {
  let el = document.createElement('kikx-question-frame');
  assert.ok(el instanceof KikxQuestionFrame);
  el.updateFrame({
    id: 'frame_1',
    type: 'Question',
    content: {
      question: {
        id: 'q_1',
        groupID: 'grp_1',
        index: 1,
        status: 'open',
        mode: 'wait',
        sessionID: 'ses_1',
        agentID: 'agent-1',
        text: 'Where did that stack trace come from?',
        priority: 'normal',
        askedAt: Date.now() - 60_000,
      },
    },
  }, appState);
  return el;
}

// A keydown shaped like a real one. mini-dom wraps `preventDefault` itself and
// makes `dispatchEvent` return false when a cancelable event was claimed, which
// is exactly how a browser reports "the default action (inserting a newline) was
// suppressed". So the fake must NOT define `defaultPrevented`: it is a getter on
// the shim's side, and writing to it throws.
function keydown(key, modifiers = {}) {
  return {
    type: 'keydown',
    key,
    cancelable: true,
    shiftKey: modifiers.shiftKey === true,
    altKey: modifiers.altKey === true,
    ctrlKey: modifiers.ctrlKey === true,
    metaKey: modifiers.metaKey === true,
    isComposing: modifiers.isComposing === true,
    preventDefault: () => {},
    stopPropagation: () => {},
  };
}

// Returns false when the handler claimed the key, i.e. when submitting won and
// the textarea did not get to insert a newline.
function press(box, event) {
  return box.dispatchEvent(event);
}

// --- the shared rule -------------------------------------------------------

test('the shared composer rule submits on plain Enter only', () => {
  assert.equal(shouldSubmitComposerKey(keydown('Enter')), true);
  assert.equal(shouldSubmitComposerKey(keydown('Enter', { shiftKey: true })), false);
  assert.equal(shouldSubmitComposerKey(keydown('Enter', { altKey: true })), false);
  assert.equal(shouldSubmitComposerKey(keydown('Enter', { ctrlKey: true })), false);
  assert.equal(shouldSubmitComposerKey(keydown('Enter', { metaKey: true })), false);
  assert.equal(shouldSubmitComposerKey(keydown('Enter', { isComposing: true })), false);
  assert.equal(shouldSubmitComposerKey(keydown('a')), false);
  // A missing event must not throw from inside a DOM handler.
  assert.equal(shouldSubmitComposerKey(null), false);
});

// --- the inline Question frame ---------------------------------------------

test('Enter in the frame answer box submits the typed answer', () => {
  let { calls, app } = appSpy();
  let el = mountFrame({ app });
  let box = byTag(el, 'textarea')[0];
  assert.ok(box, 'the frame must render an answer box');

  box.value = 'I copied it from the terminal';

  let accepted = press(box, keydown('Enter'));
  assert.equal(accepted, false,
    'Enter must be claimed, otherwise the textarea also inserts a newline');
  assert.equal(calls.length, 1, 'Enter must submit exactly once');
  assert.equal(calls[0].text, 'I copied it from the terminal');
});

test('Shift+Enter and Alt+Enter insert a newline in the frame instead of submitting', () => {
  let { calls, app } = appSpy();
  let el = mountFrame({ app });
  let box = byTag(el, 'textarea')[0];
  box.value = 'line one';

  let shift = press(box, keydown('Enter', { shiftKey: true }));
  assert.equal(shift, true,
    'Shift+Enter must be left to the textarea so it becomes a newline');

  let alt = press(box, keydown('Enter', { altKey: true }));
  assert.equal(alt, true, 'Alt+Enter must become a newline');

  assert.equal(calls.length, 0, 'neither modifier may submit');
});

test('Enter on an empty frame box submits nothing', () => {
  let { calls, app } = appSpy();
  let el = mountFrame({ app });
  let box = byTag(el, 'textarea')[0];
  box.value = '   ';

  press(box, keydown('Enter'));
  assert.equal(calls.length, 0, 'an empty answer must not be posted');
});

test('a second Enter while the send is in flight does not double-submit', () => {
  let calls = [];
  // A never-resolving send keeps the frame in its busy phase.
  let app = {
    _submitQuestionAnswer(questionID, text, options) {
      calls.push({ questionID, text, options });
      return new Promise(() => {});
    },
  };
  let el = mountFrame({ app });
  let box = byTag(el, 'textarea')[0];
  box.value = 'answer';

  press(box, keydown('Enter'));
  press(box, keydown('Enter'));

  assert.equal(calls.length, 1, 'Enter must not post twice while a send is in flight');
});

// --- the Inbox card renders the same form -------------------------------------
// The screenshot that reported this annoyance was the Inbox card, not the inline
// frame. Both must obey one rule, so this half is asserted rather than assumed.

const { renderQuestionCard, bindAnswerForm } = await import('../../src/client/components/kikx-question-card.mjs');

function mountCard(handlers) {
  let app = { ownerDocument: document, isConnected: true };
  let node = renderQuestionCard(app, {
    id: 'q_card',
    status: 'open',
    mode: 'wait',
    sessionID: 'ses_1',
    agentID: 'agent-1',
    text: 'Which branch?',
    askedAt: Date.now() - 1_000,
  });
  assert.ok(node, 'the card must render for an open question');
  bindAnswerForm(node, handlers);
  return node;
}

test('Enter in the Inbox card submits, Shift+Enter newlines', () => {
  let submitted = [];
  let node = mountCard({ onSubmit: (questionID, text) => { submitted.push({ questionID, text }); return Promise.resolve({ ok: true }); } });
  let box = byTag(node, 'textarea')[0];
  assert.ok(box, 'the card must render an answer box');

  box.value = 'the release branch';
  let shift = press(box, keydown('Enter', { shiftKey: true }));
  assert.equal(shift, true, 'Shift+Enter must reach the textarea as a newline');
  assert.equal(submitted.length, 0, 'Shift+Enter must not submit');

  let plain = press(box, keydown('Enter'));
  assert.equal(plain, false, 'plain Enter must be claimed for submitting');
  assert.equal(submitted.length, 1, 'plain Enter must submit once');
  assert.equal(submitted[0].text, 'the release branch');
});
