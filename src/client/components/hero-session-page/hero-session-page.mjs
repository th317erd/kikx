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

    hero-top-bar {
      grid-area: topbar;
    }

    hero-chat-view {
      grid-area: chat;
      overflow: hidden;
    }

    hero-sidebar {
      grid-area: sidebar;
      width: 300px;
    }

    hero-status-bar {
      grid-area: statusbar;
    }
  </style>

  <hero-top-bar></hero-top-bar>
  <hero-chat-view></hero-chat-view>
  <hero-sidebar></hero-sidebar>
  <hero-status-bar></hero-status-bar>
`;

let cachedTemplate = null;

function getTemplate() {
  if (!cachedTemplate) {
    cachedTemplate = document.createElement('template');
    cachedTemplate.innerHTML = TEMPLATE_HTML;
  }

  return cachedTemplate;
}

class HeroSessionPage extends HTMLElement {
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
  customElements.define('hero-session-page', HeroSessionPage);

export default HeroSessionPage;
