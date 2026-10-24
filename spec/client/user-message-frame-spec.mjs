'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { installDom } from './support/mini-dom.mjs';

const { document } = installDom();
globalThis.document = document;

await import('../../src/client/components/kikx-user-message-frame.mjs');

function userFrame(overrides = {}) {
  return {
    id: 'user-1',
    type: 'UserMessage',
    content: {
      text: 'Please implement the expandable prompt.',
      ...overrides,
    },
  };
}

function promptRecord() {
  return {
    capturedAt: 1_700_000_000_000,
    agentID: 'agent_1',
    agentName: 'Zav',
    userText: 'Please implement the expandable prompt.',
    messages: [
      { role: 'system', content: 'You are a careful agent.' },
      { role: 'user', content: 'Earlier history.' },
      {
        role: 'user',
        content: 'Message from Wyatt:\nPlease implement the expandable prompt.\n\ntodo: none',
      },
    ],
  };
}

test('user messages keep their normal markdown and offer the sent prompt', () => {
  let element = document.createElement('kikx-user-message-frame');
  document.body.appendChild(element);
  element.updateFrame(userFrame({ modelPrompt: promptRecord() }), {});

  assert.match(element.querySelector('.kikx-user-message__text').textContent, /expandable prompt/);
  assert.equal(element.querySelector('.kikx-user-message__prompt-summary').textContent, 'View sent prompt');

  element._renderPrompt();

  let roles = element.querySelectorAll('.kikx-user-message__prompt-role').map((node) => node.textContent);
  assert.deepEqual(roles, [ 'System', 'User', 'User / prompt' ]);
  assert.match(element.querySelector('.kikx-user-message__prompt-meta').textContent, /3 messages/);
  assert.match(element.textContent, /You are a careful agent/);
  assert.equal(element.querySelector('.kikx-user-message__prompt-user-text').textContent, 'Please implement the expandable prompt.');
});

test('the last user prompt falls back to a tinted block when markdown spans text nodes', () => {
  let element = document.createElement('kikx-user-message-frame');
  document.body.appendChild(element);
  let prompt = promptRecord();
  prompt.userText = '**Please** implement it.';
  prompt.messages = [
    { role: 'system', content: 'System.' },
    { role: 'user', content: 'Message from Wyatt:\n**Please** implement it.\n\ntodo: none' },
  ];
  element.updateFrame(userFrame({ text: '**Please** implement it.', modelPrompt: prompt }), {});
  element._renderPrompt();

  let mark = element.querySelector('.kikx-user-message__prompt-user-text');
  let fallback = element.querySelector('.kikx-user-message__prompt-content--user-fallback');
  assert.ok(mark || fallback);
  if (mark)
    assert.match(mark.textContent, /Please implement it/);
});

test('a user message without a captured prompt still expands with an explanation', () => {
  let element = document.createElement('kikx-user-message-frame');
  document.body.appendChild(element);
  element.updateFrame(userFrame(), {});

  assert.equal(element.querySelector('.kikx-user-message__prompt-summary').textContent, 'Sent prompt unavailable');
  element._renderPrompt();
  assert.match(element.querySelector('.kikx-user-message__prompt-body').textContent, /No sent prompt was captured/);
});
