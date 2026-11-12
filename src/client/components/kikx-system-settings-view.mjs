'use strict';

// =============================================================================
// System Settings — a core shell mode, not a dialog (campaign S1)
// =============================================================================
// The annotated screenshots ask for a first-class "System Settings": the SAME
// layout as the app, reusing the sidebar, opened from the topbar gear. The old
// dialog path (`settingsOpen` / `_buildSettingsDialog`) stays in code but the
// topbar no longer reaches it; plugin `settings-panel` descriptors will mount
// in this view's body from S2 on.
//
// Shape mirrors the other core views (inbox/agents/teams): a builder returning
// a built element, dispatched through the CORE_VIEW_BUILDERS table — no
// `viewName ===` branch anywhere (the P7 grep gate, pinned by
// spec/client/system-settings-view-spec.mjs).
//
// Sections: the S2 model's base pair. The section choice is USER STATE, so it
// lives on app state (`state.settingsSection`), never in the DOM — reading
// derives the default without writing (state-integrity rule), and §9.3.12's
// clamp means a section whose plugin was unloaded live falls back to General
// instead of rendering a body that no longer exists.

import { elements } from '../lib/aeor-ui.mjs';
import { scheduleAnimationFrame } from './kikx-app-helpers.mjs';
import { THEME_PALETTE, setPrimaryTheme } from '../lib/theme.mjs';
import { buildViewBackButton } from './kikx-view-chrome.mjs';
import { buildSettingsPanelNodes, listSettingsPanels } from './kikx-settings-panel.mjs';
import { buildPluginsSection } from './kikx-settings-plugins-section.mjs';
import { maybeLoadSystemSettingsPlugins } from '../state/system-settings-plugins.mjs';

const { button, div, h3, h2, header, p, section } = elements;

// The base sections, in tab order. S2 unions plugin-contributed sections on
// top (stable by surfaceID); General is always present because it is the
// clamp target.
export const SETTINGS_SECTIONS = Object.freeze([ 'General', 'Plugins' ]);

export const SETTINGS_DEFAULT_SECTION = 'General';

// §9.3.12: never hand back a section id that nothing renders. General is the
// answer even for an empty or nonsensical list — the clamp target must not
// itself be clampable to nothing.
export function clampSettingsSection(sectionName, available = SETTINGS_SECTIONS) {
  const list = Array.isArray(available) && available.length > 0 ? available : SETTINGS_SECTIONS;
  if (typeof sectionName === 'string' && list.includes(sectionName))
    return sectionName;
  return list.includes(SETTINGS_DEFAULT_SECTION) ? SETTINGS_DEFAULT_SECTION : list[0];
}

// Reading derives; it never writes. A default that materialises into state on
// read would make "what the user chose" indistinguishable from "what the code
// defaulted", and the unload clamp would have nothing to clamp against.
export function getSettingsSection(state, available = SETTINGS_SECTIONS) {
  // Owner (2026-11-12): a RESTORED mode opens the tab the URL names — the
  // stack entry carries `section` (stackFromSearchParams) while fresh app
  // state has none yet. Live state wins; the entry is the restore-time
  // fallback before the clamp.
  let restored = null;
  let stack = state?.navigationStack;
  let top = Array.isArray(stack) && stack.length ? stack[stack.length - 1] : null;
  if (top && top.view === 'settings' && typeof top.section === 'string' && top.section.trim())
    restored = top.section;
  return clampSettingsSection(state?.settingsSection ?? restored, available);
}

// The LIVE sections model (S2): base pair ∪ plugin-contributed sections from
// `settings-panel` descriptors, extras stable-sorted by surfaceID (which the
// list already guarantees) and de-duplicated against the base. Unloading a
// plugin shrinks this set, which is exactly what the clamp consumes (§9.3.12).
export function settingsSections(state) {
  let extras = [];
  for (const sectionName of listSettingsPanels(state).map((panel) => panel.section)) {
    if (!SETTINGS_SECTIONS.includes(sectionName) && !extras.includes(sectionName))
      extras.push(sectionName);
  }
  extras.sort();
  return [ ...SETTINGS_SECTIONS, ...extras ];
}

export function setSettingsSection(state, sectionName, available = SETTINGS_SECTIONS) {
  if (!state || typeof sectionName !== 'string' || !available.includes(sectionName))
    return state?.settingsSection;
  state.settingsSection = sectionName;
  return sectionName;
}

export function buildSystemSettingsView(app) {
  let state = app?._state || {};
  // The view opening IS the inventory's lifecycle trigger (S2 realtime-light:
  // first open fetches; the once-per-page visibility hook refetches).
  maybeLoadSystemSettingsPlugins(app);

  return section.class('kikx-system-settings')(
    // Owner screenshot 1: the Back control floated as its own row \"in the
    // middle of nowhere\". view-chrome's doctrine: inject into the view's
    // EXISTING header — it rides the title row now, like every other view.
    header.class('kikx-view-header')(
      buildViewBackButton(app),
      h2.class('kikx-view-header__title')('System Settings'),
    ),
    // Owner correction: sections ride the framework's TabbedView
    // (<aeor-tab-view>), not a hand-rolled button row. The component switches
    // tab visibility itself; the tab-change listener persists the choice into
    // app state, syncs the URL (`section=…`) and requests a render so the
    // breadcrumb follows the tab (owner 2026-11-12: it stayed "General" after
    // clicking Plugins because nothing listened to the section write).
    // Focus is restored to the active tab after the rebuild.
    div.class('kikx-system-settings__body')(
      buildSettingsTabView(state, app),
    ),
  ).build(document);
}

function buildSettingsTabView(state, app) {
  let available = settingsSections(state);
  let tabView = document.createElement('aeor-tab-view');
  tabView.setAttribute('active', getSettingsSection(state, available));

  for (const sectionName of available) {
    const tab = document.createElement('aeor-tab');
    tab.setAttribute('name', sectionName);
    tab.setAttribute('label', sectionName);
    const body = buildSettingsSectionBody(sectionName, state, app);
    tab.appendChild(body && typeof body.build === 'function' ? body.build(document) : body);
    tabView.appendChild(tab);
  }

  // Bubbles from the component's switchTo(). Persist AND publish (owner
  // 2026-11-12): the breadcrumb and URL must follow the tab — persist-only
  // left both stale unless an unrelated inventory render happened to repaint.
  // The render rebuilds the tab list, so restore focus to the ACTIVE tab
  // afterwards (focus follows activation — keyboard users keep their place).
  tabView.addEventListener('tab-change', (event) => {
    const next = event && event.detail ? event.detail.tab : null;
    if (typeof next !== 'string')
      return;
    setSettingsSection(state, next, settingsSections(state));
    app._syncURLFromStack?.();
    app._requestRender?.('settings-section');
    // The render is already queued for the next frame; queue ours after it so
    // the rebuilt DOM exists when we refocus.
    scheduleAnimationFrame(() => {
      const active = document.querySelector(
        '.kikx-system-settings__body [role="tab"][aria-selected="true"], .kikx-system-settings__body aeor-tab[active]',
      );
      active?.focus?.();
    });
  });

  return tabView;
}

function buildSettingsSectionBody(active, state, app) {
  if (active === 'Plugins')
    // The S2 card layout (Installed Plugins + Browse placeholder). The honest
    // empty/error/loading states live inside it — a blank body reads as a bug.
    return buildPluginsSection(app);

  // Sections other than General host only their own panels.
  let panels = buildSettingsPanelNodes(state, app, active);
  if (active !== 'General') {
    return section(
      h3(active),
      panels.length > 0
        ? panels
        : p('No settings panels contribute to this section yet.'),
    );
  }

  // General: the host-owned Account block (placeholder for host preferences,
  // deliberately small per plan §5-S1) plus every panel filed to General.
  let account = state?.account || {};
  return section(
    h3('Account'),
    p(account.name ? `Name: ${account.name}` : 'Name: not signed in'),
    p(account.email ? `Email: ${account.email}` : 'Email: not signed in'),
    // Primary theme (owner 2026-11-11): host preference, General section.
    h3('Theme'),
    buildThemePicker(state, app),
    panels,
  );
}

// Eight rainbow swatches. Click = persist + apply IMMEDIATELY (the whole app
// recolors via one CSS custom property — no reload, no re-render) and update
// the pressed state on the existing nodes, so keyboard focus stays on the
// swatch the user just activated.
function buildThemePicker(state, app) {
  return div.class('kikx-theme-picker')(
    p.class('kikx-theme-picker__label')('Primary color'),
    div.class('kikx-theme-picker__swatches')(
      ...THEME_PALETTE.map((color) => button.type('button')
        .class(`kikx-theme-picker__swatch kikx-theme-picker__swatch--${color.id}`)
        .title(color.label)
        .ariaLabel(`Primary color: ${color.label}`)
        .ariaPressed(String(state?.themeID === color.id))
        .onClick((event) => {
          setPrimaryTheme(app?._state || state, color.id);
          const swatches = event?.currentTarget?.parentElement
            ? [...event.currentTarget.parentElement.children]
            : [];
          for (const node of swatches)
            node.setAttribute?.('aria-pressed', String(node === event.currentTarget));
        })()),
    ),
  );
}
