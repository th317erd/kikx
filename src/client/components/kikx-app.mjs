'use strict';

import { elements, $ } from '../lib/aeor-ui.mjs';
import {
  AUTH_STORAGE_KEY,
  getAgents,
  getSelectedFrames,
  getSelectedAgentProvider,
  getSelectedSession,
  getSessions,
  getSessionPreviews,
  getTeams,
  getCurrentEntry,
  getCurrentSessionID,
  getGridParentSessionID,
  getScopeNoun,
  getStackDepth,
  isCollapsed,
  kikxState,
  navigateBack,
  navigateGrid,
  navigateThread,
  removeAgent,
  removeTeam,
  resetAccountState,
  resetAgentForm,
  resetSessionState,
  resetTeamForm,
  setAccount,
  setAccountFormFromAccount,
  setAgentProviders,
  setAgents,
  setAgentFormFromAgent,
  setAgentFormProvider,
  setClientComponents,
  setCollapsedView,
  setNavigationStack,
  setSessionFrames,
  setSessionPreviews,
  setSessions,
  setPreviewsLoading,
  setPreviewStatus,
  setTeams,
  setTeamFormFromTeam,
  setTokenUsage,
  upsertFrames,
  upsertAgent,
  upsertSession,
  upsertSessionPreview,
  upsertTeam,
} from '../state/kikx-state.mjs';
import { shouldSubmitComposerKey } from './composer-keyboard.mjs';
import {
  composerCaretAllowsHistory,
  composerHistoryEntriesFromFrames,
  composerHistoryDirectionForKey,
  createComposerHistoryState,
  navigateComposerHistory,
  recordComposerHistoryEntry,
} from './composer-history.mjs';
import { loadClientComponentDescriptors } from './frame-component-registry.mjs';
import './kikx-frame-item.mjs';
import './kikx-chat-view.mjs';
import './kikx-session-grid.mjs';
import { childSessions, chunkSessionIDs, clampPreviewCount } from './chat-view-model.mjs';
import { stackFromSearchParams, stackToURL } from '../state/navigation-stack.mjs';
import {
  HERO_VIEW_TRANSITION_NAME,
  runViewTransition,
  setViewTransitionName,
} from './view-transition.mjs';

const { div, header, main, nav, section, h1, h2, p, span, button, form, input, label, textarea, ul, li, strong, option } = elements;
const aeorInput = elements['aeor-input'];
const aeorModal = elements['aeor-modal'];
const aeorSelect = elements['aeor-select'];
const aeorCheckbox = elements['aeor-checkbox'];

const ANCHOR_THRESHOLD = 50;
const FRAME_ENTER_ANIMATION_MS = 260;

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
    this._composerHistory = createComposerHistoryState();
    this._pendingPreviewSessionIDs = new Set();
    this._previewRefreshScheduled = false;

    this._onMagicLinkSubmit = this._onMagicLinkSubmit.bind(this);
    this._onSubmit = this._onSubmit.bind(this);
    this._onComposerKeydown = this._onComposerKeydown.bind(this);
    this._syncDraft = this._syncDraft.bind(this);
    this._syncAuthEmail = this._syncAuthEmail.bind(this);
    this._syncAccountName = this._syncAccountName.bind(this);
    this._syncAccountEmail = this._syncAccountEmail.bind(this);
    this._syncEditingSessionTitle = this._syncEditingSessionTitle.bind(this);
    this._openAccountEditor = this._openAccountEditor.bind(this);
    this._closeAccountEditor = this._closeAccountEditor.bind(this);
    this._onAccountSubmit = this._onAccountSubmit.bind(this);
    this._openAgentManager = this._openAgentManager.bind(this);
    this._closeAgentManager = this._closeAgentManager.bind(this);
    this._closeAgentEditor = this._closeAgentEditor.bind(this);
    this._createAgent = this._createAgent.bind(this);
    this._onAgentFormSubmit = this._onAgentFormSubmit.bind(this);
    this._openTeamManager = this._openTeamManager.bind(this);
    this._closeTeamManager = this._closeTeamManager.bind(this);
    this._closeTeamEditor = this._closeTeamEditor.bind(this);
    this._createTeam = this._createTeam.bind(this);
    this._onTeamFormSubmit = this._onTeamFormSubmit.bind(this);
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
    // Sub-session cards bubble "enter" events; handle them once at the root.
    this.addEventListener('kikx-session-enter', (event) => {
      if (event.detail?.sessionID)
        this._openSessionFromCard(event.detail.sessionID);
    });
    // Browser back/forward navigates the window stack.
    this._onPopState = () => this._syncFromURL();
    globalThis.addEventListener?.('popstate', this._onPopState);
    this._render();
    if (this._state.authToken) {
      this._connectRuntimeEvents();
      this._loadClientComponents();
      this._loadAccount();
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
        this._state.authToken ? this._buildBreadcrumb() : null,
        this._state.authToken
          ? div.class('kikx-topbar__actions')(
            span.class('kikx-account-chip')(this._state.account?.name || 'User'),
            button.type('button').class('kikx-sign-out-button').onClick(this._openAccountEditor)('Account'),
            button.type('button').class('kikx-sign-out-button').onClick(this._openAgentManager)('Agents'),
            button.type('button').class('kikx-sign-out-button').onClick(this._openTeamManager)('Teams'),
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

    if (this._state.accountEditorOpen)
      shellChildren.push(this._buildAccountEditor());

    if (this._state.managingAgents)
      shellChildren.push(this._buildAgentManager());

    if (this._state.agentEditorOpen)
      shellChildren.push(this._buildAgentEditor());

    if (this._state.managingTeams)
      shellChildren.push(this._buildTeamManager());

    if (this._state.teamEditorOpen)
      shellChildren.push(this._buildTeamEditor());

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

  _buildBreadcrumb() {
    let stack = this._state.navigationStack || [];
    let crumbs = [];

    crumbs.push({
      label: 'Projects',
      depth: 1,
      active: stack.length === 1,
    });

    for (let index = 1; index < stack.length; index++) {
      let entry = stack[index];
      let session = getSessions(this._state).find((candidate) => candidate.id === entry.sessionID);
      let label = session?.title || (entry.sessionID ? String(entry.sessionID).slice(0, 8) : 'Session');
      if (entry.collapsed)
        label += ' (sub-sessions)';
      crumbs.push({
        label,
        sessionTitle: session?.title || '',
        sessionID: entry.sessionID,
        depth: index + 1,
        active: index === stack.length - 1,
      });
    }

    return nav.class('kikx-breadcrumb').ariaLabel('Session navigation')(
      crumbs.flatMap((crumb, index) => {
        let nodes = [];
        if (index > 0)
          nodes.push(span.class('kikx-breadcrumb__sep')('›'));
        nodes.push(this._buildBreadcrumbCrumb(crumb));
        return nodes;
      }),
    );
  }

  // The breadcrumb is a navigation control: every crumb (including the active
  // one) navigates to that depth. Renaming happens on the window header title,
  // which is where users expect to click.
  _buildBreadcrumbCrumb(crumb) {
    if (crumb.active)
      return span.class('kikx-breadcrumb__crumb kikx-breadcrumb__crumb--active')(crumb.label);

    return button.type('button').class('kikx-breadcrumb__crumb').onClick(() => this._navigateToDepth(crumb.depth))(crumb.label);
  }

  // Editable window title: click the session name to rename it in place. This is
  // the prominent title; the breadcrumb stays purely navigational.
  _buildEditableTitle(title, sessionID) {
    if (!sessionID)
      return h2(title);

    if (this._state.editingSessionNameID === sessionID) {
      // A native input: aeor-input does not re-dispatch keydown/focusout, which
      // this inline editor needs for Enter/Escape and click-away commit.
      return input
        .type('text')
        .class('kikx-window__title-input')
        .name('session-name')
        .value(this._state.editingSessionNameValue || '')
        .onInput((event) => { this._state.editingSessionNameValue = event.target.value; })
        .onKeydown((event) => this._onSessionNameKeydown(event, sessionID))
        .onFocusout(() => this._commitSessionName(sessionID))();
    }

    return button
      .type('button')
      .class('kikx-window__title kikx-window__title--editable')
      .title('Rename session')
      .onClick(() => this._beginSessionNameEdit(sessionID, title))(title);
  }

  _beginSessionNameEdit(sessionID, currentTitle) {
    this._state.editingSessionNameID = sessionID;
    this._state.editingSessionNameValue = currentTitle || '';
    this._render();
    queueMicrotask(() => {
      let field = this.querySelector('input[name="session-name"]');
      field?.focus?.();
      field?.select?.();
    });
  }

  _onSessionNameKeydown(event, sessionID) {
    if (event.key === 'Enter') {
      event.preventDefault();
      this._commitSessionName(sessionID);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      this._cancelSessionNameEdit();
    }
  }

  _cancelSessionNameEdit() {
    this._state.editingSessionNameID = '';
    this._state.editingSessionNameValue = '';
    this._render();
  }

  async _commitSessionName(sessionID) {
    if (this._state.editingSessionNameID !== sessionID)
      return;

    let title = (this._state.editingSessionNameValue || '').trim();
    let session = getSessions(this._state).find((candidate) => candidate.id === sessionID);
    this._state.editingSessionNameID = '';
    this._state.editingSessionNameValue = '';

    if (!title || title === (session?.title || '')) {
      this._render();
      return;
    }

    try {
      let result = await this._patchJSON(`/api/v1/sessions/${encodeURIComponent(sessionID)}`, { title });
      upsertSession(result.data.session, this._state);
    } catch (error) {
      this._state.status = error.message;
      this._state.statusKind = 'error';
    }

    this._render();
  }

  _buildRunnerShell() {
    let entry = getCurrentEntry(this._state);
    let collapsed = entry.collapsed === true;

    return [
      main.class('kikx-main')(
        section.class('kikx-sessions')(
          div.class('kikx-sessions__header')(
            h2('Workspace'),
          ),
        ),
        this._buildWindow(entry, collapsed),
      ),
    ];
  }

  // The unified work area: a maximized session over its parent, or the grid of
  // children when collapsed. One container; the stack decides what is on top.
  _buildWindow(entry, collapsed) {
    let sessionID = entry.sessionID;

    if (!sessionID)
      return this._buildWorkspaceGrid();

    return collapsed
      ? this._buildChildGrid(sessionID)
      : this._buildThreadSection(sessionID);
  }

  _scopeNoun() {
    return getScopeNoun(this._state);
  }

  // One window header for every level. The root grid has no Close; a nested
  // session window always offers Close (minimize / pop). A session window also
  // has a toggle between its chat and its sub-session grid. Add lives in the
  // grid as a trailing "Add" card, not in this header.
  _buildWindowHeader({ title, sessionID = null, collapsed = false } = {}) {
    let nested = getStackDepth(this._state) > 1;
    let backButton = nested
      ? button
        .type('button')
        .class('kikx-icon-button kikx-window__close')
        .title('Close session')
        .ariaLabel('Close session')
        .onClick(this._minimizeCurrent)('‹')
      : null;

    return div.class('kikx-window__header')(
      backButton,
      this._buildEditableTitle(title, sessionID),
      div.class('kikx-window__actions')(
        span.class.bindState((state) => `kikx-workspace__status kikx-auth-status--${state.previewsLoading ? 'pending' : 'ready'}`, ['previewsLoading', 'previewStatus'])(
          span.textContent.bindState((state) => state.previewsLoading ? 'Loading previews…' : (state.previewStatus || ''), ['previewsLoading', 'previewStatus'])(),
        ),
        sessionID
          ? button
            .type('button')
            .class(`kikx-sign-out-button kikx-window__view-toggle${collapsed ? ' is-active' : ''}`)
            .ariaPressed(collapsed ? 'true' : 'false')
            .title(collapsed ? 'Show all chat messages' : 'Show only sub-sessions')
            .onClick(this._toggleSubSessions)(
              this._buildGridIcon(),
              ` (${this._childSessions(sessionID).length})`,
            )
          : null,
      ),
    );
  }

  // 6x6 grid glyph for the sub-session filter toggle, drawn as an inline SVG so
  // no external asset or font is required.
  _buildGridIcon() {
    let size = 6;
    let step = 2;
    let dot = 1.1;
    let span = (size - 1) * step + dot;
    let svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${span} ${span}`);
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    svg.classList.add('kikx-grid-icon');

    for (let row = 0; row < size; row++) {
      for (let column = 0; column < size; column++) {
        let rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        rect.setAttribute('x', String(column * step));
        rect.setAttribute('y', String(row * step));
        rect.setAttribute('width', String(dot));
        rect.setAttribute('height', String(dot));
        svg.appendChild(rect);
      }
    }

    return svg;
  }

  // A pure toggle: on shows only sub-session cards, off shows all messages.
  _toggleSubSessions() {
    if (isCollapsed(this._state))
      return this._expandCurrent();

    return this._showSubSessions();
  }

  _buildChildGrid(parentSessionID) {
    return section.class('kikx-workspace')(
      this._buildWindowHeader({
        title: this._childGridTitle(parentSessionID),
        sessionID: parentSessionID,
        collapsed: true,
      }),
      this._buildSessionGrid(parentSessionID),
    );
  }

  _buildWorkspaceGrid() {
    return section.class('kikx-workspace')(
      this._buildWindowHeader({ title: 'Projects' }),
      this._buildSessionGrid(null),
    );
  }

  _childGridTitle(parentSessionID) {
    return getSelectedSession(this._state)?.title || `Session ${String(parentSessionID).slice(0, 8)}`;
  }

  _childSessions(parentSessionID) {
    return childSessions(getSessions(this._state), parentSessionID);
  }

  _buildSessionGrid(parentSessionID) {
    let grid = document.createElement('kikx-session-grid');
    grid.update({
      allSessions: getSessions(this._state),
      parentSessionID,
      previews: getSessionPreviews(this._state),
      appState: this._state,
      selectedSessionID: this._state.selectedSessionID,
      loading: this._state.previewsLoading,
      addLabel: `Add ${this._scopeNoun()}`,
    });
    grid.addEventListener('kikx-card-open', (event) => {
      if (event.detail?.sessionID)
        this._openSessionFromCard(event.detail.sessionID);
    });
    grid.addEventListener('kikx-card-add', () => this._createSession());
    return div.class('kikx-workspace__grid')(grid);
  }

  _buildThreadSection(sessionID) {
    let hasSelectedSession = Boolean(sessionID);

    return section.class('kikx-thread')(
      this._buildWindowHeader({
        title: this._selectedSession()?.title || 'No session',
        sessionID,
        collapsed: false,
      }),
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
    );
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

  _buildAccountEditor() {
    return aeorModal.title('Account').onClose(this._closeAccountEditor)(
      form.class('kikx-account-form').onSubmit(this._onAccountSubmit)(
        label('Name'),
        aeorInput
          .type('text')
          .name('name')
          .placeholder('Display name')
          .value.bindState((state) => state.accountFormName, ['accountFormName'])
          .onInput(this._syncAccountName)(),
        label('Email'),
        aeorInput
          .type('email')
          .name('email')
          .placeholder('you@example.com')
          .value.bindState((state) => state.accountFormEmail, ['accountFormEmail'])
          .onInput(this._syncAccountEmail)(),
        div.class('modal-footer-actions')(
          button.type('button').class('kikx-sign-out-button').onClick(this._closeAccountEditor)('Cancel'),
          button.type('submit').class('kikx-send-button')('Save'),
        ),
        p.class.bindState((state) => `kikx-auth-status kikx-auth-status--${state.accountStatusKind}`, ['accountStatusKind'])(
          span.textContent.bindState((state) => state.accountStatus, ['accountStatus'])(),
        ),
      ),
    );
  }

  _buildAgentManager() {
    let agents = getAgents(this._state);
    let masterRankByID = masterRankByAgentID(agents);

    return aeorModal.title('Agents').onClose(this._closeAgentManager)(
      div.class('kikx-agent-manager')(
        agents.length === 0
          ? p.class('kikx-muted')('No agents.')
          : ul.class('kikx-agent-list')(
            agents.map((agent) => {
              let rank = masterRankByID.get(agent.id) || 0;
              return li(
                div.class('kikx-agent-list__details')(
                  strong(agent.name),
                  span(this._agentProviderLabel(agent)),
                ),
                button
                  .type('button')
                  .class(`kikx-agent-list__crown${rank ? ` is-master kikx-agent-list__crown--rank-${rank}` : ''}`)
                  .title(rank ? `Master agent #${rank} (click to uncrown)` : 'Crown as master agent')
                  .ariaLabel(rank ? `Master agent number ${rank}` : 'Crown as master agent')
                  .ariaPressed(rank ? 'true' : 'false')
                  .onClick(() => this._toggleAgentCrown(agent))('♛'),
                button
                  .type('button')
                  .class('kikx-agent-list__edit')
                  .title('Edit agent')
                  .ariaLabel('Edit agent')
                  .onClick(() => this._editAgent(agent))('⚙'),
              );
            }),
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

  _buildTeamManager() {
    let teams = getTeams(this._state);

    return aeorModal.title('Teams').onClose(this._closeTeamManager)(
      div.class('kikx-agent-manager kikx-team-manager')(
        teams.length === 0
          ? p.class('kikx-muted')('No teams.')
          : ul.class('kikx-agent-list kikx-team-list')(
            teams.map((team) => li(
              div.class('kikx-agent-list__details')(
                strong(team.name),
                span(this._teamMemberSummary(team)),
              ),
              button
                .type('button')
                .class('kikx-agent-list__edit kikx-team-list__edit')
                .title('Edit team')
                .ariaLabel('Edit team')
                .onClick(() => this._editTeam(team))('⚙'),
            )),
          ),
        div.class('modal-footer-actions')(
          button.type('button').class('kikx-send-button').onClick(this._createTeam)('+ Add Team'),
        ),
        p.class.bindState((state) => `kikx-auth-status kikx-auth-status--${state.teamStatusKind}`, ['teamStatusKind'])(
          span.textContent.bindState((state) => state.teamStatus, ['teamStatus'])(),
        ),
      ),
    );
  }

  _buildTeamEditor() {
    let actors = this._availableTeamActors();

    return aeorModal
      .title(this._state.teamFormMode === 'edit' ? 'Edit team' : 'Create team')
      .onClose(this._closeTeamEditor)(
        form.class('kikx-agent-form kikx-team-form').onSubmit(this._onTeamFormSubmit)(
          label('Name'),
          aeorInput
            .type('text')
            .name('name')
            .value.bindState((state) => state.teamFormName, ['teamFormName'])
            .onInput((event) => { this._state.teamFormName = event.target.value; })(),
          label('Members'),
          actors.length === 0
            ? p.class('kikx-muted')('No actors are available.')
            : div.class('kikx-team-member-list')(
              actors.map((actor) => aeorCheckbox
                .class('kikx-team-member-option')
                .name('team-member')
                .value(this._teamMemberKey(actor))
                .checked(this._teamMemberChecked(actor))
                .onChange((event) => this._toggleTeamMember(actor, event.currentTarget.checked))(
                  span.class('kikx-team-member-option__name')(actor.name),
                  span.class('kikx-team-member-option__type')(actor.type),
                )),
            ),
          div.class('modal-footer-actions')(
            ...(this._state.teamFormMode === 'edit'
              ? [ button.type('button').class('kikx-sign-out-button').onClick(() => this._deleteTeam(this._state.editingTeamID))('Delete') ]
              : []),
            button.type('button').class('kikx-sign-out-button').onClick(this._closeTeamEditor)('Cancel'),
            button.type('button').class('kikx-send-button').onClick(this._onTeamFormSubmit)(this._state.teamFormMode === 'edit' ? 'Save' : 'Create'),
          ),
          p.class.bindState((state) => `kikx-auth-status kikx-auth-status--${state.teamStatusKind}`, ['teamStatusKind'])(
            span.textContent.bindState((state) => state.teamStatus, ['teamStatus'])(),
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

  _availableTeamActors() {
    let actors = getAgents(this._state).map((agent) => ({
      type: 'agent',
      actorID: agent.id,
      name: agent.name || agent.id,
    }));
    let account = this._state.account;
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

  _teamMemberKey(actor) {
    return `${actor.type}:${actor.actorID}`;
  }

  _teamMemberChecked(actor) {
    return this._state.teamFormMemberKeys[this._teamMemberKey(actor)] === true;
  }

  _toggleTeamMember(actor, checked) {
    let key = this._teamMemberKey(actor);
    let next = { ...this._state.teamFormMemberKeys };
    if (checked)
      next[key] = true;
    else
      delete next[key];

    this._state.teamFormMemberKeys = next;
  }

  _teamMembersFromForm() {
    let selected = this._state.teamFormMemberKeys || {};
    return this._availableTeamActors().filter((actor) => selected[this._teamMemberKey(actor)]).map((actor) => ({ ...actor }));
  }

  _teamMemberSummary(team) {
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
        p('No messages yet.'),
        p.class('kikx-thread__empty-hint')("Type /invite 'name of party' to invite an agent, or other party"),
      );
    }

    return this._createChatViewElement(frames);
  }

  _createChatViewElement(frames, mode = 'full') {
    let view = document.createElement('kikx-chat-view');
    view.mode = mode;
    view.update({ frames, appState: this._state });
    return view;
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

    let affectedSessionIDs = [ ...framesBySessionID.keys() ].filter((sessionID) => sessionID !== selectedSessionID);
    if (affectedSessionIDs.length > 0 && isCollapsed(this._state))
      this._schedulePreviewRefresh(affectedSessionIDs);

    if (this._pendingFrameRuntimeEvents.length > 0 && !this._frameRuntimeFlushScheduled) {
      this._frameRuntimeFlushScheduled = true;
      scheduleAnimationFrame(this._flushFrameRuntimeEvents);
    }
  }

  async _loadSessions() {
    try {
      let result = await this._getJSON('/api/v1/sessions');
      setSessions(result.data.sessions || [], this._state);

      // Deep-link: ?session=<id> or ?view=thread opens a session's thread.
      await this._applySessionDeepLink();

      this._render();
      await this._loadSessionPreviews();
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

  async _loadTeams() {
    try {
      let [teamsResult, agentsResult] = await Promise.all([
        this._getJSON('/api/v1/teams'),
        this._getJSON('/api/v1/agents'),
      ]);
      setTeams(teamsResult.data.teams || [], this._state);
      setAgents(agentsResult.data.agents || [], this._state);
      this._render();
    } catch (error) {
      this._state.teamStatus = error.message;
      this._state.teamStatusKind = 'error';
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
    this._loadAccount();
    this._loadAgents();
    this._loadSessions();
    this._loadTokenUsage();
  }

  _signOut() {
    this._disconnectRuntimeEvents();
    sessionStorage.removeItem(AUTH_STORAGE_KEY);
    this._state.authToken = '';
    this._state.refreshToken = '';
    resetAccountState(this._state);
    resetSessionState(this._state);
    setTeams([], this._state);
    resetTeamForm(this._state);
    this._state.managingTeams = false;
    this._state.teamEditorOpen = false;
    setTokenUsage({}, 0, this._state);
    this._state.connectionStatus = 'Disconnected';
    this._state.connectionStatusKind = 'error';
    this._state.status = 'Signed out';
    this._state.statusKind = 'pending';
    this._render();
  }

  async _getJSON(url) {
    let response = await fetch(url, {
      headers: this._apiHeaders(),
    });
    return readResponse(response);
  }

  async _postJSON(url, body) {
    let response = await fetch(url, {
      method: 'POST',
      headers: this._apiHeaders({
        'Content-Type': 'application/json',
      }),
      body: JSON.stringify(body),
    });
    return readResponse(response);
  }

  async _patchJSON(url, body) {
    let response = await fetch(url, {
      method: 'PATCH',
      headers: this._apiHeaders({
        'Content-Type': 'application/json',
      }),
      body: JSON.stringify(body),
    });
    return readResponse(response);
  }

  async _deleteJSON(url) {
    let response = await fetch(url, {
      method: 'DELETE',
      headers: this._apiHeaders(),
    });
    if (response.status === 204)
      return null;

    return readResponse(response);
  }

  _apiHeaders(headers = {}) {
    let next = { ...headers };
    if (this._state.authToken)
      next.Authorization = `Bearer ${this._state.authToken}`;

    return next;
  }

  _syncDraft(event) {
    this._state.draft = event.target.value;
  }

  _syncAuthEmail(event) {
    this._state.authEmail = event.target.value;
  }

  _syncAccountName(event) {
    this._state.accountFormName = event.target.value;
  }

  _syncAccountEmail(event) {
    this._state.accountFormEmail = event.target.value;
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
        authorDisplayName: this._state.account?.name || null,
      });
      upsertSession(result.data.session, this._state);
      recordComposerHistoryEntry(this._composerHistory, draft);
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
    if (this._handleComposerHistoryKey(event))
      return;

    if (!shouldSubmitComposerKey(event))
      return;

    event.preventDefault();
    event.target?.form?.requestSubmit();
  }

  _handleComposerHistoryKey(event) {
    let direction = composerHistoryDirectionForKey(event);
    if (!direction)
      return false;

    let composer = event.target;
    if (!composer)
      return false;

    if (!composerCaretAllowsHistory(direction, composer.value, composer.selectionStart))
      return false;

    this._syncComposerHistoryFromFrames();

    let navigation = navigateComposerHistory(this._composerHistory, direction, composer.value);
    if (!navigation.handled)
      return false;

    event.preventDefault();
    composer.value = navigation.value ?? '';
    this._state.draft = composer.value;

    let caret = composer.value.length;
    try {
      composer.setSelectionRange(caret, caret);
    } catch (_error) {}

    return true;
  }

  _syncComposerHistoryFromFrames() {
    if (this._composerHistory.cursor !== -1)
      return;

    let entries = composerHistoryEntriesFromFrames(getSelectedFrames(this._state));
    if (entries.length > 0)
      this._composerHistory.entries = entries;
  }

  async _loadAccount(options = {}) {
    try {
      let result = await this._getJSON('/api/v1/account');
      setAccount(result.data?.account || null, this._state);
      if (options.syncForm === true)
        setAccountFormFromAccount(this._state.account, this._state);
      this._requestRender();
    } catch (error) {
      this._state.accountStatus = error.message;
      this._state.accountStatusKind = 'error';
      if (options.render !== false)
        this._requestRender();
    }
  }

  async _openAccountEditor() {
    this._state.accountEditorOpen = true;
    this._state.accountStatus = '';
    this._state.accountStatusKind = 'pending';
    setAccountFormFromAccount(this._state.account, this._state);
    this._render();
    await this._loadAccount({ syncForm: true, render: false });
  }

  _closeAccountEditor() {
    this._state.accountEditorOpen = false;
    this._render();
  }

  async _onAccountSubmit(event) {
    event.preventDefault();

    let name = this._state.accountFormName.trim();
    let email = this._state.accountFormEmail.trim();
    if (!name) {
      this._state.accountStatus = 'Name is required';
      this._state.accountStatusKind = 'error';
      this._render();
      return;
    }

    this._state.accountStatus = 'Saving account...';
    this._state.accountStatusKind = 'pending';
    this._requestRender();

    try {
      let result = await this._patchJSON('/api/v1/account', { name, email });
      setAccount(result.data?.account || null, this._state);
      setAccountFormFromAccount(this._state.account, this._state);
      this._state.accountEditorOpen = false;
      this._state.accountStatus = 'Account saved';
      this._state.accountStatusKind = 'ready';
      this._render();
    } catch (error) {
      this._state.accountStatus = error.message;
      this._state.accountStatusKind = 'error';
      this._render();
    }
  }

  _openAgentManager() {
    this._state.managingAgents = true;
    this._state.managingTeams = false;
    this._state.agentEditorOpen = false;
    this._state.teamEditorOpen = false;
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

  _openTeamManager() {
    this._state.managingTeams = true;
    this._state.managingAgents = false;
    this._state.teamEditorOpen = false;
    this._state.agentEditorOpen = false;
    this._state.teamStatus = '';
    this._state.teamStatusKind = 'pending';
    resetTeamForm(this._state);
    this._render();
    this._loadTeams();
  }

  _closeTeamManager() {
    this._state.managingTeams = false;
    this._render();
  }

  _closeTeamEditor() {
    this._state.teamEditorOpen = false;
    this._state.managingTeams = true;
    this._render();
  }

  _createTeam() {
    resetTeamForm(this._state);
    this._state.managingTeams = false;
    this._state.teamEditorOpen = true;
    this._render();
  }

  _editTeam(team) {
    this._state.managingTeams = false;
    this._state.teamEditorOpen = true;
    setTeamFormFromTeam(team, this._state);
    this._state.teamStatus = '';
    this._render();
  }

  async _onTeamFormSubmit(event) {
    event.preventDefault();

    let body = {
      name: this._state.teamFormName,
      members: this._teamMembersFromForm(),
    };

    this._state.teamStatus = this._state.teamFormMode === 'edit' ? 'Saving team...' : 'Creating team...';
    this._state.teamStatusKind = 'pending';

    try {
      let result = this._state.teamFormMode === 'edit'
        ? await this._patchJSON(`/api/v1/teams/${encodeURIComponent(this._state.editingTeamID)}`, body)
        : await this._postJSON('/api/v1/teams', body);

      upsertTeam(result.data.team, this._state);
      let message = this._state.teamFormMode === 'edit' ? 'Team saved' : 'Team created';
      resetTeamForm(this._state);
      this._state.teamEditorOpen = false;
      this._state.managingTeams = true;
      this._state.teamStatus = message;
      this._state.teamStatusKind = 'ready';
      this._render();
    } catch (error) {
      this._state.teamStatus = error.message;
      this._state.teamStatusKind = 'error';
      this._render();
    }
  }

  async _deleteTeam(teamID) {
    this._state.teamStatus = 'Deleting team...';
    this._state.teamStatusKind = 'pending';

    try {
      await this._deleteJSON(`/api/v1/teams/${encodeURIComponent(teamID)}`);
      removeTeam(teamID, this._state);
      if (this._state.editingTeamID === teamID)
        resetTeamForm(this._state);
      this._state.teamEditorOpen = false;
      this._state.managingTeams = true;
      this._state.teamStatus = 'Team deleted';
      this._state.teamStatusKind = 'ready';
      this._render();
    } catch (error) {
      this._state.teamStatus = error.message;
      this._state.teamStatusKind = 'error';
      this._render();
    }
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

  async _toggleAgentCrown(agent) {
    let crowned = !agent.crownedClock;
    this._state.agentStatus = crowned ? 'Crowning agent...' : 'Uncrowning agent...';
    this._state.agentStatusKind = 'pending';

    try {
      let result = await this._postJSON(
        `/api/v1/agents/${encodeURIComponent(agent.id)}/${crowned ? 'crown' : 'uncrown'}`,
        {},
      );
      upsertAgent(result.data.agent, this._state);
      this._state.agentStatus = crowned ? `Crowned ${agent.name}` : `Uncrowned ${agent.name}`;
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
      // Create as a child of the session whose grid we are viewing (null at root).
      let parentSessionID = getGridParentSessionID(this._state);
      let result = await this._postJSON('/api/v1/sessions', {
        ...(parentSessionID ? { parentSessionID } : {}),
      });
      upsertSession(result.data.session, this._state);
      await this._loadSessions();
      // Enter the newly created session.
      await this._openSessionFromCard(result.data.session.id);
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

  // Minimize the current session (pop the stack). Only valid past the root.
  _minimizeCurrent() {
    if (getStackDepth(this._state) <= 1)
      return;

    // The session we are leaving; its card in the destination grid is the hero.
    let leavingSessionID = getGridParentSessionID(this._state);
    this._setHeroName(this._threadChatViewElement());

    runViewTransition(() => {
      navigateBack(this._state);
      this._syncSelectedSessionToStack();
      this._syncURLFromStack({ push: true });
      this._render();
      let grid = this.querySelector('kikx-session-grid');
      this._setHeroName(grid?.cardViewElement(leavingSessionID));
    }).finally(() => this._clearHeroNames());
  }

  // Keep state.selectedSessionID aligned with the current stack entry so frames
  // and titles reflect the active window.
  _syncSelectedSessionToStack() {
    let sessionID = getCurrentSessionID(this._state);
    this._state.selectedSessionID = sessionID || '';
  }

  // Toggle "show sub-sessions" (collapsed) on the current entry. The thread view
  // is replaced by a child grid; a crossfade transition plays without a shared
  // element (the two views are different element trees).
  async _showSubSessions() {
    await runViewTransition(() => {
      setCollapsedView(true, this._state);
      this._syncURLFromStack({ push: true });
      this._render();
    });

    await this._loadSessionPreviews();
  }

  // Expand a collapsed grid back into the full chat for its session.
  async _expandCurrent() {
    let entry = getCurrentEntry(this._state);
    if (!entry.collapsed || !entry.sessionID)
      return;

    await runViewTransition(() => {
      setCollapsedView(false, this._state);
      this._syncURLFromStack({ push: true });
      this._render();
    });
  }

  _navigateToDepth(depth) {
    if (!Number.isInteger(depth) || depth < 1)
      return;

    let stack = this._state.navigationStack || [];
    if (depth >= stack.length)
      return;

    this._state.navigationStack = stack.slice(0, depth);
    this._syncSelectedSessionToStack();
    this._syncURLFromStack({ push: true });
    this._render();
  }

  async _openSessionFromCard(sessionID) {
    if (!sessionID)
      return;

    // "Before" snapshot: only the source card's chat view carries the hero name.
    let grid = this.querySelector('kikx-session-grid');
    this._setHeroName(grid?.cardViewElement(sessionID));

    // Enter the session (push a thread window) and start the morph immediately;
    // load frames after, so the transition never waits on the network.
    await runViewTransition(() => {
      this._state.selectedSessionID = sessionID;
      this._state.status = 'Loading session...';
      this._state.statusKind = 'pending';
      this._forceScrollToBottomAfterRender = true;
      navigateThread(sessionID, this._state);
      this._syncURLFromStack({ push: true });
      this._render();
      this._setHeroName(this._threadChatViewElement());
    });

    this._clearHeroNames();

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

    await this._loadSessionPreviews();
  }

  _threadChatViewElement() {
    return this.querySelector('.kikx-thread__body kikx-chat-view');
  }

  _setHeroName(element) {
    for (let view of this.querySelectorAll('kikx-chat-view'))
      setViewTransitionName(view, view === element ? HERO_VIEW_TRANSITION_NAME : '');
  }

  _clearHeroNames() {
    for (let view of this.querySelectorAll('kikx-chat-view'))
      setViewTransitionName(view, '');
  }

  // Resolve the navigation stack from the current URL, dropping any session IDs
  // that no longer exist and truncating at the first missing link so a stale URL
  // cannot open a broken stack.
  _stackFromCurrentURL() {
    let parsed = stackFromSearchParams(globalThis.location?.search || '');
    let first = getSessions(this._state)[0]?.id;

    if (parsed.viewThread && first)
      return [ { sessionID: null, collapsed: true }, { sessionID: first, collapsed: false } ];

    let known = new Set(getSessions(this._state).map((session) => session.id));
    let stack = [ { sessionID: null, collapsed: true } ];
    for (let entry of parsed.stack.slice(1)) {
      if (!known.has(entry.sessionID))
        break;

      stack.push(entry);
    }

    return stack;
  }

  // Optional deep link on first load: ?session=<id> (or ?view=thread) opens a
  // session thread directly, seeding the navigation stack.
  async _applySessionDeepLink() {
    if (this._deepLinkApplied)
      return;

    this._deepLinkApplied = true;
    let stack = this._stackFromCurrentURL();
    if (stack.length <= 1)
      return;

    setNavigationStack(stack, this._state);
    let top = getCurrentSessionID(this._state);
    this._state.selectedSessionID = top;
    this._forceScrollToBottomAfterRender = true;

    try {
      if (top)
        await this._loadFrames(top);
    } catch (_error) {}
  }

  // Keep the address bar in sync with the window stack so a reload (or a shared
  // link) restores the exact view. Uses replaceState: the stack has its own
  // back/forward handled below, so we do not push a history entry per navigation
  // unless the owner asked for true browser history.
  _syncURLFromStack({ push = false } = {}) {
    if (typeof globalThis.location === 'undefined' || typeof globalThis.history === 'undefined')
      return;

    let url = stackToURL(this._state.navigationStack || [], {
      origin: globalThis.location.origin,
      pathname: globalThis.location.pathname,
      search: globalThis.location.search,
    });

    if (url === globalThis.location.href)
      return;

    if (push)
      globalThis.history.pushState({ kikxStack: true }, '', url);
    else
      globalThis.history.replaceState({ kikxStack: true }, '', url);
  }

  // Apply the URL's stack (browser back/forward).
  async _syncFromURL() {
    let stack = this._stackFromCurrentURL();

    setNavigationStack(stack, this._state);
    let top = getCurrentSessionID(this._state);
    this._state.selectedSessionID = top || '';

    try {
      if (top && !isCollapsed(this._state))
        await this._loadFrames(top);
    } catch (_error) {}

    this._render();
  }

  async _loadSessionPreviews() {
    let sessions = getSessions(this._state);
    if (sessions.length === 0) {
      setPreviewStatus('', this._state);
      return;
    }

    setPreviewsLoading(true, this._state);

    try {
      let previewCount = clampPreviewCount(this._state.previewCount);
      let previews = [];
      for (let chunk of chunkSessionIDs(sessions.map((session) => session.id)))
        previews.push(...await this._getSessionPreviews(chunk, previewCount));

      setSessionPreviews(previews, this._state);
      setPreviewStatus('', this._state);
    } catch (error) {
      setPreviewStatus(error.message, this._state);
    } finally {
      setPreviewsLoading(false, this._state);
      if (isCollapsed(this._state))
        this._requestRender();
    }
  }

  async _getSessionPreviews(sessionIDs, previewCount) {
    if (sessionIDs.length === 0)
      return [];

    let result = await this._postJSON('/api/v1/sessions/previews', { sessionIDs, previewCount });
    return result.data?.previews || [];
  }

  _applyPreviewToGrid(sessionID, preview) {
    upsertSessionPreview(sessionID, preview, this._state);
    let grid = this.querySelector('kikx-session-grid');
    if (grid)
      grid.setPreview(sessionID, preview);
  }

  _schedulePreviewRefresh(sessionIDs) {
    for (let sessionID of sessionIDs)
      this._pendingPreviewSessionIDs.add(sessionID);

    if (this._previewRefreshScheduled)
      return;

    this._previewRefreshScheduled = true;
    setTimeout(() => this._flushPreviewRefresh(), 400);
  }

  async _flushPreviewRefresh() {
    this._previewRefreshScheduled = false;
    let sessionIDs = [ ...this._pendingPreviewSessionIDs ];
    this._pendingPreviewSessionIDs.clear();
    if (sessionIDs.length === 0)
      return;

    try {
      let previewCount = clampPreviewCount(this._state.previewCount);
      let previews = await this._getSessionPreviews(sessionIDs, previewCount);
      for (let preview of previews)
        this._applyPreviewToGrid(preview.sessionID, preview);
    } catch (_error) {}
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
    // The title can be an h2 (root) or an editable button (session window); in
    // edit mode it is an input, which we leave alone.
    let threadTitle = this.querySelector('.kikx-window__header .kikx-window__title, .kikx-window__header h2');
    let selectedSession = this._selectedSession();
    if (threadTitle)
      threadTitle.textContent = selectedSession?.title || 'No session';

    let grid = this.querySelector('kikx-session-grid');
    if (grid) {
      // Respect the current level's parent filter; the grid shows direct
      // children of the active session, never the unfiltered list.
      grid.update({
        allSessions: getSessions(this._state),
        parentSessionID: getGridParentSessionID(this._state),
        previews: getSessionPreviews(this._state),
        appState: this._state,
        selectedSessionID: this._state.selectedSessionID,
        loading: this._state.previewsLoading,
      });
      return true;
    }

    return Boolean(threadTitle);
  }

  _syncFrameThread(sessionID = this._state.selectedSessionID, options = {}) {
    if (!sessionID || sessionID !== this._state.selectedSessionID)
      return;

    let body = this.querySelector('.kikx-thread__body');
    if (!body)
      return;

    let frames = getSelectedFrames(this._state).filter((frame) => frame && !frame.deleted && !frame.hidden);
    let view = body.querySelector('kikx-chat-view');
    if (frames.length === 0 || !view) {
      this._disconnectFrameListObserver();
      body.replaceChildren(this._buildFrameThread().build(document));
      this._connectFrameListObserver();
      if (this._frameListAnchoredToBottom)
        this._scrollFramesToBottomImmediate();
      return;
    }

    let wasAnchoredToBottom = this._frameListAnchoredToBottom || this._isFrameListNearBottom(view.frameList);
    let result = view.syncFrames(frames, this._state, options);

    if (result.insertedNew && wasAnchoredToBottom) {
      this._frameListAnchoredToBottom = true;
      this._scheduleAnchoredFrameScroll();
    }
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

  _scheduleAnchoredFrameScroll() {
    scheduleAnimationFrame(() => {
      this._scrollFramesToBottomImmediate();
    });

    setTimeout(() => {
      this._scrollFramesToBottomImmediate();
    }, FRAME_ENTER_ANIMATION_MS + 40);
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

// Rank crowned agents so the newest crown is master #1, next #2, etc. Returns a
// Map of agentID -> rank (1-based); uncrowned agents are absent.
function masterRankByAgentID(agents = []) {
  let crowned = (Array.isArray(agents) ? agents : [])
    .filter((agent) => Boolean(agent.crownedClock))
    .sort((a, b) => (
      String(b.crownedClock || '').localeCompare(String(a.crownedClock || ''))
      || (Number(b.crownedAt || 0) - Number(a.crownedAt || 0))
      || String(a.id).localeCompare(String(b.id))
    ));

  let ranks = new Map();
  crowned.forEach((agent, index) => ranks.set(agent.id, index + 1));
  return ranks;
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
