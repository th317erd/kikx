'use strict';

// Minimal, dependency-free bash highlighter for tool output details. It tokenizes
// comments, strings, variables, flags, numbers and words, marks the first word of
// a command, and returns DOM nodes (never innerHTML) so arbitrary tool output
// cannot inject markup.

const KEYWORDS = new Set([
  'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done',
  'case', 'esac', 'function', 'return', 'export', 'local', 'readonly', 'source',
  'set', 'unset', 'shift', 'trap', 'exit', 'break', 'continue',
]);

const TOKEN_PATTERN = /(#.*$)|('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")|(\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*|\$[0-9@*#?$!-])|(\s-{1,2}[A-Za-z0-9][A-Za-z0-9_-]*)|([A-Za-z_][A-Za-z0-9_]*)|(\d+(?:\.\d+)?)/g;

export function highlightBashNodes(text, ownerDocument = globalThis.document) {
  let nodes = [];
  let doc = ownerDocument;

  for (let line of String(text ?? '').split('\n')) {
    let index = 0;
    let atCommandStart = true;
    let match;
    TOKEN_PATTERN.lastIndex = 0;

    while ((match = TOKEN_PATTERN.exec(line))) {
      if (match.index > index)
        nodes.push(doc.createTextNode(line.slice(index, match.index)));
      index = match.index + match[0].length;

      let [ token, comment, string, variable, flag, word, number ] = match;
      if (comment) {
        nodes.push(spanNode(doc, token, 'bash-comment'));
      } else if (string) {
        nodes.push(spanNode(doc, token, 'bash-string'));
      } else if (variable) {
        nodes.push(spanNode(doc, token, 'bash-var'));
      } else if (flag) {
        nodes.push(spanNode(doc, token, 'bash-flag'));
      } else if (word) {
        let className = '';
        if (KEYWORDS.has(word.toLowerCase()))
          className = 'bash-keyword';
        else if (atCommandStart)
          className = 'bash-command';

        nodes.push(spanNode(doc, token, className));
        atCommandStart = false;
      } else if (number) {
        nodes.push(spanNode(doc, token, 'bash-number'));
      } else {
        nodes.push(doc.createTextNode(token));
      }
    }

    if (index < line.length)
      nodes.push(doc.createTextNode(line.slice(index)));
    nodes.push(doc.createTextNode('\n'));
  }

  // Drop the newline added after the final line.
  if (nodes.length > 0)
    nodes.pop();

  return nodes;
}

// Replace `element`'s children with highlighted nodes.
export function highlightBashInto(element, text) {
  let doc = element.ownerDocument || globalThis.document;
  element.textContent = '';
  for (let node of highlightBashNodes(text, doc))
    element.appendChild(node);
  return element;
}

function spanNode(ownerDocument, text, className) {
  let node = ownerDocument.createElement('span');
  if (className)
    node.className = className;
  node.textContent = text;
  return node;
}
