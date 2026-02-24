'use strict';

import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// ---------------------------------------------------------------------------
// Bootstrap a minimal DOM environment using jsdom so the module under test
// has access to Node, document, etc. at import time.
// ---------------------------------------------------------------------------

const DOM = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost',
});

globalThis.window   = DOM.window;
globalThis.document = DOM.window.document;
globalThis.Node     = DOM.window.Node;
globalThis.Element  = DOM.window.Element;
globalThis.Document = DOM.window.Document;

// Dynamic import happens AFTER globals are set so the module picks them up.
const { QueryEngine, $m, $$m } = await import('../../lib/query-engine.mjs');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDiv(id) {
  let element = document.createElement('div');
  if (id)
    element.id = id;
  return element;
}

function freshBody() {
  document.body.innerHTML = '';
  return document.body;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('query-engine', () => {

  // 1. $m(selector) selects elements from document
  describe('$m(selector)', () => {
    it('selects elements matching a CSS selector from document', () => {
      freshBody();
      let div = makeDiv('target');
      document.body.appendChild(div);

      let result = $m('#target');
      assert.equal(result.length, 1);
      assert.equal(result[0], div);
    });

    it('returns empty QueryEngine when selector matches nothing', () => {
      freshBody();
      let result = $m('.no-such-element');
      assert.equal(result.length, 0);
    });
  });

  // 2. $m(element) wraps a single element
  describe('$m(element)', () => {
    it('wraps a single DOM element', () => {
      let div    = makeDiv();
      let result = $m(div);
      assert.equal(result.length, 1);
      assert.equal(result[0], div);
    });
  });

  // 3. $m(array) wraps an array of elements
  describe('$m(array)', () => {
    it('wraps an array of DOM elements', () => {
      let a = makeDiv();
      let b = makeDiv();
      let c = makeDiv();

      let result = $m([ a, b, c ]);
      assert.equal(result.length, 3);
      assert.equal(result[0], a);
      assert.equal(result[1], b);
      assert.equal(result[2], c);
    });

    it('deduplicates elements in the array', () => {
      let div    = makeDiv();
      let result = $m([ div, div, div ]);
      assert.equal(result.length, 1);
    });
  });

  // 4. QueryEngine Proxy: integer index access returns elements
  describe('Proxy integer index access', () => {
    it('returns the correct element for numeric string indices', () => {
      let a = makeDiv();
      let b = makeDiv();
      let engine = $m([ a, b ]);

      assert.equal(engine[0], a);
      assert.equal(engine[1], b);
    });
  });

  // 5. QueryEngine.length returns element count
  describe('.length', () => {
    it('reflects the number of elements in the collection', () => {
      let engine = $m([ makeDiv(), makeDiv(), makeDiv() ]);
      assert.equal(engine.length, 3);
    });

    it('is 0 for an empty collection', () => {
      let engine = $m([]);
      assert.equal(engine.length, 0);
    });
  });

  // 6. Array delegation: forEach, map, filter work
  describe('Array method delegation', () => {
    it('forEach iterates every element', () => {
      let a = makeDiv();
      let b = makeDiv();
      let engine = $m([ a, b ]);

      let visited = [];
      engine.forEach((element) => visited.push(element));
      assert.deepEqual(visited, [ a, b ]);
    });

    it('map returns an array of transformed values (non-node results)', () => {
      let a = makeDiv();
      a.dataset.name = 'alpha';
      let b = makeDiv();
      b.dataset.name = 'beta';
      let engine = $m([ a, b ]);

      let names = engine.map((element) => element.dataset.name);
      assert.ok(Array.isArray(names), 'plain map should return a plain array');
      assert.deepEqual(names, [ 'alpha', 'beta' ]);
    });

    it('filter returns a QueryEngine when every result is a Node', () => {
      let a = makeDiv();
      let b = makeDiv();
      b.classList.add('keep');
      let engine = $m([ a, b ]);

      let filtered = engine.filter((element) => element.classList.contains('keep'));
      assert.ok(filtered instanceof QueryEngine, 'filter with Node results should return QueryEngine');
      assert.equal(filtered.length, 1);
      assert.equal(filtered[0], b);
    });
  });

  // 7. $-prefix methods ($map, $filter) return new QueryEngine instances
  describe('$-prefix array method coercion', () => {
    it('$map returns a QueryEngine (mapping to nodes)', () => {
      let a = makeDiv();
      let b = makeDiv();
      let engine = $m([ a, b ]);

      let result = engine.$map((element) => element);
      assert.ok(result instanceof QueryEngine, '$map should return a QueryEngine');
      assert.equal(result.length, 2);
    });

    it('$filter returns a QueryEngine even when result would be empty', () => {
      let engine = $m([ makeDiv() ]);
      let result = engine.$filter(() => false);
      assert.ok(result instanceof QueryEngine, '$filter should return a QueryEngine');
      assert.equal(result.length, 0);
    });

    it('$map coerces non-node results into QueryEngine', () => {
      // Even mapping to non-nodes should be coerced because of $ prefix
      let div    = makeDiv();
      let engine = $m([ div ]);

      // Maps to strings — $ prefix forces coercion (items get dropped since non-node)
      let result = engine.$map((element) => element);
      assert.ok(result instanceof QueryEngine);
    });
  });

  // 8. first(), last() return sub-selections
  describe('first() and last()', () => {
    let engine;
    let elements;

    beforeEach(() => {
      elements = [ makeDiv(), makeDiv(), makeDiv(), makeDiv(), makeDiv() ];
      engine   = $m(elements);
    });

    it('first() with no argument returns the first element', () => {
      let result = engine.first();
      assert.equal(result.length, 1);
      assert.equal(result[0], elements[0]);
    });

    it('first(3) returns the first 3 elements', () => {
      let result = engine.first(3);
      assert.equal(result.length, 3);
      assert.deepEqual(result.getUnderlyingArray(), elements.slice(0, 3));
    });

    it('last() with no argument returns the last element', () => {
      let result = engine.last();
      assert.equal(result.length, 1);
      assert.equal(result[0], elements[elements.length - 1]);
    });

    it('last(2) returns the last 2 elements', () => {
      let result = engine.last(2);
      assert.equal(result.length, 2);
      assert.deepEqual(result.getUnderlyingArray(), elements.slice(-2));
    });
  });

  // 9. add(), subtract() set operations
  describe('add() and subtract()', () => {
    it('add() merges another element into the collection', () => {
      let a = makeDiv();
      let b = makeDiv();
      let engine = $m([ a ]);

      let result = engine.add(b);
      assert.ok(result instanceof QueryEngine);
      assert.equal(result.length, 2);
      assert.ok(result.getUnderlyingArray().includes(b));
    });

    it('subtract() removes elements from the collection', () => {
      let a = makeDiv();
      let b = makeDiv();
      let c = makeDiv();
      let engine = $m([ a, b, c ]);

      let result = engine.subtract(b);
      assert.ok(result instanceof QueryEngine);
      assert.equal(result.length, 2);
      assert.ok(!result.getUnderlyingArray().includes(b));
    });
  });

  // 10. on(), off() event binding
  describe('on() and off()', () => {
    it('on() attaches an event listener that fires on dispatch', () => {
      freshBody();
      let div = makeDiv();
      document.body.appendChild(div);

      let fired   = false;
      let handler = () => { fired = true; };

      $m(div).on('click', handler);
      div.dispatchEvent(new DOM.window.Event('click'));

      assert.equal(fired, true);
    });

    it('off() removes the event listener so it no longer fires', () => {
      freshBody();
      let div = makeDiv();
      document.body.appendChild(div);

      let count   = 0;
      let handler = () => { count++; };

      let engine = $m(div);
      engine.on('click', handler);
      div.dispatchEvent(new DOM.window.Event('click'));
      assert.equal(count, 1);

      engine.off('click', handler);
      div.dispatchEvent(new DOM.window.Event('click'));
      assert.equal(count, 1, 'handler should not fire after off()');
    });
  });

  // 11. addClass(), removeClass(), toggleClass()
  describe('CSS class manipulation', () => {
    it('addClass() adds class names to elements', () => {
      let div = makeDiv();
      $m(div).addClass('foo', 'bar');
      assert.ok(div.classList.contains('foo'));
      assert.ok(div.classList.contains('bar'));
    });

    it('removeClass() removes class names from elements', () => {
      let div = makeDiv();
      div.classList.add('foo', 'bar');
      $m(div).removeClass('foo');
      assert.ok(!div.classList.contains('foo'));
      assert.ok(div.classList.contains('bar'));
    });

    it('toggleClass() toggles class names on elements', () => {
      let div = makeDiv();
      div.classList.add('active');
      $m(div).toggleClass('active');
      assert.ok(!div.classList.contains('active'));

      $m(div).toggleClass('active');
      assert.ok(div.classList.contains('active'));
    });
  });

  // 12. slotted(), slot() Shadow DOM helpers
  describe('slotted() and slot()', () => {
    // jsdom has limited Shadow DOM support; we test with a synthetic structure
    // using a custom element host so shadow root exists.
    it('slot() filters elements by their slot attribute', () => {
      let a = makeDiv();
      a.setAttribute('slot', 'header');
      let b = makeDiv();
      b.setAttribute('slot', 'footer');
      let c = makeDiv();

      let engine = $m([ a, b, c ]);
      let result = engine.slot('header');

      assert.equal(result.length, 1);
      assert.equal(result[0], a);
    });

    it('slotted() filters elements that are inside a <slot>', () => {
      freshBody();

      // Build a structure: div > slot > span
      let container = document.createElement('div');
      let slotEl    = document.createElement('slot');
      let span      = document.createElement('span');

      slotEl.appendChild(span);
      container.appendChild(slotEl);
      document.body.appendChild(container);

      let engine = $m([ span, container ]);
      let result = engine.slotted();

      // span is inside a slot; container is not
      assert.equal(result.length, 1);
      assert.equal(result[0], span);
    });
  });

  // 13. appendTo(), prependTo(), remove() DOM manipulation
  describe('DOM manipulation', () => {
    it('appendTo() moves elements into the target node', () => {
      freshBody();
      let parent = makeDiv();
      document.body.appendChild(parent);

      let child = makeDiv('child');
      $m([ child ]).appendTo(parent);

      assert.equal(parent.children.length, 1);
      assert.equal(parent.children[0], child);
    });

    it('prependTo() inserts elements before existing children', () => {
      freshBody();
      let parent    = makeDiv();
      let existing  = makeDiv('existing');
      parent.appendChild(existing);
      document.body.appendChild(parent);

      let newChild = makeDiv('new');
      $m([ newChild ]).prependTo(parent);

      assert.equal(parent.children[0], newChild);
      assert.equal(parent.children[1], existing);
    });

    it('remove() detaches elements from their parent', () => {
      freshBody();
      let parent = makeDiv();
      let child  = makeDiv();
      parent.appendChild(child);
      document.body.appendChild(parent);

      $m([ child ]).remove();

      assert.equal(parent.children.length, 0);
      assert.equal(child.parentNode, null);
    });

    it('appendTo() accepts a CSS selector string', () => {
      freshBody();
      let parent = makeDiv('parent-container');
      document.body.appendChild(parent);

      let child = makeDiv();
      $m([ child ]).appendTo('#parent-container');

      assert.equal(parent.children[0], child);
    });
  });

  // 14. Iterator protocol
  describe('Iterator protocol', () => {
    it('for...of iterates every element', () => {
      let a = makeDiv();
      let b = makeDiv();
      let c = makeDiv();
      let engine = $m([ a, b, c ]);

      let visited = [];
      for (let element of engine)
        visited.push(element);

      assert.deepEqual(visited, [ a, b, c ]);
    });

    it('entries() yields [index, element] pairs', () => {
      let a = makeDiv();
      let b = makeDiv();
      let engine = $m([ a, b ]);

      let pairs = [ ...engine.entries() ];
      assert.deepEqual(pairs, [ [ 0, a ], [ 1, b ] ]);
    });

    it('keys() yields numeric indices', () => {
      let engine = $m([ makeDiv(), makeDiv() ]);
      let keys   = [ ...engine.keys() ];
      assert.deepEqual(keys, [ 0, 1 ]);
    });

    it('values() yields the elements', () => {
      let a = makeDiv();
      let b = makeDiv();
      let engine = $m([ a, b ]);
      let values = [ ...engine.values() ];
      assert.deepEqual(values, [ a, b ]);
    });
  });

  // 15. isElement() static helper
  describe('QueryEngine.isElement()', () => {
    it('returns true for an Element node', () => {
      assert.equal(QueryEngine.isElement(makeDiv()), true);
    });

    it('returns true for document', () => {
      assert.equal(QueryEngine.isElement(document), true);
    });

    it('returns false for null', () => {
      assert.equal(QueryEngine.isElement(null), false);
    });

    it('returns false for a plain object', () => {
      assert.equal(QueryEngine.isElement({ nodeType: 1 }), false);
    });

    it('returns false for a string', () => {
      assert.equal(QueryEngine.isElement('div'), false);
    });
  });

  // 16. $$m reaches into shadow roots
  describe('$$m(hostElement, selectorOrElements)', () => {
    it('wraps elements using a shadow root as the context root', () => {
      freshBody();

      // jsdom supports attachShadow
      let host = document.createElement('div');
      document.body.appendChild(host);
      let shadow = host.attachShadow({ mode: 'open' });

      let inner = document.createElement('span');
      inner.className = 'shadow-child';
      shadow.appendChild(inner);

      let result = $$m(host, '.shadow-child');
      assert.equal(result.length, 1);
      assert.equal(result[0], inner);
    });

    it('wraps a direct element when passed to $$m', () => {
      freshBody();
      let host = document.createElement('div');
      document.body.appendChild(host);
      let shadow = host.attachShadow({ mode: 'open' });

      let inner = document.createElement('span');
      shadow.appendChild(inner);

      let result = $$m(host, [ inner ]);
      assert.equal(result.length, 1);
      assert.equal(result[0], inner);
    });
  });

  // Additional: instanceof check via Symbol.hasInstance
  describe('instanceof QueryEngine', () => {
    it('returns true for a QueryEngine instance', () => {
      let engine = $m([]);
      assert.ok(engine instanceof QueryEngine);
    });
  });

  // Additional: strings in array are converted to Text nodes
  describe('string-to-text-node coercion in filterAndConstructElements', () => {
    it('converts string items in the source array to Text nodes', () => {
      let engine = new QueryEngine([ 'hello world' ], { root: document });
      assert.equal(engine.length, 1);
      assert.equal(engine[0].nodeType, Node.TEXT_NODE);
      assert.equal(engine[0].textContent, 'hello world');
    });
  });

});
