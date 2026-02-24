'use strict';

let currentLocale   = {};
let currentLanguage = 'en';

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

function pickPluralForm(value, count) {
  if (count === 1)
    return (value.one !== undefined) ? value.one : value.other;

  return (value.other !== undefined) ? value.other : value.one;
}

function interpolate(template, variables) {
  if (!variables || typeof template !== 'string')
    return template;

  return template.replace(/\{(\w+)\}/g, (match, name) => {
    return (variables[name] !== undefined) ? String(variables[name]) : match;
  });
}

export function t(key, variables) {
  if (!key)
    return key;

  let value = resolvePath(currentLocale, key);

  if (value === undefined)
    return key;

  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    let count = (variables != null) ? variables.count : undefined;

    if ((value.one !== undefined || value.other !== undefined) && count !== undefined) {
      value = pickPluralForm(value, count);
    } else {
      return key;
    }
  }

  return interpolate(value, variables);
}

export function setLocale(locale, language) {
  currentLocale   = locale;
  currentLanguage = language || 'en';
}

export function getLocale() {
  return currentLocale;
}

export function getCurrentLanguage() {
  return currentLanguage;
}
