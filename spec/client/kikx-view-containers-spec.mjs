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
      sessions: [],
      sessionIDs: [],
      sessionDetailsByID: {},
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

// ---------------------------------------------------------------------------
// P2: the Projects container — rail tabs, chrome, surface contract
// ---------------------------------------------------------------------------

test('projects container: rail tabs = Inbox + view/plugins rows, chrome rides, drawer id kept', async () => {
  const { buildProjectsContainer } =
    await import('../../src/client/components/kikx-view-containers.mjs');

  const app = makeApp({
    state: {
      clientSidebarItems: {
        notes: { surfaceID: 'notes', view: 'notes', label: 'Notes' },
      },
    },
  });
  app._openAgentManager = () => { app.agentOpens = (app.agentOpens || 0) + 1; };
  app._openTeamManager = () => { app.teamOpens = (app.teamOpens || 0) + 1; };

  const host = buildProjectsContainer(app, { entry: { sessionID: null }, viewName: null });
  const tag = String(host.localName || host.tagName || '').toLowerCase();
  assert.equal(tag, 'aeor-tab-view', 'the Projects container is a TabbedView too');
  const classes = host.getAttribute('class') || '';
  assert.ok(classes.includes('kikx-view-container--projects'), 'marked as the projects container');
  assert.equal(host.getAttribute('tab-bar-position'), 'left', 'left rail');
  assert.equal(host.id, 'kikx-sidebar-menu', 'the drawer id rides the host (mobile parity)');
  assert.equal(host.getAttribute('active'), 'none',
    'grid/thread tops no rail view: no tab claims selection');

  const tabs = [...host.querySelectorAll('aeor-tab')];
  assert.deepEqual(tabs.map((t) => t.getAttribute('name')),
    [ 'inbox', 'agents', 'teams', 'notes' ],
    'tabs = Inbox + view rows + plugin destinations, in order');
  assert.deepEqual(tabs.map((t) => t.getAttribute('label')),
    [ 'Inbox', 'Agents', 'Teams', 'Notes' ],
    'labels mirror the stagehand click-by-text contract');

  assert.ok(host.querySelector('.kikx-view-container__rail-head .kikx-sessions__header'),
    'the Workspace header is rail chrome');
  const foot = host.querySelector('.kikx-view-container__rail-foot .kikx-session-objects--footer');
  assert.ok(foot, 'the footer cluster rides as rail chrome (class kept for account-page)');
  const footText = foot ? [...foot.querySelectorAll('button')].map((b) => b.textContent.trim()) : [];
  assert.ok(footText.includes('Account') && footText.includes('Sign out'),
    `footer buttons intact (got ${JSON.stringify(footText)})`);

  const withView = buildProjectsContainer(app, { entry: {}, viewName: 'agents' });
  assert.equal(withView.getAttribute('active'), 'agents',
    'an open rail view maps to the active tab');
});

test('rail tab-change runs the row handler exactly once — no second render from the glue', async () => {
  const { buildProjectsContainer } =
    await import('../../src/client/components/kikx-view-containers.mjs');

  const app = makeApp();
  app._openAgentManager = () => { app.agentOpens = (app.agentOpens || 0) + 1; };
  const host = buildProjectsContainer(app, { entry: {}, viewName: null });

  host.dispatchEvent(new CustomEvent('tab-change', { bubbles: true, detail: { tab: 'agents' } }));
  assert.equal(app.agentOpens, 1, 'the row handler fired once');
  assert.deepEqual(app.renderReasons, [],
    'the glue adds no render — each onSelect owns its own paint');

  host.dispatchEvent(new CustomEvent('tab-change', { bubbles: true, detail: { tab: 'ghost' } }));
  host.dispatchEvent(new CustomEvent('tab-change', { bubbles: true }));
  assert.equal(app.agentOpens, 1, 'unknown/malformed events are ignored');

  host.dispatchEvent(new CustomEvent('tab-change', { bubbles: true, detail: { tab: 'inbox' } }));
  assert.ok(app.renderReasons.includes('rail-tab'),
    'the inbox tab paints through its own requestRender path');
});

test('P2 real DOM: the shell MARKS the work-area surface (live regression: unmarked = 3em rail + bottom gap)', async () => {
  // Caught by owner annotation 2026-11-14: the marker never landed because
  // buildWindow returns a DSL BUILDER (no setAttribute), so the thread
  // auto-placed into grid row 1 — stretching row 1 to 613px, squeezing the
  // rail's tab-bar into a ~3em scroller (annotation 1), and leaving rows 2-3
  // of the main column empty below the thread (annotation 2's huge gap).
  const { buildRunnerShell } = await import('../../src/client/components/kikx-shell-builders.mjs');
  const app = makeApp({
    state: {
      // Thread entry (the owner's annotated case: a session view).
      navigationStack: [ { sessionID: 's1', collapsed: true } ],
      sessions: [ { id: 's1', title: 'Rail Review' } ],
      sessionIDs: [ 's1' ],
      sessionDetailsByID: { s1: { id: 's1', title: 'Rail Review' } },
      deletedSessionIDs: [],
      deletedSessionDetailsByID: {},
      sessionPreviews: {},
      filterState: {},
      frames: {},
      thinkingState: {},
      openViewNames: [],
      questionsState: { questions: [], counts: {}, loaded: true },
    },
  }); // thread path: no view -> window path (buildThreadSection builder)

  const nodes = buildRunnerShell(app);
  assert.equal(nodes.length, 1, 'one shell root');
  const shell = typeof nodes[0].build === 'function' ? nodes[0].build(document) : nodes[0];
  assert.ok(shell && shell.matches && shell.matches('.kikx-main'), 'the root is the main grid');

  const marked = shell.querySelector('.kikx-view-container__surface');
  assert.ok(marked && Array.from(shell.childNodes).includes(marked),
    'the surface is a DIRECT child of the main grid and carries its marker class — without it the column layout collapses exactly as annotated');
  const host = shell.querySelector('aeor-tab-view.kikx-view-container--projects');
  assert.ok(host && Array.from(shell.childNodes).includes(host),
    'and the container is its sibling, not its parent');
  assert.ok(host && !host.querySelector('.kikx-view-container__surface'),
    'the surface never rides inside the tab-view (panels stay empty by design)');
});

test('P2 wiring: shell builds the projects container + marked surface, scope seam reached (source pins)', async () => {
  const shellSource = await source('src/client/components/kikx-shell-builders.mjs');
  assert.match(shellSource, /buildProjectsContainer\(/,
    'the everyday shell renders the projects container');
  assert.match(shellSource, /kikx-view-container__surface/,
    'the work-area surface gets its grid marker class');
  assert.ok(!/viewName\s*===/.test(shellSource), 'still no viewName branch (P7)');

  const containerSource =
    await source('src/client/components/kikx-view-containers.mjs');
  assert.match(containerSource, /filterSessionObjectItems\(/,
    'the rail filters through the ONE scope seam (denied row = no tab)');
  assert.match(containerSource, /sidebarScopePredicateFor\(/,
    'with the module predicate, not a hand-rolled lambda');
});

test('P3a: the Inbox rail tab carries the unread badge with the old aria wording', async () => {
  const { buildProjectsContainer } =
    await import('../../src/client/components/kikx-view-containers.mjs');

  const app = makeApp({
    state: {
      questionsState: {
        questions: [
          // normalizeQuestionSummary REQUIRES id + non-empty text — bare rows
          // are dropped before unreadQuestionCount ever sees them.
          { id: 'q_open', status: 'open', text: 'Which database should I target?' },
          { id: 'q_read', status: 'open', text: 'Already read', readAt: 1_500 },
          { id: 'q_done', status: 'answered', text: 'Answered already' },
        ],
        counts: {},
        loaded: true,
      },
    },
  });
  const host = buildProjectsContainer(app, { entry: {}, viewName: null });
  const inboxTab = [...host.querySelectorAll('aeor-tab')]
    .find((tab) => tab.getAttribute('name') === 'inbox');
  assert.ok(inboxTab, 'the inbox tab exists');
  assert.equal(inboxTab.getAttribute('badge'), '1',
    'only OPEN + UNREAD questions badge (read and terminal ones do not)');
  assert.equal(inboxTab.getAttribute('aria-label'), 'Inbox, 1 unread questions',
    'the old sidebar row announcement rides the tab verbatim');
  assert.equal(inboxTab.getAttribute('label'), 'Inbox',
    'the label stays exact — the click-by-text contract');

  // Zero unread: no badge, no aria override (the old row behaved the same).
  const quiet = makeApp({
    state: { questionsState: { questions: [], counts: {}, loaded: true } },
  });
  const host2 = buildProjectsContainer(quiet, { entry: {}, viewName: null });
  const quietInbox = [...host2.querySelectorAll('aeor-tab')]
    .find((tab) => tab.getAttribute('name') === 'inbox');
  assert.equal(quietInbox.getAttribute('badge'), null, 'no count, no chip');
  assert.equal(quietInbox.getAttribute('aria-label'), null, 'no aria override');
});
