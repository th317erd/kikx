'use strict';

// Shared JSON/auth transport. Split from the data-loading commands so the data
// module stays under the source cap and retry/auth behavior has one home.

import {
  AUTH_SHARED_STORAGE_KEY,
  AUTH_STORAGE_KEY,
} from '../state/kikx-state.mjs';
import { readResponse } from './kikx-app-helpers.mjs';

export async function requestJSON(app, url, options = {}) {
  let request = {
    ...options,
    headers: apiHeaders(app, options.headers),
  };
  let response = await fetch(url, request);
  if (response.status !== 401 || !shouldRefreshForURL(url))
    return response;

  let refreshed = await refreshAuthToken(app);
  if (!refreshed)
    return response;

  return await fetch(url, {
    ...options,
    headers: apiHeaders(app, options.headers),
  });
}

function shouldRefreshForURL(url) {
  try {
    let path = new URL(url, globalThis.location?.origin || 'http://localhost').pathname;
    return !path.startsWith('/api/v1/auth/');
  } catch (_error) {
    return true;
  }
}

export async function getJSON(app, url) {
  return readResponse(await requestJSON(app, url));
}

export async function postJSON(app, url, body) {
  return readResponse(await requestJSON(app, url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  }));
}

export async function putJSON(app, url, body, options = {}) {
  return readResponse(await requestJSON(app, url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    keepalive: options.keepalive === true,
  }));
}

export async function patchJSON(app, url, body) {
  return readResponse(await requestJSON(app, url, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  }));
}

export async function deleteJSON(app, url) {
  let response = await requestJSON(app, url, {
    method: 'DELETE',
  });
  if (response.status === 204)
    return null;

  return readResponse(response);
}

export function refreshAuthToken(app) {
  if (app?._refreshAuthPromise)
    return app._refreshAuthPromise;

  let promise = refreshAuthTokenNow(app);
  if (app)
    app._refreshAuthPromise = promise;
  return promise.finally(() => {
    if (app?._refreshAuthPromise === promise)
      app._refreshAuthPromise = null;
  });
}

async function refreshAuthTokenNow(app) {
  if (!app?._state?.refreshToken)
    return false;

  // Another tab may already have rotated the shared refresh token. Adopt its
  // session instead of replaying our stale token, which would return 401 after
  // the first tab's rotation.
  let shared = readSharedAuthSession();
  if (shared?.token
    && shared.refresh_token
    && shared.refresh_token !== app._state.refreshToken) {
    adoptAuthSession(app, shared);
    if (Number(shared.expires_at) > Date.now() + 5000)
      return true;
  }

  let refreshToken = app._state.refreshToken;
  try {
    let response = await fetch('/api/v1/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    let result = await response.json().catch(() => null);
    if (!response.ok) {
      // Rotate-race fallback: the sibling may have refreshed while our request
      // was in flight. If the shared session changed, use it and retry the API.
      let latest = readSharedAuthSession();
      if (latest?.token
        && latest.refresh_token
        && latest.refresh_token !== refreshToken) {
        adoptAuthSession(app, latest);
        return true;
      }
      return false;
    }

    let auth = result?.data;
    if (!auth?.token)
      return false;
    adoptAuthSession(app, {
      ...auth,
      user: auth.user || app._state.account,
    });
    return true;
  } catch (_error) {
    return false;
  }
}

function readSharedAuthSession() {
  try {
    return JSON.parse(globalThis.localStorage?.getItem(AUTH_SHARED_STORAGE_KEY) || 'null');
  } catch (_error) {
    return null;
  }
}

function adoptAuthSession(app, auth) {
  if (!auth?.token)
    return false;
  app._state.authToken = auth.token;
  app._state.refreshToken = auth.refresh_token || app._state.refreshToken;
  persistAuthSession(auth);
  return true;
}

export function persistAuthSession(auth) {
  if (!auth?.token)
    return;
  let serialized = JSON.stringify(auth);
  try {
    globalThis.sessionStorage?.setItem(AUTH_STORAGE_KEY, serialized);
  } catch (_error) {}
  try {
    globalThis.localStorage?.setItem(AUTH_SHARED_STORAGE_KEY, serialized);
  } catch (_error) {}
}

export function clearAuthSession() {
  try { globalThis.sessionStorage?.removeItem(AUTH_STORAGE_KEY); } catch (_error) {}
  try { globalThis.localStorage?.removeItem(AUTH_SHARED_STORAGE_KEY); } catch (_error) {}
}

export function apiHeaders(app, headers = {}) {
  let next = { ...headers };
  if (app._state.authToken)
    next.Authorization = `Bearer ${app._state.authToken}`;

  return next;
}
