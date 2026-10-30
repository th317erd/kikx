'use strict';

// =============================================================================
// Uninstalling a view plugin releases its cached element (P4)
// =============================================================================
// The element cache exists so a plugin view keeps its scroll position, open row
// and caret across the shell's empty-and-rebuild cycle. The obvious failure of
// that design is the other direction: a view that no longer exists must not leave
// a live element -- and the state it was holding -- cached behind a name nothing
// resolves.
//
// `pruneViewSurfaceElements()` would satisfy a unit test on its own and still be
// dead code if nothing called it, which is exactly the mistake campaign P1 caught
// with `CommandRegistry`. So these tests drive the REAL production path:
//
//   setClientComponents(components, state)
//     -> syncViewNames(...)          (the addressable vocabulary)
//     -> pruneViewSurfaceElements()  (the cache follows it)
//
// They are paired with `view-surface-identity-spec.mjs`, which pins the reuse
// side. Together: one element per live surface, none for a dead one.

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

import { installDom } from './support/mini-dom.mjs';

register(new URL('./support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);

installDom();

const { resolveViewSurface, forgetViewSurface } = await import('../../src/client/components/client-view-surfaces.mjs');
const { getViewSurfaceElement, listViewSurfaceElementIDs } = await import('../../src/client/state/view-surface-elements.mjs');
const { setClientComponents } = await import('../../src/client/state/kikx-state.mjs');

function viewDescriptor(surfaceID, tagName) {
  return { kind: 'view', surfaceID, tagName, moduleURL: `/plugins/${surfaceID}/index.mjs` };
}

function freshState() {
  return { clientViewSurfaces: {}, clientSidebarItems: {} };
}

function render(surfaceID, state) {
  return resolveViewSurface(surfaceID, state, { _state: state });
}

test('setClientComponents releases the element of a surface it no longer lists', () => {
  let state = freshState();

  // The plugin is installed and its view is up.
  setClientComponents([ viewDescriptor('probe-live', 'kikx-probe-live') ], state);
  let element = render('probe-live', state);
  assert.ok(element, 'precondition: the view renders while installed');
  assert.equal(getViewSurfaceElement('probe-live'), element, 'precondition: the element is cached');

  // The plugin is unloaded: the inventory no longer carries the descriptor.
  setClientComponents([], state);

  assert.equal(
    getViewSurfaceElement('probe-live'),
    null,
    'an unloaded surface must not keep a cached element',
  );
  assert.equal(render('probe-live', state), null, 'and it must not render any more');
});

test('a surviving surface keeps its element across an inventory change', () => {
  let state = freshState();
  let descriptors = [
    viewDescriptor('probe-keep', 'kikx-probe-keep'),
    viewDescriptor('probe-drop', 'kikx-probe-drop'),
  ];
  setClientComponents(descriptors, state);

  let kept = render('probe-keep', state);
  let dropped = render('probe-drop', state);
  assert.ok(kept);
  assert.ok(dropped);
  assert.notEqual(kept, dropped);

  // Another plugin is uninstalled; this one stays.
  setClientComponents([ viewDescriptor('probe-keep', 'kikx-probe-keep') ], state);

  assert.equal(getViewSurfaceElement('probe-keep'), kept, 'the live surface keeps its exact element');
  assert.equal(getViewSurfaceElement('probe-drop'), null, 'only the dead surface is released');
});

test('a re-registered surface gets a fresh element, not the old one back', () => {
  let state = freshState();
  setClientComponents([ viewDescriptor('probe-cycle', 'kikx-probe-cycle') ], state);
  let before = render('probe-cycle', state);
  assert.ok(before);

  setClientComponents([], state);
  setClientComponents([ viewDescriptor('probe-cycle', 'kikx-probe-cycle') ], state);

  let after = render('probe-cycle', state);
  assert.ok(after, 'the re-installed surface renders again');
  assert.notEqual(after, before, 'a plugin reload must not resume from the unloaded element');
});

test('the cache is keyed per surface, not one slot', () => {
  let state = freshState();
  setClientComponents([
    viewDescriptor('probe-x', 'kikx-probe-x'),
    viewDescriptor('probe-y', 'kikx-probe-y'),
  ], state);

  render('probe-x', state);
  render('probe-y', state);

  let ids = listViewSurfaceElementIDs();
  assert.ok(ids.includes('probe-x'), 'probe-x must be cached');
  assert.ok(ids.includes('probe-y'), 'probe-y must be cached');
});

test('forgetViewSurface releases one surface without touching the others', () => {
  let state = freshState();
  setClientComponents([
    viewDescriptor('probe-a1', 'kikx-probe-a1'),
    viewDescriptor('probe-b1', 'kikx-probe-b1'),
  ], state);

  render('probe-a1', state);
  let keptElement = render('probe-b1', state);

  assert.equal(forgetViewSurface('probe-a1'), true, 'the surface was cached, so this reports a removal');
  assert.equal(forgetViewSurface('probe-a1'), false, 'forgetting twice is a no-op, not an error');
  assert.equal(getViewSurfaceElement('probe-a1'), null);
  assert.equal(getViewSurfaceElement('probe-b1'), keptElement, 'an unrelated surface is untouched');
});
