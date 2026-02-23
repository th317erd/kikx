'use strict';

/**
 * Form Validation System
 *
 * Provides declarative form validation with:
 * - Built-in validators (required, pattern, minLength, maxLength)
 * - Custom validator functions
 * - Field error collection with references
 * - CSS class toggling for invalid fields
 * - Step-aware validation for multi-step modals
 */

// ============================================================================
// Built-in Validators
// ============================================================================

/**
 * Validates that a field has a non-empty value.
 * @param {string} value - Field value
 * @param {object} options - Validator options
 * @param {string} options.message - Custom error message
 * @returns {string|null} Error message or null if valid
 */
export function required(value, options = {}) {
  let trimmed = (value == null) ? '' : String(value).trim();
  if (trimmed.length === 0)
    return options.message || 'This field is required';

  return null;
}

/**
 * Validates that a field matches a regex pattern.
 * @param {string} value - Field value
 * @param {object} options - Validator options
 * @param {RegExp|string} options.pattern - Pattern to match
 * @param {string} options.message - Custom error message
 * @returns {string|null} Error message or null if valid
 */
export function pattern(value, options = {}) {
  if (value == null || value === '')
    return null; // Empty values should be caught by 'required'

  let regex = (options.pattern instanceof RegExp)
    ? options.pattern
    : new RegExp(options.pattern);

  if (!regex.test(value))
    return options.message || 'Invalid format';

  return null;
}

/**
 * Validates minimum length.
 * @param {string} value - Field value
 * @param {object} options - Validator options
 * @param {number} options.min - Minimum length
 * @param {string} options.message - Custom error message
 * @returns {string|null} Error message or null if valid
 */
export function minLength(value, options = {}) {
  if (value == null || value === '')
    return null; // Empty values should be caught by 'required'

  let min = options.min || 0;
  if (String(value).length < min)
    return options.message || `Must be at least ${min} characters`;

  return null;
}

/**
 * Validates maximum length.
 * @param {string} value - Field value
 * @param {object} options - Validator options
 * @param {number} options.max - Maximum length
 * @param {string} options.message - Custom error message
 * @returns {string|null} Error message or null if valid
 */
export function maxLength(value, options = {}) {
  if (value == null || value === '')
    return null;

  let max = options.max || Infinity;
  if (String(value).length > max)
    return options.message || `Must be no more than ${max} characters`;

  return null;
}

/**
 * Validates that value matches one of the allowed options.
 * @param {string} value - Field value
 * @param {object} options - Validator options
 * @param {Array} options.values - Allowed values
 * @param {string} options.message - Custom error message
 * @returns {string|null} Error message or null if valid
 */
export function oneOf(value, options = {}) {
  if (value == null || value === '')
    return null;

  let allowedValues = options.values || [];
  if (!allowedValues.includes(value))
    return options.message || `Must be one of: ${allowedValues.join(', ')}`;

  return null;
}

// ============================================================================
// Validator Registry
// ============================================================================

const builtinValidators = {
  required,
  pattern,
  minLength,
  maxLength,
  oneOf,
};

// ============================================================================
// Field Configuration Types
// ============================================================================

/**
 * @typedef {Object} FieldValidation
 * @property {string} name - Field name (matches form input name)
 * @property {string} label - Human-readable field label for error messages
 * @property {number} [step] - Step number (1-indexed) for multi-step forms
 * @property {Array<ValidatorConfig>} validators - Array of validator configs
 */

/**
 * @typedef {Object} ValidatorConfig
 * @property {string|Function} type - Built-in validator name or custom function
 * @property {Object} [options] - Options passed to the validator
 */

/**
 * @typedef {Object} ValidationError
 * @property {string} field - Field name
 * @property {string} label - Field label
 * @property {string} message - Error message
 * @property {number} [step] - Step number if applicable
 * @property {HTMLElement} [element] - Reference to the DOM element
 */

/**
 * @typedef {Object} ValidationResult
 * @property {boolean} valid - Whether all fields are valid
 * @property {Array<ValidationError>} errors - Array of validation errors
 * @property {number|null} firstErrorStep - First step with an error (for step modals)
 */

// ============================================================================
// Form Validation
// ============================================================================

/**
 * Validates a form or field collection against a validation schema.
 *
 * @param {HTMLFormElement|HTMLElement} container - Form or container element
 * @param {Array<FieldValidation>} schema - Validation schema
 * @param {Object} [options] - Validation options
 * @param {string} [options.invalidClass='field-invalid'] - CSS class for invalid fields
 * @param {boolean} [options.clearPrevious=true] - Clear previous validation state
 * @returns {ValidationResult}
 *
 * @example
 * const schema = [
 *   {
 *     name: 'username',
 *     label: 'Username',
 *     step: 1,
 *     validators: [
 *       { type: 'required' },
 *       { type: 'pattern', options: { pattern: /^[a-z][a-z0-9_]*$/, message: 'Lowercase letters, numbers, underscores only' } },
 *       { type: 'minLength', options: { min: 3 } },
 *     ],
 *   },
 *   {
 *     name: 'email',
 *     label: 'Email',
 *     step: 2,
 *     validators: [
 *       { type: 'required' },
 *       { type: (value) => value.includes('@') ? null : 'Must be a valid email' },
 *     ],
 *   },
 * ];
 *
 * const result = validateForm(form, schema);
 * if (!result.valid) {
 *   console.log('First error on step:', result.firstErrorStep);
 *   console.log('Errors:', result.errors);
 * }
 */
export function validateForm(container, schema, options = {}) {
  let invalidClass   = options.invalidClass || 'field-invalid';
  let clearPrevious  = (options.clearPrevious !== false);

  let errors         = [];
  let firstErrorStep = null;

  // Clear previous validation state
  if (clearPrevious) {
    let previouslyInvalid = container.querySelectorAll(`.${invalidClass}`);
    for (let element of previouslyInvalid) {
      element.classList.remove(invalidClass);
    }
  }

  // Validate each field
  for (let fieldConfig of schema) {
    let fieldName   = fieldConfig.name;
    let fieldLabel  = fieldConfig.label || fieldName;
    let step        = fieldConfig.step || null;
    let validators  = fieldConfig.validators || [];

    // Find the field element
    let element = container.querySelector(`[name="${fieldName}"]`);
    if (!element)
      continue;

    // Get field value
    let value;
    if (element.type === 'checkbox') {
      value = element.checked;
    } else {
      value = element.value;
    }

    // Run validators
    for (let validatorConfig of validators) {
      let validatorType    = validatorConfig.type;
      let validatorOptions = validatorConfig.options || {};
      let errorMessage     = null;

      // Resolve validator function
      if (typeof validatorType === 'function') {
        // Custom validator function
        errorMessage = validatorType(value, validatorOptions);
      } else if (typeof validatorType === 'string') {
        // Built-in validator
        let validator = builtinValidators[validatorType];
        if (validator) {
          errorMessage = validator(value, validatorOptions);
        } else {
          console.warn(`Unknown validator: ${validatorType}`);
        }
      }

      if (errorMessage) {
        // Add invalid class to element
        element.classList.add(invalidClass);

        // Record error
        errors.push({
          field:   fieldName,
          label:   fieldLabel,
          message: errorMessage,
          step:    step,
          element: element,
        });

        // Track first error step
        if (step !== null && firstErrorStep === null)
          firstErrorStep = step;

        // Stop validating this field on first error
        break;
      }
    }
  }

  return {
    valid:          errors.length === 0,
    errors:         errors,
    firstErrorStep: firstErrorStep,
  };
}

/**
 * Creates a validation schema from HTML5 validation attributes.
 * Useful for simple forms where schema can be derived from markup.
 *
 * @param {HTMLFormElement|HTMLElement} container - Form or container element
 * @param {Object} [labelMap] - Map of field names to labels
 * @param {Object} [stepMap] - Map of field names to step numbers
 * @returns {Array<FieldValidation>}
 *
 * @example
 * // HTML: <input name="username" required pattern="[a-z]+" minlength="3">
 * const schema = schemaFromAttributes(form, { username: 'Username' }, { username: 1 });
 */
export function schemaFromAttributes(container, labelMap = {}, stepMap = {}) {
  let schema  = [];
  let inputs  = container.querySelectorAll('input, textarea, select');

  for (let input of inputs) {
    let name = input.name;
    if (!name)
      continue;

    let validators = [];

    // Required attribute
    if (input.required)
      validators.push({ type: 'required' });

    // Pattern attribute
    if (input.pattern)
      validators.push({ type: 'pattern', options: { pattern: input.pattern } });

    // Minlength attribute
    if (input.minLength > 0)
      validators.push({ type: 'minLength', options: { min: input.minLength } });

    // Maxlength attribute
    if (input.maxLength > 0 && input.maxLength < 524288)
      validators.push({ type: 'maxLength', options: { max: input.maxLength } });

    if (validators.length > 0) {
      schema.push({
        name:       name,
        label:      labelMap[name] || name,
        step:       stepMap[name] || null,
        validators: validators,
      });
    }
  }

  return schema;
}

/**
 * Clears validation state from a form.
 *
 * @param {HTMLFormElement|HTMLElement} container - Form or container element
 * @param {string} [invalidClass='field-invalid'] - CSS class to remove
 */
export function clearValidation(container, invalidClass = 'field-invalid') {
  let invalidElements = container.querySelectorAll(`.${invalidClass}`);
  for (let element of invalidElements) {
    element.classList.remove(invalidClass);
  }
}

/**
 * Formats validation errors for display.
 *
 * @param {Array<ValidationError>} errors - Validation errors
 * @param {Object} [options] - Formatting options
 * @param {boolean} [options.includeFieldName=true] - Include field name in message
 * @returns {string} Formatted error message
 */
export function formatErrors(errors, options = {}) {
  let includeFieldName = (options.includeFieldName !== false);

  if (errors.length === 0)
    return '';

  if (errors.length === 1) {
    let error = errors[0];
    return (includeFieldName)
      ? `${error.label}: ${error.message}`
      : error.message;
  }

  // Multiple errors - list them
  let messages = errors.map((error) => {
    return (includeFieldName)
      ? `${error.label}: ${error.message}`
      : error.message;
  });

  return messages.join('\n');
}

/**
 * Focuses the first invalid field in the container.
 *
 * @param {HTMLFormElement|HTMLElement} container - Form or container element
 * @param {string} [invalidClass='field-invalid'] - CSS class for invalid fields
 * @returns {HTMLElement|null} The focused element, or null if none found
 */
export function focusFirstInvalid(container, invalidClass = 'field-invalid') {
  let firstInvalid = container.querySelector(`.${invalidClass}`);
  if (firstInvalid && typeof firstInvalid.focus === 'function') {
    firstInvalid.focus();
    return firstInvalid;
  }
  return null;
}

// ============================================================================
// CSS for Invalid Fields (inject into document)
// ============================================================================

export const VALIDATION_STYLES = `
  .field-invalid {
    border-color: var(--error, #f87171) !important;
    box-shadow: 0 0 0 1px var(--error, #f87171);
  }

  .field-invalid:focus {
    border-color: var(--error, #f87171) !important;
    box-shadow: 0 0 0 2px rgba(248, 113, 113, 0.3);
  }
`;

/**
 * Injects validation styles into the document if not already present.
 */
export function injectValidationStyles() {
  if (document.querySelector('#form-validation-styles'))
    return;

  let style     = document.createElement('style');
  style.id      = 'form-validation-styles';
  style.textContent = VALIDATION_STYLES;
  document.head.appendChild(style);
}

// ============================================================================
// Default Export
// ============================================================================

export default {
  // Validators
  required,
  pattern,
  minLength,
  maxLength,
  oneOf,

  // Form validation
  validateForm,
  schemaFromAttributes,
  clearValidation,
  formatErrors,
  focusFirstInvalid,

  // Styles
  VALIDATION_STYLES,
  injectValidationStyles,
};
