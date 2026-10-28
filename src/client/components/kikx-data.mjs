'use strict';

import {
  AUTH_SHARED_STORAGE_KEY,
  AUTH_STORAGE_KEY,
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
  setAgentTagDefinitions,
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
import { frameFilterSearchParams } from '../lib/frame-filters.mjs';
import { loadClientComponentDescriptors } from './frame-component-registry.mjs';
import { clampPreviewCount, chunkSessionIDs } from './chat-view-model.mjs';
import { refreshSubSessionCards } from './kikx-sub-session-frame.mjs';
import { readResponse } from './kikx-app-helpers.mjs';
import { createThinkingBuffer } from '../state/thinking-state.mjs';

async function requestJSON(app, url, options = {}) {
  let request = {
    ...options,
    headers: apiHeaders(app, options.headers),
  };
  let response = await fetch(url, request);
  if (response.status !== 401 || !shouldRefreshForURL(url))
    return response;

  let refreshed = await refreshAuthToken(app);
  if (!refreshed)
    return response;

  return await fetch(url, {
    ...options,
    headers: apiHeaders(app, options.headers),
  });
}

function shouldRefreshForURL(url) {
  try {
    let path = new URL(url, globalThis.location?.origin || 'http://localhost').pathname;
    return !path.startsWith('/api/v1/auth/');
  } catch (_error) {
    return true;
  }
}

export async function getJSON(app, url) {
  return readResponse(await requestJSON(app, url));
}

export async function postJSON(app, url, body) {
  return readResponse(await requestJSON(app, url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  }));
}

export async function putJSON(app, url, body, options = {}) {
  return readResponse(await requestJSON(app, url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    keepalive: options.keepalive === true,
  }));
}

export async function patchJSON(app, url, body) {
  return readResponse(await requestJSON(app, url, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  }));
}

export async function deleteJSON(app, url) {
  let response = await requestJSON(app, url, {
    method: 'DELETE',
  });
  if (response.status === 204)
    return null;

  return readResponse(response);
}

export function refreshAuthToken(app) {
  if (app?._refreshAuthPromise)
    return app._refreshAuthPromise;

  let promise = refreshAuthTokenNow(app);
  if (app)
    app._refreshAuthPromise = promise;
  return promise.finally(() => {
    if (app?._refreshAuthPromise === promise)
      app._refreshAuthPromise = null;
  });
}

async function refreshAuthTokenNow(app) {
  if (!app?._state?.refreshToken)
    return false;

  // Another tab may already have rotated the shared refresh token. Adopt its
  // session instead of replaying our stale token, which would return 401 after
  // the first tab's rotation.
  let shared = readSharedAuthSession();
  if (shared?.token
    && shared.refresh_token
    && shared.refresh_token !== app._state.refreshToken) {
    adoptAuthSession(app, shared);
    if (Number(shared.expires_at) > Date.now() + 5000)
      return true;
  }

  let refreshToken = app._state.refreshToken;
  try {
    let response = await fetch('/api/v1/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    let result = await response.json().catch(() => null);
    if (!response.ok) {
      // Rotate-race fallback: the sibling may have refreshed while our request
      // was in flight. If the shared session changed, use it and retry the API.
      let latest = readSharedAuthSession();
      if (latest?.token
        && latest.refresh_token
        && latest.refresh_token !== refreshToken) {
        adoptAuthSession(app, latest);
        return true;
      }
      return false;
    }

    let auth = result?.data;
    if (!auth?.token)
      return false;
    adoptAuthSession(app, {
      ...auth,
      user: auth.user || app._state.account,
    });
    return true;
  } catch (_error) {
    return false;
  }
}

function readSharedAuthSession() {
  try {
    return JSON.parse(globalThis.localStorage?.getItem(AUTH_SHARED_STORAGE_KEY) || 'null');
  } catch (_error) {
    return null;
  }
}

function adoptAuthSession(app, auth) {
  if (!auth?.token)
    return false;
  app._state.authToken = auth.token;
  app._state.refreshToken = auth.refresh_token || app._state.refreshToken;
  persistAuthSession(auth);
  return true;
}

export function persistAuthSession(auth) {
  if (!auth?.token)
    return;
  let serialized = JSON.stringify(auth);
  try {
    globalThis.sessionStorage?.setItem(AUTH_STORAGE_KEY, serialized);
  } catch (_error) {}
  try {
    globalThis.localStorage?.setItem(AUTH_SHARED_STORAGE_KEY, serialized);
  } catch (_error) {}
}

export function clearAuthSession() {
  try { globalThis.sessionStorage?.removeItem(AUTH_STORAGE_KEY); } catch (_error) {}
  try { globalThis.localStorage?.removeItem(AUTH_SHARED_STORAGE_KEY); } catch (_error) {}
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
    // A deep-linked thread does not show session cards, so preview reads must
    // not compete with its frame fetch. Load them only when a grid is actually
    // visible; navigation back to a grid requests them explicitly.
    if (isCollapsed(app._state) || !app._state.selectedSessionID)
      await app._loadSessionPreviews();
  } catch (error) {
    app._state.status = error.message;
    app._state.statusKind = 'error';
    app._deepLinkReady = true;
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
    let tags = [];
    try {
      let tagsResult = await getJSON(app, '/api/v1/tag-definitions');
      tags = tagsResult.data.tags || [];
    } catch (_error) {
      // Older servers do not expose tag definitions. Keep the agent manager
      // usable instead of failing the whole load.
    }
    setAgentProviders(providersResult.data.providers || [], app._state);
    setAgentTagDefinitions(tags, app._state);
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

export const DEFAULT_FRAME_WINDOW_LIMIT = 120;
// Once the initial window is on screen, paging in 600 raw frames at a time
// prepends hundreds of rendered heads and forces a multi-thousand-pixel
// scrollTop correction. Keep incremental pages small; the initial/reload
// window remains large.
export const FRAME_PAGE_LIMIT = 100;

function frameWindowURL(sessionID, { limit, before, after, start, filters, query } = {}) {
  let params = new URLSearchParams();
  if (Number.isInteger(limit) && limit > 0)
    params.set('limit', String(limit));
  if (before != null)
    params.set('before', String(before));
  if (after != null)
    params.set('after', String(after));
  if (start != null)
    params.set('start', String(start));

  // Filtering happens on the server, so the popup's state travels with the
  // request. `frameFilterSearchParams` emits only rows that differ from the
  // default, so the untouched view sends no filter params at all and keeps the
  // server's unfiltered fast path.
  let filterParams = frameFilterSearchParams(filters, query);
  for (let [ key, value ] of filterParams)
    params.set(key, value);

  let queryString = params.toString();
  let base = `/api/v1/sessions/${encodeURIComponent(sessionID)}/frames`;
  return queryString ? `${base}?${queryString}` : base;
}

// Fetch the whole-session frame counts that the filter popup's badges show.
//
// These deliberately do NOT come from `framesBySessionID[...]`: that array is
// only the window the browser currently holds, so counting it answers "how many
// are on this page". The popup is a control over the session, and a badge that
// silently described the loaded page is what made a session with 17,581 frames
// report User 0 / Tools 0 / Commands 0 beside an Agent number that was just the
// page size.
//
// Counts are cached on app state per session so opening the popup repeatedly is
// free. They are invalidated when frames arrive, because a count that outlives
// the frames it counted is the same bug in a slower form.
export async function loadFrameCounts(app, sessionID, options = {}) {
  if (typeof sessionID !== 'string' || sessionID.trim() === '')
    return null;

  let state = app?._state;
  let cached = state?.frameCountsBySessionID?.[sessionID] || null;
  if (options.refresh !== true && cached)
    return cached;

  let result = await getJSON(app, `/api/v1/sessions/${encodeURIComponent(sessionID)}/frame-counts`);
  let counts = result?.data?.counts || null;
  if (!counts)
    return cached;

  if (state) {
    if (!state.frameCountsBySessionID || typeof state.frameCountsBySessionID !== 'object')
      state.frameCountsBySessionID = {};

    state.frameCountsBySessionID[sessionID] = {
      counts,
      total: result.data.total ?? null,
      truncated: result.data.truncated === true,
    };
  }

  return state?.frameCountsBySessionID?.[sessionID] || { counts, total: null, truncated: false };
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

// Per-session frame-window failures. `null` clears the record, so a session
// that loads successfully after a failure stops being captioned as broken.
function setFrameLoadError(app, sessionID, message) {
  let state = app?._state;
  if (!state || !sessionID)
    return;

  let current = state.frameLoadErrorsBySessionID || {};
  if (message == null) {
    if (!(sessionID in current))
      return;

    let next = { ...current };
    delete next[sessionID];
    // Top-level reassignment: ReactiveState only notifies on that.
    state.frameLoadErrorsBySessionID = next;
    return;
  }

  state.frameLoadErrorsBySessionID = { ...current, [sessionID]: message };
}
// Fetch a frame window. With no `before`, the server returns the NEWEST page
// (anchored to the bottom). With `before`, it returns the page just older than
// that raw order; those heads are PREPENDED without discarding loaded newer
// heads. Legacy whole-session callers pass `offset` to keep the old shape.
export async function loadFrames(app, sessionID, options = {}) {
  let limit = Number.isInteger(options.limit) ? options.limit : DEFAULT_FRAME_WINDOW_LIMIT;
  // Read the filter state at request time rather than capturing it, so a window
  // loaded after a checkbox change carries the new selection.
  let result;
  try {
    result = await getJSON(app, frameWindowURL(sessionID, {
      limit,
      before: options.before,
      after: options.after,
      start: options.start,
      filters: options.filters ?? app?._state?.frameFilters,
      query: options.query ?? app?._state?.sessionSearch,
    }));
  } catch (error) {
    // Record why, then rethrow so existing callers keep their behaviour. The
    // global status is not enough: the reload path below repaints after a
    // failure without touching it, so the reason would be lost and the thread
    // would claim the session is empty.
    setFrameLoadError(app, sessionID, error?.message || String(error));
    throw error;
  }

  setFrameLoadError(app, sessionID, null);
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
      app._syncFrameThread(sessionID);
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
      app._syncFrameThread(sessionID);
    else
      app._render();
  }

  return result.data;
}

// Load a single window beginning at a stable frame id. This is the reload
// anchor path: one request lands on the message the user was reading instead
// of walking backward through every newer page.
export async function loadFramePage(app, sessionID, pageIndex, pageSize = 120) {
  let params = new URLSearchParams({ pageSize: String(pageSize) });
  let result = await getJSON(app, `/api/v1/sessions/${encodeURIComponent(sessionID)}/frame-page/${encodeURIComponent(pageIndex)}?${params}`);
  return result.data;
}

export async function loadFramePageIndex(app, sessionID, pageSize = 120) {
  let params = new URLSearchParams({ pageSize: String(pageSize) });
  let result = await getJSON(app, `/api/v1/sessions/${encodeURIComponent(sessionID)}/frame-page-index?${params}`);
  return result.data;
}

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
  if (app._sessionPreviewsLoadPromise)
    return await app._sessionPreviewsLoadPromise;

  let promise = loadSessionPreviewsNow(app);
  app._sessionPreviewsLoadPromise = promise;
  try {
    return await promise;
  } finally {
    if (app._sessionPreviewsLoadPromise === promise)
      app._sessionPreviewsLoadPromise = null;
  }
}

async function loadSessionPreviewsNow(app) {
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
