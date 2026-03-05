'use strict';

const TEMPLATE_HTML = `
  <style>
    :host { display: block; padding: var(--spacing-xs, 4px) 0; }
    .participant-row { display: flex; align-items: center; gap: 8px; padding: 6px var(--spacing-sm, 8px); border-radius: var(--border-radius-small, 4px); transition: background 0.2s ease; cursor: pointer; }
    .participant-row:hover { background: var(--glass-hover, rgba(255,255,255,0.08)); }
    .participant-avatar { width: 28px; height: 28px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 1rem; color: #fff; flex-shrink: 0; }
    .participant-name { flex: 1; font-size: 1rem; color: var(--text-primary, #e8e8f0); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .participant-role { font-size: 1rem; color: var(--text-muted, #606078); text-transform: uppercase; letter-spacing: 0.05em; flex-shrink: 0; }
    .coordinator-badge { color: var(--accent-primary, #00e5ff); }
    .empty-state { text-align: center; padding: 12px; color: var(--text-muted, #606078); font-size: 1rem; }
  </style>

  <div class="list-container"></div>
`;

let cachedTemplate = null;

function getTemplate() {
  if (!cachedTemplate) {
    cachedTemplate = document.createElement('template');
    cachedTemplate.innerHTML = TEMPLATE_HTML;
  }

  return cachedTemplate;
}

class KikxParticipantList extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.shadowRoot.appendChild(getTemplate().content.cloneNode(true));

    this._container    = this.shadowRoot.querySelector('.list-container');
    this._participants = [];

    this._onContainerClick = this._onContainerClick.bind(this);
  }

  connectedCallback() {
    this._render();
    this._container.addEventListener('click', this._onContainerClick);
  }

  disconnectedCallback() {
    this._container.removeEventListener('click', this._onContainerClick);
  }

  // ---------------------------------------------------------------------------
  // Public properties
  // ---------------------------------------------------------------------------

  set participants(value) {
    this._participants = value || [];
    this._render();
  }

  get participants() {
    return this._participants;
  }

  // ---------------------------------------------------------------------------
  // Event delegation
  // ---------------------------------------------------------------------------

  _onContainerClick(event) {
    let row = event.target.closest('.participant-row');
    if (!row) return;

    let participantId = row.dataset.participantId;

    this.dispatchEvent(new CustomEvent('select-participant', {
      bubbles:  true,
      composed: true,
      detail:   { participantId },
    }));
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  _render() {
    if (!this._container) return;

    if (this._participants.length === 0) {
      this._container.innerHTML = '';
      return;
    }

    let html = '';

    for (let participant of this._participants) {
      let roleClass = participant.role === 'coordinator' ? ' coordinator-badge' : '';

      html += `<div class="participant-row" data-participant-id="${participant.id}">`;
      html += `<div class="participant-avatar" style="background:${participant.color}">${participant.initials}</div>`;
      html += `<span class="participant-name">${participant.name}</span>`;
      html += `<span class="participant-role${roleClass}">${participant.isBot ? 'BOT' : participant.role || ''}</span>`;
      html += `</div>`;
    }

    this._container.innerHTML = html;
  }
}

if (typeof customElements !== 'undefined')
  customElements.define('kikx-participant-list', KikxParticipantList);

export default KikxParticipantList;
