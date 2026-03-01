'use strict';

// =============================================================================
// Auth Middleware — Mythix-compatible (request, response, next)
// =============================================================================
// Adapts the existing V2 auth logic (cookie + Authorization header token
// extraction, JWT verification, UMK lazy accessor) into Mythix middleware
// format. Attaches userId, organizationId, and getUMK() to the request.
// =============================================================================

import { AuthError } from '../auth/index.mjs';

// --- Cookie Parser ---

function parseCookies(cookieString) {
  let cookies = {};

  if (!cookieString)
    return cookies;

  let pairs = cookieString.split(';');
  for (let i = 0; i < pairs.length; i++) {
    let pair  = pairs[i].trim();
    let eqIdx = pair.indexOf('=');

    if (eqIdx < 0)
      continue;

    let name  = pair.substring(0, eqIdx).trim();
    let value = pair.substring(eqIdx + 1).trim();

    cookies[name] = value;
  }

  return cookies;
}

// --- Token Extraction ---

function extractToken(request) {
  // 1. Cookie: kikx_token > token
  let cookieHeader = request.headers && request.headers.cookie;
  if (cookieHeader) {
    let cookies = parseCookies(cookieHeader);
    if (cookies.kikx_token)
      return cookies.kikx_token;

    if (cookies.token)
      return cookies.token;
  }

  // 2. Authorization: Bearer xxx
  let authHeader = request.headers && request.headers.authorization;
  if (authHeader) {
    let parts = authHeader.split(' ');
    if (parts.length === 2 && parts[0].toLowerCase() === 'bearer')
      return parts[1];
  }

  return null;
}

// --- Middleware ---

export async function authMiddleware(request, response, next) {
  let application = request.application || (response && response.application);

  if (!application)
    throw new AuthError('Application not available in middleware', 'AUTH_ERROR');

  let authService = application.getAuthService();

  let token = extractToken(request);
  if (!token)
    throw new AuthError('No token provided', 'MISSING_TOKEN');

  let decoded = authService.verifyToken(token);

  // Attach to request
  request.userId         = decoded.sub;
  request.organizationId = decoded.org;
  request.getUMK         = () => authService.getUMK(decoded);

  next();
}
