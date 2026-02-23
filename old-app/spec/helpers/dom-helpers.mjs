'use strict';

/**
 * DOM Testing Helpers using jsdom
 *
 * Provides a browser-like environment for testing Web Components,
 * DOM manipulation, and UI logic without a real browser.
 *
 * Usage:
 *   import { createDOM, destroyDOM, getDocument, getWindow } from './dom-helpers.mjs';
 *
 *   beforeEach(() => createDOM());
 *   afterEach(() => destroyDOM());
 *
 *   it('should render', () => {
 *     const doc = getDocument();
 *     const el = doc.createElement('div');
 *     // ...
 *   });
 */

import { JSDOM } from 'jsdom';

let dom = null;

/**
 * Create a fresh jsdom environment.
 * Call this in beforeEach() for test isolation.
 *
 * @param {string} html - Initial HTML (default: minimal document)
 * @returns {JSDOM} The jsdom instance
 */
export function createDOM(html = '<!DOCTYPE html><html><head></head><body></body></html>') {
  dom = new JSDOM(html, {
    url: 'http://localhost/',
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
  });

  // Expose globals that components expect
  global.window = dom.window;
  global.document = dom.window.document;
  global.HTMLElement = dom.window.HTMLElement;
  global.customElements = dom.window.customElements;
  global.CustomEvent = dom.window.CustomEvent;
  global.Event = dom.window.Event;
  global.Node = dom.window.Node;
  global.NodeList = dom.window.NodeList;
  global.Element = dom.window.Element;
  global.DocumentFragment = dom.window.DocumentFragment;
  global.MutationObserver = dom.window.MutationObserver;
  global.requestAnimationFrame = (cb) => setTimeout(cb, 16);
  global.cancelAnimationFrame = (id) => clearTimeout(id);

  // Mock localStorage
  global.localStorage = {
    _data: {},
    getItem(key) { return this._data[key] || null; },
    setItem(key, value) { this._data[key] = String(value); },
    removeItem(key) { delete this._data[key]; },
    clear() { this._data = {}; },
  };

  return dom;
}

/**
 * Destroy the jsdom environment.
 * Call this in afterEach() for cleanup.
 */
export function destroyDOM() {
  if (dom) {
    dom.window.close();
    dom = null;
  }

  // Clean up globals
  delete global.window;
  delete global.document;
  delete global.HTMLElement;
  delete global.customElements;
  delete global.CustomEvent;
  delete global.Event;
  delete global.Node;
  delete global.NodeList;
  delete global.Element;
  delete global.DocumentFragment;
  delete global.MutationObserver;
  delete global.requestAnimationFrame;
  delete global.cancelAnimationFrame;
  delete global.localStorage;
}

/**
 * Get the current document.
 * @returns {Document}
 */
export function getDocument() {
  if (!dom) throw new Error('DOM not initialized. Call createDOM() first.');
  return dom.window.document;
}

/**
 * Get the current window.
 * @returns {Window}
 */
export function getWindow() {
  if (!dom) throw new Error('DOM not initialized. Call createDOM() first.');
  return dom.window;
}

/**
 * Create an element and optionally set attributes/content.
 *
 * @param {string} tag - Tag name
 * @param {object} attrs - Attributes to set
 * @param {string} content - Inner HTML
 * @returns {Element}
 */
export function createElement(tag, attrs = {}, content = '') {
  const doc = getDocument();
  const el = doc.createElement(tag);

  for (const [key, value] of Object.entries(attrs)) {
    el.setAttribute(key, value);
  }

  if (content) {
    el.innerHTML = content;
  }

  return el;
}

/**
 * Mount an element to the document body.
 *
 * @param {Element} el - Element to mount
 * @returns {Element} The mounted element
 */
export function mount(el) {
  const doc = getDocument();
  doc.body.appendChild(el);
  return el;
}

/**
 * Wait for a number of animation frames.
 * Useful for testing code that uses requestAnimationFrame.
 *
 * @param {number} frames - Number of frames to wait
 * @returns {Promise<void>}
 */
export function waitFrames(frames = 1) {
  return new Promise((resolve) => {
    let remaining = frames;
    function tick() {
      remaining--;
      if (remaining <= 0) {
        resolve();
      } else {
        requestAnimationFrame(tick);
      }
    }
    requestAnimationFrame(tick);
  });
}

/**
 * Wait for a specified time.
 *
 * @param {number} ms - Milliseconds to wait
 * @returns {Promise<void>}
 */
export function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Trigger a DOM event on an element.
 *
 * @param {Element} el - Target element
 * @param {string} eventType - Event type (e.g., 'click', 'keydown')
 * @param {object} options - Event options
 * @returns {Event} The dispatched event
 */
export function triggerEvent(el, eventType, options = {}) {
  const win = getWindow();
  const event = new win.Event(eventType, { bubbles: true, cancelable: true, ...options });
  Object.assign(event, options);
  el.dispatchEvent(event);
  return event;
}

/**
 * Trigger a keyboard event.
 *
 * @param {Element} el - Target element
 * @param {string} eventType - 'keydown', 'keyup', 'keypress'
 * @param {string} key - Key value (e.g., 'Enter', 'a')
 * @param {object} options - Additional options
 * @returns {KeyboardEvent}
 */
export function triggerKeyEvent(el, eventType, key, options = {}) {
  const win = getWindow();
  const event = new win.KeyboardEvent(eventType, {
    key,
    bubbles: true,
    cancelable: true,
    ...options,
  });
  el.dispatchEvent(event);
  return event;
}

export default {
  createDOM,
  destroyDOM,
  getDocument,
  getWindow,
  createElement,
  mount,
  waitFrames,
  wait,
  triggerEvent,
  triggerKeyEvent,
};
