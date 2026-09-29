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
  account: null,
  accountEditorOpen: false,
  accountFormEmail: '',
  accountFormName: '',
  accountStatus: '',
  accountStatusKind: 'pending',
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
  managingTeams: false,
  refreshToken: savedAuth.refresh_token || '',
  selectedSessionID: '',
  sessionDetailsByID: {},
  sessionIDs: [],
  status: 'Checking AeorDB event stream...',
  statusKind: 'pending',
  editingTeamID: '',
  teamDetailsByID: {},
  teamEditorOpen: false,
  teamFormMemberKeys: {},
  teamFormMode: 'create',
  teamFormName: '',
  teamIDs: [],
  teamStatus: '',
  teamStatusKind: 'pending',
  tokenUsage: {},
  totalTokensUsed: 0,
  workspaceView: params.get('view') === 'thread' ? 'thread' : 'grid',
  sessionPreviewsByID: {},
  previewsLoading: false,
  previewStatus: '',
});

export function getAgents(state = kikxState) {
  return state.agentIDs
    .map((agentID) => state.agentDetailsByID[agentID])
    .filter(Boolean);
}

export function getTeams(state = kikxState) {
  return state.teamIDs
    .map((teamID) => state.teamDetailsByID[teamID])
    .filter(Boolean);
}

export function setAccount(account, state = kikxState) {
  state.account = account && typeof account === 'object' ? { ...account } : null;
}

export function setAccountFormFromAccount(account = kikxState.account, state = kikxState) {
  let source = account && typeof account === 'object' ? account : {};
  state.accountFormName = source.name || '';
  state.accountFormEmail = source.email || '';
}

export function resetAccountState(state = kikxState) {
  state.account = null;
  state.accountEditorOpen = false;
  state.accountFormName = '';
  state.accountFormEmail = '';
  state.accountStatus = '';
  state.accountStatusKind = 'pending';
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

export function getSessionPreviews(state = kikxState) {
  let output = new Map();
  for (let [sessionID, preview] of Object.entries(state.sessionPreviewsByID || {}))
    output.set(sessionID, preview);

  return output;
}

export function setSessionPreviews(previews, state = kikxState) {
  let next = { ...state.sessionPreviewsByID };
  for (let preview of Array.isArray(previews) ? previews : []) {
    if (preview?.sessionID)
      next[preview.sessionID] = preview;
  }

  state.sessionPreviewsByID = next;
}

export function upsertSessionPreview(sessionID, preview, state = kikxState) {
  if (!sessionID || !preview)
    return;

  state.sessionPreviewsByID = {
    ...state.sessionPreviewsByID,
    [sessionID]: preview,
  };
}

export function setWorkspaceView(view, state = kikxState) {
  state.workspaceView = view === 'thread' ? 'thread' : 'grid';
}

export function setPreviewsLoading(loading, state = kikxState) {
  state.previewsLoading = loading === true;
}

export function setPreviewStatus(status, state = kikxState) {
  state.previewStatus = status || '';
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

export function setTeams(teams, state = kikxState) {
  let teamIDs = [];
  let teamDetailsByID = {};

  for (let team of Array.isArray(teams) ? teams : []) {
    if (!team?.id)
      continue;

    teamIDs.push(team.id);
    teamDetailsByID[team.id] = normalizeTeam(team);
  }

  state.teamIDs = teamIDs;
  state.teamDetailsByID = teamDetailsByID;
}

export function upsertTeam(team, state = kikxState) {
  if (!team?.id)
    return;

  state.teamIDs = state.teamIDs.includes(team.id) ? state.teamIDs : [ team.id, ...state.teamIDs ];
  state.teamDetailsByID = {
    ...state.teamDetailsByID,
    [team.id]: normalizeTeam(team),
  };
}

export function removeTeam(teamID, state = kikxState) {
  state.teamIDs = state.teamIDs.filter((id) => id !== teamID);
  let next = { ...state.teamDetailsByID };
  delete next[teamID];
  state.teamDetailsByID = next;
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

export function resetTeamForm(state = kikxState) {
  state.teamFormMode = 'create';
  state.editingTeamID = '';
  state.teamFormName = '';
  state.teamFormMemberKeys = {};
}

export function setTeamFormFromTeam(team, state = kikxState) {
  state.teamFormMode = 'edit';
  state.editingTeamID = team.id;
  state.teamFormName = team.name || '';
  state.teamFormMemberKeys = memberKeysFromTeam(team);
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

function normalizeTeam(team) {
  return {
    ...team,
    members: Array.isArray(team.members) ? team.members.map((member) => ({ ...member })) : [],
  };
}

function memberKeysFromTeam(team = {}) {
  let keys = {};
  for (let member of Array.isArray(team.members) ? team.members : []) {
    if (!member?.type || !member?.actorID)
      continue;

    keys[`${member.type}:${member.actorID}`] = true;
  }

  return keys;
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
