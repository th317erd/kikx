# Plan: Plugin extensibility campaign (restore kikx2 patterns)

## Status: ACTIVE — Phase 1 in progress

## Why this exists

kikx2 (`kikx.old.march.2026`) planned and largely shipped a universal plugin
extensibility system. The current `kikx` rewrite re-introduced only a skeleton
(`4a33b23`) and never adopted it. An external plugin (`kikx-plugin-claude`,
`-codex`, `-ollama`) already implements `getModels()`/`estimateTokens()`/
`shouldCompact()` overrides that current core **silently ignores** — proof the
work was expected but is missing. This campaign restores it.

## Owner rulings (verbatim)

- "ANY class was fully overridable by a plugin, even core engine classes. I would
  like to continue doing this exact same pattern in our current project/code base."
- "Plugins CAN and SHOULD be able to register their own components that the Kikx
  system then uses." (models, message types, custom/overridden, modals, etc.)
- Generic system Kikx natively supports; plugins own their UI.

## Gap analysis (evidence)

Reference: `kikx.old.march.2026/bot-docs/plan/kikx/unified-class-registry.yaml`,
`future-plans/plugin-model-registry.yaml`, `docs/plugin-system.md`.

| Area | kikx2 | Current kikx | Priority |
|---|---|---|---|
| ClassRegistry class | yes | present (`src/core/plugins/class-registry.mjs`) | done |
| Core classes registered | yes | **absent** (only AgentInterface/PluginInterface) | CRITICAL |
| Consumers resolve via `getClass` | yes | **absent** (0 consumers; direct imports) | CRITICAL |
| `provide()` hot-reload / unload | partial | **absent** (return value ignored; no unregister) | HIGH |
| Plugin `getModels()` contract | yes | **absent** | CRITICAL |
| `estimateTokens/truncate/shouldCompact` | yes | **absent** | CRITICAL |
| `GET /api/v2/models` aggregate | yes | **absent** | HIGH |
| Model-aware truncation | yes | absent (hardcoded 128k compaction) | HIGH |
| Frame-type classes (FrameTypeBase) | yes | **absent** (string logic) | HIGH |
| Plugin client components (frame/tool) | basic | present, stronger | ok |
| Plugin-owned agent form / modals | no | **absent** | MEDIUM |
| Plugin client asset serving | no | **absent** | MEDIUM |
| Plugin ordering / disable | partial | absent | LOW-MED |

## Governing principle (from kikx2 doc)

> "The engine authors opt-in to overridability by using `registry.getClass()` to
> instantiate classes. Hardcoded instantiation = locked down. Security-critical
> code (crypto, auth) is NOT loaded from the registry."

## Phases

### Phase 1 — ClassRegistry adoption (foundation) — IN PROGRESS
- `registerCoreClasses(registry)`: register the override-worthy core classes
  (`FrameRouter`, `FrameRuntime`, `CompactionService`, `PluginRegistry`, ...)
  with `pluginName: 'core'`, at bootstrap before plugins load.
- A resolution helper so consumers instantiate via `registry.getClass(key)`
  falling back to the imported class.
- Convert the highest-value consumer (`FrameRouter`) to registry resolution as
  the working proof that a plugin can override a core engine class.
- `provide()` callbacks stored per plugin; `unloadPlugin(pluginName)` runs
  teardown + `registry.unregisterPlugin(pluginName)`; optional reload.
- Tests: a plugin registering `FrameRouter` wins; unregister restores core.

### Phase 2 — Plugin model registry + base contract
- `AgentInterface`: `static getModels()`, `estimateTokens()`, `truncate()`,
  `shouldCompact()`, `getCompactionPrompt()`, `getMaxCompactionTokens()` defaults
  (non-breaking).
- `GET /api/v1/models` aggregating `{ pluginID, ...model }` across providers
  (skip throwing plugins).
- Reconcile with existing `resolveConfigFields()`/`configFields` dynamic selects
  (models endpoint is additive; used for model-aware truncation + pricing).
- Tests + live check against the local llama.cpp server.

### Phase 3 — Frame types as classes
- `FrameTypeBase` (+ default fallback) with `toAgentMessage`/`isRenderable`/
  `getAlignment`/client `createElement`; register via `getClass('FrameType'+type)`;
  factory with fallback. Migrate string-switch sites incrementally.

### Phase 4 — Plugin-owned client UI
- Serve plugin client assets (`/api/v1/plugin-assets/<pluginID>/...`).
- Generalize component kinds (`registerComponent(kind, key, descriptor)`);
  plugin-provided agent-config form + modals.
- Codex ships `client/agent-config-form.mjs` with `/v1/models` discovery,
  refetch on baseUrl change.

## Definition of done
Each phase: unit + eslint green, evidence recorded, pushed. A plugin can override
a core class; the model registry endpoint serves real data; the Codex plugin can
own its create-agent UI with dynamic models.
