'use strict';

import {
  AUTH_STORAGE_KEY,
  getAgents,
  getGridParentSessionID,
  removeTeam,
  resetAccountState,
  resetSessionState,
  resetTeamForm,
  setAccount,
  setAccountFormFromAccount,
  setTeamFormFromTeam,
  setTeams,
  setTokenUsage,
  upsertSession,
  upsertTeam,
} from '../state/kikx-state.mjs';
import { coerceAgentFieldValue } from './agent-form-helpers.mjs';

export function syncAuthEmail(app, event) {
  app._state.authEmail = event.target.value;
}

export function syncAccountName(app, event) {
  app._state.accountFormName = event.target.value;
}

export function syncAccountEmail(app, event) {
  app._state.accountFormEmail = event.target.value;
}

export function syncEditingSessionTitle(app, event) {
  app._state.editingSessionTitle = event.target.value;
}

export async function openAccountEditor(app) {
  app._state.accountEditorOpen = true;
  app._state.accountStatus = '';
  app._state.accountStatusKind = 'pending';
  setAccountFormFromAccount(app._state.account, app._state);
  app._render();
  await app._loadAccount({ syncForm: true, render: false });
}

export function closeAccountEditor(app) {
  app._state.accountEditorOpen = false;
  app._render();
}

export async function onAccountSubmit(app, event) {
  event.preventDefault();

  let name = app._state.accountFormName.trim();
  let email = app._state.accountFormEmail.trim();
  if (!name) {
    app._state.accountStatus = 'Name is required';
    app._state.accountStatusKind = 'error';
    app._render();
    return;
  }

  app._state.accountStatus = 'Saving account...';
  app._state.accountStatusKind = 'pending';
  app._requestRender();

  try {
    let result = await app._patchJSON('/api/v1/account', { name, email });
    setAccount(result.data?.account || null, app._state);
    setAccountFormFromAccount(app._state.account, app._state);
    app._state.accountEditorOpen = false;
    app._state.accountStatus = 'Account saved';
    app._state.accountStatusKind = 'ready';
    app._render();
  } catch (error) {
    app._state.accountStatus = error.message;
    app._state.accountStatusKind = 'error';
    app._render();
  }
}

export function openTeamManager(app) {
  app._state.managingTeams = true;
  app._state.managingAgents = false;
  app._state.teamEditorOpen = false;
  app._state.agentEditorOpen = false;
  app._state.teamStatus = '';
  app._state.teamStatusKind = 'pending';
  resetTeamForm(app._state);
  app._render();
  app._loadTeams();
}

export function closeTeamManager(app) {
  app._state.managingTeams = false;
  app._render();
}

export function closeTeamEditor(app) {
  app._state.teamEditorOpen = false;
  app._state.managingTeams = true;
  app._render();
}

export function createTeam(app) {
  resetTeamForm(app._state);
  app._state.managingTeams = false;
  app._state.teamEditorOpen = true;
  app._render();
}

export function editTeam(app, team) {
  app._state.managingTeams = false;
  app._state.teamEditorOpen = true;
  setTeamFormFromTeam(team, app._state);
  app._state.teamStatus = '';
  app._render();
}

export async function onTeamFormSubmit(app, event) {
  event.preventDefault();

  let body = {
    name: app._state.teamFormName,
    members: teamMembersFromForm(app),
  };

  app._state.teamStatus = app._state.teamFormMode === 'edit' ? 'Saving team...' : 'Creating team...';
  app._state.teamStatusKind = 'pending';

  try {
    let result = app._state.teamFormMode === 'edit'
      ? await app._patchJSON(`/api/v1/teams/${encodeURIComponent(app._state.editingTeamID)}`, body)
      : await app._postJSON('/api/v1/teams', body);

    upsertTeam(result.data.team, app._state);
    let message = app._state.teamFormMode === 'edit' ? 'Team saved' : 'Team created';
    resetTeamForm(app._state);
    app._state.teamEditorOpen = false;
    app._state.managingTeams = true;
    app._state.teamStatus = message;
    app._state.teamStatusKind = 'ready';
    app._render();
  } catch (error) {
    app._state.teamStatus = error.message;
    app._state.teamStatusKind = 'error';
    app._render();
  }
}

export async function deleteTeam(app, teamID) {
  app._state.teamStatus = 'Deleting team...';
  app._state.teamStatusKind = 'pending';

  try {
    await app._deleteJSON(`/api/v1/teams/${encodeURIComponent(teamID)}`);
    removeTeam(teamID, app._state);
    if (app._state.editingTeamID === teamID)
      resetTeamForm(app._state);
    app._state.teamEditorOpen = false;
    app._state.managingTeams = true;
    app._state.teamStatus = 'Team deleted';
    app._state.teamStatusKind = 'ready';
    app._render();
  } catch (error) {
    app._state.teamStatus = error.message;
    app._state.teamStatusKind = 'error';
    app._render();
  }
}

export function availableTeamActors(app) {
  let actors = getAgents(app._state).map((agent) => ({
    type: 'agent',
    actorID: agent.id,
    name: agent.name || agent.id,
  }));
  let account = app._state.account;
  if (account?.id) {
    actors.push({
      type: 'user',
      actorID: account.id,
      name: account.name || account.username || account.email || account.id,
      username: account.username || '',
      email: account.email || '',
    });
  }

  return actors;
}

export function teamMemberKey(actor) {
  return `${actor.type}:${actor.actorID}`;
}

export function teamMemberChecked(app, actor) {
  return app._state.teamFormMemberKeys[teamMemberKey(actor)] === true;
}

export function toggleTeamMember(app, actor, checked) {
  let key = teamMemberKey(actor);
  let next = { ...app._state.teamFormMemberKeys };
  if (checked)
    next[key] = true;
  else
    delete next[key];

  app._state.teamFormMemberKeys = next;
}

export function teamMembersFromForm(app) {
  let selected = app._state.teamFormMemberKeys || {};
  return availableTeamActors(app).filter((actor) => selected[teamMemberKey(actor)]).map((actor) => ({ ...actor }));
}

export function syncAgentField(app, field, value) {
  if (field.secret) {
    app._state.agentFormSecrets = {
      ...app._state.agentFormSecrets,
      [field.name]: value,
    };
    return;
  }

  app._state.agentFormConfig = {
    ...app._state.agentFormConfig,
    [field.name]: coerceAgentFieldValue(field, value),
  };
}

export async function createSession(app) {
  app._state.status = 'Creating session...';
  app._state.statusKind = 'pending';

  try {
    // Create as a child of the session whose grid we are viewing (null at root).
    let parentSessionID = getGridParentSessionID(app._state);
    let result = await app._postJSON('/api/v1/sessions', {
      ...(parentSessionID ? { parentSessionID } : {}),
    });
    upsertSession(result.data.session, app._state);
    await app._loadSessions();
    // Enter the newly created session.
    await app._openSessionFromCard(result.data.session.id);
    app._state.status = 'Session created';
    app._state.statusKind = 'ready';
    app._render();
  } catch (error) {
    app._state.status = error.message;
    app._state.statusKind = 'error';
    app._render();
  }
}

export function openSessionEditor(app, event, session) {
  event.stopPropagation();
  app._state.editingSessionID = session.id;
  app._state.editingSessionTitle = session.title || '';
  app._render();
}

export function closeSessionEditor(app) {
  app._state.editingSessionID = '';
  app._state.editingSessionTitle = '';
  app._render();
}

export async function onSessionEditSubmit(app, event) {
  event.preventDefault();

  let title = app._state.editingSessionTitle.trim();
  if (!title) {
    app._state.status = 'Session name is required';
    app._state.statusKind = 'error';
    return;
  }

  let sessionID = app._state.editingSessionID;
  app._state.status = 'Saving session...';
  app._state.statusKind = 'pending';

  try {
    let result = await app._patchJSON(`/api/v1/sessions/${encodeURIComponent(sessionID)}`, { title });
    upsertSession(result.data.session, app._state);
    app._state.editingSessionID = '';
    app._state.editingSessionTitle = '';
    app._state.status = 'Session saved';
    app._state.statusKind = 'ready';
    app._render();
  } catch (error) {
    app._state.status = error.message;
    app._state.statusKind = 'error';
    app._render();
  }
}

export async function selectSession(app, sessionID) {
  app._state.selectedSessionID = sessionID;
  app._state.status = 'Loading session...';
  app._state.statusKind = 'pending';
  app._forceScrollToBottomAfterRender = true;

  try {
    await app._loadFrames(sessionID);
    app._state.status = 'Session loaded';
    app._state.statusKind = 'ready';
    app._render();
  } catch (error) {
    app._state.status = error.message;
    app._state.statusKind = 'error';
    app._render();
  }
}

export function signOut(app) {
  app._disconnectRuntimeEvents();
  sessionStorage.removeItem(AUTH_STORAGE_KEY);
  app._state.authToken = '';
  app._state.refreshToken = '';
  resetAccountState(app._state);
  resetSessionState(app._state);
  setTeams([], app._state);
  resetTeamForm(app._state);
  app._state.managingTeams = false;
  app._state.teamEditorOpen = false;
  setTokenUsage({}, 0, app._state);
  app._state.connectionStatus = 'Disconnected';
  app._state.connectionStatusKind = 'error';
  app._state.status = 'Signed out';
  app._state.statusKind = 'pending';
  app._render();
}

export function applyAuth(app, auth) {
  if (!auth?.token)
    throw new Error('AeorDB did not return an auth token');

  app._state.authToken = auth.token;
  app._state.refreshToken = auth.refresh_token || '';
  app._state.status = 'Signed in';
  app._state.statusKind = 'ready';
  sessionStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(auth));
  app._render();
  app._connectRuntimeEvents();
  app._loadClientComponents();
  app._loadAccount();
  app._loadAgents();
  app._loadSessions();
  app._loadTokenUsage();
}
