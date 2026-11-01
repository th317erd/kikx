'use strict';

// DOM-level proof for user-message delivery.
//
// The unit spec proves the pure helpers; this proves the rendered element. The
// specific hazard: `kikx-frame-item` only applies a status tint to
// `BOT_COMMUNICATION_TYPES` (AgentMessage/AgentMessageDelta/AgentProgress), so a
// UserMessage never enters that branch. If the delivery modifier were not added
// deliberately, the state would persist, reach `frame.updated`, and never appear.
//
// Also asserted: the text node survives the transition. `updateFrame` runs
// `_ensureStructure()` on every call, and a rebuild there is the exact class of
// bug that has wiped an in-progress render before.

import assert from 'node:assert/strict';
import test from 'node:test';

function userFrame(content = {}) {
  return {
    id: 'user-1',
    type: 'UserMessage',
    sessionID: 'ses_1',
    authorType: 'user',
    authorID: 'usr_1',
    authorDisplayName: 'Wyatt',
    hidden: false,
    deleted: false,
    timestamp: 1,
    createdAt: 1,
    updatedAt: 1,
    content: { text: 'Please implement delivery status', ...content },
  };
}

async function loadBubble() {
  const { installDom } = await import('./support/mini-dom.mjs');
  const { document } = installDom();
  globalThis.document = document;
  document.body.replaceChildren?.();
  await import('../../src/client/components/kikx-user-message-frame.mjs');
  return document;
}

test('the bubble starts with no delivery attribute and none after a neutral update', async () => {
  let document = await loadBubble();
  let element = document.createElement('kikx-user-message-frame');
  document.body.appendChild(element);

  element.updateFrame(userFrame(), {});

  assert.equal(element.getAttribute('data-delivery'), null);
  assert.equal(element.getAttribute('aria-label'), null);
});

test('a received frame announces itself and keeps its rendered text node', async () => {
  let document = await loadBubble();
  let element = document.createElement('kikx-user-message-frame');
  document.body.appendChild(element);

  element.updateFrame(userFrame(), {});
  let before = element.querySelector('.kikx-user-message__text');
  assert.ok(before);
  assert.match(before.textContent, /delivery status/);

  element.updateFrame(userFrame({ delivery: 'received' }), {});

  assert.equal(element.getAttribute('data-delivery'), 'received');
  assert.equal(element.getAttribute('aria-label'), 'Received by the agent');

  let after = element.querySelector('.kikx-user-message__text');
  // Same node: the transition toggles state in place instead of rebuilding.
  assert.equal(after, before);
  assert.match(after.textContent, /delivery status/);
});

test('an explicit received frame mounts with the state already set', async () => {
  let document = await loadBubble();
  let element = document.createElement('kikx-user-message-frame');
  document.body.appendChild(element);

  element.updateFrame(userFrame({ delivery: 'received' }), {});
  assert.equal(element.getAttribute('data-delivery'), 'received');
});

test('an unknown delivery value is not treated as received', async () => {
  let document = await loadBubble();
  let element = document.createElement('kikx-user-message-frame');
  document.body.appendChild(element);

  element.updateFrame(userFrame({ delivery: 'bogus' }), {});
  assert.equal(element.getAttribute('data-delivery'), null);
  assert.equal(element.getAttribute('aria-label'), null);
});
