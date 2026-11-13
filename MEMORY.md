# Kikx handoff memory — refreshed 2026-11-05

> **Refresh 2026-11-05 (read this first after compaction).** A full day of work
> landed since the 2026-10-30 body below: scrollview gesture/perf campaigns,
> mobile hamburger drawer + compact status bar + STOP/copy/raw-mode UI work,
> durable auth tokens (localStorage, 30-day refresh), markdown fixes,
> provider-retry phantom fix, and the source-size gate. The § numbers below are
> partially stale — trust the commits in §8-refresh and the plans under
> `docs/plans/` over the 10-30 prose. **Active campaign:
> `docs/plans/system-settings-xenocept-plugins-campaign.md` — plan at revision 3
> with an AGIS critical pass (§9), enterprise posture (§10: signatures required
> by default, unsafe dev `.env` mode, internal plugins on the same verified
> `loadPlugins` path), and ALL FIVE owner decisions recorded in §9.6.
> Implementation NOT started — start at its §8 "First action after compaction".**

This is the current continuity file for the `kikx` checkout. It replaces earlier
stale handoff notes in this file. Read the project `.pi/` and global startup
context first; this file records current work and gotchas, not the whole product
history.

## 1. Current position

- Checkout: `/home/wyatt/Projects/kikx-workspace/kikx`
- Branch: `main`; clean and pushed. Latest at refresh: Kikx `5dfa0c71`, Aeor
  `0a73ec3` (see §8-refresh for the full recent list).
- Dev server: `kikx-dev2-run.service` on `127.0.0.1:3002`, PostgreSQL
  `kikx-dev2` on `127.0.0.1:5434`; service active and `/health` ready.
- **Do not touch `kikx2` or `:3001`.** It is the production-bot clone and is
  intentionally outside this worktree.
- **No production deployment** has been authorized or performed.
- Latest browser/client changes are static; a hard reload on `:3002` is needed
  to replace cached modules/styles. Restart the dev service only for server-side
  changes.
- Aeor checkout: `/home/wyatt/Projects/aeor-web-components`, latest `0a73ec3`.
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

### Filtered lazy-loading scroll investigation

Filtered/search pages are sparse: a raw 120-frame page may project to one or
zero matching rows. Loading several such pages above the viewport used to
shrink the layout and clamp the viewport to the bottom. AEOR now serializes
viewport-preserving page loads, captures a segment/relative anchor for gaps,
falls back to the nearest item outside the viewport, and avoids stale focal
corrections. Kikx captures and restores the visible frame around paged loads
and opts into the preservation behavior. A deterministic repro still showed
scroll movement during aggressive filtered prefetch, so this needs another
verification pass before claiming it fixed.

### State integrity continuation

- Generic focused-form capture now preserves value, checked state, focus, and
  caret across a full shell render, including modal controls portaled outside
  `kikx-app`; the delayed restore waits for modal autofocus and refuses to steal
  focus from a control the user clicked afterward.
- Frame items and existing chat views no longer rebuild solely because the
  app-state object identity changed.
- Empty frame arrays no longer sync stale pages; they route through the empty
  state.
- Session-grid `update()` reconciles cards by id instead of emptying/rebuilding.
- Preview/deleted-session refreshes and newer-frame merges prefer mounted keyed
  grid/thread sync paths.
- State coverage audit:
  `docs/reports/client-state-coverage-audit-2026-10-30.md`. It explicitly records
  that per-component exhaustive coverage and the shell section registry remain
  open.

### Miri display-order diagnosis and fix

Miri on `wyatt-laptop:3098` was **not actually mid-turn**. The last turn
`MessageDone` was complete at `2026-10-30 19:53:17 UTC`; the final AgentMessage
was complete, SSE was connected, and there was no thinking output or frame-load
error. The apparent stop was an ordering bug:

- final AgentMessage `88a1bdcc…`: raw order `351384`, commit order `16582`
- later tool frames `5983c7e6…` / `189ccd84…`: raw order `361731/361732`,
  commit order `16579/16578`
- page source assigned by raw order, so the final response was on page 64 while
  the tool tail was on page 66

Local fix `f5368881` adds `thread-display-order.mjs` and promotes one completed
AgentMessage to the last loaded page when its commitOrder is newer than
everything there. A real-browser regression confirms the final response is the
last visible frame. Also fixed durable tool-call status: `markToolCallFinished`
now sets `content.status` and `state.status` to success/error, not just
`finishedProcessingAt`.

The remote container remains on image `7d484126`; the fix is **not deployed or
applied to the laptop checkout**. Latest local full suite after the state fixes:
**3,139 tests / 3,109 pass / 0 fail / 30 skipped**; targeted browser lane
**4/4 pass**.

### End-turn summary wording

The end-turn summary schema, model brief, and precepts now say explicitly:

> This summary is the first thing the user will see when you end your turn.

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

At the 2026-11-05 refresh tree:

- Kikx full unit/core suite: **3,329 tests, 3,299 pass, 0 fail, 30 skipped**
  (includes `spec/architecture/source-file-size-spec.mjs`, the 800-line hard
  cap gate, and the docs gates).
- Kikx browser lanes run green as individual Puppeteer specs (10-wide batch
  verified): scroll stability (`mobile-bottom-follow-gesture`,
  `send-pin-and-unpin`, `filtered-lazy-scroll`, `search-clear`, `frame-bottom`,
  `live-message-tail`), mobile (`mobile-layout`, `mobile-menu`), UI polish
  (`view-polish`, `status-toolbar-overlay`, `quick-action-copy`,
  `raw-markdown`), plus `composer-send-seamless`, `typing-under-load`,
  `auth-persistence`.
- AEOR browser harness: pass, including property store, keyed list, property
  binding, scrollview `updatePage`.
- Aeor/Kikx documentation gates pass.

If changing client modules, rerun full `spec/**/*-spec.mjs` and the relevant
Puppeteer lane. The whole `test:ui:puppeteer` lane may still depend on external
AeorDB availability; run individual Stagehand/Puppeteer tests instead when
needed.

## 5. Remaining campaign phases

- **ACTIVE: `docs/plans/system-settings-xenocept-plugins-campaign.md`** —
  System Settings shell mode + Xenocept plugin parity (SettingsPage base,
  plugins section UI, npm install/search, Ed25519 `.kikx-sig` verification +
  sign script, realtime `plugin.changed` SSE). Plan only; start at its §8.
  Owner scope note: "A BIG CHUNK OF IT… encrypted signatures, real-time
  installing and removing, NPM… all of it."
- Older plugin-platform phases P1/P5/P7 remainder still open (see
  `docs/plans/plugin-platform-campaign.md`).

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

### 8-refresh — 2026-11-04/05 (newest first)

Kikx:

- `5dfa0c71` Copy button success-green state
- `23bfe9c1` Copy everywhere (quote-parity with quoteTextForFrame)
- `d3ec8b8d` provider-retry: phantom previews no longer block the ladder (the
  kikx3 "Ollama Gateway Timeout killed the turn" incident, session aaa31337)
- `e2be15b0` Copy quick action (double-paper icon, raw markdown to clipboard)
- `fa5b339d` owner polish batch: mobile header span fix, view-header centering,
  pointer cursor, rename-under-load, and the "Loading page locks the mouse"
  campaign (forced-layout fixes: logger busy-skip, hash debounce, capture
  gating, per-load input yields — see plan `scrollview-campaign.md` notes in
  the commit bodies)
- `0c3cd92a` dark-red STOP as `aeor-confirm-button` (0.5s hold, rectangular)
- `670761f1` STOP ring says STOP → superseded by confirm-button above
- `aeb35f40` durable auth: localStorage primary + sessionStorage legacy
  migration; logout clears all three; server refresh TTL already 30d sliding
- `034846b7` frame timestamps present on mobile (short time-only label)
- `3d64e171` bottom pin survives sends; ANY user scroll unpins; honest bottom
  hash (scrolllog-proven pin/settle/focus fight fix)
- `506c43d4` same campaign's Kikx half (markFrameListProgrammaticWrite ×12,
  topVisibleFrameID metadata walk, hash restore guard)
- `8f1c066f` `c0383833` `d497ce06` `8be6c75d` source-size refactor wave
  (app.css split, component splits) + `425a3700` the 800-line cap gate
- `e329297f` agent contextWindowTokens default from model
- `24d0d452` `61fd81fe` live tail lazy-load fix
- `1f1d2b9a` mobile hamburger drawer + sidebar drawer (replaces top-band
  sidebar), `53067364` earlier mobile wave
- `086a75fb`→`dce21c05` user-message delivery visual (blue body, green corner)

Aeor (repo `/home/wyatt/Projects/aeor-web-components`, commit ONLY source/tests —
the uncommitted docs migration stays untouched):

- `0a73ec3` reserve page width for overhanging consumer chrome (content-
  visibility paint containment was clipping the quick-action rail)
- `54f1578` `programmaticScrollActive` + `pageAtOffset` + `markProgrammaticScroll`
- `9abb766` content-visibility + input yields + measured pins (the
  "Loading page freezes the mouse" perf work; probe numbers in the commit body)
- `677b881` user gesture wins over bottom-yank paths
- `51d3bde` `39dcdcd` `416e875` earlier scrollview series

### Older (2026-10-30 body below)

Kikx recent commits (10-30 era):
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

### §8 addendum — plugin campaign completion (2026-11-10)
Campaign plan `docs/plans/system-settings-xenocept-plugins-campaign.md`
S1-S6 ALL DELIVERED. Phase commits: S1 43cc56de+161fc573+6738eaea (shell
fork-A identity), S2 1b91915f, S4 6ef445be (signatures required default),
S3 9ef4194b→b62c0bd1 (six slices: validation, registry/integrity/tar-guards,
{npm} install+provenance+runtime paths, search+extraction split, Browse UI,
update chips), uninstall+toggle c4f419af, S5 realtime ed0100bf
(plugin.changed success-only publishes, components-then-inventory client
refetch, no repaint), S6 docs 179cf5f6. Suite at close: 3,480/0/30.
Owner-deferred: favorites, audit log, community mode. Wake port on this
host: systemd kikx-wake.timer (single sender), bot-common 5f6e999+80de0a4+
2dcf096, fixtures/tools/kikx-wake-*, first live fire 2026-11-10T04:20:02Z.

### §8 addendum — unified properties store (2026-11-13)
Plan `docs/plans/properties-store.md` (design-locked 92330325, AGIS pass
bedcc82a, ten owner rulings ff09266f). P1 546a8a91, P2 f64587a0, P3 8dd0dc08,
P4 4ed7eaba, P5 3b2dac1e, P6 fe06250f, P7 4e6c750a, P8 docs (this record's
commit). One store, three drivers (sqlite unit dialect / PostgreSQL live /
aeordb putFile retired-host); presence-implies-secret envelopes
(aes-256-gcm, fail-closed on KIKX_PROPERTIES_ENCRYPTION_KEY); caller classes
with core = server code ONLY; grants deny-wins flat from signed
manifest.json; deny-logging `[properties-deny] …`; HTTP own-account default
+ hasValue secrets + 409; theme & email migrated as hard cuts (no
localStorage / no mailer.json import — the file writer is DELETED).
Suite at close: 3,595/0/32. Records: HANDOFF ★ entry.

### §8 addendum — properties Q1/Q2: AeorDB-inspired tokens + evaluation (2026-11-13)
Owner research task (aeordb permission_resolver.rs read in full) + two
decisions: (Q1) {current} token resolved in the facade CALCULATE step from
the authenticated identity — refuses property_token_unresolved with no
identity (plugins always), hostile identity never spliced; {UUID} is
requester-side, grant patterns accept {uuid} one-segment tokens (other
braces refused at register); scope-forcing kept, theme key unchanged.
(Q2) grants evaluation = AeorDB-inspired specificity — nearest/most-specific
declaration wins (exact > {uuid} > longer prefix > /*), deny decides
equal-specificity ties, no match = no opinion = default deny; plan §4
literal example now works as written. Docs: reference/properties.md,
plugin-authoring.md, plan §4 (superseding decision), HANDOFF entry.
Focused 81/81; FULL LANE 3,598/0/32; docs gates 6/0 (this entry's commit).
