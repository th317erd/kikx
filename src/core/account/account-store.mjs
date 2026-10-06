'use strict';

const ROOT_USER_ID = '00000000-0000-0000-0000-000000000000';

// Account projection over the generic driver contract and the Kikx-native
// AuthService. Identity, names and emails come from the auth user record; the
// `/kikx/users/<id>/profile.json` document keeps presentation-only fields
// (display name, timestamps, future preferences).
export class AccountStore {
  constructor(options = {}) {
    let db = options.db || options.aeordb;
    let {
      authService,
      clock = () => Date.now(),
    } = options;

    if (!db)
      throw new TypeError('AccountStore requires db (or the aeordb alias)');

    if (!authService)
      throw new TypeError('AccountStore requires authService');

    this.aeordb = db;
    this.db = db;
    this.authService = authService;
    this.clock = clock;
  }

  async resolveIdentity(request) {
    let token = bearerTokenFromRequest(request);
    if (!token) {
      let error = new Error('Sign in before opening account settings');
      error.status = 401;
      throw error;
    }

    let identity = await this.authService.verifyAccessToken(token);
    if (!identity) {
      let error = new Error('Sign in again before opening account settings');
      error.status = 401;
      throw error;
    }

    return { ...identity, token };
  }

  async verifyIdentity(identity) {
    return Boolean(await this.authService.verifyAccessToken(identity?.token || ''));
  }

  async getAccount(identity) {
    let normalizedIdentity = normalizeIdentity(identity);
    let [user, profile] = await Promise.all([
      this.authService.getUser(normalizedIdentity.id),
      this.loadProfile(normalizedIdentity.id),
    ]);

    return normalizeAccount(normalizedIdentity, user, profile);
  }

  async updateAccount(identity, input = {}) {
    let normalizedIdentity = normalizeIdentity(identity);
    let patch = normalizeAccountPatch(input);
    let now = this.clock();
    let existingProfile = await this.loadProfile(normalizedIdentity.id);
    let nextProfile = {
      ...existingProfile,
      ...patch,
      id: normalizedIdentity.id,
      updatedAt: now,
    };

    if (!existingProfile?.createdAt)
      nextProfile.createdAt = now;

    await this.saveProfile(normalizedIdentity.id, nextProfile);

    let userPatch = {};
    if (patch.name !== undefined)
      userPatch.name = patch.name;

    if (patch.email)
      userPatch.email = patch.email;

    let user = Object.keys(userPatch).length > 0
      ? await this.authService.updateUser(normalizedIdentity.id, userPatch)
      : await this.authService.getUser(normalizedIdentity.id);

    return normalizeAccount(normalizedIdentity, user, nextProfile);
  }

  async loadProfile(userID) {
    let path = this.profilePath(userID);
    try {
      let profile = await this.db.get(path);
      return profile ?? null;
    } catch (error) {
      if (error?.status === 404)
        return null;

      throw error;
    }
  }

  async saveProfile(userID, profile) {
    let path = this.profilePath(userID);
    await this.db.put(path, profile);
    return profile;
  }

  profilePath(userID) {
    return `/kikx/users/${encodeURIComponent(normalizeRequiredString(userID, 'userID'))}/profile.json`;
  }
}

export function bearerTokenFromRequest(request) {
  let authorization = request?.headers?.authorization || request?.headers?.Authorization || '';
  if (Array.isArray(authorization))
    authorization = authorization[0] || '';

  let match = /^Bearer\s+(.+)$/i.exec(String(authorization).trim());
  return match?.[1]?.trim() || '';
}

export function decodeJWTClaims(token) {
  if (!token || typeof token !== 'string')
    return null;

  let parts = token.split('.');
  if (parts.length < 2)
    return null;

  try {
    return JSON.parse(Buffer.from(base64URLToBase64(parts[1]), 'base64').toString('utf8'));
  } catch (_error) {
    return null;
  }
}

function normalizeAccount(identity, user = null, profile = null) {
  let name = firstNonEmpty(
    profile?.name,
    profile?.displayName,
    user?.name,
    user?.username,
    profile?.email,
    user?.email,
    identity.id === ROOT_USER_ID ? 'Root' : 'User',
  );
  let email = firstNonEmpty(profile?.email, user?.email);

  return {
    id: identity.id,
    name,
    email,
    username: user?.username || '',
    source: 'kikx-user',
    createdAt: profile?.createdAt || user?.createdAt || null,
    updatedAt: profile?.updatedAt || user?.updatedAt || null,
  };
}

function normalizeAccountPatch(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    let error = new Error('Account update body must be an object');
    error.status = 400;
    throw error;
  }

  let patch = {};
  if (input.name !== undefined) {
    let name = normalizeRequiredString(input.name, 'name');
    if (name.length > 120) {
      let error = new Error('name must be 120 characters or fewer');
      error.status = 400;
      throw error;
    }
    patch.name = name;
  }

  if (input.email !== undefined) {
    let email = normalizeOptionalString(input.email);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      let error = new Error('email must be a valid email address');
      error.status = 400;
      throw error;
    }
    patch.email = email;
  }

  if (Object.keys(patch).length === 0) {
    let error = new Error('At least one account field is required');
    error.status = 400;
    throw error;
  }

  return patch;
}

function normalizeIdentity(identity) {
  if (!identity || typeof identity !== 'object')
    throw new TypeError('identity is required');

  let id = normalizeOptionalString(identity.id);
  if (!id)
    throw new TypeError('identity.id is required');

  return {
    ...identity,
    id,
    isRoot: Boolean(identity.isRoot) || id === ROOT_USER_ID,
  };
}

function normalizeRequiredString(value, name) {
  let normalized = normalizeOptionalString(value);
  if (!normalized) {
    let error = new Error(`${name} is required`);
    error.status = 400;
    throw error;
  }

  return normalized;
}

function normalizeOptionalString(value) {
  if (value == null)
    return '';

  return String(value).trim();
}

function firstNonEmpty(...values) {
  for (let value of values) {
    let normalized = normalizeOptionalString(value);
    if (normalized)
      return normalized;
  }

  return '';
}

function base64URLToBase64(value) {
  let output = String(value).replace(/-/g, '+').replace(/_/g, '/');
  while (output.length % 4 !== 0)
    output += '=';
  return output;
}
