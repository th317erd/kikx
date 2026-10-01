'use strict';

import { elements } from '../lib/aeor-ui.mjs';
import {
  getAgents,
  getSelectedAgentProvider,
  getTeams,
} from '../state/kikx-state.mjs';
import { agentFilterPills, filterAgents } from './agent-list-model.mjs';
import { masterRankByAgentID } from './master-agent-helpers.mjs';
import { findAgentConfigFormElement, resolveAgentConfigFormTag } from './agent-config-form-registry.mjs';
import './kikx-default-agent-config-form.mjs';

const { div, p, span, button, form, label, ul, li, strong, option } = elements;
const aeorInput = elements['aeor-input'];
const aeorModal = elements['aeor-modal'];
const aeorSelect = elements['aeor-select'];
const aeorCheckbox = elements['aeor-checkbox'];

export function buildAccountEditor(app) {
  return aeorModal.title('Account').onClose(app._closeAccountEditor)(
    form.class('kikx-account-form').onSubmit(app._onAccountSubmit)(
      label('Name'),
      aeorInput
        .type('text')
        .name('name')
        .placeholder('Display name')
        .value.bindState((state) => state.accountFormName, ['accountFormName'])
        .onInput(app._syncAccountName)(),
      label('Email'),
      aeorInput
        .type('email')
        .name('email')
        .placeholder('you@example.com')
        .value.bindState((state) => state.accountFormEmail, ['accountFormEmail'])
        .onInput(app._syncAccountEmail)(),
      div.class('modal-footer-actions')(
        button.type('button').class('kikx-sign-out-button').onClick(app._closeAccountEditor)('Cancel'),
        // type=button + onClick: the modal lifts .modal-footer-actions out of
        // the form, so a type=submit here would have no associated form to
        // submit. Every Kikx modal footer uses this pattern.
        button.type('button').class('kikx-send-button').onClick(app._onAccountSubmit)('Save'),
      ),
      p.class.bindState((state) => `kikx-auth-status kikx-auth-status--${state.accountStatusKind}`, ['accountStatusKind'])(
        span.textContent.bindState((state) => state.accountStatus, ['accountStatus'])(),
      ),
    ),
  );
}

export function buildAgentManager(app) {
  return aeorModal.title('Agents').onClose(app._closeAgentManager)(
    div.class('kikx-agent-manager')(
      buildAgentManagerBody(app),
    ),
  );
}

// The filter pills + agent list + status. Built separately so filter changes
// can swap just this content without rebuilding the modal element (which
// replays the modal's open animation and looks like a close/reopen).
export function buildAgentManagerBody(app) {
  let allAgents = getAgents(app._state);
  let filter = app._state.agentFilter || 'all';
  let pills = agentFilterPills(allAgents, app._state.agentProviders);

  // If the active filter no longer matches any pill (provider removed), fall
  // back to All so the list is never mysteriously empty.
  if (!pills.some((pill) => pill.id === filter))
    filter = 'all';

  let agents = filterAgents(allAgents, filter);
  let masterRankByID = masterRankByAgentID(allAgents);

  return [
    div.class('kikx-agent-filters')(
      pills.map((pill) => button
        .type('button')
        .class(`kikx-agent-filter${pill.id === filter ? ' is-active' : ''}`)
        .ariaPressed(pill.id === filter ? 'true' : 'false')
        .onClick(() => app._setAgentFilter(pill.id))(pill.label)),
    ),
    allAgents.length === 0
      ? p.class('kikx-muted')('No agents.')
      : agents.length === 0
        ? p.class('kikx-muted')('No agents match this filter.')
        : ul.class('kikx-agent-list')(
        agents.map((agent) => {
          let rank = masterRankByID.get(agent.id) || 0;
          return li
            .class('kikx-agent-list__item')
            .dataAgentId(agent.id)(
              div.class('kikx-agent-list__details')(
                strong(agent.name),
                span(agentProviderLabel(app, agent)),
              ),
              div.class('kikx-agent-list__row-actions')(
                button
                  .type('button')
                  .class(`kikx-agent-list__crown${rank ? ` is-master kikx-agent-list__crown--rank-${rank}` : ''}`)
                  .dataAgentId(agent.id)
                  .title(rank ? `Master agent #${rank} (click to uncrown)` : 'Crown as master agent')
                  .ariaLabel(rank ? `Master agent number ${rank}` : 'Crown as master agent')
                  .ariaPressed(rank ? 'true' : 'false')
                  .onClick(() => app._toggleAgentCrown(agent))('♛'),
                button
                  .type('button')
                  .class('kikx-agent-list__edit')
                  .dataAgentId(agent.id)
                  .title('Edit agent')
                  .ariaLabel('Edit agent')
                  .onClick(() => app._editAgent(agent))('⚙'),
              ),
            );
        }),
      ),
    div.class('modal-footer-actions')(
      button.type('button').class('kikx-send-button').onClick(app._createAgent)('+ Add Agent'),
    ),
    p.class(`kikx-auth-status kikx-auth-status--${app._state.agentStatusKind}`)(
      span(app._state.agentStatus),
    ),
  ];
}

// Agent create/edit "wrapper" dialog. It owns the modal chrome, the agent Name
// field, the Provider selectbox, the footer actions and the submit call. The
// provider-specific config UI (the "guts") is a separate custom element hosted
// in the config section, resolved per provider by agent-config-form-registry.
export function buildAgentEditor(app) {
  let providers = app._state.agentProviders;
  let provider = getSelectedAgentProvider(app._state);

  return aeorModal
    .title(app._state.agentFormMode === 'edit' ? 'Edit agent' : 'Create agent')
    .onClose(app._closeAgentEditor)(
      form.class('kikx-agent-form').onSubmit(app._onAgentFormSubmit)(
        providers.length === 0
          ? p.class('kikx-muted')('No agent provider plugins are registered.')
          : [
            label('Name'),
            aeorInput
              .type('text')
              .name('name')
              .value.bindState((state) => state.agentFormName, ['agentFormName'])
              .onInput((event) => { app._state.agentFormName = event.target.value; })(),
            label('Provider'),
            aeorSelect
              .name('pluginID')
              .placeholder('Select provider')
              .value(app._state.agentFormPluginID)
              .disabled(app._state.agentFormMode === 'edit')
              .onChange((event) => app._selectAgentProvider(event.target.value))(
                providers.map((candidate) => option
                  .value(candidate.pluginID)
                  .selected(candidate.pluginID === app._state.agentFormPluginID)(
                    candidate.displayName || candidate.pluginID,
                  )),
              ),
            ...buildAgentConfigSection(app, provider),
            div.class('modal-footer-actions')(
              ...(app._state.agentFormMode === 'edit'
                ? [ buildAgentDeleteButton(app) ]
                : []),
              button.type('button').class('kikx-sign-out-button').onClick(app._closeAgentEditor)('Cancel'),
              button.type('button').class('kikx-send-button').onClick(app._onAgentFormSubmit)(app._state.agentFormMode === 'edit' ? 'Save' : 'Create'),
            ),
          ],
        buildAgentFormStatus(app),
      ),
    );
}

export function buildTeamManager(app) {
  let teams = getTeams(app._state);

  return aeorModal.title('Teams').onClose(app._closeTeamManager)(
    div.class('kikx-agent-manager kikx-team-manager')(
      teams.length === 0
        ? p.class('kikx-muted')('No teams.')
        : ul.class('kikx-agent-list kikx-team-list')(
          teams.map((team) => li(
            div.class('kikx-agent-list__details')(
              strong(team.name),
              span(teamMemberSummary(team)),
            ),
            button
              .type('button')
              .class('kikx-agent-list__edit kikx-team-list__edit')
              .title('Edit team')
              .ariaLabel('Edit team')
              .onClick(() => app._editTeam(team))('⚙'),
          )),
        ),
      div.class('modal-footer-actions')(
        button.type('button').class('kikx-send-button').onClick(app._createTeam)('+ Add Team'),
      ),
      p.class.bindState((state) => `kikx-auth-status kikx-auth-status--${state.teamStatusKind}`, ['teamStatusKind'])(
        span.textContent.bindState((state) => state.teamStatus, ['teamStatus'])(),
      ),
    ),
  );
}

export function buildTeamEditor(app) {
  let actors = app._availableTeamActors();

  return aeorModal
    .title(app._state.teamFormMode === 'edit' ? 'Edit team' : 'Create team')
    .onClose(app._closeTeamEditor)(
      form.class('kikx-agent-form kikx-team-form').onSubmit(app._onTeamFormSubmit)(
        label('Name'),
        aeorInput
          .type('text')
          .name('name')
          .value.bindState((state) => state.teamFormName, ['teamFormName'])
          .onInput((event) => { app._state.teamFormName = event.target.value; })(),
        label('Members'),
        actors.length === 0
          ? p.class('kikx-muted')('No actors are available.')
          : div.class('kikx-team-member-list')(
            actors.map((actor) => aeorCheckbox
              .class('kikx-team-member-option')
              .name('team-member')
              .value(app._teamMemberKey(actor))
              .checked(app._teamMemberChecked(actor))
              .onChange((event) => app._toggleTeamMember(actor, event.currentTarget.checked))(
                span.class('kikx-team-member-option__name')(actor.name),
                span.class('kikx-team-member-option__type')(actor.type),
              )),
          ),
        div.class('modal-footer-actions')(
          ...(app._state.teamFormMode === 'edit'
            ? [ button.type('button').class('kikx-sign-out-button').onClick(() => app._deleteTeam(app._state.editingTeamID))('Delete') ]
            : []),
          button.type('button').class('kikx-sign-out-button').onClick(app._closeTeamEditor)('Cancel'),
          button.type('button').class('kikx-send-button').onClick(app._onTeamFormSubmit)(app._state.teamFormMode === 'edit' ? 'Save' : 'Create'),
        ),
        p.class.bindState((state) => `kikx-auth-status kikx-auth-status--${state.teamStatusKind}`, ['teamStatusKind'])(
          span.textContent.bindState((state) => state.teamStatus, ['teamStatus'])(),
        ),
      ),
    );
}

// Build the guts element for the selected provider and seed it from app state.
// A re-render rebuilds the whole shell, so setContext() must reseed the guts
// from agentFormConfig/agentFormSecrets; onValuesChanged mirrors live edits
// back into that state so they survive the rebuild.
export function buildAgentConfigSection(app, provider) {
  if (!provider)
    return [];

  let gutsTag = resolveAgentConfigFormTag(app._state, provider);
  let element = document.createElement(gutsTag);
  if (typeof element.setContext === 'function') {
    let agent = app._state.agentDetailsByID?.[app._state.editingAgentID];
    element.setContext({
      mode: app._state.agentFormMode,
      pluginID: provider.pluginID || app._state.agentFormPluginID,
      provider,
      config: { ...(app._state.agentFormConfig || {}) },
      secrets: { ...(app._state.agentFormSecrets || {}) },
      secretState: agent?.secretState || {},
      agent: agent || null,
      onValuesChanged: (values) => app._applyAgentConfigValues(values),
    });
  }

  return [ element ];
}

// Locate the live guts element under the wrapper/app root. Query from the app
// root (not from an event target) so it works regardless of which control
// triggered the submit.
export function findAgentConfigSection(app, provider = undefined) {
  let selected = provider === undefined ? getSelectedAgentProvider(app._state) : provider;
  let gutsTag = resolveAgentConfigFormTag(app._state || {}, selected);
  return findAgentConfigFormElement(app, gutsTag);
}

// The modal status line plus any client-side validation errors returned by the
// guts element. Errors are plain (non-bound) nodes: setting agentFormErrors is
// followed by a re-render, so they repaint from the snapshot.
export function buildAgentFormStatus(app) {
  let errors = app._state.agentFormErrors || {};
  let messages = agentFormErrorMessages(errors);

  return div.class('kikx-agent-form__status')(
    p.class.bindState(
      (state) => `kikx-auth-status kikx-auth-status--${hasAgentFormErrors(state.agentFormErrors) ? 'error' : state.agentStatusKind}`,
      ['agentStatusKind', 'agentFormErrors'],
    )(
      span.textContent.bindState((state) => state.agentStatus, ['agentStatus'])(),
    ),
    ...messages.map((message) => p.class('kikx-agent-form__error')(message)),
  );
}

export function hasAgentFormErrors(errors) {
  return agentFormErrorMessages(errors).length > 0;
}

export function agentFormErrorMessages(errors) {
  if (!errors || typeof errors !== 'object')
    return [];

  let messages = [];
  for (let message of Object.values(errors)) {
    if (typeof message === 'string' && message.trim() !== '')
      messages.push(message.trim());
  }

  return messages;
}

export function teamMemberSummary(team) {
  let members = Array.isArray(team.members) ? team.members : [];
  let agentCount = members.filter((member) => member.type === 'agent').length;
  let userCount = members.filter((member) => member.type === 'user').length;
  let parts = [];
  if (agentCount)
    parts.push(`${agentCount} ${agentCount === 1 ? 'agent' : 'agents'}`);
  if (userCount)
    parts.push(`${userCount} ${userCount === 1 ? 'user' : 'users'}`);

  return parts.join(', ') || 'No members';
}

export function buildSessionEditor(app) {
  return aeorModal.title('Edit session').onClose(app._closeSessionEditor)(
    form.class('kikx-session-editor').onSubmit(app._onSessionEditSubmit)(
      label('Name'),
      aeorInput
        .type('text')
        .name('title')
        .placeholder('Session name')
        .value.bindState((state) => state.editingSessionTitle, ['editingSessionTitle'])
        .onInput(app._syncEditingSessionTitle)(),
      div.class('modal-footer-actions').slot('footer')(
        button.type('button').class('kikx-sign-out-button').onClick(app._closeSessionEditor)('Cancel'),
        button.type('button').class('kikx-send-button').onClick(app._onSessionEditSubmit)('Save'),
      ),
    ),
  );
}

// Hold-to-confirm delete: a red aeor-confirm-button (1s hold fills a progress
// bar) so a destructive delete cannot fire on a single stray click.
export function buildAgentDeleteButton(app) {
  let confirmButton = document.createElement('aeor-confirm-button');
  confirmButton.setAttribute('label', 'Delete');
  confirmButton.setAttribute('duration', '1000');
  confirmButton.classList.add('confirm-button-danger');
  confirmButton.addEventListener('confirm', () => {
    app._deleteAgent(app._state.editingAgentID);
  });
  return confirmButton;
}

export function agentProviderLabel(app, agent) {
  let provider = app._state.agentProviders.find((candidate) => candidate.pluginID === agent.pluginID);
  let label = provider?.displayName || agent.pluginID;
  return `${label}${agent.enabled === false ? ' disabled' : ''}`;
}
