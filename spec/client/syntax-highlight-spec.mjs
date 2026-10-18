'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { installDom } from './support/mini-dom.mjs';
import { highlightBashInto, highlightBashNodes } from '../../src/client/components/syntax-highlight.mjs';

const { document } = installDom();

function nodeText(node) {
  if (typeof node.textContent === 'string')
    return node.textContent;
  return String(node.text ?? '');
}

test('bash highlighting marks commands, strings, variables and comments', () => {
  let nodes = highlightBashNodes('git commit -m "fix" $HOME # note', document);
  let text = nodes.map(nodeText).join('');
  assert.equal(text, 'git commit -m "fix" $HOME # note');

  let classes = nodes.map((node) => node.className).filter(Boolean);
  assert.ok(classes.includes('bash-command'), 'the leading command is highlighted');
  assert.ok(classes.includes('bash-string'), 'the quoted string is highlighted');
  assert.ok(classes.includes('bash-comment'), 'the comment is highlighted');
  assert.ok(classes.includes('bash-var'), 'the variable is highlighted');
});

test('bash highlighting preserves flags and numbers', () => {
  let nodes = highlightBashNodes('npm test -- --timeout 30', document);
  let classes = nodes.map((node) => node.className).filter(Boolean);
  assert.ok(classes.includes('bash-flag'));
  assert.ok(classes.includes('bash-number'));
});

test('highlightBashInto replaces children and never injects markup', () => {
  let element = document.createElement('code');
  element.appendChild(document.createElement('b'));

  highlightBashInto(element, 'echo "<b>hi</b>"');

  assert.equal(element.textContent, 'echo "<b>hi</b>"');
  assert.equal(element.querySelector('b'), null, 'HTML in output is treated as text');
});
