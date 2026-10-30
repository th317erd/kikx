# Kikx handoff memory — 2026-10-30

This is the current continuity file for the `kikx` checkout. It replaces earlier
stale handoff notes in this file. Read the project `.pi/` and global startup
context first; this file records current work and gotchas, not the whole product
history.

## 1. Current position

- Checkout: `/home/wyatt/Projects/kikx-workspace/kikx`
- Branch: `main`; **clean and pushed** at `818b90f1` (includes the remote
  browser-lane/report merge after the targeted-update work).
- Dev server: `kikx-dev2-run.service` on `127.0.0.1:3002`, PostgreSQL
  `kikx-dev2` on `127.0.0.1:5434`; service active and `/health` ready.
- **Do not touch `kikx2` or `:3001`.** It is the production-bot clone and is
  intentionally outside this worktree.
- **No production deployment** has been authorized or performed.
- Latest browser/client changes are static; a hard reload on `:3002` is needed
  to replace cached modules/styles. Restart the dev service only for server-side
  changes.
- Aeor checkout: `/home/wyatt/Projects/aeor-web-components`, latest `43f0234`.
  Its worktree has unrelated **uncommitted documentation migration changes**
  (`docs/`, `README`, `SKILL`, deleted `bot-docs/` files). Do not discard or
  commit that migration as part of Kikx work; only the framework source/test
  commits below are ours.
- Local `node_modules` in Kikx is an ignored symlink to
  `/home/wyatt/Projects/kikx-workspace/kikx2/node_modules`. The tracked
  `node_modules` symlink was removed from `main` upstream; do not commit a
  dependency on `kikx2`.

## 2. Owner-approved architecture campaign

The owner explicitly approved implementing the **entire** targeted-update plan:

- [Audit](/home/public/wyatt-desktop/Projects/kikx-workspace/kikx/docs/reports/client-targeted-update-audit-2026-10-30.md)
- [Plan](/home/public/wyatt-desktop/Projects/kikx-workspace/kikx/docs/plans/client-targeted-update-layer.md)
- Existing integrity plan:
  [client user-state integrity](/home/public/wyatt-desktop/Projects/kikx-workspace/kikx/docs/plans/client-user-state-integrity.md)

Core owner rule:

> State changes update only dependent properties/nodes. Never default to a
> broad dump-and-rebuild. Reuse DOM and preserve focus, listeners, selection,
> expansion, and scroll. No virtual DOM, no deep diff, no full-state scan.

The audit confirmed:

- AEOR has reactive **leaf** bindings, top-level `ReactiveState`, query helpers,
  and per-component getters/setters/attributes.
- AEOR historically had **no general scoped property-store or keyed
  reconciliation layer**. That layer has now been started and committed.
- Kikx `KikxFrameItem` and the shared scrollview already have useful targeted
  paths.
- Kikx `renderAppShell()` still empties `kikx-app` and rebuilds the application;
  ~78 `app._render()`/`_requestRender()` call sites remain across ordinary data,
  editor, navigation, agent/team, and runtime paths.
- Raw mode was one symptom; it is now paint-only.

## 3. Implemented in this session

### Raw Markdown mode

- Toolbar `Raw` button toggles `kikx.raw-markdown` preference.
- Implemented as a **paint-only** class toggle (`kikx-raw-mode` on `kikx-app`)
  with CSS `::before`/`::after` syntax markers:
  `**strong**`, `_em_`, `~~del~~`, backticks, heading/fence/quote/list markers.
- No shell/render call, no DOM detach, no scroll write.
- CSS lives in `src/client/styles/raw-markdown.css`.
- Browser regression asserts same node, no scroll movement, computed pseudo
  content.

### Search and filters

- Header search now filters paged Markdown locally without a whole-session body
  scan. Default debounce is **350 ms**.
- Search terms are case-insensitive **token substrings**; the old in-order
  subsequence matcher was removed because it matched almost every tool frame.
- A fresh session with `frameFilters: null` now uses default filters instead of
  skipping the predicate.
- Hidden gate remains key `deleted` but UI label is **Hidden**; when enabled it
  reveals both `hidden: true` and soft-deleted frames. Coordination wakes remain
  visible without the gate.
- Search focus/value/caret is captured/restored across shell repaints, and paged
  re-scope also preserves it.

### Targeted-update framework layer (AEOR)

New committed source:

- `aeor-web-components/property-store.js`
  - `PropertyStore` / `createPropertyStore`
  - narrow per-key change records `{ key, previous, next, revision, source }`
  - equality guards, transactions over ReactiveState batching, scoped observers,
    wildcard diagnostics, disposal.
- `aeor-web-components/reconcile.js`
  - `createKeyedList()` with create/update/remove/adopt-existing nodes
  - `patchProperties()`, `patchAttributes()`, `bindProperty()`
  - no deep diff, no virtual DOM.
- `components/aeor-scrollview.js`
  - `updatePage()` now reconciles mounted page items in place.
  - optional source hook `updateItem(item, node, previous, context)`.
  - `createKeyedList` can adopt existing keyed nodes from a page.
- Aeor browser harness coverage in `test/behaviour/property-layer.mjs` and
  scrollview tests. Harness passed with no console/harness errors.

Aeor commits:

- `03befd3` property store/reconciliation layer
- `1c1d882` scrollview in-place `updatePage`
- `43f0234` changelog documentation

### Kikx integration slice

- `src/client/lib/aeor-ui.mjs` re-exports `PropertyStore`,
  `createPropertyStore`, `createKeyedList`, `patchProperties`,
  `patchAttributes`, `bindProperty`.
- `src/client/state/preview-status-store.mjs`: first scoped pilot store for the
  topbar preview caption.
- `kikx-topbar.mjs` updates preview class/text through the store observer instead
  of a builder binding.
- `kikx-thread-page-source.mjs` accepts `updateItem` and reconciles projected
  frame nodes.
- `kikx-chat-scrollview.mjs` has `updatePageContext()`: filter/query changes
  re-project mounted pages in place instead of remounting the whole scrollview.
- `kikx-chat-view.mjs` routes `update()` through `syncFrames()` when the shared
  scrollview is already mounted.
- `render-stats.mjs` now records bounded render outcomes: kind, reason, scope,
  structural flag, touched frame IDs, timestamp. Plain `countRebuild()` remains
  cheap. Existing render counters still work.
- Kikx commits: `d52aeed2` (pilot), `5d06fe74` (page re-scope + render
  diagnostics), `905e03d7` (chat view), `6c923a3f` (progress docs).

## 4. Current test status

At the latest verified tree:

- Kikx full unit/core suite: **3,133 tests, 3,103 pass, 0 fail, 30 skipped**.
- Kikx browser lane (targeted): **6/6 pass**:
  - search/filter page re-scope
  - hidden/deleted frame filter
  - Raw Markdown paint-only toggle
  - composer state preservation
  - frame-filter popup
  - mobile layout
- AEOR browser harness: pass, including property store, keyed list, property
  binding, scrollview `updatePage`.
- Aeor/Kikx documentation gates pass.

If changing client modules, rerun full `spec/**/*-spec.mjs` and the relevant
Puppeteer lane. The whole `test:ui:puppeteer` lane may still depend on external
AeorDB availability; run individual Stagehand/Puppeteer tests instead when
needed.

## 5. Remaining campaign phases

Plan phase status:

- **Phase 0 — partial:** render reason outcomes implemented; identity guardrails
  are still incomplete. Need browser tests that fail on broad rebuilds and assert
  unchanged nodes across more paths.
- **Phase 1 — framework layer complete; topbar pilot complete.**
- **Phase 2 — shell section registry: NOT STARTED.** `renderAppShell()` still
  empties/rebuilds `kikx-app`. Need stable sections (`topbar`, `runner/auth`,
  `status`, `editor`, `error`), detached builds/swap, rollback, and tests that
  status/data updates do not detach the thread/composer/search.
- **Phase 3 — partial:** page re-scope and existing chat-view update are in
  place. Still need full `KikxChatView` keyed migration, filter/search without
  whole-thread remount in all paths, and removal of `appState`-identity frame
  rebuilds.
- **Phase 4 — runtime/data: NOT STARTED.** Remove ordinary `_requestRender`
  fallbacks; route runtime frame changes into frame records/keyed items; keep
  explicit recovery only.
- **Phase 5 — editors/agents/teams/Inbox: NOT STARTED.**
- **Phase 6 — cleanup/CI identity gate: NOT STARTED.**

Next practical target: Phase 2 shell section registry. Do not silently rewrite
the shell; preserve the plan's stop/approval/verification gates. The owner has
approved the campaign, but individual phase completion still requires tests and
review.

## 6. Critical code paths and known problems

- `kikx-shell-builders.mjs:renderAppShell()` still calls:
  - `app._disconnectFrameListObserver()`
  - `app._cleanupReactiveBindings()`
  - `$(app).empty()`
  - `app.appendChild(newTree)`
  This detaches the application tree. Snapshots in `kikx-frame-scroll.mjs` are
  recovery, not a substitute for node reuse.
- `KikxFrameItem.updateFrame()` has good in-place reconciliation, but a new
  `appState` object identity currently triggers `_render()` (`kikx-frame-item.mjs`
  around 195-220). Replace with scoped store subscriptions in Phase 3; do not
  treat the app-state object as a change signal.
- `KikxChatView` has `syncFrames()` and a keyed scrollview path. `update()` now
  uses it if already mounted; first mount/mini mode still structural.
- `KikxChatScrollView.updatePageContext()` reuses raw pages and calls
  `aeor-scrollview.updatePage()` for mounted pages. This is the current
  filter/search re-scope path.
- `kikx-runtime-events.mjs` already batches frame events and avoids per-commit
  shell renders, but still has `_requestRender()` fallbacks and resync paths.
- `render-stats.mjs` counters are used by streaming/empty-thread/filter tests.
  Render outcomes are available to tests and debug probes; expose
  `app._renderOutcomes` for diagnostics.
- The previous raw-mode bug was caused by a full shell render; do not regress it.
- Search/filter behavior is local to loaded pages and paged source; no
  whole-session body scan for paged threads. Do not reintroduce the server scan
  on keystroke or filter changes.
- `frameFilters` can be `null` in initial state; all predicates and page sources
  must normalize it to defaults, never treat null as "skip filtering."

## 7. Environment and operations

- Node 24: `/home/wyatt/.config/nvm/versions/node/v24.21.0/bin/node`
- Kikx dev: `127.0.0.1:3002`; service
  `systemctl --user restart kikx-dev2-run.service`; verify `/health`.
- Dev database is PostgreSQL `kikx-dev2` on `127.0.0.1:5434`; use the
  `ORG_AEOR_KIKX_DATABASE_URL` already supplied to the service unit. Do not copy
  the password into the repository or handoff prose.
- Auth mailer log: `/tmp/codex/kikx/kikx-auth-3002.log`.
- Kikx Chrome debugging is on reserved port `9224`; do not touch other owner
  reserved ports (`9222`, `9223`, `9228`, `9229`).
- Static/vendor paths:
  `/vendor/aeor-web-components/property-store.js` and `reconcile.js` are served
  from the Aeor checkout; both returned 200 on `:3002` when checked.
- `node_modules` symlink workaround is local-only and uncommitted.

## 8. Repository state / commits

Kikx recent commits:

- `6c923a3f` docs target progress
- `905e03d7` chat view in-place update
- `3e863482` progress docs
- `5d06fe74` page re-scope + render outcomes
- `d52aeed2` topbar PropertyStore pilot
- `4ab32f7a` merge remote
- `029578e6` remote Puppeteer contract tests
- `2fc192bb` AGIS pass
- `0f260931` audit + correction plan
- `ff53a40b` paint-only Raw
- `d0b32190` initial Raw feature
- `b7264d18` search focus/caret
- `81c6f2f8` Hidden filter semantics

AEOR recent commits:

- `43f0234` changelog docs
- `1c1d882` in-place scrollview update
- `03befd3` property store/reconciliation layer
- `9d5b563` scrollview full-render avoidance
- `7cf5caa` live item key index
- `ca19898` duplicate live append guard

## 9. Handoff guidance

- Preserve the owner's explicit preference for targeted updates; do not use a
  full rebuild as a notification mechanism.
- When touching DOM, update only changed properties/nodes and add a browser
  identity/focus/scroll regression.
- Do not deploy unless explicitly asked.
- Do not touch `kikx2`/`:3001`.
- Keep docs index entries current when adding docs.
- Leave the Aeor uncommitted documentation migration alone unless the owner
  explicitly asks to finish that separate consolidation.
