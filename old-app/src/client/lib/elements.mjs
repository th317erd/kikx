'use strict';

import { MYTHIX_TYPE, ELEMENT_DEFINITION_TYPE, UNFINISHED_DEFINITION } from './constants.mjs';
import { isType } from './base-utilities.mjs';

const IS_PROP_NAME   = /^prop\$/;
const IS_TARGET_PROP = /^prototype|constructor$/;
const IS_ON_HANDLER  = /^on([A-Z].*)$/;

// Node type constants (W3C DOM spec)
const NODE_TYPE_TEXT              = 3;
const NODE_TYPE_ELEMENT           = 1;
const NODE_TYPE_DOCUMENT_FRAGMENT = 11;

// Duck-type check for DOM Node objects — avoids dependency on the global Node
// constructor which is unavailable in plain Node.js (non-browser) environments.
function isDOMNode(value) {
  return (
    value != null &&
    typeof value === 'object' &&
    typeof value.nodeType === 'number' &&
    typeof value.appendChild === 'function'
  );
}

export class ElementDefinition {
  static [Symbol.hasInstance](instance) {
    try {
      return (instance && instance[MYTHIX_TYPE] === ELEMENT_DEFINITION_TYPE);
    } catch (error) {
      return false;
    }
  }

  constructor(tagName, attributes, children) {
    Object.defineProperties(this, {
      [MYTHIX_TYPE]: {
        writable:     true,
        enumerable:   false,
        configurable: true,
        value:        ELEMENT_DEFINITION_TYPE,
      },
      'tagName': {
        writable:     false,
        enumerable:   false,
        configurable: false,
        value:        tagName,
      },
      'attributes': {
        writable:     false,
        enumerable:   false,
        configurable: false,
        value:        attributes || {},
      },
      'children': {
        writable:     false,
        enumerable:   false,
        configurable: false,
        value:        children || [],
      },
    });
  }

  toString(_options) {
    let options = _options || {};
    let tagName = this.tagName;

    if (tagName === '#text')
      return this.attributes.value.replace(/</g, '&lt;').replace(/>/g, '&gt;');

    let attrs = (tagName === '#fragment') ? null : ((attributes) => {
      let parts = [];

      for (let [ attributeName, value ] of Object.entries(attributes)) {
        if (IS_PROP_NAME.test(attributeName))
          continue;

        if (IS_ON_HANDLER.test(attributeName))
          continue;

        if (attributeName === 'namespaceURI')
          continue;

        let name = this.toDOMAttributeName(attributeName);
        if (value == null)
          parts.push(name);
        else
          parts.push(`${name}="${encodeAttributeValue('' + value)}"`);
      }

      return parts.join(' ');
    })(this.attributes);

    let children = ((childList) => {
      return childList
        .filter((child) => (child != null && child !== false && !Object.is(child, NaN)))
        .map((child) => ((child && typeof child.toString === 'function') ? child.toString(options) : ('' + child)))
        .join('');
    })(this.children);

    if (tagName === '#fragment')
      return children;

    tagName = tagName.toLowerCase();

    let elementTagStart = `<${tagName}${(attrs) ? ` ${attrs}` : ''}>`;
    let elementTagEnd   = `</${tagName}>`;

    return `${elementTagStart}${(isVoidTag(tagName)) ? '' : `${children}${elementTagEnd}`}`;
  }

  toDOMAttributeName(attributeName) {
    return attributeName.replace(/([A-Z])/g, '-$1').toLowerCase();
  }

  build(ownerDocument) {
    if (this.tagName === '#fragment') {
      let fragment = ownerDocument.createDocumentFragment();
      for (let child of this.children) {
        let built = child.build(ownerDocument);
        if (Array.isArray(built))
          built.flat(Infinity).forEach((node) => fragment.appendChild(node));
        else
          fragment.appendChild(built);
      }
      return fragment;
    }

    let attributes   = this.attributes;
    let namespaceURI = attributes.namespaceURI;
    let options;
    let element;

    if (attributes.is)
      options = { is: attributes.is };

    if (this.tagName === '#text')
      return ownerDocument.createTextNode(attributes.value || '');

    if (namespaceURI)
      element = ownerDocument.createElementNS(namespaceURI, this.tagName, options);
    else if (isSVGElement(this.tagName))
      element = ownerDocument.createElementNS('http://www.w3.org/2000/svg', this.tagName, options);
    else
      element = ownerDocument.createElement(this.tagName, options);

    let attributeNames = Object.keys(attributes);
    for (let i = 0, il = attributeNames.length; i < il; i++) {
      let attributeName  = attributeNames[i];
      let attributeValue = attributes[attributeName];

      // Skip internal/special keys
      if (attributeName === 'namespaceURI')
        continue;

      // prop$ prefix: set directly as a DOM property
      if (IS_PROP_NAME.test(attributeName)) {
        let propertyName = attributeName.replace(IS_PROP_NAME, '');
        element[propertyName] = attributeValue;
        continue;
      }

      // on* attributes: bind as event listeners when value is a function
      let onMatch = attributeName.match(IS_ON_HANDLER);
      if (onMatch && typeof attributeValue === 'function') {
        let eventName = onMatch[1].charAt(0).toLowerCase() + onMatch[1].slice(1);
        element.addEventListener(eventName, attributeValue);
        continue;
      }

      // Regular attributes
      let modifiedAttributeName = this.toDOMAttributeName(attributeName);
      if (attributeValue == null)
        element.setAttribute(modifiedAttributeName, '');
      else
        element.setAttribute(modifiedAttributeName, '' + attributeValue);
    }

    let childList = this.children;
    for (let i = 0, il = childList.length; i < il; i++) {
      let child        = childList[i];
      let childElement = child.build(ownerDocument);

      if (Array.isArray(childElement))
        childElement.flat(Infinity).forEach((node) => element.appendChild(node));
      else
        element.appendChild(childElement);
    }

    return element;
  }
}

const IS_HTML_SAFE_CHARACTER = /^[\sa-zA-Z0-9_-]$/;
export function encodeValue(value) {
  return ('' + value).replace(/./g, (match) => {
    return (IS_HTML_SAFE_CHARACTER.test(match)) ? match : `&#${match.charCodeAt(0)};`;
  });
}

export function encodeAttributeValue(value) {
  return ('' + value).replace(/["&]/g, (match) => {
    return `&#${match.charCodeAt(0)};`;
  });
}

const IS_VOID_TAG = /^area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr$/i;
export function isVoidTag(tagName) {
  return IS_VOID_TAG.test(tagName.split(':').slice(-1)[0]);
}

export function hasChild(parentNode, childNode) {
  if (!parentNode || !childNode)
    return false;

  for (let child of Array.from(parentNode.childNodes)) {
    if (child === childNode)
      return true;
  }

  return false;
}

export function build(tagName, defaultAttributes, scope) {
  if (!tagName || !isType(tagName, '::String'))
    throw new Error('Can not create an ElementDefinition without a "tagName".');

  const finalizer = (..._children) => {
    const wrangleChildren = (children) => {
      return children.flat(Infinity).map((value) => {
        if (value == null || Object.is(value, NaN))
          return null;

        if (typeof value === 'symbol')
          return null;

        if (value[UNFINISHED_DEFINITION])
          return value();

        if (value[MYTHIX_TYPE] === ELEMENT_DEFINITION_TYPE)
          return value;

        if (isDOMNode(value))
          return nodeToElementDefinition(value);

        if (!isType(value, '::String'))
          return null;

        return new ElementDefinition('#text', { value: ('' + value) });
      }).flat(Infinity).filter(Boolean);
    };

    let children   = wrangleChildren(_children || []);
    let attributes = scope || defaultAttributes;
    return new ElementDefinition(tagName, attributes, children);
  };

  let rootProxy = new Proxy(finalizer, {
    get: (target, attributeName) => {
      if (attributeName === UNFINISHED_DEFINITION)
        return true;

      if (typeof attributeName === 'symbol' || IS_TARGET_PROP.test(attributeName))
        return target[attributeName];

      if (!scope) {
        let scopedProxy = build(tagName, defaultAttributes, Object.assign(Object.create(null), defaultAttributes || {}));
        return scopedProxy[attributeName];
      }

      return new Proxy(
        (value) => {
          scope[attributeName] = value;
          return rootProxy;
        },
        {
          get: (innerTarget, propName) => {
            if (propName === UNFINISHED_DEFINITION)
              return true;

            if (typeof propName === 'symbol' || IS_TARGET_PROP.test(propName))
              return innerTarget[propName];

            scope[attributeName] = true;
            return rootProxy[propName];
          },
        },
      );
    },
  });

  return rootProxy;
}

export function nodeToElementDefinition(node) {
  if (node.nodeType === NODE_TYPE_TEXT)
    return new ElementDefinition('#text', { value: ('' + node.nodeValue) });

  if (node.nodeType !== NODE_TYPE_ELEMENT && node.nodeType !== NODE_TYPE_DOCUMENT_FRAGMENT)
    return;

  let attributes = {};

  if (typeof node.getAttributeNames === 'function') {
    for (let attributeName of node.getAttributeNames())
      attributes[attributeName] = node.getAttribute(attributeName);
  }

  let children = Array.from(node.childNodes).map(nodeToElementDefinition).filter(Boolean);
  return new ElementDefinition(
    (node.nodeType === NODE_TYPE_DOCUMENT_FRAGMENT) ? '#fragment' : node.tagName,
    attributes,
    children,
  );
}

const IS_TEMPLATE = /^(template)$/i;

export function mergeChildren(target, ...others) {
  if (!isDOMNode(target))
    return target;

  let targetIsTemplate = IS_TEMPLATE.test(target.tagName);
  for (let other of others) {
    if (!isDOMNode(other))
      continue;

    let childNodes = (IS_TEMPLATE.test(other.tagName)) ? other.content.cloneNode(true).childNodes : other.childNodes;
    for (let child of Array.from(childNodes)) {
      let content = (IS_TEMPLATE.test(child.tagName)) ? child.content.cloneNode(true) : child;
      if (targetIsTemplate)
        target.content.appendChild(content);
      else
        target.appendChild(content);
    }
  }

  return target;
}

const IS_SVG_ELEMENT_NAME = /^(altglyph|altglyphdef|altglyphitem|animate|animateColor|animateMotion|animateTransform|animation|circle|clipPath|colorProfile|cursor|defs|desc|discard|ellipse|feblend|fecolormatrix|fecomponenttransfer|fecomposite|feconvolvematrix|fediffuselighting|fedisplacementmap|fedistantlight|fedropshadow|feflood|fefunca|fefuncb|fefuncg|fefuncr|fegaussianblur|feimage|femerge|femergenode|femorphology|feoffset|fepointlight|fespecularlighting|fespotlight|fetile|feturbulence|filter|font|fontFace|fontFaceFormat|fontFaceName|fontFaceSrc|fontFaceUri|foreignObject|g|glyph|glyphRef|handler|hKern|image|line|lineargradient|listener|marker|mask|metadata|missingGlyph|mPath|path|pattern|polygon|polyline|prefetch|radialgradient|rect|set|solidColor|stop|svg|switch|symbol|tbreak|text|textpath|tref|tspan|unknown|use|view|vKern)$/i;
export function isSVGElement(tagName) {
  return IS_SVG_ELEMENT_NAME.test(tagName);
}

export const Term = (value) => new ElementDefinition('#text', { value });

export const ElementGenerator = new Proxy(
  {
    Term,
    $TEXT: Term,
  },
  {
    get: function(target, propName) {
      if (propName in target)
        return target[propName];

      if (typeof propName === 'symbol')
        return undefined;

      if (IS_SVG_ELEMENT_NAME.test(propName))
        return build(propName, { namespaceURI: 'http://www.w3.org/2000/svg' });

      return build(propName);
    },
    set: function() {
      return true;
    },
  },
);
