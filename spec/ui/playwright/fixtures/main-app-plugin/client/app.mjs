'use strict';

class PluginMainApp extends HTMLElement {
  connectedCallback() {
    this.textContent = 'PLUGIN SHELL';
  }
}

if (!customElements.get('kikx-app'))
  customElements.define('kikx-app', PluginMainApp);
