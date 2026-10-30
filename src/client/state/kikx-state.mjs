'use strict';

import { ReactiveState } from '../lib/aeor-ui.mjs';
import {
  isReservedViewSurfaceID,
  syncViewNames,
  viewNamesFromComponents,
} from './view-name-registry.mjs';
import {
  defaultConfigForProvider,
  defaultTagValues,
  mergeAgentConfigWithProviderDefaults,
  tagValuesFromAgent,
} from './agent-state-utils.mjs';
import {
  boundSessionFrameCaches,
  boundSessionPreviews,
  countMessageFrames,
  forgetDeletedSessionState,
  isDeletedSession,
  mergeSessionFrameWindowState,
  mergeSessions,
  prependSessionFramesState,
  recordDeletedSessionState,
  removeSession as removeSessionState,
  resetSessionPagingState,
  setDeletedSessionsState,
  setSessionFramesState,
  setSessionPagingState,
  upsertFramesState,
  upsertFrameState,
  upsertSessionState,
} from './session-state-utils.mjs';
import { visibleSessions } from './session-visibility.mjs';
import { effectiveSessionAgentIDs, effectiveSessionTeamIDs } from '../../shared/session-actors.mjs';
import {
  createNavigationStack,
  isInboxView,
  pushInbox,
  pushView,
  currentViewName,
  scopeSessionID,
  currentEntry,
  currentSessionID,
  gridParentSessionID,
  popStack,
  pushThread,
  scopeNounForDepth,
  stackDepth,
} from './navigation-stack.mjs';
import { createQuestionsState } from './questions-state.mjs';
import { readDebugMode } from '../lib/debug-mode.mjs';
import {
  normalizePreferences,
  normalizePreferenceKey,
  resolvePreferencesFromSessions,
  SESSION_PREFERENCE_DEFAULTS,
} from '../../shared/session-preferences.mjs';

export const AUTH_STORAGE_KEY = 'kikx.auth.session';
export const AUTH_SHARED_STORAGE_KEY = 'kikx.auth.shared';

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
  agentFormErrors: {},
  agentFormMode: 'create',
  agentFormName: '',
  agentFormPluginID: '',
  agentFormSecrets: {},
  agentFormTags: {},
  agentIDs: [],
  agentEditorOpen: false,
  agentProviders: [],
  agentTagDefinitions: [],
  agentStatus: '',
  agentStatusKind: 'pending',
  authEmail: '',
  authStatus: '',
  authStatusKind: 'pending',
  authToken: savedAuth.token || '',
  clientComponentStatus: 'pending',
  clientFrameComponentsByType: {},
  clientToolComponentsByName: {},
  clientAgentConfigFormsByPluginID: {},
  // P4: plugin-contributed surfaces. Absent before this change, which is why a
  // 'view' or 'sidebar-item' descriptor could not reach the shell at all.
  clientViewSurfaces: {},
  clientSidebarItems: {},
  connectionStatus: 'Disconnected',
  connectionStatusKind: 'error',
  // The "show deleted sessions" eye and the title filter. deletedSessionIDs /
  // deletedSessionDetailsByID hold the soft-deleted bucket, which getSessions()
  // never returns; getVisibleSessions() merges it in only while the eye is on.
  deletedSessionDetailsByID: {},
  deletedSessionIDs: [],
  debugMode: readDebugMode(),
  draft: '',
  editingSessionID: '',
  editingSessionTitle: '',
  editingAgentID: '',
  framesBySessionID: {},
  // Whole-session frame counts, keyed by session id, as answered by the server's
  // `frame-counts` endpoint. Kept apart from `framesBySessionID` on purpose: that
  // map holds only the loaded window, and counting it is what made the filter
  // popup report page-sized numbers.
  frameCountsBySessionID: {},
  frameFilters: null,
  sessionPagingByID: {},
  // Why a session's frame window could not be loaded, keyed by session id.
  // The global `status` cannot carry this: the reload path repaints after a
  // failure without touching it, so an error there is silently swallowed and
  // the thread falls through to "No messages yet" — telling the user a session
  // is empty when the server refused to serve it. Keyed by session so a failure
  // in one window cannot caption another.
  frameLoadErrorsBySessionID: {},
  magicCode: params.get('code') || '',
  managingAgents: false,
  agentFilter: 'all',
  managingTeams: false,
  refreshToken: savedAuth.refresh_token || '',
  selectedSessionID: '',
  editingSessionNameID: '',
  editingSessionNameValue: '',
  sessionDetailsByID: {},
  sessionIDs: [],
  sessionSearch: '',
  showDeletedSessions: false,
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
  navigationStack: createNavigationStack(),
  // Ask-user Inbox state (plan §6). Kept as a nested slice so the inbox can be
  // re-fetched wholesale without touching session/frame state; the model treats
  // it as replace-only (see state/questions-state.mjs).
  questionsState: createQuestionsState(),
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
  // Filter defensively so no future path can leak a soft-deleted session into
  // the UI. Deep links to a deleted id therefore stop opening; when the future
  // "show deleted" filter lands it must reintroduce them via an explicit
  // includeDeleted path here and in mergeSessions/upsertSessionState.
  return state.sessionIDs
    .map((sessionID) => state.sessionDetailsByID[sessionID])
    .filter((session) => session && !isDeletedSession(session));
}

export function getSelectedSession(state = kikxState) {
  return state.sessionDetailsByID[state.selectedSessionID] || null;
}

export function getScopeSessionID(state = kikxState) {
  return scopeSessionID(getNavigationStack(state));
}

// Session-scoped actor views use the same inheritance rule as the server: own
// assignments plus every ancestor, never descendants or siblings.
export function getEffectiveSessionAgentIDs(state = kikxState, sessionID = state.selectedSessionID) {
  let sessions = { ...(state.deletedSessionDetailsByID || {}), ...(state.sessionDetailsByID || {}) };
  return effectiveSessionAgentIDs(sessionID, (id) => sessions[id] || null);
}

export function getEffectiveSessionTeamIDs(state = kikxState, sessionID = state.selectedSessionID) {
  let sessions = { ...(state.deletedSessionDetailsByID || {}), ...(state.sessionDetailsByID || {}) };
  return effectiveSessionTeamIDs(sessionID, (id) => sessions[id] || null);
}

// Resolve a session's effective preferences from the session records the client
// already holds. The same rules as the server apply: defaults, then ancestors
// root-to-leaf, then the session's own values. If an ancestor is missing (for
// example a deleted parent outside the loaded page), a server-supplied
// `effectivePreferences` field on the leaf is used as the fallback.
export function getSessionEffectivePreferences(state = kikxState, sessionID = state.selectedSessionID) {
  let sessionsByID = {
    ...(state.deletedSessionDetailsByID || {}),
    ...(state.sessionDetailsByID || {}),
  };

  try {
    let resolved = resolvePreferencesFromSessions(sessionsByID, sessionID);
    if (resolved.complete)
      return resolved.preferences;

    let supplied = sessionsByID[sessionID]?.effectivePreferences;
    if (supplied && typeof supplied === 'object')
      return { ...SESSION_PREFERENCE_DEFAULTS, ...normalizePreferences(supplied) };

    return resolved.preferences;
  } catch (_error) {
    // A malformed stored value must not break rendering; fall back to defaults.
    return { ...SESSION_PREFERENCE_DEFAULTS };
  }
}

export function getSessionPreference(state = kikxState, sessionID = state.selectedSessionID, key, fallback = undefined) {
  let normalizedKey = normalizePreferenceKey(key);
  let preferences = getSessionEffectivePreferences(state, sessionID);
  return Object.hasOwn(preferences, normalizedKey)
    ? preferences[normalizedKey]
    : fallback;
}

export function getSelectedFrames(state = kikxState) {
  return state.framesBySessionID[state.selectedSessionID] || [];
}

export function getSessionPaging(state = kikxState, sessionID = state.selectedSessionID) {
  return state.sessionPagingByID[sessionID] || {};
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

  state.sessionPreviewsByID = boundSessionPreviews(next, state.sessionIDs);
}

export function upsertSessionPreview(sessionID, preview, state = kikxState) {
  if (!sessionID || !preview)
    return;

  state.sessionPreviewsByID = boundSessionPreviews({
    ...state.sessionPreviewsByID,
    [sessionID]: preview,
  }, state.sessionIDs);
}

export function getNavigationStack(state = kikxState) {
  return state.navigationStack || createNavigationStack();
}

export function getCurrentEntry(state = kikxState) {
  return currentEntry(getNavigationStack(state));
}

export function getCurrentSessionID(state = kikxState) {
  return currentSessionID(getNavigationStack(state));
}
// A session entry can no longer be collapsed: the child grid that `collapsed`
// used to select is gone, and the URL parser discards the legacy flag. The flag
// survives only on the root entry, so this reports false for every session.
export function isCollapsed(state = kikxState) {
  return getCurrentEntry(state).collapsed === true;
}

export function getStackDepth(state = kikxState) {
  return stackDepth(getNavigationStack(state));
}

export function getGridParentSessionID(state = kikxState) {
  return gridParentSessionID(getNavigationStack(state));
}

export function getScopeNoun(state = kikxState) {
  return scopeNounForDepth(getStackDepth(state));
}

export function setNavigationStack(stack, state = kikxState) {
  state.navigationStack = stack;
}

export function navigateThread(sessionID, state = kikxState) {
  state.navigationStack = pushThread(getNavigationStack(state), sessionID);
}

export function navigateBack(state = kikxState) {
  state.navigationStack = popStack(getNavigationStack(state));
}

// --- Inbox navigation (plan §6) -----------------------------------------
export function navigateInbox(state = kikxState) {
  state.navigationStack = pushInbox(getNavigationStack(state));
}

export function isInboxOpen(state = kikxState) {
  return isInboxView(getNavigationStack(state));
}

export function navigateView(view, state = kikxState) {
  state.navigationStack = pushView(getNavigationStack(state), view);
}

export function isViewOpen(view, state = kikxState) {
  return currentViewName(getNavigationStack(state)) === view;
}

export function getQuestionsState(state = kikxState) {
  return state.questionsState || createQuestionsState();
}

export function setQuestions(questions, state = kikxState) {
  state.questionsState = {
    ...getQuestionsState(state),
    questions: Array.isArray(questions) ? [ ...questions ] : [],
  };
}

export function setPreviewsLoading(loading, state = kikxState) {
  state.previewsLoading = loading === true;
}

export function setPreviewStatus(status, state = kikxState) {
  state.previewStatus = status || '';
}

export function getDeletedSessions(state = kikxState) {
  return state.deletedSessionIDs
    .map((sessionID) => state.deletedSessionDetailsByID[sessionID])
    .filter(Boolean);
}

// The single source the workspace grid renders from: live sessions always, plus
// the soft-deleted bucket while the eye is on, both narrowed by the title query.
export function getVisibleSessions(state = kikxState) {
  return visibleSessions({
    liveSessions: getSessions(state),
    deletedSessions: getDeletedSessions(state),
    showDeleted: state.showDeletedSessions === true,
    query: state.sessionSearch,
  });
}

export function isShowingDeletedSessions(state = kikxState) {
  return state.showDeletedSessions === true;
}

export function getSessionSearch(state = kikxState) {
  return state.sessionSearch || '';
}

export function setSessionSearch(query, state = kikxState) {
  state.sessionSearch = typeof query === 'string' ? query : '';
}

export function setShowDeletedSessions(show, state = kikxState) {
  state.showDeletedSessions = show === true;
}

export function setSessions(nextSessions, state = kikxState) {
  applySessionSnapshot(state, mergeSessions(state, nextSessions));
}

export function upsertSession(session, state = kikxState) {
  applySessionSnapshot(state, upsertSessionState(state, session));
}

export function removeSession(sessionID, state = kikxState) {
  applySessionSnapshot(state, removeSessionState(state, sessionID));
}

export function setDeletedSessions(sessions, state = kikxState) {
  applyDeletedSessionSnapshot(state, setDeletedSessionsState(state, sessions));
}

export function recordDeletedSession(session, state = kikxState) {
  applyDeletedSessionSnapshot(state, recordDeletedSessionState(state, session));
}

export function forgetDeletedSession(sessionID, state = kikxState) {
  applyDeletedSessionSnapshot(state, forgetDeletedSessionState(state, sessionID));
}

export function setSessionFrames(sessionID, frames, state = kikxState, paging = null) {
  applySessionSnapshot(state, setSessionFramesState(state, sessionID, frames, paging));
}

export function prependSessionFrames(sessionID, frames, state = kikxState) {
  applySessionSnapshot(state, prependSessionFramesState(state, sessionID, frames));
}

export function mergeSessionFrameWindow(sessionID, frames, state = kikxState, paging = null) {
  applySessionSnapshot(state, mergeSessionFrameWindowState(state, sessionID, frames, paging));
}

export function setSessionPaging(sessionID, patch, state = kikxState) {
  applySessionSnapshot(state, setSessionPagingState(state, sessionID, patch));
}

export function resetSessionPaging(sessionID, patch, state = kikxState) {
  applySessionSnapshot(state, resetSessionPagingState(state, sessionID, patch));
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
  state.sessionPagingByID = {};
  state.selectedSessionID = '';
  state.deletedSessionIDs = [];
  state.deletedSessionDetailsByID = {};
  state.sessionSearch = '';
  state.showDeletedSessions = false;
}

export function setAgentProviders(providers, state = kikxState) {
  state.agentProviders = Array.isArray(providers) ? providers.slice() : [];
}

export function setAgentTagDefinitions(definitions, state = kikxState) {
  state.agentTagDefinitions = Array.isArray(definitions) ? definitions.slice() : [];
  state.agentFormTags = {
    ...defaultTagValues(state.agentTagDefinitions),
    ...(state.agentFormTags || {}),
  };
}

export function setClientComponents(components, state = kikxState) {
  let list = Array.isArray(components) ? components : [];
  let frameComponents = {};
  let toolComponents = {};
  let agentConfigForms = {};
  let viewSurfaces = {};
  let sidebarItems = {};

  for (let component of list) {
    if (component?.kind === 'frame' && component.frameType)
      frameComponents[component.frameType] = component;
    else if (component?.kind === 'tool' && component.toolName)
      toolComponents[component.toolName] = component;
    else if (component?.kind === 'agent-config-form' && component.pluginID)
      agentConfigForms[component.pluginID] = component;
    else if (component?.kind === 'view' && component.surfaceID) {
      // Campaign P4: a plugin view has to reach the shell. Before this branch the
      // descriptor was dropped here, so the server advertised a surface the client
      // discarded and the work-area dispatch could only ever be a core ternary.
      //
      // A core surface id is reserved: a plugin must not take over the Inbox (or
      // Agents/Teams) by registering a colliding id, so it is refused rather than
      // stored, and it stays out of the addressable name set too.
      if (!isReservedViewSurfaceID(component.surfaceID))
        viewSurfaces[component.surfaceID] = component;
    }
    else if (component?.kind === 'sidebar-item' && component.surfaceID) {
      sidebarItems[component.surfaceID] = component;
    }
  }

  state.clientFrameComponentsByType = frameComponents;
  state.clientToolComponentsByName = toolComponents;
  state.clientAgentConfigFormsByPluginID = agentConfigForms;
  state.clientViewSurfaces = viewSurfaces;
  state.clientSidebarItems = sidebarItems;

  // The single writer for the addressable view vocabulary. Derived from the
  // descriptors just filed, so uninstalling a plugin shrinks the set again instead
  // of leaving the stack able to hold a view nothing can render.
  syncViewNames(viewNamesFromComponents(list));

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
  state.agentFormTags = defaultTagValues(state.agentTagDefinitions);
  state.agentFormErrors = {};
}

export function setAgentFormProvider(pluginID, state = kikxState) {
  let provider = state.agentProviders.find((candidate) => candidate.pluginID === pluginID) || null;
  state.agentFormPluginID = pluginID || '';
  state.agentFormConfig = defaultConfigForProvider(provider);
  state.agentFormSecrets = {};
  state.agentFormErrors = {};
}

export function setAgentFormFromAgent(agent, state = kikxState) {
  let provider = state.agentProviders.find((candidate) => candidate.pluginID === agent?.pluginID) || null;
  state.agentFormMode = 'edit';
  state.editingAgentID = agent.id;
  state.agentFormName = agent.name || '';
  state.agentFormPluginID = agent.pluginID || '';
  state.agentFormConfig = mergeAgentConfigWithProviderDefaults(provider, agent.config);
  state.agentFormSecrets = {};
  state.agentFormTags = tagValuesFromAgent(agent, state.agentTagDefinitions);
  state.agentFormErrors = {};
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

export { countMessageFrames, isDeletedSession };

function applyDeletedSessionSnapshot(state, snapshot) {
  state.deletedSessionIDs = snapshot.deletedSessionIDs;
  state.deletedSessionDetailsByID = snapshot.deletedSessionDetailsByID;
}

function applySessionSnapshot(state, snapshot) {
  state.sessionIDs = snapshot.sessionIDs;
  state.sessionDetailsByID = snapshot.sessionDetailsByID;
  let bounded = boundSessionFrameCaches(
    snapshot.framesBySessionID,
    snapshot.sessionPagingByID ?? state.sessionPagingByID,
    state.selectedSessionID,
  );
  state.framesBySessionID = bounded.framesBySessionID;
  state.sessionPagingByID = bounded.sessionPagingByID;
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
  let session = readStoredAuth(globalThis.sessionStorage, AUTH_STORAGE_KEY);
  let shared = readStoredAuth(globalThis.localStorage, AUTH_SHARED_STORAGE_KEY);
  // A sibling tab may have rotated the refresh token while this tab kept a
  // stale copy in sessionStorage. Prefer the newer shared session, but never
  // use localStorage to authenticate a tab that has no session at all.
  if (session.token && shared.token && authExpiry(shared) > authExpiry(session))
    return shared;

  return session;
}

function readStoredAuth(storage, key) {
  try {
    return JSON.parse(storage?.getItem(key) || '{}') || {};
  } catch (_error) {
    return {};
  }
}

function authExpiry(auth) {
  let value = Number(auth?.expires_at);
  return Number.isFinite(value) ? value : 0;
}
