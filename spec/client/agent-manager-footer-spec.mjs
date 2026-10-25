'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

import { installDom } from './support/mini-dom.mjs';

register(new URL('./support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);
installDom();

const { elements } = await import('../../src/client/lib/aeor-ui.mjs');
const { buildAgentManagerBody, buildAgentManagerFooter } = await import('../../src/client/components/kikx-modals.mjs');

function walk(node, visit) {
  visit(node);
  for (let child of node.childNodes || []) {
    if (child?.nodeType === 1)
      walk(child, visit);
  }
}

test('the Agents modal owns one footer Add Agent button and the status line', () => {
  let app = {
    _state: {
      agentDetailsByID: {},
      agentIDs: [],
      agentTagDefinitions: [],
      agentProviders: [],
      agentStatus: 'Set OCR bot #1',
      agentStatusKind: 'ready',
      sessionDetailsByID: {},
      sessionIDs: [],
    },
  };

  let body = elements.div()(buildAgentManagerBody(app)).build(document);
  let footer = buildAgentManagerFooter(app).build(document);

  let bodyButtons = [];
  walk(body, (node) => {
    if (node?.localName === 'button' && node.textContent.trim() === '+ Add Agent')
      bodyButtons.push(node);
  });
  assert.equal(bodyButtons.length, 0, 'Add Agent must not be inside the scrolling body');
  assert.equal(body.querySelectorAll('.kikx-auth-status').length, 0);

  let footerButtons = [];
  walk(footer, (node) => {
    if (node?.localName === 'button' && node.textContent.trim() === '+ Add Agent')
      footerButtons.push(node);
  });
  assert.equal(footerButtons.length, 1);
  assert.match(footer.textContent, /Set OCR bot #1/);
  assert.ok(footer.querySelector('.kikx-auth-status'));
});
