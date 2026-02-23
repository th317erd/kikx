'use strict';

/**
 * Component Testing Helpers
 *
 * Utilities for testing Web Components in jsdom.
 * Handles component registration, mounting, and lifecycle.
 *
 * Usage:
 *   import { registerComponent, mountComponent, waitForRender } from './component-helpers.mjs';
 *
 *   // Register and mount
 *   const el = await mountComponent('hml-prompt', {
 *     id: 'test-prompt',
 *     type: 'radio',
 *   }, 'Question?<data>[{"value":"a","label":"A"}]</data>');
 *
 *   // Assert
 *   assert.ok(el.shadowRoot);
 */

import { getDocument, getWindow, wait } from './dom-helpers.mjs';

// Track registered components to avoid double-registration
const registeredComponents = new Set();

/**
 * Register a Web Component class.
 * Safe to call multiple times - will skip if already registered.
 *
 * @param {string} tagName - Custom element tag name
 * @param {typeof HTMLElement} ComponentClass - Component class
 */
export function registerComponent(tagName, ComponentClass) {
  const win = getWindow();

  if (registeredComponents.has(tagName)) {
    return; // Already registered
  }

  if (!win.customElements.get(tagName)) {
    win.customElements.define(tagName, ComponentClass);
  }

  registeredComponents.add(tagName);
}

/**
 * Create and mount a component with attributes and content.
 *
 * @param {string} tagName - Component tag name
 * @param {object} attrs - Attributes to set
 * @param {string} innerHTML - Inner HTML content
 * @returns {Promise<Element>} The mounted element
 */
export async function mountComponent(tagName, attrs = {}, innerHTML = '') {
  const doc = getDocument();

  // Create element
  const el = doc.createElement(tagName);

  // Set attributes
  for (const [key, value] of Object.entries(attrs)) {
    el.setAttribute(key, String(value));
  }

  // Set content
  if (innerHTML) {
    el.innerHTML = innerHTML;
  }

  // Mount to body
  doc.body.appendChild(el);

  // Wait for component to initialize
  await waitForRender();

  return el;
}

/**
 * Wait for component rendering to complete.
 * Uses multiple RAF cycles like the actual components do.
 *
 * @param {number} cycles - Number of RAF cycles to wait
 * @returns {Promise<void>}
 */
export async function waitForRender(cycles = 3) {
  for (let i = 0; i < cycles; i++) {
    await new Promise((resolve) => {
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(resolve);
      } else {
        setTimeout(resolve, 16);
      }
    });
  }
}

/**
 * Query an element's shadow DOM.
 *
 * @param {Element} el - Element with shadow root
 * @param {string} selector - CSS selector
 * @returns {Element|null}
 */
export function shadowQuery(el, selector) {
  if (!el.shadowRoot) return null;
  return el.shadowRoot.querySelector(selector);
}

/**
 * Query all matching elements in shadow DOM.
 *
 * @param {Element} el - Element with shadow root
 * @param {string} selector - CSS selector
 * @returns {NodeList}
 */
export function shadowQueryAll(el, selector) {
  if (!el.shadowRoot) return [];
  return el.shadowRoot.querySelectorAll(selector);
}

/**
 * Get the text content of a shadow DOM element.
 *
 * @param {Element} el - Element with shadow root
 * @param {string} selector - CSS selector
 * @returns {string|null}
 */
export function shadowText(el, selector) {
  const target = shadowQuery(el, selector);
  return target ? target.textContent.trim() : null;
}

/**
 * Simulate typing into an input element.
 *
 * @param {Element} input - Input element
 * @param {string} text - Text to type
 */
export function typeInto(input, text) {
  const win = getWindow();
  input.focus();
  input.value = text;
  input.dispatchEvent(new win.Event('input', { bubbles: true }));
  input.dispatchEvent(new win.Event('change', { bubbles: true }));
}

/**
 * Simulate pressing Enter on an element.
 *
 * @param {Element} el - Target element
 * @returns {KeyboardEvent}
 */
export function pressEnter(el) {
  const win = getWindow();
  const event = new win.KeyboardEvent('keydown', {
    key: 'Enter',
    code: 'Enter',
    keyCode: 13,
    which: 13,
    bubbles: true,
    cancelable: true,
  });
  el.dispatchEvent(event);
  return event;
}

/**
 * Simulate clicking an element.
 *
 * @param {Element} el - Target element
 * @returns {MouseEvent}
 */
export function click(el) {
  const win = getWindow();
  const event = new win.MouseEvent('click', {
    bubbles: true,
    cancelable: true,
    view: win,
  });
  el.dispatchEvent(event);
  return event;
}

/**
 * Wait for a custom event to be dispatched.
 *
 * @param {Element} el - Element to listen on
 * @param {string} eventName - Event name
 * @param {number} timeout - Timeout in ms
 * @returns {Promise<CustomEvent>}
 */
export function waitForEvent(el, eventName, timeout = 1000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout waiting for event: ${eventName}`));
    }, timeout);

    el.addEventListener(eventName, (event) => {
      clearTimeout(timer);
      resolve(event);
    }, { once: true });
  });
}

/**
 * Create a spy function that records calls.
 *
 * @returns {Function & { calls: any[][], callCount: number, reset: Function }}
 */
export function createSpy() {
  const calls = [];
  const spy = function(...args) {
    calls.push(args);
    return spy._returnValue;
  };
  spy.calls = calls;
  Object.defineProperty(spy, 'callCount', {
    get() { return calls.length; },
  });
  spy.reset = () => { calls.length = 0; };
  spy.returns = (value) => { spy._returnValue = value; return spy; };
  return spy;
}

/**
 * Clean up all mounted components.
 * Call in afterEach().
 */
export function cleanupComponents() {
  const doc = getDocument();
  doc.body.innerHTML = '';
}

/**
 * Reset component registry.
 * Call this if you need to re-register components with different implementations.
 */
export function resetRegistry() {
  registeredComponents.clear();
}

export default {
  registerComponent,
  mountComponent,
  waitForRender,
  shadowQuery,
  shadowQueryAll,
  shadowText,
  typeInto,
  pressEnter,
  click,
  waitForEvent,
  createSpy,
  cleanupComponents,
  resetRegistry,
};
