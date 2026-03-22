'use strict';

// =============================================================================
// Unit tests for <kikx-message-content> WebComponent
// =============================================================================

import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  createElement,
  connectElement,
  disconnectElement,
  clearBody,
} from '../helpers/jsdom-setup.mjs';

before(async () => {
  await import('../../../src/client/components/kikx-message-content/kikx-message-content.mjs');
});

beforeEach(() => {
  clearBody();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeElement(content) {
  let el = createElement('kikx-message-content');
  if (content !== undefined)
    el.content = content;
  return el;
}

// =============================================================================
// 1. Basic content rendering
// =============================================================================

describe('kikx-message-content — basic rendering', { timeout: 5000 }, () => {

  it('renders HTML content into .message-body after connect', () => {
    let el = makeElement('<p>Hello world</p>');
    connectElement(el);

    let body = el.querySelector('.message-body');
    assert.ok(body, 'message-body should exist');
    assert.ok(body.innerHTML.includes('Hello world'));
  });

  it('renders empty content as empty message body', () => {
    let el = makeElement('');
    connectElement(el);

    let body = el.querySelector('.message-body');
    assert.equal(body.innerHTML, '');
  });

  it('content property stores value before connect', () => {
    let el = makeElement('<p>Stored</p>');
    assert.equal(el.content, '<p>Stored</p>');
  });

  it('renders backed content on connect', () => {
    let el = makeElement('<p>Deferred</p>');
    connectElement(el);

    let body = el.querySelector('.message-body');
    assert.ok(body.innerHTML.includes('Deferred'));
  });

  it('updates content after connect', () => {
    let el = makeElement('<p>Initial</p>');
    connectElement(el);

    el.content = '<p>Updated</p>';
    let body = el.querySelector('.message-body');
    assert.ok(body.innerHTML.includes('Updated'));
    assert.ok(!body.innerHTML.includes('Initial'));
  });

  it('reads content attribute on connect when no content property set', () => {
    let el = createElement('kikx-message-content');
    el.setAttribute('content', '<p>From attribute</p>');
    connectElement(el);

    let body = el.querySelector('.message-body');
    assert.ok(body.innerHTML.includes('From attribute'));
  });
});

// =============================================================================
// 2. Sanitization
// =============================================================================

describe('kikx-message-content — sanitization', { timeout: 5000 }, () => {

  it('strips <script> tags from content', () => {
    let el = makeElement('<p>Safe</p><script>alert("xss")</script>');
    connectElement(el);

    let body = el.querySelector('.message-body');
    assert.equal(body.querySelectorAll('script').length, 0);
    assert.ok(body.innerHTML.includes('Safe'));
  });

  it('strips <iframe> tags from content', () => {
    let el = makeElement('<iframe src="http://evil.com"></iframe><p>OK</p>');
    connectElement(el);

    let body = el.querySelector('.message-body');
    assert.equal(body.querySelectorAll('iframe').length, 0);
    assert.ok(body.innerHTML.includes('OK'));
  });

  it('strips event handler attributes', () => {
    let el = makeElement('<p onclick="alert(1)">Click</p>');
    connectElement(el);

    let p = el.querySelector('.message-body p');
    assert.equal(p.getAttribute('onclick'), null);
  });

  it('strips javascript: URIs from href', () => {
    let el = makeElement('<a href="javascript:alert(1)">Link</a>');
    connectElement(el);

    let a = el.querySelector('.message-body a');
    if (a) {
      let href = a.getAttribute('href') || '';
      assert.ok(!href.includes('javascript:'), 'javascript: should be removed');
    }
  });

  it('strips <form> and <input> tags', () => {
    let el = makeElement('<form><input type="text"></form><p>After</p>');
    connectElement(el);

    let body = el.querySelector('.message-body');
    assert.equal(body.querySelectorAll('form').length, 0);
    assert.equal(body.querySelectorAll('input').length, 0);
  });

  it('adds target="_blank" and rel="noopener noreferrer" to links', () => {
    let el = makeElement('<a href="https://example.com">Example</a>');
    connectElement(el);

    let a = el.querySelector('.message-body a');
    assert.ok(a, 'link should exist');
    assert.equal(a.getAttribute('target'), '_blank');
    assert.equal(a.getAttribute('rel'), 'noopener noreferrer');
  });

  it('preserves safe HTML elements (p, strong, em, code, pre)', () => {
    let html = '<p><strong>Bold</strong> and <em>italic</em> with <code>code</code></p>';
    let el = makeElement(html);
    connectElement(el);

    let body = el.querySelector('.message-body');
    assert.ok(body.querySelector('strong'), 'strong should survive');
    assert.ok(body.querySelector('em'), 'em should survive');
    assert.ok(body.querySelector('code'), 'code should survive');
  });
});

// =============================================================================
// 3. Edge cases
// =============================================================================

describe('kikx-message-content — edge cases', { timeout: 5000 }, () => {

  it('setting content to null coerces to empty string', () => {
    let el = makeElement('<p>Initial</p>');
    connectElement(el);

    el.content = null;
    assert.equal(el.content, '');
  });

  it('setting content to undefined coerces to empty string', () => {
    let el = makeElement('<p>Initial</p>');
    connectElement(el);

    el.content = undefined;
    assert.equal(el.content, '');
  });

  it('setting content to a number coerces to string', () => {
    let el = makeElement('');
    connectElement(el);

    el.content = 42;
    assert.equal(el.content, '42');
  });

  it('handles very long content without throwing', () => {
    let longContent = '<p>' + 'A'.repeat(100000) + '</p>';
    let el = makeElement(longContent);
    connectElement(el);

    let body = el.querySelector('.message-body');
    assert.ok(body.innerHTML.length > 0, 'should render long content');
  });

  it('handles nested HTML structures', () => {
    let html = '<div><ul><li>Item 1</li><li>Item 2</li></ul><blockquote>Quote</blockquote></div>';
    let el = makeElement(html);
    connectElement(el);

    let body = el.querySelector('.message-body');
    assert.ok(body.querySelectorAll('li').length >= 2);
    assert.ok(body.querySelector('blockquote'));
  });

  it('re-connect re-renders content', () => {
    let el = makeElement('<p>Connect me</p>');
    connectElement(el);
    disconnectElement(el);

    el.content = '<p>Reconnected</p>';
    connectElement(el);

    let body = el.querySelector('.message-body');
    assert.ok(body.innerHTML.includes('Reconnected'));
  });

  it('strips <style> tags from content (defense-in-depth)', () => {
    let el = makeElement('<style>body{display:none}</style><p>Visible</p>');
    connectElement(el);

    let body = el.querySelector('.message-body');
    assert.equal(body.querySelectorAll('style').length, 0);
    assert.ok(body.innerHTML.includes('Visible'));
  });

  it('strips <meta> and <link> tags from content', () => {
    let el = makeElement('<meta charset="utf-8"><link rel="stylesheet" href="x"><p>OK</p>');
    connectElement(el);

    let body = el.querySelector('.message-body');
    assert.equal(body.querySelectorAll('meta').length, 0);
    assert.equal(body.querySelectorAll('link').length, 0);
  });

  it('strips onload attribute from img tags', () => {
    let el = makeElement('<img src="x.png" onload="alert(1)">');
    connectElement(el);

    let img = el.querySelector('.message-body img');
    if (img) {
      assert.equal(img.getAttribute('onload'), null);
    }
  });
});
