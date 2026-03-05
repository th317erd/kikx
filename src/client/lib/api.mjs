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

export function getOrCreateDm(agentId) {
  return request('POST', `/agents/${agentId}/dm`);
}

// Session endpoints

export function getSessions() {
  return request('GET', '/sessions');
}

export function getSession(sessionId) {
  return request('GET', `/sessions/${sessionId}`);
}

export function createSession(data) {
  return request('POST', '/sessions', data);
}

export function updateSession(sessionId, updates) {
  return request('PATCH', `/sessions/${sessionId}`, updates);
}

export function deleteSession(sessionId) {
  return request('DELETE', `/sessions/${sessionId}`);
}

export function addParticipant(sessionId, participantData) {
  return request('POST', `/sessions/${sessionId}/participants`, participantData);
}

export function removeParticipant(sessionId, participantId) {
  return request('DELETE', `/sessions/${sessionId}/participants/${participantId}`);
}

// Agent endpoints

export function getAgents() {
  return request('GET', '/agents');
}

export function getAgent(agentId) {
  return request('GET', `/agents/${agentId}`);
}

export function createAgent(data) {
  return request('POST', '/agents', data);
}

export function updateAgent(agentId, updates) {
  return request('PATCH', `/agents/${agentId}`, updates);
}

export function deleteAgent(agentId) {
  return request('DELETE', `/agents/${agentId}`);
}

// Ability endpoints

export function getAbilities() {
  return request('GET', '/abilities');
}

export function getAbility(abilityId) {
  return request('GET', `/abilities/${abilityId}`);
}

export function createAbility(data) {
  return request('POST', '/abilities', data);
}

export function updateAbility(abilityId, updates) {
  return request('PATCH', `/abilities/${abilityId}`, updates);
}

export function deleteAbility(abilityId) {
  return request('DELETE', `/abilities/${abilityId}`);
}

// Frame endpoints

export function getFrames(sessionId) {
  return request('GET', `/sessions/${sessionId}/frames`);
}

export function updateFrameContent(sessionId, frameId, content) {
  return request('PATCH', `/sessions/${sessionId}/frames/${frameId}`, { content });
}

// Interaction endpoints

export function sendMessage(sessionId, message, agentId) {
  return request('POST', `/sessions/${sessionId}/interact/send`, { message, agentId });
}

export function approvePermission(sessionId, frameId, body) {
  return request('POST', `/sessions/${sessionId}/interact/${frameId}`, body);
}

export function cancelInteraction(sessionId) {
  return request('POST', `/sessions/${sessionId}/interact/cancel`);
}

// Health endpoint

export function healthCheck() {
  return request('GET', '/health');
}
