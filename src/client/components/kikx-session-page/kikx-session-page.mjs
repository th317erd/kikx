'use strict';

import { t } from '../../lib/i18n.mjs';
import { BASE_PATH, API_BASE_URL } from '../../lib/config.mjs';
import { navigate } from '../../lib/router.mjs';
import { getAgents, createAgent, createSession, getOrCreateDm, getMe, getSession, getFrames, getSessions, sendMessage, approvePermission, cancelInteraction, updateFrameContent, persistAuth, getAuthToken, getCost, markSessionRead } from '../../lib/api.mjs';
import { agents, sessions, profile, connection } from '../../lib/store.mjs';
import { estimateCost } from '../../lib/cost.mjs';
import { FrameManager } from 'kikx/shared/frame-manager/frame-manager.mjs';
import * as debug from '../../lib/debug.mjs';

const TEMPLATE_HTML = `
  <style>
    kikx-session-page {
      display: grid;
      grid-template-areas:
        "topbar  topbar"
        "chat    sidebar"
        "input   sidebar"
        "statusbar statusbar";
      grid-template-columns: 1fr auto;
      grid-template-rows: auto 1fr auto auto;
      height: 100vh;
      overflow: hidden;
      background:
        radial-gradient(ellipse at 15% 85%, rgba(176, 64, 255, 0.08) 0%, transparent 50%),
        radial-gradient(ellipse at 85% 15%, rgba(0, 229, 255, 0.06) 0%, transparent 50%),
        radial-gradient(ellipse at 50% 50%, rgba(255, 64, 129, 0.03) 0%, transparent 60%),
        var(--background-base, #0a0a1a);
      color: var(--text-primary, #e8e8f0);
    }

    kikx-session-page kikx-top-bar {
      grid-area: topbar;
    }

    kikx-session-page .chat-area {
      grid-area: chat;
      position: relative;
      overflow: hidden;
    }

    kikx-session-page kikx-chat-view {
      width: 100%;
      height: 100%;
      overflow: hidden;
    }

    kikx-session-page kikx-message-input {
      grid-area: input;
    }

    kikx-session-page kikx-message-input.hidden {
      display: none;
    }

    kikx-session-page kikx-sidebar {
      grid-area: sidebar;
      width: 300px;
    }

    kikx-session-page kikx-status-bar {
      grid-area: statusbar;
    }

    kikx-session-page .typing-indicator {
      display: flex;
      gap: 4px;
      padding: 8px 4px;
    }

    kikx-session-page .typing-indicator span {
      width: 6px;
      height: 6px;
      background: var(--text-muted, #606078);
      border-radius: 50%;
      animation: typing 1.4s infinite ease-in-out;
    }

    kikx-session-page .typing-indicator span:nth-child(2) { animation-delay: 0.2s; }
    kikx-session-page .typing-indicator span:nth-child(3) { animation-delay: 0.4s; }

    @keyframes typing {
      0%, 60%, 100% { transform: translateY(0); }
      30% { transform: translateY(-4px); }
    }
  </style>

  <kikx-top-bar></kikx-top-bar>
  <div class="chat-area">
    <kikx-chat-view></kikx-chat-view>
    <kikx-scroll-anchor hidden></kikx-scroll-anchor>
  </div>
  <kikx-message-input class="hidden"></kikx-message-input>
  <kikx-sidebar></kikx-sidebar>
  <kikx-status-bar></kikx-status-bar>

  <kikx-modal class="friend-modal">
    <kikx-add-friend-modal></kikx-add-friend-modal>
  </kikx-modal>
  <kikx-modal class="session-modal">
    <kikx-create-session-modal></kikx-create-session-modal>
  </kikx-modal>
`;

let cachedTemplate = null;

function getTemplate() {
  if (!cachedTemplate) {
    cachedTemplate = document.createElement('template');
    cachedTemplate.innerHTML = TEMPLATE_HTML;
  }

  return cachedTemplate;
}

function formatTimestamp(isoStringOrEpoch) {
  if (!isoStringOrEpoch && isoStringOrEpoch !== 0)
    return '';

  let date = (typeof isoStringOrEpoch === 'number')
    ? new Date(isoStringOrEpoch)
    : new Date(isoStringOrEpoch);

  if (isNaN(date.getTime()))
    return '';

  let now  = Date.now();
  let diff = now - date.getTime();

  if (diff < 60_000)
    return t('chat.timestamp.justNow') || 'just now';

  if (diff < 3_600_000)
    return (t('chat.timestamp.minutesAgo') || '{n}m ago').replace('{n}', String(Math.floor(diff / 60_000)));

  if (diff < 86_400_000)
    return (t('chat.timestamp.hoursAgo') || '{n}h ago').replace('{n}', String(Math.floor(diff / 3_600_000)));

  if (diff < 604_800_000)
    return (t('chat.timestamp.daysAgo') || '{n}d ago').replace('{n}', String(Math.floor(diff / 86_400_000)));

  // Fallback to absolute date for older messages
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function getInitials(name) {
  if (!name)
    return '?';

  // Split on whitespace, hyphens, or underscores to handle names like "test-claude"
  let parts = name.trim().split(/[\s_-]+/).filter(Boolean);
  if (parts.length >= 2)
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();

  return parts[0].substring(0, 2).toUpperCase();
}

// ---------------------------------------------------------------------------
// Pure DOM utilities
// ---------------------------------------------------------------------------

function escapeHTML(text) {
  let div = document.createElement('div');
  div.textContent = text;

  return div.innerHTML;
}

// Frame types that are internal plumbing — never rendered in the DOM
const HIDDEN_TYPES = new Set([
  'pending-action',
  'tool-call',
  'tool-result',
  'tool-error',
  'hook-blocked',
  'permission-denied',
  'participant-joined',
  'participant-left',
  // Note: 'tool-activity' is NOT hidden — it's in RENDERABLE_TYPES
]);

// Frame types that produce visible DOM elements
const RENDERABLE_TYPES = new Set([
  'message',
  'user-message',
  'permission-request',
  'session-link',
  'command-result',
  'error',
  'reflection',
  'tool-activity',
  'compaction',
]);

// ---------------------------------------------------------------------------
// createFrameElement(frame) — Pure DOM factory
// ---------------------------------------------------------------------------
// Takes a frame object, returns an HTMLElement (kikx-interaction) or null.
// No placement, no side effects, no options flags.
// ---------------------------------------------------------------------------

export function createFrameElement(frame) {
  if (frame == null || typeof frame !== 'object')
    return null;

  if (!frame.type || !frame.content)
    return null;

  if (HIDDEN_TYPES.has(frame.type))
    return null;

  if (!RENDERABLE_TYPES.has(frame.type))
    return null;

  // Compaction frames render as a standalone divider — no interaction wrapper
  if (frame.type === 'compaction') {
    let compaction = document.createElement('kikx-compaction-frame');

    if (frame.id)
      compaction.setAttribute('data-frame-id', frame.id);

    compaction.setAttribute('frame-id', frame.id || '');

    if (frame.sessionID)
      compaction.setAttribute('session-id', frame.sessionID);

    let content = frame.content || {};

    compaction.setAttribute('status', content.status || 'started');

    if (content.startedAt)
      compaction.setAttribute('started-at', content.startedAt);

    if (content.framesCompacted != null)
      compaction.setAttribute('frames-compacted', String(content.framesCompacted));

    if (content.compactorAgentID)
      compaction.setAttribute('compactor-name', content.compactorAgentID);

    return compaction;
  }

  let isUser    = (frame.type === 'user-message') || (frame.authorType === 'user');
  let alignment;

  if (frame.type === 'session-link')
    alignment = 'system';
  else if (frame.authorType === 'system')
    alignment = 'agent';
  else if (isUser)
    alignment = 'user';
  else
    alignment = 'agent';

  let name;

  if (isUser)
    name = 'You';
  else if (frame.type === 'session-link' || frame.type === 'command-result' || frame.authorType === 'system')
    name = 'System';
  else if (frame.authorType === 'agent' && frame.authorID)
    name = frame.authorName || agents.getAgent(frame.authorID)?.name || 'Agent';
  else
    name = frame.authorName || 'Agent';

  let interaction = document.createElement('kikx-interaction');
  interaction.setAttribute('alignment', alignment);
  interaction.setAttribute('participant-name', name);
  interaction.setAttribute('participant-initials', getInitials(name));
  interaction.setAttribute('timestamp', formatTimestamp(frame.createdAt || frame.timestamp || Date.now()));
  interaction.setAttribute('data-interaction-id', frame.interactionID || frame.id || '');

  if (frame.id)
    interaction.setAttribute('data-frame-id', frame.id);

  if (frame.authorID)
    interaction.setAttribute('data-author-id', frame.authorID);

  if (frame.authorType)
    interaction.setAttribute('data-author-type', frame.authorType);

  switch (frame.type) {
    case 'session-link': {
      let content     = frame.content || {};
      let sessionLink = document.createElement('kikx-session-link');

      sessionLink.setAttribute('target-session-id', content.targetSessionID || '');
      sessionLink.setAttribute('session-title', content.title || 'Sub-session');

      if (content.participants && content.participants.length > 0)
        sessionLink.setAttribute('participant-count', String(content.participants.length));

      interaction.appendChild(sessionLink);
      break;
    }

    case 'permission-request': {
      interaction.setAttribute('bubble-type', 'permission');

      let permRequest = document.createElement('kikx-permission-request');
      permRequest.setAttribute('permission-id', frame.id || '');

      let parsedCommands = frame.content && frame.content.parsedCommands;
      if (parsedCommands && parsedCommands.length > 0) {
        let descriptionTemplate = t('permission.wantsToExecute') || '{name} wants to execute:';
        permRequest.description = descriptionTemplate.replace('{name}', name);

        let fullCommandString = frame.content.arguments && frame.content.arguments.command;
        if (fullCommandString)
          permRequest.fullCommand = fullCommandString;

        permRequest.commands = parsedCommands;
      } else {
        let toolName            = (frame.content && frame.content.toolName) || 'unknown';
        let descriptionTemplate = t('permission.wantsToUse') || '{name} wants to use:';
        permRequest.description = descriptionTemplate.replace('{name}', name);

        let toolArgs = frame.content && frame.content.arguments;
        if (toolArgs) {
          try {
            // Strip internal properties (prefixed with _) from display
            let displayArgs = {};
            for (let key of Object.keys(toolArgs)) {
              if (!key.startsWith('_'))
                displayArgs[key] = toolArgs[key];
            }

            let argKeys = Object.keys(displayArgs);
            if (argKeys.length > 0)
              permRequest.toolArgs = JSON.stringify(displayArgs, null, 2);
          } catch (_e) {
            // Ignore serialization errors
          }
        }

        permRequest.commands = [{ command: toolName, arguments: [], status: 'needs-approval' }];
      }

      if (frame.processed) {
        let storedDecision = frame.content && frame.content.decision;
        if (storedDecision)
          permRequest.resolvedDecision = storedDecision;

        permRequest.setAttribute('processed', '');
      }

      interaction.appendChild(permRequest);
      break;
    }

    case 'command-result': {
      let messageContent = document.createElement('kikx-message-content');
      messageContent.content = (frame.content && frame.content.html) || '';

      interaction.appendChild(messageContent);
      break;
    }

    case 'error': {
      interaction.setAttribute('bubble-type', 'error');

      let messageContent = document.createElement('kikx-message-content');
      let errorMsg       = (frame.content && frame.content.message) || 'An error occurred';
      messageContent.content = `<p style="color: var(--error-color, #ff4444);">Error: ${errorMsg}</p>`;

      interaction.appendChild(messageContent);
      break;
    }

    case 'reflection': {
      let reflectionBlock = document.createElement('kikx-reflection-block');
      reflectionBlock.content = (frame.content && frame.content.text) || '';
      reflectionBlock.setAttribute('complete', '');

      interaction.appendChild(reflectionBlock);
      break;
    }

    case 'tool-activity': {
      let activityContent = frame.content || {};
      let renderType      = activityContent.renderType;
      let renderData      = activityContent.renderData || {};

      if (renderType === 'file-read') {
        let fileRead = document.createElement('kikx-file-read');
        fileRead.setAttribute('file-path', renderData.filePath || '');

        if (renderData.language)
          fileRead.setAttribute('language', renderData.language);

        fileRead.fileContent = renderData.content || '';
        fileRead.lineCount   = renderData.lineCount || 0;
        fileRead.totalLines  = renderData.totalLines || 0;
        fileRead.offset      = renderData.offset || 0;

        interaction.appendChild(fileRead);
      } else if (renderType === 'file-write') {
        let fileWrite = document.createElement('kikx-file-write');
        fileWrite.setAttribute('file-path', renderData.filePath || '');

        if (renderData.created)
          fileWrite.setAttribute('created', '');

        fileWrite.diff = renderData.diff || null;

        interaction.appendChild(fileWrite);
      } else {
        // Fallback: render unknown tool-activity as a command-result
        let commandResult = document.createElement('kikx-command-result');
        commandResult.setAttribute('command-name', activityContent.toolName || 'tool');
        commandResult.setAttribute('status', 'success');
        commandResult.result = JSON.stringify(renderData, null, 2);

        interaction.appendChild(commandResult);
      }

      break;
    }

    case 'message':
    case 'user-message': {
      let html    = '';
      let content = frame.content;

      if (content && typeof content === 'object') {
        if (content.html)
          html = content.html;
        else if (content.text)
          html = `<p>${escapeHTML(content.text)}</p>`;
      } else if (typeof content === 'string') {
        html = content;
      }

      let messageContent = document.createElement('kikx-message-content');
      messageContent.content = html;

      interaction.appendChild(messageContent);
      break;
    }
  }

  return interaction;
}

// ---------------------------------------------------------------------------
// setupFrameRendering(frameManager, container) — Event wiring
// ---------------------------------------------------------------------------
// Wires FrameManager events to DOM operations. Returns a cleanup function.
// frame:added  → create element, insert at ordered position
// frame:updated → find element, patch content in place
// ---------------------------------------------------------------------------

export function setupFrameRendering(frameManager, container) {
  function onFrameAdded({ frame }) {
    // Dedup: skip if element already exists in the DOM
    if (frame.id && container.querySelector(`[data-frame-id="${frame.id}"]`))
      return;

    // For user-message frames, check for ghost element to adopt
    if (frame.type === 'user-message' || frame.authorType === 'user') {
      let ghosts = container.querySelectorAll('kikx-interaction[alignment="user"]:not([data-frame-id])');
      let ghost  = (ghosts.length > 0) ? ghosts[ghosts.length - 1] : null;

      if (ghost && ghost.classList.contains('pending')) {
        ghost.setAttribute('data-frame-id', frame.id);
        ghost.setAttribute('data-interaction-id', frame.interactionID || frame.id);
        ghost.classList.remove('pending');

        return;
      }
    }

    let el = createFrameElement(frame);
    if (!el)
      return;

    // Store order for position-based insertion
    el.setAttribute('data-frame-order', String(frame.order));

    // Find insertion point based on order
    let inserted = false;
    let children = container.querySelectorAll('[data-frame-order]');

    for (let child of children) {
      let childOrder = parseInt(child.getAttribute('data-frame-order'), 10);

      if (frame.order < childOrder) {
        // Preserve scroll position when inserting above viewport
        let scrollBefore = container.scrollTop;
        let heightBefore = container.scrollHeight;

        container.insertBefore(el, child);

        let heightAfter = container.scrollHeight;
        if (container.scrollTop > 0)
          container.scrollTop = scrollBefore + (heightAfter - heightBefore);

        inserted = true;
        break;
      }
    }

    if (!inserted)
      container.appendChild(el);
  }

  function onFrameUpdated({ frame }) {
    if (!frame || !frame.id)
      return;

    let existing = container.querySelector(`[data-frame-id="${frame.id}"]`);
    if (!existing)
      return;

    // Patch message content
    let messageContent = existing.querySelector('kikx-message-content');
    if (messageContent && frame.content) {
      let html = '';

      if (frame.content.html)
        html = frame.content.html;
      else if (frame.content.text)
        html = `<p>${escapeHTML(frame.content.text)}</p>`;

      if (html)
        messageContent.content = html;
    }

    // Patch reflection content
    let reflectionBlock = existing.querySelector('kikx-reflection-block');
    if (reflectionBlock && frame.content && frame.content.text) {
      reflectionBlock.content = frame.content.text;
      reflectionBlock.setAttribute('complete', '');
    }
  }

  frameManager.on('frame:added', onFrameAdded);
  frameManager.on('frame:updated', onFrameUpdated);

  return function cleanup() {
    frameManager.off('frame:added', onFrameAdded);
    frameManager.off('frame:updated', onFrameUpdated);
  };
}

// ---------------------------------------------------------------------------
// KikxSessionPage component
// ---------------------------------------------------------------------------

class KikxSessionPage extends HTMLElement {
  static get observedAttributes() { return ['data-id']; }

  attributeChangedCallback(name, oldValue, newValue) {
    if (name === 'data-id' && oldValue !== newValue)
      this._updateSessionView();
  }

  constructor() {
    super();

    this._currentSession    = null;
    this._eventSource       = null;
    this._frameManager      = null;
    this._oldestLoadedOrder = 0;
    this._loadingOlder      = false;
    this._emptyStateElement = null;

    // Streaming state — phantom frames through FrameManager
    // Map<agentID, DOM element> — ephemeral typing indicators
    this._typingIndicators = new Map();
    // Map<agentID, { groupID, html, reflectionText, agentID }> — active streaming groups
    this._streamingGroups = new Map();
    // Map<relayKey, { interaction, content, html }> — cross-session relay streams
    this._relayStreams = new Map();
    // Active interaction counter — tracks how many agents are currently interacting.
    // Used instead of a boolean so concurrent agents don't prematurely clear state.
    this._activeInteractionCount = 0;

    // SSE reconnection state
    this._sseReconnectAttempts = 0;
    this._sseReconnectTimer   = null;
    this._sseSessionID        = null;

    this._onAddFriend       = this._onAddFriend.bind(this);
    this._onNearTop         = this._onNearTop.bind(this);
    this._onAddSession      = this._onAddSession.bind(this);
    this._onFriendSave      = this._onFriendSave.bind(this);
    this._onFriendCancel    = this._onFriendCancel.bind(this);
    this._onSessionCreate   = this._onSessionCreate.bind(this);
    this._onSessionCancel   = this._onSessionCancel.bind(this);
    this._onModalClose      = this._onModalClose.bind(this);
    this._onSelectFriend    = this._onSelectFriend.bind(this);
    this._onSendMessage     = this._onSendMessage.bind(this);
    this._onAnchoredChange  = this._onAnchoredChange.bind(this);
    this._onJumpToBottom    = this._onJumpToBottom.bind(this);
    this._onQueueChange          = this._onQueueChange.bind(this);
    this._onPermissionResponse   = this._onPermissionResponse.bind(this);
    this._onCancelInteraction    = this._onCancelInteraction.bind(this);
    this._onInteractionSubmit    = this._onInteractionSubmit.bind(this);
    this._onInteractionIgnore    = this._onInteractionIgnore.bind(this);
    this._onSelectSession        = this._onSelectSession.bind(this);
    this._onReplyToMessage       = this._onReplyToMessage.bind(this);
  }

  connectedCallback() {
    this.appendChild(getTemplate().content.cloneNode(true));

    this._topBar             = this.querySelector('kikx-top-bar');
    this._chatView           = this.querySelector('kikx-chat-view');
    this._messageInput       = this.querySelector('kikx-message-input');
    this._sidebar            = this.querySelector('kikx-sidebar');
    this._scrollAnchor       = this.querySelector('kikx-scroll-anchor');
    this._friendModal        = this.querySelector('.friend-modal');
    this._sessionModal       = this.querySelector('.session-modal');
    this._addFriendWizard    = this.querySelector('kikx-add-friend-modal');
    this._createSessionModal = this.querySelector('kikx-create-session-modal');

    // Set modal titles
    this._friendModal.setAttribute('modal-title', t('friends.wizard.title'));
    this._sessionModal.setAttribute('modal-title', t('session.create.title'));

    // Update view based on session presence
    this._updateSessionView();

    // Event listeners
    this.addEventListener('add-friend', this._onAddFriend);
    this.addEventListener('add-session', this._onAddSession);
    this.addEventListener('friend-save', this._onFriendSave);
    this.addEventListener('friend-cancel', this._onFriendCancel);
    this.addEventListener('session-create', this._onSessionCreate);
    this.addEventListener('session-cancel', this._onSessionCancel);
    this.addEventListener('modal-close', this._onModalClose);
    this.addEventListener('select-friend', this._onSelectFriend);
    this.addEventListener('send-message', this._onSendMessage);
    this.addEventListener('anchored-change', this._onAnchoredChange);
    this.addEventListener('jump-to-bottom', this._onJumpToBottom);
    this.addEventListener('near-top', this._onNearTop);
    this.addEventListener('queue-change', this._onQueueChange);
    this.addEventListener('permission-response', this._onPermissionResponse);
    this.addEventListener('cancel-interaction', this._onCancelInteraction);
    this.addEventListener('interaction-submit', this._onInteractionSubmit);
    this.addEventListener('interaction-ignore', this._onInteractionIgnore);
    this.addEventListener('select-session', this._onSelectSession);
    this.addEventListener('reply-to-message', this._onReplyToMessage);

    this._loadInitialData();
  }

  disconnectedCallback() {
    this.removeEventListener('add-friend', this._onAddFriend);
    this.removeEventListener('add-session', this._onAddSession);
    this.removeEventListener('friend-save', this._onFriendSave);
    this.removeEventListener('friend-cancel', this._onFriendCancel);
    this.removeEventListener('session-create', this._onSessionCreate);
    this.removeEventListener('session-cancel', this._onSessionCancel);
    this.removeEventListener('modal-close', this._onModalClose);
    this.removeEventListener('select-friend', this._onSelectFriend);
    this.removeEventListener('send-message', this._onSendMessage);
    this.removeEventListener('anchored-change', this._onAnchoredChange);
    this.removeEventListener('jump-to-bottom', this._onJumpToBottom);
    this.removeEventListener('near-top', this._onNearTop);
    this.removeEventListener('queue-change', this._onQueueChange);
    this.removeEventListener('permission-response', this._onPermissionResponse);
    this.removeEventListener('cancel-interaction', this._onCancelInteraction);
    this.removeEventListener('interaction-submit', this._onInteractionSubmit);
    this.removeEventListener('interaction-ignore', this._onInteractionIgnore);
    this.removeEventListener('select-session', this._onSelectSession);
    this.removeEventListener('reply-to-message', this._onReplyToMessage);

    this._disconnectStream();
    this._destroyFrameManager();
  }

  get sessionID() {
    return this.getAttribute('data-id');
  }

  // ---------------------------------------------------------------------------
  // Session view update (top bar + input visibility + session fetch + SSE)
  // ---------------------------------------------------------------------------

  _updateSessionView() {
    // Guard: DOM refs not yet available (attributeChangedCallback
    // fires before connectedCallback). connectedCallback will call us.
    if (!this._topBar)
      return;

    let sessionID = this.sessionID;

    if (sessionID) {
      // Clean up previous session if switching
      this._disconnectStream();
      this._destroyFrameManager();
      this._chatView.clear();
      this._emptyStateElement = null;

      // Reset interaction state — the SSE stream was aborted so
      // interaction:end will never arrive to clear these.
      this._activeInteractionCount = 0;
      if (this._messageInput)
        this._messageInput.resetInteractionState();

      let statusBar = this.querySelector('kikx-status-bar');
      if (statusBar)
        statusBar.setInteracting(false);

      this._typingIndicators.clear();
      this._streamingGroups.clear();

      this._topBar.removeAttribute('hide-back');

      // Use cached session name from the store to avoid flashing the raw ID
      let cached      = sessions.getSession(sessionID);
      let cachedName  = cached && cached.name;

      if (cachedName) {
        if (cachedName.startsWith('DM: '))
          cachedName = cachedName.slice(4);

        this._topBar.setAttribute('session-name', cachedName);
      } else {
        this._topBar.removeAttribute('session-name');
      }

      this._messageInput.classList.remove('hidden');
      this._messageInput.sessionID = sessionID;

      // Highlight the active session in the sidebar
      if (this._sidebar)
        this._sidebar.activeSessionID = sessionID;

      // Mark session as read and clear unread badge
      markSessionRead(sessionID)
        .then(() => {
          sessions.updateSession(sessionID, { unreadCount: 0 });
          this._updateSessionsList();
        })
        .catch((err) => console.error('Failed to mark session read:', err));

      // Create client-side FrameManager for this session
      this._initFrameManager();

      // Load session details first, then costs (costs need participant info)
      this._fetchSessionDetails(sessionID).then(() => this._loadCosts(sessionID));
      this._loadFrames(sessionID).then(() => this._connectStream(sessionID));
    } else {
      this._topBar.setAttribute('hide-back', '');
      this._topBar.removeAttribute('session-name');
      this._messageInput.classList.add('hidden');

      if (this._sidebar)
        this._sidebar.activeSessionID = null;

      this._disconnectStream();
      this._destroyFrameManager();
      this._currentSession = null;
    }
  }

  _initFrameManager() {
    this._destroyFrameManager();

    this._frameManager = new FrameManager({ history: false });

    // --- Ephemeral typing indicators via phantom frames ---
    this._frameManager.on('frame:phantom', ({ frame }) => {
      if (frame.type !== 'typing-indicator')
        return;

      let agentID = (frame.content && frame.content.agentID) || 'default';

      // Remove existing typing indicator for this agent
      let existing = this._typingIndicators.get(agentID);
      if (existing)
        existing.remove();

      let name = this._getAgentDisplayName(agentID !== 'default' ? agentID : null);

      let interaction = document.createElement('kikx-interaction');
      interaction.setAttribute('alignment', 'agent');
      interaction.setAttribute('participant-name', name);
      interaction.setAttribute('participant-initials', getInitials(name));
      interaction.setAttribute('timestamp', formatTimestamp(new Date().toISOString()));

      if (agentID !== 'default')
        interaction.setAttribute('data-agent-id', agentID);

      let dots = document.createElement('div');
      dots.className = 'typing-indicator';
      dots.innerHTML = '<span></span><span></span><span></span>';

      interaction.appendChild(dots);
      this._chatView.appendInteraction(interaction);

      this._typingIndicators.set(agentID, interaction);
    });

    // --- Event-driven rendering: frame:added → DOM projection ---
    this._frameManager.on('frame:added', ({ frame }) => {
      this._clearEmptyState();

      // --- Streaming finalization ---
      // When a commit frame arrives while we have a streaming group, adopt
      // the group frame's DOM element instead of creating a new one.
      if (frame.type === 'message') {
        let agentID = frame.authorID || null;
        let sg = null;

        // Find streaming group by agentID
        if (agentID)
          sg = this._streamingGroups.get(agentID);

        // Fallback: check all streaming groups for a match
        if (!sg) {
          for (let [, group] of this._streamingGroups) {
            if (group.groupID) {
              sg = group;
              break;
            }
          }
        }

        if (sg && sg.groupID) {
          let groupEl = this._chatView.querySelector(
            `[data-frame-id="${sg.groupID}"]`,
          );

          if (groupEl) {
            // Finalize: update content with server-rendered HTML
            let content = frame.content;
            let html    = '';

            if (content && typeof content === 'object') {
              if (content.html)
                html = content.html;
              else if (content.text)
                html = `<p>${escapeHTML(content.text)}</p>`;
            } else if (typeof content === 'string') {
              html = content;
            }

            let mc = groupEl.querySelector('kikx-message-content');
            if (mc && html)
              mc.content = html;

            // Switch data-frame-id from group ID to real frame ID
            groupEl.setAttribute('data-frame-id', frame.id);

            if (debug.isEnabled() && frame.interactionID) {
              debug.pushFrame(frame.interactionID, frame);
              debug.snapshotComposed(frame.interactionID);
            }

            // Clean up streaming group
            if (agentID)
              this._streamingGroups.delete(agentID);

            return;
          }
        }
      }

      // --- Reflection finalization ---
      if (frame.type === 'reflection') {
        // Find a streaming group that has this reflection's interaction
        for (let [agentID, sg] of this._streamingGroups) {
          if (!sg.groupID)
            continue;

          let groupEl = this._chatView.querySelector(
            `[data-frame-id="${sg.groupID}"]`,
          );

          if (groupEl) {
            let rb = groupEl.querySelector('kikx-reflection-block');
            if (rb) {
              rb.content = (frame.content && frame.content.text) || '';
              rb.setAttribute('complete', '');
              sg.reflectionText = '';
            }

            return;
          }
        }
      }

      // --- User-message optimistic adoption ---
      if (frame.type === 'user-message') {
        let allGhosts = this._chatView.querySelectorAll(
          'kikx-interaction[alignment="user"]:not([data-frame-id])',
        );
        let optimistic = allGhosts.length > 0 ? allGhosts[allGhosts.length - 1] : null;

        if (optimistic) {
          optimistic.setAttribute('data-frame-id', frame.id);
          optimistic.setAttribute('data-interaction-id', frame.interactionID || frame.id);
          optimistic.classList.remove('pending');

          if (frame.content && frame.content.html) {
            let messageContent = optimistic.querySelector('kikx-message-content');
            if (messageContent)
              messageContent.content = frame.content.html;
          }

          if (frame.parentID)
            this._updateReplyCount(frame.parentID);

          return;
        }
      }

      // --- Dedup: skip if element already exists in DOM ---
      if (frame.id) {
        let existing = this._chatView.querySelector(
          `[data-frame-id="${frame.id}"]`,
        );

        if (existing)
          return;
      }

      // --- Merge message into preceding reflection-only bubble ---
      // When a non-streaming message arrives right after a reflection from the
      // same agent, fold the message content into the existing reflection
      // interaction instead of creating a separate empty-looking bubble.
      if (frame.type === 'message' && frame.authorID) {
        let allInteractions = this._chatView.querySelectorAll('kikx-interaction');
        let lastInteraction = allInteractions.length > 0 ? allInteractions[allInteractions.length - 1] : null;
        if (lastInteraction) {
          let hasReflection = lastInteraction.querySelector('kikx-reflection-block');
          let hasMessage    = lastInteraction.querySelector('kikx-message-content');

          if (hasReflection && !hasMessage) {
            let lastAuthor = lastInteraction.getAttribute('data-author-id');
            if (lastAuthor === frame.authorID) {
              // Merge: update the existing interaction with the message content
              lastInteraction.setAttribute('data-frame-id', frame.id);

              let content = frame.content;
              let html    = '';

              if (content && typeof content === 'object') {
                if (content.html)
                  html = content.html;
                else if (content.text)
                  html = `<p>${escapeHTML(content.text)}</p>`;
              } else if (typeof content === 'string') {
                html = content;
              }

              if (html) {
                let mc = document.createElement('kikx-message-content');
                mc.content = html;
                lastInteraction.appendChild(mc);
              }

              return;
            }
          }
        }
      }

      // --- Create and append new element ---
      let el = createFrameElement(frame);
      if (!el)
        return;

      // For streaming group frames, set the correct agent display name
      for (let [, sg] of this._streamingGroups) {
        if (sg.groupID === frame.id) {
          let agentName = this._getAgentDisplayName(sg.agentID !== 'default' ? sg.agentID : null);
          el.setAttribute('participant-name', agentName);
          el.setAttribute('participant-initials', getInitials(agentName));
          break;
        }
      }

      // Thread: set reply context if this frame is a reply
      if (frame.parentID) {
        let preview = this._getParentPreview(frame.parentID);
        if (preview)
          el.setAttribute('parent-preview', preview);
      }

      this._chatView.appendInteraction(el);

      if (frame.parentID)
        this._updateReplyCount(frame.parentID);

      if (debug.isEnabled()) {
        debug.trackElement(frame.interactionID || frame.id, el);
        debug.pushFrame(frame.interactionID || frame.id, frame);
      }
    });

    // --- Event-driven rendering: frame:updated → patch DOM in place ---
    this._frameManager.on('frame:updated', ({ frame }) => {
      if (!this._chatView)
        return;

      let el = this._chatView.querySelector(
        `[data-frame-id="${frame.id}"]`,
      );

      if (!el)
        return;

      // Update message content
      if (frame.content && (frame.content.html || frame.content.text)) {
        let mc = el.querySelector('kikx-message-content');

        if (!mc) {
          mc = document.createElement('kikx-message-content');
          el.appendChild(mc);
        }

        let html = '';

        if (frame.content.html)
          html = frame.content.html;
        else if (frame.content.text)
          html = `<p>${escapeHTML(frame.content.text)}</p>`;

        if (html)
          mc.content = html;
      }

      // Update compaction frame attributes when status changes
      if (el.tagName && el.tagName.toLowerCase() === 'kikx-compaction-frame' && frame.content) {
        let content = frame.content;

        if (content.status)
          el.setAttribute('status', content.status);

        if (content.startedAt)
          el.setAttribute('started-at', content.startedAt);

        if (content.framesCompacted != null)
          el.setAttribute('frames-compacted', String(content.framesCompacted));

        if (content.compactorAgentID)
          el.setAttribute('compactor-name', content.compactorAgentID);

        return;
      }

      // Update reflection content (streaming reflections stored in group frame)
      if (frame.content && frame.content.reflectionText) {
        let rb = el.querySelector('kikx-reflection-block');

        if (!rb) {
          rb = document.createElement('kikx-reflection-block');
          let contentEl = el.querySelector('.content') || el;
          let mc = contentEl.querySelector('kikx-message-content');

          if (mc)
            contentEl.insertBefore(rb, mc);
          else
            contentEl.appendChild(rb);
        }

        rb.content = frame.content.reflectionText;
      }
    });
  }

  _destroyFrameManager() {
    if (this._frameManager) {
      this._frameManager.removeAllListeners();
      this._frameManager = null;
    }
  }

  async _loadCosts(sessionID) {
    try {
      // Determine serviceType from the session's agent if known
      let serviceType = null;
      let session     = this._currentSession;

      if (session && session.participants) {
        for (let p of session.participants) {
          if (p.agentID) {
            let agent = agents.getAgent(p.agentID);
            if (agent && agent.pluginID) {
              // Map pluginID to serviceType
              // Plugin IDs match registerAgentType() names (e.g. 'claude', not 'claude-agent')
              if (agent.pluginID === 'claude')
                serviceType = 'anthropic';
              else if (agent.pluginID === 'openai')
                serviceType = 'openai';
            }
            break;
          }
        }
      }

      let result = await getCost({ sessionID, serviceType });
      let data   = (result && result.data) ? result.data : result;

      let costs = {
        global:  data.global  ? estimateCost(data.global) : 0,
        service: data.service ? estimateCost(data.service) : 0,
        session: data.session ? estimateCost(data.session) : 0,
      };

      connection.updateCosts(costs);
    } catch (_error) {
      // Non-fatal — costs will update incrementally from SSE events
      connection.updateCosts({ global: 0, service: 0, session: 0 });
    }
  }

  async _fetchSessionDetails(sessionID) {
    try {
      let result  = await getSession(sessionID);
      let session = (result && result.data) ? result.data : result;

      if (session && session.session)
        session = session.session;

      this._currentSession = session;

      let displayName = session.name || sessionID;

      // For DM sessions, show the agent name without "DM: " prefix
      if (displayName.startsWith('DM: '))
        displayName = displayName.slice(4);

      this._topBar.setAttribute('session-name', displayName);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Failed to fetch session details:', error);
    }
  }

  async _loadFrames(sessionID) {
    try {
      let result = await getFrames(sessionID);
      let data   = (result && result.data) || {};
      let frames = Array.isArray(data) ? data : (data.frames || []);

      if (this._frameManager) {
        // Track oldest DB-level order for scroll-up pagination
        // (FrameManager reassigns orders internally, so use raw API data)
        if (frames.length > 0) {
          let minOrder = Infinity;
          for (let i = 0; i < frames.length; i++) {
            if (frames[i].order < minOrder)
              minOrder = frames[i].order;
          }

          this._oldestLoadedOrder = minOrder;
        }

        // Batch initial load: merge WITHOUT events, then render all frames
        // in a single DocumentFragment append (avoids 100+ individual layout
        // recalculations for large sessions).
        this._frameManager.loadWindow(frames);
        this._frameManager.syncOrderCounter(this._frameManager.getWindowBounds().to);

        let fragment   = document.createDocumentFragment();
        let allFrames  = this._frameManager.toArray();

        for (let i = 0; i < allFrames.length; i++) {
          let frame = allFrames[i];

          // Merge reflection frames into the next message from the same agent
          // instead of rendering them as standalone empty bubbles.
          if (frame.type === 'reflection') {
            let next = allFrames[i + 1];
            if (next && next.authorID === frame.authorID && (next.type === 'message' || next.type === 'user-message'))
              continue; // will be merged when the next frame is processed
          }

          let el = createFrameElement(frame);

          if (!el)
            continue;

          // If the preceding frame was a reflection from the same agent,
          // prepend its reflection block into this message's interaction.
          if ((frame.type === 'message' || frame.type === 'user-message') && i > 0) {
            let prev = allFrames[i - 1];
            if (prev && prev.type === 'reflection' && prev.authorID === frame.authorID) {
              let rb = document.createElement('kikx-reflection-block');
              rb.content = (prev.content && prev.content.text) || '';
              rb.setAttribute('complete', '');

              // Prepend before existing children so reflection appears above message
              el.insertBefore(rb, el.firstChild);
            }
          }

          // Thread: set reply context if this frame is a reply
          if (frame.parentID) {
            let preview = this._getParentPreview(frame.parentID);
            if (preview)
              el.setAttribute('parent-preview', preview);
          }

          if (debug.isEnabled()) {
            debug.trackElement(frame.interactionID || frame.id, el);
            debug.pushFrame(frame.interactionID || frame.id, frame);
          }

          fragment.appendChild(el);
        }

        if (fragment.childNodes.length > 0)
          this._chatView.appendInteraction(fragment);
        else
          this._showEmptyState();

        // Resolve agent names if agents were loaded before frames
        this._refreshAgentNames();
      }
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Failed to load frames:', error);
    }
  }

  // ---------------------------------------------------------------------------
  // Viewport management — scroll-up pagination
  // ---------------------------------------------------------------------------

  _onNearTop() {
    if (!this._loadingOlder && this._oldestLoadedOrder > 0)
      this._loadOlderFrames();
  }

  async _loadOlderFrames() {
    let sessionID = this.sessionID;
    if (!sessionID || !this._frameManager)
      return;

    this._loadingOlder = true;

    try {
      let result = await getFrames(sessionID, {
        beforeOrder: this._oldestLoadedOrder,
        limit:       50,
      });

      let data   = (result && result.data) || {};
      let frames = Array.isArray(data) ? data : (data.frames || []);

      if (frames.length === 0) {
        // No more older frames — stop requesting
        this._oldestLoadedOrder = 0;
        return;
      }

      // Load into FrameManager without events (older frames get higher
      // FrameManager orders, which would place them at the bottom if we
      // used events; we need them at the top).
      this._frameManager.loadWindow(frames);

      // Update oldest DB-level order from raw API data
      let minOrder = Infinity;
      for (let i = 0; i < frames.length; i++) {
        if (frames[i].order < minOrder)
          minOrder = frames[i].order;
      }

      this._oldestLoadedOrder = minOrder;

      // Build a DocumentFragment with all older frames in chronological order,
      // then prepend the entire fragment in one DOM operation.
      let sorted   = [...frames].sort((a, b) => a.order - b.order);
      let fragment = document.createDocumentFragment();

      for (let frame of sorted) {
        // Dedup: skip frames already in the DOM
        let existing = this._chatView.querySelector(
          `kikx-interaction[data-frame-id="${frame.id}"]`,
        );

        if (existing)
          continue;

        let el = createFrameElement(frame);
        if (el)
          fragment.appendChild(el);
      }

      if (fragment.childNodes.length > 0)
        this._chatView.prependInteraction(fragment);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Failed to load older frames:', error);
    } finally {
      this._loadingOlder = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Empty state placeholder
  // ---------------------------------------------------------------------------

  _showEmptyState() {
    if (this._emptyStateElement)
      return;

    let isDM    = this._isDMSession();
    let message = (isDM) ? t('chat.empty.dm') : t('chat.empty.session');

    let element       = document.createElement('div');
    element.className = 'chat-empty-state';
    element.textContent = message;

    element.style.flex           = '1';
    element.style.display        = 'flex';
    element.style.alignItems     = 'center';
    element.style.justifyContent = 'center';
    element.style.color          = 'var(--text-muted, #606078)';
    element.style.fontSize       = '1.125rem';
    element.style.fontStyle      = 'italic';
    element.style.userSelect     = 'none';

    this._emptyStateElement = element;
    this._chatView.appendInteraction(element);
  }

  _clearEmptyState() {
    if (!this._emptyStateElement)
      return;

    this._emptyStateElement.remove();
    this._emptyStateElement = null;
  }

  _isDMSession() {
    if (this._currentSession) {
      if (this._currentSession.dmAgentID)
        return true;

      if (this._currentSession.name && this._currentSession.name.startsWith('DM: '))
        return true;
    }

    let cached = sessions.getSession(this.sessionID);
    if (cached && cached.name && cached.name.startsWith('DM: '))
      return true;

    return false;
  }

  // ---------------------------------------------------------------------------
  // SSE Stream
  // ---------------------------------------------------------------------------

  _connectStream(sessionID) {
    this._disconnectStream();

    this._sseSessionID        = sessionID;
    this._sseReconnectAttempts = 0;

    this._openSSEConnection(sessionID);
  }

  _openSSEConnection(sessionID) {
    let token = getAuthToken();
    if (!token)
      return;

    let url    = `${API_BASE_URL}/sessions/${sessionID}/stream`;
    let abort  = new AbortController();
    this._streamAbort = abort;

    connection.setStatus('connecting');

    fetch(url, {
      headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'text/event-stream' },
      signal:  abort.signal,
    }).then((response) => {
      if (!response.ok) {
        // eslint-disable-next-line no-console
        console.error('SSE stream failed:', response.status, response.statusText);
        connection.setStatus('disconnected');
        this._scheduleReconnect();

        return;
      }

      // Connected successfully — reset backoff
      this._sseReconnectAttempts = 0;
      this._readSSEStream(response.body);
    }).catch((error) => {
      if (error.name === 'AbortError')
        return;

      // eslint-disable-next-line no-console
      console.error('SSE connection error:', error);
      connection.setStatus('disconnected');
      this._scheduleReconnect();
    });
  }

  async _readSSEStream(body) {
    let reader  = body.getReader();
    let decoder = new TextDecoder();
    let buffer  = '';
    let aborted = false;

    try {
      while (true) {
        let { done, value } = await reader.read();
        if (done)
          break;

        buffer += decoder.decode(value, { stream: true });

        let lines = buffer.split('\n');
        buffer = lines.pop(); // Keep incomplete line in buffer

        let eventType = null;
        let eventData = null;

        for (let line of lines) {
          if (line.startsWith('event: ')) {
            eventType = line.substring(7).trim();
          } else if (line.startsWith('data: ')) {
            eventData = line.substring(6);
          } else if (line === '') {
            // Empty line = end of event
            if (eventType)
              this._handleSSEEvent(eventType, eventData);

            eventType = null;
            eventData = null;
          }
        }
      }
    } catch (error) {
      if (error.name === 'AbortError') {
        aborted = true;

        return;
      }

      // eslint-disable-next-line no-console
      console.error('SSE read error:', error);
    } finally {
      if (!aborted) {
        connection.setStatus('disconnected');
        this._scheduleReconnect();
      }
    }
  }

  _scheduleReconnect() {
    // Don't reconnect if intentionally disconnected or no session
    if (!this._sseSessionID)
      return;

    // Cap at 20 attempts
    if (this._sseReconnectAttempts >= 20)
      return;

    // Exponential backoff: 2s, 4s, 8s, 16s, capped at 30s
    let delay = Math.min(2000 * Math.pow(2, this._sseReconnectAttempts), 30000);
    this._sseReconnectAttempts++;

    this._sseReconnectTimer = setTimeout(() => {
      this._sseReconnectTimer = null;

      // Only reconnect if still on the same session
      if (this._sseSessionID)
        this._openSSEConnection(this._sseSessionID);
    }, delay);
  }

  _handleSSEEvent(eventType, data) {
    switch (eventType) {
      case 'connected':
        connection.setStatus('connected');
        break;

      case 'frame': {
        let frame;

        try {
          frame = JSON.parse(data);
        } catch (_error) {
          return;
        }

        // Raw frame events come from commands and other non-streaming paths.
        // Merge as a single-element array so FrameManager handles rendering.
        if (this._frameManager && frame)
          this._frameManager.merge([frame]);

        break;
      }

      case 'commit': {
        let commit;

        try {
          commit = JSON.parse(data);
        } catch (_error) {
          return;
        }

        // Merge commit frames into FrameManager — event listeners handle rendering
        if (this._frameManager && Array.isArray(commit.frames))
          this._frameManager.merge(commit.frames);

        break;
      }

      case 'delta': {
        let parsed;

        try {
          parsed = JSON.parse(data);
        } catch (_error) {
          return;
        }

        if (!this._frameManager)
          return;

        let deltaText    = (parsed.content && parsed.content.text) || '';
        let deltaAgentID = parsed.authorID || 'default';
        let deltaGroupID = parsed.interactionID || `stream-${deltaAgentID}-${Date.now()}`;

        // Remove typing indicator on first delta
        let typingEl = this._typingIndicators.get(deltaAgentID);
        if (typingEl) {
          typingEl.remove();
          this._typingIndicators.delete(deltaAgentID);
        }

        // Get or create streaming group
        let sg = this._streamingGroups.get(deltaAgentID);
        if (!sg) {
          sg = { groupID: deltaGroupID, html: '', reflectionText: '', agentID: deltaAgentID };
          this._streamingGroups.set(deltaAgentID, sg);
        }

        sg.html += deltaText;

        // Merge phantom with groupID — FrameManager creates/updates group frame
        this._frameManager.merge([{
          id:      `delta-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          type:    'message',
          phantom: true,
          groupID: sg.groupID,
          content: { html: sg.html },
        }]);

        if (debug.isEnabled() && parsed.interactionID)
          debug.setStreamDelta(parsed.interactionID, sg.html);

        break;
      }

      case 'reflection-delta': {
        let parsed;

        try {
          parsed = JSON.parse(data);
        } catch (_error) {
          return;
        }

        if (!this._frameManager)
          return;

        let reflText     = (parsed.content && parsed.content.text) || '';
        let reflAgentID  = parsed.authorID || 'default';
        let reflGroupID  = parsed.interactionID || `stream-${reflAgentID}-${Date.now()}`;

        // Remove typing indicator on first reflection delta
        let reflTypingEl = this._typingIndicators.get(reflAgentID);
        if (reflTypingEl) {
          reflTypingEl.remove();
          this._typingIndicators.delete(reflAgentID);
        }

        // Get or create streaming group
        let reflSg = this._streamingGroups.get(reflAgentID);
        if (!reflSg) {
          reflSg = { groupID: reflGroupID, html: '', reflectionText: '', agentID: reflAgentID };
          this._streamingGroups.set(reflAgentID, reflSg);
        }

        reflSg.reflectionText += reflText;

        // Merge phantom into same group — reflectionText merges alongside html
        this._frameManager.merge([{
          id:      `refl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          type:    'message',
          phantom: true,
          groupID: reflSg.groupID,
          content: { reflectionText: reflSg.reflectionText },
        }]);

        if (debug.isEnabled() && parsed.interactionID)
          debug.setReflectionDelta(parsed.interactionID, reflSg.reflectionText);

        break;
      }

      case 'usage': {
        let parsed;

        try {
          parsed = JSON.parse(data);
        } catch (_error) {
          return;
        }

        this._handleUsage(parsed);
        break;
      }

      case 'interaction:start': {
        let startData;
        try { startData = JSON.parse(data); } catch (_error) { startData = {}; }

        let startAgentID = startData.agentID || 'default';
        this._activeInteractionCount++;
        this._messageInput.setInteracting(true);

        // Merge ephemeral phantom (no groupID) → frame:phantom handler creates typing dots
        if (this._frameManager) {
          this._frameManager.merge([{
            id:      `typing-${startAgentID}-${Date.now()}`,
            type:    'typing-indicator',
            phantom: true,
            content: { agentID: startAgentID },
          }]);
        }

        let startStatusBar = this.querySelector('kikx-status-bar');
        if (startStatusBar)
          startStatusBar.setInteracting(true);
        break;
      }

      case 'interaction:end': {
        let endData;
        try { endData = JSON.parse(data); } catch (_error) { endData = {}; }

        let endAgentID = endData.agentID || 'default';

        if (debug.isEnabled()) {
          let sg = this._streamingGroups.get(endAgentID);
          if (sg && sg.groupID) {
            let groupEl = this._chatView.querySelector(
              `[data-frame-id="${sg.groupID}"]`,
            );
            if (groupEl) {
              let interactionID = endData.interactionID || groupEl.getAttribute('data-interaction-id');
              if (interactionID)
                debug.snapshotComposed(interactionID);
            }
          }
        }

        // Mark any streaming reflection blocks as complete (stop spinner)
        let endSg = this._streamingGroups.get(endAgentID);
        if (endSg && endSg.groupID) {
          let endGroupEl = this._chatView.querySelector(`[data-frame-id="${endSg.groupID}"]`);
          if (endGroupEl) {
            let rb = endGroupEl.querySelector('kikx-reflection-block');
            if (rb)
              rb.setAttribute('complete', '');
          }
        }

        // Remove typing indicator
        let endTypingEl = this._typingIndicators.get(endAgentID);
        if (endTypingEl) {
          endTypingEl.remove();
          this._typingIndicators.delete(endAgentID);
        }

        // Clean up streaming group
        this._streamingGroups.delete(endAgentID);

        // Only clear "interacting" state when ALL agents have finished
        this._activeInteractionCount = Math.max(0, this._activeInteractionCount - 1);
        if (this._activeInteractionCount === 0) {
          this._messageInput.setInteracting(false);
          let endStatusBar = this.querySelector('kikx-status-bar');
          if (endStatusBar)
            endStatusBar.setInteracting(false);
        }
        break;
      }

      case 'relay:delta': {
        let relayParsed;
        try { relayParsed = JSON.parse(data); } catch (_error) { return; }
        this._handleRelayDelta(relayParsed);
        break;
      }

      case 'relay:reflection-delta': {
        let relayReflectionParsed;
        try { relayReflectionParsed = JSON.parse(data); } catch (_error) { return; }
        this._handleRelayDelta(relayReflectionParsed);
        break;
      }
    }
  }

  _disconnectStream() {
    // Clear reconnection state first — prevents _readSSEStream's finally
    // block from scheduling another reconnect after we abort.
    this._sseSessionID = null;

    if (this._sseReconnectTimer) {
      clearTimeout(this._sseReconnectTimer);
      this._sseReconnectTimer = null;
    }

    this._sseReconnectAttempts = 0;

    if (this._streamAbort) {
      this._streamAbort.abort();
      this._streamAbort = null;
    }
  }

  _renderUserMessage(text, parentID) {
    this._clearEmptyState();

    let name = this._getUserDisplayName();

    let interaction = document.createElement('kikx-interaction');
    interaction.setAttribute('alignment', 'user');
    interaction.setAttribute('participant-name', name);
    interaction.setAttribute('participant-initials', getInitials(name));
    interaction.setAttribute('timestamp', formatTimestamp(new Date().toISOString()));

    // Thread: set reply context on the optimistic bubble
    if (parentID) {
      let preview = this._getParentPreview(parentID);
      if (preview)
        interaction.setAttribute('parent-preview', preview);
    }

    let messageContent = document.createElement('kikx-message-content');
    messageContent.content = `<p>${escapeHTML(text)}</p>`;

    interaction.appendChild(messageContent);
    interaction.classList.add('pending');
    this._chatView.appendInteraction(interaction);
  }

  _renderSystemError(message) {
    let interaction = document.createElement('kikx-interaction');
    interaction.setAttribute('alignment', 'agent');
    interaction.setAttribute('participant-name', 'System');
    interaction.setAttribute('participant-initials', '!');
    interaction.setAttribute('timestamp', formatTimestamp(new Date().toISOString()));

    let messageContent = document.createElement('kikx-message-content');
    messageContent.content = `<p style="color: var(--error-color, #ff4444);">${escapeHTML(message)}</p>`;

    interaction.appendChild(messageContent);
    this._chatView.appendInteraction(interaction);
  }

  _getUserDisplayName() {
    let user = profile.getUser();
    if (!user)
      return 'You';

    if (user.firstName)
      return user.lastName ? `${user.firstName} ${user.lastName}` : user.firstName;

    return user.email || 'You';
  }

  _getAgentDisplayName(agentID) {
    // If a specific agentID was provided, look it up from the store
    if (agentID) {
      let agent = agents.getAgent(agentID);
      if (agent && agent.name)
        return agent.name;
    }

    // Fall back to DM agent name
    if (this._currentSession && this._currentSession.dmAgentName)
      return this._currentSession.dmAgentName;

    // Look up agent name from store via dmAgentID
    if (this._currentSession && this._currentSession.dmAgentID) {
      let agent = agents.getAgent(this._currentSession.dmAgentID);
      if (agent && agent.name)
        return agent.name;
    }

    // Strip "DM: " prefix from session name if present
    if (this._currentSession && this._currentSession.name) {
      let name = this._currentSession.name;
      if (name.startsWith('DM: '))
        return name.slice(4);

      return name;
    }

    return 'Agent';
  }

  _refreshAgentNames() {
    if (!this._chatView || !this._frameManager)
      return;

    let allFrames = this._frameManager.toArray();

    for (let frame of allFrames) {
      if (frame.authorType !== 'agent' || !frame.authorID)
        continue;

      let el = this._chatView.querySelector(`[data-frame-id="${frame.id}"]`);
      if (!el || el.getAttribute('participant-name') !== 'Agent')
        continue;

      let agent = agents.getAgent(frame.authorID);
      if (agent && agent.name) {
        el.setAttribute('participant-name', agent.name);
        el.setAttribute('participant-initials', getInitials(agent.name));
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Send message
  // ---------------------------------------------------------------------------

  async _onSendMessage(event) {
    let { text, parentID } = event.detail || {};
    if (!text)
      return;

    let sessionID = this.sessionID;
    if (!sessionID)
      return;

    let agentID = await this._resolveAgentID(sessionID);

    // Render user message immediately (optimistic)
    this._renderUserMessage(text, parentID);

    try {
      await sendMessage(sessionID, text, agentID || undefined, parentID || undefined);
      this._messageInput.clearDraft();
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Failed to send message:', error);
    }
  }

  // ---------------------------------------------------------------------------
  // Initial data loading
  // ---------------------------------------------------------------------------

  async _loadInitialData() {
    // Fetch fresh profile so settings page has current data
    try {
      let meResult  = await getMe();
      let freshUser = (meResult && meResult.data) ? meResult.data : null;

      if (freshUser) {
        let currentUser = profile.getUser() || {};
        let merged = { ...currentUser, ...freshUser };
        profile.setUser(merged, getAuthToken());
        persistAuth(getAuthToken(), merged);
      }
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Failed to load profile:', error);
    }

    // Fetch agents
    try {
      let result    = await getAgents();
      let data      = (result && result.data) || {};
      let agentList = Array.isArray(data) ? data : (data.agents || []);

      for (let agent of agentList)
        agents.addAgent(agent);

      this._updateFriendsList(agentList);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Failed to load agents:', error);
    }

    // Refresh agent names on any frames that rendered before agents loaded
    this._refreshAgentNames();

    // Fetch sessions
    try {
      let result      = await getSessions();
      let data        = (result && result.data) || {};
      let sessionList = Array.isArray(data) ? data : (data.sessions || []);

      // Replace store contents to avoid duplicates on re-navigation
      let existing = sessions.getAllSessions();
      let existingIds = new Set(existing.map((s) => s.id));

      for (let session of sessionList) {
        if (!existingIds.has(session.id))
          sessions.addSession(session);
      }

      this._updateSessionsList();
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Failed to load sessions:', error);
    }
  }

  _updateFriendsList(agentList) {
    if (!this._sidebar)
      return;

    let friends = agentList.map((agent) => ({
      id:   agent.id,
      name: agent.name,
      type: 'agent',
    }));

    this._sidebar.friends = friends;
  }

  _updateSessionsList() {
    if (!this._sidebar)
      return;

    this._sidebar.sessions = sessions.getAllSessions();
  }

  // ---------------------------------------------------------------------------
  // Relay display — cross-session streaming
  // ---------------------------------------------------------------------------

  _handleRelayDelta(parsed) {
    let text            = (parsed.content && parsed.content.text) || '';
    let targetSessionID = parsed.targetSessionID || '';
    let agentID         = parsed.authorID || null;
    let relayKey        = `relay:${targetSessionID}`;

    let relay = this._relayStreams.get(relayKey);

    if (!relay) {
      let name = this._getAgentDisplayName(agentID) || 'Remote Agent';

      let interaction = document.createElement('kikx-interaction');
      interaction.setAttribute('alignment', 'agent');
      interaction.setAttribute('participant-name', `${name} (relay)`);
      interaction.setAttribute('participant-initials', getInitials(name));
      interaction.setAttribute('timestamp', formatTimestamp(new Date().toISOString()));
      interaction.setAttribute('data-relay-session', targetSessionID);

      let messageContent = document.createElement('kikx-message-content');
      interaction.appendChild(messageContent);
      this._chatView.appendInteraction(interaction);

      relay = { interaction, content: messageContent, html: '' };
      this._relayStreams.set(relayKey, relay);
    }

    relay.html += text;
    relay.content.content = relay.html;
  }

  // ---------------------------------------------------------------------------
  // Usage / cost tracking
  // ---------------------------------------------------------------------------

  _handleUsage({ interactionID, usage, serviceType, isFinal }) {
    if (!usage)
      return;

    // Show token count on only the last agent bubble for this interaction,
    // since the count covers the entire turn, not individual messages.
    // Clear it from earlier bubbles so it doesn't trail as new ones appear.
    let outputTokens = usage.outputTokens || 0;

    if (outputTokens > 0) {
      let agentInteractions = this._chatView.querySelectorAll(`kikx-interaction[alignment="agent"][data-interaction-id="${interactionID}"]`);

      for (let i = 0; i < agentInteractions.length - 1; i++)
        agentInteractions[i].removeAttribute('token-count');

      if (agentInteractions.length > 0)
        agentInteractions[agentInteractions.length - 1].setAttribute('token-count', String(outputTokens));
    }

    // Only update cost totals on the final usage event (the 'done' block).
    // Partial usage events contain cumulative snapshots and would cause
    // double-counting if added incrementally.
    if (!isFinal)
      return;

    let cost         = estimateCost(usage, serviceType);
    let currentCosts = connection.getCosts();

    connection.updateCosts({
      global:  currentCosts.global + cost,
      service: currentCosts.service + cost,
      session: currentCosts.session + cost,
    });
  }

  // ---------------------------------------------------------------------------
  // Modal / friend / session handlers
  // ---------------------------------------------------------------------------

  _onAddFriend() {
    if (this._addFriendWizard && this._addFriendWizard.reset)
      this._addFriendWizard.reset();

    this._friendModal.open();
  }

  _onAddSession() {
    if (this._createSessionModal) {
      this._createSessionModal.agents = agents.getAllAgents();
      this._createSessionModal.reset();
    }

    this._sessionModal.open();

    requestAnimationFrame(() => {
      if (this._createSessionModal && this._createSessionModal.focus)
        this._createSessionModal.focus();
    });
  }

  async _onFriendSave(event) {
    let detail = event.detail;

    if (detail.type === 'agent') {
      try {
        let result = await createAgent({
          name:     detail.name,
          pluginID: detail.pluginID,
          apiKey:   detail.apiKey,
          model:    detail.model,
        });

        let data     = (result && result.data) || result;
        let newAgent = data.agent || data;
        agents.addAgent(newAgent);

        let allAgents = agents.getAllAgents();
        this._updateFriendsList(allAgents);
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error('Failed to create agent:', error);
      }
    }

    this._friendModal.close();
  }

  _onFriendCancel() {
    this._friendModal.close();
  }

  _onSessionCancel() {
    this._sessionModal.close();
    if (this._createSessionModal && this._createSessionModal.reset)
      this._createSessionModal.reset();
  }

  async _onSessionCreate(event) {
    let detail = event.detail || {};

    try {
      let result;
      let newSession;

      let sessionData = {};

      if (detail.name)
        sessionData.name = detail.name;

      if (detail.agentID)
        sessionData.agentID = detail.agentID;

      result     = await createSession(sessionData);
      let data   = (result && result.data) || result;
      newSession = data.session || data;

      // Add to store if not already present
      let existing = sessions.getAllSessions();
      if (!existing.some((s) => s.id === newSession.id))
        sessions.addSession(newSession);

      this._updateSessionsList();
      this._sessionModal.close();

      if (newSession && newSession.id)
        navigate(`${BASE_PATH}/sessions/${newSession.id}`);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Failed to create session:', error);
      this._sessionModal.close();
    }
  }

  async _onSelectFriend(event) {
    let { id, type } = event.detail || {};

    if (type === 'agent' && id) {
      try {
        let result  = await getOrCreateDm(id);
        let data    = (result && result.data) || {};
        let session = data.session || data;

        if (session && session.id)
          navigate(`${BASE_PATH}/sessions/${session.id}`);
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error('Failed to open DM session:', error);
      }
    }
  }

  _onSelectSession(event) {
    let { id } = event.detail || {};

    if (id)
      navigate(`${BASE_PATH}/sessions/${id}`);
  }

  _onAnchoredChange(event) {
    let { anchored } = event.detail || {};

    if (anchored)
      this._scrollAnchor.hide();
    else
      this._scrollAnchor.show();
  }

  _onJumpToBottom() {
    this._chatView.scrollToBottom();
  }

  _onQueueChange(event) {
    let { count } = event.detail || {};
    let statusBar = this.querySelector('kikx-status-bar');

    if (statusBar)
      statusBar.setQueueCount(count || 0);
  }

  async _onPermissionResponse(event) {
    let { permissionID, decisions } = event.detail || {};

    if (!permissionID)
      return;

    let sessionID = this.sessionID;
    if (!sessionID)
      return;

    // Mark the permission UI as processed immediately to prevent further clicks.
    // Use composedPath() to find the actual element across shadow DOM boundaries,
    // since event.target is retargeted to kikx-interaction at this scope.
    let permEl = event.composedPath().find((el) => el.tagName === 'KIKX-PERMISSION-REQUEST');
    if (permEl && permEl.setAttribute)
      permEl.setAttribute('processed', '');

    try {
      // Pass decisions array as body to the unified endpoint
      let body = (Array.isArray(decisions) && decisions.length > 0) ? { decisions } : undefined;
      await approvePermission(sessionID, permissionID, body);

      // Persist the decision on the frame so historical loads show what was chosen
      if (Array.isArray(decisions) && decisions.length > 0) {
        let resolvedDecision = decisions[0].decision;
        if (permEl)
          permEl.resolvedDecision = resolvedDecision;

        updateFrameContent(sessionID, permissionID, { decision: resolvedDecision, processed: true }).catch(() => {});
      }
    } catch (error) {
      // Stale permission request — server restarted and lost the pending state
      if (error.status === 410) {
        if (permEl) {
          permEl.setAttribute('expired', '');
          permEl.setAttribute('processed', '');
        }

        return;
      }

      console.error('Permission approval failed:', error);
    }

    this._messageInput.focus();
  }

  async _onCancelInteraction() {
    let sessionID = this.sessionID;
    if (!sessionID)
      return;

    try {
      await cancelInteraction(sessionID);
    } catch (error) {
      console.error('Cancel interaction failed:', error);
    }
  }

  _collectPromptValues(interaction) {
    // Prompts live inside kikx-message-content (light DOM)
    let messageContents = interaction.querySelectorAll('kikx-message-content');
    let answers         = {};

    for (let messageContent of messageContents) {
      let prompts = messageContent.querySelectorAll('kikx-hml-prompt');
      for (let prompt of prompts) {
        let name  = prompt.getName();
        let value = prompt.getValue();

        if (name)
          answers[name] = value;
      }
    }

    return answers;
  }

  _disableInteractionPrompts(interaction, answers = {}) {
    interaction.removeAttribute('show-actions');

    let messageContents = interaction.querySelectorAll('kikx-message-content');
    for (let messageContent of messageContents) {
      let prompts = messageContent.querySelectorAll('kikx-hml-prompt');
      for (let prompt of prompts) {
        // Set value attribute BEFORE readonly — readonly triggers _renderControl()
        // which rebuilds from getAttribute('value'), so the value must be set first.
        let name = prompt.getName();
        if (name && answers.hasOwnProperty(name))
          prompt.setAttribute('value', String(answers[name]));

        prompt.setAttribute('readonly', '');
      }
    }
  }

  // Build updated HTML with prompt values baked in and readonly set.
  // This is what gets persisted back to the frame in the DB.
  _buildUpdatedFrameHTML(interaction, answers) {
    let messageContent = interaction.querySelector('kikx-message-content');
    if (!messageContent)
      return null;

    let rawHTML = messageContent.content;
    if (!rawHTML)
      return null;

    // Parse into a template fragment so we can manipulate the prompt elements
    let template = document.createElement('template');
    template.innerHTML = rawHTML;

    let prompts = template.content.querySelectorAll('kikx-hml-prompt');
    for (let prompt of prompts) {
      let name = prompt.getAttribute('name') || prompt.getAttribute('prompt-id') || '';

      // Mirror getName() label-derived fallback for prompts without explicit name
      if (!name) {
        let label = prompt.getAttribute('label');
        if (label)
          name = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      }

      if (name && answers.hasOwnProperty(name))
        prompt.setAttribute('value', String(answers[name]));

      prompt.setAttribute('readonly', '');
    }

    return template.innerHTML;
  }

  async _persistFrameContent(sessionID, interaction, answers) {
    let frameID = interaction.getAttribute('data-frame-id');
    if (!frameID)
      return;

    let updatedHTML = this._buildUpdatedFrameHTML(interaction, answers);
    if (!updatedHTML)
      return;

    try {
      await updateFrameContent(sessionID, frameID, { html: updatedHTML });
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Failed to persist frame content:', error);
    }
  }

  _findInteractionFromEvent(event) {
    for (let node of event.composedPath()) {
      if (node.tagName && node.tagName.toLowerCase() === 'kikx-interaction')
        return node;
    }

    return null;
  }

  async _resolveAgentID(sessionID) {
    let agentID = null;

    if (this._currentSession) {
      agentID = this._currentSession.dmAgentID || null;

      // For chat sessions, resolve agent from participants
      if (!agentID && this._currentSession.participants && this._currentSession.participants.length > 0)
        agentID = this._currentSession.participants[0].agentID;
    }

    // If no agent found, refresh session details — participants may have been
    // added after the initial fetch (e.g., invited after session creation).
    if (!agentID && sessionID) {
      await this._fetchSessionDetails(sessionID);

      if (this._currentSession) {
        agentID = this._currentSession.dmAgentID || null;

        if (!agentID && this._currentSession.participants && this._currentSession.participants.length > 0)
          agentID = this._currentSession.participants[0].agentID;
      }
    }

    return agentID;
  }

  async _onInteractionSubmit(event) {
    let interaction = this._findInteractionFromEvent(event);
    if (!interaction)
      return;

    let answers   = this._collectPromptValues(interaction);
    let sessionID = this.sessionID;

    if (!sessionID)
      return;

    let agentID = await this._resolveAgentID(sessionID);
    if (!agentID)
      return;

    // Format answers as a readable message for the agent
    let lines = [];
    for (let [name, value] of Object.entries(answers))
      lines.push(`${name}: ${value}`);

    let text = lines.join('\n');
    if (!text)
      return;

    this._disableInteractionPrompts(interaction, answers);
    this._renderUserMessage(text);

    // Persist the answered values back into the frame content
    await this._persistFrameContent(sessionID, interaction, answers);

    try {
      await sendMessage(sessionID, text, agentID);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Failed to submit prompt answers:', error);
    }

    this._messageInput.focus();
  }

  async _onInteractionIgnore(event) {
    let interaction = this._findInteractionFromEvent(event);
    if (!interaction)
      return;

    let answers   = this._collectPromptValues(interaction);
    let sessionID = this.sessionID;

    if (!sessionID)
      return;

    let agentID = await this._resolveAgentID(sessionID);
    if (!agentID)
      return;

    // Build refusal message listing each prompt
    let names = Object.keys(answers);
    let text  = (names.length > 0)
      ? `User refused to answer: ${names.join(', ')}`
      : 'User refused to answer';

    this._disableInteractionPrompts(interaction, {});
    this._renderUserMessage(text);

    // Persist readonly state (no answer values) back into the frame content
    await this._persistFrameContent(sessionID, interaction, {});

    try {
      await sendMessage(sessionID, text, agentID);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Failed to send ignore response:', error);
    }

    this._messageInput.focus();
  }

  _onModalClose() {
    // No-op: modals close themselves
  }

  // ---------------------------------------------------------------------------
  // Thread support — reply button handler + reply count tracking
  // ---------------------------------------------------------------------------

  _onReplyToMessage(event) {
    let { frameID, participantName } = event.detail || {};
    if (!frameID)
      return;

    this._messageInput.setReplyMode(frameID, participantName);
  }

  _getParentPreview(parentID) {
    if (!parentID || !this._frameManager)
      return null;

    let parentFrame = this._frameManager.get(parentID);
    if (!parentFrame)
      return null;

    let name = parentFrame.authorName || '';
    let text = '';

    if (parentFrame.content) {
      if (parentFrame.content.text)
        text = parentFrame.content.text;
      else if (parentFrame.content.html) {
        // Strip HTML for preview
        let div = document.createElement('div');
        div.innerHTML = parentFrame.content.html;
        text = (div.textContent || '').trim();
      }
    }

    let preview = text.substring(0, 60);
    if (text.length > 60)
      preview += '...';

    if (name)
      return `${name}: ${preview}`;

    return preview || null;
  }

  _updateReplyCount(parentID) {
    if (!parentID || !this._chatView)
      return;

    // Count all frames in the FrameManager that have this parentID
    let count = 0;
    if (this._frameManager) {
      for (let frame of this._frameManager) {
        if (frame.parentID === parentID)
          count++;
      }
    }

    if (count <= 0)
      return;

    // Find the parent interaction element and set reply-count
    let parentEl = this._chatView.querySelector(
      `kikx-interaction[data-frame-id="${parentID}"]`,
    );

    if (parentEl)
      parentEl.setAttribute('reply-count', String(count));
  }
}

if (typeof customElements !== 'undefined')
  customElements.define('kikx-session-page', KikxSessionPage);

export default KikxSessionPage;
