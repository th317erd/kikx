'use strict';

import { JSDOM } from 'jsdom';

// Create a jsdom instance with custom elements support
let dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost',
  pretendToBeVisual: true,
});

let window = dom.window;

// Expose browser globals that components expect.
// Use Object.defineProperty for properties that may be read-only getters
// in newer Node versions (e.g., navigator).
let globals = {
  window,
  document:         window.document,
  HTMLElement:       window.HTMLElement,
  customElements:   window.customElements,
  CustomEvent:      window.CustomEvent,
  Event:            window.Event,
  MutationObserver: window.MutationObserver,
  DocumentFragment: window.DocumentFragment,
  navigator:        window.navigator,
  localStorage:     window.localStorage,
  sessionStorage:   window.sessionStorage,
  history:          window.history,
  location:         window.location,
};

for (let [key, value] of Object.entries(globals)) {
  Object.defineProperty(globalThis, key, {
    value,
    writable:     true,
    configurable: true,
  });
}

// CSSStyleSheet may not be available in jsdom — provide a stub
if (!globalThis.CSSStyleSheet) {
  globalThis.CSSStyleSheet = class CSSStyleSheet {};
}

// Mock IntersectionObserver (jsdom doesn't support it)
if (!globalThis.IntersectionObserver) {
  globalThis.IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// Mock ResizeObserver
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// Helper: create element without connecting
export function createElement(tagName) {
  return document.createElement(tagName);
}

// Helper: connect element to DOM
export function connectElement(element) {
  document.body.appendChild(element);
  return element;
}

// Helper: disconnect element from DOM
export function disconnectElement(element) {
  if (element.parentNode)
    element.parentNode.removeChild(element);
}

// Helper: cleanup body
export function clearBody() {
  while (document.body.firstChild)
    document.body.removeChild(document.body.firstChild);
}

// Mock t() function — returns the key (or interpolates simple params)
export function mockT(key, params) {
  if (!params)
    return key;

  let result = key;
  for (let [k, v] of Object.entries(params))
    result = result.replace(`{${k}}`, String(v));

  return result;
}

export { dom, window };
