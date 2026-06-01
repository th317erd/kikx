'use strict';

import { ReactiveState } from '../lib/aeor-ui.mjs';
import {
  countMessageFrames,
  mergeSessions,
  setSessionFramesState,
  upsertSessionState,
} from './session-state-utils.mjs';

export const AUTH_STORAGE_KEY = 'kikx.auth.session';

let savedAuth = loadSavedAuth();
let params = new URLSearchParams(globalThis.location?.search || '');

export const kikxState = new ReactiveState({
  aeordbEventsURL: '',
  authEmail: '',
  authStatus: '',
  authStatusKind: 'pending',
  authToken: savedAuth.token || '',
  connectionStatus: 'Disconnected',
  connectionStatusKind: 'error',
  draft: '',
  editingSessionID: '',
  editingSessionTitle: '',
  framesBySessionID: {},
  magicCode: params.get('code') || '',
  refreshToken: savedAuth.refresh_token || '',
  selectedSessionID: '',
  sessionDetailsByID: {},
  sessionIDs: [],
  status: 'Checking AeorDB event stream...',
  statusKind: 'pending',
});

export function getSessions(state = kikxState) {
  return state.sessionIDs
    .map((sessionID) => state.sessionDetailsByID[sessionID])
    .filter(Boolean);
}

export function getSelectedSession(state = kikxState) {
  return state.sessionDetailsByID[state.selectedSessionID] || null;
}

export function getSelectedFrames(state = kikxState) {
  return state.framesBySessionID[state.selectedSessionID] || [];
}

export function setSessions(nextSessions, state = kikxState) {
  applySessionSnapshot(state, mergeSessions(state, nextSessions));
}

export function upsertSession(session, state = kikxState) {
  applySessionSnapshot(state, upsertSessionState(state, session));
}

export function setSessionFrames(sessionID, frames, state = kikxState) {
  applySessionSnapshot(state, setSessionFramesState(state, sessionID, frames));
}

export function resetSessionState(state = kikxState) {
  state.sessionIDs = [];
  state.sessionDetailsByID = {};
  state.framesBySessionID = {};
  state.selectedSessionID = '';
}

export { countMessageFrames };

function applySessionSnapshot(state, snapshot) {
  state.sessionIDs = snapshot.sessionIDs;
  state.sessionDetailsByID = snapshot.sessionDetailsByID;
  state.framesBySessionID = snapshot.framesBySessionID;
}

function loadSavedAuth() {
  try {
    return JSON.parse(sessionStorage.getItem(AUTH_STORAGE_KEY) || '{}') || {};
  } catch (_error) {
    return {};
  }
}
