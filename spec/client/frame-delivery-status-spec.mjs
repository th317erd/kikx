'use strict';

// Client half of user-message delivery: the state must be visible on the frame
// item and readable by assistive technology on the bubble.
//
// The failure this guards against is silent: a `UserMessage` is not a "tinted"
// frame (BOT_COMMUNICATION_TYPES is AgentMessage/AgentMessageDelta/AgentProgress),
// so without an explicit code path the delivery value would persist to the
// database, reach `frame.updated`, and never change a single pixel.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DELIVERY_NEUTRAL,
  DELIVERY_RECEIVED,
  applyFrameDelivery,
  frameDeliveryModifier,
  frameDeliveryStatus,
  supportsFrameDelivery,
} from '../../src/client/components/frame-delivery-status.mjs';

function userFrame(content = {}) {
  return {
    id: 'user-1',
    type: 'UserMessage',
    authorType: 'user',
    hidden: false,
    deleted: false,
    content: { text: 'Please implement it.', ...content },
  };
}

test('absent or unknown delivery reads as neutral, never as received', () => {
  assert.equal(frameDeliveryStatus(userFrame()), DELIVERY_NEUTRAL);
  assert.equal(frameDeliveryStatus(userFrame({ delivery: '' })), DELIVERY_NEUTRAL);
  assert.equal(frameDeliveryStatus(userFrame({ delivery: 'bogus' })), DELIVERY_NEUTRAL);
  assert.equal(frameDeliveryStatus(undefined), DELIVERY_NEUTRAL);
});

test('received is matched case- and whitespace-insensitively', () => {
  assert.equal(frameDeliveryStatus(userFrame({ delivery: ' RECEIVED ' })), DELIVERY_RECEIVED);
});

test('neutral adds no class at all, so the shipped grey bubble is unchanged', () => {
  assert.equal(frameDeliveryModifier(userFrame()), '');
  assert.equal(frameDeliveryModifier(userFrame({ delivery: 'neutral' })), '');
});

test('received contributes its modifier class exactly once', () => {
  assert.equal(
    frameDeliveryModifier(userFrame({ delivery: 'received' })),
    ' kikx-frame--delivery-received',
  );
});

test('hidden and deleted user messages carry no delivery state', () => {
  // A coordination wake is a hidden UserMessage: a system event, not a person's
  // message. Claiming an agent "received" it would be meaningless.
  assert.equal(supportsFrameDelivery(userFrame({ delivery: 'received' })), true);
  assert.equal(
    supportsFrameDelivery({ ...userFrame({ delivery: 'received' }), hidden: true }),
    false,
  );
  assert.equal(
    supportsFrameDelivery({ ...userFrame({ delivery: 'received' }), deleted: true }),
    false,
  );
  assert.equal(frameDeliveryModifier({ ...userFrame({ delivery: 'received' }), hidden: true }), '');
});

// Real mini-dom elements, not a hand-rolled stub. `dataset` is a live Proxy over
// `data-*` attributes there (mini-dom.mjs:160-177), so dataset and attributes are
// one store. A stub with a plain object makes removeAttribute() and
// dataset.foo look like two independent stores and produces false failures.
async function fakeElement() {
  const { installDom } = await import('./support/mini-dom.mjs');
  const { document } = installDom();
  return document.createElement('div');
}

test('applying delivery adds the modifier class and the dataset value', async () => {
  let element = await fakeElement();
  applyFrameDelivery(element, userFrame({ delivery: 'received' }));

  assert.equal(element.dataset.delivery, 'received');
  assert.equal(element.classList.contains('kikx-frame--delivery-received'), true);
});

test('applying neutral adds the dataset value but no modifier class', async () => {
  let element = await fakeElement();
  applyFrameDelivery(element, userFrame({ delivery: 'neutral' }));

  assert.equal(element.dataset.delivery, 'neutral');
  assert.equal(element.classList.contains('kikx-frame--delivery-received'), false);
});

test('a later neutral update removes a previously applied modifier', async () => {
  // Delivery is one-way today, but the reconcile path must still be able to
  // clear it: otherwise a stale class survives an authoritative server value.
  let element = await fakeElement();
  applyFrameDelivery(element, userFrame({ delivery: 'received' }));
  assert.equal(element.classList.contains('kikx-frame--delivery-received'), true);

  applyFrameDelivery(element, userFrame({ delivery: 'neutral' }));
  assert.equal(element.classList.contains('kikx-frame--delivery-received'), false);
  assert.equal(element.dataset.delivery, 'neutral');
});

test('applying to a non-user frame leaves no delivery marker behind', async () => {
  let element = await fakeElement();
  applyFrameDelivery(element, userFrame({ delivery: 'received' }));
  applyFrameDelivery(element, { ...userFrame({ delivery: 'received' }), type: 'AgentMessage' });

  // `data-delivery` is removed outright, not set to the string 'undefined'.
  assert.equal(element.hasAttribute('data-delivery'), false);
  assert.equal(element.classList.contains('kikx-frame--delivery-received'), false);
});

test('applying to a null element is a no-op, not a throw', () => {
  assert.doesNotThrow(() => applyFrameDelivery(null, userFrame({ delivery: 'received' })));
});

test('non-user frames carry no delivery state', () => {
  for (let type of [ 'AgentMessage', 'AgentProgress', 'ToolResult', 'Question' ]) {
    let frame = { ...userFrame({ delivery: 'received' }), type };
    assert.equal(supportsFrameDelivery(frame), false, type);
    assert.equal(frameDeliveryModifier(frame), '', type);
  }
});
