'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { installDom } from './support/mini-dom.mjs';

const { document } = installDom();
globalThis.document = document;

await import('../../src/client/components/kikx-coordination-frame.mjs');

function inviteWake(overrides = {}) {
  return {
    id: 'wake-1',
    type: 'UserMessage',
    authorType: 'system',
    authorID: 'internal:session-invite',
    authorDisplayName: 'Kikx session invite',
    targetAgentID: 'agent-worker',
    hidden: true,
    deleted: false,
    content: {
      text: 'You have been invited to "Bot message visibility" by Zav. Kikx-Node-Eng, review the session context now and wait for the coordinator\'s assignment before changing files.',
      status: 'scheduled',
      agentID: 'agent-worker',
      agentName: 'Kikx-Node-Eng',
      invite: true,
    },
    ...overrides,
  };
}

function mounted(frame = inviteWake()) {
  let element = document.createElement('kikx-coordination-frame');
  document.body.appendChild(element);
  element.updateFrame(frame, {});
  return element;
}

test('the card names who was woken and by whom', () => {
  let element = mounted();

  assert.equal(
    element.querySelector('.kikx-coordination__headline').textContent,
    'Kikx session invite woke Kikx-Node-Eng',
  );
  assert.equal(element.querySelector('.kikx-coordination__meta').textContent, 'from Zav · session “Bot message visibility”');
});

test('the card says it is a system handoff, not a person speaking', () => {
  let element = mounted();
  assert.equal(element.querySelector('.kikx-coordination__eyebrow').textContent, 'System handoff');

  // The instruction is present but closed, so the thread gains one line, not a
  // pasted brief.
  assert.equal(element.expanded, false);
  assert.equal(element.querySelector('.kikx-coordination__summary').textContent, 'Show instruction');
  assert.match(
    element.querySelector('.kikx-coordination__instruction').textContent,
    /review the session context now/,
  );
  // The invitee name is not duplicated into the instruction body.
  assert.doesNotMatch(
    element.querySelector('.kikx-coordination__instruction').textContent,
    /You have been invited/,
  );
});

test('the instruction expands and collapses on request', () => {
  let element = mounted();

  assert.equal(element.toggleExpanded(), true);
  assert.equal(element.expanded, true);
  assert.equal(element.querySelector('.kikx-coordination__summary').textContent, 'Hide instruction');

  assert.equal(element.toggleExpanded(), false);
  assert.equal(element.expanded, false);
  assert.equal(element.querySelector('.kikx-coordination__summary').textContent, 'Show instruction');
});

test('an expanded instruction survives a re-render of the same frame', () => {
  // The thread reconciles in place; a re-render must not silently collapse what
  // the reader opened.
  let element = mounted();
  element.toggleExpanded();
  element.updateFrame(inviteWake(), {});

  assert.equal(element.expanded, true);
});

test('the instruction is text, never markup', () => {
  let element = mounted(inviteWake({
    content: {
      text: 'You have been invited to "T" by Zav. <img src=x onerror="boom()"> do the thing',
      agentName: 'Kikx-Node-Eng',
    },
  }));

  let body = element.querySelector('.kikx-coordination__instruction');
  // mini-dom renders textContent as text; the point is that the component never
  // routes this string through markdown/HTML on purpose.
  assert.match(body.textContent, /<img src=x onerror="boom\(\)">/);
  assert.equal(body.querySelector?.('img') ?? null, null);
});

test('a wake with no inviter in its text still renders, without inventing one', () => {
  let element = mounted(inviteWake({
    content: { text: 'Context review turn.', agentName: 'Kikx-Node-Eng' },
  }));

  assert.equal(element.querySelector('.kikx-coordination__meta').textContent, '');
  assert.equal(element.querySelector('.kikx-coordination__meta').hidden, true);
  assert.equal(element.querySelector('.kikx-coordination__headline').textContent, 'Kikx session invite woke Kikx-Node-Eng');
  assert.equal(element.querySelector('.kikx-coordination__instruction').textContent, 'Context review turn.');
});

test('the frame itself is not mutated by rendering', () => {
  // `hidden` must still read true for compaction and recovery, which share this
  // frame object once it reaches the store.
  let frame = inviteWake();
  mounted(frame);
  assert.equal(frame.hidden, true);
});
