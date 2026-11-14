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
import {
  activateSettingsSection,
  buildSystemSettingsView,
  getSettingsSection,
  settingsSections,
} from './kikx-system-settings-view.mjs';

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
