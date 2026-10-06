'use strict';

import { createHash, randomUUID } from 'node:crypto';

import { authError } from './auth-error.mjs';

// User records and the email -> userId index, both stored through the generic
// driver document contract only (get/put/delete/list/batch). The index hashes
// the normalized email so a path listing never reveals an address.
const USERS_ROOT = '/kikx/auth/users';
const EMAIL_INDEX_ROOT = '/kikx/auth/email-index';

export function createUserStore({ db, clock = Date.now } = {}) {
  if (!db)
    throw new TypeError('createUserStore requires db');

  async function create({ email, name = '', username = '', roles = [ 'user' ] } = {}) {
    let normalizedEmail = normalizeEmail(email);
    let existing = await getByEmail(normalizedEmail);
    if (existing)
      throw authError(409, 'email_taken', `A user already exists for ${normalizedEmail}`);

    let now = clock();
    let user = {
      id: randomUUID(),
      type: 'user',
      email: normalizedEmail,
      username: normalizeOptionalString(username),
      name: normalizeOptionalString(name),
      roles: normalizeRoles(roles),
      disabled: false,
      createdAt: now,
      updatedAt: now,
    };

    await db.batch([
      { type: 'put', path: userPath(user.id), body: user },
      { type: 'put', path: emailIndexPath(normalizedEmail), body: { userId: user.id } },
    ]);

    return user;
  }

  async function get(id) {
    if (typeof id !== 'string' || id === '')
      return null;

    return await readUser(id);
  }

  // Returns null for an unknown or malformed email rather than throwing: the
  // magic-link request path must not distinguish the two.
  async function getByEmail(email) {
    let normalizedEmail;
    try {
      normalizedEmail = normalizeEmail(email);
    } catch (_error) {
      return null;
    }

    let index = await db.get(emailIndexPath(normalizedEmail));
    if (!index || typeof index.userId !== 'string')
      return null;

    return await readUser(index.userId);
  }

  async function list() {
    let { items } = await db.list(USERS_ROOT, { recursive: true });
    let users = [];
    for (let item of items) {
      let user = await readUserByPath(item.path);
      if (user)
        users.push(user);
    }

    return users;
  }

  async function count() {
    let { total } = await db.list(USERS_ROOT, { recursive: true });
    return total;
  }

  async function update(id, patch = {}) {
    let existing = await readUser(id);
    if (!existing)
      throw authError(404, 'user_not_found', `User not found: ${id}`);

    let next = { ...existing };
    if (Object.hasOwn(patch, 'name'))
      next.name = normalizeOptionalString(patch.name);

    if (Object.hasOwn(patch, 'username'))
      next.username = normalizeOptionalString(patch.username);

    if (Object.hasOwn(patch, 'disabled'))
      next.disabled = Boolean(patch.disabled);

    if (Object.hasOwn(patch, 'roles'))
      next.roles = normalizeRoles(patch.roles);

    let emailChanged = false;
    if (Object.hasOwn(patch, 'email')) {
      let normalizedEmail = normalizeEmail(patch.email);
      emailChanged = normalizedEmail !== existing.email;
      if (emailChanged) {
        let conflict = await getByEmail(normalizedEmail);
        if (conflict && conflict.id !== id)
          throw authError(409, 'email_taken', `A user already exists for ${normalizedEmail}`);
      }

      next.email = normalizedEmail;
    }

    next.updatedAt = clock();

    // Move the index atomically with the record so an interrupted update cannot
    // leave the old address pointing at a user whose email changed.
    let operations = [];
    if (emailChanged) {
      operations.push({ type: 'delete', path: emailIndexPath(existing.email) });
      operations.push({ type: 'put', path: emailIndexPath(next.email), body: { userId: id } });
    }

    operations.push({ type: 'put', path: userPath(id), body: next });
    await db.batch(operations);

    return next;
  }

  async function setRoles(id, roles) {
    return await update(id, { roles });
  }

  function isAdmin(user) {
    return Array.isArray(user?.roles) && user.roles.includes('admin');
  }

  async function readUser(id) {
    return await readUserByPath(userPath(id));
  }

  async function readUserByPath(path) {
    let record = await db.get(path);
    return record && record.type === 'user' ? record : null;
  }

  return { create, get, getByEmail, list, count, update, setRoles, isAdmin };
}

// Trim, lowercase and require a minimal `x@y.z` shape. Throws a 400 authError
// so create/update can surface it, while getByEmail catches and returns null.
export function normalizeEmail(email) {
  if (typeof email !== 'string')
    throw authError(400, 'invalid_email', 'email must be a string');

  let normalized = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized))
    throw authError(400, 'invalid_email', 'email must be a valid email address');

  return normalized;
}

function userPath(id) {
  return `${USERS_ROOT}/${id}.json`;
}

function emailIndexPath(normalizedEmail) {
  let digest = createHash('sha256').update(normalizedEmail).digest('hex');
  return `${EMAIL_INDEX_ROOT}/${digest}.json`;
}

function normalizeRoles(roles) {
  if (!Array.isArray(roles))
    throw authError(400, 'invalid_roles', 'roles must be an array');

  let cleaned = [ ...new Set(roles.map((role) => normalizeOptionalString(role)).filter(Boolean)) ];
  return cleaned.length > 0 ? cleaned : [ 'user' ];
}

function normalizeOptionalString(value) {
  if (value == null)
    return '';

  return String(value).trim();
}
