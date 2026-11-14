'use strict';

// =============================================================================
// Shell Views, phase P1: the Settings CONTAINER (rail + panels as one unit)
// =============================================================================
// Plan: docs/plans/shell-views-campaign.md. The owner's architecture (quoted
// there verbatim): Projects and Settings are View containers with identical
// layout, so navigating swaps PARENT CONTAINERS and the sidebar/main content
// appear to swap themselves with no shifting.
//
// What this spec locks, RED-first:
//
//   1. Container choice is a TABLE lookup in a new leaf module
//      (`kikx-view-containers.mjs`): 'settings' resolves to a container
//      element, every other name resolves null (the shell then renders the
//      Projects layout exactly as today). No `viewName ===` branch may exist
//      in either the container module or the shell — the P7 grep gate.
//   2. The container IS a left-rail TabbedView (the vendor capability added
//      in aeor-web-components 66eb196): host `tab-bar-position="left"`,
//      tabs = `settingsSections(state)` in order (base trio ∪
//      plugin-contributed sections), host `active` = the derived section
//      (getSettingsSection, §9.3.12 clamp included).
//   3. The ACTIVE tab's panel carries the real view body
//      (`buildSystemSettingsView` output — the same builder as before, so
//      the body's contract is unchanged); inactive tabs hold no body (they
//      fill in on the render the seam requests).
//   4. `tab-change` drives THE one seam: activateSettingsSection's trio —
//      persist state, sync the URL, request render — exactly once, and
//      ignores malformed events. This replaces the inline listener the old
//      in-view tab strip had, so crumb/URL/state can never drift apart.
//   5. Class-gate participation: every kikx-* class introduced here needs a
//      stylesheet rule (enforced globally by stylesheet-links-spec).

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';
import { readFile } from 'node:fs/promises';

register(new URL('./support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);
const { installDom } = await import('./support/mini-dom.mjs');
installDom();

const REPO = new URL('../../', import.meta.url);
const source = (relativePath) => readFile(new URL(relativePath, REPO), 'utf8');

function makeApp(overrides = {}) {
  return {
    _state: {
      account: { name: 'Wyatt', email: 'wegreenway@taraani.org' },
      navigationStack: [ { sessionID: null, collapsed: true } ],
      ...overrides.state,
    },
    syncCalls: 0,
    renderReasons: [],
    _syncURLFromStack() { this.syncCalls++; },
    _requestRender(reason) { this.renderReasons.push(reason); },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Table lookup: settings resolves, everything else is null
// ---------------------------------------------------------------------------

test('resolveViewContainer is a table: settings -> container, others -> null', async () => {
  const { resolveViewContainer } =
    await import('../../src/client/components/kikx-view-containers.mjs');

  const app = makeApp();
  const container = resolveViewContainer('settings', app);
  assert.ok(container, 'settings must resolve to a container element');
  const tag = String(container.localName || container.tagName || '').toLowerCase();
  assert.equal(tag, 'aeor-tab-view', 'the container IS the TabbedView');
  assert.equal(container.getAttribute('tab-bar-position'), 'left', 'left rail');

  assert.equal(resolveViewContainer('inbox', app), null,
    'non-container views resolve null so the shell renders the Projects layout');
  assert.equal(resolveViewContainer('agents', app), null, 'as above');
  assert.equal(resolveViewContainer('', app), null, 'empty name is not a view');
  assert.equal(resolveViewContainer(null, app), null, 'null is not a view');
  assert.equal(resolveViewContainer('settings', null), null,
    'resolving without an app yields nothing (view-for-app contract)');
});

// ---------------------------------------------------------------------------
// 2 + 3. Rail tabs = settingsSections; active panel = the real body
// ---------------------------------------------------------------------------

test('rail tabs are settingsSections in order, active follows state, plugin sections join', async () => {
  const { resolveViewContainer } =
    await import('../../src/client/components/kikx-view-containers.mjs');

  const app = makeApp({
    state: {
      settingsSection: 'Plugins',
      clientSettingsPanels: {
        zebra: {
          surfaceID: 'zebra',
          section: 'Zebra Mail',
          label: 'Zebra',
          tagName: 'zebra-settings',
        },
      },
      systemSettingsPlugins: { loaded: true, loading: false, error: null, inventory: [], failures: [], restartRequired: [] },
    },
  });

  const container = resolveViewContainer('settings', app);
  const tabs = [...container.querySelectorAll('aeor-tab')];
  assert.deepEqual(tabs.map((tab) => tab.getAttribute('name')),
    [ 'General', 'Email', 'Plugins', 'Zebra Mail' ],
    'tabs = base trio then plugin-contributed sections, stable order');
  assert.deepEqual(tabs.map((tab) => tab.getAttribute('label')),
    [ 'General', 'Email', 'Plugins', 'Zebra Mail' ],
    'labels mirror names');
  assert.equal(container.getAttribute('active'), 'Plugins',
    'host active follows getSettingsSection');

  const activeTab = tabs.find((tab) => tab.getAttribute('name') === 'Plugins');
  assert.ok(activeTab.querySelector('.kikx-system-settings__body'),
    'the ACTIVE tab panel carries the real view body');
  const inactiveTab = tabs.find((tab) => tab.getAttribute('name') === 'Email');
  assert.equal(inactiveTab.querySelector('.kikx-system-settings__body'), null,
    'inactive panels hold no body until a render fills them');
});

test('an unloaded section clamps: the rail never offers a body nothing renders (§9.3.12)', async () => {
  const { resolveViewContainer } =
    await import('../../src/client/components/kikx-view-containers.mjs');

  const app = makeApp({
    state: {
      settingsSection: 'Ghost', // plugin unloaded live
      systemSettingsPlugins: { loaded: true, loading: false, error: null, inventory: [], failures: [], restartRequired: [] },
    },
  });
  const container = resolveViewContainer('settings', app);
  assert.equal(container.getAttribute('active'), 'General',
    'a section nothing renders falls back to General');
});

// ---------------------------------------------------------------------------
// 4. tab-change -> THE seam, once, or nothing for malformed events
// ---------------------------------------------------------------------------

test('tab-change drives the seam exactly once: persist, URL sync, render', async () => {
  const { resolveViewContainer } =
    await import('../../src/client/components/kikx-view-containers.mjs');

  const app = makeApp({ state: { systemSettingsPlugins: { loaded: true, loading: false, error: null, inventory: [], failures: [], restartRequired: [] } } });
  const container = resolveViewContainer('settings', app);

  container.dispatchEvent(new CustomEvent('tab-change', {
    bubbles: true,
    detail: { tab: 'Email' },
  }));

  assert.equal(app._state.settingsSection, 'Email', 'the choice persisted');
  assert.equal(app.syncCalls, 1, 'URL synced exactly once');
  assert.deepEqual(app.renderReasons, [ 'settings-section' ],
    'one render requested, with the seam reason');

  container.dispatchEvent(new CustomEvent('tab-change', { bubbles: true }));
  container.dispatchEvent(new CustomEvent('tab-change', {
    bubbles: true,
    detail: { tab: 42 },
  }));
  container.dispatchEvent(new CustomEvent('tab-change', {
    bubbles: true,
    detail: { tab: 'Not A Section' },
  }));
  assert.equal(app.syncCalls, 1, 'malformed/unknown events are ignored entirely');
  assert.equal(app._state.settingsSection, 'Email', 'and never corrupt the choice');
});

// ---------------------------------------------------------------------------
// 5. P7 grep gate + shell wiring, pinned at source level
// ---------------------------------------------------------------------------

test('no viewName === branch: container module and shell stay table-driven (P7)', async () => {
  // The gate scans CODE, not prose: comments legitimately document this very
  // comparison (the P4-era shell comment quotes the gate verbatim), so block
  // and line comments are stripped before the scan.
  const codeOnly = (text) =>
    text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  const containerSource = codeOnly(
    await source('src/client/components/kikx-view-containers.mjs'),
  );
  assert.ok(!/viewName\s*===/.test(containerSource),
    'kikx-view-containers.mjs must not branch on the view name');

  const shellSource = codeOnly(
    await source('src/client/components/kikx-shell-builders.mjs'),
  );
  assert.ok(!/viewName\s*===/.test(shellSource),
    'the shell must not branch on the view name (P7 grep gate)');
  assert.match(shellSource, /resolveViewContainer\(/,
    'the shell resolves a container before building sidebar + surface');
});
