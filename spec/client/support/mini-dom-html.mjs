'use strict';

// Tiny HTML parser for the mini DOM's `innerHTML` setter. Handles the
// element/text/comment shape the client templates use; it is not a full parser.

export const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr',
]);

const ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
};

export function decodeEntities(value) {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity) => {
    if (entity[0] === '#') {
      let code = entity[1] === 'x' || entity[1] === 'X'
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return Object.hasOwn(ENTITIES, entity) ? ENTITIES[entity] : match;
  });
}

function parseAttributeString(attributeString) {
  let attributes = [];
  let pattern = /([^\s=]+)(?:\s*=\s*"([^"]*)")?/g;
  let match;
  while ((match = pattern.exec(attributeString)) !== null) {
    if (!match[1])
      continue;
    attributes.push([ match[1], match[2] === undefined ? '' : decodeEntities(match[2]) ]);
  }
  return attributes;
}

export function parseHTMLInto(ownerDocument, parent, html) {
  let pattern = /<!--[\s\S]*?-->|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^<>]*?)?)(\/?)>|([^<]+)/g;
  let stack = [ parent ];
  let match;
  while ((match = pattern.exec(html)) !== null) {
    let [ , closeTag, openTag, attributeString, selfClose, text ] = match;
    let current = stack[stack.length - 1];

    if (text !== undefined) {
      if (text)
        current.appendChild(ownerDocument.createTextNode(decodeEntities(text)));
      continue;
    }

    if (closeTag) {
      if (stack.length > 1)
        stack.pop();
      continue;
    }

    if (openTag) {
      let element = ownerDocument.createElement(openTag);
      for (let [ name, value ] of parseAttributeString(attributeString || ''))
        element.setAttribute(name, value);
      current.appendChild(element);
      if (selfClose !== '/' && !VOID_TAGS.has(openTag.toLowerCase()))
        stack.push(element);
    }
  }
}
