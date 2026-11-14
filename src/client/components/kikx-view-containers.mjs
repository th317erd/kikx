'use strict';

// =============================================================================
// Shell Views containers (plan docs/plans/shell-views-campaign.md, phase P1)
// =============================================================================
// The owner's architecture, quoted verbatim in the plan: Projects and Settings
// are View CONTAINERS with identical layout, so navigating swaps the parent
// containers and the sidebar/main content appear to swap themselves with no
// shifting.
//
// This module is the container registry — a Map keyed by view name, the same
// dispatch discipline as CORE_VIEW_BUILDERS: adding a container is a data
// edit, never a branch on the view name itself (the P7 grep gate — a raw
// source scan — is pinned at source level in
// spec/client/kikx-view-containers-spec.mjs, which is why this prose does not
// spell out the forbidden comparison).
//
// P1 ships ONE container: Settings. Its TabbedView rides the shell's OWN
// `.kikx-main` grid via `display: contents` (see app-base-shell.css), so the
// rail lands in the sidebar's grid cell and cannot drift from the column it
// replaces — the no-shift guarantee is structural, not measured. Every other
// name resolves null and the shell renders the Projects layout unchanged.
//
// Contract:
//   resolveViewContainer(name, app) -> element | null
//     null for non-container views, empty names, or a missing app
//     (a view is rendered FOR an app — same rule as resolveViewSurface).
//   The container's tab-change drives THE section seam
//     (activateSettingsSection: persist + URL sync + render) exactly once,
//     for known sections only.

import { scheduleAnimationFrame } from './kikx-app-helpers.mjs';
import { elements } from '../lib/aeor-ui.mjs';
import { getScopeSessionID, getSessions, navigateInbox } from '../state/kikx-state.mjs';
import {
  buildSessionObjectItems,
  buildSidebarSessionObjects,
  filterSessionObjectItems,
  sidebarScopePredicateFor,
} from './kikx-sidebar-session-objects.mjs';
import { SIDEBAR_MENU_ELEMENT_ID, closeSidebarMenu } from './sidebar-menu.mjs';
import {
  activateSettingsSection,
  buildSystemSettingsView,
  getSettingsSection,
  settingsSections,
} from './kikx-system-settings-view.mjs';

const { div, h2 } = elements;

// The registry. Key = the view id the stack carries.
const VIEW_CONTAINERS = new Map([
  [ 'settings', buildSettingsContainer ],
]);

export function resolveViewContainer(viewName, app) {
  if (typeof viewName !== 'string' || viewName.trim() === '')
    return null;
  if (!app)
    return null;
  const builder = VIEW_CONTAINERS.get(viewName);
  return builder ? builder(app) : null;
}

function buildSettingsContainer(app) {
  const state = app?._state || {};
  const available = settingsSections(state);
  const active = getSettingsSection(state, available);

  const tabView = document.createElement('aeor-tab-view');
  tabView.setAttribute('class', 'kikx-view-container');
  tabView.setAttribute('tab-bar-position', 'left');
  tabView.setAttribute('active', active);

  for (const sectionName of available) {
    const tab = document.createElement('aeor-tab');
    tab.setAttribute('name', sectionName);
    tab.setAttribute('label', sectionName);
    // Only the ACTIVE panel carries the body: the same builder the view used
    // before containers existed, so its contract is unchanged. Inactive
    // panels fill in on the render this seam requests below.
    if (sectionName === active)
      tab.appendChild(buildSystemSettingsView(app));
    tabView.appendChild(tab);
  }

  // tab-change -> THE one section seam. Known sections only: a malformed or
  // unknown event must not touch state, URL or the render queue (a seam call
  // that clamps would still publish and repaint — the drift this module
  // exists to prevent).
  tabView.addEventListener('tab-change', (event) => {
    const next = event && event.detail ? event.detail.tab : null;
    if (typeof next !== 'string' || !available.includes(next))
      return;
    activateSettingsSection(app, next);
    // Focus follows activation: the render rebuilds the rail, so refocus the
    // active tab AFTER it (queued behind the render's own frame).
    scheduleAnimationFrame(() => {
      document.querySelector(
        'aeor-tab-view.kikx-view-container .tab[aria-selected="true"]',
      )?.focus?.();
    });
  });

  return tabView;
}

// ---------------------------------------------------------------------------
// Projects container (Shell Views P2): the everyday shell.
// ---------------------------------------------------------------------------
// The rail IS the old sidebar's view/plugins clusters turned into tabs — fed
// through the SAME scope seam (sidebarScopePredicateFor ->
// filterSessionObjectItems), so a denied row is a tab that never exists. The
// header and footer chrome ride the host as children (the component only
// touches .tab-bar and > aeor-tab, so foreign children survive its rebuilds)
// and land in grid rows 1 and 3 beside the rail's row 2 — the geometry the
// sidebar column used to own.
//
// Panels stay EMPTY here on purpose: the work-area surface (view surface or
// session window) renders as its own grid cell, marked by the caller with
// .kikx-view-container__surface. An active tab therefore switches navigation
// via tab-change -> the row's own onSelect (the exact handler the sidebar
// button had), and the render that follows rebuilds this container fresh.
// When the stack tops no rail view (grid/thread), active="none" — the
// component keeps every panel hidden and no button claims selection.
//
// Drawer parity (mobile): the host carries the sidebar's drawer id and the
// delegated close, so a tap anywhere in the rail still shuts the menu.
export function buildProjectsContainer(app, { entry = null, viewName = null } = {}) {
  const state = app?._state || {};
  const scopeFilter = sidebarScopePredicateFor(getScopeSessionID(state), getSessions(state));
  const items = filterSessionObjectItems(
    buildSessionObjectItems(app),
    scopeFilter,
    state,
  );
  const railRows = items.filter((item) =>
    item.kind === 'button'
    && (item.group === 'view' || item.group === 'plugins')
    && typeof item.view === 'string' && item.view.trim() !== '');

  const railTabs = [
    {
      name: 'inbox',
      label: 'Inbox',
      onSelect: () => {
        navigateInbox(state);
        app._requestRender?.('rail-tab');
      },
    },
    ...railRows.map((item) => ({ name: item.view, label: item.label, onSelect: item.onSelect })),
  ];
  const active = viewName && railTabs.some((tab) => tab.name === viewName)
    ? viewName
    : 'none';

  const tabView = document.createElement('aeor-tab-view');
  tabView.setAttribute('class', 'kikx-view-container kikx-view-container--projects');
  tabView.setAttribute('tab-bar-position', 'left');
  tabView.setAttribute('active', active);
  tabView.id = SIDEBAR_MENU_ELEMENT_ID;
  // The rail chrome as foreign children, grid-placed by CSS (head row 1,
  // tab-bar row 2 via the P1 rule + --projects override, foot row 3).
  tabView.appendChild(
    div.class('kikx-view-container__rail-head')(
      div.class('kikx-sessions__header')(h2('Workspace')),
    ).build(document),
  );
  tabView.appendChild(
    div.class('kikx-view-container__rail-foot')(
      buildSidebarSessionObjects(app, { group: 'footer', scopeFilter }),
    ).build(document),
  );

  for (const tab of railTabs) {
    const node = document.createElement('aeor-tab');
    node.setAttribute('name', tab.name);
    node.setAttribute('label', tab.label);
    tabView.appendChild(node);
  }

  tabView.addEventListener('click', () => closeSidebarMenu(app));
  tabView.addEventListener('tab-change', (event) => {
    const next = event && event.detail ? event.detail.tab : null;
    const tab = railTabs.find((candidate) => candidate.name === next);
    if (!tab)
      return;
    // Each onSelect is the handler the sidebar button already had (rows use
    // the state seams, inbox paints via its own requestRender) — no second
    // render here, or every tab click would paint twice.
    tab.onSelect();
  });

  return tabView;
}
