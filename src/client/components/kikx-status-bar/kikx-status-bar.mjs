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
    :host {
      display: flex;
      align-items: center;
      justify-content: space-between;
      height: 30px;
      padding: 0 12px;
      font-size: 12px;
      font-family: var(--font-family, system-ui, sans-serif);
      color: var(--text-secondary, #a0a0b8);
      background: var(--glass-background, rgba(10, 10, 30, 0.7));
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border-top: 1px solid var(--border-glow, rgba(100, 200, 255, 0.15));
      box-shadow: 0 -1px 8px var(--glow-subtle, rgba(100, 200, 255, 0.05));
      box-sizing: border-box;
      user-select: none;
    }

    .connection-status {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .status-dot {
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--status-color, #ff4444);
    }

    .status-text {
      color: var(--text-secondary, #a0a0b8);
    }

    .cost-display {
      display: flex;
      align-items: center;
      gap: 4px;
      color: var(--text-secondary, #a0a0b8);
    }

    .cost-separator {
      margin: 0 4px;
      opacity: 0.5;
    }
  </style>

  <div class="connection-status">
    <span class="status-dot"></span>
    <span class="status-text"></span>
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
  return '$' + Number(value).toFixed(2);
}

class KikxStatusBar extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._unsubscribe = null;
  }

  connectedCallback() {
    this.shadowRoot.appendChild(getTemplate().content.cloneNode(true));
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

    let dot = this.shadowRoot.querySelector('.status-dot');
    let text = this.shadowRoot.querySelector('.status-text');
    let costDisplay = this.shadowRoot.querySelector('.cost-display');

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
      `<span>${globalLabel}: ${formatCost(costs.global)}</span>` +
      `<span class="cost-separator">|</span>` +
      `<span>${serviceLabel}: ${formatCost(costs.service)}</span>` +
      `<span class="cost-separator">|</span>` +
      `<span>${sessionLabel}: ${formatCost(costs.session)}</span>`;
  }
}

if (typeof customElements !== 'undefined')
  customElements.define('kikx-status-bar', KikxStatusBar);

export default KikxStatusBar;
