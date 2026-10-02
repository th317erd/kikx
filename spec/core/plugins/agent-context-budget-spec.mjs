'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  budgetForModel,
  estimateTokens,
  fitMessagesToBudget,
} from '../../../src/core/plugins/agent-context-budget.mjs';

test('estimateTokens uses a chars/4 fallback and is at least 1', () => {
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('a'.repeat(40)), 10);
  assert.equal(estimateTokens(''), 1);
  assert.equal(estimateTokens(null), 1);
  assert.equal(estimateTokens({ a: 1 }), Math.ceil('{"a":1}'.length / 4));
});

test('budgetForModel subtracts tool schemas, prompt reserve and output reserve', () => {
  assert.equal(budgetForModel({ contextWindow: 32768 }), 32768);
  assert.equal(budgetForModel({
    contextWindow: 32768,
    toolsChars: 4000,
    promptReserveTokens: 1000,
    maxOutputTokens: 2000,
  }), 32768 - 1000 - 1000 - 2000);
  assert.equal(budgetForModel({
    contextWindow: 32768,
    reserveChars: 400,
  }), 32768 - 100);
});

test('budgetForModel falls back to a default window and never returns negative', () => {
  assert.equal(budgetForModel({ contextWindow: null }), 32768);
  assert.equal(budgetForModel({ contextWindow: null, defaultContextWindow: 4096 }), 4096);
  assert.equal(budgetForModel({
    contextWindow: 100,
    promptReserveTokens: 1000,
  }), 0);
});

test('fitMessagesToBudget returns the list unchanged when already inside budget', () => {
  let messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hello' },
  ];
  let result = fitMessagesToBudget(messages, { budgetTokens: 1000 });
  assert.deepEqual(result, { messages, trimmed: false, droppedCount: 0 });
});

test('fitMessagesToBudget drops the OLDEST non-protected messages first', () => {
  let messages = [
    { role: 'system', content: 'S' },
    { role: 'user', content: 'oldest-' + 'a'.repeat(400) },
    { role: 'assistant', content: 'older-' + 'b'.repeat(400) },
    { role: 'user', content: 'recent-' + 'c'.repeat(400) },
    { role: 'assistant', content: 'newest-' + 'd'.repeat(400) },
    { role: 'user', content: 'trigger question' },
  ];

  let result = fitMessagesToBudget(messages, { budgetTokens: 130 });
  assert.equal(result.trimmed, true);
  assert.ok(result.droppedCount >= 1);
  // System stays.
  assert.equal(result.messages[0].role, 'system');
  // Newest user trigger stays.
  assert.equal(result.messages.at(-1).content, 'trigger question');
  // The oldest context is what disappeared.
  assert.equal(result.messages.some((message) => String(message.content).startsWith('oldest-')), false);
  // It is deterministic.
  let again = fitMessagesToBudget(messages, { budgetTokens: 130 });
  assert.deepEqual(again, result);
});

test('fitMessagesToBudget always keeps the system message and the newest user turn', () => {
  let messages = [
    { role: 'system', content: 'sys' },
    { role: 'assistant', content: 'x'.repeat(4000) },
    { role: 'user', content: 'prior user turn' },
    { role: 'assistant', content: 'y'.repeat(4000) },
    { role: 'user', content: 'the current question' },
  ];

  let result = fitMessagesToBudget(messages, { budgetTokens: 10, keepRecent: 2 });
  assert.equal(result.messages[0].role, 'system');
  assert.equal(result.messages.at(-1).role, 'user');
  assert.equal(result.messages.at(-1).content, 'the current question');
  // The last two (the most recent exchange + trigger) are protected.
  assert.equal(result.messages.length, 3);
  assert.equal(result.messages.some((message) => message.content === 'x'.repeat(4000)), false);
  assert.equal(result.messages.some((message) => message.content === 'prior user turn'), false);
  assert.equal(result.trimmed, true);
});

test('fitMessagesToBudget keeps at least the last keepRecent messages', () => {
  let messages = [
    { role: 'system', content: 'sys' },
    { role: 'assistant', content: 'old-' + 'a'.repeat(400) },
    { role: 'assistant', content: 'kept assistant' },
    { role: 'user', content: 'recent user' },
  ];

  let result = fitMessagesToBudget(messages, { budgetTokens: 1, keepRecent: 2 });
  assert.equal(result.messages.length, 3);
  assert.equal(result.messages.at(-1).content, 'recent user');
  assert.equal(result.messages.at(-2).content, 'kept assistant');
  assert.equal(result.messages.some((message) => String(message.content).startsWith('old-')), false);
});

test('fitMessagesToBudget honours protectedIndexes and protectedRoles', () => {
  let messages = [
    { role: 'system', content: 'sys' },
    { role: 'system', content: 'pinned-context-' + 'z'.repeat(400) },
    { role: 'user', content: 'mid' + 'a'.repeat(400) },
    { role: 'user', content: 'trigger' },
  ];

  let result = fitMessagesToBudget(messages, {
    budgetTokens: 60,
    protectedRoles: [ 'system' ],
    protectedIndexes: [ 1 ],
  });
  assert.equal(result.messages.some((message) => String(message.content).startsWith('pinned-context-')), true);
  assert.equal(result.messages.at(-1).content, 'trigger');
});

test('fitMessagesToBudget protects Brief A (the start brief) from trimming', () => {
  let messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'Kikx Advanced Agent Harness - v0.1.0\n' + 'p'.repeat(400) },
    { role: 'user', content: 'oldest-' + 'a'.repeat(400) },
    { role: 'assistant', content: 'older-' + 'b'.repeat(400) },
    { role: 'user', content: 'trigger' },
  ];

  let result = fitMessagesToBudget(messages, { budgetTokens: 150 });
  assert.equal(result.trimmed, true);
  assert.equal(result.messages.some((message) => String(message.content).startsWith('Kikx Advanced Agent Harness - v')), true);
  assert.equal(result.messages.some((message) => String(message.content).startsWith('oldest-')), false);

  // Opting out lets the start brief be trimmed like any other user turn.
  let loose = fitMessagesToBudget(messages, { budgetTokens: 60, protectStartBrief: false, keepRecent: 1 });
  assert.equal(loose.messages.some((message) => String(message.content).startsWith('Kikx Advanced Agent Harness - v')), false);
});

test('fitMessagesToBudget does not mutate its input and handles empty input', () => {
  let messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'a'.repeat(4000) },
    { role: 'user', content: 'trigger' },
  ];
  let snapshot = JSON.parse(JSON.stringify(messages));
  fitMessagesToBudget(messages, { budgetTokens: 5 });
  assert.deepEqual(messages, snapshot);
  assert.deepEqual(fitMessagesToBudget([], { budgetTokens: 5 }), { messages: [], trimmed: false, droppedCount: 0 });
  assert.deepEqual(fitMessagesToBudget(null, { budgetTokens: 5 }), { messages: [], trimmed: false, droppedCount: 0 });
});
