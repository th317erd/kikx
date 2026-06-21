'use strict';

const ROOT_USER_ID = '00000000-0000-0000-0000-000000000000';
const LOCAL_USER_ID = 'local-user';

export class AccountStore {
  constructor(options = {}) {
    let {
      aeordb,
      clock = () => Date.now(),
    } = options;

    if (!aeordb)
      throw new TypeError('AccountStore requires aeordb');

    this.aeordb = aeordb;
    this.clock = clock;
    this.memoryProfiles = new Map();
  }

  resolveIdentity(request) {
    let token = bearerTokenFromRequest(request);
    if (!token) {
      let error = new Error('Sign in before opening account settings');
      error.status = 401;
      throw error;
    }

    let claims = decodeJWTClaims(token);
    let userID = normalizeOptionalString(claims?.sub) || LOCAL_USER_ID;

    return {
      id: userID,
      token,
      claims: claims || {},
      isFallback: !claims?.sub,
      isRoot: userID === ROOT_USER_ID,
    };
  }

  async getAccount(identity) {
    let normalizedIdentity = normalizeIdentity(identity);
    await this.verifyIdentity(normalizedIdentity);
    let [systemUser, profile] = await Promise.all([
      this.loadSystemUser(normalizedIdentity),
      this.loadProfile(normalizedIdentity.id),
    ]);

    return normalizeAccount(normalizedIdentity, systemUser, profile);
  }

  async updateAccount(identity, input = {}) {
    let normalizedIdentity = normalizeIdentity(identity);
    await this.verifyIdentity(normalizedIdentity);
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

    let systemUser = await this.loadSystemUser(normalizedIdentity);
    if (systemUser && patch.email !== undefined) {
      systemUser = await this.updateSystemUserEmail(normalizedIdentity, patch.email, systemUser);
      nextProfile.email = systemUser?.email || patch.email;
      await this.saveProfile(normalizedIdentity.id, nextProfile);
    }

    return normalizeAccount(normalizedIdentity, systemUser, nextProfile);
  }

  async verifyIdentity(identity) {
    if (identity.isFallback || typeof this.aeordb.withToken !== 'function')
      return false;

    try {
      let userClient = this.aeordb.withToken(identity.token);
      if (typeof userClient?.listOwnAPIKeys === 'function')
        await userClient.listOwnAPIKeys();
      else
        await userClient?.request?.('GET', '/auth/keys');
      return true;
    } catch (error) {
      if (error?.status === 401 || error?.status === 403) {
        let authError = new Error('Sign in again before opening account settings');
        authError.status = 401;
        throw authError;
      }

      throw error;
    }
  }

  async loadSystemUser(identity) {
    if (identity.isFallback || identity.isRoot || typeof this.aeordb.getSystemUser !== 'function')
      return null;

    try {
      return await this.aeordb.getSystemUser(identity.id);
    } catch (error) {
      if (error?.status === 404 || error?.status === 403)
        return null;

      throw error;
    }
  }

  async updateSystemUserEmail(identity, email, existingUser = null) {
    if (identity.isFallback || identity.isRoot || typeof this.aeordb.updateSystemUser !== 'function')
      return existingUser;

    try {
      return await this.aeordb.updateSystemUser(identity.id, { email });
    } catch (error) {
      if (error?.status === 404 || error?.status === 403)
        return existingUser;

      throw error;
    }
  }

  async loadProfile(userID) {
    let path = this.profilePath(userID);
    if (typeof this.aeordb.getFile !== 'function')
      return this.memoryProfiles.get(path) || null;

    try {
      return await this.aeordb.getFile(path);
    } catch (error) {
      if (error?.status === 404)
        return null;

      throw error;
    }
  }

  async saveProfile(userID, profile) {
    let path = this.profilePath(userID);
    if (typeof this.aeordb.putFile !== 'function') {
      this.memoryProfiles.set(path, profile);
      return profile;
    }

    await this.aeordb.putFile(path, profile);
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

function normalizeAccount(identity, systemUser = null, profile = null) {
  let name = firstNonEmpty(
    profile?.name,
    profile?.displayName,
    systemUser?.displayName,
    systemUser?.name,
    systemUser?.username,
    profile?.email,
    systemUser?.email,
    identity.id === ROOT_USER_ID ? 'Root' : 'User',
  );
  let email = firstNonEmpty(profile?.email, systemUser?.email);

  return {
    id: identity.id,
    name,
    email,
    username: systemUser?.username || '',
    source: systemUser ? 'aeordb-user' : 'kikx-profile',
    createdAt: profile?.createdAt || systemUser?.created_at || systemUser?.createdAt || null,
    updatedAt: profile?.updatedAt || systemUser?.updated_at || systemUser?.updatedAt || null,
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

  let id = normalizeOptionalString(identity.id) || LOCAL_USER_ID;
  return {
    ...identity,
    id,
    isFallback: Boolean(identity.isFallback) || id === LOCAL_USER_ID,
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
