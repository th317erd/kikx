'use strict';

import { elements } from '../lib/aeor-ui.mjs';

const { div, label, span } = elements;
const aeorInput = elements['aeor-input'];
const aeorSelect = elements['aeor-select'];
const option = elements['option'];

export function buildAgentTagSection(app) {
  let definitions = agentTagDefinitions(app?._state?.agentTagDefinitions);
  if (definitions.length === 0)
    return [];

  return [
    div.class('kikx-agent-form__tags-heading')('Tags'),
    div.class('kikx-default-config kikx-agent-tags')(
      ...definitions.map((definition) => [
        label.class('kikx-default-config__label')(definition.label || definition.name),
        buildTagControl(app, definition),
        definition.description
          ? span.class('kikx-agent-tags__help')(definition.description)
          : null,
      ]),
    ),
  ];
}

function buildTagControl(app, definition) {
  let value = app?._state?.agentFormTags?.[definition.name] ?? definition.defaultValue ?? '';
  let onChange = (next) => {
    app._state.agentFormTags = {
      ...(app._state.agentFormTags || {}),
      [definition.name]: next,
    };
  };

  if (definition.type === 'select') {
    return aeorSelect
      .class('kikx-default-config__control')
      .name(definition.name)
      .onChange((event) => onChange(event.target.value))(
        normalizeOptions(definition.options).map((item) => option
          .value(item.value)
          .selected(String(item.value) === String(value))(item.label)),
      )
      .build(document);
  }

  if (definition.type === 'boolean') {
    let control = document.createElement('input');
    control.className = 'kikx-default-config__control kikx-agent-tags__checkbox';
    control.type = 'checkbox';
    control.name = definition.name;
    control.checked = value === true;
    control.addEventListener('change', () => onChange(control.checked));
    return control;
  }

  let control = aeorInput
    .class('kikx-default-config__control')
    .type(definition.type === 'integer' || definition.type === 'number' ? 'number' : 'text')
    .name(definition.name)
    .value(value)
    .onInput((event) => onChange(coerceTagInput(definition, event.target.value)))()
    .build(document);

  if (definition.type === 'integer' || definition.type === 'number') {
    if (definition.min != null)
      control.setAttribute('min', String(definition.min));
    if (definition.max != null)
      control.setAttribute('max', String(definition.max));
    control.setAttribute('step', String(definition.step ?? (definition.type === 'integer' ? 1 : 'any')));
  }

  return control;
}

function coerceTagInput(definition, value) {
  if (value === '')
    return null;
  if (definition.type === 'integer' || definition.type === 'number')
    return Number(value);
  return value;
}

function normalizeOptions(options) {
  return (Array.isArray(options) ? options : []).map((item) => (
    typeof item === 'string'
      ? { value: item, label: item }
      : { value: String(item?.value ?? ''), label: String(item?.label ?? item?.value ?? '') }
  ));
}

function agentTagDefinitions(definitions = []) {
  return (Array.isArray(definitions) ? definitions : []).filter((definition) => (
    definition
    && typeof definition.name === 'string'
    && (!Array.isArray(definition.targetTypes) || definition.targetTypes.includes('agent'))
  ));
}
