'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

import { installDom } from './support/mini-dom.mjs';

register(new URL('./support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);
installDom();

const { previewStatusStore } = await import('../../src/client/state/preview-status-store.mjs');
const { setPreviewStatus, setPreviewsLoading } = await import('../../src/client/state/kikx-state.mjs');

test('topbar preview status is exposed through the targeted property store', async () => {
  let records = [];
  let off = previewStatusStore.observeAll((items) => records.push(...items));

  setPreviewsLoading(true);
  setPreviewStatus('Loading session previews…');
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(previewStatusStore.get('loading'), true);
  assert.equal(previewStatusStore.get('status'), 'Loading session previews…');
  assert.ok(records.some((record) => record.key === 'loading'));
  assert.ok(records.some((record) => record.key === 'status'));
  assert.ok(records.every((record) => record.source.startsWith('previews.')));

  setPreviewsLoading(false);
  setPreviewStatus('');
  await new Promise((resolve) => setTimeout(resolve, 0));
  off();
});
