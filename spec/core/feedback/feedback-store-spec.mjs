'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { FeedbackStore } from '../../../src/core/feedback/index.mjs';

test('FeedbackStore writes searchable markdown reports to the global feedback folder', async () => {
  let aeordb = createClient();
  let store = new FeedbackStore({
    aeordb,
    idGenerator: () => 'ABC123',
    clock: () => '2026-06-18T21:00:00.000Z',
  });

  let result = await store.createFeedback({
    title: 'Agent router dropped a message',
    severity: 'high',
    category: 'routing',
    report: 'The coordinator routed the frame, but the target agent never saw it.',
    steps: [
      'Invite two agents.',
      'Mention the second agent.',
    ],
    expected: 'Target agent receives the frame.',
    actual: 'No response was produced.',
    impact: 'Agents cannot coordinate reliably.',
    recommendation: 'Inspect route target selection.',
  }, {
    agent: { id: 'agent_1', name: 'Iron-Hand' },
    session: { id: 'ses_1' },
    frame: { id: 'frm_1' },
  });

  assert.equal(result.id, 'ABC123');
  assert.equal(result.path, '/feedback/feedback-ABC123.md');
  assert.equal(result.severity, 'high');
  assert.equal(aeordb.calls[0].path, '/feedback/feedback-ABC123.md');
  assert.equal(aeordb.calls[0].options.contentType, 'text/markdown; charset=utf-8');
  assert.match(aeordb.calls[0].body, /# Agent router dropped a message/);
  assert.match(aeordb.calls[0].body, /agentID: "agent_1"/);
  assert.match(aeordb.calls[0].body, /sessionID: "ses_1"/);
  assert.match(aeordb.calls[0].body, /1\. Invite two agents\./);
  assert.match(aeordb.calls[0].body, /## Recommendation/);
});

test('FeedbackStore requires a report title', async () => {
  let store = new FeedbackStore({
    aeordb: createClient(),
  });

  await assert.rejects(
    () => store.createFeedback({ report: 'Missing title.' }),
    /title must be a non-empty string/,
  );
});

function createClient() {
  return {
    calls: [],
    async putFile(path, body, options = {}) {
      this.calls.push({ path, body, options });
      return { path };
    },
  };
}
