'use strict';

export function deepMerge(target, patch) {
  if (!isPlainObject(target))
    target = {};

  if (!isPlainObject(patch))
    return cloneValue(patch);

  let result = { ...target };

  for (let key of Object.keys(patch)) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor')
      continue;

    let value = patch[key];

    if (value === null) {
      delete result[key];
      continue;
    }

    if (Array.isArray(value)) {
      result[key] = value.map(cloneValue);
      continue;
    }

    if (isPlainObject(value)) {
      result[key] = deepMerge(result[key], value);
      continue;
    }

    result[key] = cloneValue(value);
  }

  return result;
}

export function cloneValue(value) {
  if (Array.isArray(value))
    return value.map(cloneValue);

  if (isPlainObject(value)) {
    let output = {};
    for (let key of Object.keys(value)) {
      if (key === '__proto__' || key === 'prototype' || key === 'constructor')
        continue;

      output[key] = cloneValue(value[key]);
    }

    return output;
  }

  return value;
}

export function isPlainObject(value) {
  if (value === null || typeof value !== 'object')
    return false;

  let proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

