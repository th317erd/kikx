---
title: System Settings shell + Xenocept plugin parity
status: current
doc_type: plan
audience: [developers, maintainers, operators]
applies_to: development-v3
last_verified: 2026-11-05
---

# System Settings shell + Xenocept plugin parity

**Status: current, revision 2 — AGIS critical pass incorporated in §9
(ponder + devil_vs_angel + test_protocol scripts and the map_territory /
thorough_review reflexes; every finding carries a searched file:line anchor).
§9 findings amending a phase take precedence over that phase's original text.
Revision 1 was the bare recon plan. Reconnaissance complete 2026-11-05; no
implementation code written yet — the owner asked for this plan first, then a context compaction
before any code.** Every file:line anchor below was read live during recon and
is the starting point after compaction. Companion campaign:
[Plugin platform campaign](./plugin-platform-campaign.md) (platform
foundation this builds on; P5/P7 items referenced here).

## 1. Owner intent (from the two screenshots)

Screenshot evidence (bot-ocr of both):

- `/home/public/wyatt-desktop/Pictures/Screenshots/session-2026-11-05-20-13-12.301.png`
  — the Xenocept reference: left sidebar `Sessions / Settings / About` plus a
  `PLUGINS` group containing plugin rows (e.g. `Codex`); main area is a
  **Settings** page with section tabs **General / Destinations / Email /
  Plugins**; the Plugins tab is two columns: **Installed Plugins** (cards:
  Email `v1.0.0`, AeorDB `v1.0.0`, File `v1.0.0`, each "Internal Plugin —
  cannot be uninstalled", with description "Plugins respond to session events
  and deliver your annotated screenshots to external services like Claude,
  Codex, or the filesystem.") and **Browse Plugins** (npm search). Owner
  annotation, verbatim: *"Notice how plugins can register their own
  'Settings' page to the sidebar. We want to mirror this same functionality in
  Kikx (since Plugins can already publish components, this shouldn't be too
  difficult... we just need to have a 'SettingsPage' component base class they
  can inherit from."*
- `/home/public/wyatt-desktop/Pictures/Screenshots/session-2026-11-05-20-09-40.149.png`
  — Kikx with two annotations: *"Turn this into a 'Gear' icon, and clicking it
  will go to 'System Settings'"* (the topbar **Settings** button) and *"This
  should say 'System Settings' in the new page"* (the sidebar entry for the
  new mode).

Scope expansion (owner, same session): *"when I say I want you to copy the
plugin system from Xenocept, I mean A BIG CHUNK OF IT. The encrypted
signatures, the real-time installing and removing, the integration with
NPM... all of it."*

And the shell rule: *"We make an entirely new 'mode' or 'shell' for the
application for the 'System Settings' view. This has the exact same layout and
look as the current layout, however we will fully reutilize the sidebar, and
main content areas."* — i.e. not a dialog: a full view-mode like Inbox/Agents/
Teams, same chrome, sidebar stays live, main area hosts settings sections.

## 2. Xenocept source map (what we are copying)

Checkout: `~/Projects/xenocept-workspace/xenocept-client/`

| Feature | Where |
| --- | --- |
| Settings shell: tabs General/Destinations/Email/Plugins, `settings-section`/`form-row`/`settings-hint` markup | `static/components/xenocept-client.js:1650-1900` |
| Plugins tab: two columns, `Installed Plugins` + `Browse Plugins`, npm keyword notice (`xenocept-plugin`, unpkg CDN install) | same file `:1799-1830` |
| Plugin cards: name row, version chip, status chips (incl. `plugin-card-status-unsigned`), description, favorite/uninstall with confirm | same file `:3537-3675` |
| Sidebar entry + `navigate('settings')` | same file `:184`, `:361` |
| Plugin SDK served to plugins | `static/lib/plugins/plugin.js` |
| Signature envelope `.xenocept-sig` = `{ payload, signature }`, **base64 Ed25519 (64-byte sig)** | `scripts/emit-manifest.sh:16-25`, `src/plugin_host/xenocept_api.rs:239-257` (posts `{plugin_id, manifest_payload, manifest_signature}`), `src/plugin_host/resolve.rs` (npm dirs + cached envelope) |
| Trust model: signed plugins gate loading, public key embedded in client, private key offline, endpoint categories, revocation, audit, pluginID immutability | their plan `plugin-signing-and-endpoint-hardening.yaml` in the xenocept-client plans folder (status ready, revision 2) |
| NPM storage: plugins live under AeorDB path `/plugins/npm/<npm-dir>`, matched by package.json `pluginID` | `src/plugin_host/resolve.rs:6-56` |

## 3. Kikx seams this builds on (already exist — do not rebuild)

Server (`src/server`, `src/core`):

- `routes/plugin-routes.mjs`: `GET /api/v1/plugins` inventory (name, location,
  mounts with auth descriptors, subscriptions, **manifest**, load failures,
  restartRequired, inertOverrides; operator-gated INVENTORY) `:37`;
  `POST /install` (`{path}` absolute; config gate `KIKX_PLUGIN_INSTALL_ENABLED`
  + operator INSTALL; `loadPlugins` + per-install migrations + rollback of
  `added` on failure) `:95-219`; `POST reload` (env-file refresh + rescan of
  configured paths) `:220`; `POST unload` (runtime remove, keeps files — the
  response says so deliberately) `:285+`.
- `routes/plugin-admin-policy.mjs`: `requireOperator`, `PLUGIN_ADMIN_ACTIONS`,
  single `UNAUTHENTICATED_MESSAGE`.
- `core/plugins/plugin-loader.mjs` `loadPlugins`/`unloadPlugin` (ownership
  ledger, migrations, mounts, subscriptions all released), `plugin-events.mjs`
  bus (`subscribe`/`unsubscribe`, attached to frameRuntime in
  `create-server.mjs:169-179,505-506`) — **no lifecycle publish to the SSE
  gateway yet** (gap → S5).
- `core/config/config-paths.mjs`: `KIKX_PLUGIN_INSTALL_ENABLED_PATH`,
  `KIKX_PLUGIN_PATHS_PATH`.

Client (`src/client`):

- `shared/client-component-kinds.mjs`: kinds `settings-panel`, `sidebar-item`,
  `view`, `toolbar-action` already exist; the single vocabulary rule (no
  second list) must keep holding.
- `state/client-component-state.mjs`: derived `state.clientSettingsPanels`;
  `components/kikx-settings-panel.mjs`: `listSettingsPanels(state)` →
  `{surfaceID, tagName, label}`, element cache in
  `state/settings-panel-elements.mjs`, mounted **today in the dialog**
  (`kikx-modals.mjs:_buildSettingsDialog`, `state.settingsOpen`).
- `components/client-view-surfaces.mjs`: core fallback table + plugin view
  dispatch — the P7 gate "no new `viewName ===` branch" — new core view =
  table entry, NOT a branch.
- `state/view-name-registry.mjs`: `CORE_VIEW_SURFACE_IDS` (feeds `VIEW_NAMES`
  → `pushView` validation, `navigation-stack.mjs:150`).
- `components/kikx-sidebar-session-objects.mjs`: `SESSION_OBJECT_GROUPS =
  ['view','footer']` (`:65`), built-in view rows (`:96,:105`), `sidebar-item`
  descriptor rows already flow into the `view` group (`:128-143`).
- Topbar `kikx-settings-open` text button in `kikx-topbar.mjs`
  (`buildTopbarActions`) → `_openSettings` dialog.
- View helpers pattern: `navigateInbox`-style wrappers in
  `state/navigation-stack.mjs`.

## 4. The delta (what does not exist yet)

1. No `settings` core view/mode, no section tabs, no System Settings sidebar
   entry, no gear icon.
2. No `SettingsPage` base class for plugins; `settings-panel` descriptors have
   no `section` concept (Xenocept plugins own a sidebar/tab section).
3. Plugins section UI: inventory list, cards, unload/reload/install actions,
   npm Browse column — none exists client-side.
4. Server install accepts only `{path}` — no npm spec; no npm search endpoint.
5. No signature verification anywhere in Kikx (`.kikx-sig` envelopes), no sign
   tool, no unsigned-chip in UI.
6. No plugin lifecycle events on the SSE gateway → other open tabs never see
   an install/unload they did not trigger.
7. Topbar Settings still opens the modal dialog (to be replaced by the mode).

## 5. Phases (each phase = failing-first tests, full suite green, push; no deploy)

### S1 — System Settings shell mode (the two annotations)

- `state/view-name-registry.mjs`: add core id `settings` (label "System
  Settings") to `CORE_VIEW_SURFACE_IDS`.
- New `components/kikx-system-settings-view.mjs` (line-capped; cached via
  `state/view-surface-elements.mjs` like other views): `buildSystemSettingsView`
  rendering, inside `buildRunnerShell` through the existing dispatch (no shell
  edit beyond the core table entry):
  - heading "System Settings";
  - section tab row (same visual family as `.kikx-view-header`), sections from
    the S2 model; local choice in `state.settingsSection` (default `'General'`,
    `'Plugins'` when opened from a plugins entry point);
  - `General` section: host-owned Account block (name/email, read-only) — the
    placeholder for host preferences; deliberately small in S1.
- `state/navigation-stack.mjs`: `navigateSystemSettings(state)` wrapper
  (`pushView(state, 'settings')`) mirroring `navigateInbox`.
- `kikx-topbar.mjs`: replace the `kikx-settings-open` text button with an
  icon-only gear (`createIcon('gear')` — icon exists) titled "System Settings",
  `onClick → navigateSystemSettings + requestRender`. The dialog path
  (`_buildSettingsDialog`, `settingsOpen`) stays in code but is no longer
  reachable from the topbar; specs that assert topbar→dialog are updated to the
  navigation contract.
- Sidebar: "System Settings" row in the `view` group (label exact per
  annotation), active when `view === 'settings'`.
- Specs: `spec/client/system-settings-view-spec.mjs` (sections model, dispatch
  resolves through the core table, no `viewName ===` new branch — grep-gate),
  updates to topbar/sidebar specs, stylesheet gate for any new class.

### S2 — SettingsPage base + sections + Installed Plugins UI

- New `lib/settings-page.mjs`: `class KikxSettingsPage extends HTMLElement`
  — the base the owner asked for — with `configure({ label, description,
  section })`, an app/state slot, and teardown-safe helpers. Plugin import path:
  absolute same-origin `/client/lib/settings-page.mjs` from the plugin's
  `moduleURL` module (documented in S6).
- `settings-panel` descriptor gains optional `section` (string, default
  `'General'`): `listSettingsPanels` passes it through; sections model = `['General','Plugins'] ∪ plugin sections` (sorted, plugin order stable by surfaceID). Panels mount in the view body of their section using the existing
  element cache (`settings-panel-elements.mjs`) — the dialog mount stops being
  the primary consumer.
- Inventory store (new leaf state module): `systemSettingsPlugins =
  { inventory, failures, restartRequired, loading, error }` fetched with
  `_getJSON('/api/v1/plugins')` when the view opens; operator 401/403 surfaces
  as `error` with the server's message (the "Sign in required…" single
  message stays intact).
- Plugins section layout mirrors Xenocept: left column **Installed Plugins**
  cards (name, `manifest.version`, description, mounts/subscriptions summary,
  `Internal Plugin — cannot be uninstalled` when the location is a built-in,
  failures listed from `failures`); card actions: **Unload** (`POST
  /api/v1/plugins/unload`), **Reload**, **Install from path** (absolute path
  input → `POST /install`, honoring the 403 config-gate hint). Right column:
  Browse (S3).
- Realtime-light: every successful action re-fetches the inventory; the view
  refetches on `visibilitychange`→visible. Cross-tab/other-operator realtime is
  S5.

### S3 — NPM integration (port of Xenocept's)

- `POST /api/v1/plugins/install` accepts `{npm: "<pkg[@version|range]>"}` in
  addition to `{path}`: validate the spec (strict regex, no flags/spaces —
  argv-array spawn, never a shell), `npm pack <spec>` into a temp dir, extract
  with `tar -xzf` (both exist in the node image), land it at
  `<KIKX_PLUGIN_NPM_DIR>` (new config key, default `<data>/plugins/npm/<pkg>`),
  append that directory to `KIKX_PLUGIN_PATHS` via the config store so `reload`
  keeps finding it (the reload route already re-reads config), then run the
  same `loadPlugins + migrations + rollback` pipeline as `{path}`. Same
  operator + config gates.
- `GET /api/v1/plugins/search?q=` → npm registry `/-/v1/search` with keyword
  **`kikx-plugin`** (Kikx's mirror of Xenocept's `xenocept-plugin`; confirm the
  keyword name with the owner before publishing docs), mapped to
  `{name, version, description}`; gated with the INVENTORY action (no local
  disclosure either way).
- Browse column UI: search input + result cards (name/version/description +
  Install → `POST {npm}` → inventory refresh), notice text mirroring Xenocept's.
- Tests: spec-validation unit (rejects `--ignore-scripts`, spaces, paths),
  route spec with mocked spawn/registry, client section spec with fixture
  responses.

### S4 — Ed25519 signatures (Xenocept scheme, ported)

- Envelope `.kikx-sig` next to `plugin.json`: `{payload: base64(manifest file
  bytes), signature: base64(64-byte ed25519 signature over those bytes)}` —
  verify the payload is byte-identical to the manifest on disk first (tamper/
  swap defense), then `crypto.verify(null, payloadBytes, publicKey, sig)`.
- Config: `KIKX_PLUGIN_SIGNING_PUBLIC_KEY` (base64 raw 32-byte key; new
  config-paths entry + `.env.example`), `KIKX_PLUGIN_SIGNATURES_REQUIRED`
  (`false` default = verify-if-present; `true` = unsigned refuses to load).
- Enforcement: `plugin-loader` pre-import gate → a bad/missing-under-required
  signature becomes a load failure with reason `signature` (visible in
  inventory `failures`); install route reports verification outcome.
- `scripts/sign-plugin.mjs`: owner-run signer (private key via env/flag only,
  never committed) writing `.kikx-sig`; mirrors `emit-manifest.sh` semantics.
- UI: the `plugin-card-status-unsigned` chip (Xenocept parity) on cards whose
  plugin lacks a valid signature (inventory needs a `signed: bool` field).
- Tests: keypair fixture roundtrip; tampered manifest fails; policy
  `if-present` vs `required`; loader refusal with recorded failure; route
  response shape.

### S5 — Realtime install/remove across clients

- After successful install/reload/unload the route publishes
  `plugin.changed {pluginID, action}` to a gateway the SSE stream carries
  (find the runtime-event gateway seam in `kikx-runtime-events`/gateway and
  add the type — follow the existing batching rules); client: when the event
  lands and the settings view is open, refetch inventory (targeted update, no
  shell repaint). Fallback already in S2 (own-action refresh + visibility).
- Test: fixture SSE emits `plugin.changed` → settings view list updates in
  place; route spec asserts the publish fires exactly once per action.

### S6 — Docs

- `docs/guides/plugin-authoring.md`: SettingsPage base + `section` field +
  sidebar-item/settings-panel examples; signature signing how-to
  (`scripts/sign-plugin.mjs`); npm install usage.
- `docs/reference/plugins.md`: endpoints (search added), signature policy,
  config keys.
- `.env.example`: the two new keys; `docs/README.md` index if new files land;
  campaign plan evidence rows updated per phase.

## 6. Test inventory (planned)

- `spec/client/system-settings-view-spec.mjs` — sections union, dispatch via
  core table, no new `viewName ===` branch.
- `spec/client/settings-page-spec.mjs` — base class contract.
- `spec/client/settings-plugins-section-spec.mjs` — cards from inventory,
  internal/uninstallable rules, actions call the right endpoints (stubbed).
- `spec/plugins/plugin-signature-spec.mjs` — sign/verify/tamper/policy.
- `spec/plugins/plugin-npm-install-spec.mjs` (or extend the existing plugin
  route spec) — spec validation + install pipeline with mocked spawn.
- `spec/ui/puppeteer/system-settings-shell-puppeteer.mjs` — gear → shell,
  sections switch, sidebar entry active state, plugins cards render from an
  extended stagehand fixture (`GET/POST /api/v1/plugins*`), unload refresh,
  npm Browse install flow (fixture-mocked), settings-panel section mount.
- Updates: `plugin-component-any-area-spec` (mount moves from dialog to view),
  topbar gear specs, `sidebar-shell-scope-spec` (new entry), stylesheet gate.

## 7. Carried constraints

- No deploy; do not touch `kikx2`/`:3001`; source caps 500/800 (split new
  modules); targeted updates only (no shell repaint for inventory refresh);
  failing-first for state updates; full suite + relevant browser lanes + Aeor
  harness per commit; commit/push each phase; docs index + authority banner on
  every new doc; `grep gate`: no new `viewName ===` branches.

## 8. First action after compaction

Read §9 first — it changes the S3/S4 execution order and amends S1, S2 and S5
— then read this file end to end, then start **S1** with the failing-first view
spec (`spec/client/system-settings-view-spec.mjs`) and the core-table entry in
`state/view-name-registry.mjs`, including the reserved-id conflict behavior
(9.3.9), the PLUGINS sidebar group heading (9.1.4), and the identity-gate
assertion (9.3.13). Re-run the recon anchors in §2/§3 if any file
has moved. Latest baseline at writing: Kikx suite **3,329 tests / 3,299 pass /
0 fail / 30 skipped** on main `72068f7f`; Aeor main `0a73ec3` harness 2/2.

## 9. Critical pass (AGIS, 2026-11-05, revision 2)

Executed `::agis.ponder`, `::agis.devil_vs_angel`, `::agis.test_protocol`
plus the `map_territory` and `thorough_review` reflexes against §1–§7.
Findings are grouped by what they change. **§9 overrides conflicting phase
text in §5.** Every claim below was verified by search in this session.

### 9.1 Scope gaps vs "all of it" (amend S2/S5; owner decisions 2 and 5)

1. **Uninstall does not exist — "real-time removing" is half-built.**
   `plugin-routes.mjs` has zero delete/uninstall/purge routes (searched);
   Xenocept has `/plugins/uninstall` (`xenocept-client.js:202`,
   `uninstallPlugin` `:3537`, disabled edit button `:2674`). The plan only
   offered Unload, which deliberately keeps files. **Action:** new
   `POST /api/v1/plugins/uninstall` (sibling of install/reload/unload) — same operator +
   config gates, new `PLUGIN_ADMIN_ACTIONS.UNINSTALL`; unloads runtime then
   removes files **only** under managed dirs (`KIKX_PLUGIN_NPM_DIR` /
   explicit install paths), never built-ins; per the platform-campaign
   ownership ruling durable plugin *data* is retained (purge stays a separate
   future action); card gains a confirm-once Uninstall next to Unload.
   The policy file's header comment enumerates covered endpoints and must be
   extended.
2. **Enable/disable toggle missing.** Xenocept cards have
   `plugin-card-toggle` → `pluginLoader.setEnabled(directoryID, next)`
   (`xenocept-client.js:3594-3607`). Kikx `inertOverrides`
   (`class-registry.mjs:180`) is class-consumption reporting — unrelated;
   no persisted enable/disable exists anywhere. **Action if approved:**
   persist a disabled set (candidate: generic tag store
   `{target_type:'plugin'}` or config), loader honors it at load, toggle
   disable→unload / enable→reload-path. **Owner decision #2.**
3. **"Real-time" needs descriptor refetch, not only inventory.**
   `/api/v1/client-components` is fetched by `loadClientComponents`
   (`kikx-data.mjs:218`) from `app._loadClientComponents` (`kikx-app.mjs:320`,
   called `:527` boot and `kikx-editors.mjs:370`) — never after plugin
   changes. A live install's `settings-panel`/`sidebar-item`/`view`
   descriptors therefore never appear until a full reload, so S5's claim
   would be half-true. **Action:** on `plugin.changed` run **both**
   `app._loadClientComponents()` (the seam already exists) and the inventory
   refetch. The element caches are already built for this —
   `settings-panel-elements.mjs:10` documents `setClientComponents` as the
   single writer that learns of uninstall, `view-name-registry.mjs:38`
   defines clear semantics. Xenocept parity for the pattern:
   keyed re-render when the installed set changes (`:2121-2130`, Install ↔
   Uninstall buttons flip in lockstep between columns).
4. **PLUGINS sidebar group never entered the plan.** Xenocept groups plugin
   rows under a `PLUGINS` sidebar heading; Kikx `sidebar-item` rows mix into
   the `view` group with Inbox/Agents/Teams
   (`kikx-sidebar-session-objects.mjs:128-143`). **Action (S1):** render a
   `PLUGINS` group heading when ≥1 plugin-owned sidebar item exists;
   presentation only, with a spec.
5. **Per-plugin config parity = declare non-goal.** Xenocept's config
   GET/PUT (`:592`) has a Kikx equivalent already: the plugin's own
   `settings-panel` + scoped plugin DB (platform P2 services). No core config
   endpoint. Favorites/star (`:3550-3567`) and update-available badges
   (`:3644`) = deferred nice-to-have. **Owner decision #5.**

### 9.2 Security findings (amend S3/S4; owner decision 3)

6. **The S3 npm pipeline as written has an integrity gap.** `npm pack
   <spec>` verifies nothing: (i) no check against the registry's
   `dist.integrity` sha512; (ii) spec validation must pin to registry
   package names — `git+`, `file:` and URL specs silently change the trust
   story (and git specs run lifecycle scripts); (iii) extraction needs
   tarbomb/path-traversal guards (absolute and `..` members rejected).
   **Action:** prefer a direct HTTPS tarball fetch from the fixed registry
   host + sha512 `dist.integrity` verify + safe extract — no npm CLI in the
   loop at all, matching Xenocept's CDN-tarball model — fallback
   `npm pack --ignore-scripts` with validated argv; cap and schema-validate
   registry JSON before rendering cards (host fixed ⇒ no SSRF).
7. **Signature scope must be stated honestly, and it tensions a ruling.**
   `.kikx-sig` signs *manifest bytes*: it proves publisher provenance +
   manifest integrity, **not** plugin-code integrity (an on-disk code swap
   with an untouched manifest still loads). The platform campaign's owner
   ruling says plugins are trusted code with *no allowlist/new authority
   boundary* — `KIKX_PLUGIN_SIGNATURES_REQUIRED=true` is effectively a
   publication allowlist, so: default **if-present** (every current
   deployment keeps working, ruling intact), `required` is opt-in hardening,
   and S6 docs must record this reconciliation. Built-ins are either signed
   in-repo or exempt under if-present (**owner decision #3**).
   Verification failure = recorded inventory failure with reason
   `signature`, never a crash or a silent skip.
8. **Rotation.** One `KIKX_PLUGIN_SIGNING_PUBLIC_KEY` makes rotation
   painful; accept comma-separated `KIKX_PLUGIN_SIGNING_PUBLIC_KEYS` (overlap
   window), failures record which key matched. Private key stays offline
   (sign script env/flag only, never repo or DB) — mirrors Xenocept's plan
   line "private key offline".

### 9.3 Shell/mode integration (map_territory; amends S1/S2 tests)

9. **Reserved-id rule first.** `view-name-registry.mjs:27/:105`: plugin
   descriptors may not take core ids. Claiming `settings` flips any
   plugin-owned `settings` view to rejected — read the implementation, then
   fix the conflict behavior in S1 (core wins, reason recorded) with a test.
10. **Deep-link comes free and must be proven.** `?view=` validates against
    the live registry (`view-deep-link-spec.mjs:1-45`) → `?view=settings`
    works once registered; add addressability assertions and confirm
    `maybeRestoreMessageHash` stays inert on sessionless settings entries
    (there are no frames to hash).
11. **Statusbar on sessionless views** already reports workspace totals by
    design (Inbox precedent, `statusbar-stats-spec.mjs:167`) → Settings will
    too; default to Inbox-consistent (**owner decision #4**).
12. **Section clamp on live unload:** if a plugin's section is selected and
    that plugin is uninstalled elsewhere, clamp `settingsSection` to
    `General`; selection lives in app state (S1) with a failing-first test.
13. **Identity gate for the mode switch** — "exact same layout, reutilize
    the sidebar" must be proven as DOM identity, not pixels: assert shell
    root + sidebar element identity across `pushView('settings')` and back
    (property-store doctrine), in the puppeteer spec.
14. **Mobile:** the section tab row and the two-column Plugins section must
    stack at ≤960px / ≤520h; add a 390px assertion and confirm the hamburger
    drawer still works over the settings view (new CSS rules + stylesheet
    gate).

### 9.4 Test protocol findings (test_protocol)

- **Fixture/route pairing:** every stagehand fixture endpoint must be
  paired with a real route unit test — the fixture proves the UI, the unit
  proves the contract; alone, each gives false confidence (cynic pass).
- **Hang risks:** units must mock registry fetch and spawn entirely (no
  `registry.npmjs.org`, no child processes — unmocked network/stdin are the
  listed hang culprits); 10s watchdogs default; the SSE test uses bounded
  waits and covers reconnect/resync by following the stream's existing
  visibilitychange re-check (`kikx-runtime-events.mjs:344`) rather than
  inventing a second mechanism.
- **Signature tests:** real generated ed25519 keypairs only (wrong-length
  base64 keys = false confidence); cover payload-mismatch AND sig-mismatch.
- **Extend, don't fork:** `navigation-stack-spec`, `view-deep-link-spec`,
  `statusbar-stats-spec`, `plugin-component-any-area-spec`,
  `plugin-unload`/route specs, documentation + source-size gates.
- **TDD order:** sections model, section clamp, and the inventory reducer go
  failing-first before any UI.

### 9.5 Sequencing correction (devil_vs_angel)

- **Devil won: execute S4 (signatures) before S3 (npm).** Shipping the
  untrusted-code entry point first and retrofitting provenance is backwards;
  the first npm install must already flow through the verify-at-load gate
  (active under if-present from day one; `required` flips later). S4's
  mechanics don't depend on keys existing yet — envelope parse, policy,
  failures and the sign script land first; key generation can follow.
- **Angel's insight kept:** `plugin.changed` carries **invalidation only**,
  no payload — the client re-pulls inventory + descriptors with its own
  credentials. Single auth path, no privilege in the event, bounded event.
- **Execution order after the pass:** S1 → S2 → S4 → S3 → uninstall /
  enable-disable (pending owner decisions) → S5 → S6. Phase IDs keep their
  §5 names; this order governs.

### 9.6 Open questions for the owner (Peer precept — decisions, not delays)

1. npm search keyword: `kikx-plugin` (Xenocept mirrors with
   `xenocept-plugin`)?
2. Enable/disable toggle (9.1.2) in scope for this campaign?
3. Signature default: **verify-if-present** (recommended — keeps the trusted-
   code ruling intact) vs required from day one; built-ins signed in-repo or
   exempt?
4. Uninstall contract: remove files of path/npm-installed plugins only,
   retain durable plugin data, never built-ins — confirm?
5. Statusbar totals on Settings (Inbox-consistent default) and deferring
   favorites/update badges — confirm?

S1 is unblocked regardless of these answers.
