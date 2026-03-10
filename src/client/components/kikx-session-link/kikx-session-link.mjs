'use strict';

// =============================================================================
// kikx-session-link — Renders a session-link frame as a clickable card.
//
// Attributes:
//   target-session-id  — The session ID to navigate to
//   session-title      — Display name for the linked session
//   participant-count  — Number of participants (optional)
// =============================================================================

const TEMPLATE_HTML = `
  <style>
    :host {
      display: block;
      cursor: pointer;
    }

    .link-card {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm, 8px);
      padding: 10px 14px;
      background: var(--glass-background, rgba(255, 255, 255, 0.05));
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid var(--accent-dim, rgba(0, 229, 255, 0.10));
      border-radius: var(--border-radius-medium, 8px);
      color: var(--text-primary, #e8e8f0);
      transition: border-color 0.2s ease, box-shadow 0.2s ease;
    }

    .link-card:hover {
      border-color: var(--accent-primary, #00e5ff);
      box-shadow: 0 0 8px var(--accent-dim, rgba(0, 229, 255, 0.10));
    }

    .link-icon {
      flex-shrink: 0;
      width: 20px;
      height: 20px;
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--accent-primary, #00e5ff);
      font-size: 14px;
    }

    .link-details {
      flex: 1;
      min-width: 0;
    }

    .link-title {
      font-weight: 600;
      font-size: 0.9rem;
      color: var(--accent-primary, #00e5ff);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .link-meta {
      font-size: 0.8rem;
      color: var(--text-muted, #606078);
      margin-top: 2px;
    }

    .link-arrow {
      flex-shrink: 0;
      color: var(--text-muted, #606078);
      font-size: 14px;
      transition: transform 0.2s ease;
    }

    .link-card:hover .link-arrow {
      transform: translateX(2px);
      color: var(--accent-primary, #00e5ff);
    }
  </style>

  <div class="link-card">
    <div class="link-icon">#</div>
    <div class="link-details">
      <div class="link-title"></div>
      <div class="link-meta"></div>
    </div>
    <div class="link-arrow">&rsaquo;</div>
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

class KikxSessionLink extends HTMLElement {
  static get observedAttributes() {
    return ['target-session-id', 'session-title', 'participant-count'];
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.shadowRoot.appendChild(getTemplate().content.cloneNode(true));

    this._title = this.shadowRoot.querySelector('.link-title');
    this._meta  = this.shadowRoot.querySelector('.link-meta');
    this._card  = this.shadowRoot.querySelector('.link-card');

    this._onClick = this._onClick.bind(this);
  }

  connectedCallback() {
    this._render();
    this._card.addEventListener('click', this._onClick);
  }

  disconnectedCallback() {
    this._card.removeEventListener('click', this._onClick);
  }

  attributeChangedCallback() {
    if (this.isConnected)
      this._render();
  }

  _render() {
    let title = this.getAttribute('session-title') || 'Sub-session';
    let count = this.getAttribute('participant-count');

    this._title.textContent = title;

    if (count && parseInt(count, 10) > 0)
      this._meta.textContent = `${count} participant${(parseInt(count, 10) === 1) ? '' : 's'}`;
    else
      this._meta.textContent = 'Session';
  }

  _onClick() {
    let targetSessionId = this.getAttribute('target-session-id');
    if (!targetSessionId)
      return;

    this.dispatchEvent(new CustomEvent('select-session', {
      bubbles:  true,
      composed: true,
      detail:   { id: targetSessionId },
    }));
  }
}

if (typeof customElements !== 'undefined')
  customElements.define('kikx-session-link', KikxSessionLink);

export default KikxSessionLink;
