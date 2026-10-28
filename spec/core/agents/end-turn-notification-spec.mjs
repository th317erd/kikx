'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildEndTurnNotice,
  notifyCoordinatorOfEndTurn,
} from '../../../src/core/agents/end-turn-notification.mjs';

function runtimeFor(sessions = []) {
  let byID = new Map(sessions.map((session) => [ session.id, session ]));
  return {
    async ensureSessionEntry(id) {
      return { session: byID.get(id) || null };
    },
    getSession(id) {
      return byID.get(id) || null;
    },
  };
}

function session(overrides = {}) {
  return {
    id: 'session',
    parentSessionID: null,
    participantAgentIDs: [],
    coordinatorAgentID: null,
    ...overrides,
  };
}

test('the end-turn notice names the bot, session, summary, and validation duty', () => {
  let text = buildEndTurnNotice({
    agentID: 'bot-a',
    sessionID: 'session-child',
    summary: 'Finished the parser fix.\n\n- Added a regression.\n- Ran the focused suite.',
  });

  assert.match(text, /Bot bot-a in session session-child has stopped/);
  assert.match(text, /finished with its work, or needs assistance/);
  assert.match(text, /Finished the parser fix/);
  assert.match(text, /Coordinator validation required/);
  assert.match(text, /prove that all of the bot's work is complete and that no gaps remain/);
  assert.match(text, /hypotheticals, unknowns, impossible cases, not-thought-of cases, and edge cases/);
  assert.match(text, /bulleted list of all checks you performed/);
});

test('a coordinator that is not the sender receives the notice in its own session', async () => {
  let sessions = [
    session({
      id: 'child',
      parentSessionID: 'parent',
      participantAgentIDs: [ 'child-bot' ],
      coordinatorAgentID: 'child-bot',
    }),
    session({
      id: 'parent',
      participantAgentIDs: [ 'parent-bot' ],
      coordinatorAgentID: 'parent-bot',
    }),
  ];
  let posts = [];
  let result = await notifyCoordinatorOfEndTurn({
    context: {
      agent: { id: 'child-bot' },
      session: sessions[0],
      frame: { id: 'end-frame' },
      services: { frameRuntime: runtimeFor(sessions) },
    },
    summary: 'Child work complete.',
    postMessage: async (input) => {
      posts.push(input);
      return { frame: { id: 'notice-frame' } };
    },
  });

  assert.equal(result.posted, true);
  assert.equal(result.coordinatorAgentID, 'parent-bot');
  assert.equal(result.coordinatorSessionID, 'parent');
  assert.equal(result.frameID, 'notice-frame');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].sessionID, 'parent');
  assert.equal(posts[0].targetAgentID, 'parent-bot');
  assert.equal(posts[0].sourceSessionID, 'child');
  assert.equal(posts[0].sourceFrameID, 'end-frame');
  assert.match(posts[0].text, /Bot child-bot in session child has stopped/);
  assert.match(posts[0].text, /Child work complete\./);
});

test('the nearest non-self coordinator is used even when the sender coordinates its own session', async () => {
  let sessions = [
    session({
      id: 'child',
      parentSessionID: 'parent',
      participantAgentIDs: [ 'child-bot' ],
      coordinatorAgentID: 'child-bot',
    }),
    session({
      id: 'parent',
      participantAgentIDs: [ 'other-coordinator' ],
      coordinatorAgentID: 'other-coordinator',
    }),
  ];
  let posts = [];
  let result = await notifyCoordinatorOfEndTurn({
    context: {
      agent: { id: 'child-bot' },
      session: sessions[0],
      services: { frameRuntime: runtimeFor(sessions) },
    },
    summary: 'Done.',
    postMessage: async (input) => {
      posts.push(input);
      return { frame: { id: 'f' } };
    },
  });

  assert.equal(result.posted, true);
  assert.equal(result.coordinatorAgentID, 'other-coordinator');
  assert.equal(posts[0].sessionID, 'parent');
});

test('a coordinator already present in the child session is notified there', async () => {
  let sessions = [
    session({
      id: 'child',
      parentSessionID: 'parent',
      participantAgentIDs: [ 'child-bot', 'supervisor' ],
      coordinatorAgentID: 'supervisor',
    }),
    session({
      id: 'parent',
      participantAgentIDs: [ 'parent-bot' ],
      coordinatorAgentID: 'parent-bot',
    }),
  ];
  let result = await notifyCoordinatorOfEndTurn({
    context: {
      agent: { id: 'child-bot' },
      session: sessions[0],
      services: { frameRuntime: runtimeFor(sessions) },
    },
    summary: 'Done.',
    postMessage: async () => ({ frame: { id: 'f' } }),
  });

  assert.equal(result.posted, true);
  assert.equal(result.coordinatorAgentID, 'supervisor');
  assert.equal(result.coordinatorSessionID, 'child');
});

test('a coordinator that also coordinates the parent is notified in the parent session', async () => {
  let sessions = [
    session({
      id: 'child',
      parentSessionID: 'parent',
      participantAgentIDs: [ 'child-bot', 'same-bot' ],
      coordinatorAgentID: 'same-bot',
    }),
    session({
      id: 'parent',
      participantAgentIDs: [ 'same-bot' ],
      coordinatorAgentID: 'same-bot',
    }),
  ];
  let posts = [];
  let result = await notifyCoordinatorOfEndTurn({
    context: {
      agent: { id: 'child-bot' },
      session: sessions[0],
      services: { frameRuntime: runtimeFor(sessions) },
    },
    summary: 'Child work complete.',
    postMessage: async (input) => {
      posts.push(input);
      return { frame: { id: 'parent-notice' } };
    },
  });

  assert.equal(result.posted, true);
  assert.equal(result.coordinatorAgentID, 'same-bot');
  assert.equal(result.coordinatorSessionID, 'parent');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].sessionID, 'parent');
  assert.equal(posts[0].targetAgentID, 'same-bot');
  assert.equal(posts[0].sourceSessionID, 'child');
});

test('the highest coordinator does not message itself', async () => {
  let sessions = [
    session({
      id: 'child',
      parentSessionID: 'parent',
      participantAgentIDs: [ 'same-bot' ],
      coordinatorAgentID: 'same-bot',
    }),
    session({
      id: 'parent',
      participantAgentIDs: [ 'same-bot' ],
      coordinatorAgentID: 'same-bot',
    }),
  ];
  let posts = 0;
  let result = await notifyCoordinatorOfEndTurn({
    context: {
      agent: { id: 'same-bot' },
      session: sessions[0],
      services: { frameRuntime: runtimeFor(sessions) },
    },
    summary: 'Done.',
    postMessage: async () => {
      posts += 1;
      return { frame: { id: 'f' } };
    },
  });

  assert.equal(result.posted, false);
  assert.equal(result.reason, 'no-parent-coordinator');
  assert.equal(posts, 0);
});

test('a chain with no coordinator posts nothing', async () => {
  let sessions = [
    session({ id: 'child', parentSessionID: 'parent', participantAgentIDs: [ 'child-bot' ] }),
    session({ id: 'parent', participantAgentIDs: [ 'parent-bot' ] }),
  ];
  let result = await notifyCoordinatorOfEndTurn({
    context: {
      agent: { id: 'child-bot' },
      session: sessions[0],
      services: { frameRuntime: runtimeFor(sessions) },
    },
    summary: 'Done.',
    postMessage: async () => ({ frame: { id: 'f' } }),
  });

  assert.equal(result.posted, false);
  assert.equal(result.reason, 'no-parent-coordinator');
});

test('a silent end-turn does not notify', async () => {
  let result = await notifyCoordinatorOfEndTurn({
    context: { agent: { id: 'bot' }, session: { id: 'session' } },
    summary: '',
    details: '',
    postMessage: async () => ({ frame: { id: 'f' } }),
  });

  assert.equal(result.posted, false);
  assert.equal(result.reason, 'missing-context');
});

test('details are used as the notice body when the summary is empty', async () => {
  let sessions = [
    session({ id: 'child', parentSessionID: 'parent', participantAgentIDs: [ 'child-bot' ], coordinatorAgentID: 'child-bot' }),
    session({ id: 'parent', participantAgentIDs: [ 'parent-bot' ], coordinatorAgentID: 'parent-bot' }),
  ];
  let posts = [];
  let result = await notifyCoordinatorOfEndTurn({
    context: {
      agent: { id: 'child-bot' },
      session: sessions[0],
      services: { frameRuntime: runtimeFor(sessions) },
    },
    summary: '',
    details: 'Detailed proof of completion.',
    postMessage: async (input) => {
      posts.push(input);
      return { frame: { id: 'f' } };
    },
  });

  assert.equal(result.posted, true);
  assert.match(posts[0].text, /Detailed proof of completion\./);
});
