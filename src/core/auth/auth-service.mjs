'use strict';

import { createApiKeyStore } from './api-key-store.mjs';
import { authError } from './auth-error.mjs';
import { buildMagicLinkURL, createLogMailer } from './mailer.mjs';
import { createMagicLinkStore } from './magic-link-store.mjs';
import { createSessionStore } from './session-store.mjs';
import { createUserStore } from './user-store.mjs';

// Driver-agnostic authentication core. It composes four document-backed stores
// and exposes the flows the HTTP layer needs. Every method is async and every
// failure is an authError (or null for the non-throwing access check), so the
// route layer never has to know which store rejected a request.
export function createAuthService(options = {}) {
  let db = options.db || options.aeordb;
  if (!db)
    throw new TypeError('createAuthService requires db (or the aeordb alias)');

  let clock = options.clock || Date.now;
  let logger = options.logger || console;
  let accessTTLSeconds = options.accessTTLSeconds ?? 3600;
  let refreshTTLSeconds = options.refreshTTLSeconds ?? 2592000;
  let magicLinkTTLSeconds = options.magicLinkTTLSeconds ?? 900;
  let publicURL = options.publicURL || '';
  let mailer = options.mailer || createLogMailer({ log: logger });

  // Fail fast on a malformed base URL: otherwise only known-email requests would
  // hit `new URL()` and throw, making the magic-link endpoint an existence
  // oracle (unknown addresses would still get a clean { ok: true }).
  if (publicURL) {
    try {
      new URL(publicURL);
    } catch (_error) {
      throw authError(500, 'invalid_public_url', `publicURL is not an absolute URL: ${publicURL}`);
    }
  }

  let users = createUserStore({ db, clock });
  let sessions = createSessionStore({ db, clock });
  let apiKeys = createApiKeyStore({ db, clock });
  let magicLinks = createMagicLinkStore({ db, clock });

  // Bootstrap the first administrator. Only acts while the user set is empty,
  // so a restart (or a race) can never create a second admin or resurrect a
  // deleted account.
  async function ensureAdmin({ email, name = '' } = {}) {
    let total = await users.count();
    if (total > 0)
      return { user: null, created: false };

    let user = await users.create({ email, name, roles: [ 'admin' ] });
    return { user, created: true };
  }

  // Always resolves with { ok: true }; a link is created and sent only for an
  // existing, enabled user, so the response never reveals which addresses are
  // registered. Mailer failures are logged, not surfaced.
  async function requestMagicLink(email, { redirectTo, userAgent, ip } = {}) {
    let user = await users.getByEmail(email);
    if (user && !user.disabled) {
      let { code, expiresAt } = await magicLinks.create({
        email: user.email,
        userId: user.id,
        ttlSeconds: magicLinkTTLSeconds,
      });
      try {
        let url = buildMagicLinkURL({ publicURL, code, redirectTo });
        await mailer.sendMagicLink({ to: user.email, url, code, expiresAt });
      } catch (error) {
        logger?.error?.(`Failed to send magic link for ${user.email}: ${error?.message || error}`);
      }

      logger?.info?.(`Magic link issued for ${user.email} (ua=${normalizeOptionalString(userAgent)} ip=${normalizeOptionalString(ip)})`);
    } else {
      logger?.info?.(`Magic link requested for unknown or disabled email: ${normalizeOptionalString(email)}`);
    }

    return { ok: true };
  }

  async function verifyMagicLink(code, { userAgent, ip } = {}) {
    let record = await magicLinks.consume(code);
    if (!record)
      throw authError(401, 'invalid_magic_link', 'Magic link is invalid or expired');

    let user = record.userId ? await users.get(record.userId) : await users.getByEmail(record.email);
    if (!user || user.disabled)
      throw authError(401, 'invalid_magic_link', 'Magic link is invalid or expired');

    let issued = await sessions.create({
      userId: user.id,
      accessTTLSeconds,
      refreshTTLSeconds,
      userAgent,
      ip,
    });

    return tokenResponse(issued, user);
  }

  async function exchangeApiKey(apiKey) {
    let userId = await apiKeys.verify(apiKey);
    if (!userId)
      throw authError(401, 'invalid_api_key', 'API key is invalid or expired');

    let user = await users.get(userId);
    if (!user || user.disabled)
      throw authError(401, 'invalid_api_key', 'API key is invalid or expired');

    let issued = await sessions.create({
      userId: user.id,
      accessTTLSeconds,
      refreshTTLSeconds,
    });

    return tokenResponse(issued, user);
  }

  async function refreshToken(refreshToken) {
    let rotated = await sessions.rotateRefresh(refreshToken, { accessTTLSeconds, refreshTTLSeconds });
    if (!rotated)
      throw authError(401, 'invalid_refresh_token', 'Refresh token is invalid or expired');

    let user = await users.get(rotated.session.userId);
    if (!user || user.disabled)
      throw authError(401, 'invalid_refresh_token', 'Refresh token is invalid or expired');

    return tokenResponse(rotated, user);
  }

  // Never throws: a malformed, expired, revoked or owner-disabled token all
  // resolve to null so middleware can treat them identically.
  async function verifyAccessToken(token) {
    try {
      let session = await sessions.verifyAccess(token);
      if (!session)
        return null;

      let user = await users.get(session.userId);
      if (!user || user.disabled)
        return null;

      return {
        id: user.id,
        sessionId: session.id,
        email: user.email,
        roles: [ ...(user.roles || []) ],
        isRoot: users.isAdmin(user),
        claims: {},
      };
    } catch (_error) {
      return null;
    }
  }

  async function getUser(id) {
    return await users.get(id);
  }

  async function getUserByEmail(email) {
    return await users.getByEmail(email);
  }

  async function updateUser(id, patch) {
    return await users.update(id, patch);
  }

  async function listApiKeys(userId) {
    return await apiKeys.list(userId);
  }

  async function createApiKey(userId, { label } = {}) {
    return await apiKeys.create({ userId, label });
  }

  async function revokeApiKey(userId, keyId) {
    return await apiKeys.revoke(userId, keyId);
  }

  async function revokeSession(sessionId) {
    return await sessions.revoke(sessionId);
  }

  async function revokeAllSessions(userId) {
    return await sessions.revokeAllForUser(userId);
  }

  function tokenResponse(issued, user) {
    return {
      token: issued.token,
      refresh_token: issued.refreshToken,
      expires_at: issued.accessExpiresAt,
      user: publicUser(user),
    };
  }

  return {
    db,
    users,
    sessions,
    apiKeys,
    magicLinks,
    ensureAdmin,
    requestMagicLink,
    verifyMagicLink,
    exchangeApiKey,
    refreshToken,
    verifyAccessToken,
    getUser,
    getUserByEmail,
    updateUser,
    listApiKeys,
    createApiKey,
    revokeApiKey,
    revokeSession,
    revokeAllSessions,
    publicUser,
  };
}

// Project a user record down to the fields safe to hand to a client or embed in
// a token payload. Never includes `disabled` or any hash.
export function publicUser(user) {
  if (!user)
    return null;

  return {
    id: user.id,
    email: user.email,
    username: user.username || '',
    name: user.name || '',
    roles: [ ...(user.roles || []) ],
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

function normalizeOptionalString(value) {
  if (value == null)
    return '';

  return String(value).trim();
}
