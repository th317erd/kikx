# Source map

> **Current documentation — Kikx v3 (unreleased).** Last verified 2026-10-30 against the repository tree, plugin registries, and active server/browser bootstrap.

This map routes maintainers and bots to the authoritative implementation for a concern. The active v3 runtime is `src/`; `old-app/` is historical reference, not live code.

## Entrypoints and composition

| Area | Source |
| --- | --- |
| package entry | `src/index.mjs` |
| runnable HTTP server | `src/server/index.mjs` |
| service composition | `src/server/create-server.mjs` |
| dependency container | `src/core/app/app-context.mjs` |
| HTTP dispatch | `src/server/router.mjs` |
| browser entry | `src/client/index.html`, `src/client/app.mjs` |

## Core runtime

| Concern | Source |
| --- | --- |
| frame engine and typed frames | `src/core/frames/` |
| session runtime, recovery, scheduling | `src/core/runtime/` |
| routing and selectors | `src/core/routing/` |
| browser-safe message projection | `src/shared/frame-manager/` |
| shared ancestry/preferences/priority | `src/shared/` |
| hybrid logical clocks | `src/core/clock/` |
| session fork/merge | `src/core/context/`, `src/core/merge/` |

## Actors and behavior

| Concern | Source |
| --- | --- |
| agent records/routing/cwd/todos | `src/core/agents/` |
| provider and agentic loop interfaces | `src/core/plugins/agent-*.mjs` |
| teams | `src/core/teams/` |
| mentions | `src/core/mentions/` |
| commands | `src/core/commands/` |
| questions/inbox/wake scheduling | `src/core/questions/` |
| tags and role selection metadata | `src/core/tags/` |

## Persistence, accounts, and configuration

| Concern | Source |
| --- | --- |
| driver-neutral database layer | `src/core/database/` |
| legacy AeorDB adapter and frame store | `src/core/aeordb/` |
| native authentication | `src/core/auth/` |
| account facade | `src/core/account/` |
| configuration paths/providers/loaders | `src/core/config/` |
| token usage | `src/core/tokens/` |
| feedback | `src/core/feedback/` |
| session preferences | `src/core/preferences/` |

## Extensions and tools

| Concern | Source |
| --- | --- |
| plugin loader/registry/class overrides | `src/core/plugins/` |
| plugin services, prompt sections, routes, migrations, indexes | `src/core/plugins/plugin-registry.mjs`, `plugin-loader.mjs`, `plugin-router.mjs`, `plugin-migrations.mjs` |
| plugin browser bootstrap and descriptors | `src/client/app.mjs`, `src/client/components/frame-component-registry.mjs` |
| built-in tools and execution lifecycle | `src/core/tools/` |
| bundled plugins | `plugins/` |
| OCR selection/service | `src/core/ocr/` |
| compaction | `src/core/compaction/` |

## Server transport and operations

| Concern | Source |
| --- | --- |
| endpoint handlers | `src/server/routes/` |
| SSE batching/streaming | `src/server/events.mjs`, `src/server/runtime-event-gateway.mjs` |
| static files and plugin assets | `src/server/static-files.mjs`, `src/server/routes/plugin-asset-routes.mjs` |
| memory sampling | `src/server/memory-sampler.mjs` |
| shutdown and process-error policy | `src/server/shutdown.mjs`, `src/server/process-error-policy.mjs` |
| local launch/watch/migration helpers | `scripts/` |

## Browser implementation

| Concern | Source |
| --- | --- |
| application shell/controller | `src/client/components/kikx-app.mjs` and helpers |
| data/API access | `src/client/components/kikx-data.mjs` |
| authentication | `src/client/components/kikx-auth.mjs` |
| runtime events | `src/client/components/kikx-runtime-events.mjs`, `runtime-events-connection.mjs` |
| frame and tool rendering | `src/client/components/kikx-frame-item.mjs`, `tool-renderers/` |
| state models | `src/client/state/` |
| AEOR framework re-export | `src/client/lib/aeor-ui.mjs` |
| styles | `src/client/styles/` |

## Tests

| Family | Location |
| --- | --- |
| core/unit/integration | `spec/core/`, `spec/server/`, `spec/shared/`, `spec/scripts/` |
| browser-model/mini-DOM | `spec/client/` |
| architectural wiring | `spec/architecture/` |
| ownership and ancestry seams | `spec/ownership/` |
| Playwright | `spec/ui/playwright/` |
| Puppeteer | `spec/ui/puppeteer/` |
| Stagehand | `spec/ui/stagehand/` |
| experimental UI spikes | `spec/ui/spike/` |

## Sources of truth

- `src/server/create-server.mjs`
- `src/server/router.mjs`
- `src/core/plugins/core-classes.mjs`
- `src/core/tools/register-built-in-tools.mjs`
- `package.json`
- repository file tree

## Related

- [Architecture](../architecture/README.md)
- [Development setup](../guides/development.md)
- [Testing guide](../guides/testing.md)
- [Plugin system reference](plugins.md)
