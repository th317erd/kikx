'use strict';

function isPlainObject(value) {
  if (value == null || typeof value !== 'object')
    return false;

  let prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function deepMerge(target, source) {
  if (!isPlainObject(target))
    return {};

  if (!isPlainObject(source))
    return { ...target };

  let result = { ...target };
  let keys   = Object.keys(source);

  for (let i = 0; i < keys.length; i++) {
    let key   = keys[i];
    let value = source[key];

    // Prototype pollution protection
    if (key === '__proto__' || key === 'constructor')
      continue;

    // Rule 1: null means DELETE the key
    if (value === null) {
      delete result[key];
      continue;
    }

    // Rule 2: arrays replace entirely
    if (Array.isArray(value)) {
      result[key] = [ ...value ];
      continue;
    }

    // Rule 3: plain objects recurse
    if (isPlainObject(value)) {
      let existing = (isPlainObject(result[key])) ? result[key] : {};
      result[key]  = deepMerge(existing, value);
      continue;
    }

    // Rule 4: everything else replaces
    result[key] = value;
  }

  return result;
}
