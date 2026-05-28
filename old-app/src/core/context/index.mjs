'use strict';

// =============================================================================
// Cascading Context
// =============================================================================

const PROPERTY_PATH_SEPARATOR = '.';
const ARRAY_INDEX_PATTERN     = /\[(\d+)\]/g;

/**
 * @param {string|string[]} path
 * @returns {string[]}
 */
function normalizePath(path) {
  if (Array.isArray(path))
    return path;

  return path
    .replace(ARRAY_INDEX_PATTERN, '.[$1]')
    .split(PROPERTY_PATH_SEPARATOR)
    .map((segment) => segment.replace(/^\[|\]$/g, ''))
    .filter((segment) => segment.length > 0);
}

/**
 * @param {any} object
 * @param {string[]} segments
 * @returns {any}
 */
function getNestedValue(object, segments) {
  let current = object;

  for (let i = 0; i < segments.length; i++) {
    if (current == null)
      return undefined;

    current = current[segments[i]];
  }

  return current;
}

/**
 * @param {any} object
 * @param {string[]} segments
 * @param {any} value
 * @returns {void}
 */
function setNestedValue(object, segments, value) {
  let current = object;

  for (let i = 0; i < segments.length - 1; i++) {
    let segment     = segments[i];
    let nextSegment = segments[i + 1];

    if (current[segment] == null) {
      let isArrayIndex = /^\d+$/.test(nextSegment);
      current[segment] = (isArrayIndex) ? [] : {};
    }

    current = current[segment];
  }

  let lastSegment = segments[segments.length - 1];
  current[lastSegment] = value;
}

/**
 * @param {any} object
 * @param {string[]} segments
 * @returns {boolean}
 */
function deleteNestedValue(object, segments) {
  let current = object;

  for (let i = 0; i < segments.length - 1; i++) {
    if (current == null)
      return false;

    let segment = segments[i];
    if (!Object.prototype.hasOwnProperty.call(current, segment))
      return false;

    current = current[segment];
  }

  let lastSegment = segments[segments.length - 1];
  if (!Object.prototype.hasOwnProperty.call(current, lastSegment))
    return false;

  delete current[lastSegment];
  return true;
}

/**
 * @implements {import('../types').CascadingContext}
 */
export class CascadingContext {
  /**
   * @param {Record<string, any>} [data]
   * @param {CascadingContext} [parent]
   */
  constructor(data, parent) {
    /** @type {Record<string, any>} */
    if (parent instanceof CascadingContext)
      this._data = Object.create(parent._data);
    else
      this._data = Object.create(null);

    /** @type {CascadingContext|null} */
    this._parent   = (parent instanceof CascadingContext) ? parent : null;
    /** @type {CascadingContext[]} */
    this._children = [];

    if (data && typeof data === 'object') {
      let keys = Object.keys(data);
      for (let i = 0; i < keys.length; i++) {
        let key = keys[i];
        this._data[key] = data[key];
      }
    }

    if (this._parent)
      this._parent._children.push(this);
  }

  /**
   * Get a property value. Walks the prototype chain (inherited values).
   * @param {string} path
   * @returns {any}
   */
  getProperty(path) {
    if (!path)
      return undefined;

    let segments = normalizePath(path);

    if (segments.length === 1)
      return this._data[segments[0]];

    return getNestedValue(this._data, segments);
  }

  /**
   * Set a property value on THIS layer only (own property).
   * @param {string} path
   * @param {any} value
   * @returns {void}
   */
  setProperty(path, value) {
    if (!path)
      return;

    let segments = normalizePath(path);

    if (segments.length === 1) {
      this._data[segments[0]] = value;
      return;
    }

    let firstSegment = segments[0];

    if (!Object.prototype.hasOwnProperty.call(this._data, firstSegment)) {
      let inherited = this._data[firstSegment];
      if (inherited && typeof inherited === 'object')
        this._data[firstSegment] = Object.assign({}, inherited);
      else
        this._data[firstSegment] = {};
    }

    setNestedValue(this._data, segments, value);
  }

  /**
   * Check if a property exists (including inherited).
   * @param {string} path
   * @returns {boolean}
   */
  hasProperty(path) {
    return this.getProperty(path) !== undefined;
  }

  /**
   * Check if a property is an own property (not inherited).
   * @param {string} path
   * @returns {boolean}
   */
  hasOwnProperty(path) {
    if (!path)
      return false;

    let segments = normalizePath(path);

    if (segments.length === 1)
      return Object.prototype.hasOwnProperty.call(this._data, segments[0]);

    let current = this._data;
    for (let i = 0; i < segments.length; i++) {
      if (!Object.prototype.hasOwnProperty.call(current, segments[i]))
        return false;

      current = current[segments[i]];
    }

    return true;
  }

  /**
   * Delete an own property. Does not affect parent layers.
   * @param {string} path
   * @returns {boolean}
   */
  deleteProperty(path) {
    if (!path)
      return false;

    let segments = normalizePath(path);

    if (segments.length === 1) {
      if (!Object.prototype.hasOwnProperty.call(this._data, segments[0]))
        return false;

      delete this._data[segments[0]];
      return true;
    }

    return deleteNestedValue(this._data, segments);
  }

  /**
   * Create a child context that inherits from this one.
   * @param {Record<string, any>} [data]
   * @returns {CascadingContext}
   */
  createChild(data) {
    return new CascadingContext(data, this);
  }

  /**
   * Get all own keys (not inherited).
   * @returns {string[]}
   */
  getOwnKeys() {
    return Object.keys(this._data);
  }

  /**
   * Get all keys (including inherited).
   * @returns {string[]}
   */
  getAllKeys() {
    let keys = new Set();
    let current = this._data;

    while (current) {
      for (let key of Object.getOwnPropertyNames(current))
        keys.add(key);

      current = Object.getPrototypeOf(current);
    }

    return Array.from(keys);
  }

  /**
   * @returns {CascadingContext|null}
   */
  getParent() {
    return this._parent;
  }

  /**
   * @returns {CascadingContext[]}
   */
  getChildren() {
    return this._children.slice();
  }

  /**
   * @param {CascadingContext} child
   * @returns {void}
   */
  removeChild(child) {
    let index = this._children.indexOf(child);
    if (index >= 0)
      this._children.splice(index, 1);
  }

  /**
   * Detach this context from its parent.
   * @returns {void}
   */
  detach() {
    if (this._parent)
      this._parent.removeChild(this);

    this._parent = null;
  }

  /**
   * Snapshot own properties as a plain object.
   * @returns {Record<string, any>}
   */
  toJSON() {
    let result = {};
    let keys   = Object.keys(this._data);

    for (let i = 0; i < keys.length; i++) {
      let key = keys[i];
      result[key] = this._data[key];
    }

    return result;
  }
}

/**
 * @param {Record<string, any>} [data]
 * @param {CascadingContext} [parent]
 * @returns {CascadingContext}
 */
export function createContext(data, parent) {
  return new CascadingContext(data, parent);
}
