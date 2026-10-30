'use strict';

import {
  getRequestAccount,
  httpError,
  parseBoolean,
  parseNonNegativeInteger,
  parseOptionalNonNegativeInteger,
  parsePositiveInteger,
  readJSON,
  writeJSON,
} from '../http-helpers.mjs';
import { suspendSessionAgents } from '../../core/agents/agent-cancellation.mjs';
import { projectClientFrameForWindow } from '../../core/aeordb/frame-store-preview.mjs';
import {
  effectivePreference,
  normalizePreferenceKey,
  SESSION_PREFERENCE_DEFAULTS,
} from '../../core/preferences/index.mjs';
import {
  matchSessionCancelRoute,
  matchSessionComposerDraftRoute,
  matchSessionComposerHistoryItemRoute,
  matchSessionComposerRoute,
  matchSessionCompactionRetryRoute,
  matchSessionDeleteRoute,
  matchSessionFramePageRoute,
  matchSessionPreferencesRoute,
  matchSessionRestoreRoute,
  matchSessionRoute,
  matchSessionUpdateRoute,
} from './route-matchers.mjs';

// Frame-window filter parameters.
//
// Each row is sent as its own `f_<key>` flag. Absence means "not requested",
// which `normalizeWindowFilters` resolves to the row's default — categories on,
// the Deleted gate off. Sending no flags therefore reproduces the unfiltered
// window exactly, so older clients keep working unchanged.
const FRAME_FILTER_PARAM_KEYS = [
  'user',
  'agent',
  'question',
  'session',
  'tools',
  'commands',
  'compaction',
  'deleted',
];

function parseFrameWindowFilters(params) {
  let filters = {};
  for (let key of FRAME_FILTER_PARAM_KEYS) {
    let raw = params.get(`f_${key}`);
    if (raw != null)
      filters[key] = parseBoolean(raw, true);
  }

  return filters;
}

export async function handleSessionRoutes({ request, response, url, context }) {
  if (request.method === 'GET' && url.pathname === '/api/v1/sessions') {
    let frameRuntime = context.require('frameRuntime');
    writeJSON(response, 200, {
      data: {
        sessions: await frameRuntime.listSessions({
          limit: parsePositiveInteger(url.searchParams.get('limit'), 50),
          offset: parseNonNegativeInteger(url.searchParams.get('offset'), 0),
          // "Show deleted sessions": the workspace opts in with includeDeleted=1
          // so soft-deleted manifests are listed alongside live ones.
          includeDeleted: parseBoolean(url.searchParams.get('includeDeleted'), false),
        }),
      },
    });
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/v1/sessions/previews') {
    let body = await readJSON(request);
    if (!Array.isArray(body.sessionIDs))
      throw httpError(400, 'sessionIDs must be an array');

    let previewCount;
    if (body.previewCount != null) {
      previewCount = Number(body.previewCount);
      if (!Number.isInteger(previewCount) || previewCount < 1)
        throw httpError(400, 'previewCount must be a positive integer');
    }

    let frameRuntime = context.require('frameRuntime');
    let previews = await frameRuntime.listSessionPreviews(body.sessionIDs, { previewCount });

    writeJSON(response, 200, {
      data: {
        previews,
      },
    });
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/v1/sessions') {
    let body = await readJSON(request);
    if (body.title != null && (typeof body.title !== 'string' || body.title.trim() === ''))
      throw httpError(400, 'title must be a non-empty string');

    let parentSessionID = body.parentSessionID || body.parentSessionId || null;
    if (parentSessionID != null && (typeof parentSessionID !== 'string' || parentSessionID.trim() === ''))
      throw httpError(400, 'parentSessionID must be a non-empty string');

    let frameRuntime = context.require('frameRuntime');
    let session = await frameRuntime.createSession({
      title: body.title,
      organizationID: body.organizationID || null,
      createdByUserID: body.createdByUserID || body.userID || null,
      parentSessionID: parentSessionID ? parentSessionID.trim() : null,
      ...(body.participantAgentIDs !== undefined ? { participantAgentIDs: body.participantAgentIDs } : {}),
      ...(body.teamIDs !== undefined ? { teamIDs: body.teamIDs } : {}),
    });

    writeJSON(response, 201, {
      data: {
        session: await withEffectivePreferences(frameRuntime, session),
      },
    });
    return true;
  }

  // Effective preferences are derived from this session and its ancestors. The
  // manifest stores only own values; this endpoint is the focused lookup a UI
  // can use when it has not loaded the whole hierarchy. `?key=` returns the one
  // requested value as well as the full effective map.
  let preferencesRoute = matchSessionPreferencesRoute(url.pathname);
  if (request.method === 'GET' && preferencesRoute) {
    let frameRuntime = context.require('frameRuntime');
    let resolved = await frameRuntime.getEffectivePreferences(preferencesRoute.sessionID);
    let keyParam = url.searchParams.get('key');
    let key = null;
    if (keyParam != null && keyParam.trim() !== '') {
      try {
        key = normalizePreferenceKey(keyParam);
      } catch (error) {
        throw httpError(400, error.message);
      }
    }

    writeJSON(response, 200, {
      data: {
        sessionID: preferencesRoute.sessionID,
        preferences: resolved.preferences,
        ownPreferences: resolved.ownPreferences || {},
        defaults: SESSION_PREFERENCE_DEFAULTS,
        ...(key ? {
          key,
          value: effectivePreference(resolved.preferences, key),
          found: Object.hasOwn(resolved.preferences, key),
        } : {}),
      },
    });
    return true;
  }

  let sessionUpdateRoute = matchSessionUpdateRoute(url.pathname);
  if (request.method === 'PATCH' && sessionUpdateRoute) {
    let body = await readJSON(request);
    if (Object.hasOwn(body, 'title') && (typeof body.title !== 'string' || body.title.trim() === ''))
      throw httpError(400, 'title must be a non-empty string');

    let frameRuntime = context.require('frameRuntime');
    let session = await frameRuntime.updateSession(sessionUpdateRoute.sessionID, body);

    writeJSON(response, 200, {
      data: {
        session: await withEffectivePreferences(frameRuntime, session),
      },
    });
    return true;
  }

  // Soft delete: stamp the session manifest with deletedAt. Nothing is
  // removed; a later "show deleted sessions" filter reads this field.
  let sessionDeleteRoute = matchSessionDeleteRoute(url.pathname);
  if (request.method === 'DELETE' && sessionDeleteRoute) {
    let frameRuntime = context.require('frameRuntime');
    let session = await frameRuntime.deleteSession(sessionDeleteRoute.sessionID);

    writeJSON(response, 200, {
      data: {
        session: await withEffectivePreferences(frameRuntime, session),
      },
    });
    return true;
  }

  // Restore (undelete): clear the soft-delete stamp so the session returns to
  // life. The inverse of DELETE, and the "show deleted sessions" undo. Nothing
  // is created or destroyed; only the manifest field changes.
  let sessionRestoreRoute = matchSessionRestoreRoute(url.pathname);
  if (request.method === 'POST' && sessionRestoreRoute) {
    let frameRuntime = context.require('frameRuntime');
    let session = await frameRuntime.updateSession(sessionRestoreRoute.sessionID, {
      deletedAt: null,
    });

    writeJSON(response, 200, {
      data: {
        session: await withEffectivePreferences(frameRuntime, session),
      },
    });
    return true;
  }

  // P8: retry a prior compaction, overwriting its frame in place. Frames are
  // immutable history, so the frame must exist; an unknown frame is a 404.
  let retryRoute = matchSessionCompactionRetryRoute(url.pathname);
  if (request.method === 'POST' && retryRoute) {
    let frameRuntime = context.require('frameRuntime');
    let entry = frameRuntime.requireSessionEntry(retryRoute.sessionID);
    if (!entry.frameEngine?.get?.(retryRoute.frameID))
      throw httpError(404, `Unknown compaction frame: ${retryRoute.frameID}`);

    let compactionService = context.has('compactionService') ? context.require('compactionService') : null;
    if (typeof compactionService?.retryCompaction !== 'function')
      throw httpError(500, 'Compaction service is unavailable');

    let services = typeof frameRuntime.routerServices === 'function'
      ? frameRuntime.routerServices()
      : { context, frameRuntime };

    let frame = await compactionService.retryCompaction({
      session: entry.session,
      frameEngine: entry.frameEngine,
      compactionFrameID: retryRoute.frameID,
      services,
    });

    if (!frame)
      throw httpError(404, `Unknown compaction frame: ${retryRoute.frameID}`);

    writeJSON(response, 200, {
      data: {
        frame,
      },
    });
    return true;
  }

  let cancelRoute = matchSessionCancelRoute(url.pathname);
  if (cancelRoute && request.method === 'POST') {
    let body = await readJSON(request);
    let agentManager = context.require('agentManager');
    let frameRuntime = context.require('frameRuntime');
    let processManager = context.has?.('processManager') ? context.require('processManager') : null;
    let result = await suspendSessionAgents({
      sessionID: cancelRoute.sessionID,
      target: typeof body.target === 'string' ? body.target : null,
      frameRuntime,
      agentManager,
      processManager,
    });

    writeJSON(response, 200, { data: result });
    return true;
  }

  let composerRoute = matchSessionComposerRoute(url.pathname);
  if (composerRoute) {
    let account = await getRequestAccount(context, request);
    if (!account?.id)
      throw httpError(401, 'Authentication required');
    let frameRuntime = context.require('frameRuntime');

    if (request.method === 'GET' && composerRoute.resource === 'history') {
      let result = await frameRuntime.listComposerHistory(composerRoute.sessionID, {
        userID: account.id,
        query: url.searchParams.get('q') || '',
        limit: parsePositiveInteger(url.searchParams.get('limit'), 30),
        before: parseOptionalNonNegativeInteger(url.searchParams.get('before')),
      });
      writeJSON(response, 200, { data: result });
      return true;
    }

    if (request.method === 'GET' && composerRoute.resource === 'drafts') {
      let result = await frameRuntime.listComposerDrafts(composerRoute.sessionID, {
        userID: account.id,
        limit: parsePositiveInteger(url.searchParams.get('limit'), 50),
        before: parseOptionalNonNegativeInteger(url.searchParams.get('before')),
      });
      writeJSON(response, 200, { data: result });
      return true;
    }
  }

  let draftRoute = matchSessionComposerDraftRoute(url.pathname);
  if (draftRoute && request.method === 'PUT') {
    let account = await getRequestAccount(context, request);
    if (!account?.id)
      throw httpError(401, 'Authentication required');
    let body = await readJSON(request);
    if (typeof body.text !== 'string')
      throw httpError(400, 'text must be a string');
    let frameRuntime = context.require('frameRuntime');
    let draft = await frameRuntime.upsertComposerDraft(draftRoute.sessionID, {
      draftID: draftRoute.draftID,
      userID: account.id,
      authorDisplayName: account.name || 'You',
      text: body.text,
    });
    writeJSON(response, 200, { data: { draft } });
    return true;
  }

  if (draftRoute && request.method === 'DELETE') {
    let account = await getRequestAccount(context, request);
    if (!account?.id)
      throw httpError(401, 'Authentication required');
    let frameRuntime = context.require('frameRuntime');
    await frameRuntime.deleteComposerDraft(draftRoute.sessionID, {
      draftID: draftRoute.draftID,
      userID: account.id,
    });
    writeJSON(response, 200, { data: { draft: null } });
    return true;
  }

  let historyItemRoute = matchSessionComposerHistoryItemRoute(url.pathname);
  if (historyItemRoute && request.method === 'DELETE') {
    let account = await getRequestAccount(context, request);
    if (!account?.id)
      throw httpError(401, 'Authentication required');
    let frameRuntime = context.require('frameRuntime');
    let redacted = await frameRuntime.redactUserMessageFrame(historyItemRoute.sessionID, {
      frameID: historyItemRoute.frameID,
      userID: account.id,
    });
    writeJSON(response, 200, { data: { frame: redacted } });
    return true;
  }

  let framePageRoute = matchSessionFramePageRoute(url.pathname);
  if (framePageRoute && request.method === 'GET') {
    let frameRuntime = context.require('frameRuntime');
    if (framePageRoute.index) {
      writeJSON(response, 200, {
        data: await frameRuntime.listFramePageIndex(framePageRoute.sessionID, {
          pageSize: parsePositiveInteger(url.searchParams.get('pageSize'), 120),
        }),
      });
      return true;
    }

    let pageIndex = parseNonNegativeInteger(framePageRoute.pageIndex, null);
    if (pageIndex == null)
      throw httpError(400, 'frame page index must be a non-negative integer');
    let page = await frameRuntime.listFramePage(framePageRoute.sessionID, {
      pageIndex,
      pageSize: parsePositiveInteger(url.searchParams.get('pageSize'), 120),
    });
    // A page is browser display state. Send the same projection as the bounded
    // frame window so raw contentText/model-only fields do not make each page
    // megabytes over the loopback link.
    writeJSON(response, 200, {
      data: {
        ...page,
        frames: Array.isArray(page.frames)
          ? page.frames.map(projectClientFrameForWindow)
          : page.frames,
      },
    });
    return true;
  }

  let sessionRoute = matchSessionRoute(url.pathname);
  if (sessionRoute) {
    let frameRuntime = context.require('frameRuntime');

    if (request.method === 'GET' && sessionRoute.resource === 'frames') {
      // A bounded tail window is the default: no `before` means the newest page,
      // a `before` cursor means the newest page older than that raw order. An
      // explicit `offset` keeps the legacy ascending whole-session listFrames
      // behavior for existing callers.
      if (url.searchParams.has('offset')) {
        writeJSON(response, 200, {
          data: {
            frames: await frameRuntime.listFrames(sessionRoute.sessionID, {
              limit: parsePositiveInteger(url.searchParams.get('limit'), 1000),
              offset: parseNonNegativeInteger(url.searchParams.get('offset'), 0),
            }),
          },
        });
        return true;
      }

      let before = parseOptionalNonNegativeInteger(url.searchParams.get('before'));
      let options = {
        limit: parsePositiveInteger(url.searchParams.get('limit'), 100),
        before,
      };
      if (url.searchParams.has('start'))
        options.start = url.searchParams.get('start');
      if (url.searchParams.has('after'))
        options.after = parseOptionalNonNegativeInteger(url.searchParams.get('after'));

      // Filtering is a server concern: the client only ever holds a window, so
      // it cannot know whether matches exist outside what it has loaded. See
      // src/shared/frame-window-filters.mjs for why this is not a client predicate.
      let filters = parseFrameWindowFilters(url.searchParams);
      if (Object.keys(filters).length > 0)
        options.filters = filters;

      let query = url.searchParams.get('q');
      if (typeof query === 'string' && query.trim() !== '')
        options.query = query;

      writeJSON(response, 200, {
        data: await frameRuntime.listFrameWindow(sessionRoute.sessionID, options),
      });
      return true;
    }

    // Whole-session frame counts for the filter popup.
    //
    // The popup used to count whatever frames the browser happened to hold,
    // which answers "how many are on this page" and produced a page-sized Agent
    // number beside zeros for every kind that fell outside the page. Counts are
    // a session property, so they are a server answer. They are derived from
    // frame paths, never bodies: see `countFilterMatches`.
    if (request.method === 'GET' && sessionRoute.resource === 'frame-counts') {
      writeJSON(response, 200, {
        data: await frameRuntime.countSessionFrames(sessionRoute.sessionID),
      });
      return true;
    }

    if (request.method === 'POST' && sessionRoute.resource === 'messages') {
      let body = await readJSON(request);
      if (!body.text || typeof body.text !== 'string' || body.text.trim() === '')
        throw httpError(400, 'text is required');

      let draftID = normalizeMessageDraftID(body.draftID);
      let account = await getRequestAccount(context, request);
      let messageInput = {
        text: body.text,
        userID: account?.id || body.userID || body.authorID || null,
        ...(draftID ? { draftID } : {}),
        // The frame is committed and flushed before this point. Do not make
        // the HTTP response wait for the agent router to pick it up; the client
        // already has the durable frame and SSE will deliver the agent output.
        flushRouter: false,
      };
      let authorDisplayName = account?.name || body.authorDisplayName || '';
      if (authorDisplayName)
        messageInput.authorDisplayName = authorDisplayName;

      let result = await frameRuntime.appendUserMessage(sessionRoute.sessionID, messageInput);

      writeJSON(response, 201, {
        data: result,
      });
      return true;
    }
  }

  return false;
}

function normalizeMessageDraftID(value) {
  if (value == null || value === '')
    return null;
  if (typeof value !== 'string')
    throw httpError(400, 'draftID must be a string');
  let draftID = value.trim();
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(draftID))
    throw httpError(400, 'draftID must be a short URL-safe identifier');
  return draftID;
}

async function withEffectivePreferences(frameRuntime, session) {
  if (!session?.id || typeof frameRuntime?.getEffectivePreferences !== 'function')
    return session;

  let resolved = await frameRuntime.getEffectivePreferences(session.id);
  return {
    ...session,
    effectivePreferences: resolved.preferences,
  };
}
