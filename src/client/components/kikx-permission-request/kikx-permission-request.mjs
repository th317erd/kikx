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
    kikx-permission-request { display: block; padding: var(--spacing-sm, 8px); }

    kikx-permission-request .permission-header {
      display: flex; align-items: center; gap: var(--spacing-xs, 4px);
      margin-bottom: var(--spacing-sm, 8px);
      font-weight: 600; font-size: 1rem;
      color: var(--text-primary, #e8e8f0);
    }

    kikx-permission-request .lightning-icon { font-size: 1.125rem; }

    kikx-permission-request .permission-description {
      font-size: 1rem; color: var(--text-secondary, #a0a0b8);
      margin-bottom: var(--spacing-sm, 8px); line-height: 1.4;
    }

    kikx-permission-request .full-command {
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

    kikx-permission-request .permission-tool-args code {
      font-family: 'Fira Code', 'Cascadia Code', monospace;
      font-size: 0.85em;
      color: var(--text-muted, #606078);
      display: block;
      max-height: 120px;
      overflow-y: auto;
      white-space: pre-wrap;
      word-break: break-all;
      padding: 4px 8px;
      background: rgba(0, 0, 0, 0.2);
      border-radius: 4px;
      margin-top: 4px;
      margin-bottom: var(--spacing-sm, 8px);
    }

    kikx-permission-request .permission-details {
      margin-top: 4px;
    }

    kikx-permission-request .detail-row {
      display: flex;
      gap: 8px;
      padding: 2px 0;
      font-size: 0.9em;
    }

    kikx-permission-request .detail-label {
      color: var(--text-muted, #606078);
      white-space: nowrap;
      min-width: 80px;
    }

    kikx-permission-request .detail-value {
      color: var(--text-primary, #e0e0f0);
      word-break: break-word;
      max-height: 100px;
      overflow-y: auto;
    }

    kikx-permission-request .command-table {
      display: flex; flex-direction: column; gap: 6px;
      margin-bottom: var(--spacing-sm, 8px);
    }

    kikx-permission-request .command-row {
      display: flex; align-items: center; gap: 8px;
      padding: 6px 8px;
      border-radius: var(--border-radius-small, 4px);
      background: rgba(255, 255, 255, 0.04);
    }

    kikx-permission-request .command-row.header-row {
      border-bottom: 1px solid rgba(255, 255, 255, 0.10);
      padding-bottom: 8px;
      margin-bottom: 2px;
    }

    kikx-permission-request .header-label {
      font-weight: 600;
      font-style: italic;
    }

    kikx-permission-request .command-row.pre-approved {
      opacity: 0.6;
    }

    kikx-permission-request .command-text {
      flex: 1;
      font-family: 'Fira Code', 'Cascadia Code', monospace;
      font-size: 0.9rem;
      color: var(--text-primary, #e8e8f0);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    kikx-permission-request .pre-approved-badge {
      font-size: 0.75rem;
      color: #66bb6a;
      font-weight: 600;
      white-space: nowrap;
    }

    kikx-permission-request .decision-area {
      display: flex; flex-direction: column; align-items: flex-start;
      gap: 4px; flex-shrink: 0;
    }

    kikx-permission-request .decision-label {
      font-size: 0.75rem; font-weight: 600;
      color: var(--text-secondary, #a0a0b8);
      line-height: 1;
    }

    kikx-permission-request .decision-label.label-allow { color: #66bb6a; }
    kikx-permission-request .decision-label.label-caution { color: #fdd835; }
    kikx-permission-request .decision-label.label-deny { color: #ff4444; }

    kikx-permission-request .decision-label.label-nod { animation: nod 1.5s ease-in-out infinite; }
    kikx-permission-request .decision-label.label-shake { animation: headshake 1.5s ease-in-out infinite; }

    @keyframes nod {
      0%, 100% { transform: translateY(0); }
      30%      { transform: translateY(2px); }
      60%      { transform: translateY(-1px); }
    }

    @keyframes headshake {
      0%, 100% { transform: translateX(0); }
      20%      { transform: translateX(-3px); }
      40%      { transform: translateX(3px); }
      60%      { transform: translateX(-2px); }
      80%      { transform: translateX(1px); }
    }

    kikx-permission-request .decision-buttons {
      display: flex; gap: 4px;
      flex-shrink: 0;
    }

    kikx-permission-request .decision-button {
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

    kikx-permission-request .decision-button:hover {
      background: rgba(255, 255, 255, 0.08);
    }

    kikx-permission-request .decision-button.active-allow {
      background: rgba(102, 187, 106, 0.20);
      border-color: #66bb6a;
      color: #66bb6a;
    }

    kikx-permission-request .decision-button.active-deny {
      background: rgba(255, 68, 68, 0.20);
      border-color: #ff4444;
      color: #ff4444;
    }

    kikx-permission-request .confirm-button {
      background: var(--accent-primary, #00e5ff); color: #ffffff;
      border: none; border-radius: var(--border-radius-small, 4px);
      padding: 8px 16px; font-weight: 600; font-size: 1rem;
      cursor: pointer; transition: box-shadow 0.2s ease;
    }

    kikx-permission-request .confirm-button:hover { box-shadow: 0 0 12px var(--accent-glow, rgba(0, 229, 255, 0.40)); }
    kikx-permission-request .confirm-button:disabled { opacity: 0.5; cursor: not-allowed; }

    kikx-permission-request[processed] .command-table,
    kikx-permission-request[processed] .confirm-button { display: none; }

    kikx-permission-request .processed-badge {
      display: none; font-size: 1rem; font-weight: 600;
      color: #66bb6a; padding: 4px 0;
    }

    kikx-permission-request .processed-badge.badge-allow { color: #66bb6a; }
    kikx-permission-request .processed-badge.badge-caution { color: #fdd835; }
    kikx-permission-request .processed-badge.badge-deny { color: #ff4444; }

    kikx-permission-request[processed] .processed-badge { display: block; }

    kikx-permission-request .expired-badge {
      display: none; font-size: 1rem; font-weight: 600;
      color: #ef9a9a; padding: 4px 0;
    }

    kikx-permission-request[expired] .command-table,
    kikx-permission-request[expired] .confirm-button { display: none; }
    kikx-permission-request[expired] .processed-badge { display: none; }
    kikx-permission-request[expired] .expired-badge { display: block; }
  </style>

  <div class="permission-header">
    <span class="lightning-icon">\u26A1</span>
    <span class="title-text"></span>
  </div>
  <div class="permission-description"></div>
  <div class="permission-details" style="display:none;"></div>
  <div class="permission-tool-args" style="display:none;"><code></code></div>
  <code class="full-command" style="display:none;"></code>
  <div class="command-table"></div>
  <button class="confirm-button" disabled></button>
  <div class="processed-badge">\u2713 Processed</div>
  <div class="expired-badge">\u23F0 Expired — please resend your message</div>
`;

function _formatLabelFallback(key) {
  // 'permission.detail.targetSession' → 'targetSession' → 'Target Session'
  let lastPart = key.includes('.') ? key.split('.').pop() : key;
  // camelCase or snake_case → Title Case
  return lastPart
    .replace(/([a-z])([A-Z])/g, '$1 $2')  // camelCase → words
    .replace(/_/g, ' ')                      // snake_case → words
    .replace(/\b\w/g, (c) => c.toUpperCase()); // Title Case
}

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
    this._decisions = new Map();
    this._commands  = [];

    // Backing fields for properties that may be set before DOM connection
    this._description           = '';
    this._toolArgsValue         = '';
    this._fullCommandValue      = '';
    this._permissionContextValue = null;

    this._onConfirmClick    = this._onConfirmClick.bind(this);
    this._onDecisionClick   = this._onDecisionClick.bind(this);
  }

  connectedCallback() {
    if (!this._initialized) {
      this._initialized = true;
      this.appendChild(getTemplate().content.cloneNode(true));

      this._titleText      = this.querySelector('.title-text');
      this._descriptionEl  = this.querySelector('.permission-description');
      this._detailsEl      = this.querySelector('.permission-details');
      this._toolArgsEl     = this.querySelector('.permission-tool-args');
      this._toolArgsCodeEl = this._toolArgsEl.querySelector('code');
      this._fullCommandEl  = this.querySelector('.full-command');
      this._commandTable   = this.querySelector('.command-table');
      this._confirmButton  = this.querySelector('.confirm-button');
      this._processedBadge = this.querySelector('.processed-badge');
    }

    this._titleText.textContent    = t('permission.title');
    this._confirmButton.textContent = t('permission.confirmButton') || 'Confirm';

    // Re-apply backing values that may have been set before DOM connection
    if (this._description)
      this._descriptionEl.textContent = this._description;

    if (this._toolArgsValue) {
      this._toolArgsCodeEl.textContent = this._toolArgsValue;
      this._toolArgsEl.style.display   = '';
    }

    if (this._fullCommandValue) {
      this._fullCommandEl.textContent  = this._fullCommandValue;
      this._fullCommandEl.style.display = '';
    }

    if (this._permissionContextValue)
      this._applyPermissionContext(this._permissionContextValue);

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
    if (!this._processedBadge)
      return;

    if (!this.hasAttribute('processed'))
      return;

    // Collect unique decisions from live interaction
    let decisions = [...this._decisions.values()];

    // Fallback to persisted decision from frame content (historical loads)
    if (decisions.length === 0 && this.resolvedDecision)
      decisions = [this.resolvedDecision];

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
    return this._description;
  }

  set description(value) {
    this._description = value || '';

    if (this._descriptionEl)
      this._descriptionEl.textContent = this._description;
  }

  get toolArgs() {
    return this._toolArgsValue;
  }

  set toolArgs(value) {
    this._toolArgsValue = value || '';

    if (!this._toolArgsEl || !this._toolArgsCodeEl)
      return;

    if (this._toolArgsValue) {
      this._toolArgsCodeEl.textContent  = this._toolArgsValue;
      this._toolArgsEl.style.display    = '';
    } else {
      this._toolArgsCodeEl.textContent  = '';
      this._toolArgsEl.style.display    = 'none';
    }
  }

  get fullCommand() {
    return this._fullCommandValue;
  }

  set fullCommand(value) {
    this._fullCommandValue = value || '';

    if (!this._fullCommandEl)
      return;

    if (this._fullCommandValue) {
      this._fullCommandEl.textContent  = this._fullCommandValue;
      this._fullCommandEl.style.display = '';
    } else {
      this._fullCommandEl.textContent  = '';
      this._fullCommandEl.style.display = 'none';
    }
  }

  get permissionContext() {
    return this._permissionContextValue;
  }

  set permissionContext(value) {
    this._permissionContextValue = value || null;

    if (this._detailsEl && this._permissionContextValue)
      this._applyPermissionContext(this._permissionContextValue);
  }

  _applyPermissionContext(ctx) {
    // Resolve title via I18N (fallback: use as-is)
    if (ctx.title) {
      let resolved = t(ctx.title, ctx.titleParams);
      this._titleText.textContent = resolved;
    }

    // Resolve description via I18N
    if (ctx.description) {
      let resolved = t(ctx.description, ctx.titleParams);
      this._descriptionEl.textContent = resolved;
    }

    // Hide toolArgs display — permissionContext takes priority
    if (this._toolArgsEl)
      this._toolArgsEl.style.display = 'none';

    // Render detail rows
    if (ctx.details && ctx.details.length > 0) {
      this._detailsEl.innerHTML = '';

      for (let detail of ctx.details) {
        let row = document.createElement('div');
        row.className = 'detail-row';

        let labelEl = document.createElement('span');
        labelEl.className = 'detail-label';
        let labelText = t(detail.label);
        // If t() returned the key itself (not found), use fallback formatting
        if (labelText === detail.label)
          labelText = _formatLabelFallback(detail.label);
        labelEl.textContent = labelText + ':';

        let valueEl = document.createElement('span');
        valueEl.className = 'detail-value';
        valueEl.textContent = detail.value || '';

        row.appendChild(labelEl);
        row.appendChild(valueEl);
        this._detailsEl.appendChild(row);
      }

      this._detailsEl.style.display = '';
    } else {
      this._detailsEl.style.display = 'none';
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
    if (!this._commandTable)
      return;

    this._commandTable.innerHTML = '';

    // Add "select all" header row when multiple commands need approval
    let needsApproval = this._commands.filter((c) => c.status !== 'allowed');
    if (needsApproval.length > 1) {
      let headerRow = document.createElement('div');
      headerRow.className = 'command-row header-row';

      let headerLabel = document.createElement('span');
      headerLabel.className = 'command-text header-label';
      headerLabel.textContent = 'All';
      headerRow.appendChild(headerLabel);

      let headerArea = document.createElement('div');
      headerArea.className = 'decision-area';

      let headerDecisionLabel = document.createElement('span');
      headerDecisionLabel.className = 'decision-label';
      headerDecisionLabel.textContent = 'Select all:';
      headerArea.appendChild(headerDecisionLabel);

      let headerButtons = document.createElement('div');
      headerButtons.className = 'decision-buttons';

      for (let btn of DECISION_BUTTONS) {
        let button = document.createElement('button');
        button.className = 'decision-button';
        button.textContent = btn.icon;
        button.title = (t(btn.tooltipKey) || btn.decision) + ' (all)';
        button.setAttribute('data-decision', btn.decision);
        button.setAttribute('data-active-class', btn.activeClass);
        button.setAttribute('data-select-all', 'true');
        headerButtons.appendChild(button);
      }

      headerArea.appendChild(headerButtons);
      headerRow.appendChild(headerArea);
      this._commandTable.appendChild(headerRow);
    }

    for (let cmd of this._commands) {
      let row = document.createElement('div');
      row.className = 'command-row';
      row.setAttribute('data-command', cmd.command);

      // Command text (command + arguments)
      // Hide when fullCommand is already shown and there's only one command (avoids duplication)
      let showCommandText = !(this._fullCommandEl.style.display !== 'none' && this._commands.length === 1);

      if (showCommandText) {
        let textEl   = document.createElement('code');
        textEl.className = 'command-text';
        let fullCmd  = cmd.command;
        if (cmd.arguments && cmd.arguments.length > 0)
          fullCmd += ' ' + cmd.arguments.join(' ');

        textEl.textContent = fullCmd;
        row.appendChild(textEl);
      }

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

    let decision    = button.getAttribute('data-decision');
    let activeClass = button.getAttribute('data-active-class');

    // Select-all header button — apply to every command row
    if (button.hasAttribute('data-select-all')) {
      this._applyDecisionToAll(decision, activeClass);
      return;
    }

    let row     = button.closest('.command-row');
    let command = row && row.getAttribute('data-command');
    if (!command)
      return;

    this._applyDecisionToRow(row, command, decision, activeClass);
    this._updateConfirmState();
  }

  _applyDecisionToRow(row, command, decision, activeClass) {
    // Deactivate all siblings
    let siblings = row.querySelectorAll('.decision-button');
    for (let sibling of siblings)
      sibling.classList.remove('active-allow', 'active-deny');

    // Activate the matching button
    let matchingButton = row.querySelector(`.decision-button[data-decision="${decision}"]`);
    if (matchingButton)
      matchingButton.classList.add(activeClass);

    // Update the decision label
    let label = row.querySelector('.decision-label');
    if (label)
      this._updateDecisionLabel(label, decision);

    // Store decision
    this._decisions.set(command, decision);
  }

  _applyDecisionToAll(decision, activeClass) {
    // Apply to header row
    let headerRow = this._commandTable.querySelector('.header-row');
    if (headerRow) {
      let siblings = headerRow.querySelectorAll('.decision-button');
      for (let sibling of siblings)
        sibling.classList.remove('active-allow', 'active-deny');

      let matchingButton = headerRow.querySelector(`.decision-button[data-decision="${decision}"]`);
      if (matchingButton)
        matchingButton.classList.add(activeClass);

      let label = headerRow.querySelector('.decision-label');
      if (label)
        this._updateDecisionLabel(label, decision);
    }

    // Apply to each command row
    let rows = this._commandTable.querySelectorAll('.command-row:not(.header-row):not(.pre-approved)');
    for (let row of rows) {
      let command = row.getAttribute('data-command');
      if (!command)
        continue;

      this._applyDecisionToRow(row, command, decision, activeClass);
    }

    this._updateConfirmState();
  }

  _updateDecisionLabel(label, decision) {
    label.className = 'decision-label';

    switch (decision) {
      case 'allow-forever':
        label.textContent = t('permission.allowForever') || 'Allow forever';
        label.classList.add('label-allow', 'label-nod');
        break;
      case 'allow-once':
        label.textContent = t('permission.allowOnceShort') || 'Allow once';
        label.classList.add('label-allow', 'label-nod');
        break;
      case 'deny-once':
        label.textContent = t('permission.denyOnce') || 'Deny once';
        label.classList.add('label-caution', 'label-shake');
        break;
      case 'deny-forever':
        label.textContent = t('permission.denyForever') || 'Deny forever';
        label.classList.add('label-deny', 'label-shake');
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
