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
//   detail: { permissionID, decisions: [{ command, decision }] }
// =============================================================================

const DECISION_BUTTONS = [
  { decision: 'allow-forever', icon: '\uD83D\uDCAF',             tooltipKey: 'permission.allowForever',   activeClass: 'active-allow' },
  { decision: 'allow-once',    icon: '\uD83D\uDC4D',             tooltipKey: 'permission.allowOnceShort', activeClass: 'active-allow' },
  { decision: 'deny-once',     icon: '\uD83D\uDC4E',             tooltipKey: 'permission.denyOnce',       activeClass: 'active-deny' },
  { decision: 'deny-forever',  icon: '\uD83D\uDEAB',             tooltipKey: 'permission.denyForever',    activeClass: 'active-deny' },
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

    .full-command {
      display: block;
      padding: 8px 10px;
      margin-bottom: var(--spacing-sm, 8px);
      background: rgba(0, 0, 0, 0.25);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: var(--border-radius-small, 4px);
      font-family: 'Fira Code', 'Cascadia Code', monospace;
      font-size: 0.9rem;
      color: var(--text-primary, #e8e8f0);
      white-space: pre-wrap;
      word-break: break-all;
      line-height: 1.5;
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

    .decision-area {
      display: flex; flex-direction: column; align-items: flex-start;
      gap: 4px; flex-shrink: 0;
    }

    .decision-label {
      font-size: 0.75rem; font-weight: 600;
      color: var(--text-secondary, #a0a0b8);
      line-height: 1;
    }

    .decision-label.label-allow { color: #66bb6a; }
    .decision-label.label-caution { color: #fdd835; }
    .decision-label.label-deny { color: #ff4444; }

    .decision-label.label-deny-shake {
      color: #ff4444;
      animation: shake 0.4s ease-in-out infinite;
    }

    @keyframes shake {
      0%, 100% { transform: translateX(0); }
      20%      { transform: translateX(-2px); }
      40%      { transform: translateX(2px); }
      60%      { transform: translateX(-2px); }
      80%      { transform: translateX(1px); }
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

    .processed-badge.badge-allow { color: #66bb6a; }
    .processed-badge.badge-caution { color: #fdd835; }
    .processed-badge.badge-deny { color: #ff4444; }

    :host([processed]) .processed-badge { display: block; }

    .expired-badge {
      display: none; font-size: 1rem; font-weight: 600;
      color: #ef9a9a; padding: 4px 0;
    }

    :host([expired]) .command-table,
    :host([expired]) .confirm-button { display: none; }
    :host([expired]) .processed-badge { display: none; }
    :host([expired]) .expired-badge { display: block; }
  </style>

  <div class="permission-header">
    <span class="lightning-icon">\u26A1</span>
    <span class="title-text"></span>
  </div>
  <div class="permission-description"></div>
  <code class="full-command" style="display:none;"></code>
  <div class="command-table"></div>
  <button class="confirm-button" disabled></button>
  <div class="processed-badge">\u2713 Processed</div>
  <div class="expired-badge">\u23F0 Expired — please resend your message</div>
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
  static get observedAttributes() { return ['processed', 'expired', 'permission-id']; }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.shadowRoot.appendChild(getTemplate().content.cloneNode(true));

    this._titleText      = this.shadowRoot.querySelector('.title-text');
    this._descriptionEl  = this.shadowRoot.querySelector('.permission-description');
    this._fullCommandEl  = this.shadowRoot.querySelector('.full-command');
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

  attributeChangedCallback(name) {
    if (name === 'processed')
      this._updateProcessedBadge();
  }

  _updateProcessedBadge() {
    if (!this.hasAttribute('processed'))
      return;

    // Collect unique decisions
    let decisions = [...this._decisions.values()];
    if (decisions.length === 0)
      return;

    // For a single decision (or all the same), show it directly
    let unique = [...new Set(decisions)];

    if (unique.length === 1) {
      let decision = unique[0];

      this._processedBadge.className = 'processed-badge';

      switch (decision) {
        case 'allow-forever':
          this._processedBadge.textContent = '\u2713 ' + (t('permission.allowForever') || 'Allow forever');
          this._processedBadge.classList.add('badge-allow');
          break;
        case 'allow-once':
          this._processedBadge.textContent = '\u2713 ' + (t('permission.allowOnceShort') || 'Allow once');
          this._processedBadge.classList.add('badge-allow');
          break;
        case 'deny-once':
          this._processedBadge.textContent = '\u2717 ' + (t('permission.denyOnce') || 'Deny once');
          this._processedBadge.classList.add('badge-caution');
          break;
        case 'deny-forever':
          this._processedBadge.textContent = '\u2717 ' + (t('permission.denyForever') || 'Deny forever');
          this._processedBadge.classList.add('badge-deny');
          break;
      }
    } else {
      // Mixed decisions — show summary
      let hasAllow = decisions.some((d) => d.startsWith('allow'));
      let hasDeny  = decisions.some((d) => d.startsWith('deny'));

      this._processedBadge.className = 'processed-badge';

      if (hasAllow && hasDeny) {
        this._processedBadge.textContent = '\u2713 Mixed decisions applied';
        this._processedBadge.classList.add('badge-caution');
      } else if (hasAllow) {
        this._processedBadge.textContent = '\u2713 Allowed';
        this._processedBadge.classList.add('badge-allow');
      } else {
        this._processedBadge.textContent = '\u2717 Denied';
        this._processedBadge.classList.add('badge-deny');
      }
    }
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

  get fullCommand() {
    return this._fullCommandEl.textContent;
  }

  set fullCommand(value) {
    if (value) {
      this._fullCommandEl.textContent  = value;
      this._fullCommandEl.style.display = '';
    } else {
      this._fullCommandEl.textContent  = '';
      this._fullCommandEl.style.display = 'none';
    }
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
        // Decision area: label + buttons
        let decisionArea = document.createElement('div');
        decisionArea.className = 'decision-area';

        let label = document.createElement('span');
        label.className = 'decision-label';
        label.textContent = 'Please select:';
        decisionArea.appendChild(label);

        let buttonsContainer = document.createElement('div');
        buttonsContainer.className = 'decision-buttons';

        let currentDecision = this._decisions.get(cmd.command);

        for (let btn of DECISION_BUTTONS) {
          let button = document.createElement('button');
          button.className = 'decision-button';
          button.textContent = btn.icon;
          button.title = t(btn.tooltipKey) || btn.decision;
          button.setAttribute('data-decision', btn.decision);
          button.setAttribute('data-active-class', btn.activeClass);

          // Restore active state if decision already selected
          if (currentDecision === btn.decision)
            button.classList.add(btn.activeClass);

          buttonsContainer.appendChild(button);
        }

        decisionArea.appendChild(buttonsContainer);
        row.appendChild(decisionArea);

        // Restore label state if decision already selected
        if (currentDecision)
          this._updateDecisionLabel(label, currentDecision);
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

    // Update the decision label
    let label = row.querySelector('.decision-label');
    if (label)
      this._updateDecisionLabel(label, decision);

    // Store decision
    this._decisions.set(command, decision);
    this._updateConfirmState();
  }

  _updateDecisionLabel(label, decision) {
    label.className = 'decision-label';

    switch (decision) {
      case 'allow-forever':
        label.textContent = t('permission.allowForever') || 'Allow forever';
        label.classList.add('label-allow');
        break;
      case 'allow-once':
        label.textContent = t('permission.allowOnceShort') || 'Allow once';
        label.classList.add('label-allow');
        break;
      case 'deny-once':
        label.textContent = t('permission.denyOnce') || 'Deny once';
        label.classList.add('label-caution');
        break;
      case 'deny-forever':
        label.textContent = t('permission.denyForever') || 'Deny forever';
        label.classList.add('label-deny-shake');
        break;
      default:
        label.textContent = 'Please select:';
        break;
    }
  }

  _updateConfirmState() {
    // No sub-commands (simple tool permission) — enable confirm immediately
    if (this._commands.length === 0) {
      this._confirmButton.disabled = false;
      return;
    }

    // Confirm is enabled when ALL commands have a decision
    let allDecided = this._commands.every(
      (cmd) => this._decisions.has(cmd.command),
    );

    this._confirmButton.disabled = !allDecided;
  }

  _onConfirmClick() {
    let decisions = [];

    for (let [command, decision] of this._decisions.entries()) {
      // Look up arguments from the original commands data
      let cmdData   = this._commands.find((c) => c.command === command);
      let args      = (cmdData && cmdData.arguments) || [];

      decisions.push({ command, arguments: args, decision });
    }

    this.dispatchEvent(new CustomEvent('permission-response', {
      bubbles:  true,
      composed: true,
      detail: {
        permissionID: this.getAttribute('permission-id') || '',
        decisions,
      },
    }));
  }
}

if (typeof customElements !== 'undefined')
  customElements.define('kikx-permission-request', KikxPermissionRequest);

export default KikxPermissionRequest;
