'use strict';

import { t } from '../../lib/i18n.mjs';

const TEMPLATE_HTML = `
  <style>
    :host {
      display: block;
      padding: var(--spacing-sm, 8px) var(--spacing-md, 16px);
      flex-shrink: 0;
    }

    .input-area {
      display: flex;
      align-items: flex-end;
      gap: var(--spacing-xs, 4px);
      background: var(--glass-background, rgba(255, 255, 255, 0.05));
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid var(--glass-border, rgba(255, 255, 255, 0.10));
      border-radius: var(--border-radius-medium, 8px);
      padding: var(--spacing-xs, 4px) var(--spacing-md, 16px);
    }

    .message-textarea {
      flex: 1;
      background: transparent;
      border: none;
      color: var(--text-primary, #e8e8f0);
      font-size: 1rem;
      font-family: inherit;
      resize: none;
      outline: none;
      padding: 8px 12px;
      line-height: 1.4;
      /* Start as single row; auto-resize JS grows up to max */
      height: auto;
      max-height: 130px;
      overflow-y: auto;
    }

    .message-textarea::placeholder {
      color: var(--input-placeholder, var(--text-muted, #606078));
    }

    .send-button {
      background: var(--accent-primary, #00e5ff);
      color: #ffffff;
      border: none;
      border-radius: var(--border-radius-small, 4px);
      padding: 8px 16px;
      font-weight: 600;
      font-size: 1rem;
      cursor: pointer;
      transition: background 0.2s ease, box-shadow 0.2s ease;
      white-space: nowrap;
      /* Match single-line textarea height so button is centered at baseline */
      align-self: center;
    }

    .send-button:hover {
      box-shadow: 0 0 12px var(--accent-glow, rgba(0, 229, 255, 0.40));
    }

    .queue-indicator {
      display: none;
    }

    .reply-banner {
      display: none;
      align-items: center;
      gap: var(--spacing-sm, 8px);
      padding: 6px 12px;
      background: var(--accent-dim, rgba(0, 229, 255, 0.10));
      border-left: 3px solid var(--accent-primary, #00e5ff);
      border-radius: var(--border-radius-small, 4px) var(--border-radius-small, 4px) 0 0;
      font-size: 0.85rem;
      color: var(--text-secondary, #a0a0b8);
    }

    .reply-banner.visible {
      display: flex;
    }

    .reply-banner-text {
      flex: 1;
      min-width: 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .reply-banner-name {
      color: var(--accent-primary, #00e5ff);
      font-weight: 600;
    }

    .reply-cancel-button {
      border: none;
      background: transparent;
      color: var(--text-muted, #606078);
      cursor: pointer;
      font-size: 1rem;
      padding: 2px 6px;
      border-radius: var(--border-radius-small, 4px);
      line-height: 1;
    }

    .reply-cancel-button:hover {
      color: var(--text-primary, #e8e8f0);
      background: var(--glass-hover, rgba(255, 255, 255, 0.08));
    }
  </style>

  <div class="reply-banner">
    <div class="reply-banner-text">
      Replying to <span class="reply-banner-name"></span>
    </div>
    <button class="reply-cancel-button" type="button">&times;</button>
  </div>
  <div class="input-area">
    <textarea class="message-textarea" rows="1"></textarea>
    <button class="send-button"></button>
  </div>
  <div class="queue-indicator" hidden>
    <span class="queue-count"></span>
    <span class="queue-hint">(Esc to cancel)</span>
  </div>
`;

let cachedTemplate = null;

function getTemplate() {
  if (!cachedTemplate) {
    cachedTemplate = document.createElement('template');
    cachedTemplate.innerHTML = TEMPLATE_HTML;
  }

  return cachedTemplate;
}

class KikxMessageInput extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.shadowRoot.appendChild(getTemplate().content.cloneNode(true));

    this._textarea          = this.shadowRoot.querySelector('.message-textarea');
    this._sendButton        = this.shadowRoot.querySelector('.send-button');
    this._queueIndicator    = this.shadowRoot.querySelector('.queue-indicator');
    this._queueCount        = this.shadowRoot.querySelector('.queue-count');
    this._replyBanner       = this.shadowRoot.querySelector('.reply-banner');
    this._replyBannerName   = this.shadowRoot.querySelector('.reply-banner-name');
    this._replyCancelButton = this.shadowRoot.querySelector('.reply-cancel-button');

    this._queue         = [];
    this._isInteracting = false;
    this._sessionID     = null;
    this._replyToFrameID = null;

    this._onKeyDown      = this._onKeyDown.bind(this);
    this._onSendClick    = this._onSendClick.bind(this);
    this._onInput        = this._onInput.bind(this);
    this._onReplyCancel  = this._onReplyCancel.bind(this);
  }

  connectedCallback() {
    this._render();
    this._textarea.addEventListener('keydown', this._onKeyDown);
    this._textarea.addEventListener('input', this._onInput);
    this._sendButton.addEventListener('click', this._onSendClick);
    this._replyCancelButton.addEventListener('click', this._onReplyCancel);
  }

  disconnectedCallback() {
    this._textarea.removeEventListener('keydown', this._onKeyDown);
    this._textarea.removeEventListener('input', this._onInput);
    this._sendButton.removeEventListener('click', this._onSendClick);
    this._replyCancelButton.removeEventListener('click', this._onReplyCancel);
  }

  _render() {
    this._textarea.placeholder   = t('chat.input.placeholder');
    this._sendButton.textContent = t('chat.input.sendButton');
  }

  // ---------------------------------------------------------------------------
  // Draft persistence (sessionStorage, partitioned by session ID)
  // ---------------------------------------------------------------------------

  get sessionID() {
    return this._sessionID;
  }

  set sessionID(value) {
    this._sessionID = value;
    this._loadDraft();
  }

  _getDraftKey() {
    if (!this._sessionID)
      return null;

    return `kikx_draft:${this._sessionID}`;
  }

  _onInput() {
    this._saveDraft();
    this._autoResize();
  }

  _autoResize() {
    let textarea = this._textarea;

    // Reset to auto so scrollHeight reflects actual content height
    textarea.style.height = 'auto';
    textarea.style.height = textarea.scrollHeight + 'px';
  }

  _saveDraft() {
    let key = this._getDraftKey();
    if (!key)
      return;

    let value = this._textarea.value;

    if (value)
      sessionStorage.setItem(key, value);
    else
      sessionStorage.removeItem(key);
  }

  _loadDraft() {
    let key = this._getDraftKey();
    if (!key)
      return;

    let draft = sessionStorage.getItem(key);
    if (draft)
      this._textarea.value = draft;
    else
      this._textarea.value = '';

    this._autoResize();
  }

  clearDraft() {
    let key = this._getDraftKey();
    if (key)
      sessionStorage.removeItem(key);
  }

  // ---------------------------------------------------------------------------
  // Input handling
  // ---------------------------------------------------------------------------

  _onKeyDown(event) {
    if (event.key === 'Escape') {
      // Cancel reply mode first
      if (this._replyToFrameID) {
        event.preventDefault();
        this.clearReplyMode();

        return;
      }

      if (this._queue.length > 0) {
        event.preventDefault();

        let queuedText = this._queue.join('\n\n');
        this._queue = [];
        this._updateQueueIndicator();

        let existing = this._textarea.value;
        this._textarea.value = (existing) ? `${queuedText}\n\n${existing}` : queuedText;
        this._saveDraft();
        this._autoResize();

        return;
      }

      if (this._isInteracting) {
        event.preventDefault();
        this.dispatchEvent(new CustomEvent('cancel-interaction', {
          bubbles:  true,
          composed: true,
        }));

        return;
      }
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this._send();
    }
  }

  _onSendClick() {
    this._send();
  }

  _send() {
    let text = this._textarea.value.trim();
    if (!text)
      return;

    this._textarea.value = '';
    this._autoResize();

    if (this._isInteracting) {
      this._queue.push(text);
      this._updateQueueIndicator();
      this.clearDraft();

      return;
    }

    // Draft stays in sessionStorage until session-page calls clearDraft()
    // after a successful 200 from the API.
    let detail = { text };
    if (this._replyToFrameID)
      detail.parentID = this._replyToFrameID;

    this.dispatchEvent(new CustomEvent('send-message', {
      bubbles:  true,
      composed: true,
      detail,
    }));

    this.clearReplyMode();
  }

  _updateQueueIndicator() {
    let count = this._queue.length;

    this.dispatchEvent(new CustomEvent('queue-change', {
      bubbles:  true,
      composed: true,
      detail:   { count },
    }));
  }

  setInteracting(isInteracting) {
    this._isInteracting = isInteracting;

    if (!isInteracting && this._queue.length > 0) {
      let combined = this._queue.join('\n\n');
      this._queue = [];
      this._updateQueueIndicator();

      this.dispatchEvent(new CustomEvent('send-message', {
        bubbles:  true,
        composed: true,
        detail:   { text: combined },
      }));
    }
  }

  focus() {
    this._textarea.focus();
  }

  clear() {
    this._textarea.value = '';
    this._autoResize();
  }

  // ---------------------------------------------------------------------------
  // Reply mode
  // ---------------------------------------------------------------------------

  setReplyMode(frameID, participantName) {
    this._replyToFrameID = frameID;
    this._replyBannerName.textContent = participantName || 'message';
    this._replyBanner.classList.add('visible');
    this._textarea.focus();
  }

  clearReplyMode() {
    this._replyToFrameID = null;
    this._replyBanner.classList.remove('visible');
    this._replyBannerName.textContent = '';
  }

  _onReplyCancel() {
    this.clearReplyMode();
    this._textarea.focus();
  }
}

if (typeof customElements !== 'undefined')
  customElements.define('kikx-message-input', KikxMessageInput);

export default KikxMessageInput;
