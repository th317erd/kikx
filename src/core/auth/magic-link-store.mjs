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

// Single-use magic links. The code is `<id>.<secret>` and only the secret hash
// is stored. consume() marks the record used before returning, so a replay
// observes consumedAt and is rejected. There is no compare-and-swap in the
// generic driver contract, so two truly concurrent consumes of the same code
// could both win; callers must treat links as low-concurrency one-shots.
const MAGIC_LINKS_ROOT = '/kikx/auth/magic-links';

export function createMagicLinkStore({ db, clock = Date.now } = {}) {
  if (!db)
    throw new TypeError('createMagicLinkStore requires db');

  async function create({ email, userId = null, ttlSeconds }) {
    if (typeof email !== 'string' || email.trim() === '')
      throw authError(400, 'invalid_email', 'email is required');

    let id = generateId();
    let secret = generateSecret();
    let now = clock();
    let record = {
      type: 'magic-link',
      id,
      email: email.trim(),
      userId,
      secretHash: hashSecret(secret),
      createdAt: now,
      expiresAt: now + Number(normalizeTTL(ttlSeconds)) * 1000,
      consumedAt: null,
    };

    await db.put(magicLinkPath(id), record);

    return { record, code: formatToken(id, secret), expiresAt: record.expiresAt };
  }

  async function consume(code) {
    let parsed = parseToken(code);
    if (!parsed)
      return null;

    let record = await readLink(parsed.id);
    if (!record || record.consumedAt != null)
      return null;

    let now = clock();
    if (!(record.expiresAt > now))
      return null;

    if (!secretsEqual(record.secretHash, hashSecret(parsed.secret)))
      return null;

    let consumed = { ...record, consumedAt: now };
    await db.put(magicLinkPath(record.id), consumed);
    return consumed;
  }

  async function readLink(id) {
    if (typeof id !== 'string' || id === '')
      return null;

    let record = await db.get(magicLinkPath(id));
    return record && record.type === 'magic-link' ? record : null;
  }

  return { create, consume };
}

function magicLinkPath(id) {
  return `${MAGIC_LINKS_ROOT}/${id}.json`;
}

function normalizeTTL(ttlSeconds) {
  let ttl = Number(ttlSeconds);
  return Number.isFinite(ttl) && ttl > 0 ? ttl : 0;
}
