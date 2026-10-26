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

test('question-answer wakes separate the agent question from the highlighted user answer', () => {
  let text = [
    'The user answered your question (you asked 4m ago):',
    '',
    'Q: Which installer shape should we use?',
    '1. Squashfs payload',
    '2. Installer is the appliance',
    '',
    'A: Keep the squashfs payload and the rollback story.',
    '',
    'References from when you asked:',
    '- file bot-docs/plans/installer.md: Installer design',
    '',
    'Continue from here.',
  ].join('\n');
  let element = document.createElement('kikx-user-message-frame');
  document.body.appendChild(element);
  element.updateFrame(userFrame({ text }), {});

  let context = element.querySelector('.kikx-user-message__context');
  let answer = element.querySelector('.kikx-user-message__answer');
  let after = element.querySelector('.kikx-user-message__after');

  assert.ok(context);
  assert.ok(answer);
  assert.ok(after);
  assert.match(context.textContent, /Q: Which installer shape/);
  assert.doesNotMatch(context.textContent, /Keep the squashfs payload/);
  assert.match(answer.textContent, /A: Keep the squashfs payload/);
  assert.doesNotMatch(answer.textContent, /Q: Which installer shape/);
  assert.match(after.textContent, /References from when you asked/);
  assert.match(after.textContent, /Continue from here\./);
});

test('ordinary user messages are not split into answer panels', () => {
  let element = document.createElement('kikx-user-message-frame');
  document.body.appendChild(element);
  element.updateFrame(userFrame({ text: 'A: this is just ordinary text? yes.' }), {});

  assert.equal(element.querySelector('.kikx-user-message__answer'), null);
  assert.match(element.querySelector('.kikx-user-message__text').textContent, /ordinary text/);
});
