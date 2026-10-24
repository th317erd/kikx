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
