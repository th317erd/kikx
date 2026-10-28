'use strict';

// Agents and Teams are sidebar views, not dialogs. The views reuse the manager
// bodies (filters, rows, actions, status) and render the create/edit form inline
// when the editor is open.
//
// Scope is the session on top of the stack: an agent/team assigned to this
// session or any ancestor is visible here. At the workspace root there is no
// session scope, so the global catalogue is shown.

import { elements } from '../lib/aeor-ui.mjs';
import {
  getAgents,
  getScopeSessionID,
  getEffectiveSessionAgentIDs,
  getEffectiveSessionTeamIDs,
  getTeams,
} from '../state/kikx-state.mjs';
import {
  buildAgentEditorForm,
  buildAgentManagerBody,
  buildAgentManagerFooter,
  buildTeamEditorForm,
  buildTeamManagerBody,
} from './kikx-modals.mjs';
import { buildViewBackButton } from './kikx-view-chrome.mjs';

const { button, div, h2, h3, header, p, section, span } = elements;

function scopedAgents(app) {
  let sessionID = getScopeSessionID(app._state);
  if (!sessionID)
    return getAgents(app._state);
  let ids = new Set(getEffectiveSessionAgentIDs(app._state, sessionID));
  return getAgents(app._state).filter((agent) => ids.has(agent.id));
}

function scopedTeams(app) {
  let sessionID = getScopeSessionID(app._state);
  if (!sessionID)
    return getTeams(app._state);
  let ids = new Set(getEffectiveSessionTeamIDs(app._state, sessionID));
  return getTeams(app._state).filter((team) => ids.has(team.id));
}

function scopeDetail(app) {
  let sessionID = getScopeSessionID(app._state);
  if (!sessionID)
    return 'Workspace catalogue';
  let title = app._state.sessionDetailsByID?.[sessionID]?.title || 'this session';
  return `In ${title} and inherited from parent sessions`;
}

function viewHeader(app, title, count, detail) {
  return header.class('kikx-view-header')(
    buildViewBackButton(app),
    h2.class('kikx-view-header__title')(title),
    span.class('kikx-view-header__count')(String(count)),
    p.class('kikx-view-header__scope')(detail),
  );
}

function availableItems(app, items, assigned, onPick, emptyLabel) {
  let assignedIDs = new Set(assigned.map((item) => item.id));
  let available = items.filter((item) => !assignedIDs.has(item.id));
  if (available.length === 0)
    return null;

  return div.class('kikx-view-available')(
    h3.class('kikx-view-available__title')(emptyLabel),
    div.class('kikx-view-available__list')(
      available.map((item) => button
        .type('button')
        .class('kikx-view-available__item')
        .onClick(() => onPick(item))(item.name || item.id)),
    ),
  );
}

export function buildAgentsView(app) {
  let agents = scopedAgents(app);
  return section.class('kikx-view kikx-agent-view').context(app)(
    viewHeader(app, 'Agents', agents.length, scopeDetail(app)),
    div.class('kikx-agent-manager')(buildAgentManagerBody(app, agents)),
    buildAgentManagerFooter(app),
    availableItems(app, getAgents(app._state), agents, (agent) => app._assignAgentToSession?.(agent), 'Add an existing agent to this session'),
    app._state.agentEditorOpen
      ? div.class('kikx-view-editor')(
        h2.class('kikx-view-editor__title')(app._state.agentFormMode === 'edit' ? 'Edit agent' : 'Create agent'),
        buildAgentEditorForm(app),
      )
      : null,
  ).build(document);
}

export function buildTeamsView(app) {
  let teams = scopedTeams(app);
  return section.class('kikx-view kikx-team-view').context(app)(
    viewHeader(app, 'Teams', teams.length, scopeDetail(app)),
    buildTeamManagerBody(app, teams),
    availableItems(app, getTeams(app._state), teams, (team) => app._assignTeamToSession?.(team), 'Add an existing team to this session'),
    app._state.teamEditorOpen
      ? div.class('kikx-view-editor')(
        h2.class('kikx-view-editor__title')(app._state.teamFormMode === 'edit' ? 'Edit team' : 'Create team'),
        buildTeamEditorForm(app),
      )
      : null,
  ).build(document);
}
