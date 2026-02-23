'use strict';

/**
 * Hero Step Modal Base Class
 *
 * Extends HeroModal with multi-step functionality:
 * - Declarative steps via <hero-step> elements
 * - CSS-driven step visibility via data-step attribute
 * - Progress indicator in title bar
 * - Step validation before navigation
 * - sessionStorage draft persistence
 */

import { HeroModal, GlobalState, escapeHtml, MODAL_STYLES, DynamicProperty } from '../hero-modal/hero-modal.js';
import { validateForm, clearValidation, formatErrors, focusFirstInvalid, injectValidationStyles } from '../../lib/form-validation.js';

// ============================================================================
// Step Modal Styles
// ============================================================================

export const STEP_MODAL_STYLES = `
  /* Step container uses CSS Grid to stack all steps */
  /* All steps occupy same grid cell, only active one visible */
  /* Modal naturally sizes to largest step content */
  dialog[open] {
    width: 500px;
  }

  dialog > main {
    display: grid;
    overflow: hidden;
  }

  /* All steps stack in the same grid cell */
  ::slotted(hero-step) {
    grid-row: 1;
    grid-column: 1;
    box-sizing: border-box;
  }

  /* Step progress indicator in header */
  .step-progress {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 12px;
    color: var(--text-muted, #6b7280);
    margin-left: 8px;
  }

  .step-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--border-color, #2d2d2d);
    transition: background 0.2s;
  }

  .step-dot.active {
    background: var(--accent, #f472b6);
  }

  .step-dot.completed {
    background: var(--success);
  }

  /* Footer navigation buttons */
  dialog > footer .step-nav {
    display: flex;
    gap: 8px;
  }

  dialog > footer .step-nav-left {
    margin-right: auto;
  }

  /* Button styles for shadow DOM (copied from buttons.css) */
  .button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 8px 16px;
    border: none;
    border-radius: var(--radius-sm, 4px);
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
    transition: background 0.2s, transform 0.1s;
    background: var(--bg-tertiary, #2a2a3e);
    color: var(--text-primary, #e0e0e0);
  }

  .button:hover {
    transform: translateY(-1px);
  }

  .button:active {
    transform: translateY(0);
  }

  .button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
    transform: none;
  }

  .button-primary {
    background: var(--accent, #f472b6);
    color: white;
  }

  .button-primary:hover:not(:disabled) {
    background: var(--accent-hover, #f687bf);
  }

  .button-secondary {
    background: var(--bg-tertiary, #2a2a3e);
    color: var(--text-primary, #e0e0e0);
  }

  .button-secondary:hover:not(:disabled) {
    background: #1a4a7a;
  }

  /* Consistent width for Next/Save buttons */
  .btn-next,
  .btn-submit {
    min-width: 72px;
  }
`;

// ============================================================================
// HeroStepModal Base Class
// ============================================================================

/**
 * Base class for multi-step modal components.
 * Uses declarative <hero-step> elements for step content.
 *
 * @example
 * class MyStepModal extends HeroStepModal {
 *   static tagName = 'my-step-modal';
 *
 *   get draftKey() { return 'myModalDraft'; }
 *
 *   getValidationSchema() {
 *     return [
 *       { name: 'field1', label: 'Field 1', step: 1, validators: [{ type: 'required' }] },
 *       { name: 'field2', label: 'Field 2', step: 2, validators: [{ type: 'required' }] },
 *     ];
 *   }
 *
 *   getSteps() {
 *     return [
 *       { label: 'Basic Info', content: this.renderStep1() },
 *       { label: 'Details', content: this.renderStep2() },
 *     ];
 *   }
 * }
 */
export class HeroStepModal extends HeroModal {
  static tagName = 'hero-step-modal';

  _currentStep = 1;
  _totalSteps = 0;

  /**
   * Get the storage key for draft persistence.
   * Override in subclass to enable draft saving.
   * @returns {string|null} Storage key or null to disable
   */
  get draftKey() {
    return null;
  }

  /**
   * Get the current step number (1-indexed).
   */
  get currentStep() {
    return this._currentStep;
  }

  /**
   * Set the current step number.
   */
  set currentStep(value) {
    this._currentStep = value;
    this.setAttribute('data-step', value);
    this._updateStepVisibility();
    this._updateStepIndicator();
    this._updateNavigationButtons();
  }

  /**
   * Update visibility of hero-step elements based on current step.
   * Uses visibility: hidden so all steps contribute to modal sizing.
   */
  _updateStepVisibility() {
    let heroSteps = this.querySelectorAll('hero-step');
    for (let i = 0; i < heroSteps.length; i++) {
      let stepNumber = i + 1;
      heroSteps[i].style.visibility = (stepNumber === this._currentStep) ? 'visible' : 'hidden';
    }
  }

  /**
   * Get validation schema for form fields.
   * Override in subclass to define field validation.
   * @returns {Array} Validation schema
   */
  getValidationSchema() {
    return [];
  }

  /**
   * Get step definitions.
   * Override in subclass.
   * @returns {Array<{label: string, content: string}>}
   */
  getSteps() {
    return [];
  }

  /**
   * Get additional styles for this modal variant.
   */
  getAdditionalStyles() {
    return STEP_MODAL_STYLES;
  }

  /**
   * Build the shadow DOM with step support.
   */
  _buildShadowDOM() {
    let additionalStyles = this.getAdditionalStyles();
    let steps = this.getSteps();
    this._totalSteps = steps.length;

    // Build step dots
    let stepDots = '';
    for (let i = 1; i <= this._totalSteps; i++) {
      let activeClass = (i === 1) ? ' active' : '';
      stepDots += `<span class="step-dot${activeClass}" data-step="${i}"></span>`;
    }

    this.shadowRoot.innerHTML = `
      <style>
        ${MODAL_STYLES}
        ${additionalStyles}
      </style>
      <dialog class="root-container" part="dialog root">
        <header part="header">
          <div class="caption-container" part="caption-container">
            <slot name="caption">
              <span part="caption">${escapeHtml(this.modalTitle)}</span>
            </slot>
            <div class="step-progress">
              ${stepDots}
            </div>
          </div>
        </header>
        <main part="main">
          <slot></slot>
        </main>
        <footer part="footer">
          <div class="step-nav step-nav-left">
            <button type="button" class="button button-secondary btn-cancel">Cancel</button>
          </div>
          <div class="step-nav">
            <button type="button" class="button button-secondary btn-back">Back</button>
            <button type="button" class="button button-primary btn-next">Next</button>
            <button type="submit" class="button button-primary btn-submit" style="display: none;">Save</button>
          </div>
        </footer>
      </dialog>
    `;
  }

  /**
   * Render content into the modal.
   */
  _renderContent() {
    let steps = this.getSteps();
    this._totalSteps = steps.length;

    // Clear current content
    this.innerHTML = '';

    // Create hero-step elements
    for (let i = 0; i < steps.length; i++) {
      let step = steps[i];
      let heroStep = document.createElement('hero-step');
      heroStep.setAttribute('label', step.label);
      heroStep.innerHTML = step.content;
      this.appendChild(heroStep);
    }

    // Bind form events for draft persistence
    this._bindDraftPersistence();
  }

  mounted() {
    // Inject validation styles
    injectValidationStyles();

    // Handle backdrop click
    if (this.$dialog) {
      this.$dialog.addEventListener('click', (event) => {
        if (event.target === this.$dialog) {
          // Don't clear draft on backdrop click - user might want to return
          this._closeWithoutClearingDraft();
        }
      });
    }

    // Bind navigation buttons
    this._bindNavigationButtons();

    // Initialize step
    this.currentStep = 1;
  }

  /**
   * Bind navigation button handlers.
   */
  _bindNavigationButtons() {
    let backButton = this.shadowRoot?.querySelector('.btn-back');
    let nextButton = this.shadowRoot?.querySelector('.btn-next');
    let cancelButton = this.shadowRoot?.querySelector('.btn-cancel');
    let submitButton = this.shadowRoot?.querySelector('.btn-submit');

    if (backButton) {
      backButton.addEventListener('click', () => this.previousStep());
    }

    if (nextButton) {
      nextButton.addEventListener('click', () => this.nextStep());
    }

    if (cancelButton) {
      cancelButton.addEventListener('click', () => this.cancel());
    }

    if (submitButton) {
      submitButton.addEventListener('click', (event) => this.handleSubmit(event));
    }
  }

  /**
   * Bind draft persistence to form fields.
   */
  _bindDraftPersistence() {
    if (!this.draftKey)
      return;

    let inputs = this.querySelectorAll('input, textarea, select');
    for (let input of inputs) {
      input.addEventListener('blur', () => this._saveDraft());
      input.addEventListener('change', () => this._saveDraft());
    }
  }

  /**
   * Save current form data to sessionStorage.
   */
  _saveDraft() {
    if (!this.draftKey)
      return;

    let data = {};

    // Query all inputs across all steps (not just within a single form)
    let inputs = this.querySelectorAll('input, textarea, select');
    for (let input of inputs) {
      if (!input.name)
        continue;

      if (input.type === 'checkbox') {
        data[input.name] = input.checked;
      } else {
        data[input.name] = input.value;
      }
    }

    sessionStorage.setItem(this.draftKey, JSON.stringify(data));
  }

  /**
   * Load draft data from sessionStorage.
   */
  _loadDraft() {
    if (!this.draftKey)
      return;

    let savedData = sessionStorage.getItem(this.draftKey);
    if (!savedData)
      return;

    try {
      let data = JSON.parse(savedData);

      // Query all inputs across all steps
      for (let [ name, value ] of Object.entries(data)) {
        let input = this.querySelector(`[name="${name}"]`);
        if (!input)
          continue;

        if (input.type === 'checkbox') {
          input.checked = Boolean(value);
        } else {
          input.value = value;
        }
      }
    } catch (error) {
      console.warn('Failed to load draft:', error);
    }
  }

  /**
   * Clear draft from sessionStorage.
   */
  _clearDraft() {
    if (!this.draftKey)
      return;

    sessionStorage.removeItem(this.draftKey);
  }

  /**
   * Update step indicator dots.
   */
  _updateStepIndicator() {
    let dots = this.shadowRoot?.querySelectorAll('.step-dot');
    if (!dots)
      return;

    for (let i = 0; i < dots.length; i++) {
      let dot = dots[i];
      let stepNumber = i + 1;

      dot.classList.remove('active', 'completed');

      if (stepNumber === this._currentStep) {
        dot.classList.add('active');
      } else if (stepNumber < this._currentStep) {
        dot.classList.add('completed');
      }
    }
  }

  /**
   * Update navigation button visibility.
   */
  _updateNavigationButtons() {
    let backButton = this.shadowRoot?.querySelector('.btn-back');
    let nextButton = this.shadowRoot?.querySelector('.btn-next');
    let submitButton = this.shadowRoot?.querySelector('.btn-submit');

    let isFirstStep = (this._currentStep === 1);
    let isLastStep = (this._currentStep === this._totalSteps);

    if (backButton) {
      backButton.disabled = isFirstStep;
    }

    if (nextButton) {
      nextButton.style.display = (isLastStep) ? 'none' : '';
    }

    if (submitButton) {
      submitButton.style.display = (isLastStep) ? '' : 'none';
    }
  }

  /**
   * Validate fields for a specific step.
   * @param {number} step - Step number to validate
   * @returns {ValidationResult}
   */
  validateStep(step) {
    let schema = this.getValidationSchema();
    let stepSchema = schema.filter((field) => field.step === step);

    return validateForm(this, stepSchema);
  }

  /**
   * Validate all fields.
   * @returns {ValidationResult}
   */
  validateAll() {
    let schema = this.getValidationSchema();
    return validateForm(this, schema);
  }

  /**
   * Navigate to the next step.
   */
  nextStep() {
    // Validate current step before proceeding
    let result = this.validateStep(this._currentStep);

    if (!result.valid) {
      this.error = formatErrors(result.errors);
      focusFirstInvalid(this);
      return;
    }

    // Clear error and proceed
    this.error = '';

    if (this._currentStep < this._totalSteps) {
      this.currentStep = this._currentStep + 1;
    }
  }

  /**
   * Navigate to the previous step.
   */
  previousStep() {
    if (this._currentStep > 1) {
      this.error = '';
      this.currentStep = this._currentStep - 1;
    }
  }

  /**
   * Go to a specific step.
   * @param {number} step - Step number (1-indexed)
   * @param {boolean} [validate=true] - Whether to validate intervening steps
   */
  goToStep(step, validate = true) {
    if (step < 1 || step > this._totalSteps)
      return;

    // If going forward and validation is enabled, validate all previous steps
    if (validate && step > this._currentStep) {
      for (let i = this._currentStep; i < step; i++) {
        let result = this.validateStep(i);
        if (!result.valid) {
          this.error = formatErrors(result.errors);
          this.currentStep = i;
          focusFirstInvalid(this);
          return;
        }
      }
    }

    this.error = '';
    this.currentStep = step;
  }

  /**
   * Open the modal.
   */
  async openModal() {
    this._errorMessage = '';

    let onOpenResult = this.onOpen();
    if (onOpenResult instanceof Promise) {
      onOpenResult = await onOpenResult;
    }
    if (onOpenResult === false)
      return;

    // Re-render content
    this._renderContent();

    // Load draft if available
    this._loadDraft();

    // Reset to step 1
    this.currentStep = 1;

    // Update title
    let titleSpan = this.shadowRoot?.querySelector('header [part="caption"]');
    if (titleSpan) {
      titleSpan.textContent = this.modalTitle;
    }

    // Show the component
    this.style.display = '';

    // Show dialog
    if (this.$dialog && typeof this.$dialog.showModal === 'function') {
      this.$dialog.showModal();
    }

    // Focus first input
    requestAnimationFrame(() => {
      let firstInput = this.querySelector('hero-step:first-of-type input, hero-step:first-of-type select, hero-step:first-of-type textarea');
      if (firstInput)
        firstInput.focus();
    });
  }

  /**
   * Cancel and close the modal, clearing draft.
   */
  cancel() {
    this._clearDraft();
    this.close();
  }

  /**
   * Close without clearing draft (for backdrop click).
   */
  _closeWithoutClearingDraft() {
    if (this.$dialog && this.$dialog.open) {
      this.$dialog.close();
    }
    this.style.display = 'none';
    this.onClose();
  }

  /**
   * Handle form submission.
   * Override in subclass.
   */
  async handleSubmit(event) {
    if (event)
      event.preventDefault();

    // Validate all fields
    let result = this.validateAll();

    if (!result.valid) {
      // Navigate to the first step with an error
      if (result.firstErrorStep !== null) {
        this.currentStep = result.firstErrorStep;
      }

      this.error = formatErrors(result.errors);
      focusFirstInvalid(this);
      return;
    }

    // Clear draft on successful submit
    this._clearDraft();

    // Subclass should handle actual submission
  }
}

// Export dependencies for subclasses
export { GlobalState, escapeHtml, MODAL_STYLES, DynamicProperty };
export { validateForm, clearValidation, formatErrors, focusFirstInvalid };
