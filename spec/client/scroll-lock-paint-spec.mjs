'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { installDom } from './support/mini-dom.mjs';

const { document } = installDom();
const { paintScrollLockButton } = await import('../../src/client/components/kikx-scroll-lock.mjs');

test('repainting an unchanged scroll-lock state leaves its icon and attributes alone', () => {
  let app = document.createElement('div');
  app._state = { selectedSessionID: 'ses_1' };
  let button = document.createElement('button');
  button.className = 'kikx-session-toolbar__button--lock';
  app.appendChild(button);
  app.querySelector = (selector) => selector === '.kikx-session-toolbar__button--lock' ? button : null;

  paintScrollLockButton(app, 'ses_1', true);
  let icon = button.firstElementChild;
  assert.ok(icon, 'icon was painted');
  let label = button.getAttribute('aria-label');

  paintScrollLockButton(app, 'ses_1', true);
  assert.equal(button.firstElementChild, icon, 'same icon node survives a no-op repaint');
  assert.equal(button.getAttribute('aria-label'), label);

  paintScrollLockButton(app, 'ses_1', false);
  assert.notEqual(button.firstElementChild, icon, 'a state change still repaints');
  assert.equal(button.getAttribute('aria-pressed'), 'false');
});
