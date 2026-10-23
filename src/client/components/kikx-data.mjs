'use strict';

import {
  forgetDeletedSession,
  getSessionPaging,
  getSessions,
  isCollapsed,
  isDeletedSession,
  mergeSessionFrameWindow,
  prependSessionFrames,
  recordDeletedSession,
  removeSession,
  resetAgentForm,
  setAccount,
  setAccountFormFromAccount,
  setAgentProviders,
  setAgents,
  setClientComponents,
  setPreviewsLoading,
  setPreviewStatus,
  setSessionFrames,
  setSessionPaging,
  setDeletedSessions,
  setSessionPreviews,
  setSessions,
  setTeams,
  setTokenUsage,
  upsertSession,
  upsertSessionPreview,
} from '../state/kikx-state.mjs';
import { loadClientComponentDescriptors } from './frame-component-registry.mjs';
import { clampPreviewCount, chunkSessionIDs } from './chat-view-model.mjs';
import { refreshSubSessionCards } from './kikx-sub-session-frame.mjs';
import { readResponse } from './kikx-app-helpers.mjs';
import { createThinkingBuffer } from '../state/thinking-state.mjs';

export async function getJSON(app, url) {
  let response = await fetch(url, {
    headers: apiHeaders(app),
  });
  return readResponse(response);
}

export async function postJSON(app, url, body) {
  let response = await fetch(url, {
    method: 'POST',
    headers: apiHeaders(app, {
      'Content-Type': 'application/json',
    }),
    body: JSON.stringify(body),
  });
  return readResponse(response);
}

export async function patchJSON(app, url, body) {
  let response = await fetch(url, {
    method: 'PATCH',
    headers: apiHeaders(app, {
      'Content-Type': 'application/json',
    }),
    body: JSON.stringify(body),
  });
  return readResponse(response);
}

export async function deleteJSON(app, url) {
  let response = await fetch(url, {
    method: 'DELETE',
    headers: apiHeaders(app),
  });
  if (response.status === 204)
    return null;

  return readResponse(response);
}

export function apiHeaders(app, headers = {}) {
  let next = { ...headers };
  if (app._state.authToken)
    next.Authorization = `Bearer ${app._state.authToken}`;

  return next;
}

export async function loadSessions(app) {
  try {
    let result = await getJSON(app, '/api/v1/sessions');
    setSessions(result.data.sessions || [], app._state);

    // The eye may already be on (e.g. after a reconnect); keep the deleted
    // bucket fresh alongside the live list.
    if (app._state.showDeletedSessions === true)
      await loadDeletedSessions(app);

    // Deep-link: ?session=<id> or ?view=thread opens a session's thread.
    await app._applySessionDeepLink();

    app._render();
    await app._loadSessionPreviews();
  } catch (error) {
    app._state.status = error.message;
    app._state.statusKind = 'error';
    app._render();
  }
}

// A runtime-events stream that reopens after a drop can be missing frames and
// session changes emitted while it was down: the server keeps no replay buffer
// and backpressure destroys a stalled stream. Re-fetch the session list (which
// also refreshes the card previews) and merge the selected session's newest
// frame window, so nothing missed during the gap stays silently stale. This is
// NOT called on the first connect: connectedCallback already runs the initial
// loads, so resyncing then would double-fetch every page load.
export async function resyncAfterRuntimeEventsReconnect(app) {
  if (!app?.isConnected || app._runtimeEventsResyncInFlight)
    return;

  app._runtimeEventsResyncInFlight = true;
  // The SSE stream has no replay buffer, so any terminal EndTyping/MessageDone
  // frame sent during the drop is gone. Drop the old live-thinking projection;
  // if an agent is still thinking, the next live delta repopulates it.
  app._thinking = createThinkingBuffer();
  try {
    await app._loadSessions();
    let sessionID = app._state.selectedSessionID;
    if (sessionID)
      await app._loadFrames(sessionID, { merge: true });

    // Questions missed during the gap (plan §6.6). The event stream has no
    // replay buffer, so without this fetch a question asked while the tab was
    // disconnected would stay invisible until the next page load.
    await app._loadQuestions?.({ complete: true });
  } catch (error) {
    app._state.status = error.message;
    app._state.statusKind = 'error';
    app._requestRender?.();
  } finally {
    app._runtimeEventsResyncInFlight = false;
  }
}

export async function deleteSession(app, sessionID) {
  let result = await deleteJSON(app, `/api/v1/sessions/${encodeURIComponent(sessionID)}`);
  // The DELETE 200 means the server stamped deletedAt, so drop the session from
  // local state directly. Re-fetching instead would be masked by loadSessions()
  // swallowing fetch errors (a failed refresh would look like a clean delete),
  // and the SSE session.saved frame keeps other tabs consistent via #1.
  removeSession(sessionID, app._state);
  // Keep the deleted manifest in the "show deleted" bucket so the eye reveals it
  // without a refetch.
  let deleted = result?.data?.session || null;
  if (deleted && isDeletedSession(deleted))
    recordDeletedSession(deleted, app._state);
  app._render();
  return deleted;
}

// Fetch every soft-deleted session (includeDeleted=1) and replace the bucket.
// Called when the eye turns on, and again on a session-list refresh while it is
// on, so the deleted view is current without polling.
export async function loadDeletedSessions(app) {
  try {
    let result = await getJSON(app, '/api/v1/sessions?includeDeleted=1');
    let all = result.data.sessions || [];
    setDeletedSessions(all.filter((session) => isDeletedSession(session)), app._state);
  } catch (error) {
    app._state.status = error.message;
    app._state.statusKind = 'error';
  } finally {
    // The fetch resolves after the eye was toggled, so repaint here for the
    // deleted cards to appear. requestRender coalesces with any render already
    // scheduled by the caller.
    app._requestRender?.();
  }
}

// Restore (undelete) a soft-deleted session: clear the stamp server-side, drop
// it from the deleted bucket, and return it to the live list.
export async function restoreSession(app, sessionID) {
  let result = await postJSON(app, `/api/v1/sessions/${encodeURIComponent(sessionID)}/restore`, {});
  let session = result?.data?.session || null;
  forgetDeletedSession(sessionID, app._state);
  if (session)
    upsertSession(session, app._state);
  app._render();
  return session;
}

export async function loadAgents(app) {
  try {
    let [ providersResult, agentsResult ] = await Promise.all([
      getJSON(app, '/api/v1/agent-providers'),
      getJSON(app, '/api/v1/agents'),
    ]);
    setAgentProviders(providersResult.data.providers || [], app._state);
    setAgents(agentsResult.data.agents || [], app._state);
    if (!app._state.agentFormPluginID)
      resetAgentForm(app._state);
    app._render();
  } catch (error) {
    app._state.agentStatus = error.message;
    app._state.agentStatusKind = 'error';
    app._render();
  }
}

export async function loadTeams(app) {
  try {
    let [ teamsResult, agentsResult ] = await Promise.all([
      getJSON(app, '/api/v1/teams'),
      getJSON(app, '/api/v1/agents'),
    ]);
    setTeams(teamsResult.data.teams || [], app._state);
    setAgents(agentsResult.data.agents || [], app._state);
    app._render();
  } catch (error) {
    app._state.teamStatus = error.message;
    app._state.teamStatusKind = 'error';
    app._render();
  }
}

export async function loadClientComponents(app) {
  try {
    let result = await getJSON(app, '/api/v1/client-components');
    let components = await loadClientComponentDescriptors(result.data?.components || []);
    setClientComponents(components, app._state);
    app._syncFrameThread(app._state.selectedSessionID, { force: true });
  } catch (error) {
    app._state.clientComponentStatus = 'error';
    app._state.status = error.message;
    app._state.statusKind = 'error';
    app._requestRender();
  }
}

export const DEFAULT_FRAME_WINDOW_LIMIT = 600;
// Once the initial window is on screen, paging in 600 raw frames at a time
// prepends hundreds of rendered heads and forces a multi-thousand-pixel
// scrollTop correction. Keep incremental pages small; the initial/reload
// window remains large.
export const FRAME_PAGE_LIMIT = 100;

function frameWindowURL(sessionID, { limit, before, after, start } = {}) {
  let params = new URLSearchParams();
  if (Number.isInteger(limit) && limit > 0)
    params.set('limit', String(limit));
  if (before != null)
    params.set('before', String(before));
  if (after != null)
    params.set('after', String(after));
  if (start != null)
    params.set('start', String(start));

  let query = params.toString();
  let base = `/api/v1/sessions/${encodeURIComponent(sessionID)}/frames`;
  return query ? `${base}?${query}` : base;
}

function frameWindowPaging(data = {}, limit = DEFAULT_FRAME_WINDOW_LIMIT) {
  return {
    hasMoreOlder: data.hasMoreOlder === true || data.hasMore === true,
    hasMoreNewer: data.hasMoreNewer === true,
    oldestOrder: data.oldestOrder ?? null,
    newestOrder: data.newestOrder ?? null,
    total: data.total ?? null,
    limit,
  };
}

// Fetch a frame window. With no `before`, the server returns the NEWEST page
// (anchored to the bottom). With `before`, it returns the page just older than
// that raw order; those heads are PREPENDED without discarding loaded newer
// heads. Legacy whole-session callers pass `offset` to keep the old shape.
export async function loadFrames(app, sessionID, options = {}) {
  let limit = Number.isInteger(options.limit) ? options.limit : DEFAULT_FRAME_WINDOW_LIMIT;
  let result = await getJSON(app, frameWindowURL(sessionID, {
    limit,
    before: options.before,
    after: options.after,
    start: options.start,
  }));
  let frames = result.data?.frames || [];
  let paging = frameWindowPaging(result.data, limit);

  if (options.start != null) {
    if (frames.length > 0) {
      setSessionFrames(sessionID, frames, app._state, paging);
      // The DOM window normally follows the newest end. A reload anchor must
      // start at the anchor instead, or a large loaded window can render newer
      // frames and skip the very message we are restoring.
      app._frameWindowStartFrameID = options.start;
    }
    if (options.render !== false)
      app._render();
    return result.data;
  }

  if (options.after != null) {
    mergeSessionFrameWindow(sessionID, frames, app._state, paging);
    if (options.render !== false)
      app._syncFrameThread(sessionID, { force: true });
    return result.data;
  }

  if (options.before != null) {
    prependSessionFrames(sessionID, frames, app._state);
    setSessionPaging(sessionID, paging, app._state);
    if (options.render !== false)
      app._syncFrameThread(sessionID, { prepend: true, animate: false });
    return result.data;
  }

  if (options.merge === true) {
    mergeSessionFrameWindow(sessionID, frames, app._state, paging);
  } else {
    setSessionFrames(sessionID, frames, app._state, paging);
  }

  if (options.render !== false) {
    if (options.merge === true)
      app._syncFrameThread(sessionID, { force: true });
    else
      app._render();
  }

  return result.data;
}

// Load a single window beginning at a stable frame id. This is the reload
// anchor path: one request lands on the message the user was reading instead
// of walking backward through every newer page.
export async function loadFramesAtMessage(app, sessionID, frameID, options = {}) {
  if (!sessionID || !frameID)
    return null;

  let limit = Number.isInteger(options.limit) ? options.limit : DEFAULT_FRAME_WINDOW_LIMIT;

  return await loadFrames(app, sessionID, {
    start: frameID,
    limit,
    render: options.render,
  });
}

// Load the previous (older) page for the selected session when the list nears
// the top. Guards against concurrent loads and stops once `hasMoreOlder` false.
export async function loadOlderFrames(app, sessionID = app._state.selectedSessionID) {
  if (!sessionID)
    return null;

  let paging = getSessionPaging(app._state, sessionID);
  if (paging.loading === true || paging.hasMoreOlder !== true || paging.oldestOrder == null)
    return null;

  setSessionPaging(sessionID, { loading: true }, app._state);

  try {
    return await loadFrames(app, sessionID, {
      before: paging.oldestOrder,
      limit: FRAME_PAGE_LIMIT,
    });
  } catch (error) {
    app._state.status = error.message;
    app._state.statusKind = 'error';
    app._requestRender();
    return null;
  } finally {
    setSessionPaging(sessionID, { loading: false }, app._state);
  }
}

// The state window is capped, so scrolling up can trim the newest end. When the
// user returns to the bottom, refetch the newest page and merge it back in.
export async function loadNewerFrames(app, sessionID = app._state.selectedSessionID) {
  if (!sessionID)
    return null;

  let paging = getSessionPaging(app._state, sessionID);
  if (paging.loading === true || paging.hasMoreNewer !== true)
    return null;

  setSessionPaging(sessionID, { loading: true }, app._state);

  try {
    let wasAnchored = app._frameListAnchoredToBottom;
    let result = await loadFrames(app, sessionID, {
      merge: true,
      after: paging.newestOrder,
      limit: FRAME_PAGE_LIMIT,
      render: false,
    });
    setSessionPaging(sessionID, { hasMoreNewer: result?.hasMoreNewer === true }, app._state);
    if (wasAnchored)
      app._forceScrollToBottomAfterRender = true;
    app._render();
    return result;
  } catch (error) {
    app._state.status = error.message;
    app._state.statusKind = 'error';
    app._requestRender();
    return null;
  } finally {
    setSessionPaging(sessionID, { loading: false }, app._state);
  }
}

export async function cancelAgents(app, target = null) {
  let sessionID = app?._state?.selectedSessionID;
  if (!sessionID)
    return null;

  let result = await postJSON(app, `/api/v1/sessions/${encodeURIComponent(sessionID)}/cancel`, {
    target: typeof target === 'string' && target.trim() !== '' ? target.trim() : null,
  });
  let count = result?.data?.count || 0;
  app._state.status = count > 0
    ? `Cancellation requested for ${count} active agent${count === 1 ? '' : 's'}`
    : 'No active agent runs';
  app._state.statusKind = count > 0 ? 'pending' : 'ready';
  app._requestRender?.();
  return result?.data || null;
}

export async function loadTokenUsage(app) {
  try {
    let result = await getJSON(app, '/api/v1/tokens');
    setTokenUsage(result.data?.tokenUsage || {}, result.data?.totalTokensUsed, app._state);
    app._render();
  } catch (error) {
    app._state.status = error.message;
    app._state.statusKind = 'error';
    app._render();
  }
}

export async function loadAccount(app, options = {}) {
  try {
    let result = await getJSON(app, '/api/v1/account');
    setAccount(result.data?.account || null, app._state);
    if (options.syncForm === true)
      setAccountFormFromAccount(app._state.account, app._state);
    app._requestRender();
  } catch (error) {
    app._state.accountStatus = error.message;
    app._state.accountStatusKind = 'error';
    if (options.render !== false)
      app._requestRender();
  }
}

export async function loadSessionPreviews(app) {
  let sessions = getSessions(app._state);
  if (sessions.length === 0) {
    setPreviewStatus('', app._state);
    return;
  }

  setPreviewsLoading(true, app._state);

  try {
    let previewCount = clampPreviewCount(app._state.previewCount);
    let previews = [];
    for (let chunk of chunkSessionIDs(sessions.map((session) => session.id)))
      previews.push(...await getSessionPreviews(app, chunk, previewCount));

    setSessionPreviews(previews, app._state);
    setPreviewStatus('', app._state);
    refreshSubSessionCards(app, app._state);
  } catch (error) {
    setPreviewStatus(error.message, app._state);
  } finally {
    setPreviewsLoading(false, app._state);
    if (isCollapsed(app._state))
      app._requestRender();
  }
}

export async function getSessionPreviews(app, sessionIDs, previewCount) {
  if (sessionIDs.length === 0)
    return [];

  let result = await postJSON(app, '/api/v1/sessions/previews', { sessionIDs, previewCount });
  return result.data?.previews || [];
}

export function applyPreviewToGrid(app, sessionID, preview) {
  upsertSessionPreview(sessionID, preview, app._state);
  let grid = app.querySelector('kikx-session-grid');
  if (grid)
    grid.setPreview(sessionID, preview);
}

export function schedulePreviewRefresh(app, sessionIDs) {
  for (let sessionID of sessionIDs)
    app._pendingPreviewSessionIDs.add(sessionID);

  if (app._previewRefreshScheduled)
    return;

  app._previewRefreshScheduled = true;
  setTimeout(() => flushPreviewRefresh(app), 400);
}

export async function flushPreviewRefresh(app) {
  app._previewRefreshScheduled = false;
  let sessionIDs = [ ...app._pendingPreviewSessionIDs ];
  app._pendingPreviewSessionIDs.clear();
  if (sessionIDs.length === 0)
    return;

  try {
    let previewCount = clampPreviewCount(app._state.previewCount);
    let previews = await getSessionPreviews(app, sessionIDs, previewCount);
    for (let preview of previews)
      applyPreviewToGrid(app, preview.sessionID, preview);
  } catch (_error) {}
}
