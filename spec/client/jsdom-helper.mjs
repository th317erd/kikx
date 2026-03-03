'use strict';

// JSDOM setup helper for client component tests.
// Provides a realistic browser environment with CustomEvent, customElements,
// HTMLElement, localStorage, history API, etc.

import { JSDOM } from 'jsdom';

let dom    = null;
let window = null;

export function setupDOM(options = {}) {
  let url = options.url || 'http://localhost:8089/kikx/';

  dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url,
    pretendToBeVisual: true,
  });

  window = dom.window;

  // Patch globals that modules expect.
  // Some properties (navigator) are read-only getters on globalThis in Node 24+,
  // so we use Object.defineProperty with configurable: true for all of them.
  let globals = {
    window,
    document:       window.document,
    HTMLElement:     window.HTMLElement,
    CustomEvent:    window.CustomEvent,
    customElements: window.customElements,
    localStorage:   window.localStorage,
    history:        window.history,
    location:       window.location,
    Event:          window.Event,
    navigator:      window.navigator,
  };

  for (let [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, {
      value,
      writable:     true,
      configurable: true,
    });
  }

  return { dom, window };
}

export function teardownDOM() {
  if (dom) {
    dom.window.close();
    dom = null;
  }

  delete globalThis.window;
  delete globalThis.document;
  delete globalThis.HTMLElement;
  delete globalThis.CustomEvent;
  delete globalThis.customElements;
  delete globalThis.localStorage;
  delete globalThis.history;
  delete globalThis.location;
  delete globalThis.Event;
  delete globalThis.navigator;

  window = null;
}

export function getDocument() {
  return globalThis.document;
}

export function getWindow() {
  return globalThis.window;
}
