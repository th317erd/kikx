'use strict';

import { elements } from '../lib/aeor-ui.mjs';
import { coerceAgentFieldValue, normalizeFieldOptions } from './agent-form-helpers.mjs';

const { div, label } = elements;
const aeorInput = elements['aeor-input'];
const aeorSelect = elements['aeor-select'];
const option = elements['option'];

// Core default "guts" for the agent create/edit wrapper dialog. It renders a
// provider's declared `configFields` and implements the guts contract used by
// the wrapper (see agent-config-form-registry.mjs):
//
//   setContext({ mode, pluginID, provider, config, secrets, secretState,
//                onValuesChanged }) -> void
//   readValues() -> { config, secrets }
//   validate() -> { valid, errors }
//
// Providers without a plugin-registered `agent-config-form` use this element,
// preserving the previous generic-field behavior.
export class KikxDefaultAgentConfigForm extends HTMLElement {
  constructor() {
    super();
    this._mode = 'create';
    this._pluginID = '';
    this._provider = null;
    this._fields = [];
    this._config = {};
    this._secrets = {};
    this._secretState = {};
    this._controls = new Map();
    this._onValuesChanged = null;
    this._rendered = false;
  }

  connectedCallback() {
    if (!this._rendered)
      this.render();
  }

  setContext(context = {}) {
    this._mode = context.mode || 'create';
    this._pluginID = context.pluginID || '';
    this._provider = context.provider || null;
    this._config = { ...(context.config || {}) };
    this._secrets = { ...(context.secrets || {}) };
    this._secretState = context.secretState || {};
    this._onValuesChanged = typeof context.onValuesChanged === 'function' ? context.onValuesChanged : null;

    let nextFields = normalizeFields(this._provider?.configFields);
    let changed = fieldsSignature(nextFields) !== fieldsSignature(this._fields);
    this._fields = nextFields;

    if (this._rendered && !changed) {
      this._applyValuesToFields();
      return;
    }

    this.render();
  }

  readValues() {
    let config = {};
    let secrets = {};

    for (let field of this._fields) {
      let control = this._controls.get(field.name);
      let value = control ? control.value : (field.secret ? '' : this._config[field.name]);

      if (field.secret) {
        if (value != null && value !== '')
          secrets[field.name] = value;

        continue;
      }

      config[field.name] = coerceAgentFieldValue(field, value);
    }

    return { config, secrets };
  }

  validate() {
    let errors = {};

    for (let field of this._fields) {
      if (!field.required)
        continue;

      // On edit, a stored secret need not be retyped to save.
      if (field.secret && this._mode !== 'create')
        continue;

      let control = this._controls.get(field.name);
      let value = control ? control.value : '';
      if (value == null || String(value).trim() === '')
        errors[field.name] = `${field.label || field.name} is required`;
    }

    return {
      valid: Object.keys(errors).length === 0,
      errors,
    };
  }

  render() {
    this._rendered = true;
    this._controls = new Map();

    if (this._fields.length === 0) {
      this.replaceChildren(div.class('kikx-default-config__empty')('This provider has no additional configuration.'));
      return;
    }

    let tree = div.class('kikx-default-config')(
      ...this._fields.map((field) => [
        label.class('kikx-default-config__label')(field.label || field.name),
        this._buildControl(field),
      ]),
    ).build(document);

    this.replaceChildren(tree);
    this._applyValuesToFields();
  }

  _buildControl(field) {
    if (field.type === 'select') {
      let control = aeorSelect
        .class('kikx-default-config__control')
        .name(field.name)
        .placeholder(field.label || field.name)
        .onChange((event) => this._onFieldChange(field, event.target.value))(
          normalizeFieldOptions(field.options).map((item) => option
            .value(item.value)
            .selected(item.value === this._config[field.name])(
              item.label,
            )),
        )
        .build(document);

      this._controls.set(field.name, control);
      return control;
    }

    let control = aeorInput
      .class('kikx-default-config__control')
      .type(field.secret ? 'password' : field.type || 'text')
      .name(field.name)
      .placeholder(field.secret ? this._secretPlaceholder(field.name) : '')
      .value(field.secret ? '' : this._config[field.name])
      .onInput((event) => this._onFieldChange(field, event.target.value))()
      .build(document);

    this._controls.set(field.name, control);
    return control;
  }

  _applyValuesToFields() {
    for (let field of this._fields) {
      let control = this._controls.get(field.name);
      if (!control)
        continue;

      if (field.secret) {
        control.value = this._secrets[field.name] || '';
        continue;
      }

      control.value = this._config[field.name] ?? field.defaultValue ?? '';
    }
  }

  _onFieldChange(field, value) {
    if (field.secret)
      this._secrets = { ...this._secrets, [field.name]: value };
    else
      this._config = { ...this._config, [field.name]: coerceAgentFieldValue(field, value) };

    this._notifyChanged();
  }

  _notifyChanged() {
    if (typeof this._onValuesChanged !== 'function')
      return;

    let values = this.readValues();
    this._onValuesChanged({ config: values.config, secrets: values.secrets });
  }

  _secretPlaceholder(fieldName) {
    let secret = this._secretState?.[fieldName];
    return secret?.present ? `Stored ending in ${secret.last4}` : '';
  }
}

if (typeof customElements !== 'undefined' && !customElements.get('kikx-default-agent-config-form'))
  customElements.define('kikx-default-agent-config-form', KikxDefaultAgentConfigForm);

function normalizeFields(fields) {
  return (Array.isArray(fields) ? fields : []).filter((field) => field && typeof field.name === 'string' && field.name !== '');
}

function fieldsSignature(fields) {
  return (Array.isArray(fields) ? fields : []).map((field) => field.name).join('|');
}
