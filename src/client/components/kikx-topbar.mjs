'use strict';

// Unified top toolbar (owner spec points 1-4).
//
// INVENTORY OF THE TWO BARS THIS REPLACES (file:line, HEAD e7b1739):
//
//   bar 1  `kikx-topbar`           src/client/components/kikx-shell-builders.mjs:58
//          brand :59-64 | breadcrumb :66 | top-right actions :68-74
//          actions = account chip, Account, Agents, Teams, Sign out (:69-73)
//
//   bar 2  `kikx-window__header`   src/client/components/kikx-shell-builders.mjs:307
//          lead :308-312 (back :299-305, crumb title :310, scroll-lock :311)
//          search :313 | actions :314-338 (preview status, participants popup,
//          frame-filter popup, `+ Add <noun>` :331-336)
//
//   DUPLICATED CONCEPT: `buildBreadcrumb` :177-210 (bar 1) and
//   `buildBreadcrumbTitle` :469-489 (bar 2) both answer "where am I / rename me".
//   That duplication is owner point 3.
//
// ---------------------------------------------------------------------------
// CSS CONSTRAINT (learned the hard way - it failed the gate once):
// `spec/client/stylesheet-links-spec.mjs:145-163` fails the build if any
// `kikx-*` class emitted by `src/client/components/*.mjs` has no rule in a
// stylesheet `index.html` links. That test caught 8 invented class names in the
// first draft of this module.
//
// This module writes no CSS of its own. The unified-bar layout rules - centring
// the search field (owner point 4) and the crumb pencil reveal-on-hover (owner
// point 3) - live in a SEPARATE sheet, src/client/styles/topbar-unified.css,
// registered by one <link> in src/client/index.html. Neither app.css nor this
// builder file grows.
//
// Nothing in this module mutates app state at build time. This bar is THE bar:
// there is no enable flag and no second rendering path. Rollback to the two
// stacked bars is a git checkout of e7b1739, not a runtime switch that nothing
// can flip (an earlier "default OFF" flag here was never assigned by any code).
// ---------------------------------------------------------------------------

import { elements } from '../lib/aeor-ui.mjs';
import {
  attachSessionNameEntryGestures,
  consumeNavigationClickGuard,
} from './session-name-gestures.mjs';
import { createIcon } from '../lib/icons.mjs';
import { navigateSystemSettings } from '../state/kikx-state.mjs';
import { currentViewName } from '../state/navigation-stack.mjs';
import { stateHasFilters } from '../lib/frame-filters.mjs';
import { buildScrollLockToolbar } from './kikx-scroll-lock.mjs';
// ONE shared contract for the rename field's `name` (owner item 2). The bar used
// to name it `crumb-name` while `beginSessionNameEdit` looked up `session-name`,
// so the field was never focused and blur/Escape were both dead. The constant
// lives in kikx-navigation.mjs beside the lookup that has to match it, and all
// three rename builders import it rather than repeating the string.
import {
  SESSION_NAME_INPUT_NAME,
  commitSessionNameOnFocusout,
  holdSessionNameFieldFocus,
} from './kikx-navigation.mjs';
import { getCurrentEntry, getScopeNoun, getSessions, getStackDepth } from '../state/kikx-state.mjs';
import { SIDEBAR_MENU_STATE_KEY, SIDEBAR_MENU_ELEMENT_ID, toggleSidebarMenu } from './sidebar-menu.mjs';
import { previewStatusStore } from '../state/preview-status-store.mjs';

// Registration side effects for the popup custom elements hosted by the bar.
// Imported here directly (not via kikx-shell-builders.mjs) so this module never
// forms an import cycle with the file that imports it.
import './kikx-participants-popup.mjs';
import './kikx-frame-filter-popup.mjs';
import './kikx-overflow-popup.mjs';
import { clientComponentKeyField } from '../../shared/client-component-kinds.mjs';

const { div, nav, header, h1, p, span, button, input } = elements;

// Crumb model. Mirrors buildBreadcrumb (kikx-shell-builders.mjs:177-210) crumb
// for crumb so the two stay comparable; the only addition is `sessionID`, which
// the pencil needs in order to know which path it renames. The root "Projects"
// crumb has no session, hence no pencil: there is no session row to rename.
export function buildCrumbModel(app) {
  let stack = app._state?.navigationStack || [];
  // Owner screenshot 2 (2026-11-12): inside System Settings the breadcrumb
  // must read "Settings › <section>" — the session path behind the mode is
  // meaningless there, and its stale crumbs made the mode feel detached from
  // the bar. Mode first, live section second (active).
  if (currentViewName(stack) === 'settings') {
    // Live state wins; a freshly reloaded page adopts the tab the URL named
    // (the stack entry carries `section`) — same fallback as
    // getSettingsSection, so crumb and body can never disagree.
    let top = stack[stack.length - 1];
    let section = typeof app._state?.settingsSection === 'string' && app._state.settingsSection.trim()
      ? app._state.settingsSection.trim()
      : (top && typeof top.section === 'string' && top.section.trim() ? top.section : 'General');
    return [
      // settingsRoot (owner item 3, 2026-11-13): clicking "Settings" while the
      // mode is open goes to GENERAL settings — never pops to Sessions.
      { label: 'Settings', depth: 1, active: false, sessionID: null, settingsRoot: true },
      { label: section, depth: 2, active: true, sessionID: null },
    ];
  }
  let sessions = getSessions(app._state);
  let crumbs = [{ label: 'Projects', depth: 1, active: stack.length === 1, sessionID: null }];

  for (let index = 1; index < stack.length; index++) {
    let entry = stack[index];
    let session = sessions.find((candidate) => candidate.id === entry.sessionID);
    let label = session?.title || (entry.sessionID ? String(entry.sessionID).slice(0, 8) : 'Session');
    crumbs.push({
      label,
      sessionID: entry.sessionID || null,
      depth: index + 1,
      active: index === stack.length - 1,
    });
  }

  return crumbs;
}

// The active crumb is a span (not a destination) and doubles as the bar's title.
// `kikx-window__title` is the compat alias described below; both classes have
// app.css rules, so this file still adds no CSS.
const ACTIVE_CRUMB_CLASS = 'kikx-breadcrumb__crumb kikx-breadcrumb__crumb--active kikx-window__title';

// One crumb, plus its pencil. The active crumb stays a span (not clickable),
// exactly as buildBreadcrumbCrumb does at kikx-shell-builders.mjs:214-220.
//
// COMPAT CLASS, deliberate: the active crumb also carries `kikx-window__title`.
// In a merged bar the active crumb IS the window title, and three browser specs
// read the current title by querying
//   '.kikx-window__header h2, .kikx-window__header .kikx-window__title[]'
// (spec/ui/stagehand/{new-session,sub-session,session-grid}-stagehand.mjs). They
// only read textContent -- none of them clicks it -- so the class is an alias,
// not a second control. It also has an app.css rule (.kikx-window__header
// .kikx-window__title), so stylesheet-links-spec stays satisfied.
export function buildTopbarCrumb(app, crumb) {
  if (crumb.sessionID && app._state.editingSessionNameID === crumb.sessionID) {
    // Native input: aeor-input does not re-dispatch keydown/focusout, which the
    // inline rename needs for Enter/Escape and click-away commit. The name comes
    // from the shared constant so the focus lookup can never drift from it again.
    let field = input
      .type('text')
      .class('kikx-breadcrumb__title-input')
      .name(SESSION_NAME_INPUT_NAME)
      .value(app._state.editingSessionNameValue || '')
      .onInput((event) => { app._state.editingSessionNameValue = event.target.value; })
      .onKeydown((event) => app._onSessionNameKeydown(event, crumb.sessionID))
      .onFocusout((event) => commitSessionNameOnFocusout(app, event, crumb.sessionID))();

    // Owner item 2b: "if I change my mind, I am fucked... there is NO WAY to
    // leave edit mode". Blur, Esc and navigation are all fixed in
    // kikx-navigation.mjs, but a VISIBLE control is the part that needs no
    // knowledge of any key. Both buttons are real buttons so they are keyboard
    // reachable, and both live inside `.kikx-breadcrumb__editor`, which is what
    // tells the focus guard not to yank focus back to the field before the click
    // lands.
    return div.class('kikx-breadcrumb__editor')(
      field,
      button
        .type('button')
        .class('kikx-breadcrumb__editor-action kikx-icon-button')
        .title('Save name')
        .ariaLabel('Save name')
        .onMousedown(holdSessionNameFieldFocus)
        .onClick(() => app._commitSessionName(crumb.sessionID))(createIcon('check')),
      button
        .type('button')
        .class('kikx-breadcrumb__editor-action kikx-icon-button')
        .title('Cancel rename')
        .ariaLabel('Cancel rename (Esc)')
        .onMousedown(holdSessionNameFieldFocus)
        .onClick(() => app._cancelSessionNameEdit())(createIcon('circle-x')),
    );
  }

  if (!crumb.sessionID) {
    return crumb.active
      ? span.class(crumb.active ? ACTIVE_CRUMB_CLASS : 'kikx-breadcrumb__crumb')(crumb.label)
      : button.type('button').class('kikx-breadcrumb__crumb')
        .onClick(() => crumb.settingsRoot
          ? app._activateSettingsSection?.('General')
          : app._navigateToDepth(crumb.depth))(crumb.label);
  }

  // A session crumb: just the label. The rename is a GESTURE now, not a button
  // (owner change of mind, 2026-10-27), so nothing sits beside the label.
  //
  // The gesture is attached to the BUILT node, not declared in the DSL: it is
  // imperative listener wiring with a timer and a teardown, which the element DSL
  // has no shape for. `.build(document)` here is deliberate and is the only place
  // in this module that forces a build, because the listener needs a real node.
  // Attaching before the node is wrapped is safe: a real DOM node passes through
  // the DSL unchanged, so the node nav is given is the same node the listeners
  // are on.
  // The ancestor's click consults `consumeNavigationClickGuard()` because a
  // long-press on an ancestor crumb opens the editor at 450ms and the click that
  // follows the release would otherwise navigate and destroy it. See the guard's
  // comment in session-name-gestures.mjs for why it cannot be done with
  // stopPropagation or a capture-phase listener.
  let label = (crumb.active
    ? span.class(ACTIVE_CRUMB_CLASS)(crumb.label)
    : button.type('button').class('kikx-breadcrumb__crumb')
      .onClick(() => {
        if (consumeNavigationClickGuard(crumb.sessionID))
          return;
        app._navigateToDepth(crumb.depth);
      })(crumb.label)).build(document);

  attachSessionNameEntryGestures(app, label, crumb);

  // The pencil was the only keyboard-reachable entry, and it is gone. `tabindex`
  // plus F2 keeps the rename reachable without a mouse, and the title attribute
  // is the tooltip that makes the gesture discoverable at all -- nothing else on
  // screen advertises that the title can be edited.
  label.setAttribute('tabindex', '0');
  // The tooltip must not promise a gesture the crumb does not have: double-click
  // is active-crumb only (see the dblclick handler), so an ancestor advertises
  // just the two entries it really supports.
  label.setAttribute('title', crumb.active
    ? `Double-click or hold to rename "${crumb.label}" (F2)`
    : `Hold to rename "${crumb.label}" (F2)`);

  // NOTE: wrap in `nav`, not `kikx-breadcrumb__crumb`. That class is a pill -
  // app.css:2799-2811 gives it border and radius - so nesting it around a
  // second control would render a pill inside a pill and paint a second
  // clickable-looking target. `nav` already carries a rule and is the correct
  // semantic home for a navigation affordance that is also editable.
  return nav.class('kikx-breadcrumb')(label);
}

// Back + breadcrumb MERGED into one control (owner point 3). The chevron leads
// the trail instead of standing as a separate button; it exists only when there
// is somewhere to go back to, which is exactly when the legacy back button
// rendered (kikx-shell-builders.mjs:298-299 `nested`).
export function buildTopbarBreadcrumb(app) {
  let nested = getStackDepth(app._state) > 1;
  let crumbs = buildCrumbModel(app);

  let trail = crumbs.flatMap((crumb, index) => {
    let nodes = [];
    if (index > 0)
      nodes.push(span.class('kikx-breadcrumb__sep')('›'));
    nodes.push(buildTopbarCrumb(app, crumb));
    return nodes;
  });

  let children = [];

  // Classic hamburger: the entry to the mobile workspace drawer. Visible only
  // at the mobile breakpoints where the sidebar is a drawer
  // (.kikx-menu-toggle is display:none on the desktop layout), and only built
  // on the authed bar (the auth shell has no sidebar). It leads the bar so it
  // is the first thing under a thumb, before the session-close chevron. Its
  // expanded state binds directly to `sidebarMenuOpen`, so toggling the menu
  // never rebuilds the shell.
  children.push(
    button
      .type('button')
      .class('kikx-menu-toggle kikx-icon-button')
      .title('Workspace menu')
      .ariaLabel('Workspace menu')
      .ariaControls(SIDEBAR_MENU_ELEMENT_ID)
      .onClick(() => toggleSidebarMenu(app))
      ['aria-expanded'].bindState(
        (state) => state[SIDEBAR_MENU_STATE_KEY] === true ? 'true' : 'false',
        [ SIDEBAR_MENU_STATE_KEY ],
      )(createIcon('menu')),
  );

  if (nested)
    children.push(
      button
        .type('button')
        .class('kikx-icon-button kikx-window__close')
        .title('Close session')
        .ariaLabel('Close session')
        .onClick(app._minimizeCurrent)(createIcon('chevron-left')),
    );

  children.push(nav.class('kikx-breadcrumb').ariaLabel('Session navigation')(trail));

  // The reserved session-toolbar slot. Legacy kept it in the second bar's lead
  // (kikx-shell-builders.mjs:319, `buildScrollLockToolbar`); the scroll-lock
  // button itself floats over the thread, but the slot is where session-level
  // tools land. Carrying it across means deleting the second bar cannot strand
  // that slot. `buildScrollLockToolbar` returns an empty div today, so this is
  // currently a no-op node - kept deliberately, not cargo-culted.
  let entry = getCurrentEntry(app._state);
  if (entry?.sessionID)
    children.push(buildScrollLockToolbar(app, entry.sessionID));

  return div.class('kikx-window__lead')(...children);
}

// The freed centre (owner point 4). Same behaviour as buildSessionSearch
// (kikx-shell-builders.mjs:437-458) - a query input plus one "clear all filters"
// action - carried here so the merged bar owns its own centre and app.css is not
// grown. Native input for the same reason the legacy builder uses one.
export function buildTopbarSearch(app, sessionID = null) {
  let searchInput = document.createElement('input');
  searchInput.type = 'search';
  searchInput.className = 'kikx-session-search__input';
  searchInput.name = 'session-search';
  searchInput.placeholder = 'Search';
  searchInput.setAttribute('aria-label', 'Search sessions and frames');
  searchInput.value = app._state.sessionSearch || '';
  searchInput.addEventListener('input', (event) => app._onSessionSearchInput(event.target.value));
  searchInput.addEventListener('keydown', (event) => event.stopPropagation());

  // Clearing is a filter control, not a searchbox affordance: one press drops
  // the text query *and* every row in the frame-filter popup.
  let clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'kikx-session-search__clear';
  clear.title = 'Clear all filters';
  clear.setAttribute('aria-label', 'Clear all filters');
  clear.setAttribute('data-search-action', 'clear-filters');
  clear.appendChild(createIcon('circle-x'));
  clear.addEventListener('click', () => app._clearFrameFilters?.());
  clear.hidden = !stateHasFilters(app._state);

  // Owner item 3 (2026-10-27): "I would like the 'eye' filter to be hugged up next
  // to the 'Search' field, to the right, just next to it (group 'search' items
  // together on the UI)."
  //
  // The eyeball used to live in the trailing `kikx-window__actions`, past the
  // participants popup and `+ Add` -- so the two controls that both narrow
  // visible content sat at opposite ends of the bar. It is now a sibling of the
  // field inside ONE group, which is what makes "search items together" true
  // structurally rather than by eyeballing pixel gaps: there is no element
  // between them that a later change could grow.
  //
  // The ROOT case is the reason this takes `sessionID` at all, and why it does
  // NOT gate the popup on it. The Projects grid is exactly where soft-deleted
  // sessions are listed (see buildTopbarActions' note and
  // kikx-shell-builders.mjs:326-331), so an eyeball that only rendered inside a
  // session would strand "show deleted" on the one screen that needs it. The
  // popup is created on every level; only the participants popup is
  // session-scoped.
  let frameFilter = document.createElement('kikx-frame-filter-popup');
  frameFilter.configure({ app, appState: app._state, sessionID });

  // Owner change (2026-11-05): "turn the eye icon into a vertical triple-dot
  // icon on mobile, and have it be a popup menu" -- the same slot, the opposite
  // breakpoint. Below the stacking width the eye and the whole actions cluster
  // hide (overflow-popup.css) and this ⋮ carries every toolbar action with the
  // filter checkboxes underneath them. On desktop it is display:none and the
  // eye + cluster stay exactly where they were.
  let overflow = document.createElement('kikx-overflow-popup');
  overflow.configure({
    app,
    appState: app._state,
    sessionID,
    actions: buildTopbarOverflowActionNodes(app, sessionID),
  });

  return div.class('kikx-topbar__search-group')(searchFieldContainer(searchInput, clear), frameFilter, overflow);
}

function searchFieldContainer(searchInput, clear) {
  let container = document.createElement('div');
  container.className = 'kikx-session-search';
  container.append(searchInput, clear);
  return container;
}

// The session-object cluster (User / Account / Agents / Teams / Sign out) USED to
// be built here. Owner point 2 moves it into the session-tree overview pane, so it
// now has exactly one definition, in ./kikx-sidebar-session-objects.mjs, and this
// bar deliberately renders no copy of it: two definitions would be two answers to
// "where does Account live", which is the drift this mission exists to remove.
// The cluster is mounted unconditionally by buildRunnerShell, so all five controls
// have exactly one home and can never appear on neither surface or both.

// Trailing cluster. This is the legacy `kikx-window__actions` content
// (kikx-shell-builders.mjs:314-338) lifted in one piece, so the merge cannot
// silently drop a control that lives only in the second bar.
//
// The individual controls are FACTORIES (owner change, 2026-11-05) because the
// mobile overflow menu (⋮, ./kikx-overflow-popup.mjs) shows the same actions
// in one popup: one definition per control, two mount points, no drift.
export function buildTopbarActions(app, sessionID = null) {
  // NOTE: there is deliberately NO `if (!sessionID) return ...` shortcut here.
  // The legacy second bar rendered preview status, the frame-filter eyeball and
  // `+ Add Project` on EVERY level including the root grid, and
  // kikx-shell-builders.mjs:326-331 spells out why the eyeball matters most
  // there: the Projects grid is exactly where soft-deleted sessions are listed,
  // so a root header without it strands "show deleted" on the one screen that
  // needs it. Only the participants popup is genuinely session-scoped.
  return div.class('kikx-window__actions')(
    previewStatusNode(),
    rawToggleButton(app),
    // Moved out of the status bar (owner change, 2026-11-05): "Remove the
    // Debug button from the statusbar... Move it next to the raw view button".
    // Same control, same handler, new home -- immediately after Raw.
    debugToggleButton(app),
    sessionID ? participantsNode(app, sessionID) : null,
    // Owner ruling (2026-11-07): NO System Settings gear here — settings is
    // reachable only from the upper-left brand mark. The cluster carries
    // session actions, nothing application-global.
    // Owner task (2026-11-07): "+ Add Session" moved OUT of this cluster into
    // buildTopbarTrailingAdd — the core band hugs search, the create action
    // stays trailing.
    // Owner point 2: no session-object cluster here -- it lives in the sidebar
    // (./kikx-sidebar-session-objects.mjs). The spacer keeps `justify-content`
    // honest so the trailing actions stay right-aligned when the sidebar owns them.
    span.class('kikx-topbar__spacer')(),
  );
}

// "+ Add Session" STAYS on the right (owner task, 2026-11-07): the rest of the
// cluster moved left beside search; the create action is its own trailing
// container. Label still comes from the same scope noun as the inline Add card,
// so the two Add affordances can never disagree.
function buildTopbarTrailingAdd(app, sessionID) {
  return div.class('kikx-topbar__trailing-actions')(
    addButton(app, sessionID),
  );
}

// One definition per control, now on the shared <aeor-button> box (owner
// ruling, 2026-11-07: "ALL these buttons are different sizes and styles…
// maybe a consistent button like aeor-button?"). The framework stylesheet
// owns height/padding/radius/typography; legacy classes keep only identity
// (uppercase labels, accent colors), and every existing selector still hits
// the element users click. Returns a NODE (like participantsNode) so the
// cluster and the mobile overflow menu pass it through unchanged.
//
// ARIA is set HERE as well as in the component: unit trees are detached
// (custom-element callbacks never fire), and specs assert aria-pressed on
// them — the component mirrors the same attributes once connected.
function toolbarButton({ className, title, pressed, onClick, label }) {
  let node = document.createElement('aeor-button');
  node.className = className;
  node.setAttribute('role', 'button');
  node.setAttribute('tabindex', '0');
  if (title != null)
    node.setAttribute('title', title);
  if (pressed != null) {
    node.setAttribute('pressed', pressed ? 'true' : 'false');
    node.setAttribute('aria-pressed', pressed ? 'true' : 'false');
  }
  if (typeof onClick === 'function')
    node.addEventListener('click', onClick);
  node.textContent = label;
  return node;
}

function rawToggleButton(app) {
  let raw = app._state.rawMarkdown === true;
  return toolbarButton({
    className: `kikx-raw-toggle${raw ? ' is-on' : ''}`,
    title: 'Show Markdown source with inline formatting (Raw mode)',
    pressed: raw,
    onClick: app._toggleRawMarkdown,
    label: 'Raw',
  });
}

function debugToggleButton(app) {
  let on = app._state.debugMode === true;
  return toolbarButton({
    className: `kikx-debug-toggle${on ? ' is-on' : ''}`,
    title: 'Toggle client debug mode',
    pressed: on,
    onClick: app._toggleDebugMode,
    label: 'Debug',
  });
}

function participantsNode(app, sessionID) {
  let participants = document.createElement('kikx-participants-popup');
  participants.configure({ app, appState: app._state, sessionID });
  return participants;
}

// Owner ruling (2026-11-07): the cluster settings gear is REMOVED — settings
// is reachable only from the upper-left brand mark. (No replacement stub: the
// brand-only spec asserts the name cannot survive anywhere in this file.)

function addButton(app, sessionID) {
  return toolbarButton({
    className: 'kikx-window__add',
    title: sessionID ? 'Add a session inside this one' : 'Add a project',
    onClick: () => app._createSession(),
    label: `+ Add ${sessionID ? scopeNounForTopbar(app) : 'Project'}`,
  });
}

function previewStatusNode() {
  let previewSpan = span.class('kikx-workspace__status')(span()).build(document);
  let previewText = previewSpan.firstElementChild;
  let paintPreview = () => {
    let loading = previewStatusStore.get('loading') === true;
    previewSpan.className = `kikx-workspace__status kikx-auth-status--${loading ? 'pending' : 'ready'}`;
    previewText.textContent = loading ? 'Loading previews…' : (previewStatusStore.get('status') || '');
  };
  paintPreview();
  previewSpan.__bindings = [ previewStatusStore.observeAll(paintPreview) ];
  return previewSpan;
}

// The same controls, already BUILT, for the mobile overflow menu. The cluster
// above is hidden by CSS below the stacking width; these nodes render inside
// the ⋮ popup instead. Desktop never shows them and mobile never shows the
// cluster, so there is exactly one VISIBLE copy of each action.
export function buildTopbarOverflowActionNodes(app, sessionID = null) {
  return [
    rawToggleButton(app),
    debugToggleButton(app),
    sessionID ? participantsNode(app, sessionID) : null,
    addButton(app, sessionID),
  ].filter(Boolean);
}

// Plugin toolbar actions (kind 'toolbar-action').
//
// THE FIRST REAL MOUNT POINT for this kind. The registry has accepted
// 'toolbar-action' descriptors since the client-surface registry landed, and not
// one line of client code referenced it: the descriptor was filtered out by
// frame-component-registry.mjs, then dropped again by setClientComponents'
// if/else chain with no else branch. Two independent silent discards, so the
// platform advertised an extension point that could never paint. See
// src/shared/client-component-kinds.mjs for the full measurement.
//
// SCOPING. A descriptor may carry `sessionID`; when it does, it renders only
// while that session is selected, so an action is not offered on a thread it
// cannot act on. A descriptor without one is global and renders at every level,
// including the root Projects grid -- deliberately, because the root header is
// where several controls already have to stay reachable; see buildTopbarActions.
//
// Returns plain descriptors rather than built nodes so the caller decides where
// they sit and the contract stays testable without a live DOM.
export function buildPluginToolbarActions(app, sessionID = null) {
  let byKind = app?._state?.clientComponentsByKind || {};
  let keyField = clientComponentKeyField('toolbar-action');
  if (!keyField)
    return [];

  return Object.values(byKind['toolbar-action'] || {})
    .filter((descriptor) => descriptor && typeof descriptor === 'object')
    .filter((descriptor) => typeof descriptor[keyField] === 'string' && descriptor[keyField] !== '')
    .filter((descriptor) => descriptor.sessionID === undefined
      || descriptor.sessionID === null
      || descriptor.sessionID === sessionID)
    .map((descriptor) => ({
      surfaceID: descriptor[keyField],
      tagName: descriptor.tagName,
      label: typeof descriptor.label === 'string' && descriptor.label.trim() !== ''
        ? descriptor.label.trim()
        : descriptor[keyField],
      sessionID: descriptor.sessionID ?? null,
    }))
    .sort((left, right) => left.surfaceID.localeCompare(right.surfaceID));
}

// Builds the nodes for the trailing action cluster. The custom element is created
// from the tagName the plugin registered, so the module it served is what renders;
// an undefined element degrades to an empty node rather than breaking the bar.
function buildPluginToolbarActionNodes(app, sessionID) {
  return buildPluginToolbarActions(app, sessionID).map((action) => {
    let element = document.createElement(action.tagName);
    element.className = 'kikx-topbar__plugin-action';
    element.setAttribute('data-plugin-toolbar-action', action.surfaceID);
    element.setAttribute('aria-label', action.label);
    if (action.sessionID)
      element.setAttribute('data-session-id', action.sessionID);
    return element;
  });
}

// The merged bar: ONE <header> for the whole app - brand, merged back+crumbs,
// centred search, trailing actions - replacing the stacked pair. It carries both
// `kikx-topbar` and `kikx-window__header` so the existing layout rules for each
// still apply and nothing has to be restyled in order to look sane.
//
// Returns a builder; the caller `.build(document)`s it like the legacy header.
export function buildUnifiedTopbar(app) {
  let authed = Boolean(app._state.authToken);
  let entry = getCurrentEntry(app._state);
  let sessionID = authed ? (entry?.sessionID || null) : null;

  // Computed once, here, so the mount cannot disagree with itself about scope.
  let pluginActions = authed ? buildPluginToolbarActionNodes(app, sessionID) : [];

  return header.class('kikx-topbar kikx-window__header')(
    div.class('kikx-brand')(
      // Owner correction: System Settings is GLOBAL, so its entry is the brand
      // mark itself — the [K] becomes a gear; the copy stays branding.
      button.type('button')
        .class('kikx-brand__mark')
        .title('System Settings')
        .ariaLabel('System Settings')
        .onClick(() => {
          navigateSystemSettings(app._state);
          // Owner bug 2 (probe-confirmed): every other navigation site writes
          // the address bar; the gear did not, so the URL kept only
          // ?session=… — a reload dropped the settings mode and landed on a
          // Session. Push the full stack (sessions + view=settings) so reload
          // and shared links restore exactly this view.
          app._syncURLFromStack?.({ push: true });
          app._requestRender();
        })(createIcon('gear')),
      div.class('kikx-brand__copy')(h1('Kikx'), p('Agent runner')),
    ),
    // Owner item 1 (2026-10-27): the bar is a grid whose tracks are identical to
    // .kikx-main (app.css:177-181), so column 2 begins exactly where the sidebar
    // ends and the breadcrumb lines up with the sidebar's right edge at every
    // width. That only works if the three remaining children live in column 2 as
    // one row -- as direct grid children they would auto-place the search into
    // column 1 of a second row and reinstate the two-row bar the owner rejected.
    div.class('kikx-topbar__rest')(
      authed ? buildTopbarBreadcrumb(app) : null,
      authed ? buildTopbarSearch(app, sessionID) : null,
      authed ? buildTopbarActions(app, sessionID) : span.class('kikx-topbar__spacer')(),
      authed ? buildTopbarTrailingAdd(app, sessionID) : null,
      ...pluginActions,
    ),
  );
}

// The create label's noun comes from state, not from a local copy.
export function scopeNounForTopbar(app) {
  return getScopeNoun(app._state);
}
