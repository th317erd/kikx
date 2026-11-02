'use strict';

// =============================================================================
// Plugins can contribute a component for any area of the app
// =============================================================================
// Owner ruling, 2026-11-02, verbatim: "All plugins should be able to export
// their own components, for any area of the app, always. It sounds like this is
// a gap that needs to be fixed in our plugin system."
//
// THE DEFECT, MEASURED BEFORE THE CHANGE. Three hand-maintained kind lists
// disagreed, so a plugin could register a surface that the server accepted,
// advertised over /api/v1/client-components, and the browser discarded:
//
//   1. src/core/plugins/plugin-registry.mjs:879
//        let surfaceKinds = new Set(['main-app','view','sidebar-item','toolbar-action','settings-panel']);
//        if (kind !== 'frame' && kind !== 'tool' && kind !== 'agent-config-form' && !surfaceKinds.has(kind))
//          throw ...
//      -- an ALLOWLIST, so this half was already generic and correct.
//
//   2. src/client/components/frame-component-registry.mjs:66-83
//        const CLIENT_COMPONENT_KINDS = ['frame','tool',...,'settings-panel'];
//        ... .filter((component) => ... && CLIENT_COMPONENT_KINDS.includes(component.kind))
//      -- a FILTER. A descriptor outside the list is dropped silently, and
//      because loadClientComponentDescriptors iterates the filtered result, its
//      module is never even imported.
//
//   3. src/client/state/kikx-state.mjs:500-536
//        if (kind==='frame') ... else if (kind==='tool') ... else if (kind==='agent-config-form')
//        ... else if (kind==='view') ... else if (kind==='sidebar-item') ...
//      -- no else branch. 'toolbar-action' and 'settings-panel' fall through
//      both gates and are discarded with nothing logged.
//
// 'toolbar-action' and 'settings-panel' sat in exactly that state. Measured:
// `grep -rn 'settings-panel\|toolbar-action' src/client --include=*.mjs` returned
// only the list literal in (2) -- not one consumer, not one store field. The
// registry advertised both; the client could never render either.
//
// WHAT THIS SPEC LOCKS DOWN:
//   A. The two sides read ONE vocabulary, so they cannot disagree again. A kind
//      the registry accepts is a kind the client knows.
//   B. The client store never DROPS a descriptor. Every kind the server
//      advertises is retrievable by its kind and key, whatever the mount-point
//      situation -- because a missing feature must be visible, not silent.
//   C. A kind that is genuinely unknown is still refused, and refused in ONE
//      place, with a message that names the whole set. "Always" must not degrade
//      into "anything goes".
//   D. 'toolbar-action' has a real mount point in the unified top bar, so the
//      long-standing promise is finally kept for at least one of the two dead
//      kinds rather than merely stored.

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';
import { readFile } from 'node:fs/promises';

import {
  CLIENT_COMPONENT_KIND_NAMES,
  CLIENT_COMPONENT_KINDS,
  clientComponentKeyField,
  isClientComponentKind,
} from '../../src/shared/client-component-kinds.mjs';

// A client module that touches document/HTMLElement at import time cannot be
// imported until a DOM is installed, and the vendor web components that the UI
// layer pulls in have to be stubbed first. Same bootstrap as the neighbouring
// top-bar specs; done at module scope so the dynamic imports below -- which are
// dynamic on purpose, so a missing export fails ONE test instead of making the
// whole file fail to link -- see the globals.
register(new URL('./support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);
const { installDom } = await import('./support/mini-dom.mjs');
installDom();

const REPO = new URL('../../', import.meta.url);

async function source(relativePath) {
  return readFile(new URL(relativePath, REPO), 'utf8');
}

// A descriptor for each kind, keyed the way that kind requires.
function descriptorFor(kind, key = 'probe-key') {
  let keyField = clientComponentKeyField(kind);
  return {
    kind,
    tagName: `kikx-probe-${kind.replace(/[^a-z0-9]+/g, '-')}`,
    moduleURL: `/probe/${kind}.mjs`,
    [keyField]: key,
  };
}

// ---------------------------------------------------------------------------
// A. One vocabulary, imported by both sides
// ---------------------------------------------------------------------------

test('the kind vocabulary is a single module that both server and client import', async () => {
  // The failure this prevents: someone re-adds a literal list on one side.
  // Asserting "the registry imports the shared module" is the reachability
  // proof -- a shared module nothing imports would be the same defect wearing
  // a tidier costume.
  let registrySource = await source('src/core/plugins/plugin-registry.mjs');
  let clientRegistrySource = await source('src/client/components/frame-component-registry.mjs');
  let stateSource = await source('src/client/state/kikx-state.mjs');
  let topbarSource = await source('src/client/components/kikx-topbar.mjs');

  for (let [name, text] of [
    [ 'plugin-registry.mjs', registrySource ],
    [ 'frame-component-registry.mjs', clientRegistrySource ],
    [ 'kikx-state.mjs', stateSource ],
  ]) {
    assert.match(
      text,
      /from '[^']*shared\/client-component-kinds\.mjs'/,
      `${name} must import the shared kind vocabulary, not keep its own list`,
    );
  }

  // And the shared module is a real import, not a mention in a comment.
  assert.doesNotMatch(registrySource, /let surfaceKinds = new Set\(/,
    'the registry must not keep a second, local kind list');
  assert.doesNotMatch(clientRegistrySource, /const CLIENT_COMPONENT_KINDS = \[/,
    'the client descriptor registry must not keep a second, local kind list');

  // The top bar consumes toolbar-action descriptors, so it is the mount point
  // for that kind and must ask the shared vocabulary rather than hardcoding.
  assert.match(topbarSource, /toolbar-action/,
    'the unified top bar must mount toolbar-action descriptors');
});

test('every kind the registry advertises is a kind the vocabulary knows', () => {
  // The registry's allowlist is now derived, so this asserts the derivation
  // covers all eight kinds rather than a subset that happens to pass.
  for (let kind of [
    'frame', 'tool', 'agent-config-form', 'main-app',
    'view', 'sidebar-item', 'toolbar-action', 'settings-panel',
  ]) {
    assert.ok(isClientComponentKind(kind), `${kind} must be a known kind`);
  }

  assert.equal(CLIENT_COMPONENT_KIND_NAMES.length, 8);

  // Every kind names a key field; a kind without one cannot be indexed and two
  // contributions would overwrite each other.
  for (let [kind, definition] of Object.entries(CLIENT_COMPONENT_KINDS)) {
    assert.equal(typeof definition.keyField, 'string', `${kind} must name a keyField`);
    assert.ok(definition.keyField.length > 0, `${kind} keyField must be non-empty`);
  }
});

test('an unknown kind is refused in one place, naming the whole set', () => {
  assert.equal(isClientComponentKind('toolbar-action'), true);
  assert.equal(isClientComponentKind('sidebar-item'), true);
  assert.equal(isClientComponentKind('nonsense-area'), false);
  assert.equal(isClientComponentKind(''), false);
  assert.equal(isClientComponentKind(null), false);
  assert.equal(isClientComponentKind(undefined), false);

  // Guards against the object prototype being mistaken for a kind.
  assert.equal(isClientComponentKind('toString'), false);
  assert.equal(isClientComponentKind('__proto__'), false);
});

// ---------------------------------------------------------------------------
// B/C. The client store keeps every advertised descriptor
// ---------------------------------------------------------------------------

test('the client store files a descriptor for EVERY kind, including ones with no consumer yet', async () => {
  // This is the direct regression test for the if/else chain with no else.
  let { setClientComponents } = await import('../../src/client/state/kikx-state.mjs');
  let state = {};

  let descriptors = CLIENT_COMPONENT_KIND_NAMES.map((kind) => descriptorFor(kind));
  setClientComponents(descriptors, state);

  // Nothing was dropped: the count the server advertised is the count retained.
  let retained = Object.values(state.clientComponentsByKind || {})
    .reduce((total, byKey) => total + Object.keys(byKey).length, 0);
  assert.equal(retained, descriptors.length,
    'every advertised descriptor must be retained, whatever its kind');

  // ...and each one is retrievable by kind AND key.
  for (let descriptor of descriptors) {
    let keyField = clientComponentKeyField(descriptor.kind);
    let found = state.clientComponentsByKind?.[descriptor.kind]?.[descriptor[requiredKey(keyField)]];
    assert.ok(found, `${descriptor.kind} descriptor must be retrievable by its ${keyField}`);
    assert.equal(found.moduleURL, descriptor.moduleURL);
  }

  // The five previously-hardcoded kinds keep their existing, specific homes, so
  // no existing consumer has to change.
  assert.ok(state.clientFrameComponentsByType);
  assert.ok(state.clientToolComponentsByName);
  assert.ok(state.clientAgentConfigFormsByPluginID);
  assert.ok(state.clientViewSurfaces);
  assert.ok(state.clientSidebarItems);

  function requiredKey(keyField) {
    assert.ok(keyField, 'descriptor kind must have a key field');
    return keyField;
  }
});

test('a kind with no mount point is reported, not silently swallowed', async () => {
  let { setClientComponents, listUnmountedComponentKinds } =
    await import('../../src/client/state/kikx-state.mjs');

  let state = {};
  setClientComponents(CLIENT_COMPONENT_KIND_NAMES.map((kind) => descriptorFor(kind)), state);

  let unmounted = listUnmountedComponentKinds(state);
  assert.ok(Array.isArray(unmounted), 'the store must be able to report unmounted kinds');
  // Whatever is unmounted must be a real kind, and a kind with a consumer must
  // not be listed -- otherwise the report is noise nobody can act on.
  for (let kind of unmounted)
    assert.ok(isClientComponentKind(kind), `${kind} listed as unmounted but is not a kind`);
  assert.ok(!unmounted.includes('frame'), 'frame has a consumer and must not be reported unmounted');
});

test('the client-side loader no longer filters by a hardcoded kind list', async () => {
  let { normalizeClientComponentDescriptors } =
    await import('../../src/client/components/frame-component-registry.mjs');

  let all = CLIENT_COMPONENT_KIND_NAMES.map((kind) => descriptorFor(kind));
  let normalized = normalizeClientComponentDescriptors(all);
  assert.equal(normalized.length, all.length,
    'the loader must pass through every known kind, not a hardcoded subset');

  // Malformed descriptors are still refused: "any area, always" is about kinds,
  // not about accepting rubbish.
  let rejected = normalizeClientComponentDescriptors([
    { kind: 'frame', moduleURL: '/x.mjs' },                       // no tagName
    { kind: 'frame', tagName: 'kikx-x-y' },                       // no moduleURL
    { kind: 'unknown-kind', tagName: 'kikx-a-b', moduleURL: '/z.mjs' },
    { kind: 'frame', tagName: 'notacustomelement', moduleURL: '/z.mjs' },  // single word: not a custom element
    null,
  ]);
  assert.equal(rejected.length, 0, 'malformed and unknown-kind descriptors must be refused');
});

// ---------------------------------------------------------------------------
// D. toolbar-action has a real mount point
// ---------------------------------------------------------------------------

test('the unified top bar mounts plugin toolbar actions for the selected session', async () => {
  let { buildPluginToolbarActions } = await import('../../src/client/components/kikx-topbar.mjs');

  assert.equal(typeof buildPluginToolbarActions, 'function',
    'the top bar must expose a builder for plugin toolbar actions');

  // A descriptor scoped to the current session renders; one scoped to a
  // different session does not, so an action cannot leak across sessions.
  let state = {
    clientComponentsByKind: {
      'toolbar-action': {
        'discord-presence': {
          kind: 'toolbar-action',
          surfaceID: 'discord-presence',
          tagName: 'kikx-probe-toolbar-action',
          moduleURL: '/probe/toolbar-action.mjs',
          sessionID: 'session-a',
        },
        'other-session': {
          kind: 'toolbar-action',
          surfaceID: 'other-session',
          tagName: 'kikx-probe-toolbar-action',
          moduleURL: '/probe/toolbar-action.mjs',
          sessionID: 'session-b',
        },
        'global-one': {
          kind: 'toolbar-action',
          surfaceID: 'global-one',
          tagName: 'kikx-probe-toolbar-action',
          moduleURL: '/probe/toolbar-action.mjs',
        },
      },
    },
  };

  let forSessionA = buildPluginToolbarActions({ _state: state }, 'session-a');
  assert.deepEqual(forSessionA.map((entry) => entry.surfaceID),
    [ 'discord-presence', 'global-one' ],
    'an action renders when it is unscoped or scoped to the selected session');

  let forRoot = buildPluginToolbarActions({ _state: state }, null);
  assert.deepEqual(forRoot.map((entry) => entry.surfaceID), [ 'global-one' ],
    'a root-level header renders only unscoped actions');
});

test('a plugin view row cannot be mounted as a toolbar action, or vice versa', async () => {
  // The two kinds carry different required extras: a sidebar row must name the
  // view it opens; a toolbar action does not navigate. Mixing them would build
  // a control that looks wired and does nothing, which is the exact failure
  // mode this whole file exists to prevent.
  let { buildPluginToolbarActions } = await import('../../src/client/components/kikx-topbar.mjs');

  let state = {
    clientComponentsByKind: {
      'sidebar-item': {
        'a-view': {
          kind: 'sidebar-item', surfaceID: 'a-view',
          tagName: 'kikx-probe-sidebar-item', moduleURL: '/probe/v.mjs', view: 'inbox',
        },
      },
    },
  };

  let actions = buildPluginToolbarActions({ _state: state }, 'session-a');
  assert.deepEqual(actions, [], 'a sidebar-item must not be mounted as a toolbar action');
});
