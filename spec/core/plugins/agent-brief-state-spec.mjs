'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  compactionBoundaryKey,
  compactionBoundaryOrder,
  getStartBriefMarker,
  latestCompactionFrame,
  markStartBriefSent,
  newestAgentMessageOrder,
  partySignature,
  shouldSendStartBrief,
} from '../../../src/core/plugins/agent-brief-state.mjs';
import {
  AGIS_PRECEPTS,
  AGIS_PRECEPTS_LINES,
  COORDINATOR_PREAMBLE_LINES,
  START_BRIEF_BANNER_PREFIX,
  isStartBriefText,
  packageVersion,
} from '../../../src/core/plugins/agent-precepts.mjs';
import {
  collectPartyActors,
  countParties,
  hasCoordinatorParties,
  hasMultiparty,
} from '../../../src/core/plugins/agent-participants.mjs';

function context(overrides = {}) {
  return {
    agent: { id: 'agent_1' },
    frame: { id: 'msg_1', type: 'UserMessage', authorType: 'user', authorID: 'usr_1' },
    session: {
      id: 'ses_1',
      participantAgentIDs: [ 'agent_1' ],
      participantUserIDs: [ 'usr_1' ],
      coordinatorAgentID: 'agent_1',
    },
    frames: [],
    ...overrides,
  };
}

test('packageVersion reads package.json.version and is cached', () => {
  let version = packageVersion();
  assert.match(version, /^\d+\.\d+\.\d+/);
  assert.equal(packageVersion(), version);
});

test('the precepts constant carries all six precepts plus Proof', () => {
  assert.match(AGIS_PRECEPTS, /Orient:/);
  assert.match(AGIS_PRECEPTS, /Source:/);
  assert.match(AGIS_PRECEPTS, /Goal:/);
  assert.match(AGIS_PRECEPTS, /Peer:/);
  assert.match(AGIS_PRECEPTS, /Stakes:/);
  assert.match(AGIS_PRECEPTS, /Mode:/);
  assert.match(AGIS_PRECEPTS, /Proof:/);
  assert.ok(AGIS_PRECEPTS_LINES.length >= 10);
  assert.ok(COORDINATOR_PREAMBLE_LINES.some((line) => /COORDINATOR PREAMBLE/.test(line)));
});

test('isStartBriefText recognises the version banner', () => {
  assert.equal(isStartBriefText(`${START_BRIEF_BANNER_PREFIX}1.2.3\nfoo`), true);
  assert.equal(isStartBriefText('Message from User:'), false);
  assert.equal(isStartBriefText(null), false);
});

test('party counting includes users (D3)', () => {
  // 1 agent + 1 user = 2 parties: multiparty, but no coordinator role.
  let two = context();
  assert.equal(countParties(two), 2);
  assert.equal(hasMultiparty(two), true);
  assert.equal(hasCoordinatorParties(two), false);

  // 2 agents + 1 user = 3 parties: coordinator applies.
  let three = context({
    session: {
      id: 'ses_1',
      participantAgentIDs: [ 'agent_1', 'agent_2' ],
      participantUserIDs: [ 'usr_1' ],
      coordinatorAgentID: 'agent_1',
    },
  });
  assert.equal(countParties(three), 3);
  assert.equal(hasCoordinatorParties(three), true);

  let actors = collectPartyActors(three);
  assert.deepEqual(actors.agents.map((agent) => agent.id), [ 'agent_1', 'agent_2' ]);
  assert.deepEqual(actors.users, [ 'usr_1' ]);
});

test('countParties adds the trigger user author when the session list omits them', () => {
  let ctx = context({
    session: { id: 'ses_1', participantAgentIDs: [ 'agent_1' ], coordinatorAgentID: 'agent_1' },
  });
  assert.equal(countParties(ctx), 2);
});

test('shouldSendStartBrief sends on the first message and not on subsequent turns', () => {
  // Share one session object across the turns, as the runtime does.
  let session = context().session;
  let first = shouldSendStartBrief(context({ session }));
  assert.deepEqual(first, { send: true, reason: 'first-message' });

  // Once Brief A has been emitted for this agent, later turns are unchanged.
  markStartBriefSent(context({ session }));
  let second = shouldSendStartBrief(context({
    session,
    frames: [ { id: 'agent_msg_1', type: 'AgentMessage', authorID: 'agent_1', order: 3 } ],
  }));
  assert.equal(second.send, false);
  assert.equal(second.reason, 'unchanged');
});

test('shouldSendStartBrief re-sends after a compaction boundary advances', () => {
  let session = context().session;
  markStartBriefSent(context({
    session,
    frames: [ { id: 'agent_msg_1', type: 'AgentMessage', authorID: 'agent_1', order: 3 } ],
  }));

  let ctx = context({
    session,
    frames: [
      { id: 'cmp_1', type: 'CompactionFrame', hidden: true, order: 5, content: { kind: 'compaction_frame', boundaryOrder: 5, boundaryFrameID: 'b5', summary: 'memory' } },
      { id: 'agent_msg_1', type: 'AgentMessage', authorID: 'agent_1', order: 3 },
    ],
  });
  assert.deepEqual(shouldSendStartBrief(ctx), { send: true, reason: 'compaction' });
});

test('shouldSendStartBrief re-sends when the coordinator changes', () => {
  let ctx = context({
    frames: [ { id: 'agent_msg_1', type: 'AgentMessage', authorID: 'agent_1', order: 3 } ],
  });
  markStartBriefSent(ctx);
  let marker = getStartBriefMarker(ctx.session);
  marker.agents.agent_1.coordinatorID = 'agent_2';
  assert.deepEqual(shouldSendStartBrief(ctx), { send: true, reason: 'coordinator-changed' });
});

test('shouldSendStartBrief re-sends when the participant set changes (new agent joins)', () => {
  let ctx = context({
    frames: [ { id: 'agent_msg_1', type: 'AgentMessage', authorID: 'agent_1', order: 3 } ],
  });
  markStartBriefSent(ctx);
  ctx.session.participantAgentIDs = [ 'agent_1', 'agent_2' ];
  assert.deepEqual(shouldSendStartBrief(ctx), { send: true, reason: 'participants-changed' });
});

test('shouldSendStartBrief re-sends when a different agent is routed for the first time', () => {
  let ctx = context({
    frames: [ { id: 'agent_msg_1', type: 'AgentMessage', authorID: 'agent_1', order: 3 } ],
  });
  markStartBriefSent(ctx);
  ctx.agent = { id: 'agent_2' };
  ctx.session.participantAgentIDs = [ 'agent_1', 'agent_2' ];
  // A never-briefed agent needs its own Brief A.
  assert.deepEqual(shouldSendStartBrief(ctx), { send: true, reason: 'new-agent' });
});

test('shouldSendStartBrief is per-agent: alternating speakers do not re-send Brief A', () => {
  let agentA = context({
    agent: { id: 'agent_1' },
    frames: [ { id: 'a1', type: 'AgentMessage', authorID: 'agent_1', order: 2 } ],
  });
  markStartBriefSent(agentA);

  // agent_2 speaks (first time) on the SAME session object.
  let sameSession = agentA.session;
  let agentB = context({
    session: sameSession,
    agent: { id: 'agent_2' },
    frames: [ { id: 'a1', type: 'AgentMessage', authorID: 'agent_1', order: 2 } ],
  });
  assert.equal(shouldSendStartBrief(agentB).send, true);
  markStartBriefSent(agentB);

  // Back to agent_1: still briefed, so no re-send.
  let agentAAgain = context({
    session: sameSession,
    agent: { id: 'agent_1' },
    frames: [ { id: 'a1', type: 'AgentMessage', authorID: 'agent_1', order: 2 } ],
  });
  assert.deepEqual(shouldSendStartBrief(agentAAgain), { send: false, reason: 'unchanged' });
});

test('shouldSendStartBrief is suppressed on a completion-review step', () => {
  assert.deepEqual(shouldSendStartBrief(context({ step: { type: 'completion-review' } })), {
    send: false,
    reason: 'completion-review',
  });
});

test('markStartBriefSent records the boundary and party signature in process memory', () => {
  let ctx = context({
    frames: [ { id: 'cmp_1', type: 'CompactionFrame', hidden: true, order: 9, content: { kind: 'compaction_frame', boundaryOrder: 9, boundaryFrameID: 'boundary_9', summary: 'm' } } ],
  });
  markStartBriefSent(ctx);
  let marker = getStartBriefMarker(ctx.session);
  let entry = marker.agents.agent_1;
  assert.equal(entry.coordinatorID, 'agent_1');
  assert.equal(entry.boundaryKey, 'boundary_9');
  assert.equal(entry.parties, 'agent_1,usr_1');
  // The marker must not leak into the serialized session manifest.
  assert.equal(ctx.session.briefState, undefined);
});

test('compaction and agent-message order helpers read the expected fields', () => {
  let cmp = { id: 'cmp_1', type: 'CompactionFrame', order: 7, content: { kind: 'compaction_frame', boundaryOrder: 7, boundaryFrameID: 'b7' } };
  assert.equal(compactionBoundaryOrder(cmp), 7);
  assert.equal(compactionBoundaryKey(cmp), 'b7');
  assert.equal(latestCompactionFrame({ frames: [ cmp ] }), cmp);
  assert.equal(latestCompactionFrame({ frames: [ { ...cmp, content: { ...cmp.content, status: 'started' } } ] }), null);
  assert.equal(latestCompactionFrame({ frames: [ { ...cmp, content: { ...cmp.content, status: 'running' } } ] }), null);
  // P7: a trimmed boundary is a real boundary (it advances Brief A's key).
  let trimmed = { ...cmp, content: { ...cmp.content, status: 'trimmed' } };
  assert.equal(latestCompactionFrame({ frames: [ trimmed ] }), trimmed);

  let newest = newestAgentMessageOrder({
    frames: [
      { id: 'a', type: 'AgentMessage', authorID: 'agent_1', order: 2 },
      { id: 'b', type: 'AgentMessage', authorID: 'agent_1', order: 8 },
      { id: 'c', type: 'AgentMessage', authorID: 'agent_1', order: 5, hidden: true },
    ],
  });
  assert.equal(newest, 8);
  assert.equal(newestAgentMessageOrder({ frames: [] }), null);
});
