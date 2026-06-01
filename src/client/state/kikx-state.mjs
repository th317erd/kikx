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
  agentDetailsByID: {},
  agentFormConfig: {},
  agentFormMode: 'create',
  agentFormName: '',
  agentFormPluginID: '',
  agentFormSecrets: {},
  agentIDs: [],
  agentProviders: [],
  agentStatus: '',
  agentStatusKind: 'pending',
  authEmail: '',
  authStatus: '',
  authStatusKind: 'pending',
  authToken: savedAuth.token || '',
  connectionStatus: 'Disconnected',
  connectionStatusKind: 'error',
  draft: '',
  editingSessionID: '',
  editingSessionTitle: '',
  editingAgentID: '',
  framesBySessionID: {},
  magicCode: params.get('code') || '',
  managingAgents: false,
  refreshToken: savedAuth.refresh_token || '',
  selectedSessionID: '',
  sessionDetailsByID: {},
  sessionIDs: [],
  status: 'Checking AeorDB event stream...',
  statusKind: 'pending',
});

export function getAgents(state = kikxState) {
  return state.agentIDs
    .map((agentID) => state.agentDetailsByID[agentID])
    .filter(Boolean);
}

export function getSelectedAgentProvider(state = kikxState) {
  return state.agentProviders.find((provider) => provider.pluginID === state.agentFormPluginID) || null;
}

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

export function setAgentProviders(providers, state = kikxState) {
  state.agentProviders = Array.isArray(providers) ? providers.slice() : [];
}

export function setAgents(agents, state = kikxState) {
  let agentIDs = [];
  let agentDetailsByID = {};

  for (let agent of Array.isArray(agents) ? agents : []) {
    if (!agent?.id)
      continue;

    agentIDs.push(agent.id);
    agentDetailsByID[agent.id] = agent;
  }

  state.agentIDs = agentIDs;
  state.agentDetailsByID = agentDetailsByID;
}

export function upsertAgent(agent, state = kikxState) {
  if (!agent?.id)
    return;

  state.agentIDs = state.agentIDs.includes(agent.id) ? state.agentIDs : [ agent.id, ...state.agentIDs ];
  state.agentDetailsByID = {
    ...state.agentDetailsByID,
    [agent.id]: agent,
  };
}

export function removeAgent(agentID, state = kikxState) {
  state.agentIDs = state.agentIDs.filter((id) => id !== agentID);
  let next = { ...state.agentDetailsByID };
  delete next[agentID];
  state.agentDetailsByID = next;
}

export function resetAgentForm(state = kikxState) {
  state.agentFormMode = 'create';
  state.editingAgentID = '';
  state.agentFormName = '';
  state.agentFormPluginID = state.agentProviders[0]?.pluginID || '';
  state.agentFormConfig = {};
  state.agentFormSecrets = {};
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
