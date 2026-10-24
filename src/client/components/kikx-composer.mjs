'use strict';

import { upsertFrame, upsertSession } from '../state/kikx-state.mjs';
import { shouldSubmitComposerKey } from './composer-keyboard.mjs';
import { ensureAutoScrollAfterSend } from './kikx-frame-scroll-lock.mjs';
import {
  clearComposerDraftWithServer,
  flushComposerDraft,
  replaceComposerText,
  syncComposerDraft,
} from './composer-drafts.mjs';

export function syncDraft(app, event) {
  app._state.draft = event.target.value;
  syncComposerDraft(app, app._state.draft);
}

export async function onSubmit(app, event) {
  event.preventDefault();
  let submittedDraft = app._state.draft;
  let draft = submittedDraft.trim();
  if (!draft) {
    app._state.status = 'Write a message before sending';
    app._state.statusKind = 'error';
    return;
  }

  if (!app._state.selectedSessionID) {
    app._state.status = 'Create a session before sending';
    app._state.statusKind = 'error';
    return;
  }

  app._state.status = 'Committing message...';
  app._state.statusKind = 'pending';
  let sessionID = app._state.selectedSessionID;
  await flushComposerDraft(app, sessionID).catch(() => false);
  clearComposerDraft(app);

  try {
    let result = await app._postJSON(`/api/v1/sessions/${encodeURIComponent(sessionID)}/messages`, {
      text: draft,
      authorDisplayName: app._state.account?.name || null,
    });
    upsertSession(result.data.session, app._state);
    // Do not wait for the reload window or the SSE echo to discover our own
    // message. Put it into state now so the render can include it immediately.
    if (result.data.frame?.id)
      upsertFrame(sessionID, result.data.frame, app._state);
    ensureAutoScrollAfterSend(app);
    await clearComposerDraftWithServer(app, sessionID);
    app._forceScrollToBottomAfterRender = true;
    app._focusComposerAfterRender = true;
    await app._loadFrames(sessionID, { render: false, merge: true });
    app._state.status = 'Message committed';
    app._state.statusKind = 'ready';
    app._render();
  } catch (error) {
    restoreComposerDraftOnFailure(app, submittedDraft);
    app._state.status = error.message;
    app._state.statusKind = 'error';
    app._render();
  }
}

export function onComposerKeydown(app, event) {
  if (!shouldSubmitComposerKey(event))
    return;

  event.preventDefault();
  event.target?.form?.requestSubmit();
}

export function clearComposerDraft(app) {
  app._state.draft = '';
  let composer = app.querySelector('textarea[name="message"]');
  if (!composer)
    return;

  composer.value = '';
  try {
    composer.setSelectionRange(0, 0);
  } catch (_error) {}
}

export function restoreComposerDraftOnFailure(app, submittedDraft) {
  if (app._state.draft)
    return;

  app._state.draft = submittedDraft;
  syncComposerDraft(app, submittedDraft);
  let composer = app.querySelector('textarea[name="message"]');
  if (composer && composer.value === '')
    composer.value = submittedDraft;
}

export function quoteFrameIntoComposer(app, detail = {}) {
  let frameID = typeof detail.frameID === 'string' ? detail.frameID.trim() : '';
  if (!frameID)
    return Promise.resolve(false);

  // Serialize quote operations. A second click can arrive while the first
  // draft flush is in flight; by the time it runs, the dedupe check sees the
  // marker already in the composer and leaves the text alone.
  let previous = app._quoteFrameQueue || Promise.resolve(true);
  app._quoteFrameQueue = previous
    .catch(() => false)
    .then(() => prefixQuoteBlock(app, frameID, detail.text));
  return app._quoteFrameQueue;
}

async function prefixQuoteBlock(app, frameID, frameText) {
  let sessionID = app?._state?.selectedSessionID;
  if (!sessionID)
    return false;

  let marker = `User is asking about and referring to frame id[${frameID}]:`;
  let composer = app.querySelector?.('textarea[name="message"]');
  let current = typeof app._state.draft === 'string' ? app._state.draft : '';
  if (composer && typeof composer.value === 'string')
    current = composer.value;

  if (current.includes(marker)) {
    composer?.focus?.();
    return false;
  }

  let quotedText = typeof frameText === 'string' ? frameText.trim() : '';
  let block = quotedText ? `${marker}\n${quotedText}` : marker;
  let next = current.trim() !== '' ? `${block}\n\n${current}` : block;
  let replaced = await replaceComposerText(app, next);
  if (replaced) {
    composer = app.querySelector?.('textarea[name="message"]');
    composer?.focus?.();
  }
  return replaced;
}
