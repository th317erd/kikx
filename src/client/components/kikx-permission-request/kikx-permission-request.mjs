'use strict';

import { t } from '../../lib/i18n.mjs';

// =============================================================================
// KikxPermissionRequest — per-command shell permission UI
// =============================================================================
// Renders a table of parsed shell commands with per-command decision buttons.
// Each command row has 4 mutually exclusive icon buttons:
//   Allow forever | Allow once | Deny once | Deny forever
//
// Properties:
//   commands  — array of { command, arguments, status }
//   (status: 'needs-approval' | 'allowed')
//
// Dispatches 'permission-response' event on submit with:
//   detail: { permissionId, decisions: [{ command, decision }] }
// =============================================================================

const DECISION_BUTTONS = [
  { decision: 'allow-forever', icon: '\uD83D\uDC4D\uD83D\uDD12', tooltipKey: 'permission.allowForever',   activeClass: 'active-allow' },
  { decision: 'allow-once',    icon: '\uD83D\uDC4D',             tooltipKey: 'permission.allowOnceShort', activeClass: 'active-allow' },
  { decision: 'deny-once',     icon: '\uD83D\uDC4E',             tooltipKey: 'permission.denyOnce',       activeClass: 'active-deny' },
  { decision: 'deny-forever',  icon: '\uD83D\uDC4E\uD83D\uDD12', tooltipKey: 'permission.denyForever',    activeClass: 'active-deny' },
];

const TEMPLATE_HTML = `
  <style>
    :host { display: block; padding: var(--spacing-sm, 8px); }

    .permission-header {
      display: flex; align-items: center; gap: var(--spacing-xs, 4px);
      margin-bottom: var(--spacing-sm, 8px);
      font-weight: 600; font-size: 1rem;
      color: var(--text-primary, #e8e8f0);
    }

    .lightning-icon { font-size: 1.125rem; }

    .permission-description {
      font-size: 1rem; color: var(--text-secondary, #a0a0b8);
      margin-bottom: var(--spacing-sm, 8px); line-height: 1.4;
    }

    .command-table {
      display: flex; flex-direction: column; gap: 6px;
      margin-bottom: var(--spacing-sm, 8px);
    }

    .command-row {
      display: flex; align-items: center; gap: 8px;
      padding: 6px 8px;
      border-radius: var(--border-radius-small, 4px);
      background: rgba(255, 255, 255, 0.04);
    }

    .command-row.pre-approved {
      opacity: 0.6;
    }

    .command-text {
      flex: 1;
      font-family: 'Fira Code', 'Cascadia Code', monospace;
      font-size: 0.9rem;
      color: var(--text-primary, #e8e8f0);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .pre-approved-badge {
      font-size: 0.75rem;
      color: #66bb6a;
      font-weight: 600;
      white-space: nowrap;
    }

    .decision-buttons {
      display: flex; gap: 4px;
      flex-shrink: 0;
    }

    .decision-button {
      background: transparent;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: var(--border-radius-small, 4px);
      padding: 4px 6px;
      cursor: pointer;
      font-size: 0.85rem;
      line-height: 1;
      transition: background 0.15s ease, border-color 0.15s ease;
      color: var(--text-secondary, #a0a0b8);
    }

    .decision-button:hover {
      background: rgba(255, 255, 255, 0.08);
    }

    .decision-button.active-allow {
      background: rgba(102, 187, 106, 0.20);
      border-color: #66bb6a;
      color: #66bb6a;
    }

    .decision-button.active-deny {
      background: rgba(255, 68, 68, 0.20);
      border-color: #ff4444;
      color: #ff4444;
    }

    .confirm-button {
      background: var(--accent-primary, #00e5ff); color: #ffffff;
      border: none; border-radius: var(--border-radius-small, 4px);
      padding: 8px 16px; font-weight: 600; font-size: 1rem;
      cursor: pointer; transition: box-shadow 0.2s ease;
    }

    .confirm-button:hover { box-shadow: 0 0 12px var(--accent-glow, rgba(0, 229, 255, 0.40)); }
    .confirm-button:disabled { opacity: 0.5; cursor: not-allowed; }

    :host([processed]) .command-table,
    :host([processed]) .confirm-button { display: none; }

    .processed-badge {
      display: none; font-size: 1rem; font-weight: 600;
      color: #66bb6a; padding: 4px 0;
    }

    :host([processed]) .processed-badge { display: block; }
  </style>

  <div class="permission-header">
    <span class="lightning-icon">\u26A1</span>
    <span class="title-text"></span>
  </div>
  <div class="permission-description"></div>
  <div class="command-table"></div>
  <button class="confirm-button" disabled></button>
  <div class="processed-badge">\u2713 Processed</div>
`;

let cachedTemplate = null;

function getTemplate() {
  if (!cachedTemplate) {
    cachedTemplate = document.createElement('template');
    cachedTemplate.innerHTML = TEMPLATE_HTML;
  }

  return cachedTemplate;
}

class KikxPermissionRequest extends HTMLElement {
  static get observedAttributes() { return ['processed', 'permission-id']; }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.shadowRoot.appendChild(getTemplate().content.cloneNode(true));

    this._titleText      = this.shadowRoot.querySelector('.title-text');
    this._descriptionEl  = this.shadowRoot.querySelector('.permission-description');
    this._commandTable   = this.shadowRoot.querySelector('.command-table');
    this._confirmButton  = this.shadowRoot.querySelector('.confirm-button');
    this._processedBadge = this.shadowRoot.querySelector('.processed-badge');

    this._decisions = new Map();
    this._commands  = [];

    this._onConfirmClick    = this._onConfirmClick.bind(this);
    this._onDecisionClick   = this._onDecisionClick.bind(this);
  }

  connectedCallback() {
    this._titleText.textContent    = t('permission.title');
    this._confirmButton.textContent = t('permission.confirmButton') || 'Confirm';

    this._confirmButton.addEventListener('click', this._onConfirmClick);
    this._commandTable.addEventListener('click', this._onDecisionClick);

    this._render();
  }

  disconnectedCallback() {
    this._confirmButton.removeEventListener('click', this._onConfirmClick);
    this._commandTable.removeEventListener('click', this._onDecisionClick);
  }

  // ---------------------------------------------------------------------------
  // Properties
  // ---------------------------------------------------------------------------

  get description() {
    return this._descriptionEl.textContent;
  }

  set description(value) {
    this._descriptionEl.textContent = value || '';
  }

  get commands() {
    return this._commands;
  }

  set commands(value) {
    this._commands = Array.isArray(value) ? value : [];
    this._decisions.clear();

    // Pre-populate decisions for already-allowed commands
    for (let cmd of this._commands) {
      if (cmd.status === 'allowed')
        this._decisions.set(cmd.command, 'allow-once');
    }

    this._render();
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  _render() {
    this._commandTable.innerHTML = '';

    for (let cmd of this._commands) {
      let row = document.createElement('div');
      row.className = 'command-row';
      row.setAttribute('data-command', cmd.command);

      // Command text (command + arguments)
      let textEl   = document.createElement('code');
      textEl.className = 'command-text';
      let fullCmd  = cmd.command;
      if (cmd.arguments && cmd.arguments.length > 0)
        fullCmd += ' ' + cmd.arguments.join(' ');

      textEl.textContent = fullCmd;
      row.appendChild(textEl);

      if (cmd.status === 'allowed') {
        // Pre-approved: show badge, no buttons
        row.classList.add('pre-approved');

        let badge = document.createElement('span');
        badge.className    = 'pre-approved-badge';
        badge.textContent  = t('permission.preApproved') || 'Pre-approved';
        row.appendChild(badge);
      } else {
        // Decision buttons
        let buttonsContainer = document.createElement('div');
        buttonsContainer.className = 'decision-buttons';

        for (let btn of DECISION_BUTTONS) {
          let button = document.createElement('button');
          button.className = 'decision-button';
          button.textContent = btn.icon;
          button.title = t(btn.tooltipKey) || btn.decision;
          button.setAttribute('data-decision', btn.decision);
          button.setAttribute('data-active-class', btn.activeClass);

          // Restore active state if decision already selected
          let currentDecision = this._decisions.get(cmd.command);
          if (currentDecision === btn.decision)
            button.classList.add(btn.activeClass);

          buttonsContainer.appendChild(button);
        }

        row.appendChild(buttonsContainer);
      }

      this._commandTable.appendChild(row);
    }

    this._updateConfirmState();
  }

  // ---------------------------------------------------------------------------
  // Event handlers
  // ---------------------------------------------------------------------------

  _onDecisionClick(event) {
    let button = event.target.closest('.decision-button');
    if (!button)
      return;

    let row     = button.closest('.command-row');
    let command = row && row.getAttribute('data-command');
    if (!command)
      return;

    let decision    = button.getAttribute('data-decision');
    let activeClass = button.getAttribute('data-active-class');

    // Deactivate all siblings
    let siblings = row.querySelectorAll('.decision-button');
    for (let sibling of siblings) {
      sibling.classList.remove('active-allow', 'active-deny');
    }

    // Activate clicked button
    button.classList.add(activeClass);

    // Store decision
    this._decisions.set(command, decision);
    this._updateConfirmState();
  }

  _updateConfirmState() {
    // Confirm is enabled when ALL commands have a decision
    let allDecided = this._commands.length > 0 && this._commands.every(
      (cmd) => this._decisions.has(cmd.command),
    );

    this._confirmButton.disabled = !allDecided;
  }

  _onConfirmClick() {
    let decisions = [];

    for (let [command, decision] of this._decisions.entries())
      decisions.push({ command, decision });

    this.dispatchEvent(new CustomEvent('permission-response', {
      bubbles:  true,
      composed: true,
      detail: {
        permissionId: this.getAttribute('permission-id') || '',
        decisions,
      },
    }));
  }
}

if (typeof customElements !== 'undefined')
  customElements.define('kikx-permission-request', KikxPermissionRequest);

export default KikxPermissionRequest;
