'use strict';

// Stand-in for /vendor/aeor-web-components/elements.js — the declarative element
// builder used by src/client components. Only the subset the specs exercise is
// implemented, but the call/attr chaining semantics match the real module.

const BUILDERS = new WeakSet();

function appendChildValue(element, value, ownerDocument) {
  if (BUILDERS.has(value)) {
    element.appendChild(value.build(ownerDocument));
    return;
  }

  if (value && typeof value === 'object' && typeof value.nodeType === 'number') {
    element.appendChild(value);
    return;
  }

  element.appendChild(ownerDocument.createTextNode(String(value)));
}

// The real builder kebab-cases camelCase attribute names before setting them
// (elements.js:160: `name.replace(/([A-Z])/g, '-$1').toLowerCase()`), so
// `.ariaLabel('x')` lands as `aria-label`, which is what assistive tech reads.
// This stub used to set the raw name, so `ariaLabel` became an attribute no
// browser would interpret -- specs asserting on accessibility silently passed
// against markup that did not have the label at all.
function domAttributeName(name) {
  if (name === 'class')
    return 'class';
  return name.replace(/([A-Z])/g, '-$1').toLowerCase();
}

function buildElement(tagName, attributes, children, ownerDocument, events = []) {
  let element = ownerDocument.createElement(tagName);
  for (let [ name, value ] of Object.entries(attributes)) {
    if (name === 'class')
      element.className = value;
    else
      element.setAttribute(domAttributeName(name), '' + value);
  }

  for (let child of children)
    appendChildValue(element, child, ownerDocument);

  for (let entry of events)
    element.addEventListener(entry.eventName, (event) => entry.handler(event));

  return element;
}

function createBuilder(tagName) {
  let attributes = {};
  let children = [];
  // `on*` chains are event handlers, not attributes. The real module attaches
  // them with addEventListener (elements.js:189-194), so the stand-in must too
  // or a click-based spec silently never fires its handler.
  let events = [];

  function finalize(...values) {
    for (let value of values.flat(Infinity)) {
      if (value === null || value === undefined || typeof value === 'symbol')
        continue;
      children.push(value);
    }
    return proxy;
  }

  let proxy = new Proxy(finalize, {
    get(_target, property) {
      if (typeof property === 'symbol')
        return undefined;

      if (property === 'build')
        return (ownerDocument) => buildElement(tagName, attributes, children, ownerDocument, events);

      // Lowercase only the first letter after "on": .onClick -> 'click',
      // .onKeydown -> 'keydown' (never 'keyDown').
      if (typeof property === 'string' && /^on[A-Z]/.test(property)) {
        let eventName = property.charAt(2).toLowerCase() + property.slice(3);
        return (handler) => {
          if (typeof handler === 'function')
            events.push({ eventName, handler });
          return proxy;
        };
      }

      return (value) => {
        if (value === true)
          attributes[property] = '';
        else if (value === null || value === undefined || value === false)
          delete attributes[property];
        else
          attributes[property] = value;
        return proxy;
      };
    },
    apply(_target, _thisArg, args) {
      return finalize(...args);
    },
  });

  BUILDERS.add(proxy);
  return proxy;
}

// Mirrors the real module: destructuring `elements` must not bind one shared
// builder. Every tag access/apply produces a fresh builder.
function createTagProxy(tagName) {
  return new Proxy(function () {}, {
    get(_target, property) {
      if (typeof property === 'symbol')
        return undefined;
      return createBuilder(tagName)[property];
    },
    apply(_target, _thisArg, args) {
      return createBuilder(tagName)(...args);
    },
  });
}

export const elements = new Proxy({}, {
  get(_target, tagName) {
    if (typeof tagName === 'symbol')
      return undefined;
    return createTagProxy(tagName);
  },
});

export function isVoidTag(tagName) {
  return [ 'br', 'hr', 'img', 'input', 'link', 'meta' ].includes(String(tagName).toLowerCase());
}

export function isSVGElement() {
  return false;
}
