'use strict';

// S1 error surface: the host class contract. The surface is mounted both inside
// the app shell and as a standalone first-render fallback, so this spec drives
// the real custom element and the real `kikx-app` render paths. It asserts on
// the live class list (`classList`/`matches`), not on the stylesheet's source
// text: a text-only check stayed green while the host carried no base class.

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

import { installDom } from './support/mini-dom.mjs';

register(new URL('./support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);

const { document } = installDom();

const { clearRecentErrors, reportClientError } = await import('../../src/client/lib/error-boundary.mjs');
const { createErrorSurfaceElement } = await import('../../src/client/components/kikx-error-surface.mjs');
await import('../../src/client/components/kikx-app.mjs');

function quietConsole(callback) {
  let original = console.error;
  console.error = () => {};
  try {
    return callback();
  } finally {
    console.error = original;
  }
}

// The stylesheet styles the surface through `.kikx-error-surface` and its
// `--empty`/`__*` variants. Proving the contract means the live DOM class list
// actually satisfies those selectors, not that the CSS source text mentions
// them. The old text-only spec stayed green while the host carried no base
// class at all, so `.kikx-error-surface { position: fixed; ... }` never applied.
test('the error surface host satisfies its stylesheet selectors in every state', () => {
  clearRecentErrors();
  let container = document.createElement('div');

  // Empty store: base class present, --empty present (the empty rule hides it).
  let empty = createErrorSurfaceElement();
  container.appendChild(empty);
  assert.equal(
    empty.classList.contains('kikx-error-surface'),
    true,
    'the host must carry .kikx-error-surface so its base rule applies',
  );
  assert.equal(
    empty.matches('.kikx-error-surface'),
    true,
    'the host must satisfy the stylesheet .kikx-error-surface selector',
  );
  assert.equal(
    empty.classList.contains('kikx-error-surface--empty'),
    true,
    '--empty must be present iff the store is empty',
  );
  assert.equal(empty.matches('.kikx-error-surface--empty'), true);
  assert.equal(
    empty.querySelector('.kikx-error-surface__header'),
    null,
    'an empty store must not render the header/chip controls',
  );
  container.removeChild(empty);

  // Non-empty collapsed store: base class present, --empty absent, header/chip/dismiss present.
  quietConsole(() => reportClientError('boom', new Error('one'), {}));
  let surface = createErrorSurfaceElement();
  container.appendChild(surface);
  assert.equal(
    surface.classList.contains('kikx-error-surface'),
    true,
    'the host must keep .kikx-error-surface when there are errors',
  );
  assert.equal(surface.matches('.kikx-error-surface'), true);
  assert.equal(
    surface.classList.contains('kikx-error-surface--empty'),
    false,
    '--empty must be absent when the store has errors',
  );
  assert.equal(surface.matches('.kikx-error-surface--empty'), false);
  assert.ok(
    surface.querySelector('.kikx-error-surface__header'),
    'the header must use the styled class',
  );
  assert.ok(
    surface.querySelector('.kikx-error-surface__chip'),
    'the chip must use the styled class',
  );
  assert.ok(
    surface.querySelector('.kikx-error-surface__dismiss'),
    'the dismiss button must use the styled class',
  );
  assert.equal(
    surface.querySelector('.kikx-error-surface__list'),
    null,
    'the list must stay collapsed until the chip is clicked',
  );

  // Expanded: chip -> list -> items, and the list announces as an alert.
  surface.querySelector('.kikx-error-surface__chip').dispatchEvent({ type: 'click' });
  let list = surface.querySelector('.kikx-error-surface__list');
  assert.ok(list, 'clicking the chip must expand the list');
  assert.equal(list.getAttribute('role'), 'alert');
  assert.ok(
    surface.querySelector('.kikx-error-surface__item'),
    'each recent error must use the styled item class',
  );
  assert.equal(surface.classList.contains('kikx-error-surface'), true);
  assert.equal(surface.classList.contains('kikx-error-surface--empty'), false);

  container.removeChild(surface);
});

test('the standalone fallback error surface carries the same classes as the in-shell host', () => {
  clearRecentErrors();
  quietConsole(() => reportClientError('parity', new Error('boom'), {}));

  // Normal render: the surface is mounted inside the rebuilt .kikx-shell.
  let app = document.createElement('kikx-app');
  app._buildAuthShell = () => {
    let stub = document.createElement('div');
    stub.className = 'stub-auth-shell';
    return stub;
  };
  app._render();
  let inShell = app.querySelector('.kikx-shell kikx-error-surface');
  assert.ok(inShell, 'the shell render must include an error surface');
  assert.equal(inShell.classList.contains('kikx-error-surface'), true);

  // First-render failure: the same host class contract must hold standalone.
  let brokenApp = document.createElement('kikx-app');
  brokenApp._buildAuthShell = () => {
    throw new Error('first shell exploded');
  };
  quietConsole(() => brokenApp._render());
  let fallback = brokenApp.querySelector('kikx-error-surface');
  assert.ok(fallback, 'a throwing first render must still mount the standalone surface');
  assert.equal(
    fallback.parentNode,
    brokenApp,
    'the fallback must mount directly under the app, outside the failed shell',
  );
  assert.equal(fallback.classList.contains('kikx-error-surface'), true);
  assert.equal(fallback.classList.contains('kikx-error-surface--empty'), false);
  assert.equal(
    fallback.className,
    inShell.className,
    'the fallback host must carry the same classes as the in-shell host',
  );
});
