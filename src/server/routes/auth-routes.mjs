'use strict';

import { httpError, readJSON, writeJSON } from '../http-helpers.mjs';

export async function handleAuthRoutes({ request, response, url, context }) {
  if (request.method === 'POST' && url.pathname === '/api/v1/auth/magic-link') {
    let body = await readJSON(request);
    if (!body.email || typeof body.email !== 'string')
      throw httpError(400, 'email is required');

    let aeordb = context.require('aeordb');
    writeJSON(response, 200, {
      data: await aeordb.requestMagicLink(body.email),
    });
    return true;
  }

  if (request.method === 'GET' && url.pathname === '/api/v1/auth/magic-link/verify') {
    let code = url.searchParams.get('code');
    if (!code)
      throw httpError(400, 'code is required');

    let aeordb = context.require('aeordb');
    writeJSON(response, 200, {
      data: await aeordb.verifyMagicLink(code),
    });
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/v1/auth/token') {
    let body = await readJSON(request);
    if (!body.api_key || typeof body.api_key !== 'string')
      throw httpError(400, 'api_key is required');

    let aeordb = context.require('aeordb');
    writeJSON(response, 200, {
      data: await aeordb.exchangeAPIKey(body.api_key),
    });
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/v1/auth/refresh') {
    let body = await readJSON(request);
    if (!body.refresh_token || typeof body.refresh_token !== 'string')
      throw httpError(400, 'refresh_token is required');

    let aeordb = context.require('aeordb');
    writeJSON(response, 200, {
      data: await aeordb.refreshToken(body.refresh_token),
    });
    return true;
  }

  return false;
}
