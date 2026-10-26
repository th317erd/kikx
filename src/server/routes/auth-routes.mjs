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
    let auth = await authService.verifyMagicLink(code, requestMeta(request));
    if (wantsHTML(request)) {
      writeMagicLinkHTML(response, auth, url.searchParams.get('redirect'));
      return true;
    }

    writeJSON(response, 200, { data: auth });
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

function wantsHTML(request) {
  let accept = String(request.headers?.accept || '').toLowerCase();
  if (accept.includes('application/json'))
    return false;
  if (request.headers?.['sec-fetch-mode'] === 'navigate')
    return true;
  return accept.includes('text/html') || accept.includes('application/xhtml+xml');
}

function writeMagicLinkHTML(response, auth, redirect) {
  let target = safeRedirectPath(redirect);
  let session = safeScriptJSON({
    token: auth?.token || '',
    refresh_token: auth?.refresh_token || '',
    expires_at: auth?.expires_at || null,
    user: auth?.user || null,
  });
  let targetJSON = safeScriptJSON(target);
  let html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Signing in to Kikx</title>
<style>
  html,body{height:100%;margin:0;background:#11161b;color:#dce3ea;font:16px system-ui,sans-serif}
  main{display:grid;place-content:center;height:100%;gap:10px;text-align:center}
  a{color:#5eead4}
</style>
</head>
<body>
<main>
  <strong>Signing you in to Kikx…</strong>
  <span>If nothing happens, <a id="continue" href="${escapeHTML(target)}">continue</a>.</span>
</main>
<script>
  const auth = ${session};
  try {
    sessionStorage.setItem('kikx.auth.session', JSON.stringify(auth));
    localStorage.setItem('kikx.auth.shared', JSON.stringify(auth));
  } catch (_error) {}
  location.replace(${targetJSON});
</script>
</body>
</html>`;

  response.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(html);
}

function safeRedirectPath(value) {
  if (typeof value !== 'string' || value.trim() === '')
    return '/';

  let text = value.trim();
  if (!text.startsWith('/') || text.startsWith('//') || text.includes('\\'))
    return '/';

  try {
    let url = new URL(text, 'http://kikx.local');
    if (url.origin !== 'http://kikx.local')
      return '/';
    return `${url.pathname}${url.search}${url.hash}`;
  } catch (_error) {
    return '/';
  }
}

function safeScriptJSON(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function escapeHTML(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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
