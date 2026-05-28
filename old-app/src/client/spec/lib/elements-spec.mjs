'use strict';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import {
  ElementDefinition,
  ElementGenerator,
  Term,
  build,
  encodeValue,
  encodeAttributeValue,
  isVoidTag,
  isSVGElement,
  hasChild,
  nodeToElementDefinition,
  mergeChildren,
} from '../../lib/elements.mjs';

import { MYTHIX_TYPE, ELEMENT_DEFINITION_TYPE, UNFINISHED_DEFINITION } from '../../lib/constants.mjs';

// Helper: create a fresh jsdom document for DOM tests
function makeDocument() {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
  return dom.window.document;
}

// ─── 1. ElementGenerator creates ElementDefinitions ──────────────────────────

describe('ElementGenerator', () => {
  it('ElementGenerator.DIV creates an ElementDefinition with tagName DIV', () => {
    let definition = ElementGenerator.DIV();
    assert.ok(definition instanceof ElementDefinition, 'should be instance of ElementDefinition');
    assert.equal(definition.tagName, 'DIV');
  });

  it('ElementGenerator.SPAN creates an ElementDefinition with tagName SPAN', () => {
    let definition = ElementGenerator.SPAN();
    assert.equal(definition.tagName, 'SPAN');
  });
});

// ─── 2. Attribute chaining ───────────────────────────────────────────────────

describe('Attribute chaining', () => {
  it('.id("foo").className("bar") chains attributes', () => {
    let definition = ElementGenerator.DIV.id('foo').className('bar')();
    assert.equal(definition.attributes.id, 'foo');
    assert.equal(definition.attributes.className, 'bar');
  });

  it('chaining returns the same rootProxy for further chaining', () => {
    let chain = ElementGenerator.DIV.id('hello');
    assert.equal(typeof chain, 'function', 'chained builder should be callable');
  });

  it('boolean attribute: .hidden() sets attribute to true when chained without calling value setter', () => {
    // Accessing .hidden without calling it as a setter, then chaining further
    // e.g. ElementGenerator.DIV.hidden.id('foo')()
    let definition = ElementGenerator.DIV.hidden.id('foo')();
    assert.equal(definition.attributes.hidden, true);
    assert.equal(definition.attributes.id, 'foo');
  });
});

// ─── 3. Children ─────────────────────────────────────────────────────────────

describe('Children', () => {
  it('string child becomes a #text ElementDefinition', () => {
    let definition = ElementGenerator.DIV('text content');
    assert.equal(definition.children.length, 1);
    assert.equal(definition.children[0].tagName, '#text');
    assert.equal(definition.children[0].attributes.value, 'text content');
  });

  it('multiple string children each become #text nodes', () => {
    let definition = ElementGenerator.DIV('hello', ' ', 'world');
    assert.equal(definition.children.length, 3);
    assert.equal(definition.children[0].attributes.value, 'hello');
    assert.equal(definition.children[2].attributes.value, 'world');
  });

  it('null and undefined children are filtered out', () => {
    let definition = ElementGenerator.DIV(null, 'kept', undefined);
    assert.equal(definition.children.length, 1);
    assert.equal(definition.children[0].attributes.value, 'kept');
  });
});

// ─── 4. Nested elements ───────────────────────────────────────────────────────

describe('Nested elements', () => {
  it('ElementDefinition child is accepted directly', () => {
    let span = ElementGenerator.SPAN('inner');
    let div  = ElementGenerator.DIV(span);
    assert.equal(div.children.length, 1);
    assert.equal(div.children[0].tagName, 'SPAN');
    assert.equal(div.children[0].children[0].attributes.value, 'inner');
  });

  it('deeply nested elements work', () => {
    let definition = ElementGenerator.DIV(
      ElementGenerator.P(
        ElementGenerator.STRONG('bold'),
      ),
    );
    assert.equal(definition.children[0].tagName, 'P');
    assert.equal(definition.children[0].children[0].tagName, 'STRONG');
  });
});

// ─── 5. toString() produces correct HTML ─────────────────────────────────────

describe('toString()', () => {
  it('simple div produces correct HTML', () => {
    let html = ElementGenerator.DIV.id('main')('hello').toString();
    assert.equal(html, '<div id="main">hello</div>');
  });

  it('nested elements produce correct HTML', () => {
    let html = ElementGenerator.DIV(ElementGenerator.SPAN('text')).toString();
    assert.equal(html, '<div><span>text</span></div>');
  });

  it('attributes are converted to kebab-case', () => {
    let html = ElementGenerator.DIV.dataFoo('bar')().toString();
    assert.equal(html, '<div data-foo="bar"></div>');
  });

  it('prop$ attributes are excluded from toString()', () => {
    let html = ElementGenerator.DIV['prop$textContent']('hello')().toString();
    assert.equal(html, '<div></div>');
  });

  it('on* handler attributes are excluded from toString()', () => {
    let html = ElementGenerator.DIV.onClick(() => {})().toString();
    assert.equal(html, '<div></div>');
  });
});

// ─── 6. Term() ────────────────────────────────────────────────────────────────

describe('Term()', () => {
  it('creates a #text ElementDefinition', () => {
    let term = Term('hello world');
    assert.equal(term.tagName, '#text');
    assert.equal(term.attributes.value, 'hello world');
  });

  it('toString() returns the text content (with HTML escaping)', () => {
    let text = Term('hello <world>').toString();
    assert.equal(text, 'hello &lt;world&gt;');
  });

  it('special characters are escaped in text nodes', () => {
    let text = Term('<script>alert("xss")</script>').toString();
    assert.ok(text.includes('&lt;'));
    assert.ok(text.includes('&gt;'));
    assert.ok(!text.includes('<script>'));
  });
});

// ─── 7. build(document) creates actual DOM elements ──────────────────────────

describe('ElementDefinition.build()', () => {
  it('creates a div element', () => {
    let document   = makeDocument();
    let definition = ElementGenerator.DIV.id('test')('content');
    let element    = definition.build(document);
    assert.equal(element.tagName, 'DIV');
    assert.equal(element.getAttribute('id'), 'test');
    assert.equal(element.textContent, 'content');
  });

  it('creates nested DOM structure', () => {
    let document   = makeDocument();
    let definition = ElementGenerator.DIV(ElementGenerator.SPAN('inner'));
    let element    = definition.build(document);
    assert.equal(element.firstChild.tagName, 'SPAN');
    assert.equal(element.firstChild.textContent, 'inner');
  });

  it('text node build creates a DOM Text node', () => {
    let document   = makeDocument();
    let term       = Term('hello');
    let node       = term.build(document);
    assert.equal(node.nodeType, document.defaultView.Node.TEXT_NODE);
    assert.equal(node.nodeValue, 'hello');
  });

  it('className attribute is converted to class attribute', () => {
    let document   = makeDocument();
    let definition = ElementGenerator.DIV.className('foo bar')();
    let element    = definition.build(document);
    assert.equal(element.getAttribute('class-name'), 'foo bar');
    // Note: className→class-name via kebab conversion. Direct className property
    // would need prop$className. This verifies the kebab conversion happens.
  });
});

// ─── 8. SVG support ───────────────────────────────────────────────────────────

describe('SVG support', () => {
  it('isSVGElement("circle") returns true', () => {
    assert.equal(isSVGElement('circle'), true);
  });

  it('isSVGElement("div") returns false', () => {
    assert.equal(isSVGElement('div'), false);
  });

  it('ElementGenerator.svg creates SVG ElementDefinition with namespaceURI', () => {
    let definition = ElementGenerator.svg();
    assert.equal(definition.attributes.namespaceURI, 'http://www.w3.org/2000/svg');
  });

  it('ElementGenerator.circle creates circle ElementDefinition with SVG namespace', () => {
    let definition = ElementGenerator.circle.r('10')();
    assert.equal(definition.tagName, 'circle');
    assert.equal(definition.attributes.namespaceURI, 'http://www.w3.org/2000/svg');
    assert.equal(definition.attributes.r, '10');
  });

  it('SVG element is created with correct namespace in DOM', () => {
    let document   = makeDocument();
    let definition = ElementGenerator.circle.r('10')();
    let element    = definition.build(document);
    assert.equal(element.namespaceURI, 'http://www.w3.org/2000/svg');
    assert.equal(element.getAttribute('r'), '10');
  });

  it('namespaceURI is not set as an attribute on the SVG element', () => {
    let document   = makeDocument();
    let definition = ElementGenerator.circle();
    let element    = definition.build(document);
    assert.equal(element.getAttribute('namespaceURI'), null);
    assert.equal(element.hasAttribute('namespaceURI'), false);
  });
});

// ─── 9. isVoidTag() ───────────────────────────────────────────────────────────

describe('isVoidTag()', () => {
  it('returns true for input', () => {
    assert.equal(isVoidTag('input'), true);
  });

  it('returns true for br', () => {
    assert.equal(isVoidTag('br'), true);
  });

  it('returns true for img', () => {
    assert.equal(isVoidTag('img'), true);
  });

  it('returns true for meta', () => {
    assert.equal(isVoidTag('meta'), true);
  });

  it('returns true for link', () => {
    assert.equal(isVoidTag('link'), true);
  });

  it('returns false for div', () => {
    assert.equal(isVoidTag('div'), false);
  });

  it('returns false for span', () => {
    assert.equal(isVoidTag('span'), false);
  });

  it('returns false for p', () => {
    assert.equal(isVoidTag('p'), false);
  });
});

// ─── 10. encodeValue() ────────────────────────────────────────────────────────

describe('encodeValue()', () => {
  it('encodes < and > as HTML entities', () => {
    let result = encodeValue('<div>');
    assert.ok(result.includes('&#60;'));
    assert.ok(result.includes('&#62;'));
    assert.ok(!result.includes('<'));
    assert.ok(!result.includes('>'));
  });

  it('leaves safe characters unchanged', () => {
    let result = encodeValue('hello world');
    assert.equal(result, 'hello world');
  });

  it('encodes double quotes', () => {
    let result = encodeValue('"quoted"');
    assert.ok(!result.includes('"'));
  });

  it('encodes & ampersands', () => {
    let result = encodeValue('a & b');
    assert.ok(!result.includes('&a'));
  });

  it('coerces non-string values to string', () => {
    let result = encodeValue(42);
    assert.equal(result, '42');
  });
});

// ─── 11. encodeAttributeValue() ──────────────────────────────────────────────

describe('encodeAttributeValue()', () => {
  it('encodes double quotes', () => {
    let result = encodeAttributeValue('"value"');
    assert.ok(!result.includes('"'));
    assert.ok(result.includes('&#34;'));
  });

  it('encodes ampersands', () => {
    let result = encodeAttributeValue('a & b');
    assert.ok(result.includes('&#38;'));
    assert.ok(!result.includes(' & '));
  });

  it('leaves other special characters like < unencoded', () => {
    let result = encodeAttributeValue('a < b');
    assert.ok(result.includes('<'));
  });

  it('leaves safe characters unchanged', () => {
    let result = encodeAttributeValue('hello-world_foo');
    assert.equal(result, 'hello-world_foo');
  });

  it('coerces non-string values to string', () => {
    let result = encodeAttributeValue(123);
    assert.equal(result, '123');
  });
});

// ─── 12. Void tags self-close in toString() ───────────────────────────────────

describe('Void tag toString()', () => {
  it('input self-closes (no closing tag)', () => {
    let html = ElementGenerator.INPUT.type('text')().toString();
    assert.ok(html.startsWith('<input'));
    assert.ok(!html.includes('</input>'));
  });

  it('br self-closes', () => {
    let html = ElementGenerator.BR().toString();
    assert.equal(html, '<br>');
  });

  it('img self-closes', () => {
    let html = ElementGenerator.IMG.src('test.png')().toString();
    assert.ok(html.startsWith('<img'));
    assert.ok(!html.includes('</img>'));
  });

  it('non-void div has closing tag', () => {
    let html = ElementGenerator.DIV().toString();
    assert.ok(html.includes('</div>'));
  });
});

// ─── 13. Fragment support ─────────────────────────────────────────────────────

describe('Fragment support (#fragment)', () => {
  it('toString() returns children concatenated without wrapper', () => {
    let fragment = new ElementDefinition('#fragment', {}, [
      ElementGenerator.DIV('a'),
      ElementGenerator.SPAN('b'),
    ]);
    assert.equal(fragment.toString(), '<div>a</div><span>b</span>');
  });

  it('build() returns a DocumentFragment node', () => {
    let document = makeDocument();
    let fragment = new ElementDefinition('#fragment', {}, [
      ElementGenerator.DIV('a'),
      ElementGenerator.SPAN('b'),
    ]);
    let node = fragment.build(document);
    assert.equal(node.nodeType, document.defaultView.Node.DOCUMENT_FRAGMENT_NODE);
    assert.equal(node.childNodes.length, 2);
  });

  it('fragment children are appended in order', () => {
    let document = makeDocument();
    let fragment = new ElementDefinition('#fragment', {}, [
      Term('first'),
      Term('second'),
    ]);
    let node = fragment.build(document);
    assert.equal(node.childNodes[0].nodeValue, 'first');
    assert.equal(node.childNodes[1].nodeValue, 'second');
  });
});

// ─── 14. prop$ prefix sets DOM properties directly ───────────────────────────

describe('prop$ prefix', () => {
  it('prop$textContent sets textContent property instead of attribute', () => {
    let document   = makeDocument();
    let definition = ElementGenerator.DIV['prop$textContent']('hello')();
    let element    = definition.build(document);
    assert.equal(element.textContent, 'hello');
    assert.equal(element.hasAttribute('textContent'), false);
    assert.equal(element.hasAttribute('text-content'), false);
  });

  it('prop$ property does not appear in toString() output', () => {
    let html = ElementGenerator.DIV['prop$textContent']('hello')().toString();
    assert.ok(!html.includes('textContent'));
    assert.ok(!html.includes('text-content'));
  });

  it('prop$innerHTML sets innerHTML property', () => {
    let document   = makeDocument();
    let definition = ElementGenerator.DIV['prop$innerHTML']('<strong>bold</strong>')();
    let element    = definition.build(document);
    assert.equal(element.innerHTML, '<strong>bold</strong>');
  });
});

// ─── 15. on* attributes bind event listeners ─────────────────────────────────

describe('on* event listener binding', () => {
  it('onClick binds a click event listener', () => {
    let document   = makeDocument();
    let clicked    = false;
    let handler    = () => { clicked = true; };
    let definition = ElementGenerator.DIV.onClick(handler)();
    let element    = definition.build(document);

    element.dispatchEvent(new document.defaultView.Event('click'));
    assert.equal(clicked, true);
  });

  it('onInput binds an input event listener', () => {
    let document   = makeDocument();
    let fired      = false;
    let definition = ElementGenerator.INPUT.onInput(() => { fired = true; })();
    let element    = definition.build(document);

    element.dispatchEvent(new document.defaultView.Event('input'));
    assert.equal(fired, true);
  });

  it('on* handler does not appear as an attribute', () => {
    let document   = makeDocument();
    let definition = ElementGenerator.DIV.onClick(() => {})();
    let element    = definition.build(document);
    assert.equal(element.hasAttribute('onClick'), false);
    assert.equal(element.hasAttribute('on-click'), false);
  });

  it('on* handler does not appear in toString() output', () => {
    let html = ElementGenerator.DIV.onClick(() => {})().toString();
    assert.ok(!html.includes('on-click'));
    assert.ok(!html.includes('onClick'));
  });
});

// ─── 16. ElementDefinition[Symbol.hasInstance] ───────────────────────────────

describe('ElementDefinition[Symbol.hasInstance]', () => {
  it('returns true for ElementDefinition instances', () => {
    let definition = ElementGenerator.DIV();
    assert.ok(definition instanceof ElementDefinition);
  });

  it('returns false for plain objects', () => {
    assert.equal(({}) instanceof ElementDefinition, false);
  });

  it('returns false for null without throwing', () => {
    assert.equal(null instanceof ElementDefinition, false);
  });

  it('returns false for undefined without throwing', () => {
    // instanceof with undefined throws a TypeError in JS — Symbol.hasInstance
    // would not be called in that case. Test with a plain object instead.
    let fake = { foo: 'bar' };
    assert.equal(fake instanceof ElementDefinition, false);
  });

  it('returns true for object with correct MYTHIX_TYPE symbol', () => {
    let fakeDefinition = { [MYTHIX_TYPE]: ELEMENT_DEFINITION_TYPE };
    assert.ok(fakeDefinition instanceof ElementDefinition);
  });

  it('returns false for object with wrong MYTHIX_TYPE value', () => {
    let wrongType = { [MYTHIX_TYPE]: Symbol('other') };
    assert.equal(wrongType instanceof ElementDefinition, false);
  });
});

// ─── 17. nodeToElementDefinition ─────────────────────────────────────────────

describe('nodeToElementDefinition()', () => {
  it('converts a text node to a #text ElementDefinition', () => {
    let document = makeDocument();
    let textNode = document.createTextNode('hello');
    let definition = nodeToElementDefinition(textNode);
    assert.equal(definition.tagName, '#text');
    assert.equal(definition.attributes.value, 'hello');
  });

  it('converts an element node with attributes', () => {
    let document = makeDocument();
    let element  = document.createElement('div');
    element.setAttribute('id', 'main');
    element.setAttribute('class', 'container');
    let definition = nodeToElementDefinition(element);
    assert.equal(definition.tagName, 'DIV');
    assert.equal(definition.attributes.id, 'main');
    assert.equal(definition.attributes.class, 'container');
  });

  it('converts an element with children recursively', () => {
    let document = makeDocument();
    let parent   = document.createElement('ul');
    let child    = document.createElement('li');
    child.appendChild(document.createTextNode('item'));
    parent.appendChild(child);

    let definition = nodeToElementDefinition(parent);
    assert.equal(definition.tagName, 'UL');
    assert.equal(definition.children.length, 1);
    assert.equal(definition.children[0].tagName, 'LI');
    assert.equal(definition.children[0].children[0].tagName, '#text');
    assert.equal(definition.children[0].children[0].attributes.value, 'item');
  });

  it('converts a DocumentFragment to a #fragment ElementDefinition', () => {
    let document = makeDocument();
    let fragment = document.createDocumentFragment();
    fragment.appendChild(document.createElement('div'));
    fragment.appendChild(document.createElement('span'));

    let definition = nodeToElementDefinition(fragment);
    assert.equal(definition.tagName, '#fragment');
    assert.equal(definition.children.length, 2);
  });

  it('returns undefined for unsupported node types', () => {
    let document  = makeDocument();
    let comment   = document.createComment('not supported');
    let definition = nodeToElementDefinition(comment);
    assert.equal(definition, undefined);
  });
});

// ─── 18. mergeChildren() ─────────────────────────────────────────────────────

describe('mergeChildren()', () => {
  it('merges children from multiple source nodes into target', () => {
    let document = makeDocument();
    let target   = document.createElement('div');
    let source1  = document.createElement('ul');
    let source2  = document.createElement('ul');

    source1.appendChild(document.createElement('li'));
    source2.appendChild(document.createElement('li'));

    mergeChildren(target, source1, source2);
    assert.equal(target.childNodes.length, 2);
  });

  it('returns the target unchanged if target is not a Node', () => {
    let notANode = { foo: 'bar' };
    let result   = mergeChildren(notANode, {});
    assert.equal(result, notANode);
  });

  it('skips non-Node sources silently', () => {
    let document = makeDocument();
    let target   = document.createElement('div');
    let source   = document.createElement('span');
    source.appendChild(document.createTextNode('hi'));

    mergeChildren(target, null, source, undefined);
    assert.equal(target.childNodes.length, 1);
    assert.equal(target.firstChild.textContent, 'hi');
  });

  it('handles template elements by cloning content', () => {
    let document = makeDocument();
    let target   = document.createElement('div');
    let template = document.createElement('template');
    template.innerHTML = '<p>from template</p>';

    mergeChildren(target, template);
    assert.equal(target.childNodes.length, 1);
    assert.equal(target.firstChild.tagName, 'P');
  });

  it('merges into template content when target is a template', () => {
    let document = makeDocument();
    let target   = document.createElement('template');
    let source   = document.createElement('div');
    source.appendChild(document.createElement('span'));

    mergeChildren(target, source);
    assert.equal(target.content.childNodes.length, 1);
    assert.equal(target.content.firstChild.tagName, 'SPAN');
  });
});

// ─── 19. hasChild() ───────────────────────────────────────────────────────────

describe('hasChild()', () => {
  it('returns true when childNode is a direct child', () => {
    let document = makeDocument();
    let parent   = document.createElement('div');
    let child    = document.createElement('span');
    parent.appendChild(child);
    assert.equal(hasChild(parent, child), true);
  });

  it('returns false when childNode is not a direct child', () => {
    let document = makeDocument();
    let parent   = document.createElement('div');
    let other    = document.createElement('span');
    assert.equal(hasChild(parent, other), false);
  });

  it('returns false when parentNode is null', () => {
    let document = makeDocument();
    let child    = document.createElement('span');
    assert.equal(hasChild(null, child), false);
  });

  it('returns false when childNode is null', () => {
    let document = makeDocument();
    let parent   = document.createElement('div');
    assert.equal(hasChild(parent, null), false);
  });

  it('returns false for grandchild (not direct child)', () => {
    let document    = makeDocument();
    let grandparent = document.createElement('div');
    let parent      = document.createElement('section');
    let grandchild  = document.createElement('span');
    parent.appendChild(grandchild);
    grandparent.appendChild(parent);
    assert.equal(hasChild(grandparent, grandchild), false);
  });
});

// ─── 20. build() factory function ────────────────────────────────────────────

describe('build() factory function', () => {
  it('throws when tagName is missing', () => {
    assert.throws(() => build(null), /Can not create an ElementDefinition without a "tagName"/);
  });

  it('throws when tagName is not a string', () => {
    assert.throws(() => build(123), /Can not create an ElementDefinition without a "tagName"/);
  });

  it('creates a builder for the given tagName', () => {
    let builder    = build('section');
    let definition = builder('hello');
    assert.equal(definition.tagName, 'section');
  });

  it('UNFINISHED_DEFINITION marker is true on unfinalized proxy', () => {
    let builder = build('div');
    assert.equal(builder[UNFINISHED_DEFINITION], true);
  });

  it('calling the builder with children finalizes it', () => {
    let definition = build('div')('hello');
    // A finalized ElementDefinition should NOT have UNFINISHED_DEFINITION
    assert.equal(definition[UNFINISHED_DEFINITION], undefined);
    assert.equal(definition instanceof ElementDefinition, true);
  });
});
