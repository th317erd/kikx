'use strict';

import {
  MYTHIX_TYPE,
  QUERY_ENGINE_TYPE,
} from './constants.mjs';

import {
  isType,
  isPlainObject,
} from './base-utilities.mjs';

const IS_INTEGER = /^\d+$/;

function isElement(value) {
  if (!value || typeof value !== 'object')
    return false;

  // Reject plain objects that happen to have a nodeType property
  if (typeof value.querySelector !== 'function' && typeof value.appendChild !== 'function')
    return false;

  // We have an Element, Document, or DocumentFragment
  if (
    value.nodeType === Node.ELEMENT_NODE ||
    value.nodeType === Node.DOCUMENT_NODE ||
    value.nodeType === Node.DOCUMENT_FRAGMENT_NODE
  )
    return true;

  return false;
}

function isSlotted(element) {
  if (!element)
    return null;

  return element.closest('slot');
}

function isNotSlotted(element) {
  if (!element)
    return null;

  return !element.closest('slot');
}

function collectClassNames(...args) {
  let classNames = [].concat(...args)
    .flat(Infinity)
    .map((part) => ('' + part).split(/\s+/))
    .flat(Infinity)
    .filter(Boolean);

  return classNames;
}

export class QueryEngine {
  static [Symbol.hasInstance](instance) {
    try {
      return (instance && instance[MYTHIX_TYPE] === QUERY_ENGINE_TYPE);
    } catch (error) {
      return false;
    }
  }

  static isElement    = isElement;
  static isSlotted    = isSlotted;
  static isNotSlotted = isNotSlotted;

  static from(...args) {
    // Called with no arguments — return empty engine rooted at this or document
    if (args.length === 0)
      return new QueryEngine([], { root: isElement(this) ? this : document, context: this });

    let argIndex = 0;

    const getOptions = () => {
      let base = Object.create(null);
      if (isPlainObject(args[argIndex]))
        base = Object.assign(base, args[argIndex++]);

      if (args[argIndex] instanceof QueryEngine)
        base = Object.assign(Object.create(null), args[argIndex].getOptions() || {}, base);

      return base;
    };

    const getRootElement = (optionsRoot) => {
      if (isElement(optionsRoot))
        return optionsRoot;

      if (isElement(this))
        return this;

      return ((this && this.ownerDocument) || document);
    };

    let options     = getOptions();
    let root        = getRootElement(options.root);
    let queryEngine;

    options.root    = root;
    options.context = options.context || this;

    // Already a QueryEngine — clone it
    if (args[argIndex] instanceof QueryEngine)
      return new QueryEngine(args[argIndex].slice(), options);

    // Array of elements
    if (Array.isArray(args[argIndex])) {
      queryEngine = new QueryEngine(args[argIndex], options);
    } else if (isType(args[argIndex], '::String')) {
      // CSS selector string
      options.selector = args[argIndex++];
      queryEngine = new QueryEngine(root.querySelectorAll(options.selector), options);
    } else if (isElement(args[argIndex])) {
      // Single DOM node
      queryEngine = new QueryEngine([ args[argIndex] ], options);
    } else {
      // Fallback: empty engine
      queryEngine = new QueryEngine([], options);
    }

    return queryEngine;
  }

  getEngineClass() {
    return QueryEngine;
  }

  constructor(elements, _options) {
    let options = _options || {};

    Object.defineProperties(this, {
      [MYTHIX_TYPE]: {
        writable:     true,
        enumerable:   false,
        configurable: true,
        value:        QUERY_ENGINE_TYPE,
      },
      '_mythixUIOptions': {
        writable:     false,
        enumerable:   false,
        configurable: false,
        value:        options,
      },
    });

    Object.defineProperties(this, {
      '_mythixUIElements': {
        writable:     false,
        enumerable:   false,
        configurable: false,
        value:        this.filterAndConstructElements(elements),
      },
    });

    let rootProxy = new Proxy(this, {
      get: (target, propName) => {
        if (typeof propName === 'symbol') {
          if (propName in target)
            return target[propName];
          else if (propName in target._mythixUIElements)
            return target._mythixUIElements[propName];

          return;
        }

        if (propName === 'length')
          return target._mythixUIElements.length;

        if (propName === 'prototype')
          return target.prototype;

        if (propName === 'constructor')
          return target.constructor;

        // Integer index access — return element directly
        if (IS_INTEGER.test(propName))
          return target._mythixUIElements[propName];

        if (propName in target)
          return target[propName];

        // Delegate to Array.prototype methods.
        // Names prefixed with "$" always coerce the result into a new QueryEngine.
        // Non-prefixed names coerce only when every item in the result is a Node or QueryEngine.
        let magicPropName = (propName.charAt(0) === '$') ? propName.substring(1) : propName;
        if (typeof Array.prototype[magicPropName] === 'function') {
          return (...methodArgs) => {
            let array  = target._mythixUIElements;
            let result = array[magicPropName](...methodArgs);

            const isDollarPrefixed = (magicPropName !== propName);
            if (
              Array.isArray(result) &&
              (isDollarPrefixed || result.every((item) => isType(item, Node) || item instanceof QueryEngine))
            ) {
              const EngineClass = target.getEngineClass();
              return new EngineClass(result, target.getOptions());
            }

            return result;
          };
        }

        return target[propName];
      },
    });

    return rootProxy;
  }

  getOptions() {
    return this._mythixUIOptions;
  }

  getContext() {
    let options = this.getOptions();
    return options.context;
  }

  getRoot() {
    let options = this.getOptions();
    return options.root || document;
  }

  getUnderlyingArray() {
    return this._mythixUIElements;
  }

  getOwnerDocument() {
    return this.getRoot().ownerDocument || document;
  }

  // Filters the provided elements array, keeping only DOM Nodes and QueryEngine
  // instances (which are flattened into the collection). Strings are converted
  // to Text nodes. Everything else is dropped.
  filterAndConstructElements(elements) {
    let ownerDocument = this.getOwnerDocument();

    let finalElements = Array.from(elements).flat(Infinity).map((item) => {
      if (!item)
        return;

      // Flatten nested QueryEngines
      if (item instanceof QueryEngine)
        return item.getUnderlyingArray();

      // Keep DOM nodes as-is
      if (isType(item, Node))
        return item;

      // Convert plain strings to Text nodes
      if (isType(item, '::String'))
        return ownerDocument.createTextNode(item);

      // Drop anything else (ElementDefinition, etc. — not yet supported here)
      return;
    }).flat(Infinity).filter(Boolean);

    return Array.from(new Set(finalElements));
  }

  // Re-selects within the current engine's context/root. Accepts the same
  // argument forms as QueryEngine.from().
  select(...args) {
    let argIndex = 0;
    let options  = Object.assign(
      Object.create(null),
      this.getOptions(),
      isPlainObject(args[argIndex]) ? args[argIndex++] : {},
    );

    const EngineClass = this.getEngineClass();
    return EngineClass.from.call(options.root || this, options, ...args.slice(argIndex));
  }

  *entries() {
    let elements = this._mythixUIElements;

    for (let index = 0, length = elements.length; index < length; index++) {
      yield [ index, elements[index] ];
    }
  }

  *keys() {
    for (let [ key ] of this.entries())
      yield key;
  }

  *values() {
    for (let [ , value ] of this.entries())
      yield value;
  }

  *[Symbol.iterator]() {
    return yield *this.values();
  }

  // Returns a QueryEngine containing only the first element, or the first
  // `count` elements when count is a valid positive number.
  first(count) {
    if (count == null || count === 0 || Object.is(count, NaN) || !isType(count, '::Number'))
      return this.select([ this._mythixUIElements[0] ]);

    return this.select(this._mythixUIElements.slice(0, Math.abs(count)));
  }

  // Returns a QueryEngine containing only the last element, or the last
  // `count` elements when count is a valid positive number.
  last(count) {
    if (count == null || count === 0 || Object.is(count, NaN) || !isType(count, '::Number'))
      return this.select([ this._mythixUIElements[this._mythixUIElements.length - 1] ]);

    return this.select(this._mythixUIElements.slice(Math.abs(count) * -1));
  }

  // Returns a new QueryEngine that is the union of this collection and the
  // provided elements (arrays, QueryEngines, or individual nodes).
  add(...elements) {
    const EngineClass = this.getEngineClass();
    return new EngineClass(this.slice().concat(...elements), this.getOptions());
  }

  // Returns a new QueryEngine with the provided elements removed from this
  // collection.
  subtract(...elements) {
    let elementSet = new Set(elements);

    const EngineClass = this.getEngineClass();
    return new EngineClass(
      this.filter((item) => !elementSet.has(item)),
      this.getOptions(),
    );
  }

  on(eventName, callback, options) {
    for (let element of this.values()) {
      if (!isElement(element))
        continue;

      element.addEventListener(eventName, callback, options);
    }

    return this;
  }

  off(eventName, callback, options) {
    for (let element of this.values()) {
      if (!isElement(element))
        continue;

      element.removeEventListener(eventName, callback, options);
    }

    return this;
  }

  appendTo(selectorOrElement) {
    if (!this._mythixUIElements.length)
      return this;

    let element = selectorOrElement;
    if (isType(selectorOrElement, '::String'))
      element = this.getRoot().querySelector(selectorOrElement);

    for (let child of this._mythixUIElements)
      element.appendChild(child);

    return this;
  }

  prependTo(selectorOrElement) {
    if (!this._mythixUIElements.length)
      return this;

    let element = selectorOrElement;
    if (isType(selectorOrElement, '::String'))
      element = this.getRoot().querySelector(selectorOrElement);

    let firstChild = element.childNodes[0] || null;
    for (let child of this._mythixUIElements)
      element.insertBefore(child, firstChild);

    return this;
  }

  insertInto(selectorOrElement, referenceNode) {
    if (!this._mythixUIElements.length)
      return this;

    let element = selectorOrElement;
    if (isType(selectorOrElement, '::String'))
      element = this.getRoot().querySelector(selectorOrElement);

    let ownerDocument = this.getOwnerDocument();

    let source;
    if (this._mythixUIElements.length > 1) {
      let fragment = ownerDocument.createDocumentFragment();
      for (let child of this._mythixUIElements)
        fragment.appendChild(child);

      source = fragment;
    } else {
      source = this._mythixUIElements[0];
    }

    element.insertBefore(source, referenceNode || null);

    return this;
  }

  replaceChildrenOf(selectorOrElement) {
    let element = selectorOrElement;
    if (isType(selectorOrElement, '::String'))
      element = this.getRoot().querySelector(selectorOrElement);

    while (element.childNodes.length)
      element.removeChild(element.childNodes[0]);

    return this.appendTo(element);
  }

  remove() {
    for (let node of this._mythixUIElements) {
      if (node && node.parentNode)
        node.parentNode.removeChild(node);
    }

    return this;
  }

  classList(operation, ...args) {
    let classNames = collectClassNames(args);

    for (let node of this._mythixUIElements) {
      if (node && node.classList) {
        if (operation === 'toggle')
          classNames.forEach((className) => node.classList.toggle(className));
        else
          node.classList[operation](...classNames);
      }
    }

    return this;
  }

  addClass(...classNames) {
    return this.classList('add', ...classNames);
  }

  removeClass(...classNames) {
    return this.classList('remove', ...classNames);
  }

  toggleClass(...classNames) {
    return this.classList('toggle', ...classNames);
  }

  // Returns only elements that are inside a <slot> element (or all elements
  // when yesNo is omitted or true; inverse when yesNo is false).
  slotted(yesNo) {
    return this.filter((arguments.length === 0 || yesNo) ? isSlotted : isNotSlotted);
  }

  // Returns only elements whose `slot` attribute equals slotName, or that are
  // nested inside a <slot name="slotName"> element.
  slot(slotName) {
    return this.filter((element) => {
      if (element && element.slot === slotName)
        return true;

      if (element && element.closest(`slot[name="${slotName.replace(/"/g, '\\"')}"]`))
        return true;

      return false;
    });
  }
}

// ---------------------------------------------------------------------------
// Convenience wrappers
// ---------------------------------------------------------------------------

// $m(selector) — select elements from the global document.
// $m(element)  — wrap one or more existing DOM nodes.
// $m(array)    — wrap an array of DOM nodes.
export function $m(selectorOrElements, options) {
  let root = (options && options.root) || document;
  return QueryEngine.from.call(root, options || {}, selectorOrElements);
}

// $$m(hostElement, selectorOrElements) — operate within a host element.
// Previously pierced shadow roots; now components use light DOM, so this
// simply scopes queries to the host element itself.
export function $$m(hostElement, selectorOrElements) {
  return QueryEngine.from.call(hostElement, {}, selectorOrElements);
}
