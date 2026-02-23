'use strict';

// ============================================================================
// Form Validation Tests
// ============================================================================
// Tests for public/js/lib/form-validation.js

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createDOM, destroyDOM, getDocument, getWindow } from '../helpers/dom-helpers.mjs';

// Import the validation module (ES module)
import {
  required,
  pattern,
  minLength,
  maxLength,
  oneOf,
  validateForm,
  schemaFromAttributes,
  clearValidation,
  formatErrors,
  focusFirstInvalid,
} from '../../public/js/lib/form-validation.js';

// ============================================================================
// Tests: required validator
// ============================================================================

describe('required validator', () => {
  it('should return error for empty string', () => {
    const result = required('');
    assert.strictEqual(result, 'This field is required');
  });

  it('should return error for whitespace-only string', () => {
    const result = required('   ');
    assert.strictEqual(result, 'This field is required');
  });

  it('should return error for null', () => {
    const result = required(null);
    assert.strictEqual(result, 'This field is required');
  });

  it('should return error for undefined', () => {
    const result = required(undefined);
    assert.strictEqual(result, 'This field is required');
  });

  it('should return null for non-empty string', () => {
    const result = required('hello');
    assert.strictEqual(result, null);
  });

  it('should return null for string with content', () => {
    const result = required('  hello  ');
    assert.strictEqual(result, null);
  });

  it('should use custom error message', () => {
    const result = required('', { message: 'Please enter a value' });
    assert.strictEqual(result, 'Please enter a value');
  });
});

// ============================================================================
// Tests: pattern validator
// ============================================================================

describe('pattern validator', () => {
  it('should return null for empty value (not required)', () => {
    const result = pattern('', { pattern: /^[a-z]+$/ });
    assert.strictEqual(result, null);
  });

  it('should return null for null value (not required)', () => {
    const result = pattern(null, { pattern: /^[a-z]+$/ });
    assert.strictEqual(result, null);
  });

  it('should return error for non-matching value', () => {
    const result = pattern('ABC', { pattern: /^[a-z]+$/ });
    assert.strictEqual(result, 'Invalid format');
  });

  it('should return null for matching value', () => {
    const result = pattern('abc', { pattern: /^[a-z]+$/ });
    assert.strictEqual(result, null);
  });

  it('should accept string pattern', () => {
    const result = pattern('abc123', { pattern: '^[a-z]+$' });
    assert.strictEqual(result, 'Invalid format');
  });

  it('should use custom error message', () => {
    const result = pattern('ABC', { pattern: /^[a-z]+$/, message: 'Only lowercase letters' });
    assert.strictEqual(result, 'Only lowercase letters');
  });

  it('should work with email pattern', () => {
    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    assert.strictEqual(pattern('user@example.com', { pattern: emailPattern }), null);
    assert.strictEqual(pattern('invalid-email', { pattern: emailPattern }), 'Invalid format');
  });
});

// ============================================================================
// Tests: minLength validator
// ============================================================================

describe('minLength validator', () => {
  it('should return null for empty value (not required)', () => {
    const result = minLength('', { min: 3 });
    assert.strictEqual(result, null);
  });

  it('should return error for value below minimum', () => {
    const result = minLength('ab', { min: 3 });
    assert.strictEqual(result, 'Must be at least 3 characters');
  });

  it('should return null for value at minimum', () => {
    const result = minLength('abc', { min: 3 });
    assert.strictEqual(result, null);
  });

  it('should return null for value above minimum', () => {
    const result = minLength('abcdef', { min: 3 });
    assert.strictEqual(result, null);
  });

  it('should use custom error message', () => {
    const result = minLength('a', { min: 5, message: 'Too short!' });
    assert.strictEqual(result, 'Too short!');
  });

  it('should default to min 0', () => {
    const result = minLength('a', {});
    assert.strictEqual(result, null);
  });
});

// ============================================================================
// Tests: maxLength validator
// ============================================================================

describe('maxLength validator', () => {
  it('should return null for empty value', () => {
    const result = maxLength('', { max: 5 });
    assert.strictEqual(result, null);
  });

  it('should return error for value above maximum', () => {
    const result = maxLength('abcdef', { max: 5 });
    assert.strictEqual(result, 'Must be no more than 5 characters');
  });

  it('should return null for value at maximum', () => {
    const result = maxLength('abcde', { max: 5 });
    assert.strictEqual(result, null);
  });

  it('should return null for value below maximum', () => {
    const result = maxLength('abc', { max: 5 });
    assert.strictEqual(result, null);
  });

  it('should use custom error message', () => {
    const result = maxLength('abcdefgh', { max: 5, message: 'Too long!' });
    assert.strictEqual(result, 'Too long!');
  });
});

// ============================================================================
// Tests: oneOf validator
// ============================================================================

describe('oneOf validator', () => {
  it('should return null for empty value', () => {
    const result = oneOf('', { values: ['a', 'b', 'c'] });
    assert.strictEqual(result, null);
  });

  it('should return null for allowed value', () => {
    const result = oneOf('b', { values: ['a', 'b', 'c'] });
    assert.strictEqual(result, null);
  });

  it('should return error for disallowed value', () => {
    const result = oneOf('x', { values: ['a', 'b', 'c'] });
    assert.strictEqual(result, 'Must be one of: a, b, c');
  });

  it('should use custom error message', () => {
    const result = oneOf('x', { values: ['yes', 'no'], message: 'Choose yes or no' });
    assert.strictEqual(result, 'Choose yes or no');
  });

  it('should handle empty values array', () => {
    const result = oneOf('anything', { values: [] });
    assert.strictEqual(result, 'Must be one of: ');
  });
});

// ============================================================================
// Tests: validateForm
// ============================================================================

describe('validateForm', () => {
  beforeEach(() => createDOM());
  afterEach(() => destroyDOM());

  function createTestForm(html) {
    const doc = getDocument();
    const form = doc.createElement('form');
    form.innerHTML = html;
    doc.body.appendChild(form);
    return form;
  }

  it('should validate required field', () => {
    const form = createTestForm('<input name="username" value="">');
    const schema = [{ name: 'username', label: 'Username', validators: [{ type: 'required' }] }];

    const result = validateForm(form, schema);

    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.errors.length, 1);
    assert.strictEqual(result.errors[0].field, 'username');
    assert.strictEqual(result.errors[0].message, 'This field is required');
  });

  it('should pass valid field', () => {
    const form = createTestForm('<input name="username" value="john">');
    const schema = [{ name: 'username', label: 'Username', validators: [{ type: 'required' }] }];

    const result = validateForm(form, schema);

    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.errors.length, 0);
  });

  it('should validate multiple validators on same field', () => {
    const form = createTestForm('<input name="username" value="AB">');
    const schema = [{
      name: 'username',
      label: 'Username',
      validators: [
        { type: 'required' },
        { type: 'minLength', options: { min: 3 } },
      ],
    }];

    const result = validateForm(form, schema);

    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.errors.length, 1);
    assert.ok(result.errors[0].message.includes('at least 3'));
  });

  it('should stop at first error for a field', () => {
    const form = createTestForm('<input name="username" value="">');
    const schema = [{
      name: 'username',
      label: 'Username',
      validators: [
        { type: 'required' },
        { type: 'minLength', options: { min: 3 } },
      ],
    }];

    const result = validateForm(form, schema);

    // Should only show 'required' error, not minLength
    assert.strictEqual(result.errors.length, 1);
    assert.strictEqual(result.errors[0].message, 'This field is required');
  });

  it('should validate multiple fields', () => {
    const form = createTestForm(`
      <input name="username" value="">
      <input name="email" value="">
    `);
    const schema = [
      { name: 'username', label: 'Username', validators: [{ type: 'required' }] },
      { name: 'email', label: 'Email', validators: [{ type: 'required' }] },
    ];

    const result = validateForm(form, schema);

    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.errors.length, 2);
  });

  it('should add invalid class to fields', () => {
    const form = createTestForm('<input name="username" value="">');
    const schema = [{ name: 'username', label: 'Username', validators: [{ type: 'required' }] }];

    validateForm(form, schema);

    const input = form.querySelector('[name="username"]');
    assert.ok(input.classList.contains('field-invalid'));
  });

  it('should use custom invalid class', () => {
    const form = createTestForm('<input name="username" value="">');
    const schema = [{ name: 'username', label: 'Username', validators: [{ type: 'required' }] }];

    validateForm(form, schema, { invalidClass: 'error-field' });

    const input = form.querySelector('[name="username"]');
    assert.ok(input.classList.contains('error-field'));
  });

  it('should track step for multi-step forms', () => {
    const form = createTestForm(`
      <input name="field1" value="">
      <input name="field2" value="">
    `);
    const schema = [
      { name: 'field1', label: 'Field 1', step: 2, validators: [{ type: 'required' }] },
      { name: 'field2', label: 'Field 2', step: 1, validators: [{ type: 'required' }] },
    ];

    const result = validateForm(form, schema);

    assert.strictEqual(result.firstErrorStep, 2); // First in schema order, not step order
  });

  it('should support custom validator functions', () => {
    const form = createTestForm('<input name="email" value="invalid">');
    const schema = [{
      name: 'email',
      label: 'Email',
      validators: [{
        type: (value) => value.includes('@') ? null : 'Must contain @',
      }],
    }];

    const result = validateForm(form, schema);

    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.errors[0].message, 'Must contain @');
  });

  it('should handle checkbox fields', () => {
    const form = createTestForm('<input type="checkbox" name="agree" value="yes">');
    const schema = [{
      name: 'agree',
      label: 'Agreement',
      validators: [{ type: (value) => value === true ? null : 'Must agree' }],
    }];

    const result = validateForm(form, schema);

    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.errors[0].message, 'Must agree');
  });

  it('should pass checkbox when checked', () => {
    const form = createTestForm('<input type="checkbox" name="agree" value="yes" checked>');
    const schema = [{
      name: 'agree',
      label: 'Agreement',
      validators: [{ type: (value) => value === true ? null : 'Must agree' }],
    }];

    const result = validateForm(form, schema);

    assert.strictEqual(result.valid, true);
  });

  it('should skip missing fields', () => {
    const form = createTestForm('<input name="exists" value="test">');
    const schema = [
      { name: 'exists', label: 'Exists', validators: [{ type: 'required' }] },
      { name: 'missing', label: 'Missing', validators: [{ type: 'required' }] },
    ];

    const result = validateForm(form, schema);

    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.errors.length, 0);
  });

  it('should clear previous validation state', () => {
    const form = createTestForm('<input name="username" value="" class="field-invalid">');

    // First validation - field is empty and already has invalid class
    const input = form.querySelector('[name="username"]');
    input.value = 'valid';

    const schema = [{ name: 'username', label: 'Username', validators: [{ type: 'required' }] }];
    validateForm(form, schema);

    assert.ok(!input.classList.contains('field-invalid'));
  });
});

// ============================================================================
// Tests: schemaFromAttributes
// ============================================================================

describe('schemaFromAttributes', () => {
  beforeEach(() => createDOM());
  afterEach(() => destroyDOM());

  function createTestForm(html) {
    const doc = getDocument();
    const form = doc.createElement('form');
    form.innerHTML = html;
    doc.body.appendChild(form);
    return form;
  }

  it('should extract required attribute', () => {
    const form = createTestForm('<input name="username" required>');
    const schema = schemaFromAttributes(form);

    assert.strictEqual(schema.length, 1);
    assert.strictEqual(schema[0].name, 'username');
    assert.strictEqual(schema[0].validators[0].type, 'required');
  });

  it('should extract pattern attribute', () => {
    const form = createTestForm('<input name="code" pattern="[A-Z]{3}">');
    const schema = schemaFromAttributes(form);

    assert.strictEqual(schema.length, 1);
    assert.strictEqual(schema[0].validators[0].type, 'pattern');
    assert.strictEqual(schema[0].validators[0].options.pattern, '[A-Z]{3}');
  });

  it('should extract minlength attribute', () => {
    const form = createTestForm('<input name="password" minlength="8">');
    const schema = schemaFromAttributes(form);

    assert.strictEqual(schema.length, 1);
    assert.strictEqual(schema[0].validators[0].type, 'minLength');
    assert.strictEqual(schema[0].validators[0].options.min, 8);
  });

  it('should use label map', () => {
    const form = createTestForm('<input name="username" required>');
    const schema = schemaFromAttributes(form, { username: 'User Name' });

    assert.strictEqual(schema[0].label, 'User Name');
  });

  it('should use step map', () => {
    const form = createTestForm('<input name="username" required>');
    const schema = schemaFromAttributes(form, {}, { username: 2 });

    assert.strictEqual(schema[0].step, 2);
  });

  it('should skip fields without validation attributes', () => {
    const form = createTestForm(`
      <input name="optional" value="test">
      <input name="required_field" required>
    `);
    const schema = schemaFromAttributes(form);

    assert.strictEqual(schema.length, 1);
    assert.strictEqual(schema[0].name, 'required_field');
  });

  it('should skip fields without name', () => {
    const form = createTestForm('<input required>');
    const schema = schemaFromAttributes(form);

    assert.strictEqual(schema.length, 0);
  });
});

// ============================================================================
// Tests: clearValidation
// ============================================================================

describe('clearValidation', () => {
  beforeEach(() => createDOM());
  afterEach(() => destroyDOM());

  it('should remove invalid class from all fields', () => {
    const doc = getDocument();
    const form = doc.createElement('form');
    form.innerHTML = `
      <input name="field1" class="field-invalid">
      <input name="field2" class="field-invalid">
    `;
    doc.body.appendChild(form);

    clearValidation(form);

    const invalid = form.querySelectorAll('.field-invalid');
    assert.strictEqual(invalid.length, 0);
  });

  it('should use custom invalid class', () => {
    const doc = getDocument();
    const form = doc.createElement('form');
    form.innerHTML = '<input name="field1" class="error-state">';
    doc.body.appendChild(form);

    clearValidation(form, 'error-state');

    const invalid = form.querySelectorAll('.error-state');
    assert.strictEqual(invalid.length, 0);
  });
});

// ============================================================================
// Tests: formatErrors
// ============================================================================

describe('formatErrors', () => {
  it('should return empty string for no errors', () => {
    const result = formatErrors([]);
    assert.strictEqual(result, '');
  });

  it('should format single error with field name', () => {
    const errors = [{ field: 'username', label: 'Username', message: 'is required' }];
    const result = formatErrors(errors);

    assert.strictEqual(result, 'Username: is required');
  });

  it('should format single error without field name', () => {
    const errors = [{ field: 'username', label: 'Username', message: 'is required' }];
    const result = formatErrors(errors, { includeFieldName: false });

    assert.strictEqual(result, 'is required');
  });

  it('should format multiple errors', () => {
    const errors = [
      { field: 'username', label: 'Username', message: 'is required' },
      { field: 'email', label: 'Email', message: 'is invalid' },
    ];
    const result = formatErrors(errors);

    assert.ok(result.includes('Username: is required'));
    assert.ok(result.includes('Email: is invalid'));
    assert.ok(result.includes('\n'));
  });
});

// ============================================================================
// Tests: focusFirstInvalid
// ============================================================================

describe('focusFirstInvalid', () => {
  beforeEach(() => createDOM());
  afterEach(() => destroyDOM());

  it('should focus first invalid field', () => {
    const doc = getDocument();
    const form = doc.createElement('form');
    form.innerHTML = `
      <input name="field1" class="field-invalid">
      <input name="field2" class="field-invalid">
    `;
    doc.body.appendChild(form);

    const focused = focusFirstInvalid(form);

    assert.ok(focused);
    assert.strictEqual(focused.getAttribute('name'), 'field1');
  });

  it('should return null when no invalid fields', () => {
    const doc = getDocument();
    const form = doc.createElement('form');
    form.innerHTML = '<input name="field1">';
    doc.body.appendChild(form);

    const focused = focusFirstInvalid(form);

    assert.strictEqual(focused, null);
  });

  it('should use custom invalid class', () => {
    const doc = getDocument();
    const form = doc.createElement('form');
    form.innerHTML = '<input name="field1" class="error-field">';
    doc.body.appendChild(form);

    const focused = focusFirstInvalid(form, 'error-field');

    assert.ok(focused);
    assert.strictEqual(focused.getAttribute('name'), 'field1');
  });
});
