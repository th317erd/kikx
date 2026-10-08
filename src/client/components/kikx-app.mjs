'use strict';

import {
  getSelectedSession,
  kikxState,
} from '../state/kikx-state.mjs';
import { applyAgentConfigValues } from '../state/agent-state-utils.mjs';
import { createComposerHistoryState } from './composer-history.mjs';
import './kikx-frame-item.mjs';
import './kikx-chat-view.mjs';
import './kikx-session-grid.mjs';
import { installGlobalErrorCapture, uninstallGlobalErrorCapture } from '../lib/error-boundary.mjs';
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
  renderAppShell,
  scopeNoun,
} from './kikx-shell-builders.mjs';
import {
  buildAccountEditor,
  buildAgentDeleteButton,
  buildAgentEditor,
  buildAgentManager,
  buildAgentManagerBody,
  buildSessionEditor,
  buildTeamEditor,
  buildTeamManager,
  agentProviderLabel,
  teamMemberSummary,
} from './kikx-modals.mjs';
import {
  apiHeaders,
  deleteJSON,
  deleteSession,
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
  loadNewerFrames,
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
  noteRuntimeEvent,
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
  pruneMissingSessionsFromStack,
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
  reconcileCompactionBots,
  reconcileMasters,
  repaintAgentCompactionBots,
  repaintAgentCrowns,
  repaintAgentManagerBody,
  selectAgentProvider,
  setAgentCompactionBotBusy,
  setAgentCrownBusy,
  setAgentFilter,
  syncAgentStatusText,
  toggleAgentCompactionBot,
  toggleAgentCrown,
} from './kikx-agent-controller.mjs';
import { onMagicLinkSubmit, verifyMagicLink } from './kikx-auth.mjs';

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
    this._runtimeReconcileScheduled = false;
    this._composerHistory = createComposerHistoryState();
    this._pendingPreviewSessionIDs = new Set();
    this._previewRefreshScheduled = false;
    this._deletingSessionIDs = new Set();
    this._pendingCrownAgentIDs = new Set();
    this._pendingCompactionBotAgentIDs = new Set();
    this._installGlobalErrorCapture = () => installGlobalErrorCapture(this);
    this._uninstallGlobalErrorCapture = () => uninstallGlobalErrorCapture(this);

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
    this._onRuntimeEventsError = (event) => onRuntimeEventsError(this, event);
    this._onRuntimeEvent = (event) => onRuntimeEvent(this, event);
    // Any event, handled or not, proves the stream is alive.
    this._runtimeEventsDispatch = (event) => {
      noteRuntimeEvent(this);
      onRuntimeEvent(this, event);
    };
    this._queueFrameRuntimeEvent = (data) => queueFrameRuntimeEvent(this, data);
    this._flushFrameRuntimeEvents = () => flushFrameRuntimeEvents(this);
    this._loadSessions = async () => loadSessions(this);
    this._loadAgents = async () => loadAgents(this);
    this._loadTeams = async () => loadTeams(this);
    this._loadClientComponents = async () => loadClientComponents(this);
    this._loadFrames = async (sessionID, options = {}) => loadFrames(this, sessionID, options);
    this._loadOlderFrames = async (sessionID = this._state.selectedSessionID) => loadOlderFrames(this, sessionID);
    this._loadNewerFrames = async (sessionID = this._state.selectedSessionID) => loadNewerFrames(this, sessionID);
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
    this._applyAgentConfigValues = (values) => applyAgentConfigValues(this._state, values);
    this._onAgentFormSubmit = async (event) => onAgentFormSubmit(this, event);
    this._buildAgentDeleteButton = () => buildAgentDeleteButton(this);
    this._deleteAgent = async (agentID) => deleteAgent(this, agentID);
    this._toggleAgentCrown = async (agent) => toggleAgentCrown(this, agent);
    this._reconcileMasters = (masters) => reconcileMasters(this, masters);
    this._setAgentCrownBusy = (agentID, busy) => setAgentCrownBusy(this, agentID, busy);
    this._repaintAgentCrowns = () => repaintAgentCrowns(this);
    this._toggleAgentCompactionBot = async (agent) => toggleAgentCompactionBot(this, agent);
    this._reconcileCompactionBots = (compactionBots) => reconcileCompactionBots(this, compactionBots);
    this._setAgentCompactionBotBusy = (agentID, busy) => setAgentCompactionBotBusy(this, agentID, busy);
    this._repaintAgentCompactionBots = () => repaintAgentCompactionBots(this);
    this._syncAgentStatusText = () => syncAgentStatusText(this);
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

  // Soft-delete a session from its card. The pending set lives on the app, not
  // the rebuilt grid, so it survives a full re-render; a second hold/click for
  // the same id is ignored while the request is in flight, and the flag is
  // cleared on both success and failure.
  async _deleteSession(sessionID) {
    if (!sessionID || this._deletingSessionIDs.has(sessionID))
      return;

    this._deletingSessionIDs.add(sessionID);
    this._state.status = 'Deleting session...';
    this._state.statusKind = 'pending';
    // Paint the pending card (dimmed, toolbar locked, delete disabled) before the
    // request resolves; without this render the pending flag is set and cleared
    // within the same tick and the user never sees that state at all.
    this._render();

    try {
      await deleteSession(this, sessionID);
      // The session is gone from state, so drop it (and anything nested under
      // it) from the window stack and the URL before the final render.
      pruneMissingSessionsFromStack(this);
      this._state.status = 'Session deleted';
      this._state.statusKind = 'ready';
    } catch (error) {
      this._state.status = error.message;
      this._state.statusKind = 'error';
    } finally {
      this._deletingSessionIDs.delete(sessionID);
      this._render();
    }
  }

  connectedCallback() {
    // Global capture is idempotent per app and is torn down on every disconnect,
    // so (re)install it before the mount guard: a disconnect -> reconnect cycle
    // must not lose `window.onerror` / `unhandledrejection` capture.
    this._installGlobalErrorCapture();

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
    renderAppShell(this);
  }

  disconnectedCallback() {
    this._uninstallGlobalErrorCapture();
    this._disconnectRuntimeEvents();
    this._disconnectFrameListObserver();
    this._cleanupReactiveBindings();
  }
}

if (!customElements.get('kikx-app'))
  customElements.define('kikx-app', KikxApp);
