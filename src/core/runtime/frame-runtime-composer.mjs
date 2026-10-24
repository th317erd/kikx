'use strict';

import { installRuntimeMethods } from './frame-runtime-mixins.mjs';

const DEFAULT_HISTORY_LIMIT = 30;
const MAX_HISTORY_LIMIT = 100;
const HISTORY_SCAN_PAGE_SIZE = 2000;
const MAX_HISTORY_SCAN_PAGES = 100;

const composerMethods = {
  async listComposerHistory(sessionID, options = {}) {
    return await collectComposerHistory(this, sessionID, options);
  },

  async listComposerDrafts(sessionID, options = {}) {
    let result = await collectComposerHistory(this, sessionID, {
      ...options,
      draftsOnly: true,
    });
    return {
      ...result,
      drafts: result.entries
        .slice()
        .sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0)),
    };
  },

  async upsertComposerDraft(sessionID, input = {}) {
    let userID = normalizeRequiredID(input.userID, 'userID');
    let draftID = normalizeDraftID(input.draftID);
    let text = typeof input.text === 'string' ? input.text : '';
    let visible = text.trim() !== '';
    let frameID = draftFrameID(draftID);
    let entry = await this.ensureSessionEntry(sessionID);
    let existing = entry.frameEngine.get(frameID) || await findRawFrame(this, sessionID, frameID);

    if (!visible && !existing)
      return null;

    let stamp = this.nextClockStamp();
    let now = stamp.at;
    let frame = {
      ...(existing || {}),
      id: frameID,
      type: 'UserDraft',
      sessionID,
      interactionID: existing?.interactionID || this.idGenerator(),
      parentID: existing?.parentID || null,
      authorType: 'user',
      authorID: userID,
      authorDisplayName: input.authorDisplayName || existing?.authorDisplayName || 'You',
      timestamp: existing?.timestamp || now,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      updatedClock: stamp.clock,
      hidden: true,
      deleted: !visible,
      content: {
        ...(existing?.content || {}),
        text: visible ? text : '',
        status: visible ? 'draft' : 'deleted',
        draftID,
        userID,
        ...(visible ? {} : { deletedAt: now }),
      },
    };

    let merged = entry.frameEngine.merge([ frame ], {
      authorType: 'user',
      authorID: userID,
      silent: true,
    });
    await this.frameStore?.flush?.();
    let saved = merged[0] || entry.frameEngine.get(frameID) || frame;
    return visible ? composerEntry(saved) : null;
  },

  async deleteComposerDraft(sessionID, input = {}) {
    await this.upsertComposerDraft(sessionID, {
      ...input,
      text: '',
    });
    return null;
  },

  async redactUserMessageFrame(sessionID, input = {}) {
    let userID = normalizeRequiredID(input.userID, 'userID');
    let frameID = normalizeRequiredID(input.frameID, 'frameID');
    let entry = await this.ensureSessionEntry(sessionID);
    let existing = entry.frameEngine.get(frameID) || await findRawFrame(this, sessionID, frameID);
    if (!existing || existing.type !== 'UserMessage' || existing.authorType !== 'user')
      throw new Error(`Unknown user message frame: ${frameID}`);
    if (existing.authorID && existing.authorID !== userID)
      throw new Error('This message belongs to another user');

    let stamp = this.nextClockStamp();
    let now = stamp.at;
    let previousText = typeof existing.content?.text === 'string' ? existing.content.text : '';
    let redactedText = `<REDACTED BY ${userID} AT ${new Date(now).toISOString()}>`;
    let frame = {
      ...existing,
      hidden: true,
      deleted: true,
      updatedAt: now,
      updatedClock: stamp.clock,
      content: {
        ...(existing.content || {}),
        text: redactedText,
        status: 'redacted',
        redactedAt: now,
        redactedBy: userID,
        originalTextLength: previousText.length,
      },
    };
    let merged = entry.frameEngine.merge([ frame ], {
      authorType: 'user',
      authorID: userID,
      silent: true,
    });
    await this.frameStore?.flush?.();
    return composerEntry(merged[0] || frame);
  },
};

async function collectComposerHistory(runtime, sessionID, options = {}) {
  let userID = normalizeRequiredID(options.userID, 'userID');
  let query = typeof options.query === 'string' ? options.query.trim().toLowerCase() : '';
  let limit = normalizeHistoryLimit(options.limit);
  let before = normalizeOptionalOrder(options.before);
  let draftsOnly = options.draftsOnly === true;
  let cursor = before;
  let matched = [];
  let hasMoreOlder = false;

  for (let page = 0; page < MAX_HISTORY_SCAN_PAGES; page++) {
    let window = await runtime.frameStore.listFrameWindow(sessionID, {
      limit: HISTORY_SCAN_PAGE_SIZE,
      raw: true,
      // Draft-only callers must not read every user-message body in the window.
      // The frame-type path filter is applied before JSON reads, so this turns a
      // large-session draft lookup into a handful of reads instead of thousands.
      frameTypes: draftsOnly ? [ 'UserDraft' ] : [ 'UserMessage', 'UserDraft' ],
      ...(cursor != null ? { before: cursor } : {}),
    });
    let frames = Array.isArray(window?.frames) ? window.frames : [];
    if (frames.length === 0)
      break;

    for (let index = frames.length - 1; index >= 0; index--) {
      let entry = composerEntry(frames[index]);
      if (!entry || !isHistoryEntryForUser(frames[index], entry, userID, draftsOnly))
        continue;
      if (query && !entry.text.toLowerCase().includes(query))
        continue;

      matched.push(entry);
      if (matched.length > limit) {
        hasMoreOlder = true;
        break;
      }
    }

    if (hasMoreOlder || window?.hasMore !== true)
      break;

    let next = normalizeOptionalOrder(window?.oldestOrder);
    if (next == null || next === cursor)
      break;
    cursor = next;
  }

  let entries = matched.slice(0, limit).reverse();
  return {
    entries,
    hasMoreOlder,
    oldestOrder: entries[0]?.order ?? null,
    newestOrder: entries.at(-1)?.order ?? null,
  };
}

function isHistoryEntryForUser(frame, entry, userID, draftsOnly) {
  if (!frame || frame.authorType !== 'user' || frame.deleted === true)
    return false;
  if (frame.authorID && frame.authorID !== userID)
    return false;
  if (draftsOnly && entry.kind !== 'draft')
    return false;
  return true;
}

function composerEntry(frame) {
  if (!frame || frame.deleted === true)
    return null;
  if (frame.type !== 'UserMessage' && frame.type !== 'UserDraft')
    return null;

  let text = typeof frame.content?.text === 'string' ? frame.content.text : '';
  let draftID = typeof frame.content?.draftID === 'string' ? frame.content.draftID : '';
  let kind = frame.type === 'UserDraft' ? 'draft' : 'message';
  if (text.trim() === '')
    return null;

  return {
    frameID: frame.id,
    id: frame.id,
    kind,
    draftID: draftID || null,
    text,
    order: Number(frame.order) || 0,
    createdAt: Number(frame.createdAt || frame.timestamp) || null,
    updatedAt: Number(frame.updatedAt || frame.createdAt || frame.timestamp) || null,
    authorDisplayName: frame.authorDisplayName || 'You',
  };
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

function draftFrameID(draftID) {
  return `draft-${draftID}`;
}

function normalizeDraftID(value) {
  let id = typeof value === 'string' ? value.trim() : '';
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id))
    throw new TypeError('draftID must be a short URL-safe identifier');
  return id;
}

function normalizeRequiredID(value, name) {
  let normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized)
    throw new TypeError(`${name} is required`);
  return normalized;
}

function normalizeHistoryLimit(value) {
  let number = Number(value);
  if (!Number.isFinite(number) || number < 1)
    return DEFAULT_HISTORY_LIMIT;
  return Math.min(MAX_HISTORY_LIMIT, Math.trunc(number));
}

function normalizeOptionalOrder(value) {
  if (value == null || value === '')
    return null;
  let number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

export function installComposerMethods(prototype) {
  installRuntimeMethods(prototype, composerMethods);
}
