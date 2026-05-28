'use strict';

// Adapted from mythix-ui-core/lib/base-utils.js
// Minimal subset needed by query-engine and elements.

const NATIVE_CLASS_TYPES = new Set([
  'Array', 'ArrayBuffer', 'BigInt', 'BigInt64Array', 'BigUint64Array',
  'Boolean', 'DataView', 'Date', 'Error', 'Float32Array', 'Float64Array',
  'Function', 'Generator', 'GeneratorFunction', 'Int8Array', 'Int16Array',
  'Int32Array', 'Map', 'Number', 'Object', 'Promise', 'Proxy', 'RegExp',
  'Set', 'SharedArrayBuffer', 'String', 'Symbol', 'Uint8Array',
  'Uint8ClampedArray', 'Uint16Array', 'Uint32Array', 'WeakMap', 'WeakSet',
  'WeakRef',
]);

export function typeOf(value) {
  if (value === undefined)
    return '::Undefined';

  if (value === null)
    return '::Null';

  if (typeof value === 'symbol')
    return '::Symbol';

  if (typeof value === 'bigint')
    return '::BigInt';

  let nativeType = typeof value;
  if (nativeType === 'string')
    return '::String';

  if (nativeType === 'number')
    return (isFinite(value)) ? '::Number' : '::Infinity';

  if (nativeType === 'boolean')
    return '::Boolean';

  if (nativeType === 'function') {
    let name = value.name || 'Function';
    if (NATIVE_CLASS_TYPES.has(name))
      return `[Class ${name}]`;

    return `[Class ${name}]`;
  }

  if (Array.isArray(value))
    return '::Array';

  let constructorName = value?.constructor?.name;
  if (constructorName && constructorName !== 'Object')
    return `[Instance ${constructorName}]`;

  return '::Object';
}

export function isType(value, ...types) {
  let valueType = typeOf(value);

  for (let type of types) {
    if (typeof type === 'string') {
      if (valueType === type)
        return true;
    } else if (typeof type === 'function') {
      if (value instanceof type)
        return true;
    }
  }

  return false;
}

export function isPlainObject(value) {
  if (value == null || typeof value !== 'object')
    return false;

  let proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function isPrimitive(value) {
  if (value == null)
    return true;

  let type = typeof value;
  return type === 'string' || type === 'number' || type === 'boolean' || type === 'bigint' || type === 'symbol';
}
