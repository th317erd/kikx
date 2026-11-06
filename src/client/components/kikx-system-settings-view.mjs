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
import { buildViewBackButton } from './kikx-view-chrome.mjs';

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
  return clampSettingsSection(state?.settingsSection, available);
}

export function setSettingsSection(state, sectionName, available = SETTINGS_SECTIONS) {
  if (!state || typeof sectionName !== 'string' || !available.includes(sectionName))
    return state?.settingsSection;
  state.settingsSection = sectionName;
  return sectionName;
}

export function buildSystemSettingsView(app) {
  let state = app?._state || {};
  let active = getSettingsSection(state);

  return section.class('kikx-system-settings')(
    buildViewBackButton(app),
    header.class('kikx-view-header')(
      h2.class('kikx-view-header__title')('System Settings'),
    ),
    // Tab row: same visual family as the view header controls. The active
    // state is a class, and the click writes app state then asks for a render
    // — the pattern every sidebar navigation row uses.
    div.class('kikx-system-settings__tabs')(
      ...SETTINGS_SECTIONS.map((sectionName) => button
        .type('button')
        .class(`kikx-system-settings__tab${sectionName === active ? ' kikx-system-settings__tab--active' : ''}`)
        .onClick(() => {
          setSettingsSection(state, sectionName);
          app?._requestRender?.();
        })(sectionName)),
    ),
    div.class('kikx-system-settings__body')(
      buildSettingsSectionBody(active, state, app),
    ),
  ).build(document);
}

function buildSettingsSectionBody(active, state, app) {
  if (active === 'Plugins')
    // S2 replaces this with the Xenocept-parity card layout (Installed Plugins
    // cards, inventory store, unload/reload/install actions). The honest
    // placeholder stays until then: an empty body reads as a bug.
    return section(
      h3('Plugins'),
      p('Installed plugins will be listed here.'),
    );

  // General: the host-owned Account block. Deliberately small in S1 — the
  // placeholder for host preferences (per the plan §5-S1 scope).
  let account = state?.account || {};
  return section(
    h3('Account'),
    p(account.name ? `Name: ${account.name}` : 'Name: not signed in'),
    p(account.email ? `Email: ${account.email}` : 'Email: not signed in'),
  );
}
