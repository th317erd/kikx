'use strict';

/**
 * Hero Chat - Message Display Component
 *
 * Displays:
 * - Message list with user/assistant messages
 * - Tool use and results
 * - Streaming message support
 * - Scroll-to-bottom button
 */

import {
  HeroComponent,
  GlobalState,
  DynamicProperty,
} from '../hero-base.js';

// ============================================================================
// Helper Functions
// ============================================================================

function escapeHtml(text) {
  let div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatRelativeDate(dateString) {
  let date    = new Date(dateString);
  let now     = new Date();
  let diffMs  = now - date;
  let diffSec = Math.floor(diffMs / 1000);
  let diffMin = Math.floor(diffMs / 60000);
  let diffHr  = Math.floor(diffMs / 3600000);
  let diffDay = Math.floor(diffMs / 86400000);

  // Up to 2 days: use "x units ago" format
  if (diffSec < 60) return 'just now';
  if (diffMin < 60) return `${diffMin} minute${(diffMin === 1) ? '' : 's'} ago`;
  if (diffHr < 24) return `${diffHr} hour${(diffHr === 1) ? '' : 's'} ago`;
  if (diffDay < 2) return (diffDay === 1) ? 'yesterday' : `${diffDay} days ago`;

  // Beyond 2 days: show actual date/time
  let timeStr = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  let dateStr = date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
  return `${dateStr} ${timeStr}`;
}

function formatTokenCount(tokens) {
  if (tokens < 1000) return tokens.toString();
  if (tokens < 10000) return (tokens / 1000).toFixed(1) + 'k';
  return Math.round(tokens / 1000) + 'k';
}

// ============================================================================
// HeroChat Component
// ============================================================================

export class HeroChat extends HeroComponent {
  static tagName = 'hero-chat';

  // Component state (session-level)
  #showHiddenMessages = false;
  #streamingMessage = null;
  #unsubscribers = [];
  #scrollThreshold = 150;

  // Frame state is owned by session-frames-provider (SINGLE SOURCE OF TRUTH)
  // This component reads from provider.frames and provider.compiled

  // Debounce state
  #renderDebounceTimer = null;
  #renderMaxWaitTimer = null;
  #renderPending = false;
  #RENDER_DEBOUNCE_MS = 16;
  #RENDER_MAX_WAIT_MS = 100;

  // Scroll state - Intent-based (tracks if user scrolled away to read)
  #resizeObserver = null;
  #lastScrollTop = 0;
  #lastScrollHeight = 0;
  #userScrolledAway = false;  // TRUE = user scrolled up to read, don't auto-scroll

  // Infinite scroll state
  #loadingOlder = false;
  #scrollTopThreshold = 100;  // pixels from top to trigger loading

  // ---------------------------------------------------------------------------
  // Shadow DOM
  // ---------------------------------------------------------------------------

  createShadowDOM() {
    return this.attachShadow({ mode: 'open' });
  }

  // ---------------------------------------------------------------------------
  // Provider Access
  // ---------------------------------------------------------------------------

  /**
   * Get the parent session-frames-provider.
   * @returns {Element|null}
   */
  get framesProvider() {
    // Look for provider in ancestors (light DOM parent since hero-chat is in shadow DOM of chat view)
    return this.closest('session-frames-provider') ||
           document.getElementById('session-frames');
  }

  // ---------------------------------------------------------------------------
  // Accessors
  // ---------------------------------------------------------------------------

  /**
   * Get visible messages (filtered by hidden state).
   * Reads from session-frames-provider (SINGLE SOURCE OF TRUTH).
   * @returns {Array}
   */
  get visibleMessages() {
    let messages = [];
    const provider = this.framesProvider;

    // Read from provider (single source of truth)
    if (provider && provider.frames) {
      const frames = provider.frames.valueOf();
      const compiled = provider.compiled ? provider.compiled.valueOf() : new Map();

      if (frames && frames.length > 0) {
        // Filter out UPDATE frames only — COMPACT frames are displayed as summary dividers
        const displayableFrames = frames.filter((f) =>
          f.type !== 'update'
        );

        // Convert frames to message format for rendering
        if (typeof window.framesToMessages === 'function') {
          messages = window.framesToMessages(displayableFrames, compiled);
        } else {
          messages = displayableFrames.map((f) => this._frameToMessage(f, compiled));
        }
      }
    }

    return (this.#showHiddenMessages)
      ? messages
      : messages.filter((m) => !m.hidden);
  }

  /**
   * Convert a single frame to message format.
   * @param {object} frame
   * @param {Map} compiled - Compiled payloads map from provider
   * @returns {object}
   */
  _frameToMessage(frame, compiled) {
    // Compact frames → divider messages with summary context
    if (frame.type === 'compact') {
      return {
        id:        frame.id,
        type:      'compact',
        role:      'system',
        context:   frame.payload?.context || '',
        frameId:   frame.id,
        createdAt: frame.timestamp,
      };
    }

    // Get payload from compiled map, fall back to frame payload
    const payload = (compiled instanceof Map && compiled.get(frame.id)) || frame.payload || {};

    return {
      id:         frame.id,
      role:       payload.role || ((frame.authorType === 'user') ? 'user' : 'assistant'),
      content:    payload.content || '',
      hidden:     payload.hidden || false,
      type:       frame.type,
      authorType: frame.authorType,
      createdAt:  frame.timestamp,
      frameId:    frame.id,
    };
  }

  /**
   * Get current session.
   * @returns {object|null}
   */
  get session() {
    return GlobalState.currentSession.valueOf();
  }

  /**
   * Get agent name for labels.
   * @returns {string}
   */
  get agentName() {
    return this.session?.agent?.name || 'Assistant';
  }

  /**
   * Get agent avatar URL.
   * @returns {string|null}
   */
  get agentAvatarUrl() {
    return this.session?.agent?.avatarUrl || null;
  }

  /**
   * Get user avatar URL.
   * Generates a default SVG avatar for the current user.
   * @returns {string}
   */
  get userAvatarUrl() {
    let user     = GlobalState.user?.valueOf();
    let username = user?.username || 'You';
    let initial  = username.charAt(0).toUpperCase();
    let color    = '#6366f1';  // Indigo — distinct from agent palette
    return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" rx="20" fill="${color}"/><text x="20" y="26" font-family="Arial,sans-serif" font-size="18" font-weight="bold" fill="white" text-anchor="middle">${initial}</text></svg>`)}`;
  }

  /**
   * Get the messages container element (for external insertions).
   * @returns {HTMLElement|null}
   */
  get $messages() {
    return this.shadowRoot?.querySelector('.messages');
  }

  /**
   * Get the innerHTML of the messages container (for compatibility).
   * @returns {string}
   */
  get messagesHTML() {
    let msgs = this.$messages;
    return (msgs) ? msgs.innerHTML : '';
  }

  /**
   * Set innerHTML of the messages container (for compatibility).
   * @param {string} html
   */
  set messagesHTML(html) {
    let msgs = this.$messages;
    if (msgs) {
      msgs.innerHTML = html;
    }
  }

  /**
   * Insert HTML adjacent to messages (for compatibility with approval/question UI).
   * @param {string} position - 'beforeend', 'afterbegin', etc.
   * @param {string} html
   */
  insertMessagesHTML(position, html) {
    let msgs = this.$messages;
    if (msgs) {
      msgs.insertAdjacentHTML(position, html);
      this.scrollToBottom();
    }
  }

  /**
   * Append a child element to messages (for compatibility).
   * @param {Node} child
   * @returns {Node}
   */
  appendToMessages(child) {
    let msgs = this.$messages;
    if (msgs) {
      let result = msgs.appendChild(child);
      this.scrollToBottom();
      return result;
    }
    return child;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Component mounted.
   */
  mounted() {
    // Subscribe to session changes
    this.#unsubscribers.push(
      this.subscribeGlobal('currentSession', ({ value }) => {
        if (value) {
          this._loadSession(value);
        } else {
          this._clearSession();
        }
      })
    );

    // Setup scroll listener to continuously track if user is at bottom
    // This captures the state BEFORE any content changes
    this._setupScrollTracking();

    // WebSocket events are handled by session-frames-provider (SINGLE SOURCE OF TRUTH)
    // This component subscribes to provider's DynamicProperties for reactive updates

    // Subscribe to provider's frames AND compiled changes
    this._setupProviderSubscription();

    // Check if session already exists (subscription won't fire for existing value)
    const existingSession = this.session;
    if (existingSession) {
      this._loadSession(existingSession);
    } else {
      this.render();
    }
  }

  /**
   * Setup scroll tracking with INTENT-BASED approach.
   *
   * The key insight: track USER INTENT, not just position.
   * - If user scrolls UP → they want to read, STOP auto-scrolling
   * - If user scrolls DOWN to bottom → they want to follow, RESUME auto-scrolling
   * - Content growth only triggers scroll when user hasn't scrolled away
   */
  _setupScrollTracking() {
    const scrollHandler = (e) => {
      const container = this._getScrollContainer();
      if (!container) return;

      const currentScrollTop = container.scrollTop;
      const scrolledUp = currentScrollTop < this.#lastScrollTop;
      const atBottom = this.isNearBottom();

      // User scrolled UP and is not at bottom → they want to read
      if (scrolledUp && !atBottom) {
        this.#userScrolledAway = true;
      }

      // User reached the bottom → they want to follow new content
      if (atBottom) {
        this.#userScrolledAway = false;
      }

      // Infinite scroll: near top → load older frames
      if (currentScrollTop < this.#scrollTopThreshold && !this.#loadingOlder) {
        this._loadOlderFrames();
      }

      this.#lastScrollTop = currentScrollTop;
      this._updateScrollButton();
    };

    // Listen on both potential scroll containers
    this.addEventListener('scroll', scrollHandler);
    const chatMain = this.closest('.chat-main');
    if (chatMain) {
      chatMain.addEventListener('scroll', scrollHandler);
      this.#unsubscribers.push(() => chatMain.removeEventListener('scroll', scrollHandler));
    }
    this.#unsubscribers.push(() => this.removeEventListener('scroll', scrollHandler));

    // Initialize state
    this.#userScrolledAway = false;
    const container = this._getScrollContainer();
    this.#lastScrollTop = container ? container.scrollTop : 0;
    this.#lastScrollHeight = container ? container.scrollHeight : 0;

    // Setup ResizeObserver to detect content size changes
    this._setupResizeObserver();
  }

  /**
   * Setup ResizeObserver on the messages container.
   * When content grows and user hasn't scrolled away, auto-scroll.
   */
  _setupResizeObserver() {
    this.#resizeObserver = new ResizeObserver((entries) => {
      const container = this._getScrollContainer();
      if (!container) return;

      const newScrollHeight = container.scrollHeight;
      const heightGrew = newScrollHeight > this.#lastScrollHeight;

      // Only auto-scroll if:
      // 1. Content actually grew (not just a reflow)
      // 2. User hasn't scrolled away to read
      if (heightGrew && !this.#userScrolledAway) {
        this._executeScroll();
      }

      // Update tracked height
      this.#lastScrollHeight = newScrollHeight;
    });

    // Observe the shadow root for size changes
    requestAnimationFrame(() => {
      const container = this.shadowRoot?.querySelector('.messages-container');
      if (container) {
        this.#resizeObserver.observe(container);
      }
      this.#resizeObserver.observe(this);
    });
  }

  /**
   * Setup subscription to session-frames-provider.
   * Subscribes to compiled DynamicProperty only (single source of truth).
   * Called on mount and re-called if provider becomes available later.
   */
  _setupProviderSubscription() {
    const provider = this.framesProvider;
    if (!provider) {
      // Provider not ready yet, try again after a tick
      requestAnimationFrame(() => this._setupProviderSubscription());
      return;
    }

    const handler = () => {
      // Render on content changes - scroll is handled by _doRender based on
      // whether content grew AND user was already near bottom
      this.renderDebounced();
    };

    // Subscribe to compiled changes ONLY (not frames)
    // The compiled Map is updated after _recompile() which runs after every frame change
    // Subscribing to both would cause double-renders
    if (provider.compiled && typeof provider.compiled.addEventListener === 'function') {
      provider.compiled.addEventListener('update', handler);
      this.#unsubscribers.push(() => {
        provider.compiled.removeEventListener('update', handler);
      });
      this.debug('Subscribed to provider compiled updates');
    }
  }

  /**
   * Component unmounted.
   */
  unmounted() {
    for (const unsub of this.#unsubscribers) {
      unsub();
    }
    this.#unsubscribers = [];

    // WebSocket events handled by provider, no cleanup needed here

    if (this.#renderDebounceTimer) clearTimeout(this.#renderDebounceTimer);
    if (this.#renderMaxWaitTimer) clearTimeout(this.#renderMaxWaitTimer);
    if (this.#resizeObserver) {
      this.#resizeObserver.disconnect();
      this.#resizeObserver = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Session Management
  // ---------------------------------------------------------------------------

  /**
   * Load session data.
   * Frame loading is handled by session-frames-provider.
   * This just resets local state and triggers render.
   * @param {object} session
   */
  async _loadSession(session) {
    this.#streamingMessage = null;

    // Provider handles frame loading via GlobalState.currentSession subscription
    this.renderDebounced();

    // Force scroll to bottom when loading a new session
    // Multiple delays to catch async frame loading
    setTimeout(() => this.forceScrollToBottom(), 50);
    setTimeout(() => this.forceScrollToBottom(), 200);
    setTimeout(() => this.forceScrollToBottom(), 500);
  }

  /**
   * Clear session state.
   */
  _clearSession() {
    this.#streamingMessage = null;
    this.render();
  }

  // ---------------------------------------------------------------------------
  // Public Methods
  // ---------------------------------------------------------------------------

  /**
   * Set streaming message state.
   * @param {object|null} streaming
   */
  setStreaming(streaming) {
    this.#streamingMessage = streaming;
    // Let content growth detection handle scrolling
    this.renderDebounced();
  }

  /**
   * Toggle show hidden messages.
   */
  toggleHiddenMessages() {
    this.#showHiddenMessages = !this.#showHiddenMessages;
    this.render();
  }

  /**
   * Set show hidden messages state explicitly.
   * @param {boolean} show - Whether to show hidden messages
   */
  setShowHiddenMessages(show) {
    if (this.#showHiddenMessages === show)
      return;

    this.#showHiddenMessages = show;
    this.render();
  }

  // ---------------------------------------------------------------------------
  // Frame Management (delegates to session-frames-provider)
  // ---------------------------------------------------------------------------

  /**
   * Set phantom frame for streaming (before message is persisted).
   * Delegates to provider.
   * @param {object|null} phantom - Phantom frame data
   */
  setPhantomFrame(phantom) {
    const provider = this.framesProvider;
    if (provider && typeof provider.setPhantomFrame === 'function') {
      provider.setPhantomFrame(phantom);
    }
    // Let content growth detection handle scrolling during streaming
    this.renderDebounced();
  }

  /**
   * Get the current phantom frame.
   * Delegates to provider.
   * @returns {object|null}
   */
  getPhantomFrame() {
    const provider = this.framesProvider;
    return (provider) ? provider.phantomFrame : null;
  }

  /**
   * Finalize phantom frame (mark as complete).
   * Delegates to provider.
   */
  finalizePhantomFrame() {
    const provider = this.framesProvider;
    if (provider && typeof provider.finalizePhantomFrame === 'function') {
      provider.finalizePhantomFrame();
    }
    // ResizeObserver will handle scrolling when content changes
    this.renderDebounced();
  }

  /**
   * Get all frames from provider.
   * @returns {Array}
   */
  getFrames() {
    const provider = this.framesProvider;
    return (provider && provider.frames) ? provider.frames.valueOf() : [];
  }

  /**
   * Get the last known timestamp from provider.
   * @returns {string|null}
   */
  getLastTimestamp() {
    const provider = this.framesProvider;
    return (provider) ? provider.getLastTimestamp() : null;
  }

  /**
   * Add an optimistic frame (for user messages before WebSocket confirmation).
   * Delegates to provider.
   * @param {object} frame
   */
  addOptimisticFrame(frame) {
    const provider = this.framesProvider;
    if (provider && typeof provider.addOptimisticFrame === 'function') {
      provider.addOptimisticFrame(frame);
    }
  }

  // ---------------------------------------------------------------------------
  // Scroll Management
  // ---------------------------------------------------------------------------

  /**
   * Get the scrollable container.
   * Returns the element that actually has scrollable overflow.
   * @returns {HTMLElement}
   */
  _getScrollContainer() {
    // Check if hero-chat itself has overflow (scrollHeight > clientHeight)
    if (this.scrollHeight > this.clientHeight) {
      return this;
    }

    // Otherwise check parent .chat-main
    const chatMain = this.closest('.chat-main');
    if (chatMain && chatMain.scrollHeight > chatMain.clientHeight) {
      return chatMain;
    }

    // Default to self
    return this;
  }

  /**
   * Check if near bottom of scroll.
   * @returns {boolean}
   */
  isNearBottom() {
    let container = this._getScrollContainer();
    if (!container) return true;
    return container.scrollHeight - container.scrollTop - container.clientHeight < this.#scrollThreshold;
  }

  /**
   * Scroll to bottom if user hasn't scrolled away.
   */
  scrollToBottom() {
    if (!this.#userScrolledAway) {
      this._executeScroll();
    }
  }

  /**
   * Force scroll to bottom immediately.
   * Use for explicit user actions (send message, load session, click scroll button).
   */
  forceScrollToBottom() {
    // User explicitly wants to go to bottom → resume auto-scrolling
    this.#userScrolledAway = false;
    this._executeScroll();
  }

  /**
   * Actually perform the scroll operation.
   */
  _executeScroll() {
    const container = this._getScrollContainer();
    if (container) {
      container.scrollTop = container.scrollHeight;
      // Update tracked positions
      this.#lastScrollTop = container.scrollTop;
      this.#lastScrollHeight = container.scrollHeight;
    }
    this._updateScrollButton();
  }

  /**
   * Update scroll button visibility.
   */
  _updateScrollButton() {
    let button = this.shadowRoot?.querySelector('.scroll-to-bottom');
    if (button) {
      button.style.display = this.isNearBottom() ? 'none' : 'flex';
    }
  }

  /**
   * Load older frames when scrolling near the top (infinite scroll).
   * Preserves scroll position so content doesn't jump.
   */
  async _loadOlderFrames() {
    const provider = this.framesProvider;
    if (!provider || !provider.hasOlderFrames || provider.loadingOlder)
      return;

    this.#loadingOlder = true;

    // Show loading indicator at top
    this._showTopLoader(true);

    // Capture scroll state before loading
    const container    = this._getScrollContainer();
    const scrollHeight = container ? container.scrollHeight : 0;

    try {
      const result = await provider.loadOlderFrames(50);

      if (result.loaded > 0) {
        // Restore scroll position: maintain offset from where user was reading
        requestAnimationFrame(() => {
          if (container) {
            const newScrollHeight = container.scrollHeight;
            const heightDiff      = newScrollHeight - scrollHeight;
            container.scrollTop  += heightDiff;
          }
        });
      }
    } finally {
      this.#loadingOlder = false;
      this._showTopLoader(false);
    }
  }

  /**
   * Show or hide the loading indicator at the top of messages.
   * @param {boolean} show
   */
  _showTopLoader(show) {
    let container = this.shadowRoot?.querySelector('.messages-container');
    if (!container) return;

    let loader = container.querySelector('.infinite-scroll-loader');

    if (show && !loader) {
      let loaderEl = document.createElement('div');
      loaderEl.className = 'infinite-scroll-loader';
      loaderEl.innerHTML = '<span class="loader-dot"></span><span class="loader-dot"></span><span class="loader-dot"></span>';
      container.insertBefore(loaderEl, container.firstChild);
    } else if (!show && loader) {
      loader.remove();
    }
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  /**
   * Debounced render to prevent rapid re-renders.
   */
  renderDebounced() {
    if (this.#renderDebounceTimer) {
      clearTimeout(this.#renderDebounceTimer);
    }

    if (!this.#renderPending) {
      this.#renderPending = true;
      this.#renderMaxWaitTimer = setTimeout(() => {
        this._doRender();
      }, this.#RENDER_MAX_WAIT_MS);
    }

    this.#renderDebounceTimer = setTimeout(() => {
      this._doRender();
    }, this.#RENDER_DEBOUNCE_MS);
  }

  /**
   * Actual render implementation.
   * Scroll is handled by ResizeObserver, not timers.
   */
  _doRender() {
    this.#renderPending = false;

    if (this.#renderDebounceTimer) {
      clearTimeout(this.#renderDebounceTimer);
      this.#renderDebounceTimer = null;
    }
    if (this.#renderMaxWaitTimer) {
      clearTimeout(this.#renderMaxWaitTimer);
      this.#renderMaxWaitTimer = null;
    }

    this.render();

    // ResizeObserver will handle scrolling when content size changes
  }

  /**
   * Render the component.
   * Uses ID-based reconciliation to preserve elements across renders.
   */
  render() {
    const session = this.session;

    if (!session) {
      // Render empty state
      this.shadowRoot.innerHTML = `
        ${this._getStyles()}
        <div class="messages messages-container">
          <div class="no-session">Select a session to start chatting</div>
        </div>
      `;
      return;
    }

    // Ensure styles and container exist
    this._ensureStructure();

    const container = this.shadowRoot.querySelector('.messages-container');
    if (!container) return;

    // Get current messages
    const messages = this.visibleMessages;

    // ID-based reconciliation: preserve existing elements
    this._reconcileMessages(container, messages);

    // Handle phantom frame (streaming)
    this._reconcilePhantom(container);

    // Update scroll button visibility after DOM settles
    requestAnimationFrame(() => {
      this._updateScrollButton();
    });
  }

  /**
   * Ensure shadow DOM has base structure (styles, container, scroll button).
   */
  _ensureStructure() {
    // Check if structure exists
    const container = this.shadowRoot.querySelector('.messages-container');
    if (container) {
      // Remove any .no-session element left over from empty state
      const noSession = container.querySelector('.no-session');
      if (noSession) {
        noSession.remove();
      }
      return;
    }

    // Create initial structure
    this.shadowRoot.innerHTML = `
      ${this._getStyles()}
      <div class="messages messages-container"></div>
      <button class="scroll-to-bottom" style="display: none">↓</button>
    `;

    // Bind scroll button
    const scrollBtn = this.shadowRoot.querySelector('.scroll-to-bottom');
    if (scrollBtn) {
      scrollBtn.onclick = () => this.forceScrollToBottom();
    }

    // Ensure ResizeObserver is watching the new container
    const newContainer = this.shadowRoot.querySelector('.messages-container');
    if (newContainer && this.#resizeObserver) {
      this.#resizeObserver.observe(newContainer);
    }
  }

  /**
   * Reconcile messages using ID-based DOM preservation.
   * Preserves existing elements, only creates new ones as needed.
   * @param {HTMLElement} container
   * @param {Array} messages
   */
  _reconcileMessages(container, messages) {
    // Build map of existing elements by frame ID
    const existing = new Map();
    container.querySelectorAll('[data-frame-id]').forEach((el) => {
      existing.set(el.dataset.frameId, el);
    });

    // Track which IDs we've seen
    const seenIds = new Set();

    // Process each message in order
    let insertionPoint = container.firstChild;

    for (const message of messages) {
      const frameId = message.frameId || message.id;
      if (!frameId) continue;

      seenIds.add(frameId);

      let element = existing.get(frameId);

      if (element) {
        // Existing element - update content if needed
        this._updateMessageElement(element, message);

        // Ensure correct position
        if (element !== insertionPoint) {
          container.insertBefore(element, insertionPoint);
        }
        insertionPoint = element.nextSibling;
      } else {
        // New element - create and insert
        element = this._createMessageElement(message, frameId);
        if (!element) continue; // Skip if element creation failed (e.g. empty content)
        container.insertBefore(element, insertionPoint);
        insertionPoint = element.nextSibling;
      }
    }

    // Remove elements that no longer exist in messages
    existing.forEach((el, id) => {
      if (!seenIds.has(id)) {
        el.remove();
      }
    });
  }

  /**
   * Create a message element from scratch.
   * @param {object} message
   * @param {string} frameId
   * @returns {HTMLElement}
   */
  _createMessageElement(message, frameId) {
    const html = this._renderMessage(message);
    const template = document.createElement('template');
    template.innerHTML = html.trim();
    const element = template.content.firstChild;

    // Ensure data-frame-id is set
    if (element && !element.dataset.frameId) {
      element.dataset.frameId = frameId;
    }

    // Initialize hml-prompt elements inside
    queueMicrotask(() => {
      if (element) {
        element.querySelectorAll('hml-prompt').forEach((prompt) => {
          if (typeof prompt.render === 'function' && prompt.shadowRoot && !prompt.shadowRoot.innerHTML) {
            prompt._renderCount = 0;
            prompt._isRendering = false;
            prompt.render();
          }
        });

        // Add batch prompt buttons if message has multiple prompts
        this._addPromptBatchButtons(element, frameId);
      }
    });

    return element;
  }

  /**
   * Add Ignore / Submit buttons for messages that have 1+ hml-prompt elements.
   * Every message with prompts is a form — no per-prompt submit buttons.
   * @param {HTMLElement} element - The message element
   * @param {string} frameId - The frame/message ID
   */
  _addPromptBatchButtons(element, frameId) {
    let prompts = element.querySelectorAll('hml-prompt');
    if (prompts.length < 1)
      return;

    // Skip if all prompts are already answered
    let unanswered = Array.from(prompts).filter((p) => !p.isAnswered);
    if (unanswered.length === 0)
      return;

    // Find the pre-rendered footer-actions inside the bubble and reveal it
    let footerActions = element.querySelector('.footer-actions');
    if (!footerActions)
      return;

    footerActions.style.display = 'flex';

    // Wire click handlers on existing buttons
    let submitBtn = footerActions.querySelector('.prompt-batch-submit');
    let ignoreBtn = footerActions.querySelector('.prompt-batch-ignore');

    submitBtn.addEventListener('click', () => {
      if (typeof window.submitPromptBatch === 'function')
        window.submitPromptBatch(frameId);

      // Hide buttons after action
      footerActions.style.display = 'none';
    });

    ignoreBtn.addEventListener('click', () => {
      if (typeof window.ignorePromptBatch === 'function')
        window.ignorePromptBatch(frameId);

      // Mark prompts as ignored visually
      prompts.forEach((p) => p.setAttribute('ignored', ''));

      // Hide buttons after action
      footerActions.style.display = 'none';
    });

    // Setup Enter-to-tab-forward focus management
    this._setupPromptFocusChain(element, prompts, submitBtn);
  }

  /**
   * Setup focus chain: Enter on a prompt advances to the next prompt,
   * last prompt advances to the Submit button, Enter on Submit fires it.
   * @param {HTMLElement} element - The message element
   * @param {NodeList} prompts - The hml-prompt elements
   * @param {HTMLElement} submitBtn - The Submit button
   */
  _setupPromptFocusChain(element, prompts, submitBtn) {
    let promptList = Array.from(prompts);

    element.addEventListener('prompt-tab-forward', (e) => {
      let fromId = e.detail?.promptId;
      let index = promptList.findIndex((p) => p.promptId === fromId);

      if (index < 0) return;

      // Find next unanswered prompt
      for (let i = index + 1; i < promptList.length; i++) {
        if (!promptList[i].isAnswered) {
          this._focusPromptInput(promptList[i]);
          return;
        }
      }

      // No more prompts — focus the Submit button
      submitBtn.focus();
    });

    // Enter on Submit button fires submit
    submitBtn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submitBtn.click();
      }
    });
  }

  /**
   * Focus the first focusable input inside an hml-prompt.
   * Uses the prompt's public focusInput() API.
   * @param {HTMLElement} prompt - The hml-prompt element
   */
  _focusPromptInput(prompt) {
    if (typeof prompt.focusInput === 'function') {
      prompt.focusInput();
    }
  }

  /**
   * Update an existing message element's content.
   * Preserves hml-prompt elements with IDs.
   * @param {HTMLElement} element
   * @param {object} message
   */
  _updateMessageElement(element, message) {
    const bubble = element.querySelector('.message-bubble');
    if (!bubble) return;

    const contentDiv = bubble.querySelector('.message-content');
    if (!contentDiv) return;

    // Preserve hml-prompt elements by ID before update
    const preservedPrompts = new Map();
    contentDiv.querySelectorAll('hml-prompt[id]').forEach((p) => {
      preservedPrompts.set(p.id, p);
    });

    // Get new content HTML
    const newContent = this._renderContent(message);

    // Only update if content changed
    if (contentDiv.innerHTML !== newContent) {
      // Parse new content
      const template = document.createElement('template');
      template.innerHTML = newContent;

      // Restore preserved prompts before inserting
      template.content.querySelectorAll('hml-prompt[id]').forEach((placeholder) => {
        const preserved = preservedPrompts.get(placeholder.id);
        if (preserved) {
          placeholder.replaceWith(preserved);
        }
      });

      // Replace content
      contentDiv.innerHTML = '';
      contentDiv.appendChild(template.content);
    }
  }

  /**
   * Reconcile phantom frame element.
   * @param {HTMLElement} container
   */
  _reconcilePhantom(container) {
    const phantom = this.getPhantomFrame();
    let phantomEl = container.querySelector('#phantom-frame');

    if (phantom) {
      if (phantomEl) {
        // Update existing phantom
        const contentDiv = phantomEl.querySelector('.message-content');
        if (contentDiv) {
          const newContent = this._renderMarkup(phantom.payload?.content || '');
          if (contentDiv.innerHTML !== newContent) {
            contentDiv.innerHTML = newContent;
          }
        }
        // Update complete class
        if (phantom.complete) {
          phantomEl.classList.remove('streaming');
          phantomEl.classList.add('complete');
        } else {
          phantomEl.classList.remove('complete');
          phantomEl.classList.add('streaming');
        }
      } else {
        // Create phantom element
        const html = this._renderPhantomFrame(phantom);
        const template = document.createElement('template');
        template.innerHTML = html.trim();
        container.appendChild(template.content.firstChild);
      }
    } else if (this.#streamingMessage) {
      // Legacy streaming message support
      if (!phantomEl) {
        const html = this._renderStreamingMessage();
        const template = document.createElement('template');
        template.innerHTML = html.trim();
        container.appendChild(template.content.firstChild);
      }
    } else {
      // Remove phantom if no longer needed
      if (phantomEl) {
        phantomEl.remove();
      }
    }
  }

  /**
   * Get styles for shadow DOM.
   * @returns {string}
   */
  _getStyles() {
    return `<style>
      :host {
        display: block;
        flex: 1;
        /* Let parent .chat-main handle scrolling */
        overflow-y: visible;
        position: relative;
      }

      .messages-container {
        display: flex;
        flex-direction: column;
        gap: 16px;
        padding: 16px;
        min-height: 100%;
      }

      .no-session {
        display: flex;
        align-items: center;
        justify-content: center;
        height: 200px;
        color: var(--text-muted, #6b7280);
        font-size: 16px;
      }

      .message {
        display: flex;
        flex-direction: column;
        max-width: 85%;
      }

      .message-user { align-self: flex-end; }
      .message-assistant { align-self: flex-start; }

      .message-header {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 14px;
        font-weight: 700;
        color: rgba(255, 255, 255, 0.85);
        margin-bottom: 8px;
        padding-bottom: 6px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.06);
      }

      .message-avatar {
        width: 22px;
        height: 22px;
        border-radius: 50%;
        flex-shrink: 0;
      }

      .header-name {
        line-height: 22px;
      }

      .message-bubble {
        padding: 12px 16px;
        border-radius: var(--radius-lg, 12px);
        background: var(--bg-tertiary, #2a2a3e);
        color: var(--text-primary, #e0e0e0);
        word-wrap: break-word;
      }

      .message-user .message-bubble {
        background: var(--accent, #f472b6);
        color: white;
        border-bottom-right-radius: 4px;
      }

      .message-user .message-header {
        color: rgba(255, 255, 255, 0.85);
      }

      .message-user .message-footer {
        border-top-color: rgba(255, 255, 255, 0.15);
      }

      .message-user .footer-meta {
        color: rgba(255, 255, 255, 0.7);
      }

      .message-assistant .message-bubble {
        border-bottom-left-radius: 4px;
      }

      .message-hidden { opacity: 0.6; }
      .message-hidden .message-bubble {
        border: 1px dashed var(--border-color, #2d2d2d);
        background: transparent;
      }

      .message-queued .message-bubble {
        opacity: 0.7;
        border: 1px dashed var(--text-muted, #6b7280);
      }

      .queued-badge, .type-badge {
        font-size: 10px;
        padding: 2px 6px;
        border-radius: 10px;
        margin-left: 6px;
        text-transform: uppercase;
        font-weight: 500;
      }

      .queued-badge { background: var(--warning, #f59e0b); color: #1a1a2e; }
      .type-badge { background: var(--bg-secondary, #1a1a2e); color: var(--text-muted, #6b7280); }

      .message-error .message-bubble {
        background: rgba(248, 113, 113, 0.1);
        border: 1px solid var(--error, #f87171);
      }

      .streaming-error {
        display: flex;
        align-items: center;
        gap: 8px;
        color: var(--error, #f87171);
      }

      .error-icon { font-size: 18px; }

      .message-content { line-height: 1.5; }
      .message-content p { margin: 0 0 8px 0; }
      .message-content p:last-child { margin-bottom: 0; }

      .message-content code {
        background: rgba(0, 0, 0, 0.2);
        padding: 2px 6px;
        border-radius: 4px;
        font-family: monospace;
        font-size: 0.9em;
      }

      .message-content pre {
        background: rgba(0, 0, 0, 0.3);
        padding: 12px;
        border-radius: 6px;
        overflow-x: auto;
        margin: 8px 0;
      }

      .message-content pre code { background: none; padding: 0; }

      .message-footer {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-top: 8px;
        padding-top: 6px;
        border-top: 1px solid rgba(255, 255, 255, 0.06);
      }

      .footer-meta {
        font-size: 14px;
        font-weight: 700;
        color: rgba(255, 255, 255, 0.7);
      }

      .footer-actions {
        display: none;
        gap: 8px;
        align-items: center;
      }

      .tool-call {
        margin: 8px 0;
        border: 1px solid var(--border-color, #2d2d2d);
        border-radius: var(--radius-sm, 4px);
        overflow: hidden;
      }

      .tool-call-header {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 12px;
        background: var(--bg-secondary, #1a1a2e);
        font-weight: 500;
        font-size: 13px;
      }

      .tool-call-body { padding: 8px 12px; }
      .tool-call-section { margin-bottom: 8px; }
      .tool-call-section:last-child { margin-bottom: 0; }

      .tool-call-label {
        font-size: 11px;
        font-weight: 600;
        color: var(--text-muted, #6b7280);
        text-transform: uppercase;
        margin-bottom: 4px;
      }

      .tool-call-content {
        font-family: monospace;
        font-size: 12px;
        background: rgba(0, 0, 0, 0.2);
        padding: 8px;
        border-radius: 4px;
        white-space: pre-wrap;
        overflow-x: auto;
        max-height: 200px;
        overflow-y: auto;
      }

      .typing-indicator {
        display: none;
      }

      .streaming .typing-indicator {
        display: flex;
        gap: 4px;
        padding-top: 8px;
      }

      .complete .typing-indicator {
        display: none;
      }

      .typing-indicator span {
        width: 6px;
        height: 6px;
        background: var(--text-muted, #6b7280);
        border-radius: 50%;
        animation: typing 1.4s infinite;
      }

      .typing-indicator span:nth-child(2) { animation-delay: 0.2s; }
      .typing-indicator span:nth-child(3) { animation-delay: 0.4s; }

      @keyframes typing {
        0%, 60%, 100% { transform: translateY(0); }
        30% { transform: translateY(-4px); }
      }

      .scroll-to-bottom {
        position: absolute;
        bottom: 20px;
        right: 20px;
        width: 40px;
        height: 40px;
        border-radius: 50%;
        background: var(--accent, #f472b6);
        color: white;
        border: none;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 18px;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
        transition: transform 0.2s, opacity 0.2s;
        z-index: 100;
      }

      .scroll-to-bottom:hover { transform: scale(1.1); }

      /* REQUEST frame styles */
      .message-request {
        align-self: flex-start;
        max-width: 85%;
      }

      .request-frame {
        background: var(--bg-tertiary, #2a2a3e);
        border: 1px solid var(--border-color, #3d3d5c);
        border-radius: var(--radius-sm, 8px);
        padding: 10px 14px;
      }

      .request-header {
        display: flex;
        align-items: center;
        gap: 8px;
        font-weight: 600;
        font-size: 13px;
        color: var(--text-primary, #e0e0e0);
      }

      .request-icon {
        font-size: 16px;
      }

      .request-label {
        color: var(--accent, #f472b6);
      }

      .request-content {
        margin-top: 8px;
        font-size: 13px;
        color: var(--text-secondary, #a0a0b0);
        font-family: monospace;
        word-break: break-all;
      }

      /* RESULT frame styles */
      .message-result {
        align-self: flex-start;
        max-width: 85%;
        margin-left: 24px;  /* Indent to show hierarchy */
      }

      .result-frame {
        background: var(--bg-secondary, #1a1a2e);
        border: 1px solid var(--border-color, #3d3d5c);
        border-radius: var(--radius-sm, 8px);
        padding: 10px 14px;
      }

      .result-success .result-frame {
        border-left: 3px solid var(--success, #10b981);
      }

      .result-error .result-frame {
        border-left: 3px solid var(--error, #f87171);
      }

      .result-header {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 12px;
        font-weight: 500;
        margin-bottom: 6px;
      }

      .result-success .result-header {
        color: var(--success, #10b981);
      }

      .result-error .result-header {
        color: var(--error, #f87171);
      }

      .result-icon {
        font-size: 14px;
      }

      .result-content {
        font-size: 12px;
        color: var(--text-secondary, #a0a0b0);
      }

      .result-content pre {
        margin: 0;
        white-space: pre-wrap;
        word-break: break-word;
        font-family: monospace;
        background: rgba(0, 0, 0, 0.2);
        padding: 8px;
        border-radius: 4px;
        max-height: 200px;
        overflow-y: auto;
      }

      .result-error-text {
        color: var(--error, #f87171);
      }

      /* COMPACT frame styles (compaction summary divider) */
      .message-compact {
        align-self: stretch;
        max-width: 100%;
      }

      .compact-frame {
        border: 1px dashed var(--border-color, #3d3d5c);
        border-radius: var(--radius-sm, 8px);
        overflow: hidden;
      }

      .compact-details summary {
        cursor: pointer;
        list-style: none;
      }

      .compact-details summary::-webkit-details-marker {
        display: none;
      }

      .compact-header {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 14px;
        font-size: 12px;
        color: var(--text-muted, #6b7280);
      }

      .compact-icon {
        font-size: 14px;
      }

      .compact-label {
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }

      .compact-time {
        margin-left: auto;
        font-size: 11px;
      }

      .compact-content {
        padding: 10px 14px;
        font-size: 12px;
        color: var(--text-secondary, #a0a0b0);
        line-height: 1.5;
        border-top: 1px dashed var(--border-color, #3d3d5c);
        max-height: 300px;
        overflow-y: auto;
      }

      .prompt-batch-submit,
      .prompt-batch-ignore {
        padding: 8px 16px;
        border-radius: var(--radius-sm, 4px);
        border: 1px solid var(--border-color, #3d3d5c);
        background: var(--bg-tertiary, #2a2a3e);
        color: var(--text-primary, #e0e0e0);
        font-size: 14px;
        font-weight: 500;
        cursor: pointer;
        transition: background 0.15s;
      }

      .prompt-batch-submit {
        background: var(--accent, #f472b6);
        border-color: var(--accent, #f472b6);
        color: white;
      }

      .prompt-batch-submit:hover {
        opacity: 0.9;
      }

      .prompt-batch-ignore:hover {
        background: var(--bg-secondary, #1a1a2e);
      }

      /* Infinite scroll loader */
      .infinite-scroll-loader {
        display: flex;
        justify-content: center;
        align-items: center;
        gap: 6px;
        padding: 16px;
      }

      .loader-dot {
        width: 8px;
        height: 8px;
        background: var(--text-muted, #6b7280);
        border-radius: 50%;
        animation: loader-bounce 1.4s infinite;
      }

      .loader-dot:nth-child(2) { animation-delay: 0.2s; }
      .loader-dot:nth-child(3) { animation-delay: 0.4s; }

      @keyframes loader-bounce {
        0%, 60%, 100% { transform: translateY(0); opacity: 0.4; }
        30% { transform: translateY(-6px); opacity: 1; }
      }
    </style>`;
  }

  /**
   * Render a single message.
   * @param {object} message
   * @returns {string}
   */
  _renderMessage(message) {
    // Handle COMPACT frames (compaction summary divider)
    if (message.type === 'compact') {
      return this._renderCompactFrame(message);
    }

    // Handle REQUEST frames (interaction requests like websearch)
    if (message.type === 'request') {
      return this._renderRequestFrame(message);
    }

    // Handle RESULT frames (interaction results)
    if (message.type === 'result') {
      return this._renderResultFrame(message);
    }

    const isPermissionPrompt = (message.content || '').includes('<hml-prompt');
    const roleClass   = (message.role === 'user') ? 'message-user' : 'message-assistant';
    const roleLabel   = (message.role === 'user') ? 'You' : (isPermissionPrompt ? '&#9889; Permission Request' : this.agentName);
    const messageId   = message.id || '';
    const frameId     = message.frameId || messageId;
    const queuedClass = (message.queued) ? ' message-queued' : '';
    const hiddenClass = (message.hidden) ? ' message-hidden' : '';
    const errorClass  = (message.type === 'error') ? ' message-error' : '';

    // Type badge for hidden messages
    let typeBadge = '';
    if (message.hidden && message.type) {
      const typeLabels = { system: 'System', interaction: 'Interaction', feedback: 'Feedback' };
      const label = typeLabels[message.type] || message.type;
      typeBadge = `<span class="type-badge type-${message.type}">${label}</span>`;
    }

    const queuedBadge = (message.queued) ? '<span class="queued-badge">Queued</span>' : '';

    // Avatar for both user and assistant messages (skip for permission prompts)
    let avatarUrl = '';
    if (isPermissionPrompt) {
      // No avatar for permission prompts — the lightning bolt in the label is enough
    } else if (message.role === 'user') {
      avatarUrl = this.userAvatarUrl;
    } else if (this.agentAvatarUrl) {
      avatarUrl = this.agentAvatarUrl;
    }
    let avatarHtml = (avatarUrl)
      ? `<img class="message-avatar" src="${this._escapeAttr(avatarUrl)}" alt="">`
      : '';

    // Render content
    const contentHtml = this._renderContent(message);

    // Render attachments
    const attachmentsHtml = this._renderAttachments(message);

    // Token estimate + footer
    const tokenEstimate = this._estimateTokens(message);
    const footerHtml = this._renderFooter(message, tokenEstimate);

    return `
      <div class="message ${roleClass}${queuedClass}${hiddenClass}${errorClass}"
           data-message-id="${messageId}"
           data-frame-id="${frameId}"
           id="${(messageId) ? `message-${messageId}` : ''}">
        <div class="message-bubble">
          <div class="message-header">${avatarHtml}<span class="header-name">${roleLabel}</span> ${queuedBadge}${typeBadge}</div>
          <div class="message-content">${contentHtml}</div>
          ${attachmentsHtml}
          ${footerHtml}
        </div>
      </div>
    `;
  }

  /**
   * Render a REQUEST frame (interaction request like websearch).
   * @param {object} message
   * @returns {string}
   */
  _renderRequestFrame(message) {
    let action = message.action || 'action';
    let data   = message.data || {};

    // Get display label based on action type
    let actionLabels = {
      websearch:    'Web Search',
      read_file:    'Read File',
      write_file:   'Write File',
      bash:         'Command',
      ask_user:     'Question',
    };
    let actionLabel = actionLabels[action] || action;

    // Get icon based on action type
    let actionIcons = {
      websearch:    '🔍',
      read_file:    '📄',
      write_file:   '✏️',
      bash:         '💻',
      ask_user:     '❓',
    };
    let icon = actionIcons[action] || '⚡';

    // Get display content (query, filename, etc.)
    let displayContent = data.query || data.url || data.path || data.command || '';
    if (displayContent.length > 100) {
      displayContent = displayContent.slice(0, 100) + '...';
    }

    return `
      <div class="message message-request" data-message-id="${message.id}" data-frame-id="${message.frameId}">
        <div class="request-frame">
          <div class="request-header">
            <span class="request-icon">${icon}</span>
            <span class="request-label">${escapeHtml(actionLabel)}</span>
          </div>
          ${(displayContent) ? `<div class="request-content">${escapeHtml(displayContent)}</div>` : ''}
        </div>
      </div>
    `;
  }

  /**
   * Render a RESULT frame (interaction result).
   * @param {object} message
   * @returns {string}
   */
  _renderResultFrame(message) {
    let result = message.result || {};
    let status = result.status || 'completed';
    let data   = result.data || result;

    // Determine if success or failure
    let isSuccess = (status === 'completed');

    // Hide successful result frames — the REQUEST frame already shows what happened.
    // Only show failures so errors are visible.
    if (isSuccess)
      return '';

    // Format the error content
    let contentHtml = '';
    if (typeof data === 'string') {
      contentHtml = escapeHtml(data);
    } else if (data.error) {
      contentHtml = `<span class="result-error-text">Error: ${escapeHtml(data.error)}</span>`;
    } else if (data.content) {
      let content = data.content;
      if (content.length > 500)
        content = content.slice(0, 500) + '\n... [truncated]';
      contentHtml = escapeHtml(content);
    } else {
      contentHtml = escapeHtml(JSON.stringify(data, null, 2).slice(0, 300));
    }

    return `
      <div class="message message-result result-error" data-message-id="${message.id}" data-frame-id="${message.frameId}">
        <div class="result-frame">
          <div class="result-header">
            <span class="result-icon">✗</span>
            <span class="result-status">Failed</span>
          </div>
          <div class="result-content"><pre>${contentHtml}</pre></div>
        </div>
      </div>
    `;
  }

  /**
   * Render a COMPACT frame (compaction summary divider).
   * Shows a collapsible card so the user knows compaction happened.
   * @param {object} message
   * @returns {string}
   */
  _renderCompactFrame(message) {
    const context = message.context || '';
    const timeStr = (message.createdAt) ? formatRelativeDate(message.createdAt) : '';

    return `
      <div class="message message-compact" data-message-id="${message.id}" data-frame-id="${message.frameId}">
        <div class="compact-frame">
          <details class="compact-details">
            <summary class="compact-header">
              <span class="compact-icon">&#x1F5DC;&#xFE0F;</span>
              <span class="compact-label">Conversation compacted</span>
              ${(timeStr) ? `<span class="compact-time">${timeStr}</span>` : ''}
            </summary>
            <div class="compact-content">${escapeHtml(context).replace(/\n/g, '<br>')}</div>
          </details>
        </div>
      </div>
    `;
  }

  /**
   * Render message content.
   * @param {object} message
   * @returns {string}
   */
  _renderContent(message) {
    // Error messages
    if (message.type === 'error') {
      const errorText = (typeof message.content === 'string') ? message.content : 'An error occurred';
      return `
        <div class="streaming-error">
          <span class="error-icon">⚠</span>
          <span class="error-text">${escapeHtml(errorText)}</span>
        </div>
      `;
    }

    // User messages: ESCAPE HTML (don't parse/sanitize)
    // User's own messages should display exactly as typed, with < > & etc escaped
    if (message.role === 'user') {
      if (typeof message.content === 'string') {
        return escapeHtml(message.content).replace(/\n/g, '<br>');
      }
      if (Array.isArray(message.content)) {
        let html = '';
        for (const block of message.content) {
          if (block.type === 'text') {
            html += escapeHtml(block.text).replace(/\n/g, '<br>');
          }
        }
        return html;
      }
      return '';
    }

    // Assistant/system messages: parse as HTML/HML markup
    if (typeof message.content === 'string') {
      return this._renderMarkup(message.content);
    }

    // Array content (Claude API format)
    if (Array.isArray(message.content)) {
      let html = '';
      for (const block of message.content) {
        if (block.type === 'text') {
          html += this._renderMarkup(block.text);
        } else if (block.type === 'tool_use') {
          html += this._renderToolUse(block);
        } else if (block.type === 'tool_result') {
          html += this._renderToolResult(block);
        }
      }
      return html;
    }

    return '';
  }

  /**
   * Render markup using HML renderer.
   * @param {string} text
   * @returns {string}
   */
  _renderMarkup(text) {
    // Use global renderMarkup from markup.js if available
    if (typeof window.renderMarkup === 'function') {
      return window.renderMarkup(text);
    }
    // Fallback: escape HTML
    return escapeHtml(text).replace(/\n/g, '<br>');
  }

  /**
   * Render file/image attachments for a message.
   * @param {object} message
   * @returns {string}
   */
  _renderAttachments(message) {
    let attachments = message.attachments || message.uploads;
    if (!attachments || !Array.isArray(attachments) || attachments.length === 0)
      return '';

    let items = attachments.map((a) => {
      let isImage = a.mimeType && a.mimeType.startsWith('image/');
      let url     = a.url || `/api/uploads/${a.id}`;

      if (isImage) {
        return `<a href="${this._escapeAttr(url)}" target="_blank" rel="noopener">
          <img class="attachment-image" src="${this._escapeAttr(url)}" alt="${escapeHtml(a.originalName || a.filename || 'image')}" loading="lazy">
        </a>`;
      }

      return `<a class="attachment-file" href="${this._escapeAttr(url)}" target="_blank" rel="noopener">
        📎 ${escapeHtml(a.originalName || a.filename || 'file')}
      </a>`;
    });

    return `<div class="message-attachments">${items.join('')}</div>`;
  }

  /**
   * Escape a string for use in an HTML attribute.
   * @param {string} str
   * @returns {string}
   */
  _escapeAttr(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /**
   * Render tool use block.
   * @param {object} block
   * @returns {string}
   */
  _renderToolUse(block) {
    return `
      <div class="tool-call">
        <div class="tool-call-header">
          <span class="tool-call-icon">⚙</span>
          <span>Tool: ${escapeHtml(block.name)}</span>
        </div>
        <div class="tool-call-body">
          <div class="tool-call-section">
            <div class="tool-call-label">Input</div>
            <div class="tool-call-content">${escapeHtml(JSON.stringify(block.input, null, 2))}</div>
          </div>
        </div>
      </div>
    `;
  }

  /**
   * Render tool result block.
   * @param {object} block
   * @returns {string}
   */
  _renderToolResult(block) {
    return `
      <div class="tool-call">
        <div class="tool-call-body">
          <div class="tool-call-section">
            <div class="tool-call-label">Result</div>
            <div class="tool-call-content">${escapeHtml(block.content)}</div>
          </div>
        </div>
      </div>
    `;
  }

  /**
   * Render streaming message (legacy support).
   * @returns {string}
   */
  _renderStreamingMessage() {
    let streaming = this.#streamingMessage;

    let agentAvatar = (this.agentAvatarUrl)
      ? `<img class="message-avatar" src="${this._escapeAttr(this.agentAvatarUrl)}" alt="">`
      : '';

    return `
      <div class="message message-assistant streaming" id="streaming-message">
        <div class="message-bubble">
          <div class="message-header">${agentAvatar}<span class="header-name">${this.agentName}</span></div>
          <div class="message-content">${this._renderMarkup(streaming.content || '')}</div>
          <div class="typing-indicator">
            <span></span><span></span><span></span>
          </div>
        </div>
      </div>
    `;
  }

  /**
   * Render phantom frame (in-progress streaming message).
   * @param {object} phantom - The phantom frame
   * @returns {string}
   */
  _renderPhantomFrame(phantom) {
    if (!phantom) return '';

    const content = phantom.payload?.content || '';
    const isComplete = phantom.complete || false;
    const completeClass = (isComplete) ? 'complete' : 'streaming';

    let agentAvatar = (this.agentAvatarUrl)
      ? `<img class="message-avatar" src="${this._escapeAttr(this.agentAvatarUrl)}" alt="">`
      : '';

    // Always render typing indicator - CSS hides it when .complete class is present
    return `
      <div class="message message-assistant ${completeClass}" id="phantom-frame">
        <div class="message-bubble">
          <div class="message-header">${agentAvatar}<span class="header-name">${this.agentName}</span></div>
          <div class="message-content">${this._renderMarkup(content)}</div>
          <div class="typing-indicator">
            <span></span><span></span><span></span>
          </div>
        </div>
      </div>
    `;
  }

  /**
   * Estimate token count for a message.
   * @param {object} message
   * @returns {number}
   */
  _estimateTokens(message) {
    let estimate = 0;

    if (typeof message.content === 'string') {
      estimate = Math.ceil(message.content.length / 4);
    } else if (Array.isArray(message.content)) {
      for (let block of message.content) {
        if (block.type === 'text') {
          estimate += Math.ceil(block.text.length / 4);
        }
      }
    }

    return estimate;
  }

  /**
   * Render message footer with timestamp, token count, and hidden action buttons.
   * @param {object} message
   * @param {number} tokenEstimate
   * @returns {string}
   */
  _renderFooter(message, tokenEstimate) {
    let timeStr  = (message.createdAt) ? formatRelativeDate(message.createdAt) : 'just now';
    let tokenStr = formatTokenCount(tokenEstimate);

    let metaText = (tokenEstimate > 0)
      ? `${timeStr} / ~${tokenStr} tokens`
      : timeStr;

    return `
      <div class="message-footer">
        <span class="footer-meta">${metaText}</span>
        <div class="footer-actions" style="display:none">
          <button class="prompt-batch-ignore" title="Ignore all prompts">Ignore</button>
          <button class="prompt-batch-submit" title="Submit all answers">Submit</button>
        </div>
      </div>`;
  }
}

// Register the component
HeroChat.register();
