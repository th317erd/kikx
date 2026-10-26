'use strict';

const STORAGE_PREFIX = 'kikx.composerDraft.';
const SENT_STORAGE_PREFIX = 'kikx.composerSentDraft.';
const MAX_SENT_DRAFTS = 10;
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

function readSentComposerDrafts(sessionID) {
  if (!sessionID)
    return [];
  try {
    let raw = globalThis.localStorage?.getItem(`${SENT_STORAGE_PREFIX}${sessionID}`);
    if (!raw)
      return [];
    let values = JSON.parse(raw);
    return Array.isArray(values)
      ? values.filter((value) => value && (value.draftID || value.text))
      : [];
  } catch (_error) {
    return [];
  }
}

function draftMatchesSent(sessionID, draft) {
  if (!draft)
    return false;
  return readSentComposerDrafts(sessionID).some((sent) => {
    if (sent.draftID && draft.draftID)
      return sent.draftID === draft.draftID;
    return Boolean(sent.text) && sent.text === draft.text;
  });
}

// A delivered message is the terminal state of its composer draft. Remember the
// draft id locally so a delayed PUT, a stale server row, or a cached copy can
// never resurrect the text after the message has been acknowledged.
export function markComposerDraftSent(sessionID, { draftID = null, text = '' } = {}) {
  if (!sessionID)
    return;
  try {
    let sent = readSentComposerDrafts(sessionID)
      .filter((entry) => !(draftID && entry.draftID === draftID));
    sent.push({
      draftID: draftID || null,
      text: typeof text === 'string' ? text : '',
      sentAt: Date.now(),
    });
    globalThis.localStorage?.setItem(
      `${SENT_STORAGE_PREFIX}${sessionID}`,
      JSON.stringify(sent.slice(-MAX_SENT_DRAFTS)),
    );
    let local = readLocalComposerDraft(sessionID);
    if (local && ((draftID && local.draftID === draftID) || (!draftID && local.text === text)))
      removeLocalComposerDraft(sessionID);
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
    revision: 0,
    pendingSaves: 0,
  };
}

function bumpComposerDraftRevision(controller) {
  if (controller)
    controller.revision = (controller.revision || 0) + 1;
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
  let revision = controller.revision || 0;
  let local = readLocalComposerDraft(sessionID);
  // Delivery is final. Do not let a delayed save or a stale server row bring a
  // sent message back as an editable draft.
  if (local && draftMatchesSent(sessionID, local)) {
    removeLocalComposerDraft(sessionID);
    if (controller.draftID === local.draftID || controller.text === local.text) {
      controller.draftID = null;
      controller.text = '';
      controller.savedText = '';
    }
    local = null;
  }

  // The server is the source of truth once it answers. The local copy is only
  // an offline/reconnect fallback; it must not be painted first, because that
  // produces a visible resurrection of text that was already sent.
  if (controller.text.trim() !== '')
    setComposerText(app, controller.text, sessionID);
  else
    setComposerText(app, '', sessionID);

  try {
    let result = await app._getJSON(`/api/v1/sessions/${encodeURIComponent(sessionID)}/composer/drafts?limit=50`);
    if (token !== controller.loadToken || app._state.selectedSessionID !== sessionID)
      return null;
    // The user typed while the request was in flight. Their text wins over any
    // server or cached copy; syncComposerDraft already persisted it locally.
    if (revision !== (controller.revision || 0))
      return result?.data?.drafts?.[0] || null;

    let drafts = result?.data?.drafts || [];
    let latest = drafts[0] || null;

    if (latest && draftMatchesSent(sessionID, latest)) {
      // The server still has a row we know was delivered (for example, the
      // message POST succeeded but the follow-up DELETE was lost). Remove it
      // instead of restoring it.
      removeLocalComposerDraft(sessionID);
      controller.draftID = null;
      controller.text = '';
      controller.savedText = '';
      setComposerText(app, '', sessionID);
      app._deleteJSON(`/api/v1/sessions/${encodeURIComponent(sessionID)}/composer/drafts/${encodeURIComponent(latest.draftID)}`).catch(() => null);
      return null;
    }

    if (latest?.text) {
      let useLocal = local
        && local.draftID
        && latest.draftID
        && local.draftID === latest.draftID
        && local.text !== latest.text
        && local.updatedAt > Number(latest.updatedAt || 0);
      controller.draftID = useLocal ? local.draftID : (latest.draftID || null);
      controller.text = useLocal ? local.text : latest.text;
      controller.savedText = latest.text;
      writeLocalComposerDraft(sessionID, {
        draftID: controller.draftID,
        text: controller.text,
      });
      setComposerText(app, controller.text, sessionID);
      if (useLocal)
        queueComposerDraftSave(app, sessionID, { immediate: true });
      return latest;
    }

    // A successful empty response is authoritative: there is no draft on the
    // server. Drop the local fallback instead of leaving a stale message to be
    // painted on the next reload or view switch.
    removeLocalComposerDraft(sessionID);
    if (controller.text.trim() !== '') {
      if (!controller.draftID)
        controller.draftID = createDraftID();
      writeLocalComposerDraft(sessionID, {
        draftID: controller.draftID,
        text: controller.text,
      });
      queueComposerDraftSave(app, sessionID);
    } else {
      controller.draftID = null;
      controller.savedText = '';
      setComposerText(app, '', sessionID);
    }
    return null;
  } catch (_error) {
    // Network outage: the local copy is the recovery source. Keep it in the
    // composer and retry when the user next types or replaces it.
    if (revision !== (controller.revision || 0))
      return null;
    if (local && controller.text.trim() === '') {
      controller.draftID = local.draftID;
      controller.text = local.text;
      controller.savedText = '';
      setComposerText(app, local.text, sessionID);
    }
    return null;
  }
}

export function syncComposerDraft(app, text) {
  let sessionID = app._state.selectedSessionID;
  if (!sessionID)
    return;

  let controller = getComposerDraftController(app, sessionID);
  bumpComposerDraftRevision(controller);
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

  controller.pendingSaves = (controller.pendingSaves || 0) + 1;
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
    })
    .finally(() => {
      controller.pendingSaves = Math.max(0, (controller.pendingSaves || 0) - 1);
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
  bumpComposerDraftRevision(controller);
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
  if (!controller) {
    removeLocalComposerDraft(sessionID);
    return;
  }

  let draftID = controller.draftID;
  cancelComposerDraftSave(app, sessionID);
  bumpComposerDraftRevision(controller);
  controller.text = '';
  controller.savedText = '';
  // Rotate immediately. If the user starts typing while the old save/delete is
  // still in flight, the new text gets a fresh id and cannot be deleted by the
  // old cleanup.
  controller.draftID = null;
  removeLocalComposerDraft(sessionID);
  if (!draftID)
    return;

  // A debounced PUT may already be in flight. Deleting first is a race: the PUT
  // can land after the DELETE and recreate the sent draft. If nothing is
  // pending, issue the DELETE immediately so sends are not delayed.
  if ((controller.pendingSaves || 0) > 0)
    await controller.saveChain.catch(() => false);
  await app._deleteJSON(`/api/v1/sessions/${encodeURIComponent(sessionID)}/composer/drafts/${encodeURIComponent(draftID)}`).catch(() => null);
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
      bumpComposerDraftRevision(controller);
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
