'use strict';

export function nonEmptyValues(values) {
  let output = {};
  for (let [ key, value ] of Object.entries(values || {})) {
    if (value != null && value !== '')
      output[key] = value;
  }
  return output;
}

export function coerceAgentFieldValue(field, value) {
  if (field.type === 'number')
    return value === '' ? null : Number(value);

  if (field.type === 'checkbox' || field.type === 'boolean')
    return Boolean(value);

  return value;
}

export function normalizeFieldOptions(options) {
  return (Array.isArray(options) ? options : []).map((item) => {
    if (typeof item === 'string')
      return { value: item, label: item };

    return {
      value: item?.value ?? '',
      label: item?.label ?? item?.value ?? '',
    };
  });
}
