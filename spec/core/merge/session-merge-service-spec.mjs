'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { FrameEngine } from '../../../src/core/frames/index.mjs';
import { FrameContextBuilder } from '../../../src/core/compaction/frame-context-builder.mjs';
import { buildCompactionFrame } from '../../../src/core/compaction/compaction-frame.mjs';
import { SessionMergeService } from '../../../src/core/merge/session-merge-service.mjs';

function frame(id, type, text, order, tokens) {
  return {
    id,
    type,
    sessionID: null,
    authorType: type === 'UserMessage' ? 'user' : 'agent',
    authorID: type === 'UserMessage' ? 'user_1' : 'agent_1',
    authorDisplayName: type === 'UserMessage' ? 'Wyatt' : 'Agent',
    createdAt: order,
    updatedAt: order,
    order,
    hidden: false,
    deleted: false,
    content: { text, tokens },
  };
}

function createHarness({ closeSessions = false, budget = 5000 } = {}) {
  let calls = [];
  let closed = [];
  let scheduled = 0;
  let active = 0;
  let maxActive = 0;
  let sessions = new Map([
    [ 'target', { id: 'target', title: 'Target' } ],
    [ 'source-a', { id: 'source-a', title: 'Source A' } ],
    [ 'source-b', { id: 'source-b', title: 'Source B' } ],
  ]);
  let engines = new Map([
    [ 'target', new FrameEngine() ],
    [ 'source-a', new FrameEngine() ],
    [ 'source-b', new FrameEngine() ],
  ]);
  engines.get('target').merge([ frame('target-1', 'UserMessage', 'target memory', 1, 8000) ]);
  engines.get('source-a').merge([ frame('source-a-1', 'AgentMessage', 'source A memory', 1, 2000) ]);
  engines.get('source-b').merge([ frame('source-b-1', 'AgentMessage', 'source B memory', 1, 3000) ]);

  let runtime = {
    async ensureSessionEntry(sessionID) {
      return { session: sessions.get(sessionID), frameEngine: engines.get(sessionID) };
    },
    pinSession() {},
    unpinSession() {},
    frameStore: { async flush() {} },
    async deleteSession(sessionID) {
      closed.push(sessionID);
      sessions.get(sessionID).deletedAt = 1;
      return sessions.get(sessionID);
    },
    async processScheduledFrames() { scheduled++; },
    async emitRuntimeEvent() {},
  };

  let realContextBuilder = new FrameContextBuilder({ estimateTokens: () => 1 });
  let compactionService = {
    contextBuilder: {
      context(frames) {
        return realContextBuilder.context(frames);
      },
      countFrameTokens(frames) {
        return frames.reduce((sum, entry) => sum + (Number(entry.content?.tokens) || 1), 0);
      },
      estimateTokens() { return 1; },
    },
    createCompactionFrame(input) {
      return buildCompactionFrame({
        ...input,
        id: 'merge-frame-1',
        now: 1000,
      });
    },
    instructions: 'base instructions',
  };

  let storeValues = new Map();
  let store = {
    async save(job) { storeValues.set(job.id, JSON.parse(JSON.stringify(job))); },
    async get(id) { return storeValues.get(id) || null; },
    async list() { return [ ...storeValues.values() ]; },
  };

  let service = new SessionMergeService({
    frameRuntime: runtime,
    compactionService,
    store,
    idGenerator: () => 'merge-test-1',
    clock: () => 1000,
    createSummaryRunner: async () => ({ contextBudget: budget, compactorAgent: { id: 'compactor', name: 'Compactor' } }),
    async summarizeSections({ sections }) {
      if (sections.length > 1)
        return 'MERGED CONTEXT';
      let section = sections[0];
      calls.push(section.sessionID);
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
      return `SUMMARY ${section.sessionID}`;
    },
  });

  return {
    service,
    runtime,
    sessions,
    engines,
    calls,
    closed,
    get scheduled() { return scheduled; },
    get maxActive() { return maxActive; },
    closeSessions,
    budget,
  };
}

async function waitFor(predicate, timeoutMS = 1000) {
  let started = Date.now();
  while (Date.now() - started < timeoutMS) {
    let result = await predicate();
    if (result)
      return result;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for condition');
}

test('parallel session summaries feed one merge frame in the target session', async () => {
  let harness = createHarness();
  let started = await harness.service.startMerge({
    targetSessionID: 'target',
    sessionIDs: [ 'target', 'source-a', 'source-b' ],
    requestedByAgentID: 'agent_1',
    requestedByFrameID: 'frame_1',
  });

  let job = await waitFor(async () => {
    let current = await harness.service.getMerge(started.mergeID);
    return current?.status === 'complete' ? current : null;
  });

  assert.deepEqual(job.compactedSessionIDs, [ 'target', 'source-b' ]);
  assert.deepEqual(job.untouchedSessionIDs, [ 'source-a' ]);
  assert.equal(harness.calls.includes('target'), true);
  assert.equal(harness.calls.includes('source-b'), true);
  assert.equal(harness.maxActive, 2, 'the two selected sessions compact in parallel');

  let merged = harness.engines.get('target').get('merge-frame-1');
  assert.ok(merged, 'the merge frame is stored in the target session');
  assert.equal(merged.content.summary, 'MERGED CONTEXT');
  assert.equal(merged.content.merge.targetSessionID, 'target');
  assert.deepEqual(merged.content.merge.compactedSessionIDs, [ 'target', 'source-b' ]);
  assert.deepEqual(merged.content.merge.untouchedSessionIDs, [ 'source-a' ]);
  assert.equal(harness.scheduled, 1, 'the coordinator receives a completion wake');
  assert.deepEqual(harness.closed, [], 'sessions stay open by default');
});

test('close_sessions soft-deletes only the source sessions after the merge frame is stored', async () => {
  let harness = createHarness({ closeSessions: true });
  let started = await harness.service.startMerge({
    targetSessionID: 'target',
    sessionIDs: [ 'target', 'source-a', 'source-b' ],
    closeSessions: true,
    requestedByAgentID: 'agent_1',
  });

  let job = await waitFor(async () => {
    let current = await harness.service.getMerge(started.mergeID);
    return current?.status === 'complete' ? current : null;
  });

  assert.deepEqual(job.closedSessionIDs, [ 'source-a', 'source-b' ]);
  assert.deepEqual(harness.closed, [ 'source-a', 'source-b' ]);
  assert.equal(harness.sessions.get('target').deletedAt, undefined);
  assert.ok(harness.engines.get('target').get('merge-frame-1'), 'the merge frame is durable before closing');
});
