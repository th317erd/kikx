'use strict';

const STORAGE_PREFIX = 'kikx.composerDraft.';
const DRAFT_SAVE_DEBOUNCE_MS = 250;

export function readLocalComposerDraft(sessionID) {
  if (!sessionID)
    return null;
  try {
    let raw = globalThis.localStorage?.getItem(`${STORAGE_PREFIX}${sessionID}`);
    if (!raw)
      return null;
    let value = JSON.parse(raw);
    if (!value || typeof value.text !== 'string' || value.text.trim() === '')
      return null;
    return {
      draftID: typeof value.draftID === 'string' ? value.draftID : null,
      text: value.text,
      updatedAt: Number(value.updatedAt) || 0,
    };
  } catch (_error) {
    return null;
  }
}

export function writeLocalComposerDraft(sessionID, draft) {
  if (!sessionID)
    return;
  try {
    if (!draft || typeof draft.text !== 'string' || draft.text.trim() === '') {
      globalThis.localStorage?.removeItem(`${STORAGE_PREFIX}${sessionID}`);
      return;
    }
    globalThis.localStorage?.setItem(`${STORAGE_PREFIX}${sessionID}`, JSON.stringify({
      draftID: draft.draftID || null,
      text: draft.text,
      updatedAt: Date.now(),
    }));
  } catch (_error) {}
}

export function removeLocalComposerDraft(sessionID) {
  if (!sessionID)
    return;
  try {
    globalThis.localStorage?.removeItem(`${STORAGE_PREFIX}${sessionID}`);
  } catch (_error) {}
}

export function listLocalComposerDrafts(sessionID) {
  let draft = readLocalComposerDraft(sessionID);
  return draft ? [ draft ] : [];
}

export function createComposerDraftController(sessionID) {
  return {
    sessionID,
    draftID: null,
    text: '',
    savedText: '',
    timer: null,
    saveChain: Promise.resolve(true),
    loadToken: 0,
  };
}

export function getComposerDraftController(app, sessionID) {
  app._composerDraftControllers ||= new Map();
  let key = sessionID || app._state.selectedSessionID;
  if (!key)
    return null;
  let controller = app._composerDraftControllers.get(key);
  if (!controller) {
    controller = createComposerDraftController(key);
    app._composerDraftControllers.set(key, controller);
  }
  return controller;
}

export async function activateComposerDraftSession(app, sessionID = app._state.selectedSessionID) {
  if (!sessionID)
    return null;
  if (app._activeComposerDraftSessionID === sessionID && app.querySelector?.('textarea[name="message"]'))
    return null;

  let previousSessionID = app._activeComposerDraftSessionID || null;
  if (previousSessionID && previousSessionID !== sessionID)
    await flushComposerDraft(app, previousSessionID).catch(() => false);

  app._activeComposerDraftSessionID = sessionID;
  let controller = getComposerDraftController(app, sessionID);
  let token = ++controller.loadToken;
  let local = readLocalComposerDraft(sessionID);
  if (local) {
    controller.draftID = local.draftID;
    controller.text = local.text;
    controller.savedText = '';
    setComposerText(app, local.text, sessionID);
  } else {
    controller.draftID = null;
    controller.text = '';
    controller.savedText = '';
    setComposerText(app, '', sessionID);
  }

  try {
    let result = await app._getJSON(`/api/v1/sessions/${encodeURIComponent(sessionID)}/composer/drafts?limit=50`);
    if (token !== controller.loadToken || app._state.selectedSessionID !== sessionID)
      return null;
    let drafts = result?.data?.drafts || [];
    let latest = drafts[0] || null;
    if (local && local.updatedAt >= Number(latest?.updatedAt || 0)) {
      if (controller.draftID && controller.text.trim() !== '')
        queueComposerDraftSave(app, sessionID, { immediate: true });
      return latest;
    }
    if (latest?.text) {
      controller.draftID = latest.draftID || null;
      controller.text = latest.text;
      controller.savedText = latest.text;
      writeLocalComposerDraft(sessionID, {
        draftID: controller.draftID,
        text: controller.text,
      });
      setComposerText(app, latest.text, sessionID);
    }
    return latest;
  } catch (_error) {
    // Network outage: the local copy is the recovery source. Keep it in the
    // composer and retry when the user next types or replaces it.
    return null;
  }
}

export function syncComposerDraft(app, text) {
  let sessionID = app._state.selectedSessionID;
  if (!sessionID)
    return;

  let controller = getComposerDraftController(app, sessionID);
  controller.text = typeof text === 'string' ? text : '';
  if (controller.text.trim() === '') {
    writeLocalComposerDraft(sessionID, null);
  } else {
    if (!controller.draftID)
      controller.draftID = createDraftID();
    writeLocalComposerDraft(sessionID, {
      draftID: controller.draftID,
      text: controller.text,
    });
  }
  scheduleComposerDraftSave(app, sessionID);
}

export function scheduleComposerDraftSave(app, sessionID, { immediate = false } = {}) {
  let controller = getComposerDraftController(app, sessionID);
  if (!controller)
    return;
  clearTimeout(controller.timer);
  controller.timer = null;
  let delay = immediate ? 0 : DRAFT_SAVE_DEBOUNCE_MS;
  controller.timer = setTimeout(() => {
    controller.timer = null;
    queueComposerDraftSave(app, sessionID);
  }, delay);
  controller.timer.unref?.();
}

export function queueComposerDraftSave(app, sessionID, { immediate = false } = {}) {
  let controller = getComposerDraftController(app, sessionID);
  if (!controller)
    return Promise.resolve(true);

  clearTimeout(controller.timer);
  controller.timer = null;
  let draftID = controller.draftID;
  let text = controller.text;
  let previousDraftID = draftID;
  if (!draftID && text.trim() === '')
    return controller.saveChain;
  if (!draftID && text.trim() !== '')
    draftID = controller.draftID = createDraftID();

  controller.saveChain = controller.saveChain
    .catch(() => false)
    .then(async () => {
      let result = await app._putJSON(
        `/api/v1/sessions/${encodeURIComponent(sessionID)}/composer/drafts/${encodeURIComponent(draftID)}`,
        { text },
        { keepalive: immediate },
      );
      if (controller.draftID === draftID && controller.text === text)
        controller.savedText = text;
      if (text.trim() === '') {
        removeLocalComposerDraft(sessionID);
        if (controller.draftID === previousDraftID && controller.text.trim() === '')
          controller.draftID = null;
      }
      return Boolean(result);
    })
    .catch((error) => {
      app._state.status = `Draft not saved: ${error.message}`;
      app._state.statusKind = 'error';
      return false;
    });
  return controller.saveChain;
}

export async function flushComposerDraft(app, sessionID = app._state.selectedSessionID, options = {}) {
  if (!sessionID)
    return true;
  let controller = getComposerDraftController(app, sessionID);
  if (!controller)
    return true;
  clearTimeout(controller.timer);
  controller.timer = null;
  if (controller.text === controller.savedText && controller.text.trim() !== '')
    return true;
  return await queueComposerDraftSave(app, sessionID, { immediate: options.keepalive === true });
}

export async function replaceComposerText(app, text, { draftID = null, savedText = null } = {}) {
  let sessionID = app._state.selectedSessionID;
  if (!sessionID)
    return false;

  let saved = await flushComposerDraft(app, sessionID);
  if (!saved)
    return false;

  let controller = getComposerDraftController(app, sessionID);
  controller.text = typeof text === 'string' ? text : '';
  controller.draftID = draftID || (controller.text.trim() !== '' ? createDraftID() : null);
  controller.savedText = savedText == null ? '' : savedText;
  writeLocalComposerDraft(sessionID, {
    draftID: controller.draftID,
    text: controller.text,
  });
  setComposerText(app, controller.text, sessionID);
  if (controller.draftID && controller.savedText !== controller.text)
    queueComposerDraftSave(app, sessionID);
  return true;
}

export function cancelComposerDraftSave(app, sessionID = app._state.selectedSessionID) {
  let controller = getComposerDraftController(app, sessionID);
  if (!controller)
    return;
  clearTimeout(controller.timer);
  controller.timer = null;
}

export async function clearComposerDraftWithServer(app, sessionID = app._state.selectedSessionID) {
  if (!sessionID)
    return;
  let controller = getComposerDraftController(app, sessionID);
  let draftID = controller?.draftID;
  cancelComposerDraftSave(app, sessionID);
  controller.text = '';
  controller.savedText = '';
  removeLocalComposerDraft(sessionID);
  if (draftID) {
    await app._deleteJSON(`/api/v1/sessions/${encodeURIComponent(sessionID)}/composer/drafts/${encodeURIComponent(draftID)}`).catch(() => null);
  }
  // Another draft may have started while the delete was in flight.
  if (controller.draftID === draftID && controller.text.trim() === '')
    controller.draftID = null;
}

export async function deleteComposerHistoryEntry(app, entry) {
  if (!entry)
    return false;
  let sessionID = app._state.selectedSessionID;
  if (!sessionID)
    return false;

  if (entry.kind === 'draft') {
    let controller = getComposerDraftController(app, sessionID);
    let activeDraft = entry.draftID
      ? controller?.draftID === entry.draftID
      : (controller?.draftID == null && controller?.text === entry.text);
    if (activeDraft) {
      controller.text = '';
      controller.savedText = '';
      controller.draftID = null;
      removeLocalComposerDraft(sessionID);
      setComposerText(app, '', sessionID);
    }
    if (entry.draftID) {
      await app._deleteJSON(`/api/v1/sessions/${encodeURIComponent(sessionID)}/composer/drafts/${encodeURIComponent(entry.draftID)}`);
    }
    return true;
  }

  await app._deleteJSON(`/api/v1/sessions/${encodeURIComponent(sessionID)}/composer/history/${encodeURIComponent(entry.frameID)}`);
  return true;
}

export function setComposerText(app, text, sessionID = app._state.selectedSessionID) {
  if (sessionID !== app._state.selectedSessionID)
    return;
  app._state.draft = typeof text === 'string' ? text : '';
  let composer = app.querySelector('textarea[name="message"]');
  if (!composer)
    return;
  composer.value = app._state.draft;
  try {
    let caret = composer.value.length;
    composer.setSelectionRange(caret, caret);
  } catch (_error) {}
}

export function createDraftID() {
  try {
    if (globalThis.crypto?.randomUUID)
      return globalThis.crypto.randomUUID();
  } catch (_error) {}
  return `draft-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
