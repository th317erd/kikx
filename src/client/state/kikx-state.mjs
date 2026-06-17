'use strict';

import { ReactiveState } from '../lib/aeor-ui.mjs';
import {
  defaultConfigForProvider,
  mergeAgentConfigWithProviderDefaults,
} from './agent-state-utils.mjs';
import {
  countMessageFrames,
  mergeSessions,
  setSessionFramesState,
  upsertFramesState,
  upsertFrameState,
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
  agentEditorOpen: false,
  agentProviders: [],
  agentStatus: '',
  agentStatusKind: 'pending',
  authEmail: '',
  authStatus: '',
  authStatusKind: 'pending',
  authToken: savedAuth.token || '',
  clientComponentStatus: 'pending',
  clientFrameComponentsByType: {},
  clientToolComponentsByName: {},
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
  tokenUsage: {},
  totalTokensUsed: 0,
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

export function upsertFrame(sessionID, frame, state = kikxState) {
  applySessionSnapshot(state, upsertFrameState(state, sessionID, frame));
}

export function upsertFrames(framesBySessionID, state = kikxState) {
  applySessionSnapshot(state, upsertFramesState(state, framesBySessionID));
}

export function setTokenUsage(tokenUsage, totalTokensUsed = null, state = kikxState) {
  let snapshot = normalizeTokenUsageSnapshot(tokenUsage);
  state.tokenUsage = snapshot;
  state.totalTokensUsed = totalTokensUsed == null
    ? totalTokensUsedFromSnapshot(snapshot)
    : normalizeNonNegativeInteger(totalTokensUsed);
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

export function setClientComponents(components, state = kikxState) {
  let frameComponents = {};
  let toolComponents = {};

  for (let component of Array.isArray(components) ? components : []) {
    if (component?.kind === 'frame' && component.frameType)
      frameComponents[component.frameType] = component;
    else if (component?.kind === 'tool' && component.toolName)
      toolComponents[component.toolName] = component;
  }

  state.clientFrameComponentsByType = frameComponents;
  state.clientToolComponentsByName = toolComponents;
  state.clientComponentStatus = 'ready';
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
  let provider = state.agentProviders[0] || null;
  state.agentFormMode = 'create';
  state.editingAgentID = '';
  state.agentFormName = '';
  state.agentFormPluginID = provider?.pluginID || '';
  state.agentFormConfig = defaultConfigForProvider(provider);
  state.agentFormSecrets = {};
}

export function setAgentFormProvider(pluginID, state = kikxState) {
  let provider = state.agentProviders.find((candidate) => candidate.pluginID === pluginID) || null;
  state.agentFormPluginID = pluginID || '';
  state.agentFormConfig = defaultConfigForProvider(provider);
  state.agentFormSecrets = {};
}

export function setAgentFormFromAgent(agent, state = kikxState) {
  let provider = state.agentProviders.find((candidate) => candidate.pluginID === agent?.pluginID) || null;
  state.agentFormMode = 'edit';
  state.editingAgentID = agent.id;
  state.agentFormName = agent.name || '';
  state.agentFormPluginID = agent.pluginID || '';
  state.agentFormConfig = mergeAgentConfigWithProviderDefaults(provider, agent.config);
  state.agentFormSecrets = {};
}

export { countMessageFrames };

function applySessionSnapshot(state, snapshot) {
  state.sessionIDs = snapshot.sessionIDs;
  state.sessionDetailsByID = snapshot.sessionDetailsByID;
  state.framesBySessionID = snapshot.framesBySessionID;
}

function normalizeTokenUsageSnapshot(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    return {};

  let output = {};
  for (let [key, value] of Object.entries(input)) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      continue;

    let tokensUsed = normalizeNonNegativeInteger(value.tokensUsed);
    if (tokensUsed <= 0)
      continue;

    output[key] = {
      ...value,
      tokensUsed,
    };
  }

  return output;
}

function totalTokensUsedFromSnapshot(snapshot) {
  let total = 0;
  for (let entry of Object.values(snapshot))
    total += normalizeNonNegativeInteger(entry?.tokensUsed);

  return total;
}

function normalizeNonNegativeInteger(value) {
  let number = Number(value);
  if (!Number.isFinite(number) || number <= 0)
    return 0;

  return Math.trunc(number);
}

function loadSavedAuth() {
  try {
    return JSON.parse(sessionStorage.getItem(AUTH_STORAGE_KEY) || '{}') || {};
  } catch (_error) {
    return {};
  }
}
