'use strict';

// =============================================================================
// The one client-component kind vocabulary
// =============================================================================
// A plugin contributes UI by naming an "area" of the app it wants to fill:
// a frame body, a tool body, a whole view, a sidebar row, a settings panel, a
// toolbar action. Each of those is a KIND. The platform's promise, in the
// owner's words (2026-11-02): "All plugins should be able to export their own
// components, for any area of the app, always."
//
// THE DEFECT THIS FILE EXISTS FOR. Before it there were THREE independent,
// hand-maintained lists of kinds, and they disagreed:
//
//   1. plugin-registry.mjs `normalizeComponentDescriptor` validated against
//      'frame' | 'tool' | 'agent-config-form' plus a `surfaceKinds` set.
//   2. src/client/components/frame-component-registry.mjs had its own copy in
//      CLIENT_COMPONENT_KINDS and silently dropped any descriptor not in it
//      (its normalizeDescriptors is a `.filter`, so the descriptor vanished and
//      the module was never even imported).
//   3. src/client/state/kikx-state.mjs `setClientComponents` filed only five
//      kinds via an if/else chain and had no else branch at all.
//
// A kind accepted by (1) and missing from (2)+(3) was therefore accepted by the
// server, advertised over /api/v1/client-components, and discarded by the
// browser with no error anywhere. That is the same silent-drop class as the
// namespaced-tool defect (b79888f6): everything looks healthy and nothing
// renders. `toolbar-action` and `settings-panel` were in exactly this state --
// the registry advertised them and not one client file referenced either.
//
// THE RULE THAT KEEPS THEM FROM DIVERGING AGAIN: there is no second list. Both
// sides import this module, and a kind that is not here cannot be registered in
// the first place, so "advertised but unrenderable" stops being reachable rather
// than merely being unlikely.
//
// What this file does NOT promise: every kind has a mount point TODAY. A kind
// with no consumer is stored and addressable but paints nothing; that is a
// missing feature, which is visible and honest, instead of a silent discard,
// which is not. See listUnmountedKinds() in the client store for the honest
// report of which kinds currently have nowhere to paint.

// `keyField` is the descriptor property that identifies a contribution WITHIN
// its kind -- the uniqueness key the registry indexes on and the client files
// under. A kind with no key field would let two contributions silently
// overwrite each other, so every kind names one.
//
// `scope` records what the kind is keyed BY, because that is what determines
// whether two plugins collide: two frames must not claim the same frameType,
// but two plugins may each contribute a toolbar action.
export const CLIENT_COMPONENT_KINDS = Object.freeze({
  frame: {
    keyField: 'frameType',
    scope: 'global',
    description: 'Replaces the body of one frame type in the session thread.',
  },
  tool: {
    keyField: 'toolName',
    scope: 'global',
    description: 'Replaces the body of one tool call frame, by tool name.',
  },
  'agent-config-form': {
    keyField: 'pluginID',
    scope: 'plugin',
    description: 'The configuration form for agents provided by a plugin.',
  },
  'main-app': {
    keyField: 'surfaceID',
    scope: 'global',
    description: 'The whole application shell. One at a time.',
  },
  view: {
    keyField: 'surfaceID',
    scope: 'global',
    description: 'A whole work area, navigable by name, rendered in place of the thread.',
  },
  'sidebar-item': {
    keyField: 'surfaceID',
    scope: 'global',
    description: 'A row in the session-tree sidebar that navigates to a view.',
  },
  'toolbar-action': {
    keyField: 'surfaceID',
    scope: 'global',
    description: 'A control in the unified top bar, scoped to the selected session.',
  },
  'settings-panel': {
    keyField: 'surfaceID',
    scope: 'global',
    description: 'A panel in the settings area.',
  },
});

export const CLIENT_COMPONENT_KIND_NAMES = Object.freeze(Object.keys(CLIENT_COMPONENT_KINDS));

export function isClientComponentKind(kind) {
  return typeof kind === 'string' && Object.hasOwn(CLIENT_COMPONENT_KINDS, kind);
}

export function clientComponentKeyField(kind) {
  return CLIENT_COMPONENT_KINDS[kind]?.keyField || null;
}

// The message both sides use, so a rejected kind says the same thing wherever
// it is rejected and names the full set instead of a partial one.
export function clientComponentKindError(kind) {
  return `Unknown client component kind: ${String(kind)}; expected one of: ${CLIENT_COMPONENT_KIND_NAMES.join(', ')}`;
}
