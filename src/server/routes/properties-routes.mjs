'use strict';

// Properties-store P3 (plan: docs/plans/properties-store.md): the HTTP
// surface for /api/v1/properties. The identity NEVER reaches the facade
// (§3) — this layer runs as the `core` caller and owns the transport's own
// scope rules: default scope = the caller's own account, explicit account
// scope must equal the caller (hostile cross-account = 403), global read
// open / global write behind the identity bar, session/plugin unreachable in
// v1, secrets returned as hasValue ONLY, optimistic version -> 409, and
// 401/503 gate parity with the auth family.

import { httpError, readJSON, writeJSON } from '../http-helpers.mjs';

const PROPERTIES_PATH = '/api/v1/properties';
const SCOPE_TYPES = Object.freeze([ 'global', 'account', 'session', 'plugin' ]);

// Auth-family local helper: any missing/invalid token collapses to one 401.
async function requireIdentity(context, request) {
  const accountStore = context.require('accountStore');
  try {
    return await accountStore.resolveIdentity(request);
  } catch (error) {
    if (error?.status === 401)
      throw httpError(401, error.message || 'Sign in required');
    throw error;
  }
}

// Transport scope rules. Validation (400) runs before authorization (403):
// an unknown vocabulary word is a malformed request, not a forbidden one.
function authorizeScope(identity, rawType, rawId) {
  const type = rawType === null || rawType === undefined || rawType === '' ? 'account' : String(rawType);
  if (!SCOPE_TYPES.includes(type))
    throw httpError(400, `unknown scope_type ${JSON.stringify(type)} (want ${SCOPE_TYPES.join(', ')})`);
  if (type === 'global')
    return { type: 'global', id: '' };
  if (type === 'account') {
    const id = rawId === null || rawId === undefined || rawId === '' ? identity.id : String(rawId);
    if (id !== identity.id)
      throw httpError(403, 'forbidden: that account scope is not yours');
    return { type: 'account', id };
  }
  throw httpError(403, `scope_type '${type}' is not reachable over HTTP in v1`);
}

// Secrets leave as hasValue ONLY — the plaintext never crosses the transport,
// on read or on write echo, no matter who asks.
function rowView(key, scope, row) {
  const secret = row.encryptionMethod !== null && row.encryptionMethod !== undefined;
  const view = {
    key,
    scope_type: scope.type,
    scope_id: scope.id,
    hasValue: row.value !== null && row.value !== undefined,
    version: row.version,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    updated_by: row.updatedBy,
    deleted_at: row.deletedAt,
  };
  if (!secret)
    view.value = row.value;
  return view;
}

// Store/facade codes -> HTTP, preserving `.code` on the thrown error so the
// response body can name it (the client keys 409 off status; the body keeps
// it greppable). Returns null for anything unmapped (let it become a 500).
function mapStoreError(error) {
  let status = null;
  switch (error?.code) {
    case 'property_key_invalid':
    case 'property_scope_invalid':
    case 'property_plugin_id_invalid':
    case 'property_value_too_large':
    case 'property_grant_invalid':
    case 'property_registry_invalid':
      status = 400;
      break;
    case 'property_denied':
      status = 403;
      break;
    case 'property_not_found':
      status = 404;
      break;
    case 'property_version_conflict':
      status = 409;
      break;
    case 'property_facade_unavailable':
      status = 503;
      break;
    case 'property_secret_key_missing':
      // Server lacks KIKX_PROPERTIES_ENCRYPTION_KEY — operator fix, never 4xx.
      status = 500;
      break;
    default:
      return null;
  }
  return Object.assign(httpError(status, error.message), { code: error.code });
}

async function facadeFor(context) {
  if (!context.has('propertiesFacade'))
    throw httpError(503, 'properties store unavailable');
  return context.require('propertiesFacade');
}

function requireKey(key) {
  if (typeof key !== 'string' || key === '')
    throw httpError(400, 'key is required');
  return key;
}

export async function handlePropertiesRoutes({ request, response, url, context }) {
  if (url.pathname !== PROPERTIES_PATH)
    return false;

  // Availability first (server condition), then identity, then scope.
  const facade = await facadeFor(context);

  if (request.method === 'GET') {
    const identity = await requireIdentity(context, request);
    const key = requireKey(url.searchParams.get('key'));
    const scope = authorizeScope(identity, url.searchParams.get('scope_type'), url.searchParams.get('scope_id'));
    let row;
    try {
      row = await facade.read('core', scope, key);
    } catch (error) {
      throw mapStoreError(error) ?? error;
    }
    if (!row)
      throw httpError(404, `no property at ${scope.type}:${scope.id} ${key}`);
    writeJSON(response, 200, { data: rowView(key, scope, row) });
    return true;
  }

  if (request.method === 'PUT') {
    const identity = await requireIdentity(context, request);
    const body = await readJSON(request);
    const key = requireKey(body?.key);
    if (!body || typeof body !== 'object' || !Object.prototype.hasOwnProperty.call(body, 'value'))
      throw httpError(400, 'value is required (null is a value; absence is not)');
    if (body.secret !== undefined && typeof body.secret !== 'boolean')
      throw httpError(400, 'secret must be a boolean');
    let expectedVersion = null;
    if (body.expectedVersion !== undefined && body.expectedVersion !== null) {
      if (!Number.isInteger(body.expectedVersion) || body.expectedVersion < 1)
        throw httpError(400, 'expectedVersion must be an integer >= 1');
      expectedVersion = body.expectedVersion;
    }
    const scope = authorizeScope(identity, body.scope_type, body.scope_id);
    let row;
    try {
      row = await facade.write('core', scope, key, body.value, {
        secret: body.secret === true,
        expectedVersion,
        updatedBy: identity.id, // audit seam (plan §10.7): WHO wrote over HTTP
      });
    } catch (error) {
      throw mapStoreError(error) ?? error;
    }
    writeJSON(response, 200, { data: rowView(key, scope, row) });
    return true;
  }

  if (request.method === 'DELETE') {
    const identity = await requireIdentity(context, request);
    const key = requireKey(url.searchParams.get('key'));
    let expectedVersion = null;
    const rawVersion = url.searchParams.get('expectedVersion');
    if (rawVersion !== null && rawVersion !== '') {
      const parsed = Number(rawVersion);
      if (!Number.isInteger(parsed) || parsed < 1)
        throw httpError(400, 'expectedVersion must be an integer >= 1');
      expectedVersion = parsed;
    }
    const scope = authorizeScope(identity, url.searchParams.get('scope_type'), url.searchParams.get('scope_id'));
    let deleted;
    try {
      deleted = await facade.remove('core', scope, key, {
        expectedVersion,
        updatedBy: identity.id,
      });
    } catch (error) {
      throw mapStoreError(error) ?? error;
    }
    writeJSON(response, 200, {
      data: {
        key,
        scope_type: scope.type,
        scope_id: scope.id,
        version: deleted.version,
        deleted_at: deleted.deletedAt,
        ok: true,
      },
    });
    return true;
  }

  return false;
}
