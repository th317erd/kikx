'use strict';

// =============================================================================
// View surfaces behind descriptors (P4)
// =============================================================================
// The campaign (docs/plans/plugin-platform-campaign.md, P4) requires: "A plugin
// view renders in the main area with no core shell edit", and its P7 exit proof
// states the same thing as a grep gate: "No new `viewName ===` branch".
//
// The defect these tests exist for, measured before the change:
//
//   kikx-shell-builders.mjs:292-296 dispatched the work area with a ternary
//   chain `viewName === 'inbox' ? ... : viewName === 'agents' ? ... :
//   viewName === 'teams' ? ... : buildWindow(...)`. Adding a view meant editing
//   core shell code, which is exactly what P4 forbids.
//
//   Worse, the descriptors could not have worked even if a plugin registered one.
//   `setClientComponents()` (kikx-state.mjs:485) filed only `frame`, `tool` and
//   `agent-config-form` descriptors; `view` and `sidebar-item` were dropped on the
//   floor. So the surface was advertised by the server and discarded by the
//   client -- unreachable, not merely unimplemented.
//
//   And the view vocabulary was a frozen literal in navigation-stack.mjs, so
//   `pushView()` refused any name a plugin contributed even after a successful
//   registration.
//
// These tests pin the contract from five directions:
//   1. a plugin `view` descriptor survives setClientComponents, and its surfaceID
//      becomes an addressable view name;
//   2. dispatch resolves a plugin view with NO core branch on its name;
//   3. core views (Inbox/Agents/Teams) still render, as the fallback;
//   4. an unknown or absent descriptor degrades to the window, never a blank work
//      area and never a throw;
//   5. the shell really dispatches through the resolver (the P7 gate).

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { register } from 'node:module';

import { installDom } from './support/mini-dom.mjs';

register(new URL('./support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);

installDom();

const {
  CORE_VIEW_SURFACE_IDS,
  isCoreViewSurface,
  listAddressableViewNames,
  resolveViewSurface,
} = await import('../../src/client/components/client-view-surfaces.mjs');

const {
  VIEW_NAMES,
  createNavigationStack,
  getRegisteredViewNames,
  normalizeNavigationStack,
  pushView,
  registerViewNames,
} = await import('../../src/client/state/navigation-stack.mjs');

const { kikxState, setClientComponents } = await import('../../src/client/state/kikx-state.mjs');

// --- helpers ---------------------------------------------------------------

function fakeApp(state = {}) {
  return { _state: state, _render() {}, _requestRender() {}, _syncFrameThread() {} };
}

function viewDescriptors(...surfaceIDs) {
  return surfaceIDs.map((surfaceID) => ({
    kind: 'view',
    surfaceID,
    tagName: `kikx-${surfaceID}-surface`,
    moduleURL: `/plugins/${surfaceID}/view.mjs`,
    label: surfaceID,
  }));
}

function classesOf(node) {
  return String(node?.className || '').split(/\s+/).filter(Boolean);
}

function tagOf(node) {
  return String(node?.localName || node?.tagName || '').toLowerCase();
}

// --- 1. descriptors survive the client, and become addressable ------------

test('a plugin view descriptor is kept by setClientComponents and becomes addressable', () => {
  let state = {};
  setClientComponents(viewDescriptors('metrics'), state);

  // The old behaviour dropped it entirely; the map is the evidence it did not.
  assert.ok(state.clientViewSurfaces, 'client view surfaces must be recorded on state');
  assert.equal(state.clientViewSurfaces.metrics?.surfaceID, 'metrics');

  // Addressable means pushView accepts it, which is what a sidebar entry needs.
  assert.ok(getRegisteredViewNames().includes('metrics'));

  let stack = pushView(createNavigationStack(), 'metrics');
  assert.equal(stack.at(-1).view, 'metrics');
});

test('core view names stay addressable when no descriptors are served at all', () => {
  let state = {};
  setClientComponents([], state);

  for (let name of CORE_VIEW_SURFACE_IDS)
    assert.ok(getRegisteredViewNames().includes(name), `${name} must remain addressable`);
});

test('a plugin view name is refused when that plugin is not installed', () => {
  // The reload/unload half of the contract: the name set is derived from the
  // descriptors currently served, so it must shrink again, not linger.
  let state = {};
  setClientComponents(viewDescriptors('metrics'), state);
  assert.ok(getRegisteredViewNames().includes('metrics'));

  setClientComponents([], state);
  assert.ok(!getRegisteredViewNames().includes('metrics'), 'a removed view must stop being addressable');
  assert.throws(() => pushView(createNavigationStack(), 'metrics'), /unknown view/);
});

test('the frozen VIEW_NAMES list is still the core default, unmodified', () => {
  // Guards against "fixing" dispatch by quietly editing the core vocabulary.
  assert.deepEqual(VIEW_NAMES, [ 'inbox', 'agents', 'teams' ]);
  assert.deepEqual([ ...CORE_VIEW_SURFACE_IDS ], [ 'inbox', 'agents', 'teams' ]);
});

// --- 2/3. dispatch resolves without a core branch on the name ------------

test('dispatch resolves a plugin view descriptor instead of falling back to the window', () => {
  let state = {};
  setClientComponents(viewDescriptors('metrics'), state);
  let app = fakeApp(state);

  let surface = resolveViewSurface('metrics', state, app);
  assert.ok(surface, 'a registered plugin view must resolve to an element');
  assert.equal(tagOf(surface), 'kikx-metrics-surface');
});

test('core views still resolve, through the core fallback table', () => {
  // A real state object: the core builders read agentIDs/teamIDs/inbox keys, so a
  // bare {} would throw inside them and the failure would say nothing about
  // dispatch. This asserts that the fallback map still reaches the builders.
  let state = { ...kikxState };
  setClientComponents([], state);
  let app = fakeApp(state);

  for (let name of CORE_VIEW_SURFACE_IDS) {
    assert.ok(isCoreViewSurface(name), `${name} must be a core surface`);
    let surface = resolveViewSurface(name, state, app);
    assert.ok(surface, `core view ${name} must render`);
  }
});

test('a plugin descriptor for a core name is shadowed, so core cannot be replaced by accident', () => {
  // Ordering matters and is a security-ish decision: a plugin must not silently
  // take over the Inbox by registering a descriptor whose id collides with it.
  let state = {};
  setClientComponents(viewDescriptors('inbox'), state);

  assert.ok(!state.clientViewSurfaces?.inbox, 'a core view name must not be accepted as a plugin surface');
});

test('an unknown view name resolves to null rather than throwing or rendering blank', () => {
  let state = {};
  setClientComponents([], state);

  assert.equal(resolveViewSurface('nope', state, fakeApp(state)), null);
  assert.equal(resolveViewSurface(null, state, fakeApp(state)), null);
  assert.equal(resolveViewSurface('', state, fakeApp(state)), null);

  // No app means nothing to render FOR: an empty section is a blank work area, so
  // the resolver answers null and the caller renders the window instead.
  assert.equal(resolveViewSurface('inbox', state, null), null);
});

// --- 4. sidebar entries are descriptor-driven too ------------------------

test('a plugin sidebar-item descriptor is kept and exposed as a sidebar row', () => {
  let state = {};
  setClientComponents([
    {
      kind: 'sidebar-item',
      surfaceID: 'metrics-link',
      tagName: 'kikx-metrics-link',
      moduleURL: '/plugins/metrics/link.mjs',
      label: 'Metrics',
      view: 'metrics',
    },
  ], state);

  assert.equal(state.clientSidebarItems['metrics-link']?.label, 'Metrics');

  // The shell must be able to see it without a core edit; assert on the accessor
  // the shell uses rather than on the raw map, so the seam is pinned.
  let names = listAddressableViewNames();
  assert.ok(names.includes('metrics'), 'a sidebar item adds its target view to the addressable set');
});

test('a stale persisted view name degrades instead of producing a blank work area', () => {
  // A bookmarked `?view=` for a plugin that is no longer installed must not leave
  // the stack holding a view nothing can render.
  let state = {};
  setClientComponents([], state);

  let kept = normalizeNavigationStack([ { sessionID: null, collapsed: true, view: 'metrics' } ]);
  assert.equal(kept.at(-1).view, undefined, 'an unrenderable view must be dropped');

  let stillThere = normalizeNavigationStack([ { sessionID: null, collapsed: true, view: 'inbox' } ]);
  assert.equal(stillThere.at(-1).view, 'inbox', 'a renderable core view must survive');
});

test('registerViewNames is additive and never removes a core name', () => {
  registerViewNames([ 'metrics' ]);
  assert.ok(getRegisteredViewNames().includes('metrics'));
  for (let name of CORE_VIEW_SURFACE_IDS)
    assert.ok(getRegisteredViewNames().includes(name), 'registering must not shadow core');

  // Keep the module-level set from leaking into the other tests in this file.
  registerViewNames();
  assert.ok(!getRegisteredViewNames().includes('metrics'));
});

// --- the app state shape the shell reads ---------------------------------

test('setClientComponents still files frame/tool/config-form descriptors', () => {
  // Regression guard: the change adds kinds, it must not disturb the existing
  // three or the frame/tool renderers stop resolving.
  let state = {};
  setClientComponents([
    { kind: 'frame', frameType: 'Thing', tagName: 'kikx-thing-frame', moduleURL: '/a.mjs' },
    { kind: 'tool', toolName: 'thing', tagName: 'kikx-thing-tool', moduleURL: '/b.mjs' },
    { kind: 'agent-config-form', pluginID: 'p', tagName: 'kikx-p-form', moduleURL: '/c.mjs' },
  ], state);

  assert.equal(state.clientFrameComponentsByType.Thing?.frameType, 'Thing');
  assert.equal(state.clientToolComponentsByName.thing?.toolName, 'thing');
  assert.equal(state.clientAgentConfigFormsByPluginID.p?.pluginID, 'p');
  assert.equal(state.clientComponentStatus, 'ready');
  assert.deepEqual(state.clientViewSurfaces, {});
  assert.deepEqual(state.clientSidebarItems, {});
});

// --- 5. the shell really uses the resolver (the P7 grep gate) ------------

// Strip comments before the grep gate runs. Without this the gate matches its own
// explanatory prose -- measured: the first version of this test failed on the
// phrase "No new `viewName ===` branch" quoted in the shell's own comment, which
// is a false positive, not a regression.
function codeOnly(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

test('the shell dispatches through resolveViewSurface and has no viewName === branch', async () => {
  // The campaign P7 exit proof is a grep gate, and a resolver nothing calls would
  // satisfy neither half of it. Asserted on the source because the property is
  // about the SHAPE of the shell, not one rendered frame: a future contributor
  // re-adding a ternary chain would reintroduce the coupling even if every render
  // test still passed.
  let source = await readFile(
    new URL('../../src/client/components/kikx-shell-builders.mjs', import.meta.url),
    'utf8',
  );
  let code = codeOnly(source);

  assert.ok(code.includes('resolveViewSurface('), 'the shell must dispatch through the resolver');
  assert.ok(!/viewName\s*===/.test(code), 'the shell must not branch on a literal view name');
});

test('the dispatch expression renders a plugin view, and yields the window on an unknown one', async () => {
  // This drives `resolveViewSurface(...) || buildWindow(...)` -- the exact
  // expression the shell's work area uses. It is NOT renderAppShell end to end:
  // that needs a full app harness (_captureRenderSnapshot, _buildRunnerShell,
  // auth token, error-surface mounting) which is orthogonal to this seam. The grep
  // gate above is what pins that the shell really contains this expression.
  let { buildWindow, renderAppShell } = await import('../../src/client/components/kikx-shell-builders.mjs');

  let app = fakeApp({ ...kikxState });

  // (a) a registered plugin view wins over the window.
  setClientComponents(viewDescriptors('metrics'), app._state);
  let surface = resolveViewSurface('metrics', app._state, app) || buildWindow(app, { sessionID: null });
  assert.equal(tagOf(surface), 'kikx-metrics-surface', 'a plugin view must be the work-area surface');

  // (b) an unknown name resolves to null, so the same expression yields the window
  // -- never an empty <section>, which would be a blank work area.
  setClientComponents([], app._state);
  assert.equal(resolveViewSurface('ghost', app._state, app), null);

  // The exports exist and are callable, so the fallback branch is a real function
  // rather than a name that only appears in a comment.
  assert.equal(typeof buildWindow, 'function');
  assert.equal(typeof renderAppShell, 'function');
});

test('the sidebar renders a plugin row that is wired and reflects active state', async () => {
  // A sidebar row that cannot navigate is a dead control. Asserted through the
  // builder the shell calls, not by re-implementing the mapping here.
  let state = { ...kikxState };
  setClientComponents([
    {
      kind: 'sidebar-item',
      surfaceID: 'metrics-link',
      tagName: 'kikx-metrics-link',
      moduleURL: '/plugins/metrics/link.mjs',
      label: 'Metrics',
      view: 'metrics',
    },
  ], state);

  let { buildSessionObjectItems } = await import('../../src/client/components/kikx-sidebar-session-objects.mjs');
  let app = fakeApp(state);
  let items = buildSessionObjectItems(app);

  let row = items.find((item) => item.id === 'metrics-link');
  assert.ok(row, 'the plugin sidebar row must be in the item list');
  assert.equal(row.label, 'Metrics');
  assert.equal(row.group, 'view', 'a plugin row belongs in the view cluster, not the footer');

  // Core rows keep their established order ahead of plugin rows.
  let order = items.filter((item) => item.group === 'view').map((item) => item.id);
  assert.deepEqual(order, [ 'agents', 'teams', 'metrics-link' ]);

  // Wiring: selecting the row pushes its view. Asserted on the resulting stack so
  // a no-op handler cannot pass.
  row.onSelect();
  assert.equal(state.navigationStack.at(-1).view, 'metrics');
});

test('the plugin sidebar row shows active state when its view is on top', async () => {
  let state = { ...kikxState };
  state.navigationStack = [ { sessionID: null, collapsed: true }, { sessionID: null, collapsed: true, view: 'metrics' } ];
  setClientComponents([
    {
      kind: 'sidebar-item',
      surfaceID: 'metrics-link',
      tagName: 'kikx-metrics-link',
      moduleURL: '/plugins/metrics/link.mjs',
      label: 'Metrics',
      view: 'metrics',
    },
  ], state);

  let { buildSessionObjectItems } = await import('../../src/client/components/kikx-sidebar-session-objects.mjs');
  let row = buildSessionObjectItems(fakeApp(state)).find((item) => item.id === 'metrics-link');

  assert.equal(row.active, true, 'the row must show active state when its view is open');
});
