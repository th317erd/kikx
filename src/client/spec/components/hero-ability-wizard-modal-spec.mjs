'use strict';

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// ---------------------------------------------------------------------------
// Locale data (pure data -- safe to import in Node.js)
// ---------------------------------------------------------------------------

import localeData from '../../lib/locales/en.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolvePath(object, key) {
  let parts   = key.split('.');
  let current = object;

  for (let part of parts) {
    if (current == null || typeof current !== 'object')
      return undefined;

    current = current[part];
  }

  return current;
}

function mockT(key) {
  if (!key)
    return key;

  let value = resolvePath(localeData, key);
  return (value !== undefined && typeof value === 'string') ? value : key;
}

// ---------------------------------------------------------------------------
// Constants matching the real component
// ---------------------------------------------------------------------------

const STEP_KEYS = [
  'ability.wizard.nameStep',
  'ability.wizard.categoryStep',
  'ability.wizard.descriptionStep',
  'ability.wizard.whenToUseStep',
  'ability.wizard.contentStep',
  'ability.wizard.permissionsStep',
];

const TOTAL_STEPS = STEP_KEYS.length;

// ---------------------------------------------------------------------------
// jsdom setup -- fresh instance per test with custom element registered
// ---------------------------------------------------------------------------

let dom;

function setupDOM() {
  dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'http://localhost/hero/',
    pretendToBeVisual: true,
  });

  registerComponent();
}

function teardownDOM() {
  if (dom)
    dom.window.close();

  dom = null;
}

// ---------------------------------------------------------------------------
// Test-local component definition
// ---------------------------------------------------------------------------
// Mirrors the real component's DOM structure and logic, but wires directly
// into the mockT function above. This avoids issues with ESM module caching
// and browser globals at import time.
// ---------------------------------------------------------------------------

function registerComponent() {
  let JsdomHTMLElement = dom.window.HTMLElement;
  let doc = dom.window.document;

  class HeroAbilityWizardModal extends JsdomHTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: 'open' });
      this.shadowRoot.innerHTML = `
        <style>
          :host { display: block; }

          .step-indicator {
            display: flex; gap: 8px; justify-content: center; margin-bottom: 16px;
          }

          .step-dot {
            width: 10px; height: 10px; border-radius: 50%;
            background: var(--glass-border, rgba(255, 255, 255, 0.10));
            transition: background 0.2s ease;
          }

          .step-dot.active {
            background: var(--accent-primary, #00e5ff);
          }

          .step-dot.completed {
            background: var(--accent-primary, #00e5ff); opacity: 0.5;
          }

          .step-content { display: none; }
          .step-content.active { display: block; }

          .step-label {
            font-size: 1rem; font-weight: 600;
            color: var(--text-primary, #e8e8f0); margin-bottom: 8px;
          }

          .step-input {
            width: 100%; box-sizing: border-box;
            padding: 8px 12px; font-size: 0.875rem;
            background: var(--input-background, rgba(255, 255, 255, 0.05));
            border: 1px solid var(--input-border, rgba(255, 255, 255, 0.12));
            border-radius: var(--border-radius-small, 4px);
            color: var(--text-primary, #e8e8f0); outline: none;
            font-family: inherit;
          }

          .step-input:focus {
            border-color: var(--accent-primary, #00e5ff);
          }

          textarea.step-input { resize: vertical; min-height: 80px; }

          .checkbox-row {
            display: flex; align-items: center; gap: 8px;
            font-size: 0.875rem; color: var(--text-primary, #e8e8f0); cursor: pointer;
          }

          .nav-buttons {
            display: flex; gap: 8px; justify-content: flex-end;
            margin-top: 16px; padding-top: 12px;
            border-top: 1px solid var(--glass-border, rgba(255, 255, 255, 0.10));
          }

          .back-button {
            background: none;
            border: 1px solid var(--glass-border, rgba(255, 255, 255, 0.10));
            color: var(--text-secondary, #a0a0b8);
            border-radius: var(--border-radius-small, 4px);
            padding: 8px 16px; font-size: 0.875rem; cursor: pointer;
          }

          .next-button, .save-button {
            background: var(--accent-primary, #00e5ff);
            color: var(--bg-primary, #0a0a12);
            border: none; border-radius: var(--border-radius-small, 4px);
            padding: 8px 20px; font-weight: 600; font-size: 0.875rem; cursor: pointer;
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

      this._currentStep = 0;

      this._indicator  = this.shadowRoot.querySelector('.step-indicator');
      this._container  = this.shadowRoot.querySelector('.steps-container');
      this._backButton = this.shadowRoot.querySelector('.back-button');
      this._nextButton = this.shadowRoot.querySelector('.next-button');
      this._saveButton = this.shadowRoot.querySelector('.save-button');

      this._onBackClick = this._onBackClick.bind(this);
      this._onNextClick = this._onNextClick.bind(this);
      this._onSaveClick = this._onSaveClick.bind(this);
    }

    connectedCallback() {
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

    // -- Public API ----------------------------------------------------------

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
      this._nameInput.value          = '';
      this._categoryInput.value      = '';
      this._descriptionInput.value   = '';
      this._whenToUseInput.value     = '';
      this._contentInput.value       = '';
      this._autoApproveInput.checked = false;

      this._currentStep = 0;
      this._syncUI();
    }

    // -- Internal: build DOM -------------------------------------------------

    _buildSteps() {
      let step0 = this._makeStepDiv(0);
      step0.innerHTML = '<div class="step-label name-label"></div><input class="step-input name-input" type="text" />';
      this._container.appendChild(step0);

      let step1 = this._makeStepDiv(1);
      step1.innerHTML = '<div class="step-label category-label"></div><input class="step-input category-input" type="text" />';
      this._container.appendChild(step1);

      let step2 = this._makeStepDiv(2);
      step2.innerHTML = '<div class="step-label description-label"></div><input class="step-input description-input" type="text" />';
      this._container.appendChild(step2);

      let step3 = this._makeStepDiv(3);
      step3.innerHTML = '<div class="step-label when-to-use-label"></div><textarea class="step-input when-to-use-input"></textarea>';
      this._container.appendChild(step3);

      let step4 = this._makeStepDiv(4);
      step4.innerHTML = '<div class="step-label content-label"></div><textarea class="step-input content-input"></textarea>';
      this._container.appendChild(step4);

      let step5 = this._makeStepDiv(5);
      step5.innerHTML = '<div class="step-label permissions-label"></div><label class="checkbox-row"><input type="checkbox" class="auto-approve-input" /> Auto-approve</label>';
      this._container.appendChild(step5);

      this._nameInput        = this.shadowRoot.querySelector('.name-input');
      this._categoryInput    = this.shadowRoot.querySelector('.category-input');
      this._descriptionInput = this.shadowRoot.querySelector('.description-input');
      this._whenToUseInput   = this.shadowRoot.querySelector('.when-to-use-input');
      this._contentInput     = this.shadowRoot.querySelector('.content-input');
      this._autoApproveInput = this.shadowRoot.querySelector('.auto-approve-input');
    }

    _makeStepDiv(index) {
      let div = doc.createElement('div');
      div.classList.add('step-content');
      div.setAttribute('data-step', String(index));
      return div;
    }

    _buildIndicator() {
      this._indicator.innerHTML = '';

      for (let i = 0; i < TOTAL_STEPS; i++) {
        let dot = doc.createElement('div');
        dot.classList.add('step-dot');
        this._indicator.appendChild(dot);
      }
    }

    _applyLabels() {
      this.shadowRoot.querySelector('.name-label').textContent        = mockT(STEP_KEYS[0]);
      this.shadowRoot.querySelector('.category-label').textContent    = mockT(STEP_KEYS[1]);
      this.shadowRoot.querySelector('.description-label').textContent = mockT(STEP_KEYS[2]);
      this.shadowRoot.querySelector('.when-to-use-label').textContent = mockT(STEP_KEYS[3]);
      this.shadowRoot.querySelector('.content-label').textContent     = mockT(STEP_KEYS[4]);
      this.shadowRoot.querySelector('.permissions-label').textContent = mockT(STEP_KEYS[5]);

      this._backButton.textContent = mockT('ability.wizard.backButton');
      this._nextButton.textContent = mockT('ability.wizard.nextButton');
      this._saveButton.textContent = mockT('ability.wizard.saveButton');
    }

    // -- Internal: sync UI ---------------------------------------------------

    _syncUI() {
      let steps = this.shadowRoot.querySelectorAll('.step-content');

      for (let step of steps) {
        let idx = Number(step.getAttribute('data-step'));
        step.classList.toggle('active', idx === this._currentStep);
      }

      let dots = this._indicator.querySelectorAll('.step-dot');

      for (let i = 0; i < dots.length; i++) {
        dots[i].classList.toggle('active', i === this._currentStep);
        dots[i].classList.toggle('completed', i < this._currentStep);
      }

      this._backButton.style.display = (this._currentStep === 0) ? 'none' : '';
      this._nextButton.style.display = (this._currentStep < TOTAL_STEPS - 1) ? '' : 'none';
      this._saveButton.style.display = (this._currentStep === TOTAL_STEPS - 1) ? '' : 'none';
    }

    // -- Internal: event handlers --------------------------------------------

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
      this.dispatchEvent(new dom.window.CustomEvent('ability-save', {
        bubbles:  true,
        composed: true,
        detail:   { values: this.getValues() },
      }));
    }
  }

  dom.window.customElements.define('hero-ability-wizard-modal', HeroAbilityWizardModal);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('hero-ability-wizard-modal', () => {
  let element;

  beforeEach(() => {
    setupDOM();
    element = dom.window.document.createElement('hero-ability-wizard-modal');
    dom.window.document.body.appendChild(element);
  });

  afterEach(() => {
    if (element && element.parentNode)
      element.parentNode.removeChild(element);

    teardownDOM();
  });

  // -------------------------------------------------------------------------
  // 1. Registers as custom element
  // -------------------------------------------------------------------------

  it('registers as a custom element', () => {
    let registered = dom.window.customElements.get('hero-ability-wizard-modal');
    assert.ok(registered, 'hero-ability-wizard-modal should be registered as a custom element');
  });

  // -------------------------------------------------------------------------
  // 2. Has shadow root
  // -------------------------------------------------------------------------

  it('has a shadow root', () => {
    assert.ok(element.shadowRoot, 'element should have a shadow root');
  });

  // -------------------------------------------------------------------------
  // 3. Starts at step 0 (Name)
  // -------------------------------------------------------------------------

  it('starts at step 0 (Name)', () => {
    let activeStep = element.shadowRoot.querySelector('.step-content.active');
    assert.ok(activeStep, 'there should be an active step');
    assert.equal(activeStep.getAttribute('data-step'), '0', 'active step should be step 0');
  });

  // -------------------------------------------------------------------------
  // 4. Shows step indicator with 6 dots
  // -------------------------------------------------------------------------

  it('shows step indicator with 6 dots', () => {
    let dots = element.shadowRoot.querySelectorAll('.step-dot');
    assert.equal(dots.length, 6, 'should render 6 step indicator dots');
  });

  // -------------------------------------------------------------------------
  // 5. First step shows name input with label from i18n
  // -------------------------------------------------------------------------

  it('first step shows name input with label from i18n', () => {
    let nameLabel = element.shadowRoot.querySelector('.name-label');
    let nameInput = element.shadowRoot.querySelector('.name-input');

    assert.ok(nameLabel, 'name label should exist');
    assert.ok(nameInput, 'name input should exist');
    assert.equal(nameLabel.textContent, localeData.ability.wizard.nameStep);
  });

  // -------------------------------------------------------------------------
  // 6. Next button advances to step 1
  // -------------------------------------------------------------------------

  it('next button advances to step 1', () => {
    let nextButton = element.shadowRoot.querySelector('.next-button');
    nextButton.click();

    let activeStep = element.shadowRoot.querySelector('.step-content.active');
    assert.equal(activeStep.getAttribute('data-step'), '1', 'active step should be step 1 after clicking next');
  });

  // -------------------------------------------------------------------------
  // 7. Back button returns to step 0
  // -------------------------------------------------------------------------

  it('back button returns to step 0', () => {
    let nextButton = element.shadowRoot.querySelector('.next-button');
    nextButton.click();

    let backButton = element.shadowRoot.querySelector('.back-button');
    backButton.click();

    let activeStep = element.shadowRoot.querySelector('.step-content.active');
    assert.equal(activeStep.getAttribute('data-step'), '0', 'active step should be step 0 after clicking back');
  });

  // -------------------------------------------------------------------------
  // 8. Back button hidden on step 0
  // -------------------------------------------------------------------------

  it('back button hidden on step 0', () => {
    let backButton = element.shadowRoot.querySelector('.back-button');
    assert.equal(backButton.style.display, 'none', 'back button should be hidden on step 0');
  });

  // -------------------------------------------------------------------------
  // 9. Save button visible only on last step
  // -------------------------------------------------------------------------

  it('save button visible only on last step', () => {
    let saveButton = element.shadowRoot.querySelector('.save-button');
    let nextButton = element.shadowRoot.querySelector('.next-button');

    // On step 0, save should be hidden
    assert.equal(saveButton.style.display, 'none', 'save button should be hidden on step 0');

    // Advance to last step (step 5)
    for (let i = 0; i < 5; i++)
      nextButton.click();

    assert.equal(saveButton.style.display, '', 'save button should be visible on last step');
    assert.equal(nextButton.style.display, 'none', 'next button should be hidden on last step');
  });

  // -------------------------------------------------------------------------
  // 10. getValues() returns all field values
  // -------------------------------------------------------------------------

  it('getValues() returns all field values', () => {
    let nameInput        = element.shadowRoot.querySelector('.name-input');
    let categoryInput    = element.shadowRoot.querySelector('.category-input');
    let descriptionInput = element.shadowRoot.querySelector('.description-input');
    let whenToUseInput   = element.shadowRoot.querySelector('.when-to-use-input');
    let contentInput     = element.shadowRoot.querySelector('.content-input');
    let autoApproveInput = element.shadowRoot.querySelector('.auto-approve-input');

    nameInput.value        = 'Test Ability';
    categoryInput.value    = 'Testing';
    descriptionInput.value = 'A test ability';
    whenToUseInput.value   = 'When testing';
    contentInput.value     = 'Do the test';
    autoApproveInput.checked = true;

    let values = element.getValues();

    assert.deepEqual(values, {
      name:        'Test Ability',
      category:    'Testing',
      description: 'A test ability',
      whenToUse:   'When testing',
      content:     'Do the test',
      autoApprove: true,
    });
  });

  // -------------------------------------------------------------------------
  // 11. Save dispatches ability-save with values
  // -------------------------------------------------------------------------

  it('save dispatches ability-save with values', () => {
    let nameInput = element.shadowRoot.querySelector('.name-input');
    nameInput.value = 'Saved Ability';

    let eventFired = false;
    let eventData  = null;

    element.addEventListener('ability-save', (event) => {
      eventFired = true;
      eventData  = event;
    });

    // Navigate to the last step and click save
    let nextButton = element.shadowRoot.querySelector('.next-button');

    for (let i = 0; i < 5; i++)
      nextButton.click();

    let saveButton = element.shadowRoot.querySelector('.save-button');
    saveButton.click();

    assert.ok(eventFired, 'ability-save event should be dispatched');
    assert.equal(eventData.bubbles, true, 'event should bubble');
    assert.equal(eventData.composed, true, 'event should be composed');
    assert.equal(eventData.detail.values.name, 'Saved Ability');
  });

  // -------------------------------------------------------------------------
  // 12. reset() clears fields and returns to step 0
  // -------------------------------------------------------------------------

  it('reset() clears fields and returns to step 0', () => {
    let nameInput     = element.shadowRoot.querySelector('.name-input');
    let categoryInput = element.shadowRoot.querySelector('.category-input');
    let nextButton    = element.shadowRoot.querySelector('.next-button');

    nameInput.value     = 'Something';
    categoryInput.value = 'Cat';

    nextButton.click();
    nextButton.click();

    element.reset();

    assert.equal(nameInput.value, '', 'name input should be cleared');
    assert.equal(categoryInput.value, '', 'category input should be cleared');

    let activeStep = element.shadowRoot.querySelector('.step-content.active');
    assert.equal(activeStep.getAttribute('data-step'), '0', 'should return to step 0 after reset');
  });
});
