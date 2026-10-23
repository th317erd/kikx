'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { installDom } from './support/mini-dom.mjs';

installDom();

const { createIcon, iconNames, setIcon } = await import('../../src/client/lib/icons.mjs');

test('the generated icon set exposes every UI icon with a non-empty silhouette', () => {
  for (let name of [ 'brain', 'chat', 'gear', 'crown', 'compaction', 'terminal', 'file-read', 'file-write', 'eyeball', 'quill', 'check', 'lock-locked', 'lock-unlocked', 'search', 'fetch', 'todo', 'mail', 'database', 'output', 'warning', 'info', 'arrow-right', 'dots', 'diamond', 'chevron-left' ]) {
    assert.ok(iconNames().includes(name), `${name} is part of the icon set`);
    let icon = createIcon(name);
    assert.equal(icon.tagName.toLowerCase(), 'svg');
    assert.equal(icon.dataset.icon, name);
    assert.ok(icon.getAttribute('viewBox'));
    assert.ok(icon.querySelector('path')?.getAttribute('d'), `${name} must contain a path`);
  }
});

test('unknown icon names fall back to the neutral diamond', () => {
  let icon = createIcon('not-an-icon');
  assert.equal(icon.dataset.icon, 'not-an-icon');
  assert.ok(icon.querySelector('path'));
});

test('setIcon replaces the previous icon and records the semantic name', () => {
  let host = document.createElement('span');
  setIcon(host, 'brain');
  assert.equal(host.dataset.icon, 'brain');
  assert.equal(host.querySelector('svg')?.dataset.icon, 'brain');

  setIcon(host, 'gear');
  assert.equal(host.dataset.icon, 'gear');
  assert.equal(host.querySelectorAll('svg').length, 1);
  assert.equal(host.querySelector('svg')?.dataset.icon, 'gear');
});

test('labelled icons expose an accessible role and name', () => {
  let icon = createIcon('warning', { label: 'Warning' });
  assert.equal(icon.getAttribute('role'), 'img');
  assert.equal(icon.getAttribute('aria-label'), 'Warning');
  assert.equal(icon.getAttribute('aria-hidden'), 'false');
});
