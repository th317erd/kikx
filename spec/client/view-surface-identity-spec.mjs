'use strict';

// =============================================================================
// A plugin view surface is one element, not a new one per paint (P4)
// =============================================================================
// The campaign (docs/plans/plugin-platform-campaign.md -> P4) still lists one
// open item: "proving a plugin view survives reload/removal without losing the
// user's focus and selection".
//
// The defect these tests exist for, measured before the change:
//
//   `buildDescriptorSurface()` called `document.createElement(tagName)` on every
//   resolve, and `renderAppShell()` calls `resolveViewSurface()` on every paint
//   after `$(app).empty()`. So the element the user was standing on was discarded
//   and a fresh one built each render, with nothing carried across. Its internal
//   state -- scroll position, which row was open, the caret -- lived only in that
//   element, so a re-render silently reset the view.
//
//   Reusing one element per surface is the enabling mechanism. It is necessary
//   and NOT sufficient for focus: detaching a node blurs it, so caret and
//   document.activeElement must be restored separately. These tests pin the
//   mechanism only; they do not claim focus survives a render.
//
// What is pinned here:
//   1. two resolves of the same plugin view return the SAME element;
//   2. the element survives an intervening detach (the empty-and-rebuild cycle);
//   3. a different surface gets a different element;
//   4. a re-resolve refreshes state and app rather than re-creating;
//   5. a view whose tag was never defined still resolves to null (no regression on
//      the broken-install path);
//   6. after the descriptor disappears the surface resolves to null, so the shell
//      falls back to the window instead of rendering a stale element.

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

import { installDom } from './support/mini-dom.mjs';

register(new URL('./support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);

installDom();

const { resolveViewSurface } = await import('../../src/client/components/client-view-surfaces.mjs');

// A descriptor as the server sends it: kind 'view', with a surfaceID the client
// registers as an addressable view name, and a custom-element tag.
function descriptor(surfaceID, tagName = 'kikx-probe-view') {
  return { kind: 'view', surfaceID, tagName, moduleURL: `/plugins/${surfaceID}/index.mjs` };
}

function stateWith(surfaces) {
  return { clientViewSurfaces: surfaces };
}

function fakeApp() {
  return { _state: {}, probe: true };
}

test('the same plugin view resolves to the same element across renders', () => {
  let state = stateWith({ 'probe-one': descriptor('probe-one') });
  let app = fakeApp();

  let first = resolveViewSurface('probe-one', state, app);
  let second = resolveViewSurface('probe-one', state, app);

  assert.ok(first, 'the first resolve must produce an element');
  assert.equal(first, second, 'a re-resolve must reuse the element, not build a new one');
});

test('the element survives being detached, as the shell rebuild detaches it', () => {
  let state = stateWith({ 'probe-two': descriptor('probe-two') });
  let app = fakeApp();

  let first = resolveViewSurface('probe-two', state, app);
  assert.ok(first);

  // renderAppShell() does exactly this: build the new tree, then empty the app.
  let host = document.createElement('div');
  host.appendChild(first);
  host.removeChild(first);
  assert.equal(first.isConnected, false, 'precondition: the detach really happened');

  let second = resolveViewSurface('probe-two', state, app);
  assert.equal(second, first, 'detaching must not cause a replacement element');
  assert.equal(second.isConnected, false, 'reuse must not reattach on its own');
});

test('distinct surfaces get distinct elements', () => {
  let state = stateWith({
    'probe-a': descriptor('probe-a', 'kikx-probe-a'),
    'probe-b': descriptor('probe-b', 'kikx-probe-b'),
  });
  let app = fakeApp();

  let a = resolveViewSurface('probe-a', state, app);
  let b = resolveViewSurface('probe-b', state, app);

  assert.ok(a);
  assert.ok(b);
  assert.notEqual(a, b, 'a per-surface cache must not collapse two surfaces onto one node');
  assert.equal(a.localName, 'kikx-probe-a');
  assert.equal(b.localName, 'kikx-probe-b');
});

test('a reused element is handed the current state and app, not the first one', () => {
  let firstState = stateWith({ 'probe-refresh': descriptor('probe-refresh') });
  let secondState = { clientViewSurfaces: firstState.clientViewSurfaces, generation: 2 };
  let app = fakeApp();

  let element = resolveViewSurface('probe-refresh', firstState, app);
  assert.equal(element.appState, firstState, 'first resolve binds the first state');

  resolveViewSurface('probe-refresh', secondState, app);
  assert.equal(element.appState, secondState, 'a re-resolve must refresh the bound state');
  assert.equal(element.app, app);
});

test('a view whose element was never defined still resolves to null', () => {
  // The broken-install path. mini-dom creates an element for any tag name, so the
  // real guard is the shape check: a descriptor with no tagName cannot render.
  let state = stateWith({ 'probe-broken': { kind: 'view', surfaceID: 'probe-broken' } });
  let app = fakeApp();

  assert.equal(resolveViewSurface('probe-broken', state, app), null);
});

test('a removed descriptor stops resolving, so the shell falls back to the window', () => {
  let state = stateWith({ 'probe-gone': descriptor('probe-gone') });
  let app = fakeApp();

  assert.ok(resolveViewSurface('probe-gone', state, app), 'precondition: it renders while registered');

  // The plugin was unloaded: the inventory no longer lists the surface.
  delete state.clientViewSurfaces['probe-gone'];

  assert.equal(
    resolveViewSurface('probe-gone', state, app),
    null,
    'an unloaded surface must resolve to null, not to a stale cached element',
  );
});
