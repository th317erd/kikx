'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { FrameRuntime } from '../../../src/core/runtime/frame-runtime.mjs';

function createFrameStore() {
  let sessions = new Map();
  let framesBySession = new Map();
  let bucketFor = (sessionID) => {
    if (!framesBySession.has(sessionID))
      framesBySession.set(sessionID, new Map());
    return framesBySession.get(sessionID);
  };

  return {
    async saveSession(session) { sessions.set(session.id, clone(session)); },
    async saveSessionManifest(session) { sessions.set(session.id, clone(session)); },
    async loadSession(sessionID) { return sessions.has(sessionID) ? clone(sessions.get(sessionID)) : null; },
    async listSessions() { return [ ...sessions.values() ].map(clone); },
    async listFrames(sessionID) { return [ ...bucketFor(sessionID).values() ].map(clone); },
    async listScheduledFrames() { return []; },
    async flush() {},
    async ensureIndexConfigs() {},
    connect(engine, options = {}) {
      let bucket = bucketFor(options.sessionID);
      let handler = ({ frames }) => {
        for (let frame of frames || [])
          bucket.set(frame.id, clone(frame));
      };
      engine.on('commit', handler);
      return () => engine.off('commit', handler);
    },
  };
}

function createRuntime() {
  let index = 0;
  return new FrameRuntime({
    frameStore: createFrameStore(),
    clock: () => 1000 + index,
    idGenerator: () => `id_${++index}`,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  });
}

function userMessage(overrides = {}) {
  return {
    id: 'msg_1',
    type: 'UserMessage',
    sessionID: 'ses_1',
    authorType: 'user',
    authorID: 'usr_1',
    hidden: false,
    deleted: false,
    timestamp: 1,
    createdAt: 1,
    updatedAt: 1,
    content: { text: 'Please implement it.' },
    ...overrides,
  };
}

test('recordModelPrompt attaches the exact message list to the triggering user message', async () => {
  let runtime = createRuntime();
  let session = await runtime.createSession({ id: 'ses_1', title: 'Prompt capture' });
  let entry = await runtime.ensureSessionEntry(session.id);
  entry.frameEngine.merge([ userMessage() ], { authorType: 'user', authorID: 'usr_1' });

  await runtime.recordModelPrompt(session.id, 'msg_1', {
    agentID: 'agent_1',
    agentName: 'Zav',
    userText: 'Please implement it.',
    messages: [
      { role: 'system', content: 'System rules' },
      { role: 'user', content: 'Message from Wyatt:\nPlease implement it.\n\ntodo: none' },
    ],
  });

  let frame = entry.frameEngine.get('msg_1');
  assert.equal(frame.content.text, 'Please implement it.', 'the user-visible text is untouched');
  assert.equal(frame.content.modelPrompt.agentName, 'Zav');
  assert.equal(frame.content.modelPrompt.userText, 'Please implement it.');
  assert.deepEqual(frame.content.modelPrompt.messages, [
    { role: 'system', content: 'System rules' },
    { role: 'user', content: 'Message from Wyatt:\nPlease implement it.\n\ntodo: none' },
  ]);
});

test('recordModelPrompt ignores hidden internal wakes', async () => {
  let runtime = createRuntime();
  let session = await runtime.createSession({ id: 'ses_1', title: 'Prompt capture' });
  let entry = await runtime.ensureSessionEntry(session.id);
  entry.frameEngine.merge([ userMessage({ hidden: true, content: { text: 'internal wake' } }) ], {
    authorType: 'user',
    authorID: 'usr_1',
  });

  let result = await runtime.recordModelPrompt(session.id, 'msg_1', {
    messages: [ { role: 'user', content: 'should not attach' } ],
  });

  assert.equal(result, null);
  assert.equal(entry.frameEngine.get('msg_1').content.modelPrompt, undefined);
});

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}
