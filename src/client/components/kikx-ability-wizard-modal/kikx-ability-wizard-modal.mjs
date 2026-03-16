'use strict';

import { t } from '../../lib/i18n.mjs';

const STEP_KEYS = [
  'ability.wizard.nameStep',
  'ability.wizard.categoryStep',
  'ability.wizard.descriptionStep',
  'ability.wizard.whenToUseStep',
  'ability.wizard.contentStep',
  'ability.wizard.permissionsStep',
];

const TOTAL_STEPS = STEP_KEYS.length;

const TEMPLATE_HTML = `
  <style>
    kikx-ability-wizard-modal { display: block; }

    kikx-ability-wizard-modal .step-indicator {
      display: flex; gap: 8px; justify-content: center; margin-bottom: 16px;
    }

    kikx-ability-wizard-modal .step-dot {
      width: 10px; height: 10px; border-radius: 50%;
      background: var(--glass-border, rgba(255, 255, 255, 0.10));
      transition: background 0.2s ease;
    }

    kikx-ability-wizard-modal .step-dot.active {
      background: var(--accent-primary, #00e5ff);
    }

    kikx-ability-wizard-modal .step-dot.completed {
      background: var(--accent-primary, #00e5ff); opacity: 0.5;
    }

    kikx-ability-wizard-modal .step-content { display: none; }
    kikx-ability-wizard-modal .step-content.active { display: block; }

    kikx-ability-wizard-modal .step-label {
      font-size: 1rem; font-weight: 600;
      color: var(--text-primary, #e8e8f0); margin-bottom: 8px;
    }

    kikx-ability-wizard-modal .step-input {
      width: 100%; box-sizing: border-box;
      padding: 8px 12px; font-size: 1rem;
      background: var(--input-background, rgba(255, 255, 255, 0.05));
      border: 1px solid var(--input-border, rgba(255, 255, 255, 0.12));
      border-radius: var(--border-radius-small, 4px);
      color: var(--text-primary, #e8e8f0); outline: none;
      font-family: inherit;
    }

    kikx-ability-wizard-modal .step-input:focus {
      border-color: var(--accent-primary, #00e5ff);
    }

    kikx-ability-wizard-modal textarea.step-input { resize: vertical; min-height: 80px; }

    kikx-ability-wizard-modal .checkbox-row {
      display: flex; align-items: center; gap: 8px;
      font-size: 1rem; color: var(--text-primary, #e8e8f0); cursor: pointer;
    }

    kikx-ability-wizard-modal .nav-buttons {
      display: flex; gap: 8px; justify-content: flex-end;
      margin-top: 16px; padding-top: 12px;
      border-top: 1px solid var(--glass-border, rgba(255, 255, 255, 0.10));
    }

    kikx-ability-wizard-modal .back-button {
      background: none;
      border: 1px solid var(--glass-border, rgba(255, 255, 255, 0.10));
      color: var(--text-secondary, #a0a0b8);
      border-radius: var(--border-radius-small, 4px);
      padding: 8px 16px; font-size: 1rem; cursor: pointer;
    }

    kikx-ability-wizard-modal .next-button, kikx-ability-wizard-modal .save-button {
      background: var(--accent-primary, #00e5ff);
      color: #fff;
      border: none; border-radius: var(--border-radius-small, 4px);
      padding: 8px 20px; font-weight: 600; font-size: 1rem; cursor: pointer;
    }
  </style>

  <div class="step-indicator"></div>
  <div class="steps-container"></div>
  <div class="nav-buttons">
    <button class="back-button"></button>
    <button class="next-button"></button>
    <button class="save-button"></button>
  </div>
`;

let cachedTemplate = null;

function getTemplate() {
  if (!cachedTemplate) {
    cachedTemplate = document.createElement('template');
    cachedTemplate.innerHTML = TEMPLATE_HTML;
  }

  return cachedTemplate;
}

class KikxAbilityWizardModal extends HTMLElement {
  constructor() {
    super();
  }

  connectedCallback() {
    this.appendChild(getTemplate().content.cloneNode(true));

    this._currentStep = 0;

    this._indicator     = this.querySelector('.step-indicator');
    this._container     = this.querySelector('.steps-container');
    this._backButton    = this.querySelector('.back-button');
    this._nextButton    = this.querySelector('.next-button');
    this._saveButton    = this.querySelector('.save-button');

    this._onBackClick = this._onBackClick.bind(this);
    this._onNextClick = this._onNextClick.bind(this);
    this._onSaveClick = this._onSaveClick.bind(this);

    this._buildSteps();
    this._buildIndicator();
    this._applyLabels();
    this._syncUI();

    this._backButton.addEventListener('click', this._onBackClick);
    this._nextButton.addEventListener('click', this._onNextClick);
    this._saveButton.addEventListener('click', this._onSaveClick);
  }

  disconnectedCallback() {
    this._backButton.removeEventListener('click', this._onBackClick);
    this._nextButton.removeEventListener('click', this._onNextClick);
    this._saveButton.removeEventListener('click', this._onSaveClick);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  getValues() {
    return {
      name:        this._nameInput.value,
      category:    this._categoryInput.value,
      description: this._descriptionInput.value,
      whenToUse:   this._whenToUseInput.value,
      content:     this._contentInput.value,
      autoApprove: this._autoApproveInput.checked,
    };
  }

  reset() {
    this._nameInput.value        = '';
    this._categoryInput.value    = '';
    this._descriptionInput.value = '';
    this._whenToUseInput.value   = '';
    this._contentInput.value     = '';
    this._autoApproveInput.checked = false;

    this._currentStep = 0;
    this._syncUI();
  }

  // ---------------------------------------------------------------------------
  // Internal -- build DOM
  // ---------------------------------------------------------------------------

  _buildSteps() {
    // Step 0 -- Name
    let step0 = this._makeStepDiv(0);
    step0.innerHTML = '<div class="step-label name-label"></div><input class="step-input name-input" type="text" />';
    this._container.appendChild(step0);

    // Step 1 -- Category
    let step1 = this._makeStepDiv(1);
    step1.innerHTML = '<div class="step-label category-label"></div><input class="step-input category-input" type="text" />';
    this._container.appendChild(step1);

    // Step 2 -- Description
    let step2 = this._makeStepDiv(2);
    step2.innerHTML = '<div class="step-label description-label"></div><input class="step-input description-input" type="text" />';
    this._container.appendChild(step2);

    // Step 3 -- When to Use
    let step3 = this._makeStepDiv(3);
    step3.innerHTML = '<div class="step-label when-to-use-label"></div><textarea class="step-input when-to-use-input"></textarea>';
    this._container.appendChild(step3);

    // Step 4 -- Content
    let step4 = this._makeStepDiv(4);
    step4.innerHTML = '<div class="step-label content-label"></div><textarea class="step-input content-input"></textarea>';
    this._container.appendChild(step4);

    // Step 5 -- Permissions
    let step5 = this._makeStepDiv(5);
    step5.innerHTML = '<div class="step-label permissions-label"></div><label class="checkbox-row"><input type="checkbox" class="auto-approve-input" /> Auto-approve</label>';
    this._container.appendChild(step5);

    // Cache input references
    this._nameInput        = this.querySelector('.name-input');
    this._categoryInput    = this.querySelector('.category-input');
    this._descriptionInput = this.querySelector('.description-input');
    this._whenToUseInput   = this.querySelector('.when-to-use-input');
    this._contentInput     = this.querySelector('.content-input');
    this._autoApproveInput = this.querySelector('.auto-approve-input');
  }

  _makeStepDiv(index) {
    let div = document.createElement('div');
    div.classList.add('step-content');
    div.setAttribute('data-step', String(index));
    return div;
  }

  _buildIndicator() {
    this._indicator.innerHTML = '';

    for (let i = 0; i < TOTAL_STEPS; i++) {
      let dot = document.createElement('div');
      dot.classList.add('step-dot');
      this._indicator.appendChild(dot);
    }
  }

  _applyLabels() {
    this.querySelector('.name-label').textContent        = t(STEP_KEYS[0]);
    this.querySelector('.category-label').textContent    = t(STEP_KEYS[1]);
    this.querySelector('.description-label').textContent = t(STEP_KEYS[2]);
    this.querySelector('.when-to-use-label').textContent = t(STEP_KEYS[3]);
    this.querySelector('.content-label').textContent     = t(STEP_KEYS[4]);
    this.querySelector('.permissions-label').textContent = t(STEP_KEYS[5]);

    this._backButton.textContent = t('ability.wizard.backButton');
    this._nextButton.textContent = t('ability.wizard.nextButton');
    this._saveButton.textContent = t('ability.wizard.saveButton');
  }

  // ---------------------------------------------------------------------------
  // Internal -- sync UI to current step
  // ---------------------------------------------------------------------------

  _syncUI() {
    let steps = this.querySelectorAll('.step-content');

    for (let step of steps) {
      let idx = Number(step.getAttribute('data-step'));
      step.classList.toggle('active', idx === this._currentStep);
    }

    let dots = this._indicator.querySelectorAll('.step-dot');

    for (let i = 0; i < dots.length; i++) {
      dots[i].classList.toggle('active', i === this._currentStep);
      dots[i].classList.toggle('completed', i < this._currentStep);
    }

    // Navigation button visibility
    this._backButton.style.display = (this._currentStep === 0) ? 'none' : '';
    this._nextButton.style.display = (this._currentStep < TOTAL_STEPS - 1) ? '' : 'none';
    this._saveButton.style.display = (this._currentStep === TOTAL_STEPS - 1) ? '' : 'none';
  }

  // ---------------------------------------------------------------------------
  // Internal -- event handlers
  // ---------------------------------------------------------------------------

  _onBackClick() {
    if (this._currentStep > 0) {
      this._currentStep--;
      this._syncUI();
    }
  }

  _onNextClick() {
    if (this._currentStep < TOTAL_STEPS - 1) {
      this._currentStep++;
      this._syncUI();
    }
  }

  _onSaveClick() {
    this.dispatchEvent(new CustomEvent('ability-save', {
      bubbles:  true,
      composed: true,
      detail:   { values: this.getValues() },
    }));
  }
}

if (typeof customElements !== 'undefined')
  customElements.define('kikx-ability-wizard-modal', KikxAbilityWizardModal);

export default KikxAbilityWizardModal;
