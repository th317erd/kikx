'use strict';

// =============================================================================
// The element each plugin settings panel stands on
// =============================================================================
// A leaf module on purpose: it imports nothing.
//
// This mirrors `view-surface-elements.mjs` exactly, and for the same reason.
// `kikx-settings-panel.mjs` (a component) creates and reuses these elements;
// `setClientComponents` (the state layer) is the single writer that learns when a
// panel has been uninstalled. Both need the same cache, and putting it behind an
// import of the component from the state layer would drag the shell into every
// module that touches state.
//
// Why an element is cached at all: the shell empties and rebuilds its tree on
// every paint, and a paint is what a state change causes. Creating a plugin panel
// per resolve would throw away whatever the user had typed into it. Reuse is what
// makes that survive -- a detached node loses focus, so the panel still has to
// restore focus itself; this module only holds the nodes.

const SETTINGS_PANEL_ELEMENTS = new Map();

export function getSettingsPanelElement(surfaceID) {
  if (typeof surfaceID !== 'string')
    return null;
  return SETTINGS_PANEL_ELEMENTS.get(surfaceID) || null;
}

export function setSettingsPanelElement(surfaceID, element) {
  if (typeof surfaceID !== 'string' || !surfaceID)
    return false;
  if (!element)
    return false;

  SETTINGS_PANEL_ELEMENTS.set(surfaceID, element);
  return true;
}

export function forgetSettingsPanelElement(surfaceID) {
  if (typeof surfaceID !== 'string')
    return false;
  return SETTINGS_PANEL_ELEMENTS.delete(surfaceID);
}

// Keep only the panels named in `liveSurfaceIDs`, and report what was dropped, so
// an uninstalled plugin cannot leave a panel -- and whatever it was holding --
// alive behind a name nothing resolves any more.
export function pruneSettingsPanelElements(liveSurfaceIDs) {
  let live = liveSurfaceIDs instanceof Set ? liveSurfaceIDs : new Set(liveSurfaceIDs || []);
  let dropped = [];

  for (let surfaceID of SETTINGS_PANEL_ELEMENTS.keys()) {
    if (live.has(surfaceID))
      continue;

    SETTINGS_PANEL_ELEMENTS.delete(surfaceID);
    dropped.push(surfaceID);
  }

  return dropped;
}

export function listSettingsPanelElementIDs() {
  return Array.from(SETTINGS_PANEL_ELEMENTS.keys());
}
