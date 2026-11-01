'use strict';

import { installRuntimeMethods } from './frame-runtime-mixins.mjs';

const MODEL_PROMPT_VERSION = 1;

const promptMethods = {
  // Persist the exact message list a provider is about to send with the user
  // frame that triggered the turn. This is a silent update to an existing
  // visible UserMessage: it changes no ordering, routes nothing, and leaves the
  // user's text untouched. Hidden/internal wakes are intentionally ignored.
  async recordModelPrompt(sessionID, frameID, prompt = {}) {
    let normalizedSessionID = normalizeID(sessionID);
    let normalizedFrameID = normalizeID(frameID);
    if (!normalizedSessionID || !normalizedFrameID)
      return null;

    let messages = Array.isArray(prompt.messages) ? prompt.messages : [];
    if (messages.length === 0)
      return null;

    let entry = await this.ensureSessionEntry(normalizedSessionID);
    let existing = entry.frameEngine.get(normalizedFrameID)
      || await findRawFrame(this, normalizedSessionID, normalizedFrameID);
    if (!existing
      || existing.type !== 'UserMessage'
      || existing.authorType !== 'user'
      || existing.hidden === true
      || existing.deleted === true)
      return null;

    let stamp = this.nextClockStamp();
    let now = stamp.at;
    let userText = typeof prompt.userText === 'string'
      ? prompt.userText
      : (typeof existing.content?.text === 'string' ? existing.content.text : '');
    let modelPrompt = {
      version: MODEL_PROMPT_VERSION,
      capturedAt: Number.isFinite(Number(prompt.capturedAt)) ? Number(prompt.capturedAt) : now,
      agentID: normalizeOptionalID(prompt.agentID),
      agentName: normalizeOptionalID(prompt.agentName),
      userText,
      messageText: typeof prompt.messageText === 'string' ? prompt.messageText : userText,
      messages,
    };
    let frame = {
      ...existing,
      updatedAt: now,
      updatedClock: stamp.clock,
      content: {
        ...(existing.content || {}),
        modelPrompt,
      },
    };
    let merged = entry.frameEngine.merge([ frame ], {
      authorType: 'user',
      authorID: existing.authorID || null,
      silent: true,
    });
    await this.frameStore?.flush?.();
    return merged[0] || frame;
  },

  // Record that this UserMessage actually reached the provider, i.e. the agent
  // began consuming it. Display-only: this is the only writer of `delivery`.
  //
  // WHY `content.delivery` AND NOT `content.status`
  // `TERMINAL_CONTENT_STATUSES` (frame-engine.mjs:18-29) is consulted by
  // `normalizeLifecycleState` on every merge, and a terminal `content.status`
  // permanently stamps `state.lifecycle.status = 'closed'`. Writing
  // `status: 'complete'` here would durably close a message the person
  // authored - a silent state mutation of user data to serve a display concern.
  // Measured, both variants on a real merged UserMessage:
  //   content.status = 'complete'  -> lifecycle {status:'closed',reason:'complete'}
  //   content.delivery = 'received'-> lifecycle null (untouched)
  // `success` is no safer than `complete`: it is the generic "this tool step
  // succeeded" vocabulary (SUCCESS_STATUSES, tool-frame-summary.mjs:19) and
  // would present the bubble as a finished tool card. `received` states what
  // happened and collides with neither meaning.
  //
  // Idempotent by construction: an already-delivered frame returns the existing
  // row and writes nothing, so the provider retry ladder cannot emit one commit
  // per attempt. Hidden frames are excluded, which is what keeps coordination
  // wakes out of this: they are persisted as hidden `UserMessage`s.
  async markFrameDelivered(sessionID, frameID) {
    let normalizedSessionID = normalizeID(sessionID);
    let normalizedFrameID = normalizeID(frameID);
    if (!normalizedSessionID || !normalizedFrameID)
      return null;

    let entry = await this.ensureSessionEntry(normalizedSessionID);
    let existing = entry.frameEngine.get(normalizedFrameID)
      || await findRawFrame(this, normalizedSessionID, normalizedFrameID);
    if (!existing
      || existing.type !== 'UserMessage'
      || existing.authorType !== 'user'
      || existing.hidden === true
      || existing.deleted === true)
      return null;

    if (existing.content?.delivery === 'received')
      return existing;

    let stamp = this.nextClockStamp();
    let now = stamp.at;
    let frame = {
      ...existing,
      updatedAt: now,
      updatedClock: stamp.clock,
      content: {
        ...(existing.content || {}),
        delivery: 'received',
        deliveryAt: now,
      },
    };
    // `silent: true` is load-bearing, not cosmetic: it suppresses ROUTING
    // (frame-router.mjs:41,56,171) while still publishing `frame.updated`. A
    // non-silent merge would re-enter the router and could start a second turn
    // off the very message that just started this one.
    let merged = entry.frameEngine.merge([ frame ], {
      authorType: 'user',
      authorID: existing.authorID || null,
      silent: true,
    });
    await this.frameStore?.flush?.();
    return merged[0] || frame;
  },
};

function normalizeID(value) {
  let text = typeof value === 'string' ? value.trim() : '';
  return text || '';
}

function normalizeOptionalID(value) {
  let text = normalizeID(value);
  return text || null;
}

async function findRawFrame(runtime, sessionID, frameID) {
  let window = await runtime.frameStore.listFrameWindow(sessionID, {
    start: frameID,
    limit: 1,
    raw: true,
  });
  return Array.isArray(window?.frames)
    ? window.frames.find((frame) => frame?.id === frameID) || null
    : null;
}

export function installPromptMethods(prototype) {
  installRuntimeMethods(prototype, promptMethods);
}
