'use strict';

import { authError } from './auth-error.mjs';
import {
  formatToken,
  generateId,
  generateSecret,
  hashSecret,
  parseToken,
  secretsEqual,
} from './token-utils.mjs';

// Session records hold only secret hashes. Access and refresh tokens share the
// session id but carry distinct secrets, so knowing one cannot derive the
// other. Rotation replaces both hashes in place; the old tokens then fail every
// subsequent check.
const SESSIONS_ROOT = '/kikx/auth/sessions';

export function createSessionStore({ db, clock = Date.now } = {}) {
  if (!db)
    throw new TypeError('createSessionStore requires db');

  async function create({
    userId,
    accessTTLSeconds,
    refreshTTLSeconds,
    userAgent = '',
    ip = '',
  }) {
    if (typeof userId !== 'string' || userId === '')
      throw authError(400, 'invalid_user_id', 'userId is required');

    let now = clock();
    let id = generateId();
    let accessSecret = generateSecret();
    let refreshSecret = generateSecret();
    let session = {
      type: 'session',
      id,
      userId,
      accessHash: hashSecret(accessSecret),
      refreshHash: hashSecret(refreshSecret),
      createdAt: now,
      accessExpiresAt: now + ttlMillis(accessTTLSeconds),
      refreshExpiresAt: now + ttlMillis(refreshTTLSeconds),
      rotatedFrom: null,
      revokedAt: null,
      userAgent: normalizeOptionalString(userAgent),
      ip: normalizeOptionalString(ip),
    };

    await db.put(sessionPath(id), session);

    return {
      session,
      token: formatToken(id, accessSecret),
      refreshToken: formatToken(id, refreshSecret),
      accessExpiresAt: session.accessExpiresAt,
      refreshExpiresAt: session.refreshExpiresAt,
    };
  }

  async function verifyAccess(token) {
    let parsed = parseToken(token);
    if (!parsed)
      return null;

    let session = await readSession(parsed.id);
    if (!session || session.revokedAt != null)
      return null;

    if (!secretsEqual(session.accessHash, hashSecret(parsed.secret)))
      return null;

    if (!(session.accessExpiresAt > clock()))
      return null;

    return session;
  }

  // Rotate a refresh token: validate it, then replace BOTH secret hashes and
  // both expiries. The previous access token stops working because accessHash
  // changes; the previous refresh token likewise. `rotatedFrom` stores the
  // first 16 hex characters of the superseded access hash so a rotation chain
  // can be reconstructed without keeping the old secrets.
  async function rotateRefresh(refreshToken, { accessTTLSeconds, refreshTTLSeconds } = {}) {
    let parsed = parseToken(refreshToken);
    if (!parsed)
      return null;

    let session = await readSession(parsed.id);
    if (!session || session.revokedAt != null)
      return null;

    if (!secretsEqual(session.refreshHash, hashSecret(parsed.secret)))
      return null;

    let now = clock();
    if (!(session.refreshExpiresAt > now))
      return null;

    let accessSecret = generateSecret();
    let refreshSecret = generateSecret();
    let next = {
      ...session,
      accessHash: hashSecret(accessSecret),
      refreshHash: hashSecret(refreshSecret),
      createdAt: now,
      accessExpiresAt: now + ttlMillis(accessTTLSeconds),
      refreshExpiresAt: now + ttlMillis(refreshTTLSeconds),
      rotatedFrom: String(session.accessHash || '').slice(0, 16) || session.createdAt,
      revokedAt: null,
    };

    await db.put(sessionPath(session.id), next);

    return {
      session: next,
      token: formatToken(session.id, accessSecret),
      refreshToken: formatToken(session.id, refreshSecret),
      accessExpiresAt: next.accessExpiresAt,
      refreshExpiresAt: next.refreshExpiresAt,
    };
  }

  async function revoke(sessionId) {
    let session = await readSession(sessionId);
    if (!session || session.revokedAt != null)
      return false;

    await db.put(sessionPath(sessionId), { ...session, revokedAt: clock() });
    return true;
  }

  async function get(sessionId) {
    return await readSession(sessionId);
  }

  async function revokeAllForUser(userId) {
    let { items } = await db.list(SESSIONS_ROOT, { recursive: true });
    let now = clock();
    let revoked = 0;
    for (let item of items) {
      let session = await db.get(item.path);
      if (session?.type !== 'session' || session.userId !== userId || session.revokedAt != null)
        continue;

      await db.put(item.path, { ...session, revokedAt: now });
      revoked++;
    }

    return revoked;
  }

  async function readSession(id) {
    if (typeof id !== 'string' || id === '')
      return null;

    let record = await db.get(sessionPath(id));
    return record && record.type === 'session' ? record : null;
  }

  return { create, verifyAccess, rotateRefresh, revoke, get, revokeAllForUser };
}

function sessionPath(id) {
  return `${SESSIONS_ROOT}/${id}.json`;
}

function ttlMillis(seconds) {
  return Number(seconds) * 1000;
}

function normalizeOptionalString(value) {
  if (value == null)
    return '';

  return String(value).trim();
}
