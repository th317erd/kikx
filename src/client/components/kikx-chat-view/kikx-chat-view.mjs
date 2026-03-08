'use strict';

import { t } from '../../lib/i18n.mjs';

const ANCHOR_THRESHOLD = 50;
const TOP_THRESHOLD    = 50;

const TEMPLATE_HTML = `
  <style>
    :host {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-height: 0;
      overflow: hidden;
    }

    .chat-container {
      flex: 1;
      overflow-y: auto;
      padding: var(--spacing-sm, 8px);
    }

    .chat-container::-webkit-scrollbar { width: 6px; }
    .chat-container::-webkit-scrollbar-track { background: transparent; }
    .chat-container::-webkit-scrollbar-thumb {
      background: var(--glass-border, rgba(255, 255, 255, 0.10));
      border-radius: 3px;
    }
    .chat-container::-webkit-scrollbar-button { display: none; }

    .interaction-stream {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-sm, 8px);
      min-height: 100%;
    }
  </style>

  <div class="chat-container">
    <div class="interaction-stream">
      <slot></slot>
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

class KikxChatView extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.shadowRoot.appendChild(getTemplate().content.cloneNode(true));

    this._chatContainer     = this.shadowRoot.querySelector('.chat-container');
    this._interactionStream = this.shadowRoot.querySelector('.interaction-stream');
    this._isAnchoredToBottom = true;
    this._resizeObserver     = null;

    this._onScroll = this._onScroll.bind(this);
  }

  get isAnchoredToBottom() { return this._isAnchoredToBottom; }

  connectedCallback() {
    this._chatContainer.addEventListener('scroll', this._onScroll);
    this._resizeObserver = new ResizeObserver(() => this._onContentResize());
    this._resizeObserver.observe(this._interactionStream);
  }

  disconnectedCallback() {
    this._chatContainer.removeEventListener('scroll', this._onScroll);

    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }
  }

  _onScroll() {
    let container          = this._chatContainer;
    let distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    let anchored           = distanceFromBottom <= ANCHOR_THRESHOLD;

    if (anchored !== this._isAnchoredToBottom) {
      this._isAnchoredToBottom = anchored;
      this.dispatchEvent(new CustomEvent('anchored-change', {
        bubbles:  true,
        composed: true,
        detail:   { anchored },
      }));
    }

    // Near top → request older frames
    if (container.scrollTop <= TOP_THRESHOLD) {
      this.dispatchEvent(new CustomEvent('near-top', {
        bubbles:  true,
        composed: true,
      }));
    }
  }

  _onContentResize() {
    if (this._isAnchoredToBottom)
      this._scrollToBottomImmediate();
  }

  _scrollToBottomImmediate() {
    let container       = this._chatContainer;
    container.scrollTop = container.scrollHeight - container.clientHeight;
  }

  scrollToBottom() {
    this._isAnchoredToBottom = true;
    this._chatContainer.scrollTo({
      top:      this._chatContainer.scrollHeight - this._chatContainer.clientHeight,
      behavior: 'smooth',
    });

    this.dispatchEvent(new CustomEvent('anchored-change', {
      bubbles:  true,
      composed: true,
      detail:   { anchored: true },
    }));
  }

  appendInteraction(element) {
    this._interactionStream.appendChild(element);

    if (this._isAnchoredToBottom)
      this._scrollToBottomImmediate();
  }

  prependInteraction(element) {
    let container       = this._chatContainer;
    let previousHeight  = container.scrollHeight;

    this._interactionStream.insertBefore(element, this._interactionStream.firstChild);

    // Maintain scroll position after prepend
    let newHeight       = container.scrollHeight;
    container.scrollTop += (newHeight - previousHeight);
  }
}

if (typeof customElements !== 'undefined')
  customElements.define('kikx-chat-view', KikxChatView);

export default KikxChatView;
