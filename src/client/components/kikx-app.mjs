'use strict';

import { elements, $ } from '../lib/aeor-ui.mjs';
import {
  getSelectedSession,
  kikxState,
} from '../state/kikx-state.mjs';
import { createComposerHistoryState } from './composer-history.mjs';
import './kikx-frame-item.mjs';
import './kikx-chat-view.mjs';
import './kikx-session-grid.mjs';
import {
  buildAuthShell,
  buildBreadcrumb,
  buildBreadcrumbCrumb,
  buildChildGrid,
  buildEditableTitle,
  buildFrameThread,
  buildGridIcon,
  buildRunnerShell,
  buildSessionGrid,
  buildStatusBar,
  buildThreadSection,
  buildWindow,
  buildWindowHeader,
  buildWorkspaceGrid,
  childGridTitle,
  childSessionsFor,
  createChatViewElement,
  createFrameItemElement,
  scopeNoun,
} from './kikx-shell-builders.mjs';
import {
  buildAccountEditor,
  buildAgentConfigField,
  buildAgentConfigFields,
  buildAgentDeleteButton,
  buildAgentEditor,
  buildAgentManager,
  buildAgentManagerBody,
  buildSessionEditor,
  buildTeamEditor,
  buildTeamManager,
  agentConfigFieldValue,
  agentProviderLabel,
  teamMemberSummary,
} from './kikx-modals.mjs';
import {
  apiHeaders,
  deleteJSON,
  getJSON,
  patchJSON,
  postJSON,
  applyPreviewToGrid,
  flushPreviewRefresh,
  getSessionPreviews,
  loadAccount,
  loadAgents,
  loadClientComponents,
  loadFrames,
  loadOlderFrames,
  loadSessions,
  loadSessionPreviews,
  loadTeams,
  loadTokenUsage,
  schedulePreviewRefresh,
} from './kikx-data.mjs';
import {
  connectRuntimeEvents,
  disconnectRuntimeEvents,
  flushFrameRuntimeEvents,
  onRuntimeEvent,
  onRuntimeEventsError,
  onRuntimeEventsOpen,
  queueFrameRuntimeEvent,
} from './kikx-runtime-events.mjs';
import {
  afterRender,
  captureRenderSnapshot,
  cleanupReactiveBindings,
  connectFrameListObserver,
  disconnectFrameListObserver,
  isFrameListNearBottom,
  onFrameContentResize,
  onFrameListScroll,
  requestRender,
  restoreFrameListScroll,
  scheduleAnchoredFrameScroll,
  scrollFramesToBottom,
  scrollFramesToBottomImmediate,
  syncFrameThread,
  syncSessionShell,
} from './kikx-frame-scroll.mjs';
import {
  applySessionDeepLink,
  beginSessionNameEdit,
  cancelSessionNameEdit,
  clearHeroNames,
  commitSessionName,
  expandCurrent,
  minimizeCurrent,
  navigateToDepth,
  onSessionNameKeydown,
  openSessionFromCard,
  setHeroName,
  showSubSessions,
  stackFromCurrentURL,
  syncFromURL,
  syncSelectedSessionToStack,
  syncURLFromStack,
  threadChatViewElement,
  toggleSubSessions,
} from './kikx-navigation.mjs';
import {
  clearComposerDraft,
  handleComposerHistoryKey,
  onComposerKeydown,
  onSubmit,
  restoreComposerDraftOnFailure,
  syncComposerHistoryFromFrames,
  syncDraft,
} from './kikx-composer.mjs';
import {
  availableTeamActors,
  closeAccountEditor,
  closeSessionEditor,
  closeTeamEditor,
  closeTeamManager,
  createSession,
  createTeam,
  deleteTeam,
  editTeam,
  onAccountSubmit,
  onSessionEditSubmit,
  onTeamFormSubmit,
  openAccountEditor,
  openSessionEditor,
  openTeamManager,
  selectSession,
  signOut,
  syncAccountEmail,
  syncAccountName,
  syncAgentField,
  syncAuthEmail,
  syncEditingSessionTitle,
  teamMemberChecked,
  teamMemberKey,
  teamMembersFromForm,
  toggleTeamMember,
  applyAuth,
} from './kikx-editors.mjs';
import {
  closeAgentEditor,
  closeAgentManager,
  createAgent,
  deleteAgent,
  editAgent,
  onAgentFormSubmit,
  openAgentManager,
  reconcileMasters,
  repaintAgentCrowns,
  repaintAgentManagerBody,
  secretPlaceholder,
  selectAgentProvider,
  setAgentCrownBusy,
  setAgentFilter,
  syncAgentStatusText,
  toggleAgentCrown,
} from './kikx-agent-controller.mjs';
import { onMagicLinkSubmit, verifyMagicLink } from './kikx-auth.mjs';

const { div, header, h1, p, span, button } = elements;

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
    this._pendingCrownAgentIDs = new Set();

    this._buildAuthShell = () => buildAuthShell(this);
    this._buildBreadcrumb = () => buildBreadcrumb(this);
    this._buildBreadcrumbCrumb = (crumb) => buildBreadcrumbCrumb(this, crumb);
    this._buildEditableTitle = (title, sessionID) => buildEditableTitle(this, title, sessionID);
    this._beginSessionNameEdit = (sessionID, currentTitle) => beginSessionNameEdit(this, sessionID, currentTitle);
    this._onSessionNameKeydown = (event, sessionID) => onSessionNameKeydown(this, event, sessionID);
    this._cancelSessionNameEdit = () => cancelSessionNameEdit(this);
    this._commitSessionName = async (sessionID) => commitSessionName(this, sessionID);
    this._buildRunnerShell = () => buildRunnerShell(this);
    this._buildWindow = (entry, collapsed) => buildWindow(this, entry, collapsed);
    this._scopeNoun = () => scopeNoun(this);
    this._buildWindowHeader = (options) => buildWindowHeader(this, options);
    this._buildGridIcon = () => buildGridIcon();
    this._toggleSubSessions = () => toggleSubSessions(this);
    this._buildChildGrid = (parentSessionID) => buildChildGrid(this, parentSessionID);
    this._buildWorkspaceGrid = () => buildWorkspaceGrid(this);
    this._childGridTitle = (parentSessionID) => childGridTitle(this, parentSessionID);
    this._childSessions = (parentSessionID) => childSessionsFor(this, parentSessionID);
    this._buildSessionGrid = (parentSessionID) => buildSessionGrid(this, parentSessionID);
    this._buildThreadSection = (sessionID) => buildThreadSection(this, sessionID);
    this._buildStatusBar = () => buildStatusBar(this);
    this._buildAccountEditor = () => buildAccountEditor(this);
    this._buildAgentManager = () => buildAgentManager(this);
    this._buildAgentManagerBody = () => buildAgentManagerBody(this);
    this._repaintAgentManagerBody = () => repaintAgentManagerBody(this);
    this._buildAgentEditor = () => buildAgentEditor(this);
    this._buildTeamManager = () => buildTeamManager(this);
    this._buildTeamEditor = () => buildTeamEditor(this);
    this._buildAgentConfigFields = (provider) => buildAgentConfigFields(this, provider);
    this._buildAgentConfigField = (field) => buildAgentConfigField(this, field);
    this._agentConfigFieldValue = (field) => agentConfigFieldValue(this, field);
    this._availableTeamActors = () => availableTeamActors(this);
    this._teamMemberKey = (actor) => teamMemberKey(actor);
    this._teamMemberChecked = (actor) => teamMemberChecked(this, actor);
    this._toggleTeamMember = (actor, checked) => toggleTeamMember(this, actor, checked);
    this._teamMembersFromForm = () => teamMembersFromForm(this);
    this._teamMemberSummary = (team) => teamMemberSummary(team);
    this._buildSessionEditor = () => buildSessionEditor(this);
    this._buildFrameThread = () => buildFrameThread(this);
    this._createChatViewElement = (frames, mode = 'full') => createChatViewElement(this, frames, mode);
    this._createFrameItemElement = (frame) => createFrameItemElement(this, frame);
    this._connectRuntimeEvents = () => connectRuntimeEvents(this);
    this._disconnectRuntimeEvents = () => disconnectRuntimeEvents(this);
    this._onRuntimeEventsOpen = () => onRuntimeEventsOpen(this);
    this._onRuntimeEventsError = () => onRuntimeEventsError(this);
    this._onRuntimeEvent = (event) => onRuntimeEvent(this, event);
    this._queueFrameRuntimeEvent = (data) => queueFrameRuntimeEvent(this, data);
    this._flushFrameRuntimeEvents = () => flushFrameRuntimeEvents(this);
    this._loadSessions = async () => loadSessions(this);
    this._loadAgents = async () => loadAgents(this);
    this._loadTeams = async () => loadTeams(this);
    this._loadClientComponents = async () => loadClientComponents(this);
    this._loadFrames = async (sessionID, options = {}) => loadFrames(this, sessionID, options);
    this._loadOlderFrames = async (sessionID = this._state.selectedSessionID) => loadOlderFrames(this, sessionID);
    this._loadTokenUsage = async () => loadTokenUsage(this);
    this._onMagicLinkSubmit = async (event) => onMagicLinkSubmit(this, event);
    this._verifyMagicLink = async (code) => verifyMagicLink(this, code);
    this._applyAuth = (auth) => applyAuth(this, auth);
    this._signOut = () => signOut(this);
    this._getJSON = async (url) => getJSON(this, url);
    this._postJSON = async (url, body) => postJSON(this, url, body);
    this._patchJSON = async (url, body) => patchJSON(this, url, body);
    this._deleteJSON = async (url) => deleteJSON(this, url);
    this._apiHeaders = (headers = {}) => apiHeaders(this, headers);
    this._syncDraft = (event) => syncDraft(this, event);
    this._syncAuthEmail = (event) => syncAuthEmail(this, event);
    this._syncAccountName = (event) => syncAccountName(this, event);
    this._syncAccountEmail = (event) => syncAccountEmail(this, event);
    this._syncEditingSessionTitle = (event) => syncEditingSessionTitle(this, event);
    this._onSubmit = async (event) => onSubmit(this, event);
    this._onComposerKeydown = (event) => onComposerKeydown(this, event);
    this._handleComposerHistoryKey = (event) => handleComposerHistoryKey(this, event);
    this._syncComposerHistoryFromFrames = () => syncComposerHistoryFromFrames(this);
    this._loadAccount = async (options = {}) => loadAccount(this, options);
    this._openAccountEditor = async () => openAccountEditor(this);
    this._closeAccountEditor = () => closeAccountEditor(this);
    this._onAccountSubmit = async (event) => onAccountSubmit(this, event);
    this._openAgentManager = () => openAgentManager(this);
    this._closeAgentManager = () => closeAgentManager(this);
    this._closeAgentEditor = () => closeAgentEditor(this);
    this._createAgent = () => createAgent(this);
    this._editAgent = (agent) => editAgent(this, agent);
    this._openTeamManager = () => openTeamManager(this);
    this._closeTeamManager = () => closeTeamManager(this);
    this._closeTeamEditor = () => closeTeamEditor(this);
    this._createTeam = () => createTeam(this);
    this._editTeam = (team) => editTeam(this, team);
    this._onTeamFormSubmit = async (event) => onTeamFormSubmit(this, event);
    this._deleteTeam = async (teamID) => deleteTeam(this, teamID);
    this._selectAgentProvider = (pluginID) => selectAgentProvider(this, pluginID);
    this._syncAgentField = (field, value) => syncAgentField(this, field, value);
    this._onAgentFormSubmit = async (event) => onAgentFormSubmit(this, event);
    this._buildAgentDeleteButton = () => buildAgentDeleteButton(this);
    this._deleteAgent = async (agentID) => deleteAgent(this, agentID);
    this._toggleAgentCrown = async (agent) => toggleAgentCrown(this, agent);
    this._reconcileMasters = (masters) => reconcileMasters(this, masters);
    this._setAgentCrownBusy = (agentID, busy) => setAgentCrownBusy(this, agentID, busy);
    this._repaintAgentCrowns = () => repaintAgentCrowns(this);
    this._syncAgentStatusText = () => syncAgentStatusText(this);
    this._secretPlaceholder = (fieldName) => secretPlaceholder(this, fieldName);
    this._setAgentFilter = (filter) => setAgentFilter(this, filter);
    this._agentProviderLabel = (agent) => agentProviderLabel(this, agent);
    this._createSession = async () => createSession(this);
    this._openSessionEditor = (event, session) => openSessionEditor(this, event, session);
    this._closeSessionEditor = () => closeSessionEditor(this);
    this._onSessionEditSubmit = async (event) => onSessionEditSubmit(this, event);
    this._selectSession = async (sessionID) => selectSession(this, sessionID);
    this._selectedSession = () => getSelectedSession(this._state);
    this._minimizeCurrent = () => minimizeCurrent(this);
    this._syncSelectedSessionToStack = () => syncSelectedSessionToStack(this);
    this._showSubSessions = async () => showSubSessions(this);
    this._expandCurrent = async () => expandCurrent(this);
    this._navigateToDepth = (depth) => navigateToDepth(this, depth);
    this._openSessionFromCard = async (sessionID) => openSessionFromCard(this, sessionID);
    this._threadChatViewElement = () => threadChatViewElement(this);
    this._setHeroName = (element) => setHeroName(this, element);
    this._clearHeroNames = () => clearHeroNames(this);
    this._stackFromCurrentURL = () => stackFromCurrentURL(this);
    this._applySessionDeepLink = async () => applySessionDeepLink(this);
    this._syncURLFromStack = (options = {}) => syncURLFromStack(this, options);
    this._syncFromURL = async () => syncFromURL(this);
    this._loadSessionPreviews = async () => loadSessionPreviews(this);
    this._getSessionPreviews = async (sessionIDs, previewCount) => getSessionPreviews(this, sessionIDs, previewCount);
    this._applyPreviewToGrid = (sessionID, preview) => applyPreviewToGrid(this, sessionID, preview);
    this._schedulePreviewRefresh = (sessionIDs) => schedulePreviewRefresh(this, sessionIDs);
    this._flushPreviewRefresh = async () => flushPreviewRefresh(this);
    this._captureRenderSnapshot = () => captureRenderSnapshot(this);
    this._afterRender = (snapshot = {}) => afterRender(this, snapshot);
    this._requestRender = () => requestRender(this);
    this._clearComposerDraft = () => clearComposerDraft(this);
    this._restoreComposerDraftOnFailure = (submittedDraft) => restoreComposerDraftOnFailure(this, submittedDraft);
    this._syncSessionShell = () => syncSessionShell(this);
    this._syncFrameThread = (sessionID = this._state.selectedSessionID, options = {}) => syncFrameThread(this, sessionID, options);
    this._cleanupReactiveBindings = (root = this) => cleanupReactiveBindings(this, root);
    this._connectFrameListObserver = () => connectFrameListObserver(this);
    this._disconnectFrameListObserver = () => disconnectFrameListObserver(this);
    this._isFrameListNearBottom = (frameList = this.querySelector('.kikx-frame-list')) => isFrameListNearBottom(this, frameList);
    this._scrollFramesToBottom = () => scrollFramesToBottom(this);
    this._scheduleAnchoredFrameScroll = () => scheduleAnchoredFrameScroll(this);
    this._scrollFramesToBottomImmediate = (frameList = this.querySelector('.kikx-frame-list')) => scrollFramesToBottomImmediate(this, frameList);
    this._restoreFrameListScroll = (snapshot = {}) => restoreFrameListScroll(this, snapshot);
    this._onFrameContentResize = () => onFrameContentResize(this);
    this._onFrameListScroll = (event) => onFrameListScroll(this, event);
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
}

if (!customElements.get('kikx-app'))
  customElements.define('kikx-app', KikxApp);
