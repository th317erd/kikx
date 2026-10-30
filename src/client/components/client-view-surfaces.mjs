'use strict';

// =============================================================================
// View surfaces: dispatch by descriptor, not by a core branch on the name
// =============================================================================
// Campaign P4 requires a plugin view to render "with no core shell edit", and its
// P7 exit proof states the grep gate directly: "No new `viewName ===` branch".
//
// Before this module, `kikx-shell-builders.mjs` chose the work-area surface with
// a ternary chain over `viewName === 'inbox' | 'agents' | 'teams'`. Every new
// view was a core edit, so the P7 gate could only ever be re-broken, never met.
//
// The contract this module implements:
//
//   1. A plugin `view` descriptor (kind 'view', surfaceID X) renders in the main
//      area when the stack top is `view: X`.
//   2. Core views keep working. They are NOT server descriptors -- a descriptor
//      requires a `moduleURL` custom element, and these are builder functions --
//      so they live in a core fallback table keyed by the same ids.
//   3. A plugin cannot take over a core surface id. Core names are reserved, so a
//      colliding descriptor is refused at registration time rather than silently
//      preferred or silently shadowed.
//   4. Anything unresolved returns null, so the caller falls back to the window.
//      A view entry that renders nothing is a blank work area; null is the signal
//      to render the session surface instead.
//
// See `state/view-name-registry.mjs` for the name vocabulary itself. It is a leaf
// module so that `navigation-stack.mjs` can share one definition without
// importing the view builders (which would be a cycle: builders -> state ->
// navigation-stack -> builders).

import { buildInboxView } from './kikx-inbox-view.mjs';
import { buildAgentsView, buildTeamsView } from './kikx-agent-team-views.mjs';
import {
  CORE_VIEW_SURFACE_IDS,
  getRegisteredViewNames,
  isCoreViewSurface,
  isReservedViewSurfaceID,
  listAddressableViewNames,
  registerViewNames,
} from '../state/view-name-registry.mjs';

export {
  CORE_VIEW_SURFACE_IDS,
  getRegisteredViewNames,
  isCoreViewSurface,
  isReservedViewSurfaceID,
  listAddressableViewNames,
  registerViewNames,
};

// The core fallback. A Map, not a switch, because the point of the change is that
// adding a surface is a data edit rather than a new branch in the shell.
const CORE_VIEW_BUILDERS = new Map([
  [ 'inbox', (app) => buildInboxView(app) ],
  [ 'agents', (app) => buildAgentsView(app) ],
  [ 'teams', (app) => buildTeamsView(app) ],
]);

// Resolve the work-area surface for the view currently on top of the stack.
//
// Returns a DOM element, or null when the name is not a renderable view. The
// caller renders `buildWindow()` on null -- that fallback is what stops a stale
// `?view=` from blanking the work area (see `normalizeNavigationStack`, which
// drops such an entry before it can reach here).
export function resolveViewSurface(viewName, state = null, app = null) {
  if (typeof viewName !== 'string' || viewName.trim() === '')
    return null;

  // A view is rendered FOR an app: its handlers, its state and its rebuild all come
  // from there. Resolving without one yields an empty section, i.e. a blank work
  // area, so null (render the window instead) is the honest answer.
  if (!app)
    return null;

  // Core ids are reserved (a colliding descriptor is refused at registration), so
  // a core name never reaches the descriptor lookup. Order is therefore not
  // load-bearing for precedence -- only for keeping the reserved guarantee.
  let builder = CORE_VIEW_BUILDERS.get(viewName);
  if (builder)
    return builder(app);

  let descriptor = state?.clientViewSurfaces?.[viewName];
  if (descriptor)
    return buildDescriptorSurface(descriptor, state, app);

  return null;
}

// A plugin view is a custom element, the same contract frame components use: the
// client imports its `moduleURL` (via loadClientComponentDescriptors), then the
// shell creates the tag and hands it the app and state.
//
// A descriptor whose element was never defined is a broken install, not a reason
// to blank the screen, so this returns null and the window renders instead.
function buildDescriptorSurface(descriptor, state, app) {
  let tagName = descriptor?.tagName;
  if (typeof tagName !== 'string' || tagName === '')
    return null;

  if (typeof document === 'undefined' || typeof document.createElement !== 'function')
    return null;

  let element;
  try {
    element = document.createElement(tagName);
  } catch (_error) {
    return null;
  }
  if (!element)
    return null;

  // Both names are provided on purpose: existing plugin elements read `appState`
  // (the frame-component contract), while a view needs the element's own handlers,
  // which live on the app. Providing one and not the other is how a view renders
  // once and then cannot re-render.
  element.appState = state;
  if (app) {
    if (typeof element.mountApp === 'function')
      element.mountApp(app);
    else
      element.app = app;
  }

  if (typeof element.updateView === 'function')
    element.updateView(descriptor.surfaceID || null, state, app);

  return element;
}

// The sidebar rows a plugin contributes, in a stable order. Kept beside the view
// resolution because a sidebar item exists to open a view; splitting them would
// let the two halves disagree about which names are addressable.
export function listSidebarItemSurfaces(state = null) {
  return Object.values(state?.clientSidebarItems || {})
    .filter((item) => item && typeof item.surfaceID === 'string')
    .sort((left, right) => left.surfaceID.localeCompare(right.surfaceID));
}
