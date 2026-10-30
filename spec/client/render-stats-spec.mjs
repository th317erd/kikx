'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  countRebuild,
  recordRender,
  renderOutcomes,
  resetRenderStats,
  snapshotRenderStats,
} from '../../src/client/components/render-stats.mjs';

test('render diagnostics record why a full rebuild happened', () => {
  resetRenderStats();
  countRebuild('shell', {
    reason: 'navigation',
    scope: 'session-1',
    structural: true,
    touchedFrameIDs: [ 'frame-1', 'frame-2' ],
  });
  countRebuild('frameItem', { reason: 'frame.content', touchedFrameIDs: [ 'frame-3' ] });

  assert.equal(snapshotRenderStats().shell, 1);
  assert.equal(snapshotRenderStats().frameItem, 1);
  assert.equal(renderOutcomes.length, 2);
  assert.deepEqual(renderOutcomes[0], {
    kind: 'shell',
    reason: 'navigation',
    scope: 'session-1',
    structural: true,
    touchedFrameIDs: [ 'frame-1', 'frame-2' ],
    at: renderOutcomes[0].at,
  });
  assert.equal(renderOutcomes[1].reason, 'frame.content');

  resetRenderStats();
  assert.equal(renderOutcomes.length, 0);
  assert.equal(snapshotRenderStats().shell, 0);
});

test('a caller without diagnostics keeps the hot counter path cheap', () => {
  resetRenderStats();
  countRebuild('shell');
  assert.equal(snapshotRenderStats().shell, 1);
  assert.equal(renderOutcomes.length, 0, 'a plain counter call must not allocate an outcome');

  recordRender('grid', { reason: 'session.saved' });
  assert.equal(renderOutcomes.length, 1);
  assert.equal(renderOutcomes[0].kind, 'grid');
});
