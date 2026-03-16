'use strict';

const TEMPLATE_HTML = `
  <style>
    kikx-hml-prompt-value { display: block; padding: 4px 0; }

    kikx-hml-prompt-value .value-label {
      font-size: 1rem; font-weight: 600;
      color: var(--text-muted, #606078); margin-bottom: 2px;
    }

    kikx-hml-prompt-value .value-container {
      display: flex; flex-wrap: wrap; gap: 4px; align-items: center;
    }

    kikx-hml-prompt-value .value-pill {
      display: inline-flex; align-items: center;
      padding: 3px 10px;
      background: rgba(76, 175, 80, 0.15);
      border: 1px solid rgba(76, 175, 80, 0.40);
      border-radius: 12px;
      font-size: 1rem; font-weight: 500;
      color: #81c784;
      white-space: nowrap;
    }

    kikx-hml-prompt-value .value-pill.color-value {
      gap: 6px;
    }

    kikx-hml-prompt-value .color-swatch {
      width: 14px; height: 14px;
      border-radius: 50%; border: 1px solid rgba(255, 255, 255, 0.2);
      display: inline-block;
    }
  </style>

  <div class="value-label"></div>
  <div class="value-container"></div>
`;

let cachedTemplate = null;

function getTemplate() {
  if (!cachedTemplate) {
    cachedTemplate = document.createElement('template');
    cachedTemplate.innerHTML = TEMPLATE_HTML;
  }

  return cachedTemplate;
}

class KikxHmlPromptValue extends HTMLElement {
  constructor() {
    super();
    this._label     = '';
    this._values    = [];
    this._inputType = '';
  }

  connectedCallback() {
    if (!this._initialized) {
      this._initialized = true;
      this.appendChild(getTemplate().content.cloneNode(true));

      this._labelEl     = this.querySelector('.value-label');
      this._containerEl = this.querySelector('.value-container');
    }
  }

  // ---------------------------------------------------------------------------
  // Public properties
  // ---------------------------------------------------------------------------

  get label() {
    return this._label;
  }

  set label(value) {
    this._label = value || '';

    if (this._labelEl)
      this._labelEl.textContent = this._label;
  }

  get values() {
    return this._values;
  }

  set values(value) {
    if (typeof value === 'string')
      value = [value];

    this._values = Array.isArray(value) ? value : [];
    this._renderPills();
  }

  get inputType() {
    return this._inputType;
  }

  set inputType(value) {
    this._inputType = value || '';
    this._renderPills();
  }

  // ---------------------------------------------------------------------------
  // Private methods
  // ---------------------------------------------------------------------------

  _renderPills() {
    if (!this._containerEl)
      return;

    this._containerEl.innerHTML = '';

    for (let val of this._values) {
      let pill = document.createElement('span');
      pill.className = 'value-pill';

      if (this._inputType === 'color') {
        pill.classList.add('color-value');

        let swatch = document.createElement('span');
        swatch.className = 'color-swatch';
        swatch.style.backgroundColor = val;
        pill.appendChild(swatch);
        pill.appendChild(document.createTextNode(val));
      } else if (this._inputType === 'boolean' || this._inputType === 'checkbox') {
        let display = (val === true || val === 'true') ? 'Yes' : 'No';
        pill.textContent = display;
      } else {
        pill.textContent = val;
      }

      this._containerEl.appendChild(pill);
    }
  }
}

if (typeof customElements !== 'undefined')
  customElements.define('kikx-hml-prompt-value', KikxHmlPromptValue);

export default KikxHmlPromptValue;
