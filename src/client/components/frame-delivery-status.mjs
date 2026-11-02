'use strict';

// Delivery state for a message a person typed: `neutral` from the moment it
// appears, `received` once the agent has actually been fed the message.
//
// WHY THIS IS NOT IN `tool-frame-summary.mjs`
// That module owns the generic frame status vocabulary, where `success` already
// means "this tool step succeeded" (`SUCCESS_STATUSES`, :19). Delivery is a
// different axis with a different meaning, so it gets its own module and its own
// words. Anything that folds it back into `frameStatus` re-creates the collision
// this file exists to avoid.
//
// WHY THE STORED WORD IS `received` AND NOT `success`
// `content.status = 'complete'` (or any member of `TERMINAL_CONTENT_STATUSES`,
// frame-engine.mjs:18-29) is treated by `normalizeLifecycleState` as terminal and
// durably stamps `state.lifecycle.status = 'closed'`. Marking a person's own
// message closed to serve a display concern would be a silent state mutation of
// their data. `content.delivery` is read by nothing but this module.

export const DELIVERY_NEUTRAL = 'neutral';
export const DELIVERY_RECEIVED = 'received';

// Spoken/tooltip wording. The stored value stays `received`; what a person reads
// says what actually happened.
export const DELIVERY_RECEIVED_LABEL = 'Received by the agent';

// Delivery is rendered with the same success treatment as every other frame,
// not a bespoke caption or edge accent.
export const DELIVERY_SUCCESS_CLASS = 'kikx-frame--status-success';

// Absent means neutral: legacy rows carry no `delivery` key and need no
// migration, and the client must never treat an unknown value as received.
export function frameDeliveryStatus(frame) {
  let value = String(frame?.content?.delivery ?? '').trim().toLowerCase();
  return value === DELIVERY_RECEIVED ? DELIVERY_RECEIVED : DELIVERY_NEUTRAL;
}

// Delivery is a promise about a person's own message reaching the agent, so it
// is only shown on a visible `UserMessage`. A hidden `UserMessage` is a
// coordination wake — a system event that happens to share the frame type — and
// carries no delivery state. The server is the authority for who authored a
// frame (it writes `authorType` at frame-runtime.mjs:523); a transport message
// is written under its own registered type, so `type === 'UserMessage'` already
// means "a person typed this".
export function supportsFrameDelivery(frame) {
  return frame?.type === 'UserMessage'
    && frame?.hidden !== true
    && frame?.deleted !== true;
}

// '' for neutral so the shipped grey bubble keeps its exact current classes.
export function frameDeliveryModifier(frame) {
  if (!supportsFrameDelivery(frame))
    return '';
  let status = frameDeliveryStatus(frame);
  return status === DELIVERY_RECEIVED
    ? ` kikx-frame--delivery-received ${DELIVERY_SUCCESS_CLASS}`
    : '';
}

// Apply the delivery state to a mounted frame item in place. One call site
// (`kikx-frame-item.mjs` `_applyFrameState`), so the class and the dataset can
// never drift apart. Every non-user frame is a no-op: nothing added, nothing
// removed, so a frame that is not a person's message is untouched by this
// feature even if it somehow carried a `delivery` key.
export function applyFrameDelivery(element, frame) {
  if (!element)
    return;

  if (!supportsFrameDelivery(frame)) {
    let wasReceived = element.getAttribute('data-delivery') === DELIVERY_RECEIVED;
    element.removeAttribute('data-delivery');
    if (element.classList)
      element.classList.remove(`kikx-frame--delivery-${DELIVERY_RECEIVED}`);

    // A hidden/deleted UserMessage may previously have been promoted to
    // delivery success, so clear that too. A non-user frame's own generic
    // status class/dataset must be left alone; this function must never erase
    // a tool's success/error state unless the element still carried the
    // delivery marker we are removing.
    if (frame?.type === 'UserMessage' || wasReceived) {
      element.removeAttribute('data-frame-status');
      element.classList?.remove(DELIVERY_SUCCESS_CLASS);
    }
    return;
  }

  let status = frameDeliveryStatus(frame);
  element.dataset.delivery = status;
  if (!element.classList)
    return;

  let modifier = `kikx-frame--delivery-${DELIVERY_RECEIVED}`;
  if (status === DELIVERY_RECEIVED) {
    element.classList.add(modifier, DELIVERY_SUCCESS_CLASS);
    element.dataset.frameStatus = 'success';
  } else {
    element.classList.remove(modifier, DELIVERY_SUCCESS_CLASS);
    element.removeAttribute('data-frame-status');
  }
}
