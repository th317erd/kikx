---
title: Plugin platform campaign
status: current
doc_type: plan
audience: [developers, maintainers, operators]
applies_to: development-v3
last_verified: 2026-10-29
---

# Plugin platform campaign

## 1. Evidence

### Current baseline

- Final-pass baseline: Kikx main `fb45f8b6`, after the plugin platform, ownership ledger, authority namespace, admin auth, and driver-qualified migration work.
- Non-doc suite after that merge: **2863 tests, 2834 pass, 0 fail, 29 skipped**.
- The original Miri branch was `f201985e`, **48 commits ahead / 18 behind** at review time; that branch's isolated suite was **2709 tests, 2680 pass, 0 fail, 29 skipped**.
- The plugin-router spec is **12/12 pass**.
- The merge completed; the combined revision has passed the non-doc suite. Plugin attribution/unload tests, authority namespace tests, admin-auth tests, and migration-driver tests now exist. Plugin mount auth descriptors, scoped-DB/event contracts, and live install/reload/unload still need work.
- The laptop dirty tree was the documentation migration plus untracked docs/testbed/public files; no plugin source was dirty.

### Registry facts

- `CORE_CLASSES` contains 8 classes: `PluginRegistry`, `PluginInterface`, `AgentInterface`, `CommandRegistry`, `FrameRouter`, `FrameRuntime`, `CompactionService`, `DatabaseConnectionBase`.
- Only three construction sites resolve a core class through the registry:
  - `FrameRouter` (`src/server/create-server.mjs:212`)
  - `FrameRuntime` (`:424`)
  - `CompactionService` (`:462`)
- `PluginRegistry` is constructed directly before plugins load. A plugin cannot override the registry it is loading into.
- `CommandRegistry` is constructed directly.
- `AgentInterface`, `PluginInterface`, and `DatabaseConnectionBase` are bases used by providers/tools/drivers, not construction points for a running core service.
- Specialized plugin collections are not class stacks:
  - tools (`Map`, last registration wins)
  - agent providers (`Map`)
  - database drivers (`Map`)
  - selectors (`Array`, append order)
  - frame/tool/config-form components (`Map`)
  - tag definitions (`Map`)
  - frame indexes (`Map`)
- `unloadPlugin()` currently removes only entries attributed to the plugin in the `ClassRegistry` stacks. Specialized collections are not removed with it.
- Some built-in feature families are core-authored but registry-shaped:
  - 63 built-in tools and 4 built-in frame components in `src/core/tools/register-built-in-tools.mjs`
  - 8 internal commands in `src/core/commands/internal-commands.mjs`
  - 3 core tag definitions in `src/core/tags/tag-definitions.mjs`
  - frame-type classes in `src/core/frames/frame-types/`
  - routing, question scheduling, prompts, precepts and compaction policy in core modules

### Server and client ownership

- 13 route files and roughly 69 route condition sites under `src/server/routes/`.
- 50 `context.set(...)` service/store constructions in `src/server/create-server.mjs`.
- `create-server.mjs` is 680 lines; `kikx-shell-builders.mjs` is 632 lines.
- The browser has hardcoded view names, sidebar descriptors, shell dispatch and an explicit optional-component list.
- Client component descriptors support only `frame`, `tool`, and `agent-config-form`.

### Miri's platform work

Miri's work is now merged into main; the platform was merged at `850c811b`, the ownership ledger completed at `65f1fb1a`, and the latest platform baseline is `fb45f8b6`. It added:

- plugin HTTP mounts under `/api/plugins/<plugin-id>/`;
- a plugin inventory, reload endpoint, and gated install endpoint;
- scoped plugin database handles with table-prefix and DDL restrictions;
- deny-by-default capability checks;
- scoped event subscriptions;
- ordered, checksummed SQL migrations;
- setup/onInit/onShutdown lifecycle hooks;
- plugin manifests, duplicate-name refusal, location hashes, load-failure inventory;
- quiet session appends and agent audit tails;
- shutdown bounds and timer fixes.

This is a substantial platform foundation. It is not yet a complete plugin-way implementation.

### Concrete defects in the existing platform work

- Authority now derives its table from the plugin namespace and is generic; the remaining authority question is only the owner ruling that plugins are trusted code.
- `PluginDatabase` is still SQL-shaped. `PluginMigrations` now declares driver support and refuses unsupported drivers instead of silently applying PostgreSQL DDL.
- Core-owned plugin admin endpoints now require an authenticated Kikx identity. Plugin mount handlers still need per-route auth descriptors; the plugin-admin policy deliberately does not cover mounts.
- The ownership ledger now attributes and releases mounts, migrations, tools, selectors, tags, drivers, components, indexes, scoped DB handles and subscriptions. The remaining lifecycle risk is that class-stack overrides are released through a separate path and existing instances are not rebuilt.
- Authority, admin auth, router and unload/attribution have regression tests. Remaining contract gaps are plugin mount auth descriptors, scoped-DB driver behavior, event delivery, and install/reload failure paths.
- The branch has no client view/navigation registration.
- The branch has no generic service registration or startup/recovery registration.
- The branch's package/config changes include plugin-specific Discord paths in core config.

## 2. Territory

Trace every path from boot to behavior:

```text
server entry
  → createServer
  → registerCoreClasses
  → registerBuiltInTools / tag definitions
  → plugin discovery and setup
  → plugin route/migration/database/event registration
  → database driver selection
  → service/store construction
  → FrameRouter selectors
  → FrameRuntime
  → frame persistence and routing
  → auth/account/session/question/tag/team/todo routes
  → client component descriptors
  → browser shell/navigation
  → session/thread views and actions
  → shutdown/recovery
```

### Files in scope

- Plugin core: `src/core/plugins/`, `src/core/routing/`
- Server composition: `src/server/create-server.mjs`, `src/server/index.mjs`,
  `src/server/router.mjs`, `src/server/routes/`, `src/server/shutdown.mjs`
- Class construction and registry: `src/core/plugins/class-registry.mjs`,
  `core-classes.mjs`, `plugin-registry.mjs`
- Frame/routing: `src/core/frames/`, `src/core/agents/agent-route-frame-plugin.mjs`,
  `src/core/questions/question-schedule-plugin.mjs`
- Persistence: `src/core/aeordb/`, `src/core/database/`
- Agent loop/prompt: `src/core/plugins/agent-interface.mjs`,
  `agent-loop-tools.mjs`, `agent-precepts.mjs`, `agent-brief-template.mjs`
- Client: `src/client/state/navigation-stack.mjs`,
  `kikx-shell-builders.mjs`, `kikx-sidebar-session-objects.mjs`,
  `src/client/lib/aeor-ui.mjs`, `src/client/components/frame-component-registry.mjs`
- Tests: `spec/core/plugins/`, `spec/plugins/`, `spec/server/`, `spec/client/`,
  `spec/ui/`

### External/durable surfaces

- Existing plugin manifests and package main entries.
- Existing plugin routes under `/api/plugins/`.
- Existing plugin migration directories and migration ledger.
- Client component descriptors and plugin asset URLs.
- Existing plugin load paths and `KIKX_PLUGIN_PATHS`.
- Current Postgres operational database and AeorDB compatibility path.
- Existing Kikx auth sessions, magic links, API tokens, and human accounts.

## 3. Frame

### Target

A feature can be installed, overridden, observed, reloaded, and unloaded without editing
`create-server.mjs`, a core route table, or the browser shell. Class overrides are real
only where construction resolves the registry; every other extension has an explicit
registration contract rather than an accidental map or direct import.

### Non-goals

- Do not make authentication or cryptography plugin-overridable.
- Do not let a plugin claim `/api/v1/auth/*` or another reserved prefix.
- Do not allow arbitrary plugin code into the core agent loop without a bounded control
  contract.
- Do not create a second UI framework or a second frame store.
- Do not migrate every built-in tool in one landing.
- No production deployment in this campaign.

### Success criteria

1. A test plugin can override a core class and the next constructed instance uses it.
2. A test plugin can register a service with dependencies and deterministic startup and
   shutdown; the service is removed on unload.
3. A test plugin can mount an authenticated, capability-checked HTTP route; unload
   removes the mount.
4. A test plugin can register a main-area view and sidebar entry without core edits.
5. A test plugin can register a frame index that works on each advertised driver and is
   removed on unload.
6. Plugin installation/reload cannot leave stale routes, tools, selectors, components,
   migrations, or event subscriptions.
7. Existing Kikx features keep their behavior; the full non-doc suite and relevant UI
   lanes pass.
8. The plugin docs and contract tests describe every new registration family.

## 4. Contracts

### 4.1 Registry and construction contract

The class registry remains the authoritative stack for class overrides.

Every overrideable class must be obtained through one resolver:

```js
resolveCoreClass(registry, key, fallback)
```

Rules:

- A class registration changes future construction only.
- A reload that claims to apply a class override must recreate affected instances or
  report that a restart is required.
- No construction site may use `new CoreClass()` when that class is registered as an
  override point.
- `PluginRegistry` itself must be created before plugin loading; its override is
  explicitly out of scope (chicken-and-egg).
- Auth/crypto classes stay outside the registry.

Add a registry-owned registration record:

```text
{ pluginId, kind, key, value, loadOrder, dispose }
```

`unregisterPlugin()` must remove every owned registration, not just class stacks.

### 4.1a Current class-resolution audit

| Class | Registered | Constructed through registry today | Required treatment |
|---|---|---|---|
| `PluginRegistry` | yes | no; created before plugin load | Keep core-owned; document bootstrap exception |
| `CommandRegistry` | yes | no; direct `new` | Resolve before construction or remove from override list |
| `FrameRouter` | yes | yes | Keep as the reference overrideable class |
| `FrameRuntime` | yes | yes | Recreate on reload or report restart-required |
| `CompactionService` | yes | yes | Recreate on reload or report restart-required |
| `PluginInterface` | yes | n/a; base class | Do not present as a live service override |
| `AgentInterface` | yes | n/a; provider base | Do not present as a live service override |
| `DatabaseConnectionBase` | yes | n/a; driver base | Override through concrete driver, not base row |
| Frame-type classes | yes | only when `createTypedFrame` receives a registry | Audit every model-context caller; pass registry consistently |

The plan must remove the ambiguity: a class is either a real construction override, a base class, or a deliberately core-only bootstrap exception.

### 4.2 Service contract

```js
registerService(name, {
  factory(context) -> instance,
  dependsOn: [serviceName],
  init(instance, context),
  health(instance),
  shutdown(instance)
})
```

- Services are constructed in dependency order after plugin load and database readiness.
- A failed required service prevents readiness.
- Optional service failures are reported but do not make an unrelated feature unusable.
- Service ownership is plugin-scoped; unload runs shutdown before removing.
- Auth/crypto services are not replaceable through this contract.

### 4.3 HTTP route contract

- Plugins receive a scoped mount: `/api/plugins/<plugin-id>/`.
- Reserved IDs `api`, `v1`, `plugins` remain refused.
- Every plugin route has an explicit transport auth policy:
  - `required` by default for non-public routes;
  - `public` must be declared and reviewed.
- Auth is an ordinary HTTP policy, not a plugin capability boundary. Plugins are trusted
  code and may override the main server application class and the browser shell.
- Raw body is preserved; size/deadline/error behavior is fixed in core.
- Install/reload endpoints require Kikx authentication, not only a config flag. An
  explicit operator capability is required if/when Kikx has a role model; until then the
  authenticated-identity check is the honest boundary, and the missing role model is
  reported rather than invented.
- Unload removes the mount and refuses new requests.

Route descriptor shape:

```js
{
  pluginId,
  mountPath,
  auth: 'required' | 'public', // public must be an explicit reviewed declaration
  capabilities: [{ actor, action, scope }],
  handler,
  dispose
}
```

The core router must evaluate auth and capability policy before calling the handler. A plugin cannot pass an arbitrary `actor` in the request body and have that count as authorization.

### 4.4 Client surface contract

Add descriptors for:

- `view`: label, icon, scope, builder module, optional count source;
- `sidebar-item`: placement, label, scope, action/view;
- `toolbar-action`: placement, label, icon, action;
- `settings-panel`: label, builder module;
- existing `frame`, `tool`, `agent-config-form`.

The server inventory returns descriptors; the browser imports modules through the
existing plugin asset route. A missing optional surface degrades; it does not reject the
entire client module graph. Unload must remove descriptors and the client must be able to
reconcile without a full shell rebuild where practical.

Main application descriptor shape:

```js
{
  kind: 'main-app',
  id: 'plugin-id.main-app',
  moduleURL: '/api/v1/plugin-assets/plugin-id/app.mjs',
  tagName: 'kikx-app',
  dispose
}
```

The bootstrap loader must select the main application module **before** the built-in
`kikx-app` is defined. The core `src/client/app.mjs` becomes a bootstrap that resolves the
descriptor and imports either the plugin main app or the built-in fallback. A plugin main
app owns shell composition but still receives the shared session/auth services.

View descriptor shape:

```js
{
  kind: 'view',
  id: 'plugin-id.view-id',
  label: 'View title',
  icon: 'icon-name',
  scope: 'session' | 'workspace' | 'global',
  moduleURL: '/api/v1/plugin-assets/plugin-id/view.mjs',
  tagName: 'plugin-view-id',
  dispose
}
```

No plugin may claim a reserved route prefix, inject raw HTML, or bypass the shared frame shell for conversation messages.

### 4.5 Persistence and index contract

- `registerIndex` describes a field, type and optional source path.
- The driver contract advertises index support.
- AeorDB receives index config; PostgreSQL creates an expression index; drivers without
  native index support may scan but must say so.
- Migration directories are plugin-owned and run once under a checksum ledger.
- A plugin index and its migrations are removed or tombstoned on unload according to an
  explicit retention policy; data is not silently deleted.
- Migration SQL is either driver-neutral or explicitly declares a driver capability.

Index descriptor shape:

```js
{
  name: 'focus_todo_id',
  type: 'string',
  source: ['content', 'focus_todo_id'], // optional nested source
  drivers: ['aeordb', 'postgresql'],
  removeOnUnload: 'definition-only' | 'retain-data'
}
```

`removeOnUnload` must never silently delete durable plugin data. The default is definition-only.

### 4.6 Prompt, loop and policy contract

Add named, bounded contributions rather than plugin-defined replacements of the loop:

- prompt sections;
- precepts;
- role/tag selectors;
- compaction strategies;
- loop-control extensions with a fixed terminal-state vocabulary.

The core loop remains finite and auditable. A plugin cannot create an unbounded hidden
wake path.

### 4.7 Manifest and lifecycle contract

```json
{
  "name": "plugin-id",
  "version": "1.0.0",
  "kikxVersion": ">=...",
  "requires": ["other-plugin"],
  "provides": ["capability"],
  "loadOrder": 100
}
```

- Duplicate plugin names are refused.
- Required dependencies must resolve; optional dependencies are reported.
- Load order is deterministic and conflict diagnostics name both plugins.
- `onInit` runs after all registrations for that plugin; `onShutdown` runs in reverse
  order; teardown remains idempotent.
- A setup timeout marks the plugin failed and rolls back partial registrations; a
  non-cancellable setup that later mutates state must be quarantined or require restart.

## 5. Decisions

### D1 — Treat the merged Miri platform as the foundation

`origin/miri-plugin` has been merged into main; the current platform baseline is `fb45f8b6`. Preserve the merged
scrollview, session-scope, filter, end-turn and todo-focus-index work while hardening the
platform. Do not re-integrate the old branch or selectively revert it without a written
conflict map.

Reason: it already supplies routes, DB, events, migrations, lifecycle and inventory.
Rebuilding those in parallel would duplicate work and create incompatible contracts.

### D2 — Plugin routes are authenticated by default

Public plugin routes must be explicitly declared. The current unauthenticated inventory
and reload/install surface must be hardened before the route contract is called complete.

This is a security default, not a feature preference.

### D3 — Built-in feature migration is phased

The campaign first builds the seams, then migrates one complete family (Questions or Todo
UI) as the reference plugin. It does not mechanically move all 63 tools in one phase.

Reason: a reference plugin proves routes, views, services, indexes and unload together.

### D4 — The main application shell is deliberately hijackable

Plugins are trusted code. A plugin may override the main **server** application class,
the browser **`kikx-app` shell**, and any service/store or client composition surface it
can resolve through the relevant registry. Do not build a per-class allowlist or an
authority boundary around plugin overrides in this campaign.

This includes the shell's composition surfaces: root app element, topbar, navigation,
views, sidebar/session objects, toolbar/actions and settings panels. A plugin that
replaces `kikx-app` may choose a different composition of those surfaces; it must still
use the shared auth/session data services rather than inventing a second credential model.

`registerService` remains useful for dependency order, lifecycle and teardown, but it is
not a security boundary. Existing database-prefix checks and route authentication are
kept as ordinary safety/transport policies, not as claims that a hostile plugin is
contained. Do not spend campaign effort generalizing `PluginAuthority`; the existing
Miri-specific authority code is out of scope unless a later security campaign asks for
it.

### D5 — Mount paths remain scoped

Keep `/api/plugins/<plugin-id>/`; never allow a plugin to claim `/api/v1/*` directly.

### D6 — Index support is driver-qualified

A plugin index declares its driver capabilities. PostgreSQL expression indexes and AeorDB
index configs are both first-class; unsupported drivers report a scan fallback rather than
pretending the index exists.

### D7 — UI surfaces are descriptors, not core branches

No new `viewName === ...` branches in `kikx-shell-builders.mjs`. Views/sidebar/toolbar
entries come from descriptors and modules.

### D8 — Owner rulings

Recorded owner rulings:

1. **Built-in migration scope:** build the seams and migrate one complete reference
   family in this campaign; move the remaining built-in tools/frames in later phases.
2. **Public plugin routes:** authenticated by default; a route may be public only by an
   explicit reviewed declaration. No public default in development.
3. **Service/class and shell override:** the main server application class and the
   browser `kikx-app` shell are deliberately hijackable. Plugins are trusted code; no
   allowlist and no new authority boundary around plugin overrides. Existing safety
   checks remain ordinary defenses, not a containment claim.
4. **Uninstall retention:** remove definitions, routes, indexes and migration
   registrations by default; retain durable plugin data unless an explicit purge is
   requested.

These are owner rulings, not recommendations still awaiting ratification.

## 6. Phases

### P0 — Integrate and harden the existing platform

Start gate: current main `fb45f8b6` is green on the non-doc suite, and the merged
platform work has been inspected against the current construction sites.

Work:

- Record the final merged baseline (`fb45f8b6`, 2863/2834) and remove the stale
  "not yet merged" assumption from the campaign.
- The duplicate `pg` declaration has been normalized; verify the optional dependency
  installation path remains intact.
- Preserve both plugin-index and Miri platform work; do not re-apply the old branch.
- Extend the existing authority/attribution/unload tests to cover route auth, scoped-DB
  driver behavior, event delivery, migrations and install/reload failure paths. Do not
  rely on the router and ownership tests alone. (**Event delivery is now covered**:
  `spec/plugins/plugin-event-delivery-spec.mjs` drives delivery, scoping, isolation and
  reload through the loader. See the still-open list for the reload defect it found.)
- Add ordinary Kikx authentication gates to plugin inventory, reload, install and
  mutating plugin routes.
- Do not generalize `PluginAuthority` or add a plugin capability boundary; the owner
  ruling makes plugins trusted code.
- Make migration/database contracts explicitly driver-qualified; keep Postgres working
  while reporting unsupported drivers.
- Run full suite and plugin contract tests.

Exit proof:

- Existing suite green.
- New platform tests cover success, malformed input, timeout, oversized body, duplicate
  name, failed setup, failed migration, unauthorized route, unload cleanup.
- The main application class override is explicitly tested; no authority boundary is
  claimed.
- One live boot with a no-op plugin confirms inventory/mount/auth/unload.

### P1 — Registry construction and ownership

Work:

- Add a single `resolveRegistered` construction path.
- Audit every `new CoreClass()` for classes in `CORE_CLASSES`.
- Either resolve it through the registry or document why it is deliberately core-only.
- Verify the ownership ledger covers every registration family, including the new
  frame-index API; add a missing-family test gate.
- Keep class-stack overrides on their separate release path and add generation/reload
  semantics: a class override that requires rebuild reports `restart-required` if a live
  instance cannot be replaced.

Exit proof:

- A test plugin overrides `FrameRouter`, `FrameRuntime`, `CompactionService` and the main
  server application class; the next constructed instances use the overrides.
- A browser bootstrap test selects a plugin `main-app` descriptor before the built-in
  `kikx-app` is registered, and falls back when none is present.
- Direct construction tests prove no bypass remains for registered classes.
- Unload test proves every registry collection returns to its pre-plugin state.

### P2 — Service and startup lifecycle

Work:

- Implement `registerService`.
- Introduce ordered startup phases and recovery hooks.
- Migrate one feature service (Questions or Todo) as the first plugin-owned service.
  **Landed:** `plugins/todo-focus-index` registers `todoFocusIndex` as that service
  (`spec/plugins/todo-focus-index-service-spec.mjs`). Writing the contract exposed two
  real defects in the previous shape: the index promise lived in module scope, so a
  reload silently reused the first load’s result, and its `.catch(() => {})` cached one
  transient startup failure for the process lifetime. It deliberately declares no
  `dependsOn: [ 'aeordb' ]`, because a missing database was always tolerated and a hard
  dependency would turn that tolerance into a boot-aborting init error.
- Register health checks and shutdown teardown.
- Ensure a failed required service fails readiness; optional failures are visible.

Exit proof:

- Service dependency order test.
- Init failure test.
- Shutdown failure isolation test.
- Plugin unload removes service and subscriptions.
  **Proven:** the same spec unloads and asserts the service registration, the context
  entry and the frame-index registration are all gone.

### P3 — HTTP route ownership

Work:

- Formalize the Miri route mount with auth/capability policy.
- Add route descriptor inventory and unload.
- Add request limits, timeout, raw body, error mapping and capability tests.
- Move one plugin-facing integration route from a core route file to a bundled plugin.
- Keep auth/account routes core.

Exit proof:

- Authorized route succeeds.
- Unauthorized route is rejected before handler by ordinary Kikx auth.
- Oversized body, malformed JSON, timeout and handler failure are deterministic.
- Unload returns 404/route-not-found immediately.

### P4 — Client surfaces

Work:

- Add main-app/view/sidebar/toolbar/settings descriptors.
- Replace the static `src/client/app.mjs` import with a bootstrap that chooses a plugin
  `main-app` module before defining the built-in `kikx-app` fallback.
- Extend client component loading to consume the descriptors.
- Move Agents and Teams views behind descriptors as the first reference.
- Keep Inbox available as core or move it after parity.
- Add unload/reload reconciliation and focus/selection preservation.
- Ensure a missing optional descriptor does not abort the client boot.

Exit proof:

- A plugin `main-app` can replace the shell and render a view with no core shell edit; the
  built-in app remains the fallback.
- A plugin view renders in the main area with no core shell edit.
- A plugin sidebar entry navigates and shows active state.
- Reload/removal returns to the prior view.
- Existing Agents/Teams/Inbox Playwright tests remain green.

**P4 view surfaces by descriptor — landed.** The work-area dispatch no longer
compares the view name against literals. `kikx-shell-builders.mjs` renders
`resolveViewSurface(viewName, state, app) || buildWindow(app, entry)`, so the P7 grep
gate (no new `viewName ===` branch) is met rather than re-broken by the next view.

Three defects fell out of writing the contract, none of which was the documented
task. First, `setClientComponents()` filed only `frame`/`tool`/`agent-config-form`
descriptors and dropped `view` and `sidebar-item` on the floor, so a plugin view was
advertised by `GET /api/v1/client-components` and discarded by the client —
unreachable, not merely unimplemented. Second, the addressable view vocabulary was a
frozen literal in `navigation-stack.mjs`, so `pushView()` refused a plugin view name
even after a successful registration; it is now derived from the descriptors served,
which also means uninstalling a plugin shrinks the set again instead of leaving the
stack able to hold a view nothing renders. Third, resolving a surface with no app
produced an empty section — the blank work area the null fallback exists to prevent —
so the resolver now answers null without one.

Core view ids are **reserved**: a plugin descriptor whose surfaceID collides with
`inbox`/`agents`/`teams` is refused at `setClientComponents`, so a plugin cannot
silently take over a built-in surface. Core views are NOT server descriptors — they
are builder functions, and a descriptor requires a `moduleURL` custom element — so the
built-ins live in a core fallback table keyed by the same ids. Plugin `sidebar-item`
descriptors render as rows in the view cluster, after the core rows, reusing the same
`isViewOpen` active state and the `navigateView` seam. Proven:
`spec/client/view-surface-descriptors-spec.mjs`, 16 tests, of which reverting only
`kikx-state.mjs` fails exactly 8 and reverting only `kikx-shell-builders.mjs` fails
exactly the grep gate.

### P5 — Domain catalogues and prompt/loop policy

Work:

- Move built-in tools, commands, frame types and tag definitions into bundled plugin
  packages or plugin-shaped manifests.
- Add prompt-section/precept/role-selector registrations.
- Add bounded loop-control registration with terminal-state validation.
- Keep the core loop and authority model.

Exit proof:

- At least one built-in tool family is loaded and unloaded as a plugin.
- Prompt assembly and role priority tests prove plugin contributions and ordering.
- Loop-control tests reject unbounded or unknown terminal paths.

**P5 loop-control registration — landed.** The loop's terminal vocabulary is now a
closed exported set (`LOOP_CONTROL_TERMINALS` in `agent-loop-state.mjs`): finalize,
respond, break, route, null-response. `PluginRegistry.registerLoopControl()` refuses an
action that declares a terminal outside it, refuses the core's own action names, and
requires `allowsContinuation: true` before accepting the `respond` terminal, so a plugin
cannot acquire a self-wake by accident. Registrations are ledger-owned, so
`releasePlugin()` reverses them.

Dispatch gained a real fix rather than only a registry: `executeAskStep` now treats any
`LoopControl` that `handleLoopControl` did not apply as a hard stop. Before this, such an
output fell through with `state.finalized`/`state.break` untouched and the loop continued,
which is exactly the unbounded hidden wake path 4.6 forbids. Proven load-bearing: with
only `agent-interface.mjs` reverted to its parent commit, 2 of the 11 contract tests fail.

### P6 — Persistence and index uniformity

Work:

- Add the driver-qualified index contract.
- Make AeorDB and PostgreSQL paths testable from the same plugin.
- Add migration driver declarations and unload/retention behavior.
- Add checksum/immutability/conflict tests and advisory-lock concurrency tests.

Exit proof:

- One plugin index works on both test drivers that advertise support.
- Unsupported driver reports scan fallback.
- Migration failure rolls back; duplicate versions and changed applied files fail closed.
- Unload follows the declared retention policy.

### P7 — Consolidation and completeness

Work:

- Remove transitional shims and grep-gate direct imports/branches.
- Update plugin docs and the source map.
- Add contract harness to the standard test command.
- Run full suite, UI lanes, and live boot.
- Update the gap report with closed/open items.

Exit proof:

- No new `viewName ===` branch, hardcoded plugin feature route, or direct construction of a
  registered core class.
- All P0-P6 contract tests green.
- Full non-doc suite green.
- Docs index/authority gates green where the docs migration allows.
- Plugin install/reload/unload demonstrated live.

### Implementation status — 2026-10-30

Landed and verified:

- **P0:** merged Miri platform foundation, ownership ledger, admin authentication,
  driver-qualified migrations, and plugin failure inventory.
- **P2:** plugin-owned services with dependency ordering, replacement/restoration,
  shutdown hooks, and unload release.
- **P3:** authenticated-by-default plugin mounts, explicit public opt-in, identity
  propagation, and authenticated plugin-admin routes. Per-mount request limits,
  mount dispose, and deterministic mount error mapping are implemented and proven:
  a mount may tighten (never raise) the deployment body cap and deadline, malformed
  JSON is a 400 rather than a handler failure, and the inventory reports each
  mount's auth declaration and enforced limits so a public mount is reviewable.
- **P4:** client composition descriptors and a bootstrap that chooses a plugin
  `main-app` before defining the built-in `kikx-app` fallback.
- **P5:** ordered plugin prompt sections; the remaining built-in catalogue
  migration is intentionally deferred under decision D3/D8.
- **P6:** driver-qualified frame indexes and migration driver declarations, plus a
  checksum/advisory-lock/rollback integrity contract for plugin migrations.
- **P7 (docs):** consolidated the legacy documentation tree into `docs/`, indexed every document,
  added authority banners, and refreshed plugin reference/authoring and
  architecture/source-map documentation.

Still open:

- ~~the full direct-construction audit from P1~~ **closed**. Every class
  `core-classes.mjs` registers under `pluginName: 'core'` is now accounted for,
  with the resolution mode named rather than assumed:
  - **resolved at construction, override needs a restart** — `FrameRouter`,
    `FrameRuntime`, `CompactionService`, `CommandRegistry`. Each is built once,
    before plugins load, so a later override cannot reach the live instance; all
    four are now built through `resolveCoreClass` and reported by
    `listRestartRequired()`/`data.restartRequired`. `CommandRegistry` was the
    audit's real find: registered as overridable but constructed directly, so an
    override was ignored *and* unreported.
  - ~~**resolved per use, but never reached in production**~~ — **closed**. The
    `FrameType<Type>` keys were inert: `frameTypeClass()` in
    `src/core/frames/frame-types/create-typed-frame.mjs` looked the class up on
    every frame creation, and `buildModelMessages()` forwarded `options.registry`
    down to it, but the lookup ran only when a caller passed a registry, and both
    production providers call `this.constructor.buildModelMessages(params)` with
    no options (`kikx-plugin-ollama/index.mjs:191`,
    `kikx-plugin-codex/index.mjs:226`). `options.registry` was therefore always
    undefined, the static `FRAME_TYPE_CLASSES` map always won, and a frame-type
    override registered, appeared in the inventory, and changed no message.

    The fix threads the registry in from the core side rather than asking three
    plugin repos to change: `buildModelMessages()` now resolves `pluginRegistry`
    from the `services` object core already hands every provider, via the existing
    `resolveService()` helper (the same `services.context.require(...)` path the
    agent router uses for `agentManager`/`pluginRegistry`). An explicit
    `options.registry` still wins, and with no registry anywhere the static core
    rendering is unchanged. Because the keys are now genuinely resolved, they are
    classified consumed instead of inert, derived from `FRAME_TYPE_REGISTRATIONS`
    so an added frame type cannot drift out of the classification.

    Proof: `spec/core/plugins/frame-type-override-liveness-spec.mjs` (5 tests)
    asserts the *message text* a plugin override produces when a provider passes
    no options, not a registry row. Revert-measured: reverting only the
    `buildModelMessages()` fallback fails exactly the two liveness tests while the
    three control tests (no-registry rendering unchanged, explicit registry
    precedence, consumed classification) stay green. A restart was never the fix
    here, which is why these keys were reported as `data.inertOverrides` rather
    than `restart-required`, and that distinction is now resolved at its root
    instead of being reported.
  - **no construction site to audit** — `PluginInterface`, `AgentInterface`,
    `DatabaseConnectionBase`. They are plugin-facing base classes and subclass
    guards (`isSubclassOf` in `plugin-registry.mjs`), never instantiated by core,
    so there is nothing to route through the registry.
  - **the registry itself** — `PluginRegistry` is constructed at
    `create-server.mjs` bootstrap, which is the registry an override would have to
    be registered on. The bootstrap does not register core classes at that point,
    so the direct `new PluginRegistry()` is the only coherent construction; it is
    documented here rather than changed. (Unproven by test: this is read from call
    order at `create-server.mjs` 160-203, not executed as a contract.);
- ~~migrating Questions or Todo into the first plugin-owned service from P2~~ —
  **landed** (`plugins/todo-focus-index`, `spec/plugins/todo-focus-index-service-spec.mjs`);
- moving one integration route out of core from P3 (per-mount request limits
  landed: `spec/plugins/plugin-mount-limits-spec.mjs`, 18 tests, 14 failing before).
  The only plausible candidate is `src/server/routes/image-proxy-route.mjs` (152
  lines), and it is **not a mechanical move**: that route reads arbitrary absolute
  host paths behind a `BLOCKED_ROOTS` denylist plus a per-session user preference,
  so relocating it to a plugin mount changes the trust boundary. Awaiting an owner
  decision, not additional analysis;
- ~~focus/selection preservation for plugin views from P4~~ **closed**, and the
  note that stood here was wrong twice over. It claimed the remainder was "blocked
  in this environment" because "no Chrome is installed". Chrome *is* installed — as
  a Playwright/Puppeteer cache under `~/.cache` that `findChromeExecutable()` never
  looked at, so the resolver answered "no browser" on a machine with two. The
  real-browser lane was red for that reason, not because the proof was unavailable.

  What the browser actually showed, once it could run: a plugin view rendered
  **nothing at all**. Three defects, none of them the missing restore logic the old
  note pointed at:

  1. `stackFromSearchParams` validated `?view=` against `VIEW_NAMES`, the frozen core
     literal. A plugin surface can never be in that array, so no plugin view was
     reachable by URL — a reload or a shared link dropped it, which is literally
     "P4's view does not survive a reload". Every other reader of the vocabulary
     (`normalizeNavigationStack`, `pushView`, `isViewEntry`) already asked the live
     registry; the parse site was the last holdout.
  2. `stackFromCurrentURL` skipped any entry whose `sessionID` was unknown and
     `break`ed out of the loop, discarding the rest of the tail. A view entry has
     `sessionID: null` by construction, so this rejected every view entry —
     `?view=inbox` included, meaning the pinned Inbox deep link had been dead in
     production too, not only for plugins.
  3. `applyAuth` carries a second, hand-maintained copy of the startup load list and
     fired `_loadSessions()` in parallel with `_loadClientComponents()`. The deep
     link therefore resolved before the descriptor registered the view name, and
     `_deepLinkApplied` latches, so it was never retried. Fixed by making the
     descriptor load a prerequisite in both lists (`kikx-app.mjs`, `kikx-editors.mjs`).

  With those closed, the restore half was built as the old note described: capture
  focus and the caret inside a view surface in `captureRenderSnapshot`, restore it
  in `afterRender` (`kikx-frame-scroll.mjs`), reusing the snapshot pair the composer
  already used. Two details are deliberately not the obvious ones: lookups compare
  the `data-kikx-focus-key` attribute instead of interpolating a plugin-authored key
  into a selector (a plugin must not choose what the shell queries), and the
  `data-kikx-view-surface` marker is set by the shell in
  `buildDescriptorSurface`, not by the plugin, so the contract holds for a plugin
  that never heard of it.

  Proof: `spec/ui/playwright/plugin-view-focus-playwright.mjs` drives the real path
  (server descriptor → `/api/v1/client-components` → `setClientComponents` → `?view=notes`
  → type → `app._render()`), and asserts element reuse plus post-rebuild attachment
  so "focus survived" cannot pass on an app that never repainted.
  Revert-measured: stashing only the restore half fails
  `assert.equal(after.activeKey, 'note-body')`. The three navigation defects are
  pinned by `spec/client/view-deep-link-spec.mjs` (6 tests, no browser needed);
  reverting only the parser fix fails 4 of them and leaves the two that must stay
  green (unregistered refusal, core/removed views) green;

  The harness defect is fixed too, because a red lane nobody can act on is how the
  above stayed hidden: `findChromeExecutable()` now probes the download caches with
  a **numeric** version comparison (a string sort picked `...7680.76` over
  `...7680.153`, which is how this was caught), and the two specs that launched with
  no `executablePath` now skip explicitly instead of hard-failing;
- moving built-in tool/frame/command catalogue families from P5 (bounded loop
  controls landed: `registerLoopControl`, `spec/plugins/plugin-loop-control-spec.mjs`,
  exit proof "reject unbounded or unknown terminal paths" met);
- ~~dual-driver index execution from P6~~ **closed**. Index support is now two
  declared capabilities rather than one probe: `indexDocuments` (AeorDB persists
  `indexes.json` documents) and `scalarIndex` (PostgreSQL expression index, SQLite
  JSON1), and both hooks raise `capability_unsupported` instead of resolving to a
  no-op that was indistinguishable from success. `spec/core/database/plugin-index-parity-spec.mjs`
  drives the shipped `plugins/todo-focus-index` service against real SQLite and real
  PostgreSQL; revert-measured at 8 of 9 failing, the single pass being the proof of
  shape (the query returns right rows because it scans). The same audit surfaced the
  original defect: `writeIndexConfigs` gated on `typeof configureIndexes === 'function'`,
  true for every driver because the base class supplied the no-op;
- ~~unload follows the declared retention policy from P6~~ **closed**, and the field
  had never been implemented. `removeOnUnload: 'definition-only' | 'retain-data'`
  appeared in §4.5 and nowhere in `src/`: unload removed every frame-index
  declaration unconditionally, so a plugin asking for `retain-data` silently got the
  opposite, while the documented default was neither reported nor enforced. An index
  declaration now carries the resolved policy on its descriptor, a mistyped policy
  fails closed at registration, and the ledger closure honours the policy.
  `spec/core/plugins/plugin-index-retention-spec.mjs` (7 tests) loads a real plugin
  from disk through `loadPlugins`; revert-measured at 4 of 7 failing. Neither policy
  deletes durable data — that is asserted against a counted `delete`, because
  removal of data is a separate explicit purge, not an unload side effect;
- ~~event delivery~~ **closed**, and it was a real defect rather than a coverage gap.
  `PluginEventBus` was correctly attached (`create-server.mjs:499`) and scoping correctly
  filtered, which is why the earlier "unmet contract" note was misleading - the bus
  worked. The hole was **reload**. `POST /api/v1/plugins/reload` re-scans the configured
  paths and calls `loadPlugins` again, and `registerPluginRecord` only refuses a name
  when a *different directory* claims it, so reloading the same directory was accepted:
  `setup()` ran a second time and the record was replaced. Two leaks followed. The
  previous registration's subscriptions stayed on the bus while the new load added
  another, so one runtime event invoked the handler twice per reload and N times after N
  reloads - invisible, because the handler does run. And the replaced record held the only
  reference to that registration's teardown, so a reload silently dropped it along with
  the resources it would have released. Measured at **3 deliveries where 2 are correct**.
  Fixed by unloading an already-loaded path before reloading it (16 lines in
  `plugin-loader.mjs`). The spec is 6 tests, and reverting only that fix reproduces
  `3 !== 2` on exactly the reload test while the other five still pass. `subscribe()`
  also carried a dead branch (both arms returned `true`) and two comments promising a
  flush of queued events that does not exist; the comments now say what the code does;
- the `ui:playwright` lane has **one** failure that is not this repo's:
  `inbox-frame-visual-parity-playwright.mjs` 404s on
  `vendor/aeor-web-components/components/aeor-scrollview.js`. That file exists on the
  vendored framework's own `origin/main`; the checkout at
  `/home/wyatt/Projects/aeor-web-components` is 7 commits behind it and has never
  contained the file. So the lane is red on a stale vendor checkout, not on Kikx
  code. Fixing it means updating that checkout (a different repo) or vendoring the
  file; deliberately not done here. Worth noting that the lane is now honest enough
  to show this at all: before the resolver fix it executed 2 tests and skipped 14,
  and now it executes 17 with 0 skipped. **Confirmed, not assumed:** pointing
  `KIKX_AEOR_WEB_COMPONENTS_ROOT` at a throwaway worktree of the vendor's own
  `origin/main` turns the spec green (1 pass / 0 fail, identical computed styles at
  420/300/240px), while the checked-out `cc8c2e0` 404s on that one asset. So the
  failure is the stale checkout and nothing in `src/`;
- demonstrating install/reload/unload on a live boot from P7 — **the route half is
  closed, the deploy half is not.** `/api/v1/plugins` exposed GET inventory plus POST
  `/install` and POST `/reload`, so unload had no HTTP surface at all: the only way to
  stop a plugin was to restart the process, and this exit criterion was unreachable by
  construction. It now has one — POST `/api/v1/plugins/unload`, gated by the same
  operator check as the other admin actions (a new `plugins:unload` action, not a bare
  boolean). The machinery was never missing: `unloadPlugin()` already had a complete
  contract pinned by `spec/plugins/plugin-unload-spec.mjs` (mount, subscriptions,
  migrations, scoped database handle, authority, class overrides). The surface was.

  Three properties are load-bearing and are tested as such, in
  `spec/server/plugin-unload-route-spec.mjs` (10 tests): **order** — every rejection
  test also asserts the plugin is still loaded and still mounted, because a gate that
  runs after the work is worthless; an **unknown name is 404, never 200 with
  `unloaded:false`** — a caller trying to stop a stopped plugin must not be answered in
  a way that reads as success; and **unload is not a one-way door** — the loader
  re-imports with a cache-busting query, so an install → unload → reinstall cycle on one
  process re-runs `setup()` and re-establishes its subscription exactly once rather
  than zero times. Revert-measured: with only the two source files reverted, 9 of the 10
  fail, and the single pass is the pre-existing fall-through pinned on purpose.

  Proven against a real boot too, not only fakes: `spec/plugins/live-boot-exit-proof.mjs`
  now drives unload over a real socket against `createServer()` with the real Postgres
  driver, and reports 11 passed / 0 failed — including anonymous refusal, unknown-name
  404, the mount going dark, and the host still serving afterwards. That proof previously
  called `unloadPlugin()` in-process *because* there was no route, and its comment said
  so; that comment is now corrected rather than left standing.

  What remains is only the deploy: showing install/reload/unload on the live image needs
  the host-side `deploy.sh main`.
- ~~removing remaining transitional shims~~ — **measured, and the item was
  mis-worded.** A grep for transitional/compat-shim markers across `src/` returns
  nothing; the five `legacy`/`backwards-compat` hits are data-format fallbacks
  (`chat-view-model.mjs`, `frame-type-base.mjs`, `config-paths.mjs`) and one rename
  alias in `session-state-utils.mjs`, none of them plugin-platform code. There is
  nothing to remove because decision 10's compatibility ingress (old manifests,
  `/api/plugins/` mounts, plugin asset URLs, class registrations behind one
  version-gated adapter) was never built: no `manifestVersion`, `apiVersion` or
  version-gate symbol exists in `src/core/plugins/`. So this is not shim cleanup but
  an unbuilt decision — building it is scope the owner has not authorized, and
  deleting the item would hide that.

The full suite is green at 3,095 tests (3,065 pass, 30 skipped) at this commit,
`npm test` = `node --test "spec/**/*-spec.mjs"`. The P6 retention contract above
adds its own seven (`spec/core/plugins/plugin-index-retention-spec.mjs`) and no
pre-existing assertion broke. Correcting an inherited claim: earlier revisions of
this paragraph said the suite `includes the documentation consolidation gate`. There
is no such gate — nothing in `spec/` reads `docs/`, so this document is not
test-enforced and its counts are hand-verified.

## 7. Verification spine

### Baseline commands

```bash
node --test --test-timeout=30000 'spec/**/*-spec.mjs'
node --test spec/plugins/plugin-router-spec.mjs
node --test spec/ui/playwright/...
```

Use the repo's Node 24 binary. Run the full non-doc suite before each phase push. The
docs-only migration failures are tracked separately and must not be used to claim a code
failure or a code success.

### Test families

- Registry: stack order, override, unregister, construction resolution, reload generation.
- Plugin loader: manifest, duplicate name, setup timeout, onInit/onShutdown, load failure,
  idempotent reload, install.
- Routes: mount matching, auth, capability, body size, timeout, error, unload.
- Services: dependency order, init failure, health, shutdown, unload.
- UI: descriptor load, view/sidebar render, navigation, missing module fallback,
  unload/removal.
- Persistence: index contract per driver, migration checksum/versions/locks, rollback,
  retention.
- Agent policy: prompt/precept ordering, bounded loop controls, no hidden wake path.

### Mechanical DoD

A phase is done only when:

1. Its failing-first tests exist and pass.
2. Its adjacent existing tests pass.
3. The full non-doc suite passes.
4. A one-unit revert works.
5. No new core edit is required for the demonstrated plugin.
6. The plan and gap report are updated with evidence.
7. The landing commit is pushed only after the combined revision passes.

## 8. Risks and constraints

- **Integration state:** the Miri platform is merged, ownership-ledger complete and driver-qualified at `fb45f8b6`; the combined revision
  has a green non-doc suite, but plugin-specific contract tests and live platform
  exercises are still owed. Preserve current main features.
- **Concurrent docs edit:** docs tree is being rewritten; do not commit docs-bot
  in-progress files. Add the campaign plan only where the docs migration permits.
- **Security:** plugin routes and install/reload are code-execution surfaces. Do not ship
  the current unauthenticated inventory/reload behavior as complete.
- **Driver divergence:** PostgreSQL is operational; AeorDB/SQLite must report capabilities
  honestly. SQL migrations cannot be assumed portable.
- **Class override blast radius:** replacing the main application class, `FrameRuntime` or
  `FrameRouter` can change everything. Phase it and test construction; the owner has
  explicitly accepted this blast radius for trusted plugins.
- **Trusted plugins:** plugins can hijack the main server application class and the
  browser `kikx-app` shell. Do not describe registry overrides, database-prefix checks,
  or route auth as a sandbox. A malicious plugin is a compromised process/client, not a
  contained tenant.
- **Optional dependency behavior:** `pg` is now declared once; verify the optional-install
  path still refuses gracefully when it is absent.
- **Performance:** plugin stamping and migrations must not add per-frame database reads
  without measurement. Record latency and memory baselines.
- **Backward compatibility:** existing plugin packages, route URLs, manifests and client
  assets must keep working through one compatibility ingress.

## 8.1 Adversarial review findings

These findings are part of the plan, not objections to it:

1. **`PluginAuthority` is intentionally not generalized in this campaign.** It remains Miri-specific. The owner ruling makes the main application class hijackable and treats plugins as trusted code, so building a capability boundary around plugin overrides would be misleading.
2. **Plugin routes currently bypass core auth.** The route handler table runs before the auth chain. P3 still needs ordinary Kikx authentication before plugin handlers and inventory/reload/install; this is transport safety, not a plugin capability boundary.
3. **Persistence is driver-qualified, not driver-neutral.** PostgreSQL migrations now refuse unsupported drivers; AeorDB/SQLite behavior remains an explicit capability decision, not an assumed equivalence.
4. **Unload is now mostly reversible but split across two mechanisms.** The ownership ledger releases mounts, migrations, tools, selectors, tags, drivers, components, indexes, DB handles and subscriptions; class-stack overrides are released separately. **Both paths are now proven together**: `spec/plugins/plugin-unload-contract-spec.mjs` releases twelve ledger families and pops a class override in one `unloadPlugin()` call, asserts the stack falls back to the core class rather than emptying, and repeats it for a failed load's rollback.
5. **A class override is not a live behavior change.** A reload that does not reconstruct the affected instance must report `restart-required`; otherwise the registry row looks changed while the running service is stale. **Implemented.** `ClassRegistry.noteClassResolved()` records what each live instance was built from, `resolveCoreClass()` — the single construction-resolution point — calls it, and `listRestartRequired()` reports keys whose stack top no longer matches the running instance. The inventory route (`GET /api/v1/plugins`) now returns `data.restartRequired`. The defect this closes is concrete: `create-server.mjs` resolves `frameRouter` at line 242 but only awaits the plugin load at 281, so a plugin `FrameRouter` override can never affect the running router, while `FrameRuntime` (473) and `CompactionService` (519) overrides do take effect. Both orderings are asserted.
6. **The merge is complete but the platform is not contract-complete.** The merged
   revision is green on the non-doc suite after the ownership ledger; still run the new
   platform contract tests and live install/reload/unload exercise. Preserve our
   scrollview, session scope, filter and todo-focus work.
7. **Mount limits were deployment-wide, so a plugin could not declare its own.**
   The router carried one body cap and one deadline from its constructor; `mount()`
   accepted nothing but `auth`. That made the campaign's §4.3 descriptor shape
   aspirational: no per-mount `capabilities` review surface, no per-mount deadline,
   and a replaced mount's handler was dropped without anything calling it back, so a
   reload leaked whatever the old handler held. Now `mount()` accepts
   `maxBodyBytes`/`handlerTimeoutMS` clamped to the deployment ceiling, plus
   `dispose` run on unmount and on reload, and `unmount()` deletes the route before
   dispose so an unload is immediately route-not-found even when cleanup throws.
   Malformed JSON now maps to 400 with its own message instead of a 500 attributed
   to the plugin; a plugin's own error keeps the generic body regardless of the
   status it chose, because that text is network-visible.
8. **A rolled-back migration was still reported as applied.**
   `#runPlugin` pushed onto `this.applied` *before* opening its transaction, so a
   migration that threw and ROLLBACKed still appeared in `run()`'s result and the
   startup log. Nothing downstream could tell it apart from a real apply. The push
   now happens after COMMIT. Proven failing-first: with the source at HEAD the
   integrity spec is 8/9 and this is the one that fails. The same spec pins the
   ledger lock ordering (CREATE TABLE inside the ledger advisory lock), per-plugin
   lock release on failure, checksum immutability for applied migrations, a missing
   migration file for a recorded version, and the table-prefix guard firing before
   any transaction opens.
9. **"Registered as overridable" did not mean "actually resolved".**
   `core-classes.mjs` registers eight classes under `pluginName: 'core'`, which
   tells a plugin it may override them. Only three were built through
   `resolveCoreClass`. `CommandRegistry` was constructed directly in
   `create-server.mjs`, so a plugin override changed the registry row and nothing
   else - and because nothing resolved it, `listRestartRequired()` could not
   report the discrepancy either. It now resolves through the registry, joined by
   `FrameRouter`/`FrameRuntime`/`CompactionService`. Because it is built before
   plugins load, an override still cannot affect that instance - the same
   `restart-required` answer as `FrameRouter`, but now a reported one.
   The audit is now closed: three registered classes have no core construction site
   at all (plugin-facing base classes and subclass guards), and the
   `FrameType<Type>` keys are a third category - resolved per use by
   `frameTypeClass()`, but only when the caller supplies a registry, which no
   production provider does today. Those overrides must not be filed as
   restart-required (a restart would not help); they are reported as
   `data.inertOverrides` instead. The lesson generalises: "overridable" needs a
   resolution mode (construction-time vs per-use vs currently unreachable),
   because only the first can be stale and only the last is beyond a restart's
   reach.
10. **Existing plugin packages need a compatibility ingress.** Preserve old manifests, `/api/plugins/` mounts, plugin asset URLs and class registrations for one transition window; version-gate legacy rows in an adapter rather than teaching every consumer both shapes.

## 9. Artifacts

- This plan: `docs/plans/plugin-platform-campaign.md`.
- Gap report: `docs/reports/plugin-way-gap-analysis-2026-10-29.md`.
- New contract tests: `spec/plugins/`, including the existing
  `plugin-attribution-spec.mjs` and `plugin-unload-spec.mjs`.
- Worker/progress files only if implementation is later split across agents.
- At completion: `dod-evidence.md` with command output, live evidence and remaining gaps.

## 10. Execution contract

When implementation is authorized:

```text
re-confirm merged baseline fb45f8b6 and optional-dependency behavior
→ run full non-doc suite
→ platform contract tests
→ P0 contract tests
→ P1 registry construction
→ P2 services/startup
→ P3 routes
→ P4 client surfaces
→ P5 catalogues/prompt/loop
→ P6 persistence/indexes
→ P7 cleanup
```

Each phase is an independently green landing and a one-unit revert. Do not push after a
failing gate. Do not deploy. Re-run the full suite after merging current main and after
any upstream sync.


### P7 live proof — Discord inbound, measured on a running process (2026-10-30)

Recorded because it changes what is known, not because it closes a checklist line. Every
"inbound routes to the bound session" assertion up to now was a unit test driving an
injected double, and the largest green-to-reality gap in the Discord plugin was that
**no production code path could write `discord_channel_session`** — the tests fabricated
a binding row the running system could not create.

Measured against `src/server/index.mjs` booted from this tree on `:3019`, with a
self-generated Ed25519 keypair and no bot token (so no gateway competed with the live
instance):

- unsigned POST → `401 invalid request signature / missing signature headers`;
- signed PING → `200 {"type":1}`;
- signed interaction from an actor with **no** grant → `202 not framed: not_authorized`,
  and zero rows in `discord_message_frame` (deny-by-default holds, and denies *before*
  any write);
- grant written through the plugin's own `discord:policy_grant` tool → `granted:true`,
  `verified:true`;
- same signed interaction → `202 {sessionID, frameID}`;
- **the `discord_channel_session` row was created by the production auto-bind path**,
  not by the test;
- the session API on that same process returns the frame:
  `UserMessage "[discord:e2e-prober] e2e inbound proof e2e-after-grant"`;
- replaying the same message id → `202 not framed: duplicate` (dedupe holds);
- deleting the grant → `202 not framed: not_authorized` again.

So the chain `signed request → capability gate → binding → frame in a real session` is
proven end-to-end at the system boundary, and the two defects that made the first
attempt fail were both mine, not the product's: the dev process pointed at AeorDB `:6830`
while the session I had chosen lived in the host store on `:6833`, and `pkill -f` matched
its own wrapper shell.

Found while doing it, and fixed in `kikx-plugin-discord` `00af1d6`: there was a
`discord:policy_grant` tool and **no revoke tool**, so a capability could only be taken
away by hand-written SQL. Under the owner's strict-security ruling that is a one-way
door, not a control. `discord:policy_revoke` now mirrors the grant's narrow remit and
reports the effect rather than the intent — a scoped revoke that leaves a broader
unscoped grant authorizing the action returns `revoked:false` with `stillAllowed:true`
and tells the caller to repeat with `allScopes:true`.

Still **not** proven: a real Discord message reaching this code. The gateway reached
READY with the real Miri token and the fatal-close latch is proven against Discord's own
4004, but no `MESSAGE_CREATE` has ever been delivered by Discord into a Kikx session.
That needs a token in the 3003 container plus the Message Content intent, and it is the
remaining live gap.

### Discord interaction callback — 202 is not an answer (2026-10-30)

The endpoint answered a slash command with `202 {"ok":true}`. Discord parses the
response body as an interaction callback and ignores the status code, so what the
user saw was **"The application did not respond"** while the suite stayed green.
The old `a slash command option is framed as the message text` test asserted that
202 — the defect written down as an expectation.

Fixed in `kikx-plugin-discord` `2980203`:

- The callback is now a real deferral, **type 5** for a command and **type 6** for
  a component, sent *before* the database work so dedupe, authorization and the
  session write cannot overrun Discord's three-second window.
- The outcome is delivered by `PATCH /webhooks/{application_id}/{token}/messages/@original`,
  so it edits the deferred placeholder instead of posting a second message.
- With no application credential it answers **type 4** (ephemeral) instead of
  deferring: a deferral with no webhook behind it would strand the user on
  "thinking…" until the token expired.
- Authorization is unchanged. The ack is a transport obligation; the frame and the
  reply text still depend on the gate, and a denied sender gets an ephemeral
  "Not authorized" with no write.

Measured on a live process (port 3022, `wt-parity`, throwaway Ed25519 key, real Miri
bot token, disposable database `kikx_ack_probe` — created and dropped for this run):

| request | result |
| --- | --- |
| unsigned `type:2` | `401 invalid request signature / missing signature headers` |
| signed `type:1` | `200 {"type":1}` |
| signed `type:2` command | `200 {"type":5,"data":{"flags":64}}` |
| signed `type:3` component | `200 {"type":6,"data":{"flags":64}}` |
| follow-up PATCH | `HTTP 404 {"message":"Unknown Webhook","code":10015}` ×2 |

The 404 is the proof, not a failure: `10015` is Discord saying the *interaction
token* is unknown, which it is — a fake token was used deliberately so nothing
could be written to a real guild. A bad bot credential would have returned `401`,
so the request is authenticated and well-formed. The router also logged
`denied inbound … no grant for discord.inbound`, so the ack did not bypass policy.

Reverting `index.mjs` to `00af1d6` fails **9 of the 20** endpoint specs; with it,
`71/71` plugin specs pass.

Still **not** proven: a real human message reaching a session through the gateway
(that needs the Message Content privileged intent), and the live image is still
`f201985` — `deploy.sh` stages `origin/master`, so a fresh deploy would pick up
`2980203`, but no deploy has been run.

### Discord gateway observability and liveness, measured (2026-10-30)

Appended to close a specific blindness rather than a checklist line. The gateway reported
only through `console.warn`, so "is the bot connected?" and "why did my message not
arrive?" were answerable exclusively from a shell on the host running the process. On the
3003 dev instance that shell was unreachable from the agent doing the work, which made two
different failures look identical: a gateway that never dialled, and a gateway that dialled
and denied the sender.

Fixed in `kikx-plugin-discord` by exposing `GET /api/plugins/discord/status`. The mount is
`auth: 'public'` because Discord cannot hold a Kikx session, and that must not make
internal state readable anonymously, so the route resolves identity itself through the
`accountStore` that core places in `context`. The token is deliberately absent from the
body: a token in a status body is a token in a log.

Three facts are reported separately because they fail separately:

- `tokenPresent` — was a bot token found at `/kikx/discord/bot/token`. A false here is a
  configuration problem, not a connection problem.
- `connected` plus the gateway's own `status()` — `ready`, `sessionID`, `sequence`,
  `attempt`, `fatal`, `heartbeatIntervalMS`, `userId`.
- `recentOutcomes` — every dispatch decision, **including denials**, with `reason`,
  `channelID` and `actorID`. A denial that exists only as a log line is indistinguishable
  from nobody having sent anything.

Proof on a running process (port 3026, `wt-parity`, real Miri token, disposable database
`kikx_status_probe` — created and dropped for the run):

| request | result |
| --- | --- |
| `GET /api/plugins/discord/status` anonymous | `401 Sign in required to read Discord plugin status` |
| same, `Authorization: Bearer <admin token>` | `200` |
| body | `tokenPresent:true`, `connected:true`, `userId:1471348366305923102`, `heartbeatIntervalMS:41250`, `inboundChannelID`/`inboundSessionID` resolved |
| `recentOutcomes[0]` | `GUILD_CREATE`, `handled:false`, `reason:"not_a_message"` — a real dispatch from Discord |
| token substring search in body | absent |

`spec/status-route-spec.mjs` is 6 tests; reverting only `index.mjs` to `2980203` fails
**4 of 6**. The two that still pass are vacuous and are not counted: with no route
registered there is nothing to leak and the mount is still public.

Two corrections to earlier text in this document:

1. The previous "not proven" line said a real human message needs the Message Content
   privileged intent. The intent is **already approved** — the application's flags read
   `532480`, which carries bit `524288`. Measured directly: a real human `MESSAGE_CREATE`
   from another guild arrived over the gateway with non-empty `content` and was denied at
   `not_authorized`. Had the intent been missing, the router would have reported
   `empty_content_missing_intent` instead, since it checks for that case explicitly.
2. "A real human message reaching a session through the gateway" is now narrower than it
   was. What remains unproven is a human who **holds a grant**, typing in the bound
   channel, producing a framed message. The transport, the intent, the content, and the
   gate are all proven; only the positive authorization branch is not.

The 3003 dev instance itself needed no restart for any of this. It was reported as dead
for two days because of an SSH tunnel that forwarded 3098 and not 3003; it answered
`/health` `200` and served `/client/*` byte-identical to this tree throughout, with
`Cache-Control: no-cache`, so the stale-looking status bar was a browser cache. Its client
modules are current; only *server* modules freeze at boot.

### Discord edits: one path, behind the gate (2026-10-30)

`kikx-plugin-discord` `4554b85`. An earlier revision of this document recorded edit
handling as present because the HTTP branch and its three tables existed. It was present
twice, and both copies were wrong:

- **Over HTTP** there was an inline copy of the edit logic in `index.mjs`. It re-derived
  the diff, wrote `discord_message_frame`, and appended to the frame — and never called
  `authorizeInbound`. The mapping row proves that *the original message* passed the gate;
  it does not prove the actor editing it now is the same one. So an edit was a write with
  no capability check, which is the strict-security ruling inverted.
- **Over the gateway** there was no edit path at all. `handle()` opened with
  `if (eventType !== 'MESSAGE_CREATE') return not_a_message`, so `MESSAGE_UPDATE` was
  dropped before the router looked at it. A user editing a message saw nothing happen.

One path replaced them: `MESSAGE_UPDATE` dispatches to `handleEdit()` in
`inbound-router.mjs`, which calls the same `authorizeInbound` the message path uses,
resolves the frame through `findFrame()`, keeps `original_text` intact, and appends to the
audit tail via `updateFrameAudit()`. The inline copy is deleted rather than left as a
second definition — the two copies had already diverged once.

Two policy decisions inside it, both deny-by-default:

- **No author, no write.** An edit with no attributable author is refused
  (`no_author`) rather than inheriting the original message's grant on faith.
- **No content is not an error.** Discord sends `MESSAGE_UPDATE` with no `content` field
  when it unfurls a link preview. That is reported as `edit_without_content`, not treated
  as a malformed request, because otherwise every pasted URL logs a failure.

`spec/inbound-edit-spec.mjs` is 9 tests; reverting both files to `26d815d` fails **8 of
9**, the single pass being the control that unrelated events are still not messages. The
pre-existing router test asserted `MESSAGE_UPDATE → not_a_message`, which is the old
behaviour written down as an expectation — the second time in this campaign that an
assertion was protecting a defect rather than catching one. It now expects
`unframed_message`. Plugin suite: **86/86**.

Not measured: a real edit arriving over a live gateway socket. The unit proof drives
`handle()` directly and the code path from `onDispatch` to `handle()` is the same one
`MESSAGE_CREATE` already travels, but that identity is argued from the source, not
observed on a socket.

## Plugin reload now re-reads configuration, measured

The owner's hard requirement is that plugins stay installable, reloadable and removable
without a service restart. One defect defeated that requirement while looking like an
environment problem, and it was ours.

**The measurement.** `POST /api/v1/plugins/reload` on the 3003 dev instance returned
`200 {"added":[],"total":8,"failures":[]}`, and the plugin's own `startedAt` in
`GET /api/plugins/discord/status` moved to the reload timestamp - so `setup()` and
`onInit()` genuinely re-ran and the new plugin code was live. The same response reported
`tokenPresent:false`. The token had been written to `kikx/.env.dev` seventeen hours after
the process booted. Reload was working; the *configuration* it reloaded against was a
boot-time snapshot, so the only remaining way to apply a newly added key was to restart
the process. A reload that cannot see the configuration it was performed for is not a
working reload.

**Why.** `scripts/start-dev.mjs` and `scripts/start-kikx-dev.mjs` call `loadEnvFile`
once, before spawning the server. `ConfigStore`'s process-env provider reads
`process.env` live on every `get()` (`src/core/config/config-providers.mjs`), so anything
present in the environment is visible immediately - but a key written to the file after
the spawn never enters the environment at all. The store was never stale; the environment
was never updated.

**The fix.** `src/core/config/env-refresh.mjs` re-reads the env file at reload time and
the `/plugins/reload` route calls it before `loadPlugins`. The rule is deliberately
conservative, because refreshing an environment from a file is a good way to break a
deliberate override:

1. A key absent from the environment is added - the file is the only source that could
   supply it.
2. A key the file owns is updated. `loadEnvFileWithProvenance` records, at boot, which
   keys the file was actually allowed to set, and carries that list in the environment
   (`KIKX_ENV_FILE_OWNED_KEYS`) so it survives the launcher-to-server process boundary.
3. Any other key is pinned and left alone. This is what keeps `KIKX_PORT=3025 npm run dev`
   on 3025 across a reload instead of being dragged back to the file's value.

The reload response reports what happened - `added`, `updated`, `pinned` - rather than
logging it, because an operator reloading a plugin to pick up configuration needs to see
whether the configuration was re-read.

**Proof.** `spec/core/config/env-refresh-spec.mjs` is 11 tests, driving real temp files
through the real loaders. The decisive one builds a `ConfigStore` *before* the key exists,
appends the key to the file, refreshes, then asserts the same store instance resolves the
new value with no restart. Reverting `refreshEnvFromFile` to additive-only behaviour fails
**7 of 11**; the 4 that still pass are the loader-provenance tests, which bind to the
other half of the change and are labelled as such rather than counted as coverage of the
refresh.

**Scope, stated plainly.** The route change reaches the running 3003 process only through
one restart, because a route in core is not hot-swapped. That is a *core* upgrade and is
labelled as one; it is not a plugin-lifecycle restart, and after this change a plugin
install, reload or removal needs no restart at all.

Not measured: a live 3003 reload picking up a post-boot token through this path. The
proof is at the store and route boundary; the live confirmation is pending a core upgrade
of that instance.
