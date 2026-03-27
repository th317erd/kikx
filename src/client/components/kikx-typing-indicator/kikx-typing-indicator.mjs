'use strict';

// =============================================================================
// kikx-typing-indicator — Lightweight "agent is thinking" bar
// =============================================================================
// Shows: "agent-name: ... scrolling thinking text ..."
// Compact, not a full chat bubble. Disappears if agent has nothing to say.
// Promoted to a full chat bubble (kikx-interaction) when message arrives.
// =============================================================================

const TEMPLATE_HTML = `
  <style>
    kikx-typing-indicator {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 12px;
      font-size: 0.85rem;
      color: var(--text-secondary, #a0a0b8);
      opacity: 0.8;
      transition: opacity 0.3s ease;
      max-width: 18em;
    }

    kikx-typing-indicator .agent-name {
      font-weight: 600;
      color: var(--text-primary, #e8e8f0);
      white-space: nowrap;
      flex-shrink: 0;
    }

    kikx-typing-indicator .dots {
      display: inline-flex;
      gap: 2px;
      font-weight: 600;
      font-size: 1rem;
      flex-shrink: 0;
    }

    kikx-typing-indicator .dots span {
      animation: kikx-typing-dot 1.4s ease-in-out infinite;
      opacity: 0.3;
    }

    kikx-typing-indicator .dots span:nth-child(2) { animation-delay: 0.2s; }
    kikx-typing-indicator .dots span:nth-child(3) { animation-delay: 0.4s; }

    @keyframes kikx-typing-dot {
      0%, 80%, 100% { opacity: 0.3; }
      40%           { opacity: 1; }
    }

    kikx-typing-indicator .thinking-scroll {
      flex: 1;
      overflow: hidden;
      white-space: nowrap;
      font-style: italic;
      color: var(--text-tertiary, rgba(255, 255, 255, 0.35));
      font-size: 0.8rem;
      mask-image: linear-gradient(to right, transparent 0%, black 5%, black 85%, transparent 100%);
      -webkit-mask-image: linear-gradient(to right, transparent 0%, black 5%, black 85%, transparent 100%);
    }

    kikx-typing-indicator .thinking-scroll-inner {
      display: inline-block;
      animation: kikx-typing-scroll 10s linear infinite;
    }

    @keyframes kikx-typing-scroll {
      0%   { transform: translateX(0%); }
      100% { transform: translateX(-50%); }
    }
  </style>

  <span class="agent-name"></span>
  <span class="dots"><span>.</span><span>.</span><span>.</span></span>
  <span class="thinking-scroll"><span class="thinking-scroll-inner"></span></span>
`;

let cachedTemplate = null;

function getTemplate() {
  if (!cachedTemplate) {
    cachedTemplate = document.createElement('template');
    cachedTemplate.innerHTML = TEMPLATE_HTML;
  }

  return cachedTemplate;
}

class KikxTypingIndicator extends HTMLElement {
  constructor() {
    super();
    this._agentName      = '';
    this._thinkingText   = '';
  }

  get agentName() { return this._agentName; }

  set agentName(value) {
    this._agentName = value || '';

    if (this._nameEl)
      this._nameEl.textContent = this._agentName + ':';
  }

  get thinkingText() { return this._thinkingText; }

  set thinkingText(value) {
    this._thinkingText = value || '';
    this._updateScroll();
  }

  connectedCallback() {
    if (!this._initialized) {
      this._initialized = true;
      this.appendChild(getTemplate().content.cloneNode(true));

      this._nameEl    = this.querySelector('.agent-name');
      this._scrollEl  = this.querySelector('.thinking-scroll-inner');
    }

    if (this._agentName)
      this._nameEl.textContent = this._agentName + ':';

    this._updateScroll();
  }

  _updateScroll() {
    if (!this._scrollEl)
      return;

    if (!this._thinkingText) {
      this._scrollEl.textContent = '';
      return;
    }

    let preview = this._thinkingText.length > 300 ? this._thinkingText.slice(-300) : this._thinkingText;
    preview = preview.replace(/\n+/g, ' \u2022 ').replace(/\s+/g, ' ').trim();
    // Duplicate for seamless loop
    this._scrollEl.textContent = preview + '    \u2022    ' + preview;
  }

  // Remove self with a fade-out
  dismiss() {
    this.style.opacity = '0';
    setTimeout(() => this.remove(), 300);
  }
}

if (typeof customElements !== 'undefined')
  customElements.define('kikx-typing-indicator', KikxTypingIndicator);

export default KikxTypingIndicator;
