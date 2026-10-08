'use strict';

// Minimal, jsdom-free DOM used by client-component specs that must exercise
// real custom-element code under pure Node. It implements only the surface the
// components under test touch; it is deliberately not a general-purpose DOM.

import { parseHTMLInto, VOID_TAGS } from './mini-dom-html.mjs';
import { matchesSelector, queryAll } from './mini-dom-selectors.mjs';

class ClassList {
  constructor(element) {
    this._element = element;
  }

  add(...names) {
    for (let name of names.flat(Infinity)) {
      if (name)
        this._element._classes.add(String(name));
    }
  }

  remove(...names) {
    for (let name of names.flat(Infinity))
      this._element._classes.delete(String(name));
  }

  contains(name) {
    return this._element._classes.has(String(name));
  }

  toggle(name, force) {
    let shouldAdd = force === undefined ? !this.contains(name) : force === true;
    if (shouldAdd)
      this.add(name);
    else
      this.remove(name);
    return shouldAdd;
  }

  get value() {
    return [ ...this._element._classes ].join(' ');
  }
}

function datasetKeyToAttribute(key) {
  return `data-${String(key).replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)}`;
}

function attributeToDatasetKey(name) {
  return name.slice(5).replace(/-([a-z])/g, (_match, char) => char.toUpperCase());
}

// Real HTML lowercases `data-*` attribute names, so `setAttribute('data-Foo', )`
// and `dataset.foo` address the same attribute. Other attributes keep their case
// (SVG `viewBox`, ARIA names) -- only the data family is normalized.
function normalizeAttributeName(name) {
  let key = String(name);
  return key.length >= 5 && key.slice(0, 5).toLowerCase() === 'data-' ? key.toLowerCase() : key;
}

// Custom-element reactions bubble through the whole inserted/removed subtree in
// the real DOM (tree order, root first). The shim must do the same or nested
// component teardown/startup is never exercised.
function connectSubtree(node) {
  if (node.nodeType === 1 && typeof node.connectedCallback === 'function' && node._connected !== true) {
    node._connected = true;
    node.connectedCallback();
  }

  for (let child of node.childNodes || [])
    connectSubtree(child);
}

function disconnectSubtree(node) {
  if (node.nodeType === 1 && typeof node.disconnectedCallback === 'function' && node._connected === true) {
    node._connected = false;
    node.disconnectedCallback();
  }

  for (let child of node.childNodes || [])
    disconnectSubtree(child);
}

export class MiniNode {
  constructor(nodeType, nodeName) {
    this.nodeType = nodeType;
    this.nodeName = nodeName;
    this.parentNode = null;
  }

  cloneNode(deep = false) {
    let clone;
    if (this.nodeType === 11) {
      clone = this.ownerDocument.createDocumentFragment();
    } else if (this.nodeType === 3) {
      clone = new MiniText(this._text);
    } else if (this.nodeType === 1) {
      clone = this.ownerDocument.createElement(this.localName);
      for (let [ name, value ] of this._attributes)
        clone.setAttribute(name, value);
    } else {
      clone = new MiniNode(this.nodeType, this.nodeName);
      clone.childNodes = [];
    }

    clone.ownerDocument = this.ownerDocument;
    if (deep && this.childNodes) {
      for (let child of this.childNodes)
        clone.appendChild(child.cloneNode(true));
    }
    return clone;
  }

  remove() {
    if (this.parentNode)
      this.parentNode.removeChild(this);
  }

  contains(node) {
    for (let current = node; current; current = current.parentNode) {
      if (current === this)
        return true;
    }
    return false;
  }
}

export class MiniText extends MiniNode {
  constructor(text = '') {
    super(3, '#text');
    this._text = String(text ?? '');
  }

  get textContent() {
    return this._text;
  }

  set textContent(value) {
    this._text = String(value ?? '');
  }

  get nodeValue() {
    return this._text;
  }
}

export class MiniElement extends MiniNode {
  constructor(tagName = '') {
    let resolved = new.target.__tagName || tagName;
    let name = String(resolved || '');
    // Browser semantics: HTML elements expose an UPPERCASE tagName/nodeName
    // and a lowercase localName. Specs must rely on the same casing as Chrome.
    super(1, name.toUpperCase());
    this.tagName = name.toUpperCase();
    this.localName = name.toLowerCase();
    this.childNodes = [];
    this._classes = new Set();
    this._attributes = new Map();
    this._listeners = new Map();
    // `dataset` is a live view over the `data-*` attributes (both directions),
    // matching the browser: `element.dataset.frameId = 'x'` sets
    // `data-frame-id`, and `setAttribute('data-frame-id', 'x')` is readable as
    // `element.dataset.frameId`.
    this.dataset = new Proxy({}, {
      get: (_target, key) => {
        if (typeof key !== 'string')
          return undefined;
        let value = this.getAttribute(datasetKeyToAttribute(key));
        return value === null ? undefined : value;
      },
      set: (_target, key, value) => {
        this.setAttribute(datasetKeyToAttribute(key), value);
        return true;
      },
      has: (_target, key) => typeof key === 'string' && this.hasAttribute(datasetKeyToAttribute(key)),
      deleteProperty: (_target, key) => {
        this.removeAttribute(datasetKeyToAttribute(key));
        return true;
      },
      ownKeys: () => {
        let keys = [];
        for (let [ name ] of this._attributes) {
          if (name.startsWith('data-'))
            keys.push(attributeToDatasetKey(name));
        }
        return keys;
      },
      getOwnPropertyDescriptor: (_target, key) => {
        if (typeof key !== 'string')
          return undefined;
        let value = this.getAttribute(datasetKeyToAttribute(key));
        if (value === null)
          return undefined;
        return { value, writable: true, enumerable: true, configurable: true };
      },
    });
  }

  get className() {
    return [ ...this._classes ].join(' ');
  }

  set className(value) {
    let names = String(value ?? '').split(/\s+/).filter(Boolean);
    this._classes = new Set(names);
    this._attributes.set('class', names.join(' '));
  }

  get classList() {
    if (!this._classList)
      this._classList = new ClassList(this);
    return this._classList;
  }

  get attributes() {
    let result = [];
    for (let [ name, value ] of this._attributes)
      result.push({ name, value });
    return result;
  }

  // Only <template> exposes `.content`; it holds the parsed DOM separately
  // from the template element itself, matching browsers.
  get content() {
    if (this.localName !== 'template')
      return undefined;
    if (!this._contentFragment)
      this._contentFragment = this.ownerDocument.createDocumentFragment();
    return this._contentFragment;
  }

  get children() {
    return this.childNodes.filter((node) => node.nodeType === 1);
  }

  get firstChild() {
    return this.childNodes[0] || null;
  }

  get lastChild() {
    return this.childNodes[this.childNodes.length - 1] || null;
  }

  get firstElementChild() {
    return this.children[0] || null;
  }

  get nextElementSibling() {
    if (!this.parentNode)
      return null;
    let siblings = this.parentNode.children;
    let index = siblings.indexOf(this);
    return index >= 0 ? siblings[index + 1] || null : null;
  }

  get isConnected() {
    return Boolean(this.parentNode);
  }

  setAttribute(name, value) {
    let key = normalizeAttributeName(name);
    if (key === 'class')
      this.className = value;
    else
      this._attributes.set(key, String(value));
  }

  getAttribute(name) {
    let key = normalizeAttributeName(name);
    if (key === 'class')
      return this._classes.size > 0 ? this.className : null;
    return this._attributes.has(key) ? this._attributes.get(key) : null;
  }

  hasAttribute(name) {
    if (normalizeAttributeName(name) === 'class')
      return this._classes.size > 0;
    return this._attributes.has(normalizeAttributeName(name));
  }

  removeAttribute(name) {
    let key = normalizeAttributeName(name);
    if (key === 'class') {
      this._classes = new Set();
      this._attributes.delete('class');
      return;
    }
    this._attributes.delete(key);
  }

  appendChild(node) {
    if (!node)
      return node;

    if (node.nodeType === 11) {
      for (let child of [ ...node.childNodes ])
        this.appendChild(child);
      return node;
    }

    if (node.parentNode)
      node.parentNode.removeChild(node);

    node.parentNode = this;
    this.childNodes.push(node);

    connectSubtree(node);

    return node;
  }

  append(...nodes) {
    for (let node of nodes)
      this.appendChild(node);
  }

  insertBefore(node, reference) {
    // Browser semantics: pre-insert rewrites a referenceChild that IS the node
    // to the node's next sibling, so inserting a node before itself is a no-op.
    // Modelling that here keeps reconciliation callers from tearing a node out
    // and re-appending it (which would fire disconnect/connect on real custom
    // elements) when the order is already correct.
    if (node === reference)
      return node;

    if (!reference)
      return this.appendChild(node);

    if (node.nodeType === 11) {
      for (let child of [ ...node.childNodes ])
        this.insertBefore(child, reference);
      return node;
    }

    if (node.parentNode)
      node.parentNode.removeChild(node);

    let index = this.childNodes.indexOf(reference);
    node.parentNode = this;
    if (index >= 0)
      this.childNodes.splice(index, 0, node);
    else
      this.childNodes.push(node);

    connectSubtree(node);

    return node;
  }

  removeChild(node) {
    let index = this.childNodes.indexOf(node);
    if (index >= 0) {
      this.childNodes.splice(index, 1);
      node.parentNode = null;
      disconnectSubtree(node);
    }
    return node;
  }

  // Replaces every child with the given nodes (strings become text nodes, like
  // the real DOM). The client uses this to swap a rebuilt thread body in place.
  replaceChildren(...nodes) {
    for (let child of [ ...this.childNodes ])
      this.removeChild(child);

    for (let node of nodes)
      this.appendChild(typeof node === 'string' ? new MiniText(node) : node);
  }

  get textContent() {
    let text = '';
    for (let child of this.childNodes)
      text += child.textContent;
    return text;
  }

  set textContent(value) {
    for (let child of [ ...this.childNodes ])
      this.removeChild(child);
    if (value !== undefined && value !== null && String(value) !== '')
      this.appendChild(new MiniText(value));
  }

  get innerHTML() {
    let root = this.localName === 'template' ? this.content : this;
    return root.childNodes.map(serializeNode).join('');
  }

  set innerHTML(html) {
    let root = this.localName === 'template' ? this.content : this;
    for (let child of [ ...root.childNodes ])
      root.removeChild(child);
    parseHTMLInto(this.ownerDocument, root, String(html ?? ''));
  }

  querySelectorAll(selector) {
    return queryAll(this, selector);
  }

  querySelector(selector) {
    return queryAll(this, selector)[0] || null;
  }

  matches(selector) {
    let compounds = String(selector).trim().split(/\s+/).filter(Boolean);
    return compounds.length > 0 && matchesSelector(this, compounds);
  }

  addEventListener(type, listener) {
    let list = this._listeners.get(type);
    if (!list) {
      list = [];
      this._listeners.set(type, list);
    }
    list.push(listener);
  }

  removeEventListener(type, listener) {
    let list = this._listeners.get(type);
    if (!list)
      return;
    let index = list.indexOf(listener);
    if (index >= 0)
      list.splice(index, 1);
  }

  listenerCount(type) {
    return (this._listeners.get(type) || []).length;
  }

  dispatchEvent(event) {
    // `target`/`currentTarget` are read-only accessors on the platform Event, so
    // assign our own shadowing properties instead of writing to them.
    Object.defineProperty(event, 'target', {
      configurable: true,
      value: this,
    });

    // Track propagation so a listener's stopPropagation() halts the bubble walk.
    // The platform method keeps its own internal flag we cannot read back.
    let stopped = false;
    let defaultPrevented = false;
    let platformStop = typeof event.stopPropagation === 'function' ? event.stopPropagation : null;
    Object.defineProperty(event, 'stopPropagation', {
      configurable: true,
      writable: true,
      value: () => {
        stopped = true;
        platformStop?.call(event);
      },
    });

    // Model cancellation so dispatchEvent() can return false the way the DOM
    // does; preventDefault only cancels a cancelable event.
    Object.defineProperty(event, 'defaultPrevented', {
      configurable: true,
      get: () => defaultPrevented,
    });
    if (typeof event.preventDefault === 'function') {
      let platformPreventDefault = event.preventDefault;
      Object.defineProperty(event, 'preventDefault', {
        configurable: true,
        writable: true,
        value: () => {
          if (event.cancelable === true)
            defaultPrevented = true;
          platformPreventDefault?.call(event);
        },
      });
    }

    let path = [];
    for (let node = this; node; node = node.parentNode)
      path.push(node);

    for (let current of path) {
      Object.defineProperty(event, 'currentTarget', {
        configurable: true,
        value: current,
      });
      for (let listener of current._listeners.get(event.type) || [])
        listener.call(current, event);
      if (stopped)
        break;
      // Real DOM defaults `bubbles` to false, so anything not explicitly true
      // must not bubble.
      if (!event.bubbles)
        break;
    }

    return !event.defaultPrevented;
  }
}

function serializeNode(node) {
  if (node.nodeType === 3)
    return node.textContent;

  // innerHTML serialization lowercases HTML tag names, matching browsers.
  let tag = node.localName || String(node.tagName || '').toLowerCase();
  let attributes = '';
  for (let [ name, value ] of node._attributes) {
    if (name === 'class')
      continue;
    attributes += ` ${name}="${value}"`;
  }
  if (node.className)
    attributes += ` class="${node.className}"`;
  if (VOID_TAGS.has(tag))
    return `<${tag}${attributes}>`;
  return `<${tag}${attributes}>${node.childNodes.map(serializeNode).join('')}</${tag}>`;
}

export class MiniDocument extends MiniNode {
  constructor(registry) {
    super(9, '#document');
    this.childNodes = [];
    this.registry = registry;
  }

  createElement(tagName) {
    let name = String(tagName).toLowerCase();
    let ctor = this.registry.get(name);
    if (ctor) {
      let element = new ctor();
      element.ownerDocument = this;
      return element;
    }
    let element = new MiniElement(name);
    element.ownerDocument = this;
    return element;
  }

  createElementNS(_namespace, tagName) {
    return this.createElement(tagName);
  }

  createTextNode(text) {
    let node = new MiniText(text);
    node.ownerDocument = this;
    return node;
  }

  createDocumentFragment() {
    let fragment = new MiniNode(11, '#document-fragment');
    fragment.childNodes = [];
    fragment.appendChild = MiniElement.prototype.appendChild;
    fragment.append = MiniElement.prototype.append;
    fragment.insertBefore = MiniElement.prototype.insertBefore;
    fragment.removeChild = MiniElement.prototype.removeChild;
    fragment.ownerDocument = this;
    return fragment;
  }

  querySelectorAll(selector) {
    return queryAll(this, selector);
  }

  querySelector(selector) {
    return queryAll(this, selector)[0] || null;
  }

  get body() {
    if (!this._body)
      this._body = this.createElement('body');
    return this._body;
  }
}

// A minimal `window` event target so client code can install and tear down
// process-level listeners (`window.onerror`, `unhandledrejection`) under Node.
// Browsers expose this on globalThis; the shim keeps it as a distinct object so
// a spec can assert that a listener was actually removed.
export class MiniWindow {
  constructor() {
    this.onerror = null;
    this._listeners = new Map();
  }

  addEventListener(type, listener) {
    let bucket = this._listeners.get(type);
    if (!bucket) {
      bucket = [];
      this._listeners.set(type, bucket);
    }
    bucket.push(listener);
  }

  removeEventListener(type, listener) {
    let bucket = this._listeners.get(type);
    if (!bucket)
      return;
    let index = bucket.indexOf(listener);
    if (index >= 0)
      bucket.splice(index, 1);
  }

  dispatchEvent(event) {
    for (let listener of [ ...(this._listeners.get(event.type) || []) ])
      listener(event);
  }

  listenerCount(type) {
    return (this._listeners.get(type) || []).length;
  }
}

class CustomElementRegistry {
  constructor() {
    this._byName = new Map();
  }

  define(name, constructor) {
    let key = String(name).toLowerCase();
    if (this._byName.has(key))
      return;
    constructor.__tagName = key;
    this._byName.set(key, constructor);
  }

  get(name) {
    return this._byName.get(String(name).toLowerCase());
  }

  whenDefined(name) {
    return Promise.resolve(this.get(name));
  }
}

const installed = { registry: null, document: null, window: null };

export function installDom() {
  if (installed.registry)
    return installed;

  let registry = new CustomElementRegistry();
  let document = new MiniDocument(registry);
  installed.registry = registry;
  installed.document = document;
  installed.window = new MiniWindow();

  globalThis.HTMLElement = MiniElement;
  globalThis.document = document;
  globalThis.window = installed.window;
  globalThis.customElements = registry;

  if (typeof globalThis.CustomEvent === 'undefined') {
    globalThis.CustomEvent = class CustomEvent {
      constructor(type, init = {}) {
        this.type = type;
        Object.assign(this, init);
      }
    };
  }

  return installed;
}
