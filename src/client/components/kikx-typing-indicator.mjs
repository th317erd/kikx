'use strict';

const TEMPLATE_HTML = `
  <span class="kikx-typing-indicator__name"></span>
  <span class="kikx-typing-indicator__dots"><span>.</span><span>.</span><span>.</span></span>
  <span class="kikx-typing-indicator__thinking"><span></span></span>
`;

export class KikxTypingIndicator extends HTMLElement {
  constructor() {
    super();
    this._agentName = '';
    this._thinkingText = '';
  }

  get agentName() {
    return this._agentName;
  }

  set agentName(value) {
    this._agentName = value || '';
    this._renderValues();
  }

  get thinkingText() {
    return this._thinkingText;
  }

  set thinkingText(value) {
    this._thinkingText = value || '';
    this._renderValues();
  }

  connectedCallback() {
    if (!this._initialized) {
      this._initialized = true;
      this.innerHTML = TEMPLATE_HTML;
    }

    this._renderValues();
  }

  _renderValues() {
    let name = this.querySelector('.kikx-typing-indicator__name');
    let thinking = this.querySelector('.kikx-typing-indicator__thinking span');

    if (name)
      name.textContent = this._agentName ? `${this._agentName}:` : 'Agent:';

    if (thinking) {
      let preview = this._thinkingText.length > 300
        ? this._thinkingText.slice(-300)
        : this._thinkingText;
      preview = preview.replace(/\n+/g, ' • ').replace(/\s+/g, ' ').trim();
      thinking.textContent = preview ? `${preview}    •    ${preview}` : '';
    }
  }
}

if (typeof customElements !== 'undefined' && !customElements.get('kikx-typing-indicator'))
  customElements.define('kikx-typing-indicator', KikxTypingIndicator);
