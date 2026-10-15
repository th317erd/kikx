'use strict';

import { thinkingLines } from '../state/thinking-state.mjs';

const MAX_RENDERED_LINES = 200;

// Fixed-size, never-resizing panel that shows one agent's live thoughts in a
// monospace window. Newest line is pinned to the bottom; older lines overflow
// above and are faded by a CSS mask, so the panel never changes size as the
// agent streams (no more bouncing bubble).
const TEMPLATE_HTML = `
  <header class="kikx-thinking-panel__head">
    <span class="kikx-thinking-panel__name"></span><span class="kikx-thinking-panel__dots"><span>.</span><span>.</span><span>.</span></span>
  </header>
  <div class="kikx-thinking-panel__window">
    <div class="kikx-thinking-panel__lines"></div>
  </div>
`;

export class KikxThinkingPanel extends HTMLElement {
  constructor() {
    super();
    this._entry = null;
    this._name = '';
    this._lines = [];
  }

  connectedCallback() {
    if (!this._initialized) {
      this._initialized = true;
      this.innerHTML = TEMPLATE_HTML;
      this._nameElement = this.querySelector('.kikx-thinking-panel__name');
      this._linesElement = this.querySelector('.kikx-thinking-panel__lines');
    }

    if (this._entry)
      this._applyEntry();
  }

  setEntry(entry = {}) {
    this._entry = entry;
    if (this.isConnected)
      this._applyEntry();
  }

  _applyEntry() {
    this._name = this._entry?.name || 'Agent';
    this._applyName();
    this._applyLines(thinkingLines(this._entry?.text || '', MAX_RENDERED_LINES));
  }

  _applyName() {
    if (this._nameElement && this._nameElement.textContent !== this._name)
      this._nameElement.textContent = this._name;
  }

  _applyLines(next) {
    let container = this._linesElement;
    if (!container)
      return;

    let children = container.children;
    for (let index = 0; index < next.length; index++) {
      let line = children[index];
      if (!line) {
        line = document.createElement('div');
        line.className = 'kikx-thinking-panel__line';
        container.appendChild(line);
      }

      if (line.textContent !== next[index])
        line.textContent = next[index];
    }

    while (container.children.length > next.length)
      container.removeChild(container.lastElementChild);

    while (container.children.length > MAX_RENDERED_LINES)
      container.removeChild(container.firstElementChild);

    this._lines = next;
  }
}

if (typeof customElements !== 'undefined' && !customElements.get('kikx-thinking-panel'))
  customElements.define('kikx-thinking-panel', KikxThinkingPanel);
