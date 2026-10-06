'use strict';

import { httpError, readJSON, writeJSON } from '../http-helpers.mjs';

export async function handleAuthRoutes({ request, response, url, context }) {
  if (request.method === 'POST' && url.pathname === '/api/v1/auth/magic-link') {
    let body = await readJSON(request);
    if (typeof body.email !== 'string' || !body.email)
      throw httpError(400, 'email is required');

    let authService = context.require('authService');
    writeJSON(response, 200, {
      data: await authService.requestMagicLink(body.email, {
        redirectTo: body.redirect,
        ...requestMeta(request),
      }),
    });
    return true;
  }

  if (request.method === 'GET' && url.pathname === '/api/v1/auth/magic-link/verify') {
    let code = url.searchParams.get('code');
    if (!code)
      throw httpError(400, 'code is required');

    let authService = context.require('authService');
    writeJSON(response, 200, {
      data: await authService.verifyMagicLink(code, requestMeta(request)),
    });
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/v1/auth/token') {
    let body = await readJSON(request);
    if (typeof body.api_key !== 'string' || !body.api_key)
      throw httpError(400, 'api_key is required');

    let authService = context.require('authService');
    writeJSON(response, 200, {
      data: await authService.exchangeApiKey(body.api_key),
    });
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/v1/auth/refresh') {
    let body = await readJSON(request);
    if (typeof body.refresh_token !== 'string' || !body.refresh_token)
      throw httpError(400, 'refresh_token is required');

    let authService = context.require('authService');
    writeJSON(response, 200, {
      data: await authService.refreshToken(body.refresh_token),
    });
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/v1/auth/logout') {
    let authService = context.require('authService');
    let accountStore = context.require('accountStore');
    let identity = null;
    try {
      identity = await accountStore.resolveIdentity(request);
    } catch (error) {
      if (error?.status !== 401)
        throw error;
    }

    if (identity?.sessionId)
      await authService.revokeSession(identity.sessionId);

    writeJSON(response, 200, { data: { ok: true } });
    return true;
  }

  if (request.method === 'GET' && url.pathname === '/api/v1/auth/me') {
    let authService = context.require('authService');
    let identity = await requireIdentity(context, request);
    writeJSON(response, 200, {
      data: { user: authService.publicUser(await authService.getUser(identity.id)) },
    });
    return true;
  }

  if (request.method === 'GET' && url.pathname === '/api/v1/auth/api-keys') {
    let authService = context.require('authService');
    let identity = await requireIdentity(context, request);
    writeJSON(response, 200, {
      data: { keys: await authService.listApiKeys(identity.id) },
    });
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/v1/auth/api-keys') {
    let authService = context.require('authService');
    let identity = await requireIdentity(context, request);
    let body = await readJSON(request);
    writeJSON(response, 200, {
      data: await authService.createApiKey(identity.id, { label: body.label }),
    });
    return true;
  }

  if (request.method === 'DELETE' && url.pathname.startsWith('/api/v1/auth/api-keys/')) {
    let authService = context.require('authService');
    let identity = await requireIdentity(context, request);
    let keyID = decodeURIComponent(url.pathname.slice('/api/v1/auth/api-keys/'.length));
    if (!keyID)
      throw httpError(400, 'key id is required');

    writeJSON(response, 200, {
      data: { revoked: await authService.revokeApiKey(identity.id, keyID) },
    });
    return true;
  }

  return false;
}

// Resolve the bearer identity for the signed-in endpoints. Any missing or
// invalid token becomes a single 401 so the route layer never leaks which
// store rejected the request.
async function requireIdentity(context, request) {
  let accountStore = context.require('accountStore');
  try {
    return await accountStore.resolveIdentity(request);
  } catch (error) {
    if (error?.status === 401)
      throw httpError(401, error.message || 'Sign in required');

    throw error;
  }
}

function requestMeta(request) {
  return {
    userAgent: String(request.headers?.['user-agent'] || ''),
    ip: String(request.socket?.remoteAddress || ''),
  };
}
