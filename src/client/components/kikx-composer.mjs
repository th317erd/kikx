'use strict';

import { getSelectedFrames, upsertSession } from '../state/kikx-state.mjs';
import { shouldSubmitComposerKey } from './composer-keyboard.mjs';
import {
  composerCaretAllowsHistory,
  composerHistoryEntriesFromFrames,
  composerHistoryDirectionForKey,
  navigateComposerHistory,
  recordComposerHistoryEntry,
} from './composer-history.mjs';

export function syncDraft(app, event) {
  app._state.draft = event.target.value;
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
  clearComposerDraft(app);

  try {
    let result = await app._postJSON(`/api/v1/sessions/${encodeURIComponent(app._state.selectedSessionID)}/messages`, {
      text: draft,
      authorDisplayName: app._state.account?.name || null,
    });
    upsertSession(result.data.session, app._state);
    recordComposerHistoryEntry(app._composerHistory, draft);
    app._forceScrollToBottomAfterRender = true;
    app._focusComposerAfterRender = true;
    await app._loadFrames(app._state.selectedSessionID, { render: false, merge: true });
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
  if (handleComposerHistoryKey(app, event))
    return;

  if (!shouldSubmitComposerKey(event))
    return;

  event.preventDefault();
  event.target?.form?.requestSubmit();
}

export function handleComposerHistoryKey(app, event) {
  let direction = composerHistoryDirectionForKey(event);
  if (!direction)
    return false;

  let composer = event.target;
  if (!composer)
    return false;

  if (!composerCaretAllowsHistory(direction, composer.value, composer.selectionStart))
    return false;

  syncComposerHistoryFromFrames(app);

  let navigation = navigateComposerHistory(app._composerHistory, direction, composer.value);
  if (!navigation.handled)
    return false;

  event.preventDefault();
  composer.value = navigation.value ?? '';
  app._state.draft = composer.value;

  let caret = composer.value.length;
  try {
    composer.setSelectionRange(caret, caret);
  } catch (_error) {}

  return true;
}

export function syncComposerHistoryFromFrames(app) {
  if (app._composerHistory.cursor !== -1)
    return;

  let entries = composerHistoryEntriesFromFrames(getSelectedFrames(app._state));
  if (entries.length > 0)
    app._composerHistory.entries = entries;
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
  let composer = app.querySelector('textarea[name="message"]');
  if (composer && composer.value === '')
    composer.value = submittedDraft;
}
