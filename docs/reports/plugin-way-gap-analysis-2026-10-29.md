---
title: Plugin-way gap analysis
status: current
doc_type: report
audience: [developers, maintainers]
applies_to: development-v3
last_verified: 2026-10-29
---

# Plugin-way gap analysis

## Purpose

Kikx's stated direction is a plugin-driven runtime: plugins should be able to
contribute or replace product behavior through stable registration seams, while
the core owns durable primitives and orchestration. This report identifies the
systems that still require core edits or are only partially plugin-extensible.

## Executive summary

The plugin registry is real and already covers several important seams:
tools, agent providers, commands, frame selectors, client frame/tool/config-form
components, tag definitions, database drivers, and selected core classes. The new
todo-focus plugin also demonstrates plugin-owned frame indexing.

The remaining gap is **not "there is no plugin system."** It is that several
product systems are still hardwired into the core bootstrap or browser shell:

1. HTTP API routes.
2. Main-area views and sidebar/navigation entries.
3. Service and store composition.
4. Built-in feature catalogues (tools, commands, frame types, tags, routing).
5. Startup, recovery, and scheduled-work hooks.
6. Complete plugin lifecycle and unload semantics.
7. Uniform persistence-index support across drivers.

If "entirely plugin driven" means a new feature can be added without editing
`create-server.mjs`, the browser shell, or a core route table, those are the
high-severity gaps.

## What already follows the plugin way

- Tools and their client renderers (`registerTool`, `PluginInterface`).
- Agent providers (`registerAgentProvider` / `registerAgentType`).
- Slash commands (`registerCommand`).
- Frame routing selectors (`registerSelector`; `FrameRouter`).
- Frame, tool, and agent-config-form client components.
- Tag definitions and role-action metadata.
- Database drivers (`registerDatabaseDriver`).
- Selected core class overrides through `ClassRegistry`.
- Plugin-scoped client assets under `/api/v1/plugin-assets/...`.
- New: plugin-owned session frame indexes (`registerFrameIndex`) and a
  driver-level scalar-index hook (`ensureScalarIndex`).
- Exemplar: `plugins/todo-focus-index` stamps `focus_todo_id`, registers its
  index, and contributes a query tool without adding a core route.

## Gap matrix

| # | System | Current state | Severity |
|---|---|---|---|
| G1 | HTTP API routes | All product routes live in `src/server/routes/`; no plugin route registry | High |
| G2 | Browser views/navigation | Core owns `VIEW_NAMES`, view builders, sidebar objects, dialogs, modals | High |
| G3 | Service/store composition | `create-server.mjs` constructs every store and service; no plugin service lifecycle | High |
| G4 | Built-in feature catalogues | Core arrays register built-in tools/frame components; core also registers commands, frame types, tag definitions, routing plugins, prompt/precept text | Medium |
| G5 | Agent loop and prompt policy | Loop controls, briefs, precepts, compaction policy and role-tag semantics are core code | Medium |
| G6 | Startup/recovery/schedulers | Recovery, question repair, process recovery and scheduled worker are core startup phases; no plugin startup hook | Medium |
| G7 | Plugin lifecycle | Unload restores class overrides only; specialized maps (tools, selectors, components, indexes, tags, drivers) are not fully removed | Medium |
| G8 | Index/persistence extension | Frame indexes now extensible, but driver support is uneven and index registration is not unloaded | Medium |
| G9 | Plugin metadata/order | No dependency declarations, version constraints, capability negotiation or deterministic load ordering beyond path order | Medium |
| G10 | Contract/docs coverage | No shared contract suite for plugin routes/views/services/indexes; plugin docs do not list every available registration seam | Medium |
| G11 | Auth/cryptography | Deliberately not plugin-overridable | Intentional |

## Detailed findings

### G1 — HTTP routes are core-owned

Evidence:

- `src/server/create-server.mjs` wires the route dispatcher.
- `src/server/routes/*.mjs` contains the product endpoints.
- `src/server/routes/plugin-asset-routes.mjs` is the only plugin-related route;
  it serves files, not plugin-defined API behavior.
- `createPluginSetupContext()` exposes no `registerRoute` or equivalent.

Consequence: a plugin can add a tool that manipulates data, but it cannot expose
a durable HTTP resource, webhook, SSE stream, or first-class API surface without
editing core route files. This is the largest "not plugin way" gap.

Recommendation: add a scoped `registerRoute` contract with method/path matching,
authentication policy, request limits, and unload support. Routes should be
owned by the plugin name and removed with it.

### G2 — The browser shell is core-owned

Evidence:

- `src/client/state/navigation-stack.mjs` has a hardcoded `VIEW_NAMES` list.
- `src/client/components/kikx-shell-builders.mjs` dispatches Inbox, Agents and
  Teams directly.
- `src/client/components/kikx-sidebar-session-objects.mjs` hardcodes sidebar
  descriptors.
- `src/client/lib/aeor-ui.mjs` lists optional components explicitly.
- `src/client/components/kikx-agent-team-views.mjs` is a core view, not a plugin
  contribution.
- Component descriptors support only `frame`, `tool`, and `agent-config-form`.

Consequence: a plugin can supply a renderer for a frame or tool, but it cannot
add a main-area view, a sidebar entry, a navigation target, a toolbar action, a
settings panel, or a session-object item. Agents and Teams are a clear example:
the feature is session-scoped and UI-heavy, but the view and modal replacement
had to be implemented in core client files.

Recommendation: define plugin client-surface descriptors for:

- navigation/view entries with icon, label, scope and builder module;
- sidebar/session-object descriptors;
- toolbar and frame quick actions;
- settings/preferences panels.

The server descriptor endpoint should carry the same registrations so reload
and authorization can be consistent.

### G3 — Service and store composition is hardcoded

Evidence: `src/server/create-server.mjs` sets each service directly:
`agentManager`, `teamManager`, `questionsStore`, `tagsStore`, `agentTodoStore`,
`ocrService`, `compactionService`, `processManager`, `feedbackStore`,
`tokenUsage`, `questionAnswerService`, `sessionMergeService`, and others.
Core class overrides exist for only a small subset.

Plugins can technically mutate `AppContext`, but there is no declared service
factory contract, lifecycle ordering, dependency declaration, health check or
teardown tied to plugin unload.

Consequence: a plugin cannot cleanly provide a replacement questions store,
new persistence-backed feature, or background service without relying on
undocumented context mutation.

Recommendation: add `registerService(name, factory)` with explicit dependencies
and teardown, plus startup/readiness phases. Keep auth/crypto outside the
override surface.

### G4 — Built-in catalogues are core arrays

Evidence:

- `src/core/tools/register-built-in-tools.mjs` owns `BUILT_IN_TOOLS` and
  `BUILT_IN_FRAME_COMPONENTS`.
- `src/core/commands/internal-commands.mjs` registers core commands and routing.
- `src/core/frames/frame-types/index.mjs` owns the frame-type registry.
- `src/core/tags/tag-definitions.mjs` owns `CORE_TAG_DEFINITIONS`.
- `src/core/agents/agent-route-frame-plugin.mjs` and
  `src/core/questions/question-schedule-plugin.mjs` are registered from
  `create-server.mjs`, not from plugin packages.
- Prompt/precept text lives in `src/core/plugins/agent-precepts.mjs`,
  briefs/templates, and compaction defaults.

These registrations go through plugin-shaped registries, so they are
overridable. But they are not **plugin packages**: adding or removing a core
feature usually means editing a core array or core bootstrap file.

Consequence: built-ins are privileged relative to third-party plugins. This is
acceptable for stable primitives, but not for every product feature if the goal
is "entirely plugin driven."

Recommendation: move feature families into bundled plugins (or at least
plugin-style manifests) while retaining core primitives. Prioritize:
question tooling/UI, tool catalogues, tag/role behavior, compaction policy, and
routing defaults.

### G5 — Agent loop and prompt policy are core-owned

Evidence:

- `src/core/plugins/agent-interface.mjs` owns the loop, terminal controls and
  end-turn notification.
- `src/core/plugins/agent-loop-tools.mjs` owns `end-turn`, `continue-turn`,
  `stop`, `progress`, `route` and related behavior.
- `src/core/plugins/agent-brief-template.mjs` / `agent-precepts.mjs` own prompt
  sections and precepts.
- `src/core/compaction/` owns compaction selection and policy.
- Role-priority logic knows `leadership_score`, `compaction_score`, and
  `ocr_score` by name.

Consequence: a plugin cannot add a loop control, prompt section, precept,
compaction strategy, or role-selection rule without touching core.

Recommendation: add composition hooks for prompt sections, precepts, loop
controls, role selectors and compaction strategies. Keep the core loop finite
and auditable; plugins contribute named pieces, not arbitrary rewrites of the
loop.

### G6 — Startup, recovery and scheduled work are core phases

Evidence: `create-server.mjs` owns runtime recovery, process recovery, pending
tool recovery, scheduled-frame worker startup, question index repair and
readiness transitions. There is no `registerStartupTask` or
`registerRecoveryTask` in the plugin setup contract.

Consequence: a plugin with durable state has no first-class way to repair or
resume it before readiness, or to register a periodic worker that is stopped on
unload.

Recommendation: expose ordered startup phases and teardown:
`registerStartupTask`, `registerRecoveryTask`, `registerScheduledWorker`, with
failure/deadline/health reporting.

### G7 — Unload is partial

Evidence: `docs/reference/plugins.md` documents that `unloadPlugin` restores
class-stack registrations but does not remove entries from tools, providers,
database-driver, component, tag, selector or frame-index collections. The new
frame-index registration inherits this gap.

Consequence: hot reload/unload can leave overridden tools, stale selectors,
stale client components or index definitions active. That undermines plugin
isolation and makes plugin tests unreliable.

Recommendation: give every registry collection plugin ownership metadata and a
single unregister path. Add a contract test that loads, unloads and proves all
registrations disappear and teardown runs.

### G8 — Persistence indexes are only partially uniform

Evidence:

- Frame index configuration is AeorDB-oriented
  (`frame-store-indexes.mjs` + `.aeordb-config/indexes.json`).
- PostgreSQL previously inherited a no-op `configureIndexes`.
- The new `ensureScalarIndex` hook and todo-focus plugin close the immediate
  gap for one plugin, but generic plugin index support still needs a driver
  contract, path/partial-index semantics, and unload cleanup.
- A plugin index is written into the session index config; there is no
  cross-driver contract test.

Consequence: a plugin that registers an index may get real acceleration on one
driver and a sequential scan on another, and its index may outlive its plugin.

Recommendation: define a driver-neutral index contract with declared
capabilities and a verification test per driver; include index removal on
unload.

### G9 — No plugin dependency or load-order contract

Evidence: `loadPlugins()` loads configured paths in order and catches failures;
there is no manifest with `requires`, version ranges, capability declarations,
or conflict detection. The only ordering is file/registry insertion order plus
special core registrations after plugin loading.

Consequence: plugins that override classes, routes, services, selectors or
views cannot declare "load before/after" or "requires feature X." Conflicts are
warning-only and can silently produce the wrong class or selector order.

Recommendation: add a small plugin manifest (`name`, `version`, `requires`,
`provides`, `loadOrder`) and resolve dependencies deterministically. Keep
failures fail-open only for optional features; fail closed for required
dependencies.

### G10 — Contract tests and docs lag the seams

Evidence:

- `docs/reference/plugins.md` does not list the new `registerFrameIndex` or
  `ensureScalarIndex` seams.
- The plugin authoring guide lists tools/providers/commands/selectors/
  components/tags/drivers, but not views, routes, services, startup tasks or
  prompt sections.
- There is no shared plugin contract suite analogous to the database driver
  contract harness.

Recommendation: add a plugin contract harness covering registration,
permissions, load/unload, client descriptor resolution, index creation and
teardown. Update both plugin docs whenever a new registration family is added.

## Recommended migration order

1. **P0: route and client-surface registries.** These unlock feature parity for
   plugins without changing the core loop.
2. **P0: service registration and startup/recovery hooks.** This makes durable
   plugin features possible.
3. **P1: unload ownership and contract tests.** Without this, hot reload and
   plugin isolation remain unreliable.
4. **P1: move one complete feature family to a bundled plugin.** Questions or
   todo UI are good candidates because they exercise tools, routes, client
   surfaces, stores and indexes.
5. **P2: move remaining built-in catalogues and prompt/role policy into
   plugin-shaped registrations.**
6. **P2: plugin manifest dependencies/version negotiation.**

## Acceptance criteria for "plugin way"

A feature is plugin-way when all of the following are true:

- It can be installed without editing `create-server.mjs`.
- It can expose its own API routes and client surfaces without editing a core
  route table or `kikx-shell-builders.mjs`.
- Its services have declared dependencies, startup order, health and teardown.
- Its frame/tool/view registrations carry plugin ownership and disappear on
  unload.
- Its indexes are created on every supported driver that claims index support,
  and are removed with the plugin.
- Its contract tests load and unload the plugin, not just its classes in
  isolation.

## Non-goals / intentional exceptions

Authentication and cryptography should remain outside the universal class
override surface. The core runtime must keep a small, auditable loop, durable
frame storage and authority model even if feature policy moves into plugins.

## Evidence map

- Plugin loader/registry: `src/core/plugins/plugin-loader.mjs`,
  `src/core/plugins/plugin-registry.mjs`, `src/core/plugins/plugin-interface.mjs`.
- Core bootstrap: `src/server/create-server.mjs`.
- Routes: `src/server/routes/`.
- Built-in tools/frames: `src/core/tools/register-built-in-tools.mjs`.
- Built-in commands: `src/core/commands/internal-commands.mjs`.
- Frame types: `src/core/frames/frame-types/index.mjs`.
- Tags: `src/core/tags/tag-definitions.mjs`.
- Agent loop/prompt: `src/core/plugins/agent-interface.mjs`,
  `src/core/plugins/agent-loop-tools.mjs`,
  `src/core/plugins/agent-precepts.mjs`.
- Client views/navigation: `src/client/state/navigation-stack.mjs`,
  `src/client/components/kikx-shell-builders.mjs`,
  `src/client/components/kikx-sidebar-session-objects.mjs`.
- New plugin-owned index example: `plugins/todo-focus-index/index.mjs`.
- Plugin docs: `docs/reference/plugins.md`, `docs/guides/plugin-authoring.md`.
