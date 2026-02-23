'use strict';

/**
 * Hero Modal Configure Ability
 *
 * Multi-step modal for creating/editing abilities.
 * Step 1: Name, Category, Description, When to Use
 * Step 2: Content (Markdown)
 */

import { HeroStepModal, GlobalState, DynamicProperty, formatErrors } from '../hero-step-modal/hero-step-modal.js';

export class HeroModalConfigureAbility extends HeroStepModal {
  static tagName = 'hero-modal-configure-ability';

  _editId = null;

  get modalTitle() {
    return (this._editId) ? 'Edit Ability' : 'New Ability';
  }

  get draftKey() {
    // Different key for edit vs create
    return (this._editId)
      ? `heroModalDraft_configureAbility_${this._editId}`
      : 'heroModalDraft_configureAbility_new';
  }

  /**
   * Open modal in edit mode.
   * @param {number} abilityId - ID of ability to edit
   */
  openEdit(abilityId) {
    this._editId = abilityId;
    this.openModal();
  }

  onOpen() {
    // If editing, load the ability data
    if (this._editId) {
      this._loadAbilityData();
    }
  }

  /**
   * Load ability data for editing.
   */
  _loadAbilityData() {
    let abilities = GlobalState.abilities.valueOf();
    let allAbilities = [ ...(abilities.system || []), ...(abilities.user || []) ];
    let ability = allAbilities.find((ability) => ability.id === this._editId);

    if (!ability)
      return;

    // Wait for DOM to be ready, then populate fields
    requestAnimationFrame(() => {
      let form = this.querySelector('form') || this;

      let nameInput = form.querySelector('[name="name"]');
      if (nameInput)
        nameInput.value = ability.name || '';

      let categoryInput = form.querySelector('[name="category"]');
      if (categoryInput)
        categoryInput.value = ability.category || '';

      let descriptionInput = form.querySelector('[name="description"]');
      if (descriptionInput)
        descriptionInput.value = ability.description || '';

      let appliesInput = form.querySelector('[name="applies"]');
      if (appliesInput)
        appliesInput.value = ability.applies || '';

      let contentInput = form.querySelector('[name="content"]');
      if (contentInput)
        contentInput.value = ability.content || '';
    });
  }

  /**
   * Validation schema for form fields.
   */
  getValidationSchema() {
    return [
      // Step 1 fields
      {
        name:       'name',
        label:      'Name',
        step:       1,
        validators: [
          { type: 'required', options: { message: 'Name is required' } },
          {
            type:    'pattern',
            options: {
              pattern: /^[a-z][a-z0-9_]*$/,
              message: 'Name must start with a lowercase letter and contain only lowercase letters, numbers, and underscores',
            },
          },
          { type: 'minLength', options: { min: 2, message: 'Name must be at least 2 characters' } },
        ],
      },
      // Step 2 fields
      {
        name:       'content',
        label:      'Content',
        step:       2,
        validators: [
          { type: 'required', options: { message: 'Content is required' } },
        ],
      },
    ];
  }

  /**
   * Define the steps for this modal.
   */
  getSteps() {
    return [
      {
        label:   'Basic Info',
        content: this._renderStep1(),
      },
      {
        label:   'Content',
        content: this._renderStep2(),
      },
    ];
  }

  /**
   * Render step 1: Basic info fields.
   */
  _renderStep1() {
    return `
      <form autocomplete="off">
        <div class="form-row">
          <div class="form-group form-group-half">
            <label for="ability-name">Name</label>
            <input type="text" id="ability-name" name="name" required pattern="[a-z][a-z0-9_]*" placeholder="my_ability" autocomplete="off">
            <small class="form-hint">Lowercase letters, numbers, underscores only.</small>
          </div>
          <div class="form-group form-group-half">
            <label for="ability-category">Category</label>
            <input type="text" id="ability-category" name="category" placeholder="custom" autocomplete="off">
          </div>
        </div>
        <div class="form-group">
          <label for="ability-description">Description</label>
          <input type="text" id="ability-description" name="description" placeholder="Brief description of this ability" autocomplete="off">
        </div>
        <div class="form-group">
          <label for="ability-applies">When to Use</label>
          <input type="text" id="ability-applies" name="applies" placeholder="e.g., when user asks about coding, for file operations, always" autocomplete="off">
          <small class="form-hint">Describe the context or trigger for this ability</small>
        </div>
      </form>
      <div class="error-message"></div>
    `;
  }

  /**
   * Render step 2: Content.
   */
  _renderStep2() {
    return `
      <div class="form-group">
        <label for="ability-content">Content (Markdown)</label>
        <textarea id="ability-content" name="content" required rows="12" placeholder="Instructions for the AI agent..."></textarea>
        <small class="form-hint">Template variables: {{DATE}}, {{TIME}}, {{USER_NAME}}, {{SESSION_NAME}}</small>
      </div>
      <div class="error-message"></div>
    `;
  }

  mounted() {
    super.mounted();

    // Listen for show-modal events
    document.addEventListener('show-modal', (event) => {
      if (event.detail.modal === 'configure-ability' || event.detail.modal === 'ability') {
        this._editId = null;
        this.openModal();
      }
    });
  }

  /**
   * Handle form submission.
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
      return;
    }

    // Collect form data from all steps
    let name        = this.querySelector('[name="name"]')?.value.trim() || '';
    let category    = this.querySelector('[name="category"]')?.value.trim() || 'custom';
    let description = this.querySelector('[name="description"]')?.value.trim() || '';
    let applies     = this.querySelector('[name="applies"]')?.value.trim() || '';
    let content     = this.querySelector('[name="content"]')?.value || '';

    try {
      let { createAbility, updateAbility, fetchAbilities } = window;

      let data = {
        name,
        category,
        description,
        applies,
        content,
      };

      if (this._editId) {
        await updateAbility(this._editId, data);
      } else {
        await createAbility(data);
      }

      // Refresh abilities list
      let abilities = await fetchAbilities();
      this.setGlobal('abilities', abilities);

      // Clear draft and close
      this._clearDraft();
      this.close();
    } catch (error) {
      this.error = error.message;
    }
  }

  /**
   * Reset state when closing.
   */
  onClose() {
    this._editId = null;
  }
}

// Register component using Mythix UI pattern
HeroModalConfigureAbility.register();
