'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

import { installDom } from './support/mini-dom.mjs';

register(new URL('./support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);
installDom();

const { incomingFrameMatchesWindow } = await import('../../src/client/components/kikx-runtime-events.mjs');

const STATE = {
  selectedSessionID: 'ses_1',
  sessionSearch: 'frmfltr',
  frameFilters: {
    agent: true,
    user: true,
    sessions: true,
    tools: true,
    commands: true,
    questions: true,
    compaction: true,
    deleted: false,
  },
};

test('live frames enter the selected thread only when they match the current window filter', () => {
  assert.equal(incomingFrameMatchesWindow({
    type: 'AgentMessage',
    content: { text: 'frame filter popup' },
  }, 'ses_1', STATE), true);

  assert.equal(incomingFrameMatchesWindow({
    type: 'AgentMessage',
    content: { text: 'unrelated status' },
  }, 'ses_1', STATE), false);

  // Other sessions still receive their frames so their cards/previews update.
  assert.equal(incomingFrameMatchesWindow({
    type: 'AgentMessage',
    content: { text: 'unrelated status' },
  }, 'ses_2', STATE), true);
});

test('live frames respect category filters and the deleted gate', () => {
  let state = {
    ...STATE,
    sessionSearch: '',
    frameFilters: { ...STATE.frameFilters, agent: false },
  };

  assert.equal(incomingFrameMatchesWindow({
    type: 'AgentMessage',
    content: { text: 'agent text' },
  }, 'ses_1', state), false);

  assert.equal(incomingFrameMatchesWindow({
    type: 'UserMessage',
    content: { text: 'user text' },
  }, 'ses_1', state), true);

  assert.equal(incomingFrameMatchesWindow({
    type: 'UserMessage',
    deleted: true,
    content: { text: 'deleted text' },
  }, 'ses_1', state), false);

  let hiddenReveal = { ...state, frameFilters: { ...state.frameFilters, user: true, deleted: true } };
  assert.equal(incomingFrameMatchesWindow({
    type: 'UserMessage',
    hidden: true,
    content: { text: 'hidden text' },
  }, 'ses_1', hiddenReveal), true);
});
