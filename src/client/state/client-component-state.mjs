'use strict';

// Client-component descriptor store and mount-point inventory. Split from the
// main reactive state so the state module stays under the source cap.

import {
  getRegisteredViewNames,
  isReservedViewSurfaceID,
  syncViewNames,
  viewNamesFromComponents,
} from './view-name-registry.mjs';
import { clientComponentKeyField } from '../../shared/client-component-kinds.mjs';
import { pruneViewSurfaceElements } from './view-surface-elements.mjs';
import { pruneSettingsPanelElements } from './settings-panel-elements.mjs';

export const CLIENT_COMPONENT_KINDS_WITH_MOUNT_POINTS = Object.freeze([
  'frame',
  'tool',
  'agent-config-form',
  'main-app',
  'view',
  'sidebar-item',
  'toolbar-action',
  'settings-panel',
]);

// The kinds a plugin contributed that have no mount point, so nothing paints them.
// An empty array means every contribution is renderable. A non-empty one is a
// missing feature -- visible and actionable -- instead of a component that
// vanished between the server and the screen.
export function listUnmountedComponentKinds(state) {
  let byKind = state?.clientComponentsByKind || {};
  let mounted = new Set(CLIENT_COMPONENT_KINDS_WITH_MOUNT_POINTS);
  return Object.keys(byKind)
    .filter((kind) => Object.keys(byKind[kind] || {}).length > 0)
    .filter((kind) => !mounted.has(kind))
    .sort();
}

export function setClientComponents(components, state) {
  let list = Array.isArray(components) ? components : [];

  // THE ONE STORE. Every descriptor the server advertised lands here, keyed by
  // kind and then by that kind's own key field.
  //
  // This replaced an if/else-if chain that filed five kinds and had NO else
  // branch: 'toolbar-action' and 'settings-panel' were accepted by the registry,
  // advertised over /api/v1/client-components, and then discarded here without a
  // log line. The chain is why the owner's "components for any area of the app,
  // always" was not true, and a chain cannot be extended by a plugin -- only by
  // editing core. A map keyed by kind can.
  //
  // A descriptor whose kind is unknown is REFUSED and reported, not filed:
  // 'always' must not decay into 'anything'. It cannot normally happen, because
  // the server refuses an unknown kind at registration.
  let byKind = {};
  let unknownKinds = [];
  for (let component of list) {
    let kind = component?.kind;
    let keyField = clientComponentKeyField(kind);
    if (!keyField) {
      unknownKinds.push(String(kind));
      continue;
    }
    let key = component[keyField];
    if (typeof key !== 'string' || key === '')
      continue;
    (byKind[kind] ||= {})[key] = component;
  }

  // The five specific homes are kept as views DERIVED from byKind, so every
  // existing consumer keeps working untouched. They are not a second store: a
  // kind can never be present in one and missing from the other.
  let frameComponents = byKind.frame || {};
  let toolComponents = byKind.tool || {};
  let agentConfigForms = byKind['agent-config-form'] || {};
  let viewSurfaces = {};
  let sidebarItems = byKind['sidebar-item'] || {};

  for (let [ surfaceID, component ] of Object.entries(byKind.view || {})) {
    // Campaign P4: a plugin view has to reach the shell. Before that fix the
    // descriptor was dropped here, so the server advertised a surface the client
    // discarded and the work-area dispatch could only ever be a core ternary.
    //
    // A core surface id is reserved: a plugin must not take over the Inbox (or
    // Agents/Teams) by registering a colliding id, so it is refused as a ROUTE.
    // It is still kept in byKind.view -- the navigable view table and the
    // descriptor store answer different questions, and collapsing them is how a
    // reserved-id collision would silently lose a plugin's component instead of
    // merely its route.
    if (!isReservedViewSurfaceID(surfaceID))
      viewSurfaces[surfaceID] = component;
  }

  state.clientComponentsByKind = byKind;
  state.clientComponentUnknownKinds = unknownKinds;

  state.clientFrameComponentsByType = frameComponents;
  state.clientToolComponentsByName = toolComponents;
  state.clientAgentConfigFormsByPluginID = agentConfigForms;
  state.clientViewSurfaces = viewSurfaces;
  state.clientSidebarItems = sidebarItems;
  // A DERIVED view of byKind['settings-panel'], not a second store -- the same
  // treatment the five original homes get, so no consumer learns a new shape and a
  // kind can never be in one and missing from the other.
  state.clientSettingsPanels = byKind['settings-panel'] || {};

  // The single writer for the addressable view vocabulary. Derived from the
  // descriptors just filed, so uninstalling a plugin shrinks the set again instead
  // of leaving the stack able to hold a view nothing can render.
  syncViewNames(viewNamesFromComponents(list));

  // A view surface's element is cached so it survives the shell's rebuild. When
  // the inventory changes, an uninstalled surface must not keep its element -- and
  // whatever state it was holding -- alive behind a name nothing resolves. This is
  // the same moment the addressable vocabulary shrinks, so the two cannot disagree.
  //
  // The live set must be passed explicitly: this is the leaf function, whose only
  // input is the ids it should keep. Calling it with nothing prunes every surface,
  // including the ones still installed.
  pruneViewSurfaceElements(getRegisteredViewNames());

  // The same moment for panels: a settings panel that was uninstalled must not
  // keep its element -- and whatever the user typed into it -- alive behind a
  // surfaceID nothing renders any more. Derived from the store just written, so
  // the two cannot disagree about what is still installed.
  pruneSettingsPanelElements(Object.keys(state.clientSettingsPanels));

  state.clientComponentStatus = 'ready';
}
