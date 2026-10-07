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
    this.dataset = {};
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
    let key = String(name);
    if (key === 'class')
      this.className = value;
    else
      this._attributes.set(key, String(value));
  }

  getAttribute(name) {
    let key = String(name);
    if (key === 'class')
      return this._classes.size > 0 ? this.className : null;
    return this._attributes.has(key) ? this._attributes.get(key) : null;
  }

  hasAttribute(name) {
    if (String(name) === 'class')
      return this._classes.size > 0;
    return this._attributes.has(String(name));
  }

  removeAttribute(name) {
    let key = String(name);
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

    if (typeof node.connectedCallback === 'function' && node._connected !== true) {
      node._connected = true;
      node.connectedCallback();
    }

    return node;
  }

  append(...nodes) {
    for (let node of nodes)
      this.appendChild(node);
  }

  insertBefore(node, reference) {
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

    if (typeof node.connectedCallback === 'function' && node._connected !== true) {
      node._connected = true;
      node.connectedCallback();
    }

    return node;
  }

  removeChild(node) {
    let index = this.childNodes.indexOf(node);
    if (index >= 0) {
      this.childNodes.splice(index, 1);
      node.parentNode = null;
      if (typeof node.disconnectedCallback === 'function' && node._connected === true) {
        node._connected = false;
        node.disconnectedCallback();
      }
    }
    return node;
  }

  get textContent() {
    let text = '';
    for (let child of this.childNodes)
      text += child.textContent;
    return text;
  }

  set textContent(value) {
    this.childNodes = [];
    if (value !== undefined && value !== null && String(value) !== '')
      this.appendChild(new MiniText(value));
  }

  get innerHTML() {
    let root = this.localName === 'template' ? this.content : this;
    return root.childNodes.map(serializeNode).join('');
  }

  set innerHTML(html) {
    let root = this.localName === 'template' ? this.content : this;
    root.childNodes = [];
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

const installed = { registry: null, document: null };

export function installDom() {
  if (installed.registry)
    return installed;

  let registry = new CustomElementRegistry();
  let document = new MiniDocument(registry);
  installed.registry = registry;
  installed.document = document;

  globalThis.HTMLElement = MiniElement;
  globalThis.document = document;
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
