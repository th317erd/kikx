'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  compactionCardClass,
  compactionErrors,
  compactionRetryURL,
  compactionRetryable,
  compactionStatusClass,
  compactionSummaryLine,
  compactionWarnings,
  normalizeCompactionIssues,
  normalizeCompactionStatus,
} from '../../src/client/components/kikx-compaction-frame-helpers.mjs';

test('normalizeCompactionStatus maps raw status to the four UI states', () => {
  assert.equal(normalizeCompactionStatus('complete'), 'success');
  assert.equal(normalizeCompactionStatus('success'), 'success');
  assert.equal(normalizeCompactionStatus('failed'), 'error');
  assert.equal(normalizeCompactionStatus('error'), 'error');
  assert.equal(normalizeCompactionStatus('trimmed'), 'trimmed');
  assert.equal(normalizeCompactionStatus('running'), 'running');
  assert.equal(normalizeCompactionStatus(undefined), 'running');
});

test('status and card classes encode the visual state', () => {
  assert.equal(compactionStatusClass('complete'), 'kikx-tool-card__status--success');
  assert.equal(compactionStatusClass('failed'), 'kikx-tool-card__status--error');
  assert.equal(compactionStatusClass('trimmed'), 'kikx-tool-card__status--trimmed');
  assert.equal(compactionStatusClass('running'), 'kikx-tool-card__status--running');

  for (let state of [ 'running', 'success', 'error', 'trimmed' ])
    assert.equal(compactionCardClass(state).includes(`kikx-compaction-card--${state}`), true);
});

test('summary lines reflect status and frame count', () => {
  assert.equal(
    compactionSummaryLine({ status: 'complete', frameCount: 3 }),
    'Compaction complete. 3 frames compressed.',
  );
  assert.equal(
    compactionSummaryLine({ status: 'complete', frameCount: 1 }),
    'Compaction complete. 1 frame compressed.',
  );
  assert.equal(
    compactionSummaryLine({ status: 'trimmed', content: {} }),
    'Compaction failed; context was trimmed to proceed.',
  );
  assert.equal(
    compactionSummaryLine({ status: 'running', frameCount: 2 }),
    'Compacting session context across 2 frames...',
  );
});

test('normalizeCompactionIssues accepts strings/objects and drops empties', () => {
  assert.deepEqual(normalizeCompactionIssues([ 'trimmed to proceed', '', { message: 'provider down', kind: 'network' }, { message: '  ' }, null ]), [
    { message: 'trimmed to proceed', kind: 'compaction' },
    { message: 'provider down', kind: 'network' },
  ]);
  assert.deepEqual(normalizeCompactionIssues(undefined), []);
  assert.deepEqual(normalizeCompactionIssues('single warning'), [ { message: 'single warning', kind: 'compaction' } ]);
});

test('warning and error selectors read the structured content lists', () => {
  let content = {
    warnings: [ { message: 'context trimmed', kind: 'trim' } ],
    errors: [ { message: 'provider exploded', kind: 'compaction' } ],
  };
  assert.deepEqual(compactionWarnings(content), [ { message: 'context trimmed', kind: 'trim' } ]);
  assert.deepEqual(compactionErrors(content), [ { message: 'provider exploded', kind: 'compaction' } ]);
  assert.deepEqual(compactionWarnings({}), []);
});

test('retry is offered only for degraded boundaries', () => {
  assert.equal(compactionRetryable('failed'), true);
  assert.equal(compactionRetryable('error'), true);
  assert.equal(compactionRetryable('trimmed'), true);
  assert.equal(compactionRetryable('complete'), false);
  assert.equal(compactionRetryable('running'), false);
});

test('retry URL targets the session compaction frame', () => {
  assert.equal(
    compactionRetryURL('ses 1', 'cmp/1'),
    '/api/v1/sessions/ses%201/compaction/cmp%2F1/retry',
  );
});
