'use strict';

import { t } from '../../lib/i18n.mjs';
import store, { connection } from '../../lib/store.mjs';

const STATUS_COLORS = {
  connected:    '#00ff88',
  connecting:   '#ffcc00',
  disconnected: '#ff4444',
};

const STATUS_KEYS = {
  connected:    'statusBar.connected',
  connecting:   'statusBar.connecting',
  disconnected: 'statusBar.disconnected',
};

const TEMPLATE_HTML = `
  <style>
    kikx-status-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      height: 30px;
      padding: 0 12px;
      position: relative;
      font-size: 1rem;
      font-family: var(--font-family, system-ui, sans-serif);
      color: var(--text-secondary, #a0a0b8);
      background: var(--glass-background, rgba(10, 10, 30, 0.7));
      backdrop-filter: blur(var(--glass-blur, 16px));
      -webkit-backdrop-filter: blur(var(--glass-blur, 16px));
      border-top: none;
      box-shadow: 0 -4px 20px rgba(0, 0, 0, 0.3);
      box-sizing: border-box;
      user-select: none;
    }

    kikx-status-bar::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 1px;
      background: linear-gradient(90deg,
        #ff4081, #b040ff, #448aff, #00e5ff, #00e676, #ffea00, #ff9100, #ff4081,
        #b040ff, #448aff, #00e5ff, #00e676, #ffea00, #ff9100, #ff4081);
      background-size: 200% 100%;
      animation: rainbow-scroll 60s linear infinite;
      box-shadow: 0 0 6px rgba(0, 229, 255, 0.2), 0 0 12px rgba(176, 64, 255, 0.1);
    }

    @keyframes rainbow-scroll {
      to { background-position: -200% 0; }
    }

    kikx-status-bar .connection-status {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    kikx-status-bar .status-dot {
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--status-color, #ff4444);
    }

    kikx-status-bar .status-text {
      color: var(--text-secondary, #a0a0b8);
    }

    kikx-status-bar .queue-hint {
      color: var(--accent-primary, #00e5ff);
      font-style: italic;
      margin-left: 4px;
    }

    kikx-status-bar .queue-hint:empty {
      display: none;
    }

    kikx-status-bar .cost-display {
      display: flex;
      align-items: center;
      gap: 4px;
      color: var(--text-secondary, #a0a0b8);
    }

    kikx-status-bar .cost-value {
      color: var(--accent-text, var(--accent-primary, #00e5ff));
    }

    kikx-status-bar .cost-separator {
      margin: 0 4px;
      opacity: 0.5;
    }
  </style>

  <div class="connection-status">
    <span class="status-dot"></span>
    <span class="status-text"></span>
    <span class="queue-hint"></span>
  </div>
  <div class="cost-display"></div>
`;

let cachedTemplate = null;

function getTemplate() {
  if (!cachedTemplate) {
    cachedTemplate = document.createElement('template');
    cachedTemplate.innerHTML = TEMPLATE_HTML;
  }

  return cachedTemplate;
}

function formatCost(value) {
  let n = Number(value);

  if (n >= 1)
    return '$' + n.toFixed(2);

  if (n >= 0.01)
    return '$' + n.toFixed(3);

  if (n > 0)
    return '$' + n.toFixed(4);

  return '$0.00';
}

class KikxStatusBar extends HTMLElement {
  constructor() {
    super();
    this._unsubscribe = null;
  }

  connectedCallback() {
    if (!this._initialized) {
      this._initialized = true;
      this.appendChild(getTemplate().content.cloneNode(true));
    }

    this.update();

    this._onStoreUpdate = ({ modified }) => {
      if (!modified || modified.includes('connection'))
        this.update();
    };

    store.on('update', this._onStoreUpdate);
  }

  disconnectedCallback() {
    if (this._onStoreUpdate) {
      store.off('update', this._onStoreUpdate);
      this._onStoreUpdate = null;
    }
  }

  update(options) {
    let status;
    let costs;

    if (options) {
      status = options.status;
      costs = options.costs;
    } else {
      status = connection.getStatus();
      costs = connection.getCosts();
    }

    let dot = this.querySelector('.status-dot');
    let text = this.querySelector('.status-text');
    let costDisplay = this.querySelector('.cost-display');

    if (!dot || !text || !costDisplay) {
      return;
    }

    let color = STATUS_COLORS[status] || STATUS_COLORS.disconnected;
    let label = t(STATUS_KEYS[status] || STATUS_KEYS.disconnected);

    dot.style.background = color;
    text.textContent = label;

    let globalLabel  = t('statusBar.globalCost');
    let serviceLabel = t('statusBar.serviceCost');
    let sessionLabel = t('statusBar.sessionCost');

    costDisplay.innerHTML =
      `<span>${globalLabel}: <span class="cost-value">${formatCost(costs.global)}</span></span>` +
      `<span class="cost-separator">|</span>` +
      `<span>${serviceLabel}: <span class="cost-value">${formatCost(costs.service)}</span></span>` +
      `<span class="cost-separator">|</span>` +
      `<span>${sessionLabel}: <span class="cost-value">${formatCost(costs.session)}</span></span>`;
  }

  setInteracting(isInteracting) {
    this._isInteracting = isInteracting;
    this._updateHint();
  }

  setQueueCount(count) {
    this._queueCount = count || 0;
    this._updateHint();
  }

  _updateHint() {
    let hint = this.querySelector('.queue-hint');
    if (!hint)
      return;

    if (this._queueCount > 0)
      hint.textContent = `${this._queueCount} queued (Esc to cancel)`;
    else if (this._isInteracting)
      hint.textContent = '(Esc to cancel)';
    else
      hint.textContent = '';
  }
}

if (typeof customElements !== 'undefined')
  customElements.define('kikx-status-bar', KikxStatusBar);

export default KikxStatusBar;
