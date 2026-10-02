'use strict';

import { getAgents, removeAgent, resetAgentForm, setAgentFormFromAgent, setAgentFormProvider, upsertAgent } from '../state/kikx-state.mjs';
import { masterRankByAgentID } from './master-agent-helpers.mjs';
import {
  compactionBotButtonAriaLabel,
  compactionBotButtonTitle,
  compactionBotRankByAgentID,
} from './compaction-bot-helpers.mjs';
import { buildAgentManagerBody, findAgentConfigSection } from './kikx-modals.mjs';
import { cssEscape } from './kikx-app-helpers.mjs';
import { nonEmptyValues } from './agent-form-helpers.mjs';
import { readAgentGutsValues, validateAgentGuts } from './agent-config-form-registry.mjs';

export function openAgentManager(app) {
  app._state.managingAgents = true;
  app._state.managingTeams = false;
  app._state.agentEditorOpen = false;
  app._state.teamEditorOpen = false;
  app._state.agentStatus = '';
  app._state.agentStatusKind = 'pending';
  resetAgentForm(app._state);
  app._render();
  app._loadAgents();
}

export function closeAgentManager(app) {
  app._state.managingAgents = false;
  app._render();
}

export function closeAgentEditor(app) {
  app._state.agentEditorOpen = false;
  app._state.managingAgents = true;
  app._render();
}

export function createAgent(app) {
  resetAgentForm(app._state);
  app._state.managingAgents = false;
  app._state.agentEditorOpen = true;
  app._render();
}

export function editAgent(app, agent) {
  app._state.managingAgents = false;
  app._state.agentEditorOpen = true;
  setAgentFormFromAgent(agent, app._state);
  app._state.agentStatus = '';
  app._render();
}

export function selectAgentProvider(app, pluginID) {
  setAgentFormProvider(pluginID, app._state);
  app._render();
}

export async function onAgentFormSubmit(app, event) {
  event.preventDefault();

  // Read the provider-specific guts element from the app root. The Create
  // button is wired via onClick, so event.currentTarget is the BUTTON, not the
  // form; querying from the app root always finds the live guts regardless of
  // which control triggered the submit.
  let provider = app._state.agentProviders.find((candidate) => candidate.pluginID === app._state.agentFormPluginID) || null;
  let guts = findAgentConfigSection(app, provider);

  // Client-side validation first: if the guts rejects the input, show its
  // errors in the modal and abort without a server round-trip.
  let validation = await validateAgentGuts(guts);
  if (!validation.valid) {
    app._state.agentFormErrors = validation.errors;
    app._state.agentStatus = '';
    app._state.agentStatusKind = 'error';
    app._render();
    return;
  }

  let values = readAgentGutsValues(guts);
  let config = values ? values.config : app._state.agentFormConfig;
  let secrets = values ? values.secrets : app._state.agentFormSecrets;

  let body = {
    name: app._state.agentFormName,
    pluginID: app._state.agentFormPluginID,
    config,
    secrets: nonEmptyValues(secrets),
  };

  app._state.agentFormErrors = {};
  app._state.agentStatus = app._state.agentFormMode === 'edit' ? 'Saving agent...' : 'Creating agent...';
  app._state.agentStatusKind = 'pending';

  try {
    let result = app._state.agentFormMode === 'edit'
      ? await app._patchJSON(`/api/v1/agents/${encodeURIComponent(app._state.editingAgentID)}`, body)
      : await app._postJSON('/api/v1/agents', body);

    upsertAgent(result.data.agent, app._state);
    let message = app._state.agentFormMode === 'edit' ? 'Agent saved' : 'Agent created';
    resetAgentForm(app._state);
    app._state.agentEditorOpen = false;
    app._state.managingAgents = true;
    app._state.agentStatus = message;
    app._state.agentStatusKind = 'ready';
    app._render();
  } catch (error) {
    app._state.agentStatus = error.message;
    app._state.agentStatusKind = 'error';
    app._render();
  }
}

export async function deleteAgent(app, agentID) {
  app._state.agentStatus = 'Deleting agent...';
  app._state.agentStatusKind = 'pending';

  try {
    let response = await fetch(`/api/v1/agents/${encodeURIComponent(agentID)}`, { method: 'DELETE' });
    if (!response.ok)
      throw new Error((await response.json())?.error?.message || `HTTP ${response.status}`);

    removeAgent(agentID, app._state);
    if (app._state.editingAgentID === agentID)
      resetAgentForm(app._state);
    app._state.agentEditorOpen = false;
    app._state.managingAgents = true;
    app._state.agentStatus = 'Agent deleted';
    app._state.agentStatusKind = 'ready';
    app._render();
  } catch (error) {
    app._state.agentStatus = error.message;
    app._state.agentStatusKind = 'error';
    app._render();
  }
}

export async function toggleAgentCrown(app, agent) {
  // Re-read the current agent from state: rows repaint in place (no modal
  // re-render), so a captured agent object can be stale after a prior toggle.
  let current = app._state.agentDetailsByID[agent.id] || agent;

  // Guard against concurrent toggles for the same agent: rapid clicks fire
  // overlapping crown/uncrown requests whose responses race, leaving the final
  // state unpredictable. Ignore a click while one is in flight for that agent.
  if (app._pendingCrownAgentIDs.has(current.id))
    return;

  let crowned = !current.crownedClock;
  app._pendingCrownAgentIDs.add(current.id);
  setAgentCrownBusy(app, current.id, true);
  app._state.agentStatus = crowned ? 'Crowning agent...' : 'Uncrowning agent...';
  app._state.agentStatusKind = 'pending';

  try {
    let result = await app._postJSON(
      `/api/v1/agents/${encodeURIComponent(current.id)}/${crowned ? 'crown' : 'uncrown'}`,
      {},
    );
    upsertAgent(result.data.agent, app._state);
    // Reconcile the WHOLE crown set from the authoritative server list:
    // crowning a 4th evicts the oldest, and the client cannot know which
    // agents were evicted from the single toggle response alone. Without this,
    // client and server diverge and subsequent toggles act on the wrong state.
    reconcileMasters(app, result.data.masters);
    app._state.agentStatus = crowned ? `Crowned ${current.name}` : `Uncrowned ${current.name}`;
    app._state.agentStatusKind = 'ready';
    // Repaint crown buttons in place: a full _render() rebuilds the modal
    // element, which reads as the modal closing and reopening on every click.
    repaintAgentCrowns(app);
    syncAgentStatusText(app);
  } catch (error) {
    app._state.agentStatus = error.message;
    app._state.agentStatusKind = 'error';
    syncAgentStatusText(app);
  } finally {
    app._pendingCrownAgentIDs.delete(current.id);
    setAgentCrownBusy(app, current.id, false);
  }
}

// Sync local agent crown state to the authoritative server master list:
// mark every listed master crowned and clear crownedClock on any agent not in
// the list (evicted). Keeps client and server identical after a crown toggle.
export function reconcileMasters(app, masters) {
  if (!Array.isArray(masters))
    return;

  let masterByID = new Map(masters.filter((agent) => agent?.id).map((agent) => [ agent.id, agent ]));

  for (let agentID of app._state.agentIDs || []) {
    let current = app._state.agentDetailsByID[agentID];
    if (!current)
      continue;

    let master = masterByID.get(agentID);
    let nextCrownedClock = master?.crownedClock || null;
    let nextCrownedAt = master?.crownedAt || null;
    if (current.crownedClock === nextCrownedClock && current.crownedAt === nextCrownedAt)
      continue;

    upsertAgent({ ...current, crownedClock: nextCrownedClock, crownedAt: nextCrownedAt }, app._state);
  }
}

// Disable a crown button while its request is in flight so a second click
// cannot start an overlapping toggle.
export function setAgentCrownBusy(app, agentID, busy) {
  for (let button of app.querySelectorAll(`.kikx-agent-list__crown[data-agent-id="${cssEscape(agentID)}"]`)) {
    button.disabled = busy;
    button.classList.toggle('is-busy', busy);
  }
}

// Update each agent row's crown rank styling and status line without a full
// re-render (keeps the modal stable while toggling crowns).
export function repaintAgentCrowns(app) {
  let ranks = masterRankByAgentID(getAgents(app._state));
  for (let button of app.querySelectorAll('.kikx-agent-list__crown[data-agent-id]')) {
    let rank = ranks.get(button.dataset.agentId) || 0;
    button.className = `kikx-agent-list__crown${rank ? ` is-master kikx-agent-list__crown--rank-${rank}` : ''}`;
    button.title = rank ? `Master agent #${rank} (click to uncrown)` : 'Crown as master agent';
    button.setAttribute('aria-label', rank ? `Master agent number ${rank}` : 'Crown as master agent');
    button.setAttribute('aria-pressed', rank ? 'true' : 'false');
  }
}

// Parallel to toggleAgentCrown, but for the independent compaction-bot list. The
// endpoints return the authoritative list, so reconciliation is identical.
export async function toggleAgentCompactionBot(app, agent) {
  let current = app._state.agentDetailsByID[agent.id] || agent;

  // Guard against concurrent toggles for the same agent (rapid clicks race).
  if (app._pendingCompactionBotAgentIDs.has(current.id))
    return;

  let crowned = !current.compactionCrownedClock;
  app._pendingCompactionBotAgentIDs.add(current.id);
  setAgentCompactionBotBusy(app, current.id, true);
  app._state.agentStatus = crowned ? 'Setting compaction bot...' : 'Clearing compaction bot...';
  app._state.agentStatusKind = 'pending';

  try {
    let result = await app._postJSON(
      `/api/v1/agents/${encodeURIComponent(current.id)}/${crowned ? 'compact-crown' : 'compact-uncrown'}`,
      {},
    );
    upsertAgent(result.data.agent, app._state);
    // Reconcile the WHOLE compaction-bot set from the authoritative server list:
    // designating a 4th evicts the oldest, which the client cannot derive from
    // the single toggle response alone.
    reconcileCompactionBots(app, result.data.compactionBots);
    app._state.agentStatus = crowned ? `Compaction bot set: ${current.name}` : `Compaction bot cleared: ${current.name}`;
    app._state.agentStatusKind = 'ready';
    repaintAgentCompactionBots(app);
    syncAgentStatusText(app);
  } catch (error) {
    app._state.agentStatus = error.message;
    app._state.agentStatusKind = 'error';
    syncAgentStatusText(app);
  } finally {
    app._pendingCompactionBotAgentIDs.delete(current.id);
    setAgentCompactionBotBusy(app, current.id, false);
  }
}

// Sync local compaction-bot state to the authoritative server list, exactly as
// reconcileMasters does for the crown but over the independent fields.
export function reconcileCompactionBots(app, compactionBots) {
  if (!Array.isArray(compactionBots))
    return;

  let botByID = new Map(compactionBots.filter((agent) => agent?.id).map((agent) => [ agent.id, agent ]));

  for (let agentID of app._state.agentIDs || []) {
    let current = app._state.agentDetailsByID[agentID];
    if (!current)
      continue;

    let bot = botByID.get(agentID);
    let nextClock = bot?.compactionCrownedClock || null;
    let nextAt = bot?.compactionCrownedAt || null;
    if (current.compactionCrownedClock === nextClock && current.compactionCrownedAt === nextAt)
      continue;

    upsertAgent({ ...current, compactionCrownedClock: nextClock, compactionCrownedAt: nextAt }, app._state);
  }
}

// Disable a compaction-bot button while its request is in flight.
export function setAgentCompactionBotBusy(app, agentID, busy) {
  for (let button of app.querySelectorAll(`.kikx-agent-list__compaction-bot[data-agent-id="${cssEscape(agentID)}"]`)) {
    button.disabled = busy;
    button.classList.toggle('is-busy', busy);
  }
}

// Repaint each row's compaction-bot rank styling without a full re-render.
export function repaintAgentCompactionBots(app) {
  let ranks = compactionBotRankByAgentID(getAgents(app._state));
  for (let button of app.querySelectorAll('.kikx-agent-list__compaction-bot[data-agent-id]')) {
    let rank = ranks.get(button.dataset.agentId) || 0;
    button.className = `kikx-agent-list__compaction-bot${rank ? ` is-compaction-bot kikx-agent-list__compaction-bot--rank-${rank}` : ''}`;
    button.title = compactionBotButtonTitle(rank);
    button.setAttribute('aria-label', compactionBotButtonAriaLabel(rank));
    button.setAttribute('aria-pressed', rank ? 'true' : 'false');
  }
}

export function syncAgentStatusText(app) {
  let status = app.querySelector('.kikx-agent-manager .kikx-auth-status');
  if (!status)
    return;

  status.className = `kikx-auth-status kikx-auth-status--${app._state.agentStatusKind}`;
  let text = status.querySelector('span');
  if (text)
    text.textContent = app._state.agentStatus;
}

export function setAgentFilter(app, filter) {
  app._state.agentFilter = filter || 'all';
  // Swap only the modal body so the modal element (and its open animation
  // state) survives; a full _render() would rebuild it and flicker.
  if (!repaintAgentManagerBody(app))
    app._render();
}

export function repaintAgentManagerBody(app) {
  let manager = app.querySelector('.kikx-agent-manager');
  if (!manager)
    return false;

  let definition = buildAgentManagerBody(app);
  let nodes = [ definition ].flat(Infinity).map((item) => item.build(document));
  manager.replaceChildren(...nodes);
  return true;
}
