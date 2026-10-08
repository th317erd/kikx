'use strict';

// Shim correctness: custom-element reactions and attribute normalization must
// match the browser closely enough that component teardown/startup is actually
// exercised by specs that manipulate the DOM through normal APIs.

import assert from 'node:assert/strict';
import test from 'node:test';

import { installDom } from './support/mini-dom.mjs';

const { document, registry: customElements } = installDom();

class NestedParent extends HTMLElement {
  constructor() {
    super();
    this.connects = 0;
    this.disconnects = 0;
  }

  connectedCallback() {
    this.connects += 1;
  }

  disconnectedCallback() {
    this.disconnects += 1;
  }
}
customElements.define('nested-parent', NestedParent);

class NestedChild extends HTMLElement {
  constructor() {
    super();
    this.connects = 0;
    this.disconnects = 0;
  }

  connectedCallback() {
    this.connects += 1;
  }

  disconnectedCallback() {
    this.disconnects += 1;
  }
}
customElements.define('nested-child', NestedChild);

function buildNested() {
  let root = document.createElement('div');
  let parent = document.createElement('nested-parent');
  let child = document.createElement('nested-child');
  parent.appendChild(child);
  root.appendChild(parent);
  return { root, parent, child };
}

test('removing a subtree fires disconnectedCallback for nested custom elements', () => {
  let { root, parent, child } = buildNested();

  root.removeChild(parent);

  assert.equal(parent.disconnects, 1);
  assert.equal(child.disconnects, 1, 'nested child teardown must fire');
});

test('re-inserting a subtree re-fires connectedCallback for nested custom elements', () => {
  let { root, parent, child } = buildNested();
  root.removeChild(parent);

  root.appendChild(parent);

  assert.equal(child.connects, 2, 'nested child startup must fire again');
  assert.equal(child.disconnects, 1);
});

test('replaceChildren fires teardown for the whole replaced subtree', () => {
  let { root, parent, child } = buildNested();

  root.replaceChildren();

  assert.equal(parent.disconnects, 1);
  assert.equal(child.disconnects, 1);
});

test('setting innerHTML fires teardown for the removed subtree', () => {
  let { root, parent, child } = buildNested();

  root.innerHTML = '<span>fresh</span>';

  assert.equal(parent.disconnects, 1);
  assert.equal(child.disconnects, 1);
});

test('setting textContent fires teardown for the removed subtree', () => {
  let { root, parent } = buildNested();

  root.textContent = 'plain';

  assert.equal(parent.disconnects, 1);
});

test('data-* attribute names are lowercased in both directions', () => {
  let element = document.createElement('div');
  element.setAttribute('data-Frame-Type', 'ToolFrame');

  assert.equal(element.getAttribute('data-frame-type'), 'ToolFrame');
  assert.equal(element.dataset.frameType, 'ToolFrame');

  element.dataset.otherKey = 'value';
  assert.equal(element.getAttribute('data-other-key'), 'value');

  element.removeAttribute('data-Frame-Type');
  assert.equal(element.hasAttribute('data-frame-type'), false);
});

test('non-data attribute names keep their case (SVG viewBox)', () => {
  let element = document.createElement('svg');
  element.setAttribute('viewBox', '0 0 10 10');

  assert.equal(element.getAttribute('viewBox'), '0 0 10 10');
});

test('unsupported attribute-selector operators fail loud instead of silently matching', () => {
  let root = document.createElement('div');
  root.appendChild(document.createElement('span'));

  assert.throws(() => root.querySelector('[data-frame-type$="ToolFrame"]'), /unsupported attribute operator/);
  assert.throws(() => root.querySelector('[class^="kikx"]'), /unsupported attribute operator/);
  assert.throws(() => root.querySelector('[class*="kikx"]'), /unsupported attribute operator/);
  assert.ok(root.querySelector('span'), 'supported selectors still work');
});
