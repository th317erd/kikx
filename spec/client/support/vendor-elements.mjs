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

function buildElement(tagName, attributes, children, ownerDocument, events = [], bindings = [], providedState = undefined) {
  let element = ownerDocument.createElement(tagName);
  for (let [ name, value ] of Object.entries(attributes)) {
    if (name === 'class')
      element.className = value;
    else
      element.setAttribute(domAttributeName(name), '' + value);
  }

  // Per-attribute state bindings (`.class.bindState(cb, keys)`), mirroring
  // elements.js:410. Nothing subscribes here -- there is no ReactiveState in a
  // spec process -- so the callback is evaluated once against the state it is
  // given, which is enough to assert *which* state a control reads. The
  // teardown callback is registered on the element so cleanupBindings() finds
  // it exactly as it does in the browser.
  for (let binding of bindings) {
    let state = providedState;
    if (state === undefined)
      continue;

    let apply = () => {
      let value = binding.callback(state);
      if (binding.attribute === null) {
        if (value === null || value === undefined)
          return;

        if (typeof value === 'object' && !Array.isArray(value)) {
          for (let [ name, attributeValue ] of Object.entries(value)) {
            if (attributeValue === null || attributeValue === undefined || attributeValue === false)
              delete attributes[name];
            else
              attributes[name] = attributeValue;
          }
        }

        return;
      }

      if (value === null || value === undefined || value === false)
        delete attributes[binding.attribute];
      else
        attributes[binding.attribute] = value;
    };

    apply();

    if (typeof state.on === 'function')
      binding.teardown = () => state.off?.('*', apply), state.on('*', apply);
  }

  for (let child of children)
    appendChildValue(element, child, ownerDocument);

  for (let entry of events)
    element.addEventListener(entry.eventName, (event) => entry.handler(event));

  if (bindings.length > 0)
    element.__bindings = bindings.map((binding) => () => binding.teardown?.());

  return element;
}

function createBuilder(tagName) {
  let attributes = {};
  let children = [];
  let bindings = [];
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
        return (ownerDocument, state) => buildElement(tagName, attributes, children, ownerDocument, events, bindings, state);

      // `bindState` is read off the builder root for a whole-element binding, and
      // off an attribute accessor for a per-attribute one. Both return the
      // builder, not a state consumer (elements.js:378-386, 406-414) -- that is
      // what lets `.class.bindState(cb, keys)()` terminate a child chain.
      if (property === 'bindState') {
        return (callback, filters) => {
          bindings.push({ attribute: null, callback, filters });
          return proxy;
        };
      }

      // `on*` chains are event handlers, not attributes (elements.js:389-395).
      // This branch must come before the attribute accessor, or `.onClick(fn)`
      // is recorded as an inert `onclick="<function>"` attribute and every
      // click-based assertion silently observes zero calls.
      if (typeof property === 'string' && /^on[A-Z]/.test(property)) {
        let eventName = property.charAt(2).toLowerCase() + property.slice(3);
        return (handler) => {
          if (typeof handler === 'function')
            events.push({ eventName, handler });
          return proxy;
        };
      }

      // An attribute accessor: `.class('x')` sets the attribute, while
      // `.class.bindState(cb, keys)` binds it.
      let attribute = property;

      return new Proxy(
        (value) => {
          if (value === true)
            attributes[attribute] = '';
          else if (value === null || value === undefined || value === false)
            delete attributes[attribute];
          else
            attributes[attribute] = value;
          return proxy;
        },
        {
          get: (_target, propertyName) => {
            if (typeof propertyName === 'symbol')
              return undefined;

            if (propertyName === 'bindState') {
              return (callback, filters) => {
                bindings.push({ attribute, callback, filters });
                return proxy;
              };
            }

            return proxy[propertyName];
          },
        },
      );
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

// Stand-in for the framework's own teardown walk (elements.js cleanupBindings).
// Ported from the real implementation rather than simplified, so a component
// spec exercises the same contract the browser will: descend into descendants
// AND shadow roots, guard against cycles, and clear each node's slot *before*
// running its callbacks so a throw cannot leave a half-torn-down subtree
// subscribed. A simplified stub here would let a broken walk pass the suite.
function walkBindableNodes(root, visit, seen = new Set()) {
  if (!root || typeof root !== 'object' || seen.has(root))
    return;

  seen.add(root);
  visit(root);

  if (typeof root.querySelectorAll === 'function') {
    for (let node of root.querySelectorAll('*'))
      walkBindableNodes(node, visit, seen);
  }

  if (root.shadowRoot)
    walkBindableNodes(root.shadowRoot, visit, seen);
}

function runNodeCleanups(node, slot) {
  let callbacks = node[slot];
  if (!Array.isArray(callbacks) || callbacks.length === 0)
    return 0;

  node[slot] = [];

  let count = 0;
  let failure = null;

  for (let callback of callbacks) {
    if (typeof callback !== 'function')
      continue;

    count++;

    try {
      callback();
    } catch (error) {
      if (!failure) failure = error;
    }
  }

  if (failure) throw failure;
  return count;
}

export function cleanupBindings(root) {
  if (!root || typeof root !== 'object')
    return 0;

  let count = 0;
  let failure = null;

  walkBindableNodes(root, (node) => {
    try {
      count += runNodeCleanups(node, '__bindings');
    } catch (error) {
      if (!failure) failure = error;
    }
  });

  if (failure) throw failure;
  return count;
}

export function disposeBindings(root) {
  if (!root || typeof root !== 'object')
    return 0;

  let count = 0;
  let failure = null;

  walkBindableNodes(root, (node) => {
    for (let slot of [ '__bindings', '__disposers' ]) {
      try {
        count += runNodeCleanups(node, slot);
      } catch (error) {
        if (!failure) failure = error;
      }
    }
  });

  if (failure) throw failure;
  return count;
}
