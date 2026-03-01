'use strict';

// =============================================================================
// Cascading Context
// =============================================================================
// Uses Object.create() prototype chain for layered config/state.
// Layers: plugin defaults -> org config -> session state -> runtime state.
// Child layers inherit from parent via prototype chain.
// =============================================================================

const PROPERTY_PATH_SEPARATOR = '.';
const ARRAY_INDEX_PATTERN     = /\[(\d+)\]/g;

function normalizePath(path) {
  if (Array.isArray(path))
    return path;

  // Convert 'foo.bar[0].baz' -> ['foo', 'bar', '0', 'baz']
  return path
    .replace(ARRAY_INDEX_PATTERN, '.[$1]')
    .split(PROPERTY_PATH_SEPARATOR)
    .map((segment) => segment.replace(/^\[|\]$/g, ''))
    .filter((segment) => segment.length > 0);
}

function getNestedValue(object, segments) {
  let current = object;

  for (let i = 0; i < segments.length; i++) {
    if (current == null)
      return undefined;

    current = current[segments[i]];
  }

  return current;
}

function setNestedValue(object, segments, value) {
  let current = object;

  for (let i = 0; i < segments.length - 1; i++) {
    let segment     = segments[i];
    let nextSegment = segments[i + 1];

    if (current[segment] == null) {
      // Create intermediate object or array based on next segment
      let isArrayIndex = /^\d+$/.test(nextSegment);
      current[segment] = (isArrayIndex) ? [] : {};
    }

    current = current[segment];
  }

  let lastSegment = segments[segments.length - 1];
  current[lastSegment] = value;
}

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

export class CascadingContext {
  constructor(data, parent) {
    // The actual data store. Child contexts use Object.create(parent._data)
    // so property lookups walk the prototype chain.
    if (parent instanceof CascadingContext)
      this._data = Object.create(parent._data);
    else
      this._data = Object.create(null);

    this._parent   = (parent instanceof CascadingContext) ? parent : null;
    this._children = [];

    // Copy initial data as own properties (not inherited)
    if (data && typeof data === 'object') {
      let keys = Object.keys(data);
      for (let i = 0; i < keys.length; i++) {
        let key = keys[i];
        this._data[key] = data[key];
      }
    }

    // Register with parent
    if (this._parent)
      this._parent._children.push(this);
  }

  // Get a property value. Walks the prototype chain (inherited values).
  getProperty(path) {
    if (!path)
      return undefined;

    let segments = normalizePath(path);

    if (segments.length === 1)
      return this._data[segments[0]];

    return getNestedValue(this._data, segments);
  }

  // Set a property value on THIS layer only (own property).
  setProperty(path, value) {
    if (!path)
      return;

    let segments = normalizePath(path);

    if (segments.length === 1) {
      this._data[segments[0]] = value;
      return;
    }

    // For nested paths, we need to ensure intermediate objects
    // are own properties so we don't mutate parent layers.
    let firstSegment = segments[0];

    // If the first-level value is inherited, create an own copy
    if (!Object.prototype.hasOwnProperty.call(this._data, firstSegment)) {
      let inherited = this._data[firstSegment];
      if (inherited && typeof inherited === 'object')
        this._data[firstSegment] = Object.assign({}, inherited);
      else
        this._data[firstSegment] = {};
    }

    setNestedValue(this._data, segments, value);
  }

  // Check if a property exists (including inherited).
  hasProperty(path) {
    return this.getProperty(path) !== undefined;
  }

  // Check if a property is an own property (not inherited).
  hasOwnProperty(path) {
    if (!path)
      return false;

    let segments = normalizePath(path);

    if (segments.length === 1)
      return Object.prototype.hasOwnProperty.call(this._data, segments[0]);

    // For nested paths, check each level is own
    let current = this._data;
    for (let i = 0; i < segments.length; i++) {
      if (!Object.prototype.hasOwnProperty.call(current, segments[i]))
        return false;

      current = current[segments[i]];
    }

    return true;
  }

  // Delete an own property. Does not affect parent layers.
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

  // Create a child context that inherits from this one.
  createChild(data) {
    return new CascadingContext(data, this);
  }

  // Get all own keys (not inherited).
  getOwnKeys() {
    return Object.keys(this._data);
  }

  // Get all keys (including inherited).
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

  // Get the parent context.
  getParent() {
    return this._parent;
  }

  // Get all child contexts.
  getChildren() {
    return this._children.slice();
  }

  // Remove a child context.
  removeChild(child) {
    let index = this._children.indexOf(child);
    if (index >= 0)
      this._children.splice(index, 1);
  }

  // Detach this context from its parent.
  detach() {
    if (this._parent)
      this._parent.removeChild(this);

    this._parent = null;
  }

  // Snapshot own properties as a plain object.
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

export function createContext(data, parent) {
  return new CascadingContext(data, parent);
}
