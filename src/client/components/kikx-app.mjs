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
  setAgentFormFromAgent,
  setAgentFormProvider,
  setClientComponents,
  setSessionFrames,
  setSessions,
  setTokenUsage,
  upsertFrames,
  upsertAgent,
  upsertSession,
} from '../state/kikx-state.mjs';
import { shouldSubmitComposerKey } from './composer-keyboard.mjs';
import { loadClientComponentDescriptors } from './frame-component-registry.mjs';
import './kikx-frame-item.mjs';

const { div, header, main, section, h1, h2, p, span, button, form, label, textarea, ul, li, strong, option } = elements;
const aeorInput = elements['aeor-input'];
const aeorModal = elements['aeor-modal'];
const aeorSelect = elements['aeor-select'];

const ANCHOR_THRESHOLD = 50;

export class KikxApp extends HTMLElement {
  constructor() {
    super();

    this._state = kikxState;
    this._eventSource = null;
    this._frameListResizeObserver = null;
    this._observedFrameList = null;
    this._frameListAnchoredToBottom = true;
    this._forceScrollToBottomAfterRender = false;
    this._focusComposerAfterRender = false;
    this._renderScheduled = false;
    this._pendingFrameRuntimeEvents = [];
    this._frameRuntimeFlushScheduled = false;

    this._onMagicLinkSubmit = this._onMagicLinkSubmit.bind(this);
    this._onSubmit = this._onSubmit.bind(this);
    this._onComposerKeydown = this._onComposerKeydown.bind(this);
    this._syncDraft = this._syncDraft.bind(this);
    this._syncAuthEmail = this._syncAuthEmail.bind(this);
    this._syncEditingSessionTitle = this._syncEditingSessionTitle.bind(this);
    this._openAgentManager = this._openAgentManager.bind(this);
    this._closeAgentManager = this._closeAgentManager.bind(this);
    this._closeAgentEditor = this._closeAgentEditor.bind(this);
    this._createAgent = this._createAgent.bind(this);
    this._onAgentFormSubmit = this._onAgentFormSubmit.bind(this);
    this._createSession = this._createSession.bind(this);
    this._closeSessionEditor = this._closeSessionEditor.bind(this);
    this._onSessionEditSubmit = this._onSessionEditSubmit.bind(this);
    this._signOut = this._signOut.bind(this);
    this._onRuntimeEvent = this._onRuntimeEvent.bind(this);
    this._onRuntimeEventsOpen = this._onRuntimeEventsOpen.bind(this);
    this._onRuntimeEventsError = this._onRuntimeEventsError.bind(this);
    this._onFrameListScroll = this._onFrameListScroll.bind(this);
    this._onFrameContentResize = this._onFrameContentResize.bind(this);
    this._flushFrameRuntimeEvents = this._flushFrameRuntimeEvents.bind(this);
  }

  connectedCallback() {
    if (this._mounted)
      return;

    this._mounted = true;
    this._render();
    if (this._state.authToken) {
      this._connectRuntimeEvents();
      this._loadClientComponents();
      this._loadAgents();
      this._loadSessions();
      this._loadTokenUsage();
    } else if (this._state.magicCode) {
      this._verifyMagicLink(this._state.magicCode);
    }
  }

  _render() {
    let renderSnapshot = this._captureRenderSnapshot();
    this._disconnectFrameListObserver();
    this._cleanupReactiveBindings();
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

    if (this._state.agentEditorOpen)
      shellChildren.push(this._buildAgentEditor());

    let tree = div.class('kikx-shell').context(this)(shellChildren).build(document);

    this.appendChild(tree);
    this._afterRender(renderSnapshot);
  }

  disconnectedCallback() {
    this._disconnectRuntimeEvents();
    this._disconnectFrameListObserver();
    this._cleanupReactiveBindings();
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
          div.class('kikx-thread__body')(
            this._buildFrameThread(),
          ),
          form.class('kikx-composer').onSubmit(this._onSubmit)(
            label.class('kikx-composer__label')('Message'),
            textarea
              .name('message')
              .placeholder(hasSelectedSession ? 'Send a message' : 'Create or select a session first')
              .disabled(!hasSelectedSession)
              .onKeydown(this._onComposerKeydown)
              .onInput(this._syncDraft)(this._state.draft),
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
      span.class('kikx-statusbar__spacer')(),
      span
        .class('kikx-statusbar__tokens')
        .title('Total tracked tokens')
        .textContent.bindState((state) => formatTokenUsageTotal(state.totalTokensUsed), ['totalTokensUsed'])(),
    );
  }

  _buildAgentManager() {
    let agents = getAgents(this._state);

    return aeorModal.title('Agents').onClose(this._closeAgentManager)(
      div.class('kikx-agent-manager')(
        agents.length === 0
          ? p.class('kikx-muted')('No agents.')
          : ul.class('kikx-agent-list')(
            agents.map((agent) => li(
              div.class('kikx-agent-list__details')(
                strong(agent.name),
                span(this._agentProviderLabel(agent)),
              ),
              button
                .type('button')
                .class('kikx-agent-list__edit')
                .title('Edit agent')
                .ariaLabel('Edit agent')
                .onClick(() => this._editAgent(agent))('⚙'),
            )),
          ),
        div.class('modal-footer-actions')(
          button.type('button').class('kikx-send-button').onClick(this._createAgent)('+ Add Agent'),
        ),
        p.class.bindState((state) => `kikx-auth-status kikx-auth-status--${state.agentStatusKind}`, ['agentStatusKind'])(
          span.textContent.bindState((state) => state.agentStatus, ['agentStatus'])(),
        ),
      ),
    );
  }

  _buildAgentEditor() {
    let providers = this._state.agentProviders;
    let provider = getSelectedAgentProvider(this._state);

    return aeorModal
      .title(this._state.agentFormMode === 'edit' ? 'Edit agent' : 'Create agent')
      .onClose(this._closeAgentEditor)(
        form.class('kikx-agent-form').onSubmit(this._onAgentFormSubmit)(
          providers.length === 0
            ? p.class('kikx-muted')('No agent provider plugins are registered.')
            : [
              label('Name'),
              aeorInput
                .type('text')
                .name('name')
                .value.bindState((state) => state.agentFormName, ['agentFormName'])
                .onInput((event) => { this._state.agentFormName = event.target.value; })(),
              label('Provider'),
              aeorSelect
                .name('pluginID')
                .placeholder('Select provider')
                .value(this._state.agentFormPluginID)
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
                ...(this._state.agentFormMode === 'edit'
                  ? [ button.type('button').class('kikx-sign-out-button').onClick(() => this._deleteAgent(this._state.editingAgentID))('Delete') ]
                  : []),
                button.type('button').class('kikx-sign-out-button').onClick(this._closeAgentEditor)('Cancel'),
                button.type('button').class('kikx-send-button').onClick(this._onAgentFormSubmit)(this._state.agentFormMode === 'edit' ? 'Save' : 'Create'),
              ),
            ],
          p.class.bindState((state) => `kikx-auth-status kikx-auth-status--${state.agentStatusKind}`, ['agentStatusKind'])(
            span.textContent.bindState((state) => state.agentStatus, ['agentStatus'])(),
          ),
        ),
      );
  }

  _buildAgentConfigFields(provider) {
    if (!provider)
      return [];

    return (provider.configFields || []).flatMap((field) => [
      label(field.label || field.name),
      this._buildAgentConfigField(field),
    ]);
  }

  _buildAgentConfigField(field) {
    if (field.type === 'select') {
      return aeorSelect
        .name(field.name)
        .placeholder(field.label || field.name)
        .value(this._agentConfigFieldValue(field))
        .onChange((event) => this._syncAgentField(field, event.target.value))(
          normalizeFieldOptions(field.options).map((item) => option
            .value(item.value)
            .selected(item.value === this._agentConfigFieldValue(field))(
              item.label,
            )),
        );
    }

    return aeorInput
      .type(field.secret ? 'password' : field.type || 'text')
      .name(field.name)
      .placeholder(field.secret ? this._secretPlaceholder(field.name) : '')
      .value(field.secret ? '' : this._agentConfigFieldValue(field))
      .onInput((event) => this._syncAgentField(field, event.target.value))();
  }

  _agentConfigFieldValue(field) {
    return this._state.agentFormConfig[field.name] ?? field.defaultValue ?? '';
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

    let frames = getSelectedFrames(this._state).filter((frame) => frame && !frame.deleted && !frame.hidden);
    if (frames.length === 0) {
      return div.class('kikx-thread__empty')(
        p('No frames yet.'),
      );
    }

    return div.class('kikx-frame-list').role('list')(
      div.class('kikx-frame-stream')(
        frames.map((frame) => this._createFrameItemElement(frame)),
      ),
    );
  }

  _createFrameItemElement(frame) {
    let item = document.createElement('kikx-frame-item');
    item.updateFrame(frame, this._state);
    return item;
  }

  _connectRuntimeEvents() {
    this._disconnectRuntimeEvents();

    if (typeof EventSource !== 'function') {
      this._state.connectionStatus = 'Disconnected';
      this._state.connectionStatusKind = 'error';
      return;
    }

    try {
      this._eventSource = new EventSource('/api/v1/events');
      this._eventSource.addEventListener('open', this._onRuntimeEventsOpen);
      this._eventSource.addEventListener('error', this._onRuntimeEventsError);
      for (let eventType of [ 'connected', 'session.saved', 'frame.added', 'frame.updated', 'frame.phantom', 'commit', 'tokens.updated' ])
        this._eventSource.addEventListener(eventType, this._onRuntimeEvent);
    } catch (error) {
      this._state.connectionStatus = 'Disconnected';
      this._state.connectionStatusKind = 'error';
      this._state.status = error.message;
      this._state.statusKind = 'error';
    }
  }

  _disconnectRuntimeEvents() {
    if (!this._eventSource)
      return;

    this._eventSource.close();
    this._eventSource = null;
  }

  _onRuntimeEventsOpen() {
    this._state.connectionStatus = 'Connected';
    this._state.connectionStatusKind = 'ready';
  }

  _onRuntimeEventsError() {
    this._state.connectionStatus = 'Disconnected';
    this._state.connectionStatusKind = 'error';
  }

  _onRuntimeEvent(event) {
    let data = parseRuntimeEvent(event);
    if (!data)
      return;

    if (data.type === 'connected') {
      this._state.connectionStatus = 'Connected';
      this._state.connectionStatusKind = 'ready';
      return;
    }

    if (data.type === 'tokens.updated') {
      setTokenUsage(data.tokenUsage || {}, data.totalTokensUsed, this._state);
      return;
    }

    if (data.type === 'session.saved' && data.session?.id) {
      upsertSession(data.session, this._state);
      if (!this._syncSessionShell())
        this._requestRender();
      return;
    }

    if ((data.type === 'frame.added' || data.type === 'frame.updated' || data.type === 'frame.phantom') && data.sessionID && data.frame?.id) {
      this._queueFrameRuntimeEvent(data);
      return;
    }

    if (data.sessionID === this._state.selectedSessionID && this._frameListAnchoredToBottom)
      this._forceScrollToBottomAfterRender = true;

    this._requestRender();
  }

  _queueFrameRuntimeEvent(data) {
    this._pendingFrameRuntimeEvents.push(data);

    if (this._frameRuntimeFlushScheduled)
      return;

    this._frameRuntimeFlushScheduled = true;
    scheduleAnimationFrame(this._flushFrameRuntimeEvents);
  }

  _flushFrameRuntimeEvents() {
    this._frameRuntimeFlushScheduled = false;
    let events = this._pendingFrameRuntimeEvents.splice(0);
    if (events.length === 0)
      return;

    let framesBySessionID = new Map();
    let touchedFrameIDsBySessionID = new Map();
    for (let data of events) {
      addFrameToBatch(framesBySessionID, data.sessionID, data.frame);
      addTouchedFrameIDs(touchedFrameIDsBySessionID, data.sessionID, renderedFrameIDsFor(data.frame));
    }
    upsertFrames(framesBySessionID, this._state);

    let selectedSessionID = this._state.selectedSessionID;
    let touchedFrameIDs = touchedFrameIDsBySessionID.get(selectedSessionID);
    if (touchedFrameIDs)
      this._syncFrameThread(selectedSessionID, { touchedFrameIDs });

    if (this._pendingFrameRuntimeEvents.length > 0 && !this._frameRuntimeFlushScheduled) {
      this._frameRuntimeFlushScheduled = true;
      scheduleAnimationFrame(this._flushFrameRuntimeEvents);
    }
  }

  async _loadSessions() {
    try {
      let result = await this._getJSON('/api/v1/sessions');
      setSessions(result.data.sessions || [], this._state);

      let sessions = getSessions(this._state);
      if (!this._state.selectedSessionID && sessions.length > 0)
        this._state.selectedSessionID = sessions[0].id;

      if (this._state.selectedSessionID) {
        this._forceScrollToBottomAfterRender = true;
        await this._loadFrames(this._state.selectedSessionID);
      } else {
        this._render();
      }
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
        resetAgentForm(this._state);
      this._render();
    } catch (error) {
      this._state.agentStatus = error.message;
      this._state.agentStatusKind = 'error';
      this._render();
    }
  }

  async _loadClientComponents() {
    try {
      let result = await this._getJSON('/api/v1/client-components');
      let components = await loadClientComponentDescriptors(result.data?.components || []);
      setClientComponents(components, this._state);
      this._syncFrameThread(this._state.selectedSessionID, { force: true });
    } catch (error) {
      this._state.clientComponentStatus = 'error';
      this._state.status = error.message;
      this._state.statusKind = 'error';
      this._requestRender();
    }
  }

  async _loadFrames(sessionID, options = {}) {
    let result = await this._getJSON(`/api/v1/sessions/${encodeURIComponent(sessionID)}/frames`);
    setSessionFrames(sessionID, result.data.frames || [], this._state);
    if (options.render !== false)
      this._render();
  }

  async _loadTokenUsage() {
    try {
      let result = await this._getJSON('/api/v1/tokens');
      setTokenUsage(result.data?.tokenUsage || {}, result.data?.totalTokensUsed, this._state);
      this._render();
    } catch (error) {
      this._state.status = error.message;
      this._state.statusKind = 'error';
      this._render();
    }
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
    this._connectRuntimeEvents();
    this._loadClientComponents();
    this._loadAgents();
    this._loadSessions();
    this._loadTokenUsage();
  }

  _signOut() {
    this._disconnectRuntimeEvents();
    sessionStorage.removeItem(AUTH_STORAGE_KEY);
    this._state.authToken = '';
    this._state.refreshToken = '';
    resetSessionState(this._state);
    setTokenUsage({}, 0, this._state);
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
    let submittedDraft = this._state.draft;
    let draft = submittedDraft.trim();
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
    this._clearComposerDraft();

    try {
      let result = await this._postJSON(`/api/v1/sessions/${encodeURIComponent(this._state.selectedSessionID)}/messages`, {
        text: draft,
      });
      upsertSession(result.data.session, this._state);
      this._forceScrollToBottomAfterRender = true;
      this._focusComposerAfterRender = true;
      await this._loadFrames(this._state.selectedSessionID, { render: false });
      this._state.status = 'Message committed';
      this._state.statusKind = 'ready';
      this._render();
    } catch (error) {
      this._restoreComposerDraftOnFailure(submittedDraft);
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
    this._state.agentEditorOpen = false;
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

  _closeAgentEditor() {
    this._state.agentEditorOpen = false;
    this._state.managingAgents = true;
    this._render();
  }

  _createAgent() {
    resetAgentForm(this._state);
    this._state.managingAgents = false;
    this._state.agentEditorOpen = true;
    this._render();
  }

  _editAgent(agent) {
    this._state.managingAgents = false;
    this._state.agentEditorOpen = true;
    setAgentFormFromAgent(agent, this._state);
    this._state.agentStatus = '';
    this._render();
  }

  _selectAgentProvider(pluginID) {
    setAgentFormProvider(pluginID, this._state);
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
      resetAgentForm(this._state);
      this._state.agentEditorOpen = false;
      this._state.managingAgents = true;
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
      this._state.agentEditorOpen = false;
      this._state.managingAgents = true;
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

  _agentProviderLabel(agent) {
    let provider = this._state.agentProviders.find((candidate) => candidate.pluginID === agent.pluginID);
    let label = provider?.displayName || agent.pluginID;
    return `${label}${agent.enabled === false ? ' disabled' : ''}`;
  }

  async _createSession() {
    this._state.status = 'Creating session...';
    this._state.statusKind = 'pending';

    try {
      let result = await this._postJSON('/api/v1/sessions', {
      });
      upsertSession(result.data.session, this._state);
      this._state.selectedSessionID = result.data.session.id;
      this._forceScrollToBottomAfterRender = true;
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
    this._forceScrollToBottomAfterRender = true;

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

  _captureRenderSnapshot() {
    let frameList = this.querySelector('.kikx-frame-list');

    let composer = this.querySelector('textarea[name="message"]');
    let composerFocused = this.contains(document.activeElement) && document.activeElement === composer;

    return {
      composerFocused,
      composerPresent: Boolean(composer),
      selectedSessionID: this._state.selectedSessionID,
      frameListPresent: Boolean(frameList),
      frameListScrollTop: frameList?.scrollTop ?? 0,
      frameListScrollHeight: frameList?.scrollHeight ?? 0,
      composerSelectionStart: composerFocused ? composer.selectionStart : null,
      composerSelectionEnd: composerFocused ? composer.selectionEnd : null,
      composerSelectionDirection: composerFocused ? composer.selectionDirection : 'none',
      frameListNearBottom: this._frameListAnchoredToBottom,
      forceScrollToBottom: this._forceScrollToBottomAfterRender,
      focusComposer: this._focusComposerAfterRender,
    };
  }

  _afterRender(snapshot = {}) {
    let shouldScrollToBottom = snapshot.forceScrollToBottom || snapshot.frameListNearBottom;
    let shouldFocusComposer = snapshot.focusComposer || snapshot.composerFocused;
    let shouldRestoreFrameScroll = (
      !shouldScrollToBottom
      && snapshot.frameListPresent
      && snapshot.selectedSessionID === this._state.selectedSessionID
    );
    let composer = this.querySelector('textarea[name="message"]');
    if (composer && composer.value !== (this._state.draft || ''))
      composer.value = this._state.draft || '';

    this._forceScrollToBottomAfterRender = false;
    this._focusComposerAfterRender = false;

    if (shouldScrollToBottom) {
      this._frameListAnchoredToBottom = true;
      this._scrollFramesToBottom();
    } else if (shouldRestoreFrameScroll) {
      this._restoreFrameListScroll(snapshot);
    }

    if (shouldFocusComposer) {
      queueMicrotask(() => {
        let nextComposer = this.querySelector('textarea[name="message"]:not([disabled])');
        if (!nextComposer)
          return;

        nextComposer.focus();
        if (Number.isInteger(snapshot.composerSelectionStart) && Number.isInteger(snapshot.composerSelectionEnd)) {
          let max = nextComposer.value.length;
          nextComposer.setSelectionRange(
            Math.min(snapshot.composerSelectionStart, max),
            Math.min(snapshot.composerSelectionEnd, max),
            snapshot.composerSelectionDirection || 'none',
          );
        }
      });
    }

    this._connectFrameListObserver();
  }

  _requestRender() {
    if (this._renderScheduled)
      return;

    this._renderScheduled = true;
    scheduleAnimationFrame(() => {
      this._renderScheduled = false;
      if (this.isConnected)
        this._render();
    });
  }

  _clearComposerDraft() {
    this._state.draft = '';
    let composer = this.querySelector('textarea[name="message"]');
    if (!composer)
      return;

    composer.value = '';
    try {
      composer.setSelectionRange(0, 0);
    } catch (_error) {}
  }

  _restoreComposerDraftOnFailure(submittedDraft) {
    if (this._state.draft)
      return;

    this._state.draft = submittedDraft;
    let composer = this.querySelector('textarea[name="message"]');
    if (composer && composer.value === '')
      composer.value = submittedDraft;
  }

  _syncSessionShell() {
    let sessionList = this.querySelector('.kikx-session-list');
    if (!sessionList)
      return false;

    let sessionItems = this._buildSessionItems();
    let sessionItemDefinitions = Array.isArray(sessionItems) ? sessionItems : [ sessionItems ];
    sessionList.replaceChildren(...sessionItemDefinitions.map((item) => item.build(document)));

    let threadTitle = this.querySelector('.kikx-thread__header h2');
    let selectedSession = this._selectedSession();
    if (threadTitle)
      threadTitle.textContent = selectedSession?.title || 'No session';

    return true;
  }

  _syncFrameThread(sessionID = this._state.selectedSessionID, options = {}) {
    if (!sessionID || sessionID !== this._state.selectedSessionID)
      return;

    let body = this.querySelector('.kikx-thread__body');
    if (!body)
      return;

    let frames = getSelectedFrames(this._state).filter((frame) => frame && !frame.deleted && !frame.hidden);
    if (frames.length === 0) {
      if (!body.querySelector('.kikx-thread__empty')) {
        this._disconnectFrameListObserver();
        body.replaceChildren(this._buildFrameThread().build(document));
      }
      return;
    }

    let frameList = body.querySelector('.kikx-frame-list');
    let frameStream = frameList?.querySelector('.kikx-frame-stream');
    if (!frameList || !frameStream) {
      this._disconnectFrameListObserver();
      body.replaceChildren(this._buildFrameThread().build(document));
      this._connectFrameListObserver();
      if (this._frameListAnchoredToBottom)
        this._scrollFramesToBottomImmediate();
      return;
    }

    let touchedFrameIDs = options.touchedFrameIDs instanceof Set ? options.touchedFrameIDs : null;
    let existingByID = new Map();
    for (let item of Array.from(frameStream.children).filter((node) => node.matches?.('kikx-frame-item[data-frame-id]')))
      existingByID.set(item.dataset.frameId, item);

    let cursor = frameStream.firstElementChild;
    for (let frame of frames) {
      let item = existingByID.get(frame.id);
      if (!item) {
        item = this._createFrameItemElement(frame);
      } else {
        existingByID.delete(frame.id);
        if (options.force === true || !touchedFrameIDs || touchedFrameIDs.has(frame.id))
          item.updateFrame(frame, this._state, { force: options.force === true });
      }

      if (item === cursor) {
        cursor = cursor.nextElementSibling;
      } else {
        frameStream.insertBefore(item, cursor);
      }
    }

    for (let stale of existingByID.values())
      stale.remove();
  }

  _cleanupReactiveBindings(root = this) {
    let nodes = [ root, ...root.querySelectorAll('*') ];
    for (let node of nodes) {
      if (!Array.isArray(node.__bindings))
        continue;

      for (let cleanup of node.__bindings)
        cleanup?.();

      node.__bindings = [];
    }
  }

  _connectFrameListObserver() {
    let frameList = this.querySelector('.kikx-frame-list');
    let frameStream = frameList?.querySelector('.kikx-frame-stream');
    if (!frameList || !frameStream || typeof ResizeObserver !== 'function')
      return;

    this._observedFrameList = frameList;
    frameList.addEventListener('scroll', this._onFrameListScroll);
    this._frameListResizeObserver = new ResizeObserver(this._onFrameContentResize);
    this._frameListResizeObserver.observe(frameStream);
  }

  _disconnectFrameListObserver() {
    if (this._observedFrameList) {
      this._observedFrameList.removeEventListener('scroll', this._onFrameListScroll);
      this._observedFrameList = null;
    }

    if (!this._frameListResizeObserver)
      return;

    this._frameListResizeObserver.disconnect();
    this._frameListResizeObserver = null;
  }

  _isFrameListNearBottom(frameList = this.querySelector('.kikx-frame-list')) {
    if (!frameList)
      return true;

    return frameList.scrollHeight - frameList.scrollTop - frameList.clientHeight <= ANCHOR_THRESHOLD;
  }

  _scrollFramesToBottom() {
    this._frameListAnchoredToBottom = true;
    this._scrollFramesToBottomImmediate();
  }

  _scrollFramesToBottomImmediate(frameList = this.querySelector('.kikx-frame-list')) {
    if (!frameList)
      return;

    frameList.scrollTop = Math.max(0, frameList.scrollHeight - frameList.clientHeight);
  }

  _restoreFrameListScroll(snapshot = {}) {
    let frameList = this.querySelector('.kikx-frame-list');
    if (!frameList)
      return;

    let maxScrollTop = Math.max(0, frameList.scrollHeight - frameList.clientHeight);
    frameList.scrollTop = Math.min(Math.max(0, snapshot.frameListScrollTop || 0), maxScrollTop);
  }

  _onFrameContentResize() {
    if (this._frameListAnchoredToBottom)
      this._scrollFramesToBottomImmediate();
  }

  _onFrameListScroll(event) {
    this._frameListAnchoredToBottom = this._isFrameListNearBottom(event.currentTarget);
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

function normalizeFieldOptions(options) {
  return (Array.isArray(options) ? options : []).map((item) => {
    if (typeof item === 'string')
      return { value: item, label: item };

    return {
      value: item?.value ?? '',
      label: item?.label ?? item?.value ?? '',
    };
  });
}

function formatTokenUsageTotal(value) {
  let total = Number(value);
  if (!Number.isFinite(total) || total < 0)
    total = 0;

  return `Tokens: ${Math.trunc(total).toLocaleString('en-US')}`;
}

function parseRuntimeEvent(event) {
  try {
    let data = JSON.parse(event.data || '{}');
    if (!data.type && event.type)
      data.type = event.type;
    return data;
  } catch (_error) {
    return null;
  }
}

function scheduleAnimationFrame(callback) {
  if (typeof requestAnimationFrame === 'function')
    return requestAnimationFrame(callback);

  return setTimeout(callback, 0);
}

function addTouchedFrameIDs(target, sessionID, frameIDs) {
  if (!sessionID || !frameIDs || frameIDs.size === 0)
    return;

  let existing = target.get(sessionID);
  if (!existing) {
    existing = new Set();
    target.set(sessionID, existing);
  }

  for (let frameID of frameIDs)
    existing.add(frameID);
}

function addFrameToBatch(target, sessionID, frame) {
  if (!sessionID || !frame)
    return;

  let frames = target.get(sessionID);
  if (!frames) {
    frames = [];
    target.set(sessionID, frames);
  }

  frames.push(frame);
}

function renderedFrameIDsFor(frame) {
  let ids = new Set();
  if (!frame)
    return ids;

  if (typeof frame.id === 'string' && frame.id)
    ids.add(frame.id);

  if (
    frame.phantom === true
    && typeof frame.responseFrameID === 'string'
    && frame.responseFrameID.trim() !== ''
    && (frame.type === 'AgentThinking' || frame.type === 'AgentMessageDelta')
  ) {
    ids.add(frame.responseFrameID.trim());
  }

  if (frame.type === 'BeginTyping' || frame.type === 'EndTyping') {
    let agentID = frame.authorID || frame.content?.agentID || 'default';
    ids.add(`typing:${agentID}`);
  }

  return ids;
}

if (!customElements.get('kikx-app'))
  customElements.define('kikx-app', KikxApp);
