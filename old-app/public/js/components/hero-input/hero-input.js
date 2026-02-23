'use strict';

/**
 * Hero Input - Message Input Component
 *
 * Features:
 * - Auto-resizing textarea
 * - Command detection (/ prefix)
 * - Queue support when busy
 * - Keyboard shortcuts (Enter to send, Shift+Enter for newline)
 */

import {
  HeroComponent,
  GlobalState,
  DynamicProperty,
} from '../hero-base.js';

// ============================================================================
// HeroInput Component
// ============================================================================

export class HeroInput extends HeroComponent {
  static tagName = 'hero-input';

  // Component state
  #isLoading = false;
  #streamingMode = true;
  #messageQueue = [];
  #maxHeight = 150;
  #unsubscribers = [];
  #pendingFiles = [];
  #draftTimer = null;
  #DRAFT_DEBOUNCE_MS = 100;

  // @mention autocomplete state
  #mentionActive = false;
  #mentionStartIndex = -1;
  #mentionSelectedIndex = 0;
  #mentionCandidates = [];

  // ---------------------------------------------------------------------------
  // Shadow DOM
  // ---------------------------------------------------------------------------

  createShadowDOM() {
    return this.attachShadow({ mode: 'open' });
  }

  // ---------------------------------------------------------------------------
  // Template Expression Getters
  // ---------------------------------------------------------------------------

  /**
   * Get placeholder text based on session state.
   * @returns {string}
   */
  get placeholder() {
    return this.currentSession ? 'Type a message...' : 'Select a session to start...';
  }

  // ---------------------------------------------------------------------------
  // Element Accessors
  // ---------------------------------------------------------------------------

  /**
   * Get the textarea element.
   * @returns {HTMLTextAreaElement|null}
   */
  get textarea() {
    return this.shadowRoot?.querySelector('textarea');
  }

  /**
   * Get current input value.
   * @returns {string}
   */
  get value() {
    return this.textarea?.value || '';
  }

  /**
   * Set input value.
   * @param {string} val
   */
  set value(val) {
    if (this.textarea) {
      this.textarea.value = val;
      this.autoResize();
    }
  }

  /**
   * Check if currently loading.
   * @returns {boolean}
   */
  get loading() {
    return this.#isLoading;
  }

  /**
   * Set loading state.
   * @param {boolean} val
   */
  set loading(val) {
    this.#isLoading = val;
    this._updateButtonState();
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
      this.subscribeGlobal('currentSession', () => {
        this._updateDisabledState();
        this._updateButtonState();
        this._restoreDraft();
        this.focus();
      })
    );

    // Initial state update
    this._updateDisabledState();
    this._updateButtonState();
    this._restoreDraft();
  }

  /**
   * Component unmounted.
   */
  unmounted() {
    for (let unsub of this.#unsubscribers) {
      unsub();
    }
    this.#unsubscribers = [];
  }

  // ---------------------------------------------------------------------------
  // Public Methods
  // ---------------------------------------------------------------------------

  /**
   * Focus the textarea.
   */
  focus() {
    this.textarea?.focus();
  }

  /**
   * Clear the input.
   */
  clear() {
    if (this.textarea) {
      this.textarea.value = '';
      this.textarea.style.height = 'auto';
    }
  }

  /**
   * Process queued messages.
   */
  async processQueue() {
    while (this.#messageQueue.length > 0 && !this.#isLoading) {
      let queued = this.#messageQueue.shift();

      this.dispatchEvent(new CustomEvent('hero:queue-process', {
        detail: { content: queued.content, queueId: queued.id },
        bubbles: true,
        composed: true,
      }));

      // Wait for message to complete (parent should call done())
      await new Promise((resolve) => {
        this.addEventListener('hero:queue-complete', resolve, { once: true });
      });
    }
  }

  /**
   * Signal queue item complete.
   */
  queueComplete() {
    this.dispatchEvent(new CustomEvent('hero:queue-complete'));
  }

  // ---------------------------------------------------------------------------
  // Event Handlers (called from template)
  // ---------------------------------------------------------------------------

  /**
   * Handle send action.
   */
  async handleSend() {
    let content = this.value.trim();

    if (!content) return;
    if (!this.currentSession) return;

    // Clear input and draft
    this.clear();
    this._clearDraft();

    // Commands are now handled server-side - send them like regular messages
    // The server will intercept /command patterns and execute them

    // If busy, queue the message
    if (this.#isLoading) {
      this._queueMessage(content);
      this.focus();
      return;
    }

    // Send the message (commands and regular messages are handled the same way)
    await this._sendMessage(content);
  }

  /**
   * Handle keydown events.
   * @param {KeyboardEvent} e
   */
  handleKeydown(e) {
    // @mention autocomplete navigation
    if (this.#mentionActive) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        this.#mentionSelectedIndex = Math.min(this.#mentionSelectedIndex + 1, this.#mentionCandidates.length - 1);
        this._renderMentionDropdown();
        return;
      }

      if (e.key === 'ArrowUp') {
        e.preventDefault();
        this.#mentionSelectedIndex = Math.max(this.#mentionSelectedIndex - 1, 0);
        this._renderMentionDropdown();
        return;
      }

      if (e.key === 'Tab' || e.key === 'Enter') {
        if (this.#mentionCandidates.length > 0) {
          e.preventDefault();
          this._selectMention(this.#mentionCandidates[this.#mentionSelectedIndex]);
          return;
        }
      }

      if (e.key === 'Escape') {
        e.preventDefault();
        this._closeMentionDropdown();
        return;
      }
    }

    // Enter without Shift sends message
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      this.handleSend();
      return;
    }

    // Escape clears input and draft
    if (e.key === 'Escape') {
      this.clear();
      this._clearDraft();
      return;
    }
  }

  /**
   * Auto-resize textarea based on content.
   */
  autoResize() {
    let textarea = this.textarea;
    if (!textarea) return;

    textarea.style.height = 'auto';
    let newHeight = Math.min(textarea.scrollHeight, this.#maxHeight);
    textarea.style.height = newHeight + 'px';

    // Enable scrolling when content exceeds max height
    textarea.style.overflowY = (textarea.scrollHeight > this.#maxHeight) ? 'auto' : 'hidden';

    // Check for @mention trigger
    this._checkMentionTrigger();

    // Save draft (debounced)
    this._saveDraftDebounced();
  }

  /**
   * Handle dragover event.
   * @param {DragEvent} e
   */
  handleDragOver(e) {
    e.preventDefault();
    e.stopPropagation();
    let overlay = this.shadowRoot?.querySelector('.drop-overlay');
    if (overlay) overlay.classList.add('active');
  }

  /**
   * Handle dragleave event.
   * @param {DragEvent} e
   */
  handleDragLeave(e) {
    e.preventDefault();
    e.stopPropagation();
    let overlay = this.shadowRoot?.querySelector('.drop-overlay');
    if (overlay) overlay.classList.remove('active');
  }

  /**
   * Handle file drop.
   * @param {DragEvent} e
   */
  handleDrop(e) {
    e.preventDefault();
    e.stopPropagation();

    let overlay = this.shadowRoot?.querySelector('.drop-overlay');
    if (overlay) overlay.classList.remove('active');

    let files = Array.from(e.dataTransfer?.files || []);
    if (files.length > 0)
      this._addFiles(files);
  }

  /**
   * Handle paste event (for pasted images).
   * @param {ClipboardEvent} e
   */
  handlePaste(e) {
    let items = Array.from(e.clipboardData?.items || []);
    let files = items
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter(Boolean);

    if (files.length > 0) {
      e.preventDefault();
      this._addFiles(files);
    }
  }

  /**
   * Get pending files for the current message.
   * @returns {File[]}
   */
  get pendingFiles() {
    return [...this.#pendingFiles];
  }

  /**
   * Clear pending files after upload.
   */
  clearFiles() {
    this.#pendingFiles = [];
    this._renderFilePreview();
  }

  /**
   * Handle clear button click.
   */
  handleClear() {
    this.dispatchEvent(new CustomEvent('hero:clear', {
      bubbles: true,
      composed: true,
    }));
  }

  // ---------------------------------------------------------------------------
  // Private Methods
  // ---------------------------------------------------------------------------

  /**
   * Queue a message for later processing.
   * @param {string} content
   */
  _queueMessage(content) {
    let queueId = `queued-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    this.#messageQueue.push({ id: queueId, content });

    this.dispatchEvent(new CustomEvent('hero:message-queued', {
      detail: { content, queueId },
      bubbles: true,
      composed: true,
    }));
  }

  /**
   * Send a message.
   * @param {string} content
   */
  async _sendMessage(content) {
    this.loading = true;

    try {
      this.dispatchEvent(new CustomEvent('hero:send-message', {
        detail: {
          content,
          files:     this.#pendingFiles.length > 0 ? [...this.#pendingFiles] : null,
          streaming: this.#streamingMode,
          sessionId: this.currentSession.id,
        },
        bubbles: true,
        composed: true,
      }));

      // Clear files after dispatching
      this.#pendingFiles = [];
      this._renderFilePreview();
    } finally {
      // Note: loading will be set to false by parent after response
    }
  }

  /**
   * Add files to pending list.
   * @param {File[]} files
   */
  _addFiles(files) {
    for (let file of files) {
      // Max 5 files
      if (this.#pendingFiles.length >= 5) break;

      // Max 10 MB each
      if (file.size > 10 * 1024 * 1024) {
        console.warn(`File too large: ${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)`);
        continue;
      }

      this.#pendingFiles.push(file);
    }

    this._renderFilePreview();
  }

  /**
   * Remove a file from pending list.
   * @param {number} index
   */
  _removeFile(index) {
    this.#pendingFiles.splice(index, 1);
    this._renderFilePreview();
  }

  /**
   * Render file preview chips.
   */
  _renderFilePreview() {
    let bar = this.shadowRoot?.querySelector('.file-preview-bar');
    if (!bar) return;

    if (this.#pendingFiles.length === 0) {
      bar.classList.remove('has-files');
      bar.innerHTML = '';
      return;
    }

    bar.classList.add('has-files');
    bar.innerHTML = '';

    this.#pendingFiles.forEach((file, index) => {
      let chip = document.createElement('span');
      chip.className = 'file-chip';

      let isImage = file.type.startsWith('image/');

      if (isImage) {
        let img = document.createElement('img');
        img.src = URL.createObjectURL(file);
        img.onload = () => URL.revokeObjectURL(img.src);
        chip.appendChild(img);
      }

      let name = document.createElement('span');
      name.textContent = file.name.length > 20 ? file.name.slice(0, 17) + '...' : file.name;
      chip.appendChild(name);

      let remove = document.createElement('span');
      remove.className = 'remove';
      remove.textContent = '\u00d7';
      remove.addEventListener('click', () => this._removeFile(index));
      chip.appendChild(remove);

      bar.appendChild(chip);
    });
  }

  // ---------------------------------------------------------------------------
  // Draft Persistence (sessionStorage, keyed by session ID)
  // ---------------------------------------------------------------------------

  /**
   * Get the sessionStorage key for the current session's draft.
   * @returns {string|null}
   */
  _draftKey() {
    let sessionId = this.currentSession?.id;
    return sessionId ? `hero-draft-${sessionId}` : null;
  }

  /**
   * Save draft to sessionStorage (debounced).
   */
  _saveDraftDebounced() {
    clearTimeout(this.#draftTimer);
    this.#draftTimer = setTimeout(() => this._saveDraft(), this.#DRAFT_DEBOUNCE_MS);
  }

  /**
   * Save current textarea value to sessionStorage.
   */
  _saveDraft() {
    let key   = this._draftKey();
    let value = this.value;

    if (!key) return;

    if (value)
      sessionStorage.setItem(key, value);
    else
      sessionStorage.removeItem(key);
  }

  /**
   * Restore draft from sessionStorage into the textarea.
   */
  _restoreDraft() {
    let key = this._draftKey();
    if (!key) return;

    let draft = sessionStorage.getItem(key);
    if (draft) {
      this.value = draft;  // triggers autoResize via setter
    }
  }

  /**
   * Clear draft from sessionStorage.
   */
  _clearDraft() {
    let key = this._draftKey();
    if (key)
      sessionStorage.removeItem(key);
  }

  // ---------------------------------------------------------------------------
  // @Mention Autocomplete
  // ---------------------------------------------------------------------------

  /**
   * Check if the cursor is in an @mention context and show/update dropdown.
   */
  _checkMentionTrigger() {
    let textarea = this.textarea;
    if (!textarea) return;

    let text   = textarea.value;
    let cursor = textarea.selectionStart;

    // Walk backwards from cursor to find @ trigger
    let atIndex = -1;
    for (let i = cursor - 1; i >= 0; i--) {
      let char = text[i];

      // Stop at whitespace or newline — no @ in this word
      if (char === ' ' || char === '\n' || char === '\t') break;

      if (char === '@') {
        // Only trigger at start of line or after whitespace
        if (i === 0 || /\s/.test(text[i - 1])) {
          atIndex = i;
        }
        break;
      }
    }

    if (atIndex === -1) {
      this._closeMentionDropdown();
      return;
    }

    let query = text.slice(atIndex + 1, cursor).toLowerCase();
    this.#mentionStartIndex = atIndex;

    // Get agent participants from current session
    let participants = this.currentSession?.participants || [];
    let agents = participants.filter((p) => p.participantType === 'agent');

    // Filter by query (match name or alias)
    let candidates = agents.filter((a) => {
      let name  = (a.name || '').toLowerCase();
      let alias = (a.alias || '').toLowerCase();
      return name.startsWith(query) || alias.startsWith(query);
    });

    if (candidates.length === 0) {
      this._closeMentionDropdown();
      return;
    }

    this.#mentionActive     = true;
    this.#mentionCandidates = candidates;
    this.#mentionSelectedIndex = Math.min(this.#mentionSelectedIndex, candidates.length - 1);
    this._renderMentionDropdown();
  }

  /**
   * Select a mention candidate and insert it into the textarea.
   * @param {Object} candidate - Participant to mention
   */
  _selectMention(candidate) {
    let textarea = this.textarea;
    if (!textarea) return;

    let displayName = candidate.alias || candidate.name || `agent-${candidate.participantId}`;
    let before      = textarea.value.slice(0, this.#mentionStartIndex);
    let after       = textarea.value.slice(textarea.selectionStart);
    let insertion   = `@${displayName} `;

    textarea.value = before + insertion + after;
    textarea.selectionStart = textarea.selectionEnd = before.length + insertion.length;

    this._closeMentionDropdown();
    textarea.focus();
    this.autoResize();
  }

  /**
   * Render the mention autocomplete dropdown.
   */
  _renderMentionDropdown() {
    let dropdown = this.shadowRoot?.querySelector('.mention-dropdown');
    if (!dropdown) return;

    dropdown.innerHTML = '';
    dropdown.classList.add('active');

    for (let i = 0; i < this.#mentionCandidates.length; i++) {
      let candidate = this.#mentionCandidates[i];
      let item      = document.createElement('div');
      item.className = 'mention-item' + ((i === this.#mentionSelectedIndex) ? ' selected' : '');

      let name = candidate.alias || candidate.name || `agent-${candidate.participantId}`;
      let role = candidate.role || '';

      item.innerHTML = `<span class="mention-name">@${name}</span>` +
                       ((candidate.alias && candidate.name) ? `<span class="mention-real">${candidate.name}</span>` : '') +
                       `<span class="mention-role">${role}</span>`;

      item.addEventListener('mousedown', (e) => {
        e.preventDefault(); // Prevent textarea blur
        this._selectMention(candidate);
      });

      dropdown.appendChild(item);
    }
  }

  /**
   * Close the mention autocomplete dropdown.
   */
  _closeMentionDropdown() {
    this.#mentionActive        = false;
    this.#mentionStartIndex    = -1;
    this.#mentionSelectedIndex = 0;
    this.#mentionCandidates    = [];

    let dropdown = this.shadowRoot?.querySelector('.mention-dropdown');
    if (dropdown) {
      dropdown.classList.remove('active');
      dropdown.innerHTML = '';
    }
  }

  // ---------------------------------------------------------------------------
  // UI State Updates
  // ---------------------------------------------------------------------------

  /**
   * Update send button state.
   */
  _updateButtonState() {
    let button = this.shadowRoot?.querySelector('.send-button');
    if (button) {
      button.disabled = this.#isLoading || !this.currentSession;
    }
  }

  /**
   * Update disabled state of textarea based on session.
   */
  _updateDisabledState() {
    let textarea = this.textarea;
    if (textarea) {
      textarea.disabled = !this.currentSession;
      textarea.placeholder = this.placeholder;
    }
  }
}

// Register the component
HeroInput.register();
