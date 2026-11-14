---
title: Shell Views — Projects and Settings as TabbedView containers
status: current
doc_type: plan
audience: [developers, maintainers, operators]
applies_to: development-v3
last_verified: 2026-11-14
---

# Shell Views — TabbedView containers

> **BUILD STATUS (2026-11-14): P1–P4 ALL SHIPPED — build complete.**
> P1 Settings container `dbb2a4d0` · P2 Projects container `b9be9ad6` (P3's
> plugin-view rows and P4's mobile drawer folded into P2 — drawer mirrored
> rules shipped early, mobile specs green) · P3a badge kikx `4aca9125` +
> vendor `01ab7a2` (open concern 1 resolved its recommended way; P3's
> remainder was void — only Inbox ever had a count). Verified: unit lane
> 3,615 pass / 32 skipped with 3 failures attributed to Zav's in-flight
> frame-filter/topbar edits (not committed here); affected puppeteer files
> 8/8; vendor real-browser runner 2/2. Open: owner visual review of the rail
> (chrome spacing, badge color); stagehand lane blocked by the dead AeorDB
> `:6830` (owner ruling — `resolveStagehandOpenAIAPIKey` still fetches from
> it, so all 28 tests die at infra, not assertions).

## Why (owner ruling, 2026-11-14, verbatim)

> "Well, now we have 'Views', and 'Sub-Views': i.e. we have a 'Projects View'
> container, and a 'Settings View' container. Both contain tabbed-views. Both
> views have the same layout, so when we navigate, the user doesn't notice any
> 'shifting' or strange behavior, and it _appears_ that the sidebar content and
> main content swap themselves out (even though in reality, we are swapping out
> their parent containers)."

Prior rulings in the same thread: the Settings chrome (subtitle/Back/tabs in
the body) is removed; the settings sidebar nav exists but now becomes the
container's LEFT RAIL; the breadcrumb in Settings is the single
`< Exit Settings` control (landed, `1d152eba`); and the vendor TabbedView
gained a left tab-bar because it "should" have one (landed, AEOR `66eb196`,
consumer runner 2/2 — `tab-bar-position="left"`, gated ArrowDown/ArrowUp).

## Target architecture

One container per View; both containers are geometry-IDENTICAL, so swapping
them cannot produce a shift:

```
main.kikx-main  (shell root — NEVER swapped; identity + scroll doctrine hold)
└── <container>                    Projects View  |  Settings View
    grid: columns = var(--kikx-view-rail-w) 1fr;  rows = auto 1fr auto
    ├── rail-top chrome    (col 1 row 1: e.g. "Workspace" header)
    ├── <aeor-tab-view tab-bar-position="left">   spans cols 1/3, row 2,
    │     .tab-bar   → col 1   (today's sidebar column: the RAIL = tabs)
    │     <aeor-tab> → col 2   (today's main column: the PANELS)
    └── rail-bottom chrome (col 1 row 3: account chip / Account / Sign out)
```

- **Tabs come from the existing descriptor lists** — no `viewName ===`
  branches (P7 grep gate keeps holding): Settings tabs =
  `settingsSections(state)` (plugin-contributed sections included);
  Projects tabs = core view rows + `listSidebarItemSurfaces` destinations.
- **Tab-change ↔ state**: settings `tab-change` → the existing
  `activateSettingsSection` seam (persist + URL + render, one seam, no new
  paths). Projects `tab-change` → the existing `navigateView` seam.
- **Panels** are today's work-area builders: Settings =
  `buildSettingsSectionBody`; Projects = `resolveViewSurface(viewName) ||
  buildWindow(entry)` results (grid/thread), i.e. the stack still drives
  session content inside the Projects panel.
- **One width variable** (`--kikx-view-rail-w`) defines both containers'
  columns — no drift by construction (deliberately NOT subgrid: one var is
  simpler and Chromium-independent).
- `< Exit Settings` stays exactly as landed; session breadcrumbs stay
  exactly as they are (Projects only).

## Current state (verified inventory, this session)

- `shell-builders.mjs` builds `main.kikx-main` = fixed `section.kikx-sessions`
  sidebar + swappable work area; the settings sidebar branch lives in
  `buildSessionObjectItems` (sections replace Agents/Teams, Inbox bows out
  with `null`) — P1 converts those ROWS into rail tabs, then removes the
  branch (timing: see phases).
- `activateSettingsSection` (system-settings-view) and `navigateView`
  (kikx-state) are the two seams; `resolveViewSurface` dispatches panels.
- Vendor rail verified: AEOR `66eb196`; capability proven by
  `spec/ui/playwright/aeor-framework-playwright` (2/2, real browser).

## Breaking pins (map_territory findings — searched, not recalled)

1. **Seven stagehand specs** click `.kikx-session-objects button` through
   `clickButtonByText` — retarget THAT ONE helper (dual-selector during
   transition, rail-only after P2). No seven-spec rewrite.
2. `spec/ui/puppeteer/system-settings-shell-puppeteer.mjs` — my recent pins
   target `.kikx-session-objects button` + `.kikx-sidebar__view--active`
   (sidebar labels, active row, Agents-absent, install column, chrome
   probes, exit control). Rail rows must either keep comparable selectors
   or these assertions follow the helper's target — rewire per phase, never
   weaken the guarantee.
3. Shell-root identity across mode switch (§9.3.13 + its puppeteer test):
   containers swap INSIDE `main.kikx-main`, so captured root/sidebar nodes
   must stay identical — if the rail replaces the sidebar NODE, that test's
   sidebar selectors must be re-anchored deliberately (identity of the
   SHELL root is the invariant, not of any one child).
4. Scroll identity: focus-frame doctrine + `prefers-reduced-motion` rules
   untouched; container swap must not create a scroll container in col 1.
5. Scope filtering (`sidebar-shell-scope`, `sidebar-scope-field`,
   `sidebar-view-grouping`, `filterSessionObjectItems`): the DATA layer is
   unchanged — rail tabs are rendered FROM the same filtered rows, so a
   denied row must never become a tab.
6. Class gate (`stylesheet-links-spec`): every new `kikx-*` class needs a
   stylesheet rule.
7. P7 grep gate (`system-settings-view-spec`): no `viewName === 'settings'`
   (or any new view-name branches) in the shell; container selection is a
   lookup/table.
8. Mobile drawer: `SIDEBAR_MENU_ELEMENT_ID` + delegated close live on
   `section.kikx-sessions`; the container must carry the same id/wiring or
   the drawer stops closing (mobile specs pin it).
9. `session-shell-sync` crumb guard (skips title writes in Settings) —
   unchanged, but re-verify after P1 (active-crumb absence is already
   handled; exit button carries no title class).

## Phases (failing-first; full unit lane green before each commit; no deploys)

**All four phases shipped 2026-11-14 — see BUILD STATUS above for commits
and deviations; the text below is the design they were built to.**

- **P1 — Settings container.** New `kikx-view-containers.mjs` (own module:
  shell-builders is over the soft cap): builds the container grid, the
  left-rail `<aeor-tab-view>` from a descriptor list, chrome slots, and the
  tab-change→seam glue. Shell: settings mode renders the Settings container
  INSTEAD of sidebar+body (view dispatch → container choice, table-based).
  Tests first (RED): unit — tabs = `settingsSections` in order incl.
  plugin-contributed sections, `active` follows `getSettingsSection`,
  `tab-change` drives the seam exactly once, chrome slots render, no
  `viewName ===` branch (grep gate), class-gate entries; puppeteer — chrome
  probes stay `{header:false, tabs-view-present…}` re-anchored to the
  container, **the no-shift proof**: rail column `getBoundingClientRect()`
  width before entering Settings EQUALS the Projects sidebar width after
  (delta < 1px), exit control still pops, section switch via RAIL tab
  writes `section=` + crumb-free UI. Remove the old
  `buildSessionObjectItems` settings branch once tabs own the rail.
- **P2 — Projects container.** Sidebar becomes the rail: view rows +
  destinations become tabs; header/footer become chrome slots; sessions
  grid/thread stay panel content driven by the stack. Retarget
  `clickButtonByText` (dual-selector). Tests: stagehand suite green via the
  helper (the contract proof), scope-filter parity (denied row = no tab),
  identity + no-shift proofs re-run in the Projects direction, deep-link
  and hash restore unchanged, drawer id present.
- **P3 — Inbox/Agents (and plugin views) as Projects tabs.** Their view
  surfaces become panels of the Projects container; `resolveViewSurface`
  output feeds the active panel. Inbox badge: tabs carry LABELS only — see
  open concern 1 (vendor badge support or chrome-positioned badge) — if
  unresolved, Inbox keeps its row in rail-top chrome as a non-tab fallback
  (recommendation below).
- **P4 — Mobile drawer mapping.** The drawer contains the container (rail
  + panels) with `SIDEBAR_MENU_ELEMENT_ID` and delegated close preserved;
  `max-width: 960px` / `max-height: 520px` behavior unchanged. Tests:
  mobile-menu + mobile-layout specs green.

Watchdogs (test_check): unit lanes already bounded (`--test-timeout=60000`,
lane `timeout 300`); puppeteer/playwright files run with 90–120s per-test
caps; NO test in this plan touches the network (local fixtures only). Hang
classes named: tab-change→render→tab-change loops (pin with a
once-per-gesture assertion), duplicate listeners on container rebuild
(dispose contract: `__bindings` cleanup on replaced subtrees — AEOR
disposal doctrine), subgrid/feature support (avoided by design — one width
var instead).

## Devil-vs-angel decisions (folded)

1. **Vendor tabs vs hand-rolled rail buttons → vendor tabs.** Free WAI-ARIA
   (roving tabindex, arrows, roles) and the component we just upgraded;
   cost = labels-only buttons (badge concern, open concern 1) and
   `switchTo` instead of custom `onSelect` (seams glued in `tab-change`,
   which already exists for both destinations).
2. **Helper-retarget vs keeping `kikx-session-objects` classes on tabs →
   helper-retarget with a dual-selector transition.** Class-faking on vendor
   buttons couples shell CSS to a component we do not own; the helper is one
   file, seven specs, one contract.
3. **Subgrid vs duplicated widths → neither: ONE custom property**
   (`--kikx-view-rail-w`) feeds both containers' `grid-template-columns`,
   so drift is impossible without a second source of truth.

## Open concerns (ledger — recommendations for the owner)

1. **Inbox unread badge on a label-only tab.** — **RESOLVED (P3a,
   shipped `01ab7a2` + `4aca9125`):** the vendor `badge` attribute renders the
   count chip inside the button with the verbatim old aria wording; zero at
   zero. Rail chrome spacing + chip color remain visual-review items only.
2. **Plugin-contributed VIEW rows** (e.g. `notes`) become Projects tabs in
   P2 vs P3: recommend P2 (they are descriptor-driven like the rest) with
   P3 focused on Inbox/Agents semantics (badges, counts).
3. **Old sidebar-row code** (`buildSessionObjectItems` settings branch,
   `buildInboxSidebarEntry` null-path): remove in the phase that replaces it,
   never earlier (keeps every phase green on its own).
4. **Deep-link/hash behavior**: containers swap only at mode level; frame
   hash restore inside panels is untouched — re-run view-deep-link + send-pin
   specs each phase as the regression net.

## Definition of 100% (thorough_review gate for this plan)

- [x] Owner's architecture quoted verbatim; prerequisite (vendor rail) landed
      and verified by the consumer runner.
- [x] Breaking pins found by searching (9 items, file-named).
- [x] Every phase has failing-first tests, watchdog notes, and a lane gate.
- [x] Tradeoffs decided with rationale (devil_vs_angel folded).
- [x] Open concerns carry recommendations, not bare questions.
- [x] AGIS reflexes executed against the draft: map_territory (consumer
      inventory above), test_protocol (watchdogs/hang classes), devil_vs_angel
      (3 decisions), thorough_review (this checklist).
- [x] Docs gates green + README indexed + committed + pushed (the build-side
      completion of THIS document — done in its own commit, 6/0 gates).
- [x] P1–P4 built, verified and pushed (BUILD STATUS above); every phase's
      failing-first tests exist and pass; deviations recorded rather than
      silently absorbed.

## NEXT ACTION after compact

P1 in this order: 1) write `spec/client/kikx-view-containers-spec.mjs`
RED (tab list from `settingsSections`, seam glue once, chrome slots, no
`viewName ===`); 2) `kikx-view-containers.mjs` green; 3) shell wiring for
settings mode (container table lookup) + class-gate entries; 4) puppeteer:
re-anchor chrome probes + add the no-shift width proof + exit/tab switch;
5) remove the old settings sidebar-row branch; 6) full unit lane green →
commit → push. Standing rules: failing-first, lane before commits, no
deploys, never touch `kikx2`/`:3001`, 500/800 caps, light DOM only.
