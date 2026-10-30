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
//   5. A plugin view keeps the SAME element across paints. One element per
//      surface is what lets a view hold onto its scroll position, open row and
//      caret while the shell does its empty-and-rebuild cycle.
//
// See `state/view-name-registry.mjs` for the name vocabulary itself. It is a leaf
// module so that `navigation-stack.mjs` can share one definition without
// importing the view builders (which would be a cycle: builders -> state ->
// navigation-stack -> builders). `state/view-surface-elements.mjs` is a leaf for
// the same reason -- the state layer prunes the cache, so it cannot reach this
// module without dragging the shell in.

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
import {
  forgetViewSurfaceElement,
  getViewSurfaceElement,
  pruneViewSurfaceElements as pruneCachedViewSurfaceElements,
  setViewSurfaceElement,
} from '../state/view-surface-elements.mjs';

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

// Forget one surface's element, for an explicit teardown or a plugin upgrade that
// changes its tag.
export function forgetViewSurface(surfaceID) {
  return forgetViewSurfaceElement(surfaceID);
}

// Drop elements for surfaces that are no longer registered. The live set is the
// addressable name vocabulary, so pruning agrees with what the shell can dispatch.
// Called by `setClientComponents` when the descriptor inventory changes.
export function pruneViewSurfaceElements() {
  return pruneCachedViewSurfaceElements(getRegisteredViewNames());
}

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

  // Reuse the element this surface already has. The shell empties and rebuilds the
  // whole tree on every paint, so building a fresh element per resolve would reset
  // the view -- and there would be no surviving node for focus to be restored into.
  //
  // A cached element whose tag no longer matches (the plugin changed its tag on
  // reload) is replaced rather than mutated: a custom element cannot change its
  // tag in place.
  let surfaceID = descriptor.surfaceID;
  let element = getViewSurfaceElement(surfaceID);
  if (element && element.localName !== tagName) {
    forgetViewSurfaceElement(surfaceID);
    element = null;
  }

  if (!element) {
    try {
      element = document.createElement(tagName);
    } catch (_error) {
      return null;
    }
    if (!element)
      return null;

    setViewSurfaceElement(surfaceID, element);
  }

  // Both names are provided on purpose: existing plugin elements read `appState`
  // (the frame-component contract), while a view needs the element's own handlers,
  // which live on the app. Providing one and not the other is how a view renders
  // once and then cannot re-render.
  //
  // These are re-assigned on every resolve even when the element is reused, so a
  // cached element never keeps a stale state object.
  // The shell marks which surface this element is, rather than asking the plugin
  // to. Focus restoration (kikx-frame-scroll.mjs) has to find the view host that
  // was just emptied and rebuilt, and a marker the plugin must remember to emit
  // is a marker some plugin will not emit -- leaving its view silently unable to
  // keep focus. Set here, it holds for every descriptor surface including ones
  // written before this contract existed.
  try {
    element.setAttribute('data-kikx-view-surface', surfaceID || '');
  } catch (_error) {}
  element.appState = state;
  if (app) {
    if (typeof element.mountApp === 'function')
      element.mountApp(app);
    else
      element.app = app;
  }

  if (typeof element.updateView === 'function')
    element.updateView(surfaceID || null, state, app);

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
