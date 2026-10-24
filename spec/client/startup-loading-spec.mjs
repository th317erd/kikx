'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

import { installDom } from './support/mini-dom.mjs';

register(new URL('./support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);
installDom();

const { buildStartupLoading } = await import('../../src/client/components/kikx-shell-builders.mjs');
const { hasSessionDeepLink } = await import('../../src/client/components/kikx-app-helpers.mjs');

test('deep-linked session URLs are detected before sessions load', () => {
  assert.equal(hasSessionDeepLink('?session=ses_1'), true);
  assert.equal(hasSessionDeepLink('?view=thread'), true);
  assert.equal(hasSessionDeepLink('?view=projects'), false);
  assert.equal(hasSessionDeepLink(''), false);
});

test('the startup loader presents a spinner, message, and indeterminate progress bar', () => {
  let loader = buildStartupLoading();
  loader = typeof loader?.build === 'function' ? loader.build(document) : loader;
  assert.match(loader.textContent, /Loading session/);
  assert.match(loader.textContent, /Restoring messages and scroll position/);
  assert.ok(loader.querySelector('.kikx-startup-loading__spinner'));
  assert.ok(loader.querySelector('.kikx-startup-loading__track .kikx-startup-loading__fill'));
  assert.equal(loader.getAttribute('aria-busy'), 'true');
});
