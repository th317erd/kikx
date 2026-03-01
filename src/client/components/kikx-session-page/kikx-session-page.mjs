'use strict';

const TEMPLATE_HTML = `
  <style>
    :host {
      display: grid;
      grid-template-areas:
        "topbar topbar"
        "chat sidebar"
        "statusbar statusbar";
      grid-template-columns: 1fr auto;
      grid-template-rows: auto 1fr auto;
      height: 100vh;
      overflow: hidden;
      background: var(--background-base, #0a0a1a);
      color: var(--text-primary, #e8e8f0);
    }

    kikx-top-bar {
      grid-area: topbar;
    }

    kikx-chat-view {
      grid-area: chat;
      overflow: hidden;
    }

    kikx-sidebar {
      grid-area: sidebar;
      width: 300px;
    }

    kikx-status-bar {
      grid-area: statusbar;
    }
  </style>

  <kikx-top-bar></kikx-top-bar>
  <kikx-chat-view></kikx-chat-view>
  <kikx-sidebar></kikx-sidebar>
  <kikx-status-bar></kikx-status-bar>
`;

let cachedTemplate = null;

function getTemplate() {
  if (!cachedTemplate) {
    cachedTemplate = document.createElement('template');
    cachedTemplate.innerHTML = TEMPLATE_HTML;
  }

  return cachedTemplate;
}

class KikxSessionPage extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  connectedCallback() {
    this.shadowRoot.appendChild(getTemplate().content.cloneNode(true));
  }

  get sessionId() {
    return this.getAttribute('data-id');
  }
}

if (typeof customElements !== 'undefined')
  customElements.define('kikx-session-page', KikxSessionPage);

export default KikxSessionPage;
