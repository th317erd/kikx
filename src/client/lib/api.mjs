'use strict';

// REST API client for Kikx V2.
// Wraps fetch() with auth token handling, error normalization, and typed endpoint methods.

const STORAGE_KEY = 'kikx_auth';
let authToken = null;
let onUnauthorized = null;

const BASE_URL = '/kikx/api/v2';

export function setAuthToken(token) {
  authToken = token;
}

export function getAuthToken() { return authToken; }
export function setOnUnauthorized(callback) { onUnauthorized = callback; }

// Persist auth state to localStorage
export function persistAuth(token, user) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ token, user }));
  } catch (_e) { /* storage unavailable */ }
}

// Load auth state from localStorage. Returns { token, user } or null.
export function loadPersistedAuth() {
  try {
    let raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;

    let parsed = JSON.parse(raw);
    if (parsed && parsed.token) return parsed;
  } catch (_e) { /* corrupt or unavailable */ }

  return null;
}

// Clear persisted auth
export function clearPersistedAuth() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (_e) { /* storage unavailable */ }
}

class ApiError extends Error {
  constructor(status, message, body) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

export { ApiError };

async function request(method, path, body, options = {}) {
  let headers = {
    'Accept': 'application/json',
    ...options.headers,
  };

  if (authToken)
    headers['Authorization'] = `Bearer ${authToken}`;

  if (body && typeof body === 'object') {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(body);
  }

  let response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: method === 'GET' ? undefined : body,
    ...options.fetchOptions,
  });

  if (response.status === 401) {
    if (typeof onUnauthorized === 'function')
      onUnauthorized();

    throw new ApiError(401, 'Unauthorized', null);
  }

  let responseBody;
  let contentType = response.headers.get('Content-Type') || '';
  if (contentType.includes('application/json'))
    responseBody = await response.json();
  else
    responseBody = await response.text();

  if (!response.ok) {
    let errorMessage = (typeof responseBody === 'string')
      ? responseBody
      : (responseBody?.message || response.statusText);

    throw new ApiError(response.status, errorMessage, responseBody);
  }

  return responseBody;
}

// Auth endpoints

export function login(email, password) {
  return request('POST', '/auth/login', { email, password });
}

export function registerUser({ email, password, firstName, lastName, organizationName }) {
  return request('POST', '/auth/register', { email, password, firstName, lastName, organizationName });
}

export function getMe() {
  return request('GET', '/auth/me');
}

export function updateProfile(updates) {
  return request('PUT', '/auth/me', updates);
}

// DM endpoints

export function getOrCreateDm(agentID) {
  return request('POST', `/agents/${agentID}/dm`);
}

// Session endpoints

export function getSessions() {
  return request('GET', '/sessions');
}

export function getSession(sessionID) {
  return request('GET', `/sessions/${sessionID}`);
}

export function createSession(data) {
  return request('POST', '/sessions', data);
}

export function updateSession(sessionID, updates) {
  return request('PATCH', `/sessions/${sessionID}`, updates);
}

export function deleteSession(sessionID) {
  return request('DELETE', `/sessions/${sessionID}`);
}

export function addParticipant(sessionID, participantData) {
  return request('POST', `/sessions/${sessionID}/participants`, participantData);
}

export function removeParticipant(sessionID, participantID) {
  return request('DELETE', `/sessions/${sessionID}/participants/${participantID}`);
}

// Agent endpoints

export function getAgents() {
  return request('GET', '/agents');
}

export function getAgent(agentID) {
  return request('GET', `/agents/${agentID}`);
}

export function createAgent(data) {
  return request('POST', '/agents', data);
}

export function updateAgent(agentID, updates) {
  return request('PATCH', `/agents/${agentID}`, updates);
}

export function deleteAgent(agentID) {
  return request('DELETE', `/agents/${agentID}`);
}

// Ability endpoints

export function getAbilities() {
  return request('GET', '/abilities');
}

export function getAbility(abilityID) {
  return request('GET', `/abilities/${abilityID}`);
}

export function createAbility(data) {
  return request('POST', '/abilities', data);
}

export function updateAbility(abilityID, updates) {
  return request('PATCH', `/abilities/${abilityID}`, updates);
}

export function deleteAbility(abilityID) {
  return request('DELETE', `/abilities/${abilityID}`);
}

// Frame endpoints

export function getFrames(sessionID, options = {}) {
  let params = new URLSearchParams();

  if (options.beforeOrder !== undefined)
    params.set('beforeOrder', String(options.beforeOrder));

  if (options.afterOrder !== undefined)
    params.set('afterOrder', String(options.afterOrder));

  if (options.limit !== undefined)
    params.set('limit', String(options.limit));

  let query = params.toString();
  let url   = `/sessions/${sessionID}/frames${(query) ? `?${query}` : ''}`;

  return request('GET', url);
}

export function updateFrameContent(sessionID, frameID, content) {
  return request('PATCH', `/sessions/${sessionID}/frames/${frameID}`, { content });
}

// Interaction endpoints

export function sendMessage(sessionID, message, agentID, parentID) {
  let body = { message, convertMarkdown: true };
  if (agentID)
    body.agentID = agentID;

  if (parentID)
    body.parentID = parentID;

  return request('POST', `/sessions/${sessionID}/interact/send`, body);
}

export function approvePermission(sessionID, frameID, body) {
  return request('POST', `/sessions/${sessionID}/interact/${frameID}`, body);
}

export function cancelInteraction(sessionID) {
  return request('POST', `/sessions/${sessionID}/interact/cancel`);
}

// Health endpoint

export function healthCheck() {
  return request('GET', '/health');
}
