'use strict';

// =============================================================================
// Settings: the mount point for the 'settings-panel' client component kind
// =============================================================================
// THIS FILE EXISTS TO MAKE ONE SENTENCE TRUE. The owner's requirement
// (2026-11-02), verbatim: "All plugins should be able to export their own
// components, for any area of the app, always."
//
// Before this module that sentence was false by exactly one kind. The registry
// accepted a 'settings-panel' descriptor, `/api/v1/client-components` advertised
// it, `setClientComponents` filed it -- and nothing in `src/client` mentioned
// 'settings-panel' at all. There was no settings area to paint into, so a plugin
// could contribute a panel and get silence. `listUnmountedComponentKinds()`
// reported that honestly, which is better than the silent discard it replaced,
// but an honest report of a hole is still a hole.
//
// WHAT THIS IS NOT. It is not a plugin-facing API. A plugin only ever sees the
// kind: it registers a descriptor {kind:'settings-panel', surfaceID, tagName,
// moduleURL, label} and serves its own custom element. Everything below is the
// shell's half of that contract, and it is deliberately generic -- it knows
// nothing about any particular plugin, so a second and third plugin panel work
// without touching this file.
//
// THE ELEMENT IS CACHED (settings-panel-elements.mjs), because the shell empties
// and rebuilds its tree on every paint. Rebuilding a panel per paint would wipe
// whatever the user had typed into it. Same reasoning, and the same mechanism, as
// plugin view surfaces.

import { elements } from '../lib/aeor-ui.mjs';
import {
  forgetSettingsPanelElement,
  getSettingsPanelElement,
  setSettingsPanelElement,
} from '../state/settings-panel-elements.mjs';

const { div, p, span, section, h3 } = elements;

// The panels a plugin contributed, in a stable order.
//
// Returns plain descriptors rather than built nodes so the caller decides where
// they sit, and so the ordering is testable without a live DOM. `label` is
// optional by contract; a descriptor without one is still a valid panel, so it
// falls back to the surfaceID rather than being dropped -- dropping it is exactly
// the failure mode this whole module exists to end.
export function listSettingsPanels(state = {}) {
  let panels = state?.clientSettingsPanels || {};

  return Object.values(panels)
    .filter((descriptor) => descriptor && typeof descriptor === 'object')
    .filter((descriptor) => typeof descriptor.surfaceID === 'string' && descriptor.surfaceID !== '')
    .filter((descriptor) => typeof descriptor.tagName === 'string' && descriptor.tagName !== '')
    .map((descriptor) => ({
      surfaceID: descriptor.surfaceID,
      tagName: descriptor.tagName,
      label: typeof descriptor.label === 'string' && descriptor.label.trim() !== ''
        ? descriptor.label.trim()
        : descriptor.surfaceID,
    }))
    .sort((left, right) => left.surfaceID.localeCompare(right.surfaceID));
}

// A plugin panel is a custom element, the same contract frame components and
// plugin views use: the client imports its `moduleURL` (in
// loadClientComponentDescriptors), then the shell creates the tag and hands it
// the app and state.
//
// A descriptor whose element was never defined is a broken install, not a reason
// to blank the dialog, so this returns null and the caller renders the empty
// state instead. Two things it must NOT do: invent a fallback tag (that would
// render a panel-shaped lie) and throw (a broken plugin must not take down the
// settings area for every other plugin).
function buildSettingsPanelElement(panel, state, app) {
  let tagName = panel?.tagName;
  if (typeof tagName !== 'string' || tagName === '')
    return null;

  if (typeof document === 'undefined' || typeof document.createElement !== 'function')
    return null;

  let surfaceID = panel.surfaceID;
  let element = getSettingsPanelElement(surfaceID);

  // A cached element whose tag no longer matches (the plugin changed its tag on
  // reload) is replaced rather than mutated: a custom element cannot change its
  // tag in place.
  if (element && element.localName !== tagName) {
    forgetSettingsPanelElement(surfaceID);
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

    // The shell marks which panel this element is, rather than asking the plugin
    // to. A marker the plugin must remember to emit is a marker some plugin will
    // not emit.
    try {
      element.setAttribute('data-kikx-settings-panel', surfaceID);
    } catch (_error) {}

    setSettingsPanelElement(surfaceID, element);
  }

  // Both names are provided on purpose: existing plugin elements read `appState`
  // (the frame-component contract), while a panel with handlers needs the app.
  // Providing one and not the other is how a panel renders once and then cannot
  // re-render.
  element.appState = state;
  if (app) {
    if (typeof element.mountApp === 'function')
      element.mountApp(app);
    else
      element.app = app;
  }

  if (typeof element.updatePanel === 'function')
    element.updatePanel(surfaceID, state, app);

  return element;
}

// One panel section per contributed descriptor.
export function buildSettingsPanelNodes(state = {}, app = null) {
  return listSettingsPanels(state)
    .map((panel) => {
      let element = buildSettingsPanelElement(panel, state, app);
      if (!element)
        return null;

      return section.class('kikx-settings__panel')(div.class('kikx-settings__panel-heading')(h3(panel.label)), element);
    })
    .filter(Boolean);
}

// The empty state. Said out loud rather than rendering an empty dialog: a blank
// settings screen looks like a bug, and the honest message also tells the reader
// what a plugin has to do to fill it.
export function buildSettingsEmptyState() {
  return p.class('kikx-settings__empty')(
    'No plugin has contributed a settings panel yet. A plugin adds one by '
    + 'registering a client component of kind \u2018settings-panel\u2019.',
  );
}
