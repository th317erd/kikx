'use strict';

import { t } from '../../lib/i18n.mjs';
import { navigate } from '../../lib/router.mjs';
import { getAgents, createAgent, createSession, getOrCreateDm, getMe, getSession, getFrames, getSessions, sendMessage, approvePermission, cancelInteraction, updateFrameContent, persistAuth, getAuthToken } from '../../lib/api.mjs';
import { agents, sessions, profile, connection } from '../../lib/store.mjs';
import { estimateCost } from '../../lib/cost.mjs';
import { FrameManager } from '../../../shared/frame-manager/frame-manager.mjs';
import * as debug from '../../lib/debug.mjs';

const TEMPLATE_HTML = `
  <style>
    :host {
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

    kikx-top-bar {
      grid-area: topbar;
    }

    .chat-area {
      grid-area: chat;
      position: relative;
      overflow: hidden;
    }

    kikx-chat-view {
      width: 100%;
      height: 100%;
      overflow: hidden;
    }

    kikx-message-input {
      grid-area: input;
    }

    kikx-message-input.hidden {
      display: none;
    }

    kikx-sidebar {
      grid-area: sidebar;
      width: 300px;
    }

    kikx-status-bar {
      grid-area: statusbar;
    }

    .typing-indicator {
      display: flex;
      gap: 4px;
      padding: 8px 4px;
    }

    .typing-indicator span {
      width: 6px;
      height: 6px;
      background: var(--text-muted, #606078);
      border-radius: 50%;
      animation: typing 1.4s infinite ease-in-out;
    }

    .typing-indicator span:nth-child(2) { animation-delay: 0.2s; }
    .typing-indicator span:nth-child(3) { animation-delay: 0.4s; }

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

class KikxSessionPage extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });

    this._currentSession    = null;
    this._eventSource       = null;
    this._frameManager      = null;
    this._oldestLoadedOrder = 0;
    this._loadingOlder      = false;

    // Multi-agent streaming: per-agent streaming state
    // Map<agentID, { typingIndicator, typingDots, streamingInteraction, streamingContent, streamingHTML, streamingReflection, reflectionText }>
    this._agentStreams = new Map();

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
    this.shadowRoot.appendChild(getTemplate().content.cloneNode(true));

    this._topBar             = this.shadowRoot.querySelector('kikx-top-bar');
    this._chatView           = this.shadowRoot.querySelector('kikx-chat-view');
    this._messageInput       = this.shadowRoot.querySelector('kikx-message-input');
    this._sidebar            = this.shadowRoot.querySelector('kikx-sidebar');
    this._scrollAnchor       = this.shadowRoot.querySelector('kikx-scroll-anchor');
    this._friendModal        = this.shadowRoot.querySelector('.friend-modal');
    this._sessionModal       = this.shadowRoot.querySelector('.session-modal');
    this._addFriendWizard    = this.shadowRoot.querySelector('kikx-add-friend-modal');
    this._createSessionModal = this.shadowRoot.querySelector('kikx-create-session-modal');

    // Set modal titles
    this._friendModal.setAttribute('modal-title', t('friends.wizard.title'));
    this._sessionModal.setAttribute('modal-title', t('session.create.title'));

    // Update view based on session presence
    this._updateSessionView();

    // Event listeners
    this.shadowRoot.addEventListener('add-friend', this._onAddFriend);
    this.shadowRoot.addEventListener('add-session', this._onAddSession);
    this.shadowRoot.addEventListener('friend-save', this._onFriendSave);
    this.shadowRoot.addEventListener('friend-cancel', this._onFriendCancel);
    this.shadowRoot.addEventListener('session-create', this._onSessionCreate);
    this.shadowRoot.addEventListener('session-cancel', this._onSessionCancel);
    this.shadowRoot.addEventListener('modal-close', this._onModalClose);
    this.shadowRoot.addEventListener('select-friend', this._onSelectFriend);
    this.shadowRoot.addEventListener('send-message', this._onSendMessage);
    this.shadowRoot.addEventListener('anchored-change', this._onAnchoredChange);
    this.shadowRoot.addEventListener('jump-to-bottom', this._onJumpToBottom);
    this.shadowRoot.addEventListener('near-top', this._onNearTop);
    this.shadowRoot.addEventListener('queue-change', this._onQueueChange);
    this.shadowRoot.addEventListener('permission-response', this._onPermissionResponse);
    this.shadowRoot.addEventListener('cancel-interaction', this._onCancelInteraction);
    this.shadowRoot.addEventListener('interaction-submit', this._onInteractionSubmit);
    this.shadowRoot.addEventListener('interaction-ignore', this._onInteractionIgnore);
    this.shadowRoot.addEventListener('select-session', this._onSelectSession);
    this.shadowRoot.addEventListener('reply-to-message', this._onReplyToMessage);

    this._loadInitialData();
  }

  disconnectedCallback() {
    this.shadowRoot.removeEventListener('add-friend', this._onAddFriend);
    this.shadowRoot.removeEventListener('add-session', this._onAddSession);
    this.shadowRoot.removeEventListener('friend-save', this._onFriendSave);
    this.shadowRoot.removeEventListener('friend-cancel', this._onFriendCancel);
    this.shadowRoot.removeEventListener('session-create', this._onSessionCreate);
    this.shadowRoot.removeEventListener('session-cancel', this._onSessionCancel);
    this.shadowRoot.removeEventListener('modal-close', this._onModalClose);
    this.shadowRoot.removeEventListener('select-friend', this._onSelectFriend);
    this.shadowRoot.removeEventListener('send-message', this._onSendMessage);
    this.shadowRoot.removeEventListener('anchored-change', this._onAnchoredChange);
    this.shadowRoot.removeEventListener('jump-to-bottom', this._onJumpToBottom);
    this.shadowRoot.removeEventListener('near-top', this._onNearTop);
    this.shadowRoot.removeEventListener('queue-change', this._onQueueChange);
    this.shadowRoot.removeEventListener('permission-response', this._onPermissionResponse);
    this.shadowRoot.removeEventListener('cancel-interaction', this._onCancelInteraction);
    this.shadowRoot.removeEventListener('interaction-submit', this._onInteractionSubmit);
    this.shadowRoot.removeEventListener('interaction-ignore', this._onInteractionIgnore);
    this.shadowRoot.removeEventListener('select-session', this._onSelectSession);
    this.shadowRoot.removeEventListener('reply-to-message', this._onReplyToMessage);

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
    let sessionID = this.sessionID;

    if (sessionID) {
      this._topBar.removeAttribute('hide-back');
      this._topBar.setAttribute('session-name', sessionID);
      this._messageInput.classList.remove('hidden');
      this._messageInput.sessionID = sessionID;

      // Reset session cost when navigating to a new session
      let currentCosts = connection.getCosts();
      connection.updateCosts({ global: currentCosts.global, service: currentCosts.service, session: 0 });

      // Create client-side FrameManager for this session
      this._initFrameManager();

      this._fetchSessionDetails(sessionID);
      this._loadFrames(sessionID).then(() => this._connectStream(sessionID));
    } else {
      this._topBar.setAttribute('hide-back', '');
      this._topBar.removeAttribute('session-name');
      this._messageInput.classList.add('hidden');

      this._disconnectStream();
      this._destroyFrameManager();
      this._currentSession = null;
    }
  }

  _initFrameManager() {
    this._destroyFrameManager();

    this._frameManager = new FrameManager({ history: false });

    // Event-driven rendering: FrameManager emits when frames are added/updated
    this._frameManager.on('frame:added', ({ frame }) => {
      this._renderFrame(frame);
    });

    this._frameManager.on('frame:updated', ({ frame }) => {
      this._updateRenderedFrame(frame);
    });
  }

  _destroyFrameManager() {
    if (this._frameManager) {
      this._frameManager.removeAllListeners();
      this._frameManager = null;
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
        // Bulk load into FrameManager — suppress per-frame events
        this._frameManager.merge(frames, { events: false });
        this._frameManager.syncOrderCounter(this._frameManager.getWindowBounds().to);

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

        // Render all frames from FrameManager's sorted state
        for (let frame of this._frameManager)
          this._renderFrame(frame, { fromHistory: true });
      } else {
        // Fallback: direct render (no FrameManager)
        for (let frame of frames)
          this._renderFrame(frame, { fromHistory: true });
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

      // Load into FrameManager without events (we render manually in order)
      this._frameManager.loadWindow(frames);

      // Update oldest DB-level order from raw API data
      let minOrder = Infinity;
      for (let i = 0; i < frames.length; i++) {
        if (frames[i].order < minOrder)
          minOrder = frames[i].order;
      }

      this._oldestLoadedOrder = minOrder;

      // Prepend rendered frames (oldest first, so they stack correctly)
      let sorted = [...frames].sort((a, b) => a.order - b.order);
      for (let frame of sorted)
        this._renderFrame(frame, { fromHistory: true, prepend: true });
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Failed to load older frames:', error);
    } finally {
      this._loadingOlder = false;
    }
  }

  // ---------------------------------------------------------------------------
  // SSE Stream
  // ---------------------------------------------------------------------------

  _connectStream(sessionID) {
    this._disconnectStream();

    let token = getAuthToken();
    if (!token)
      return;

    let url    = `/kikx/api/v2/sessions/${sessionID}/stream`;
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
        return;
      }

      this._readSSEStream(response.body);
    }).catch((error) => {
      if (error.name === 'AbortError')
        return;

      // eslint-disable-next-line no-console
      console.error('SSE connection error:', error);
      connection.setStatus('disconnected');
    });
  }

  async _readSSEStream(body) {
    let reader  = body.getReader();
    let decoder = new TextDecoder();
    let buffer  = '';

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
      if (error.name === 'AbortError')
        return;

      // eslint-disable-next-line no-console
      console.error('SSE read error:', error);
    }

    connection.setStatus('disconnected');
  }

  _handleSSEEvent(eventType, data) {
    switch (eventType) {
      case 'connected':
        connection.setStatus('connected');
        break;

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

      case 'frame': {
        // When FrameManager is present, frames arrive via 'commit' events
        // (which already contain the frame data). Skip raw 'frame' events
        // to avoid rendering the same frame twice.
        if (this._frameManager)
          break;

        let frame;

        try {
          frame = JSON.parse(data);
        } catch (_error) {
          return;
        }

        this._renderFrame(frame);
        break;
      }

      case 'delta': {
        let parsed;

        try {
          parsed = JSON.parse(data);
        } catch (_error) {
          return;
        }

        this._handleStreamDelta(parsed);
        break;
      }

      case 'reflection-delta': {
        let parsed;

        try {
          parsed = JSON.parse(data);
        } catch (_error) {
          return;
        }

        this._handleReflectionDelta(parsed);
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

        let startAgentID = startData.agentID || null;
        this._messageInput.setInteracting(true);
        this._showTypingIndicator(startAgentID);
        let startStatusBar = this.shadowRoot.querySelector('kikx-status-bar');
        if (startStatusBar)
          startStatusBar.setInteracting(true);
        break;
      }

      case 'interaction:end': {
        let endData;
        try { endData = JSON.parse(data); } catch (_error) { endData = {}; }

        let endAgentID = endData.agentID || null;

        if (debug.isEnabled()) {
          let streamState = (endAgentID) ? this._agentStreams.get(endAgentID) : null;
          let streamingEl = (streamState && streamState.streamingInteraction) || this._streamingInteraction;
          if (streamingEl) {
            let interactionID = endData.interactionID || streamingEl.getAttribute('data-interaction-id');
            if (interactionID)
              debug.snapshotComposed(interactionID);
          }
        }

        this._removeTypingIndicator(endAgentID);
        this._clearStreamingState(endAgentID);
        this._messageInput.setInteracting(false);
        let endStatusBar = this.shadowRoot.querySelector('kikx-status-bar');
        if (endStatusBar)
          endStatusBar.setInteracting(false);
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
    if (this._streamAbort) {
      this._streamAbort.abort();
      this._streamAbort = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Frame rendering
  // ---------------------------------------------------------------------------

  _placeInteraction(interaction, options) {
    if (options && options.prepend)
      this._chatView.prependInteraction(interaction);
    else
      this._chatView.appendInteraction(interaction);
  }

  _renderFrame(frame, options = {}) {
    // User-message frames from SSE: don't re-render (already shown optimistically),
    // but update the optimistic element with server-provided metadata (token count, frame ID).
    if (frame.type === 'user-message' && !options.fromHistory) {
      let estimatedTokens = frame.content && frame.content.estimatedTokens;

      // Find the most recent user bubble without a data-frame-id (the optimistic one)
      let allInteractions = this._chatView.shadowRoot.querySelectorAll('kikx-interaction[alignment="user"]:not([data-frame-id])');
      let optimistic = allInteractions.length > 0 ? allInteractions[allInteractions.length - 1] : null;

      if (optimistic) {
        optimistic.setAttribute('data-frame-id', frame.id);
        optimistic.setAttribute('data-interaction-id', frame.interactionID || frame.id);

        if (estimatedTokens)
          optimistic.setAttribute('token-count', String(estimatedTokens));

        // If the server converted markdown → HTML, update the optimistic bubble
        if (frame.content && frame.content.html) {
          let messageContent = optimistic.querySelector('kikx-message-content');
          if (messageContent)
            messageContent.content = frame.content.html;
        }
      }

      // Thread: update reply count on the parent message now that the frame is confirmed
      if (frame.parentID)
        this._updateReplyCount(frame.parentID);

      return;
    }

    // Skip non-renderable frame types (internal plumbing, not user-facing)
    let hiddenTypes = new Set([
      'pending-action',
      'tool-call',
      'tool-result',
      'tool-error',
      'hook-blocked',
      'permission-denied',
      'participant-joined',
      'participant-left',
    ]);

    if (hiddenTypes.has(frame.type))
      return;

    // Session-link frames — render as clickable card
    if (frame.type === 'session-link') {
      let content = frame.content || {};

      let interaction = document.createElement('kikx-interaction');
      interaction.setAttribute('alignment', 'system');
      interaction.setAttribute('participant-name', 'System');
      interaction.setAttribute('participant-initials', '#');
      interaction.setAttribute('timestamp', formatTimestamp(frame.createdAt || frame.timestamp || Date.now()));
      interaction.setAttribute('data-interaction-id', frame.interactionID || frame.id);
      interaction.setAttribute('data-frame-id', frame.id);

      let sessionLink = document.createElement('kikx-session-link');
      sessionLink.setAttribute('target-session-id', content.targetSessionID || '');
      sessionLink.setAttribute('session-title', content.title || 'Sub-session');

      if (content.participants && content.participants.length > 0)
        sessionLink.setAttribute('participant-count', String(content.participants.length));

      interaction.appendChild(sessionLink);
      this._placeInteraction(interaction, options);

      if (debug.isEnabled()) {
        debug.trackElement(frame.interactionID || frame.id, interaction);
        debug.pushFrame(frame.interactionID || frame.id, frame);
      }

      return;
    }

    // Permission request — render approval UI
    if (frame.type === 'permission-request') {
      let name = this._getAgentDisplayName();

      let interaction = document.createElement('kikx-interaction');
      interaction.setAttribute('alignment', 'agent');
      interaction.setAttribute('participant-name', name);
      interaction.setAttribute('participant-initials', getInitials(name));
      interaction.setAttribute('timestamp', formatTimestamp(frame.createdAt || frame.timestamp || Date.now()));
      interaction.setAttribute('data-interaction-id', frame.interactionID || frame.id);
      interaction.setAttribute('data-frame-id', frame.id);

      let permRequest = document.createElement('kikx-permission-request');
      permRequest.setAttribute('permission-id', frame.id);

      // Set per-command data if available (shell:execute with parsed commands)
      let parsedCommands = frame.content && frame.content.parsedCommands;
      if (parsedCommands && parsedCommands.length > 0) {
        let descriptionTemplate = t('permission.wantsToExecute') || '{name} wants to execute:';
        permRequest.description = descriptionTemplate.replace('{name}', name);

        // Show the full original command string at the top
        let fullCommandString = frame.content && frame.content.arguments && frame.content.arguments.command;
        if (fullCommandString)
          permRequest.fullCommand = fullCommandString;

        permRequest.commands = parsedCommands;
      } else {
        let toolName = (frame.content && frame.content.toolName) || 'unknown';
        permRequest.description = `${name} wants to use: ${toolName}`;
      }

      if (frame.processed)
        permRequest.setAttribute('processed', '');

      interaction.appendChild(permRequest);
      this._placeInteraction(interaction, options);

      if (debug.isEnabled()) {
        debug.trackElement(frame.interactionID || frame.id, interaction);
        debug.pushFrame(frame.interactionID || frame.id, frame);
      }

      return;
    }

    // Command result — render as system message
    if (frame.type === 'command-result') {
      let interaction = document.createElement('kikx-interaction');
      interaction.setAttribute('alignment', 'agent');
      interaction.setAttribute('participant-name', 'System');
      interaction.setAttribute('participant-initials', 'S');
      interaction.setAttribute('timestamp', formatTimestamp(frame.createdAt || frame.timestamp || Date.now()));
      interaction.setAttribute('data-interaction-id', frame.interactionID || frame.id);
      interaction.setAttribute('data-frame-id', frame.id);

      let messageContent = document.createElement('kikx-message-content');
      messageContent.content = (frame.content && frame.content.html) || '';

      interaction.appendChild(messageContent);
      this._placeInteraction(interaction, options);

      if (debug.isEnabled()) {
        debug.trackElement(frame.interactionID || frame.id, interaction);
        debug.pushFrame(frame.interactionID || frame.id, frame);
      }

      return;
    }

    // Error frames — render as error messages
    if (frame.type === 'error') {
      let interaction = document.createElement('kikx-interaction');
      interaction.setAttribute('alignment', 'agent');
      interaction.setAttribute('participant-name', 'System');
      interaction.setAttribute('participant-initials', '!');
      interaction.setAttribute('timestamp', formatTimestamp(frame.createdAt || frame.timestamp || Date.now()));
      interaction.setAttribute('data-interaction-id', frame.interactionID || frame.id);
      interaction.setAttribute('data-frame-id', frame.id);

      let messageContent = document.createElement('kikx-message-content');
      let errorMsg = (frame.content && frame.content.message) || 'An error occurred';
      messageContent.content = `<p style="color: var(--error-color, #ff4444);">Error: ${errorMsg}</p>`;

      interaction.appendChild(messageContent);
      this._placeInteraction(interaction, options);

      if (debug.isEnabled()) {
        debug.trackElement(frame.interactionID || frame.id, interaction);
        debug.pushFrame(frame.interactionID || frame.id, frame);
      }

      return;
    }

    // Reflection frames
    if (frame.type === 'reflection') {
      // If we're streaming and have a live reflection block, finalize it
      if (this._streamingReflection) {
        this._streamingReflection.content = (frame.content && frame.content.text) || '';
        this._streamingReflection = null;
        this._reflectionText      = '';

        return;
      }

      // From history or non-streaming: render as standalone collapsible block
      if (options.fromHistory) {
        let name = this._getAgentDisplayName();

        let interaction = document.createElement('kikx-interaction');
        interaction.setAttribute('alignment', 'agent');
        interaction.setAttribute('participant-name', name);
        interaction.setAttribute('participant-initials', getInitials(name));
        interaction.setAttribute('timestamp', formatTimestamp(frame.createdAt || frame.timestamp || Date.now()));
        interaction.setAttribute('data-interaction-id', frame.interactionID || frame.id);
        interaction.setAttribute('data-frame-id', frame.id);

        let reflectionBlock = document.createElement('kikx-reflection-block');
        reflectionBlock.content = (frame.content && frame.content.text) || '';

        interaction.appendChild(reflectionBlock);
        this._placeInteraction(interaction, options);

        if (debug.isEnabled()) {
          debug.trackElement(frame.interactionID || frame.id, interaction);
          debug.pushFrame(frame.interactionID || frame.id, frame);
        }
      }

      return;
    }

    // Message frames: finalize streaming bubble if active
    if (frame.type === 'message' && this._streamingInteraction) {
      let content = frame.content;
      let html    = '';

      if (content && typeof content === 'object') {
        if (content.html)
          html = content.html;
        else if (content.text)
          html = `<p>${this._escapeHTML(content.text)}</p>`;
      } else if (typeof content === 'string') {
        html = content;
      }

      // Update the existing streaming content with the finalized (sanitized) HTML
      if (this._streamingContent)
        this._streamingContent.content = html;

      // Set data-frame-id so persistence can find this frame later
      this._streamingInteraction.setAttribute('data-frame-id', frame.id);

      if (debug.isEnabled() && frame.interactionID) {
        debug.pushFrame(frame.interactionID, frame);
        debug.snapshotComposed(frame.interactionID);
      }

      this._streamingInteraction = null;
      this._streamingContent     = null;
      this._streamingHTML        = '';

      return;
    }

    let isUser    = (frame.type === 'user-message') || (frame.authorType === 'user');
    let alignment = (isUser) ? 'user' : 'agent';
    let name      = frame.authorName || ((isUser) ? this._getUserDisplayName() : this._getAgentDisplayName());

    let interaction = document.createElement('kikx-interaction');
    interaction.setAttribute('alignment', alignment);
    interaction.setAttribute('participant-name', name);
    interaction.setAttribute('participant-initials', getInitials(name));
    interaction.setAttribute('timestamp', formatTimestamp(frame.createdAt || frame.timestamp || Date.now()));
    interaction.setAttribute('data-interaction-id', frame.interactionID || frame.id);
    interaction.setAttribute('data-frame-id', frame.id);

    // Thread: set reply context if this frame is a reply
    if (frame.parentID) {
      let preview = this._getParentPreview(frame.parentID);
      if (preview)
        interaction.setAttribute('parent-preview', preview);
    }

    // Set server-estimated token count for user messages
    if (isUser && frame.content && frame.content.estimatedTokens)
      interaction.setAttribute('token-count', String(frame.content.estimatedTokens));

    // frame.content is an object: { html: "..." } or { text: "..." }
    let content = frame.content;
    let html    = '';

    if (content && typeof content === 'object') {
      if (content.html) {
        html = content.html;
      } else if (content.text) {
        // Plain text (e.g. user-message frames) — escape for safe HTML rendering
        html = `<p>${this._escapeHTML(content.text)}</p>`;
      }
    } else if (typeof content === 'string') {
      html = content;
    }

    let messageContent = document.createElement('kikx-message-content');
    messageContent.content = html;

    interaction.appendChild(messageContent);
    this._placeInteraction(interaction, options);

    // Thread: update reply count on parent message
    if (frame.parentID)
      this._updateReplyCount(frame.parentID);

    if (debug.isEnabled()) {
      debug.trackElement(frame.interactionID || frame.id, interaction);
      debug.pushFrame(frame.interactionID || frame.id, frame);
    }
  }

  _updateRenderedFrame(frame) {
    if (!this._chatView || !this._chatView.shadowRoot)
      return;

    let existing = this._chatView.shadowRoot.querySelector(
      `kikx-interaction[data-frame-id="${frame.id}"]`,
    );

    if (!existing)
      return;

    // Update content for message-type frames
    let messageContent = existing.querySelector('kikx-message-content');
    if (messageContent && frame.content) {
      let html = '';

      if (frame.content.html)
        html = frame.content.html;
      else if (frame.content.text)
        html = `<p>${this._escapeHTML(frame.content.text)}</p>`;

      if (html)
        messageContent.content = html;
    }
  }

  _renderUserMessage(text, parentID) {
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
    messageContent.content = `<p>${this._escapeHTML(text)}</p>`;

    interaction.appendChild(messageContent);
    this._chatView.appendInteraction(interaction);
  }

  _renderSystemError(message) {
    let interaction = document.createElement('kikx-interaction');
    interaction.setAttribute('alignment', 'agent');
    interaction.setAttribute('participant-name', 'System');
    interaction.setAttribute('participant-initials', '!');
    interaction.setAttribute('timestamp', formatTimestamp(new Date().toISOString()));

    let messageContent = document.createElement('kikx-message-content');
    messageContent.content = `<p style="color: var(--error-color, #ff4444);">${this._escapeHTML(message)}</p>`;

    interaction.appendChild(messageContent);
    this._chatView.appendInteraction(interaction);
  }

  _escapeHTML(text) {
    let div = document.createElement('div');
    div.textContent = text;

    return div.innerHTML;
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

    // Determine agent ID from session data (may be null for agent-less sessions)
    let agentID = null;
    if (this._currentSession)
      agentID = this._currentSession.dmAgentID || this._currentSession.agentID || this._currentSession.agentID;

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
  // Typing indicator
  // ---------------------------------------------------------------------------

  _showTypingIndicator(agentID) {
    this._removeTypingIndicator(agentID);

    let name = this._getAgentDisplayName(agentID);

    let interaction = document.createElement('kikx-interaction');
    interaction.setAttribute('alignment', 'agent');
    interaction.setAttribute('participant-name', name);
    interaction.setAttribute('participant-initials', getInitials(name));
    interaction.setAttribute('timestamp', formatTimestamp(new Date().toISOString()));

    if (agentID)
      interaction.setAttribute('data-agent-id', agentID);

    let dots = document.createElement('div');
    dots.className = 'typing-indicator';
    dots.innerHTML = '<span></span><span></span><span></span>';

    interaction.appendChild(dots);
    this._chatView.appendInteraction(interaction);

    let streamState = {
      typingIndicator:      interaction,
      typingDots:           dots,
      streamingInteraction: null,
      streamingContent:     null,
      streamingHTML:        '',
      streamingReflection:  null,
      reflectionText:       '',
    };

    // Store per-agent and legacy single-agent references
    if (agentID)
      this._agentStreams.set(agentID, streamState);

    this._typingIndicator      = interaction;
    this._typingDots           = dots;
    this._streamingHTML        = '';
    this._streamingInteraction = null;
    this._streamingContent     = null;
    this._streamingReflection  = null;
    this._reflectionText       = '';
  }

  _removeTypingIndicator(agentID) {
    if (agentID) {
      let streamState = this._agentStreams.get(agentID);
      if (streamState && streamState.typingIndicator) {
        streamState.typingIndicator.remove();
        streamState.typingIndicator = null;
        streamState.typingDots      = null;
      }
    }

    // Also clean up legacy single-agent indicator
    if (this._typingIndicator) {
      this._typingIndicator.remove();
      this._typingIndicator = null;
      this._typingDots      = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Streaming display
  // ---------------------------------------------------------------------------

  _handleStreamDelta(parsed) {
    let text    = (parsed.content && parsed.content.text) || '';
    let agentID = parsed.authorID || null;

    // Resolve per-agent stream state, falling back to legacy single-agent
    let streamState = (agentID && this._agentStreams.has(agentID))
      ? this._agentStreams.get(agentID)
      : null;

    let typingIndicator = (streamState) ? streamState.typingIndicator : this._typingIndicator;
    let typingDots      = (streamState) ? streamState.typingDots : this._typingDots;
    let streamContent   = (streamState) ? streamState.streamingContent : this._streamingContent;

    // First delta: promote typing indicator to streaming bubble
    if (typingIndicator && !streamContent) {
      // Remove typing dots
      if (typingDots) {
        typingDots.remove();
        if (streamState)
          streamState.typingDots = null;
        else
          this._typingDots = null;
      }

      // Create message-content inside the existing interaction bubble
      let messageContent = document.createElement('kikx-message-content');
      typingIndicator.appendChild(messageContent);

      if (streamState) {
        streamState.streamingInteraction = typingIndicator;
        streamState.streamingContent     = messageContent;
        streamState.typingIndicator      = null;
        streamState.streamingHTML        = '';
      }

      this._streamingInteraction = typingIndicator;
      this._streamingContent     = messageContent;
      this._typingIndicator      = null;
      this._streamingHTML        = '';

      if (parsed.interactionID)
        typingIndicator.setAttribute('data-interaction-id', parsed.interactionID);

      if (debug.isEnabled() && parsed.interactionID)
        debug.trackElement(parsed.interactionID, typingIndicator);

      streamContent = messageContent;
    }

    if (!streamContent)
      return;

    let html = (streamState) ? streamState.streamingHTML : this._streamingHTML;
    html += text;

    if (streamState)
      streamState.streamingHTML = html;

    this._streamingHTML = html;
    streamContent.content = html;

    if (debug.isEnabled() && parsed.interactionID)
      debug.setStreamDelta(parsed.interactionID, html);
  }

  _handleReflectionDelta(parsed) {
    let text    = (parsed.content && parsed.content.text) || '';
    let agentID = parsed.authorID || null;

    // Resolve per-agent stream state
    let streamState = (agentID && this._agentStreams.has(agentID))
      ? this._agentStreams.get(agentID)
      : null;

    let streamingReflection  = (streamState) ? streamState.streamingReflection : this._streamingReflection;
    let streamingInteraction = (streamState) ? streamState.streamingInteraction : this._streamingInteraction;
    let streamingContent     = (streamState) ? streamState.streamingContent : this._streamingContent;
    let typingIndicator      = (streamState) ? streamState.typingIndicator : this._typingIndicator;
    let typingDots           = (streamState) ? streamState.typingDots : this._typingDots;

    // First reflection delta: create reflection block inside streaming interaction
    if (!streamingReflection) {
      // Ensure we have a streaming interaction (promote typing indicator if needed)
      if (typingIndicator && !streamingInteraction) {
        if (typingDots) {
          typingDots.remove();
          if (streamState)
            streamState.typingDots = null;
          else
            this._typingDots = null;
        }

        streamingInteraction = typingIndicator;

        if (streamState) {
          streamState.streamingInteraction = typingIndicator;
          streamState.typingIndicator      = null;
        }

        this._streamingInteraction = typingIndicator;
        this._typingIndicator      = null;
      }

      if (!streamingInteraction)
        return;

      let reflectionBlock = document.createElement('kikx-reflection-block');
      if (streamingContent)
        streamingInteraction.insertBefore(reflectionBlock, streamingContent);
      else
        streamingInteraction.appendChild(reflectionBlock);

      streamingReflection = reflectionBlock;

      if (streamState) {
        streamState.streamingReflection = reflectionBlock;
        streamState.reflectionText      = '';
      }

      this._streamingReflection = reflectionBlock;
      this._reflectionText      = '';
    }

    let reflectionText = (streamState) ? streamState.reflectionText : this._reflectionText;
    reflectionText += text;

    if (streamState)
      streamState.reflectionText = reflectionText;

    this._reflectionText = reflectionText;
    streamingReflection.content = reflectionText;

    if (debug.isEnabled() && parsed.interactionID)
      debug.setReflectionDelta(parsed.interactionID, reflectionText);
  }

  _clearStreamingState(agentID) {
    if (agentID)
      this._agentStreams.delete(agentID);

    this._streamingInteraction = null;
    this._streamingContent     = null;
    this._streamingHTML        = '';
    this._streamingReflection  = null;
    this._reflectionText       = '';
  }

  // ---------------------------------------------------------------------------
  // Relay display — cross-session streaming
  // ---------------------------------------------------------------------------

  _handleRelayDelta(parsed) {
    let text              = (parsed.content && parsed.content.text) || '';
    let targetSessionID   = parsed.targetSessionID || '';
    let agentID           = parsed.authorID || null;
    let relayKey          = `relay:${targetSessionID}`;

    // Use relay key to track streaming state for relayed content
    let streamState = this._agentStreams.get(relayKey);

    if (!streamState) {
      // First relay delta: create a "via Session Y" streaming bubble
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

      streamState = {
        typingIndicator:      null,
        typingDots:           null,
        streamingInteraction: interaction,
        streamingContent:     messageContent,
        streamingHTML:        '',
        streamingReflection:  null,
        reflectionText:       '',
      };

      this._agentStreams.set(relayKey, streamState);
    }

    streamState.streamingHTML += text;
    streamState.streamingContent.content = streamState.streamingHTML;
  }

  // ---------------------------------------------------------------------------
  // Usage / cost tracking
  // ---------------------------------------------------------------------------

  _handleUsage({ interactionID, usage }) {
    if (!usage)
      return;

    // Set output tokens on the agent's interaction element (not the user's)
    let outputTokens = usage.outputTokens || 0;
    let agentInteraction = this._chatView.shadowRoot.querySelector(`kikx-interaction[alignment="agent"][data-interaction-id="${interactionID}"]`);

    if (agentInteraction && outputTokens > 0)
      agentInteraction.setAttribute('token-count', String(outputTokens));

    // Update costs in the store
    let cost         = estimateCost(usage);
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

      if (detail.agentID) {
        // Create (or reuse) a DM session with the selected agent
        result     = await getOrCreateDm(detail.agentID);
        let data   = (result && result.data) || result;
        newSession = data.session || data;

        // Override name if the user provided one
        if (detail.name && newSession && newSession.id) {
          let { updateSession } = await import('../../lib/api.mjs');
          await updateSession(newSession.id, { name: detail.name });
          newSession.name = detail.name;
        }
      } else {
        result     = await createSession({ name: detail.name });
        let data   = (result && result.data) || result;
        newSession = data.session || data;
      }

      // Add to store if not already present
      let existing = sessions.getAllSessions();
      if (!existing.some((s) => s.id === newSession.id))
        sessions.addSession(newSession);

      this._updateSessionsList();
      this._sessionModal.close();

      if (newSession && newSession.id)
        navigate(`/kikx/sessions/${newSession.id}`);
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
          navigate(`/kikx/sessions/${session.id}`);
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error('Failed to open DM session:', error);
      }
    }
  }

  _onSelectSession(event) {
    let { id } = event.detail || {};

    if (id)
      navigate(`/kikx/sessions/${id}`);
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
    let statusBar = this.shadowRoot.querySelector('kikx-status-bar');

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

    // Mark the permission UI as processed
    let permEl = event.target.closest('kikx-permission-request') || event.target;
    if (permEl && permEl.setAttribute)
      permEl.setAttribute('processed', '');

    try {
      // Pass decisions array as body to the unified endpoint
      let body = (Array.isArray(decisions) && decisions.length > 0) ? { decisions } : undefined;
      await approvePermission(sessionID, permissionID, body);
    } catch (error) {
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
    // Prompts live inside kikx-message-content's shadow DOM
    let messageContents = interaction.querySelectorAll('kikx-message-content');
    let answers         = {};

    for (let messageContent of messageContents) {
      let shadow = messageContent.shadowRoot;
      if (!shadow)
        continue;

      let prompts = shadow.querySelectorAll('kikx-hml-prompt');
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
      let shadow = messageContent.shadowRoot;
      if (!shadow)
        continue;

      let prompts = shadow.querySelectorAll('kikx-hml-prompt');
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

  async _onInteractionSubmit(event) {
    let interaction = this._findInteractionFromEvent(event);
    if (!interaction)
      return;

    let answers   = this._collectPromptValues(interaction);
    let sessionID = this.sessionID;

    if (!sessionID)
      return;

    let agentID = null;
    if (this._currentSession)
      agentID = this._currentSession.dmAgentID || this._currentSession.agentID || this._currentSession.agentID;

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

    let agentID = null;
    if (this._currentSession)
      agentID = this._currentSession.dmAgentID || this._currentSession.agentID || this._currentSession.agentID;

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
    if (!parentID || !this._chatView || !this._chatView.shadowRoot)
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
    let parentEl = this._chatView.shadowRoot.querySelector(
      `kikx-interaction[data-frame-id="${parentID}"]`,
    );

    if (parentEl)
      parentEl.setAttribute('reply-count', String(count));
  }
}

if (typeof customElements !== 'undefined')
  customElements.define('kikx-session-page', KikxSessionPage);

export default KikxSessionPage;
