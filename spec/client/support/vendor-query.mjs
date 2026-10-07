'use strict';

// Stand-in for /vendor/aeor-web-components/query.js. Only `.empty()` (and a
// couple of read helpers) are exercised by the client-component specs.

function toElementArray(input) {
  if (!input)
    return [];
  if (Array.isArray(input))
    return input;
  if (typeof input.nodeType === 'number')
    return [ input ];
  return [];
}

export function $(input) {
  let nodes = toElementArray(input);

  let engine = {
    get length() {
      return nodes.length;
    },
    empty() {
      for (let node of nodes) {
        while (node.childNodes.length)
          node.removeChild(node.childNodes[0]);
      }
      return engine;
    },
    toArray() {
      return nodes.slice();
    },
    [Symbol.iterator]() {
      return nodes[Symbol.iterator]();
    },
  };

  return engine;
}
