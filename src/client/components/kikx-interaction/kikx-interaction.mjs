'use strict';

import { t } from '../../lib/i18n.mjs';
import { glowInitCSS, glowCSS, glowHoverCSS } from '../../styles/glow-focus.mjs';

const TEMPLATE_HTML = `
  <style>
    :host {
      display: block;
      padding: var(--spacing-sm, 8px);
      max-width: 85%;
      align-self: flex-start;
    }

    ::selection {
      background: var(--accent-dim, rgba(0, 229, 255, 0.10));
      color: var(--text-primary, #e8e8f0);
    }

    :host([alignment="user"]) {
      align-self: flex-end;
    }

    :host([alignment="system"]) {
      align-self: center;
      max-width: 100%;
    }

    /* Transition for smooth pending → confirmed state change */
    :host {
      transition: opacity 0.3s ease, filter 0.3s ease;
    }

    /* Optimistic "sending" state — faded + desaturated until server confirms */
    :host(.pending) {
      opacity: 0.55;
      filter: saturate(0.4);
    }

    /* ----------------------------------------------------------------- */
    /* Animated border glow dots — shown when bubble is clicked          */
    /* backdrop-filter creates a stacking context so z-index:-1/-2 works */
    /* ----------------------------------------------------------------- */
    ${glowInitCSS('.bubble')}
    ${glowHoverCSS('.bubble:hover:not(.focused)')}
    ${glowCSS('.bubble.focused')}

    /* ----------------------------------------------------------------- */
    /* Glass-surface reflection (toggled via console: kikxReflections())  */
    /* ----------------------------------------------------------------- */
    :host([reflect]) .bubble {
      box-shadow:
        0 2px 8px rgba(0, 0, 0, 0.2),
        0 0 20px rgba(0, 229, 255, 0.03),
        0 0 40px rgba(176, 64, 255, 0.02),
        4px 8px 6px -3px rgba(0, 229, 255, 0.07),
        6px 10px 10px -3px rgba(176, 64, 255, 0.05);
    }

    :host([alignment="user"][reflect]) .bubble {
      box-shadow:
        0 0 12px var(--accent-glow, rgba(0, 229, 255, 0.20)),
        0 0 30px rgba(176, 64, 255, 0.08),
        4px 8px 6px -3px var(--accent-glow, rgba(0, 229, 255, 0.10)),
        6px 10px 10px -3px rgba(176, 64, 255, 0.06);
    }

    :host([bubble-type="permission"][reflect]) .bubble {
      box-shadow:
        0 0 12px rgba(255, 234, 0, 0.20),
        0 0 30px rgba(255, 234, 0, 0.08),
        4px 8px 6px -3px rgba(255, 234, 0, 0.08),
        6px 10px 10px -3px rgba(255, 234, 0, 0.05);
    }

    :host([bubble-type="error"][reflect]) .bubble {
      box-shadow:
        0 0 12px rgba(255, 23, 68, 0.20),
        0 0 30px rgba(255, 23, 68, 0.08),
        4px 8px 6px -3px rgba(255, 23, 68, 0.08),
        6px 10px 10px -3px rgba(255, 23, 68, 0.05);
    }

    .bubble {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-xs, 4px);
      background: var(--glass-background, rgba(255, 255, 255, 0.05));
      backdrop-filter: blur(var(--glass-blur, 16px));
      -webkit-backdrop-filter: blur(var(--glass-blur, 16px));
      border: 1px solid var(--glass-border, rgba(255, 255, 255, 0.10));
      border-radius: var(--border-radius-large, 12px);
      padding: 12px 14px;
      color: var(--text-primary, #e8e8f0);
      box-shadow:
        0 2px 8px rgba(0, 0, 0, 0.2),
        0 0 20px rgba(0, 229, 255, 0.03),
        0 0 40px rgba(176, 64, 255, 0.02);
    }

    :host([alignment="user"]) .bubble {
      background:
        linear-gradient(135deg,
          var(--accent-dim, rgba(0, 229, 255, 0.10)) 0%,
          rgba(176, 64, 255, 0.06) 100%);
      border-color: var(--chat-user-border, var(--accent-glow, rgba(0, 229, 255, 0.30)));
      box-shadow:
        0 0 12px var(--accent-glow, rgba(0, 229, 255, 0.20)),
        0 0 30px rgba(176, 64, 255, 0.08);
    }

    /* ----------------------------------------------------------------- */
    /* Permission / warning — yellow bubble (same pattern as user msgs)  */
    /* Uses --neon-yellow from the theme neon palette                    */
    /* ----------------------------------------------------------------- */
    :host([bubble-type="permission"]) .bubble {
      background:
        linear-gradient(135deg,
          var(--color-warning-dim, rgba(255, 234, 0, 0.15)) 0%,
          rgba(255, 234, 0, 0.06) 100%);
      border-color: rgba(255, 234, 0, 0.30);
      box-shadow:
        0 0 12px rgba(255, 234, 0, 0.20),
        0 0 30px rgba(255, 234, 0, 0.08);
    }

    :host([bubble-type="permission"]) .bubble-header {
      margin: -12px -14px 0;
      padding: 10px 14px;
      border-radius: var(--border-radius-large, 12px) var(--border-radius-large, 12px) 0 0;
      background:
        repeating-linear-gradient(
          -45deg,
          transparent,
          transparent 8px,
          rgba(0, 0, 0, 0.12) 8px,
          rgba(0, 0, 0, 0.12) 16px
        );
    }

    /* ----------------------------------------------------------------- */
    /* Error / alert — red bubble (same pattern as user msgs)            */
    /* Uses --color-error from the theme semantic palette                */
    /* ----------------------------------------------------------------- */
    :host([bubble-type="error"]) .bubble {
      background:
        linear-gradient(135deg,
          var(--color-error-dim, rgba(255, 23, 68, 0.15)) 0%,
          rgba(255, 23, 68, 0.06) 100%);
      border-color: rgba(255, 23, 68, 0.30);
      box-shadow:
        0 0 12px rgba(255, 23, 68, 0.20),
        0 0 30px rgba(255, 23, 68, 0.08);
    }

    :host([bubble-type="error"]) .bubble-header {
      margin: -12px -14px 0;
      padding: 10px 14px;
      border-radius: var(--border-radius-large, 12px) var(--border-radius-large, 12px) 0 0;
      background:
        repeating-linear-gradient(
          -45deg,
          transparent,
          transparent 8px,
          rgba(0, 0, 0, 0.12) 8px,
          rgba(0, 0, 0, 0.12) 16px
        );
    }

    .bubble-header {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm, 8px);
    }

    .avatar {
      width: 28px;
      height: 28px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      font-size: 0.65rem;
      flex-shrink: 0;
      color: #fff;
      background: var(--interaction-avatar-color, #e53935);
    }

    .header-text {
      display: flex;
      align-items: baseline;
      gap: var(--spacing-sm, 8px);
      flex: 1;
      min-width: 0;
    }

    .header-name {
      font-size: 1rem;
      font-weight: 600;
      color: var(--text-primary, #e8e8f0);
    }

    .content {
      padding: 2px 0;
    }

    .footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 1rem;
      color: var(--text-muted, #606078);
      padding-top: 2px;
    }

    .footer:empty {
      display: none;
    }

    .reply-context {
      display: none;
      align-items: center;
      gap: var(--spacing-xs, 4px);
      padding: 4px 8px;
      margin-bottom: 2px;
      font-size: 0.8rem;
      color: var(--text-muted, #606078);
      border-left: 2px solid var(--accent-dim, rgba(0, 229, 255, 0.30));
      background: rgba(255, 255, 255, 0.02);
      border-radius: 0 var(--border-radius-small, 4px) var(--border-radius-small, 4px) 0;
    }

    :host([parent-preview]) .reply-context {
      display: flex;
    }

    .reply-context-text {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .footer-left {
      display: flex;
      gap: var(--spacing-sm, 8px);
      align-items: center;
    }

    .reply-button {
      border: none;
      background: transparent;
      color: var(--text-muted, #606078);
      cursor: pointer;
      font-size: 0.9rem;
      padding: 4px 10px;
      border-radius: var(--border-radius-small, 4px);
      transition: color 0.2s ease, background 0.2s ease;
      display: none;
    }

    :host([data-frame-id]) .reply-button {
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }

    :host([alignment="system"]) .reply-button,
    :host([bubble-type="permission"]) .reply-button {
      display: none;
    }

    .reply-button:hover {
      color: var(--accent-primary, #00e5ff);
      background: var(--glass-hover, rgba(255, 255, 255, 0.08));
    }

    .reply-count-badge {
      display: none;
      font-size: 0.8rem;
      color: var(--accent-primary, #00e5ff);
      cursor: pointer;
      padding: 2px 6px;
      border-radius: var(--border-radius-small, 4px);
      transition: background 0.2s ease;
    }

    .reply-count-badge:hover {
      background: var(--glass-hover, rgba(255, 255, 255, 0.08));
    }

    :host([reply-count]) .reply-count-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }

    .footer-right {
      display: flex;
      gap: var(--spacing-xs, 4px);
      align-items: center;
    }

    .action-button {
      border: none;
      border-radius: var(--border-radius-small, 4px);
      padding: 8px 20px;
      font-size: 1rem;
      font-weight: 600;
      cursor: pointer;
      transition: box-shadow 0.2s ease;
    }

    .ignore-button {
      background: var(--glass-background, rgba(255, 255, 255, 0.05));
      color: var(--text-primary, #e8e8f0);
    }

    .ignore-button:hover {
      box-shadow: 0 0 8px rgba(255, 255, 255, 0.12);
    }

    .submit-button {
      background: var(--accent-primary, #00e5ff);
      color: #fff;
    }

    .submit-button:hover {
      box-shadow: 0 0 12px var(--accent-glow, rgba(0, 229, 255, 0.40));
    }
  </style>

  <div class="bubble">
    <div class="reply-context">
      <span class="reply-context-text"></span>
    </div>
    <div class="bubble-header">
      <div class="avatar"></div>
      <div class="header-text">
        <span class="header-name"></span>
      </div>
    </div>
    <div class="content">
      <slot></slot>
    </div>
    <div class="footer">
      <div class="footer-left">
        <span class="footer-meta"></span>
        <button class="reply-button" type="button">Reply</button>
        <span class="reply-count-badge"></span>
      </div>
      <div class="footer-right"></div>
    </div>
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

function formatTokenCount(count) {
  let num = parseInt(count, 10);

  if (isNaN(num) || num <= 0)
    return '';

  return (num === 1)
    ? t('chat.interaction.tokenCount.one').replace('{count}', '1')
    : t('chat.interaction.tokenCount.other').replace('{count}', String(num));
}

class KikxInteraction extends HTMLElement {
  static get observedAttributes() {
    return [
      'participant-name',
      'participant-initials',
      'avatar-color',
      'alignment',
      'bubble-type',
      'timestamp',
      'token-count',
      'show-actions',
      'data-interaction-id',
      'parent-preview',
      'reply-count',
    ];
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.shadowRoot.appendChild(getTemplate().content.cloneNode(true));

    this._bubble           = this.shadowRoot.querySelector('.bubble');
    this._avatar           = this.shadowRoot.querySelector('.avatar');
    this._headerName       = this.shadowRoot.querySelector('.header-name');
    this._footerMeta       = this.shadowRoot.querySelector('.footer-meta');
    this._footerRight      = this.shadowRoot.querySelector('.footer-right');
    this._replyButton      = this.shadowRoot.querySelector('.reply-button');
    this._replyCountBadge  = this.shadowRoot.querySelector('.reply-count-badge');
    this._replyContextText = this.shadowRoot.querySelector('.reply-context-text');
    this._slot             = this.shadowRoot.querySelector('slot');

    this._onIgnoreClick    = this._onIgnoreClick.bind(this);
    this._onSubmitClick    = this._onSubmitClick.bind(this);
    this._onReplyClick     = this._onReplyClick.bind(this);
    this._onSlotChange     = this._updateReflectText.bind(this);
    this._onBubbleClick    = this._onBubbleClick.bind(this);
    this._onPeerFocus      = this._onPeerFocus.bind(this);
  }

  connectedCallback() {
    this._render();
    this._replyButton.addEventListener('click', this._onReplyClick);
    this._slot.addEventListener('slotchange', this._onSlotChange);
    this._bubble.addEventListener('click', this._onBubbleClick);
    this.ownerDocument.addEventListener('interaction-focused', this._onPeerFocus);
    requestAnimationFrame(() => this._updateReflectText());

    // Random glow offset so bubbles don't all rotate in sync
    this._bubble.style.animationDelay = `${-Math.random() * 20}s, ${-Math.random() * 30}s`;
  }

  disconnectedCallback() {
    this._removeActionListeners();
    this._bubble.removeEventListener('click', this._onBubbleClick);
    this.ownerDocument.removeEventListener('interaction-focused', this._onPeerFocus);
    this._replyButton.removeEventListener('click', this._onReplyClick);
    this._slot.removeEventListener('slotchange', this._onSlotChange);
  }

  attributeChangedCallback() {
    if (this.isConnected)
      this._render();
  }

  _render() {
    this._headerName.textContent = this.getAttribute('participant-name') || '';
    this._avatar.textContent     = this.getAttribute('participant-initials') || '';

    let avatarColor = this.getAttribute('avatar-color');
    if (avatarColor) {
      this._avatar.style.setProperty('--interaction-avatar-color', avatarColor);
    } else {
      this._avatar.style.removeProperty('--interaction-avatar-color');
    }

    // Build footer meta: "timestamp / ~N tokens" or just "timestamp"
    let timestamp      = this.getAttribute('timestamp') || '';
    let tokenCountAttr = this.getAttribute('token-count');
    let tokenStr       = tokenCountAttr ? formatTokenCount(tokenCountAttr) : '';
    let parts          = [];

    if (timestamp)
      parts.push(timestamp);

    if (tokenStr)
      parts.push(tokenStr);

    this._footerMeta.textContent = parts.join(' / ');

    // Reply context (shown when this message is a reply to another)
    let parentPreview = this.getAttribute('parent-preview');
    if (parentPreview)
      this._replyContextText.textContent = parentPreview;

    // Reply count badge
    let replyCount = this.getAttribute('reply-count');
    if (replyCount) {
      let count = parseInt(replyCount, 10);
      if (count > 0)
        this._replyCountBadge.textContent = `${count} ${(count === 1) ? 'reply' : 'replies'}`;
    }

    this._renderActions();
  }

  _updateReflectText() {
    let text = '';
    let slotted = this._slot.assignedNodes({ flatten: true });

    for (let node of slotted) {
      if (node.nodeType === Node.TEXT_NODE) {
        text += node.textContent;
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        // Prefer shadow DOM textContent if available (e.g. kikx-message-content)
        if (node.shadowRoot)
          text += node.shadowRoot.textContent || '';
        else
          text += node.textContent || '';
      }
    }

    this._bubble.setAttribute('data-reflect-text', text.trim().substring(0, 300));
  }

  _renderActions() {
    this._removeActionListeners();
    this._footerRight.innerHTML = '';

    if (!this.hasAttribute('show-actions'))
      return;

    let ignoreButton = document.createElement('button');
    ignoreButton.className   = 'action-button ignore-button';
    ignoreButton.textContent = t('chat.interaction.ignoreButton');
    ignoreButton.type        = 'button';

    let submitButton = document.createElement('button');
    submitButton.className   = 'action-button submit-button';
    submitButton.textContent = t('chat.interaction.submitButton');
    submitButton.type        = 'button';

    ignoreButton.addEventListener('click', this._onIgnoreClick);
    submitButton.addEventListener('click', this._onSubmitClick);

    this._ignoreButton = ignoreButton;
    this._submitButton = submitButton;

    this._footerRight.appendChild(ignoreButton);
    this._footerRight.appendChild(submitButton);
  }

  _removeActionListeners() {
    if (this._ignoreButton) {
      this._ignoreButton.removeEventListener('click', this._onIgnoreClick);
      this._ignoreButton = null;
    }

    if (this._submitButton) {
      this._submitButton.removeEventListener('click', this._onSubmitClick);
      this._submitButton = null;
    }
  }

  _onIgnoreClick() {
    this.dispatchEvent(new CustomEvent('interaction-ignore', {
      bubbles:  true,
      composed: true,
      detail:   { interactionID: this.getAttribute('data-interaction-id') },
    }));
  }

  _onSubmitClick() {
    this.dispatchEvent(new CustomEvent('interaction-submit', {
      bubbles:  true,
      composed: true,
      detail:   { interactionID: this.getAttribute('data-interaction-id') },
    }));
  }

  _onReplyClick() {
    let frameID   = this.getAttribute('data-frame-id');
    let name      = this.getAttribute('participant-name') || '';
    let alignment = this.getAttribute('alignment') || '';

    // Build a short preview from the first message-content child
    let preview = '';
    let content = this.querySelector('kikx-message-content');
    if (content && content.shadowRoot) {
      let body = content.shadowRoot.querySelector('.message-body');
      if (body)
        preview = (body.textContent || '').trim().substring(0, 80);
    }

    this.dispatchEvent(new CustomEvent('reply-to-message', {
      bubbles:  true,
      composed: true,
      detail:   { frameID, participantName: name, preview, alignment },
    }));
  }

  _onBubbleClick() {
    this._bubble.classList.add('focused');

    // Tell sibling interactions to clear their focus
    this.ownerDocument.dispatchEvent(new CustomEvent('interaction-focused', {
      detail: { source: this },
    }));
  }

  _onPeerFocus(event) {
    if (event.detail.source !== this)
      this._bubble.classList.remove('focused');
  }

  clearFocus() {
    this._bubble.classList.remove('focused');
  }
}

if (typeof customElements !== 'undefined')
  customElements.define('kikx-interaction', KikxInteraction);

// ---------------------------------------------------------------------------
// Console toggle: kikxReflections()
// Toggles the glass-surface reflection effect on all chat bubbles.
// Uses contain: paint on the host to prevent infinite mirror recursion.
// ---------------------------------------------------------------------------
if (typeof window !== 'undefined') {
  window.__kikxReflectionsEnabled = false;

  function collectShadowRoots(node, results) {
    if (node.shadowRoot) {
      results.push(node.shadowRoot);
      collectShadowRoots(node.shadowRoot, results);
    }

    let children = (node.shadowRoot) ? node.shadowRoot.children : node.children;
    if (!children)
      return;

    for (let child of children)
      collectShadowRoots(child, results);
  }

  window.kikxReflections = function kikxReflections(force) {
    let enabled = (force !== undefined) ? !!force : !window.__kikxReflectionsEnabled;
    window.__kikxReflectionsEnabled = enabled;

    let roots = [document];
    collectShadowRoots(document.body, roots);

    let count = 0;
    for (let root of roots) {
      for (let el of root.querySelectorAll('kikx-interaction')) {
        if (enabled)
          el.setAttribute('reflect', '');
        else
          el.removeAttribute('reflect');

        count++;
      }
    }

    // eslint-disable-next-line no-console
    console.log(`[kikx] Reflections ${(enabled) ? 'ON' : 'OFF'} (${count} bubbles)`);

    return enabled;
  };
}

export default KikxInteraction;
