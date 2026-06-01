'use strict';

import { elements, $ } from '../lib/aeor-ui.mjs';
import {
  AUTH_STORAGE_KEY,
  getAgents,
  getSelectedFrames,
  getSelectedAgentProvider,
  getSelectedSession,
  getSessions,
  kikxState,
  removeAgent,
  resetAgentForm,
  resetSessionState,
  setAgentProviders,
  setAgents,
  setSessionFrames,
  setSessions,
  upsertAgent,
  upsertSession,
} from '../state/kikx-state.mjs';
import { shouldSubmitComposerKey } from './composer-keyboard.mjs';

const { div, header, main, section, h1, h2, h3, p, span, button, form, label, textarea, ul, li, strong, input, select, option } = elements;
const aeorInput = elements['aeor-input'];
const aeorModal = elements['aeor-modal'];

export class KikxApp extends HTMLElement {
  constructor() {
    super();

    this._state = kikxState;

    this._onMagicLinkSubmit = this._onMagicLinkSubmit.bind(this);
    this._onSubmit = this._onSubmit.bind(this);
    this._onComposerKeydown = this._onComposerKeydown.bind(this);
    this._openAgentManager = this._openAgentManager.bind(this);
    this._closeAgentManager = this._closeAgentManager.bind(this);
    this._createAgent = this._createAgent.bind(this);
    this._onAgentFormSubmit = this._onAgentFormSubmit.bind(this);
    this._createSession = this._createSession.bind(this);
    this._closeSessionEditor = this._closeSessionEditor.bind(this);
    this._onSessionEditSubmit = this._onSessionEditSubmit.bind(this);
    this._signOut = this._signOut.bind(this);
  }

  connectedCallback() {
    if (this._mounted)
      return;

    this._mounted = true;
    this._render();
    if (this._state.authToken) {
      this._loadAeorDBEventsURL();
      this._loadSessions();
    } else if (this._state.magicCode) {
      this._verifyMagicLink(this._state.magicCode);
    }
  }

  _render() {
    $(this).empty();

    let shellChildren = [
      header.class('kikx-topbar')(
        div.class('kikx-brand')(
          span.class('kikx-brand__mark')('K'),
          div.class('kikx-brand__copy')(
            h1('Kikx'),
            p('Agent runner'),
          ),
        ),
        this._state.authToken
          ? div.class('kikx-topbar__actions')(
            button.type('button').class('kikx-sign-out-button').onClick(this._openAgentManager)('Agents'),
            button.type('button').class('kikx-sign-out-button').onClick(this._signOut)('Sign out'),
          )
          : span.class('kikx-topbar__spacer')(),
      ),
      this._state.authToken ? this._buildRunnerShell() : this._buildAuthShell(),
    ];

    if (this._state.authToken)
      shellChildren.push(this._buildStatusBar());

    if (this._state.editingSessionID)
      shellChildren.push(this._buildSessionEditor());

    if (this._state.managingAgents)
      shellChildren.push(this._buildAgentManager());

    let tree = div.class('kikx-shell').context(this)(shellChildren).build(document);

    this.appendChild(tree);
  }

  _buildAuthShell() {
    return main.class('kikx-auth-main')(
      section.class('kikx-auth-panel')(
        h2('Sign in'),
        p('Enter your email and AeorDB will send a sign-in link.'),
        div.class.bindState((state) => `kikx-auth-status kikx-auth-status--${state.authStatusKind}`, ['authStatusKind'])(
          span.textContent.bindState((state) => state.authStatus, ['authStatus'])(),
        ),
        form.class('kikx-auth-form').onSubmit(this._onMagicLinkSubmit)(
          label('Email'),
          aeorInput
            .type('email')
            .name('email')
            .placeholder('you@example.com')
            .value.bindState((state) => state.authEmail, ['authEmail'])
            .onInput(this._syncAuthEmail)(),
          button.type('submit').class('kikx-send-button')('Send link'),
        ),
      ),
    );
  }

  _buildRunnerShell() {
    let hasSelectedSession = Boolean(this._state.selectedSessionID);

    return [
      main.class('kikx-main')(
        section.class('kikx-sessions')(
          div.class('kikx-sessions__header')(
            h2('Sessions'),
            button.type('button').class('kikx-icon-button').title('Create session').onClick(this._createSession)('+'),
          ),
          ul.class('kikx-session-list')(
            this._buildSessionItems(),
          ),
        ),
        section.class('kikx-thread')(
          div.class('kikx-thread__header')(
            h2(this._selectedSession()?.title || 'No session'),
          ),
          this._buildFrameThread(),
          form.class('kikx-composer').onSubmit(this._onSubmit)(
            label.class('kikx-composer__label')('Message'),
            textarea
              .name('message')
              .placeholder(hasSelectedSession ? 'Send a message' : 'Create or select a session first')
              .disabled(!hasSelectedSession)
              .value.bindState((state) => state.draft, ['draft'])
              .onKeydown(this._onComposerKeydown)
              .onInput(this._syncDraft)(),
            div.class('kikx-composer__actions')(
              button.type('submit').class('kikx-send-button').disabled(!hasSelectedSession)('Send'),
            ),
          ),
        ),
      ),
    ];
  }

  _buildStatusBar() {
    return div.class.bindState((state) => `kikx-statusbar kikx-statusbar--${state.connectionStatusKind}`, ['connectionStatusKind'])(
      span.class('kikx-statusbar__dot')(),
      span.textContent.bindState((state) => state.connectionStatus, ['connectionStatus'])(),
    );
  }

  _buildAgentManager() {
    let providers = this._state.agentProviders;
    let agents = getAgents(this._state);
    let provider = getSelectedAgentProvider(this._state);

    return aeorModal.title('Agents').onClose(this._closeAgentManager)(
      div.class('kikx-agent-manager')(
        div.class('kikx-agent-manager__list')(
          h3('Configured agents'),
          agents.length === 0
            ? p.class('kikx-muted')('No agents.')
            : ul.class('kikx-agent-list')(
              agents.map((agent) => li(
                div(
                  strong(agent.name),
                  span(`${agent.pluginID}${agent.enabled === false ? ' disabled' : ''}`),
                ),
                div.class('kikx-agent-list__actions')(
                  button.type('button').class('kikx-sign-out-button').onClick(() => this._editAgent(agent))('Edit'),
                  button.type('button').class('kikx-sign-out-button').onClick(() => this._deleteAgent(agent.id))('Delete'),
                ),
              )),
            ),
        ),
        form.class('kikx-agent-form').onSubmit(this._onAgentFormSubmit)(
          h3(this._state.agentFormMode === 'edit' ? 'Edit agent' : 'New agent'),
          providers.length === 0
            ? p.class('kikx-muted')('No agent provider plugins are registered.')
            : [
              label('Name'),
              input
                .type('text')
                .name('name')
                .value.bindState((state) => state.agentFormName, ['agentFormName'])
                .onInput((event) => { this._state.agentFormName = event.target.value; })(),
              label('Provider'),
              select
                .name('pluginID')
                .disabled(this._state.agentFormMode === 'edit')
                .onChange((event) => this._selectAgentProvider(event.target.value))(
                  providers.map((candidate) => option
                    .value(candidate.pluginID)
                    .selected(candidate.pluginID === this._state.agentFormPluginID)(
                      candidate.displayName || candidate.pluginID,
                    )),
                ),
              ...this._buildAgentConfigFields(provider),
              div.class('modal-footer-actions')(
                button.type('button').class('kikx-sign-out-button').onClick(this._createAgent)('New'),
                button.type('submit').class('kikx-send-button')(this._state.agentFormMode === 'edit' ? 'Save' : 'Create'),
              ),
            ],
          p.class.bindState((state) => `kikx-auth-status kikx-auth-status--${state.agentStatusKind}`, ['agentStatusKind'])(
            span.textContent.bindState((state) => state.agentStatus, ['agentStatus'])(),
          ),
        ),
      ),
    );
  }

  _buildAgentConfigFields(provider) {
    if (!provider)
      return [];

    return (provider.configFields || []).flatMap((field) => [
      label(field.label || field.name),
      input
        .type(field.secret ? 'password' : field.type || 'text')
        .name(field.name)
        .placeholder(field.secret ? this._secretPlaceholder(field.name) : '')
        .value(field.secret ? '' : this._state.agentFormConfig[field.name] ?? field.defaultValue ?? '')
        .onInput((event) => this._syncAgentField(field, event.target.value))(),
    ]);
  }

  _buildSessionItems() {
    let sessions = getSessions(this._state);
    if (sessions.length === 0) {
      return li.class('kikx-session-list__empty')(
        p('No Sessions.'),
        button.type('button').class('kikx-inline-action').onClick(this._createSession)('+ New Session'),
      );
    }

    return sessions.map((session) => {
      let selected = session.id === this._state.selectedSessionID;
      let count = typeof session.messageCount === 'number' ? session.messageCount : 0;

      return li
        .class(selected ? 'is-selected' : '')
        .onClick(() => this._selectSession(session.id))(
          div.class('kikx-session-item__header')(
            strong(session.title || session.id),
            button
              .type('button')
              .class('kikx-session-item__edit')
              .title('Edit session')
              .ariaLabel('Edit session')
              .onClick((event) => this._openSessionEditor(event, session))('⚙'),
          ),
          span.class('kikx-session-item__meta')(`${count} message${count === 1 ? '' : 's'}`),
        );
    });
  }

  _buildSessionEditor() {
    return aeorModal.title('Edit session').onClose(this._closeSessionEditor)(
      form.class('kikx-session-editor').onSubmit(this._onSessionEditSubmit)(
        label('Name'),
        aeorInput
          .type('text')
          .name('title')
          .placeholder('Session name')
          .value.bindState((state) => state.editingSessionTitle, ['editingSessionTitle'])
          .onInput(this._syncEditingSessionTitle)(),
        div.class('modal-footer-actions').slot('footer')(
          button.type('button').class('kikx-sign-out-button').onClick(this._closeSessionEditor)('Cancel'),
          button.type('button').class('kikx-send-button').onClick(this._onSessionEditSubmit)('Save'),
        ),
      ),
    );
  }

  _buildFrameThread() {
    if (!this._state.selectedSessionID) {
      return div.class('kikx-thread__empty')(
        p('Create a session to start.'),
        button.type('button').class('kikx-inline-action').onClick(this._createSession)('+ New Session'),
      );
    }

    let frames = getSelectedFrames(this._state);
    if (frames.length === 0) {
      return div.class('kikx-thread__empty')(
        p('No frames yet.'),
      );
    }

    return ul.class('kikx-frame-list')(
      frames.map((frame) => li.class(`kikx-frame kikx-frame--${frame.type}`)(
        div.class('kikx-frame__meta')(
          strong(frame.type),
          span(frame.authorID || frame.authorType || 'system'),
        ),
        p(frame.content?.text || frame.contentText || frame.id),
      )),
    );
  }

  async _loadAeorDBEventsURL() {
    try {
      let response = await fetch('/api/v1/aeordb/events-url?events=entries_created,entries_updated&path_prefix=/kikx');
      let body = await response.json();
      if (!response.ok)
        throw new Error(body?.error?.message || 'Unable to load AeorDB events URL');

      this._state.aeordbEventsURL = body.data.url;
      this._state.connectionStatus = 'Connected';
      this._state.connectionStatusKind = 'ready';
    } catch (error) {
      this._state.connectionStatus = 'Disconnected';
      this._state.connectionStatusKind = 'error';
      this._state.status = error.message;
      this._state.statusKind = 'error';
    }
  }

  async _loadSessions() {
    try {
      let result = await this._getJSON('/api/v1/sessions');
      setSessions(result.data.sessions || [], this._state);

      let sessions = getSessions(this._state);
      if (!this._state.selectedSessionID && sessions.length > 0)
        this._state.selectedSessionID = sessions[0].id;

      if (this._state.selectedSessionID)
        await this._loadFrames(this._state.selectedSessionID);
      else
        this._render();
    } catch (error) {
      this._state.status = error.message;
      this._state.statusKind = 'error';
      this._render();
    }
  }

  async _loadAgents() {
    try {
      let [providersResult, agentsResult] = await Promise.all([
        this._getJSON('/api/v1/agent-providers'),
        this._getJSON('/api/v1/agents'),
      ]);
      setAgentProviders(providersResult.data.providers || [], this._state);
      setAgents(agentsResult.data.agents || [], this._state);
      if (!this._state.agentFormPluginID)
        this._state.agentFormPluginID = this._state.agentProviders[0]?.pluginID || '';
      this._render();
    } catch (error) {
      this._state.agentStatus = error.message;
      this._state.agentStatusKind = 'error';
      this._render();
    }
  }

  async _loadFrames(sessionID) {
    let result = await this._getJSON(`/api/v1/sessions/${encodeURIComponent(sessionID)}/frames`);
    setSessionFrames(sessionID, result.data.frames || [], this._state);
    this._render();
  }

  async _onMagicLinkSubmit(event) {
    event.preventDefault();
    let email = this._state.authEmail.trim();
    if (!email) {
      this._state.authStatus = 'Email is required';
      this._state.authStatusKind = 'error';
      return;
    }

    this._state.authStatus = 'Requesting magic link...';
    this._state.authStatusKind = 'pending';

    try {
      await this._postJSON('/api/v1/auth/magic-link', { email });
      this._state.authStatus = 'If the account exists, AeorDB sent a login link.';
      this._state.authStatusKind = 'ready';
    } catch (error) {
      this._state.authStatus = error.message;
      this._state.authStatusKind = 'error';
    }
  }

  async _verifyMagicLink(code) {
    if (!code) {
      this._state.authStatus = 'Code is required';
      this._state.authStatusKind = 'error';
      return;
    }

    this._state.authStatus = 'Verifying magic link...';
    this._state.authStatusKind = 'pending';

    try {
      let result = await this._getJSON(`/api/v1/auth/magic-link/verify?code=${encodeURIComponent(code)}`);
      this._applyAuth(result.data);
    } catch (error) {
      this._state.authStatus = error.message;
      this._state.authStatusKind = 'error';
    }
  }

  _applyAuth(auth) {
    if (!auth?.token)
      throw new Error('AeorDB did not return an auth token');

    this._state.authToken = auth.token;
    this._state.refreshToken = auth.refresh_token || '';
    this._state.status = 'Signed in';
    this._state.statusKind = 'ready';
    sessionStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(auth));
    this._render();
    this._loadAeorDBEventsURL();
    this._loadSessions();
  }

  _signOut() {
    sessionStorage.removeItem(AUTH_STORAGE_KEY);
    this._state.authToken = '';
    this._state.refreshToken = '';
    resetSessionState(this._state);
    this._state.connectionStatus = 'Disconnected';
    this._state.connectionStatusKind = 'error';
    this._state.status = 'Signed out';
    this._state.statusKind = 'pending';
    this._render();
  }

  async _getJSON(url) {
    let response = await fetch(url);
    return readResponse(response);
  }

  async _postJSON(url, body) {
    let response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    return readResponse(response);
  }

  async _patchJSON(url, body) {
    let response = await fetch(url, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    return readResponse(response);
  }

  _syncDraft(event) {
    this._state.draft = event.target.value;
  }

  _syncAuthEmail(event) {
    this._state.authEmail = event.target.value;
  }

  _syncEditingSessionTitle(event) {
    this._state.editingSessionTitle = event.target.value;
  }

  async _onSubmit(event) {
    event.preventDefault();
    let draft = this._state.draft.trim();
    if (!draft) {
      this._state.status = 'Write a message before sending';
      this._state.statusKind = 'error';
      return;
    }

    if (!this._state.selectedSessionID) {
      this._state.status = 'Create a session before sending';
      this._state.statusKind = 'error';
      return;
    }

    this._state.status = 'Committing message...';
    this._state.statusKind = 'pending';

    try {
      let result = await this._postJSON(`/api/v1/sessions/${encodeURIComponent(this._state.selectedSessionID)}/messages`, {
        text: draft,
      });
      upsertSession(result.data.session, this._state);
      this._state.draft = '';
      await this._loadFrames(this._state.selectedSessionID);
      this._state.status = 'Message committed';
      this._state.statusKind = 'ready';
      this._render();
    } catch (error) {
      this._state.status = error.message;
      this._state.statusKind = 'error';
      this._render();
    }
  }

  _onComposerKeydown(event) {
    if (!shouldSubmitComposerKey(event))
      return;

    event.preventDefault();
    event.target?.form?.requestSubmit();
  }

  _openAgentManager() {
    this._state.managingAgents = true;
    this._state.agentStatus = '';
    this._state.agentStatusKind = 'pending';
    resetAgentForm(this._state);
    this._render();
    this._loadAgents();
  }

  _closeAgentManager() {
    this._state.managingAgents = false;
    this._render();
  }

  _createAgent() {
    resetAgentForm(this._state);
    this._render();
  }

  _editAgent(agent) {
    this._state.agentFormMode = 'edit';
    this._state.editingAgentID = agent.id;
    this._state.agentFormName = agent.name || '';
    this._state.agentFormPluginID = agent.pluginID || '';
    this._state.agentFormConfig = { ...(agent.config || {}) };
    this._state.agentFormSecrets = {};
    this._state.agentStatus = '';
    this._render();
  }

  _selectAgentProvider(pluginID) {
    this._state.agentFormPluginID = pluginID;
    this._state.agentFormConfig = {};
    this._state.agentFormSecrets = {};
    this._render();
  }

  _syncAgentField(field, value) {
    if (field.secret) {
      this._state.agentFormSecrets = {
        ...this._state.agentFormSecrets,
        [field.name]: value,
      };
      return;
    }

    this._state.agentFormConfig = {
      ...this._state.agentFormConfig,
      [field.name]: coerceAgentFieldValue(field, value),
    };
  }

  async _onAgentFormSubmit(event) {
    event.preventDefault();

    let body = {
      name: this._state.agentFormName,
      pluginID: this._state.agentFormPluginID,
      config: this._state.agentFormConfig,
      secrets: nonEmptyValues(this._state.agentFormSecrets),
    };

    this._state.agentStatus = this._state.agentFormMode === 'edit' ? 'Saving agent...' : 'Creating agent...';
    this._state.agentStatusKind = 'pending';

    try {
      let result = this._state.agentFormMode === 'edit'
        ? await this._patchJSON(`/api/v1/agents/${encodeURIComponent(this._state.editingAgentID)}`, body)
        : await this._postJSON('/api/v1/agents', body);

      upsertAgent(result.data.agent, this._state);
      let message = this._state.agentFormMode === 'edit' ? 'Agent saved' : 'Agent created';
      this._editAgent(result.data.agent);
      this._state.agentStatus = message;
      this._state.agentStatusKind = 'ready';
      this._render();
    } catch (error) {
      this._state.agentStatus = error.message;
      this._state.agentStatusKind = 'error';
      this._render();
    }
  }

  async _deleteAgent(agentID) {
    this._state.agentStatus = 'Deleting agent...';
    this._state.agentStatusKind = 'pending';

    try {
      let response = await fetch(`/api/v1/agents/${encodeURIComponent(agentID)}`, { method: 'DELETE' });
      if (!response.ok)
        throw new Error((await response.json())?.error?.message || `HTTP ${response.status}`);

      removeAgent(agentID, this._state);
      if (this._state.editingAgentID === agentID)
        resetAgentForm(this._state);
      this._state.agentStatus = 'Agent deleted';
      this._state.agentStatusKind = 'ready';
      this._render();
    } catch (error) {
      this._state.agentStatus = error.message;
      this._state.agentStatusKind = 'error';
      this._render();
    }
  }

  _secretPlaceholder(fieldName) {
    let agent = this._state.agentDetailsByID[this._state.editingAgentID];
    let secret = agent?.secretState?.[fieldName];
    return secret?.present ? `Stored ending in ${secret.last4}` : '';
  }

  async _createSession() {
    this._state.status = 'Creating session...';
    this._state.statusKind = 'pending';

    try {
      let result = await this._postJSON('/api/v1/sessions', {
      });
      upsertSession(result.data.session, this._state);
      this._state.selectedSessionID = result.data.session.id;
      await this._loadSessions();
      this._state.status = 'Session created';
      this._state.statusKind = 'ready';
      this._render();
    } catch (error) {
      this._state.status = error.message;
      this._state.statusKind = 'error';
      this._render();
    }
  }

  _openSessionEditor(event, session) {
    event.stopPropagation();
    this._state.editingSessionID = session.id;
    this._state.editingSessionTitle = session.title || '';
    this._render();
  }

  _closeSessionEditor() {
    this._state.editingSessionID = '';
    this._state.editingSessionTitle = '';
    this._render();
  }

  async _onSessionEditSubmit(event) {
    event.preventDefault();

    let title = this._state.editingSessionTitle.trim();
    if (!title) {
      this._state.status = 'Session name is required';
      this._state.statusKind = 'error';
      return;
    }

    let sessionID = this._state.editingSessionID;
    this._state.status = 'Saving session...';
    this._state.statusKind = 'pending';

    try {
      let result = await this._patchJSON(`/api/v1/sessions/${encodeURIComponent(sessionID)}`, { title });
      upsertSession(result.data.session, this._state);
      this._state.editingSessionID = '';
      this._state.editingSessionTitle = '';
      this._state.status = 'Session saved';
      this._state.statusKind = 'ready';
      this._render();
    } catch (error) {
      this._state.status = error.message;
      this._state.statusKind = 'error';
      this._render();
    }
  }

  async _selectSession(sessionID) {
    this._state.selectedSessionID = sessionID;
    this._state.status = 'Loading session...';
    this._state.statusKind = 'pending';

    try {
      await this._loadFrames(sessionID);
      this._state.status = 'Session loaded';
      this._state.statusKind = 'ready';
      this._render();
    } catch (error) {
      this._state.status = error.message;
      this._state.statusKind = 'error';
      this._render();
    }
  }

  _selectedSession() {
    return getSelectedSession(this._state);
  }
}

async function readResponse(response) {
  let body = await response.json();
  if (!response.ok)
    throw new Error(body?.error?.message || `HTTP ${response.status}`);

  return body;
}

function nonEmptyValues(values) {
  let output = {};
  for (let [key, value] of Object.entries(values || {})) {
    if (value != null && value !== '')
      output[key] = value;
  }
  return output;
}

function coerceAgentFieldValue(field, value) {
  if (field.type === 'number')
    return value === '' ? null : Number(value);

  if (field.type === 'checkbox' || field.type === 'boolean')
    return Boolean(value);

  return value;
}

if (!customElements.get('kikx-app'))
  customElements.define('kikx-app', KikxApp);
