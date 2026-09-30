'use strict';

import {
  getRequestAccount,
  httpError,
  parseNonNegativeInteger,
  parseOptionalNonNegativeInteger,
  parsePositiveInteger,
  readJSON,
  writeJSON,
} from '../http-helpers.mjs';
import { matchSessionRoute, matchSessionUpdateRoute } from './route-matchers.mjs';

export async function handleSessionRoutes({ request, response, url, context }) {
  if (request.method === 'GET' && url.pathname === '/api/v1/sessions') {
    let frameRuntime = context.require('frameRuntime');
    writeJSON(response, 200, {
      data: {
        sessions: await frameRuntime.listSessions({
          limit: parsePositiveInteger(url.searchParams.get('limit'), 50),
          offset: parseNonNegativeInteger(url.searchParams.get('offset'), 0),
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
    });

    writeJSON(response, 201, {
      data: {
        session,
      },
    });
    return true;
  }

  let sessionUpdateRoute = matchSessionUpdateRoute(url.pathname);
  if (request.method === 'PATCH' && sessionUpdateRoute) {
    let body = await readJSON(request);
    if (!body.title || typeof body.title !== 'string' || body.title.trim() === '')
      throw httpError(400, 'title must be a non-empty string');

    let frameRuntime = context.require('frameRuntime');
    let session = await frameRuntime.updateSession(sessionUpdateRoute.sessionID, {
      title: body.title,
    });

    writeJSON(response, 200, {
      data: {
        session,
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
      writeJSON(response, 200, {
        data: await frameRuntime.listFrameWindow(sessionRoute.sessionID, {
          limit: parsePositiveInteger(url.searchParams.get('limit'), 100),
          before,
        }),
      });
      return true;
    }

    if (request.method === 'POST' && sessionRoute.resource === 'messages') {
      let body = await readJSON(request);
      if (!body.text || typeof body.text !== 'string' || body.text.trim() === '')
        throw httpError(400, 'text is required');

      let account = await getRequestAccount(context, request);
      let messageInput = {
        text: body.text,
        userID: account?.id || body.userID || body.authorID || null,
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
