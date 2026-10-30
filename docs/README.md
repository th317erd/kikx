---
title: Kikx documentation index
status: current
doc_type: index
audience: [all-bots, developers, operators, qa]
applies_to: development-v3
last_verified: 2026-10-27
canonical: true
keywords: [index, routing, documentation, bots]
---

# Kikx documentation index

> **Canonical bot entry point — development revision 3.** Kikx has never been
> publicly released. Revision 3 means the third internal implementation, not a
> public major version or the package semantic version.

Kikx is a frame-based, plugin-driven agent harness for durable collaboration by
humans and multiple AI agents. It supports concurrent context compaction,
multi-bot sessions, asynchronous tools and processes, cross-session work,
session hierarchies, characters, teams, and pluggable persistence. The browser
is the only shipped first-party UI, but it consumes UI-independent core, shared,
HTTP, and SSE contracts.

## How bots should use these docs

Use this authority order when sources disagree:

1. Executable source and tests.
2. Current canonical architecture, reference, guides, and operations docs.
3. Active roadmap documents, which describe intended work.
4. Completed plans and dated reports, which preserve implementation evidence.
5. Superseded and historical material.

Read [the overview](./overview.md) first for capability status and honest
implemented/partial/planned boundaries. Then follow the task route below. Do
not treat a historical backend, port, path, line number, or deployment topology
as current merely because it appears in the archive.

## Fast routes by task

| Need | Start here | Then read |
| --- | --- | --- |
| Understand Kikx quickly | [Overview](./overview.md) | [Architecture map](./architecture/README.md), [source map](./reference/source-map.md) |
| Change frames or routing | [Frames/runtime/routing](./architecture/frames-runtime-routing.md) | [Actors/routing](./architecture/actors-and-routing.md), [agent behavior](./reference/agent-behavior.md) |
| Change agents or providers | [Agentic script](./architecture/agentic-script.md) | [Plugins/providers/persistence](./architecture/plugins-providers-persistence.md) |
| Change sessions, teams, or delegation | [Sessions/teams/cross-session](./architecture/sessions-teams-cross-session.md) | [Actors/routing](./architecture/actors-and-routing.md) |
| Change compaction | [Context compaction](./architecture/context-compaction.md) | [Compaction incident](./history/incidents/2026-10-01-compaction-summary-loss.md) |
| Add or change a tool | [Tools/processes/scheduling](./architecture/tools-processes-scheduling.md) | [Tool reference](./reference/tools.md) |
| Author a plugin | [Plugin authoring](./guides/plugin-authoring.md) | [Plugin reference](./reference/plugins.md) |
| Change persistence | [Database drivers](./reference/database-drivers.md) | [Storage](./reference/storage.md), [database operations](./operations/database.md) |
| Change authentication | [Authentication](./reference/authentication.md) | [HTTP API](./reference/http-api.md), [configuration](./reference/configuration.md) |
| Change the browser UI | [Frontend guide](./guides/frontend.md) | [HTTP API](./reference/http-api.md), project `AGENTS.md` |
| Develop or test locally | [Development guide](./guides/development.md) | [Testing guide](./guides/testing.md) |
| Run or diagnose the service | [Runtime lifecycle](./operations/runtime-lifecycle.md) | [Observability](./operations/observability.md), [database operations](./operations/database.md) |
| Understand deployment ownership | [Deployment boundary](./operations/deployment.md) | [Configuration](./reference/configuration.md) |
| Investigate known failures | [Maintainer docs](#maintainer-state) | [Incident archive](#incidents-and-migrations) |
| Plan future work | [Active roadmap](#active-roadmap) | [Completed and superseded plans](#plans-and-evidence) |

## Fast routes by role

- **Any newly loaded bot:** overview, architecture map, source map, then the
  relevant guide or reference.
- **Core/runtime bot:** frames/runtime/routing, actors/routing, sessions/teams,
  compaction, and tools/processes.
- **Plugin/provider bot:** plugins/providers/persistence, plugin reference,
  plugin-authoring guide, and tools reference.
- **UI bot:** frontend guide, HTTP API, shared projection sections in the
  architecture map, and the required AEOR framework skill from `AGENTS.md`.
- **Operator:** runtime lifecycle, database operations, observability,
  configuration, and deployment boundary.
- **QA/reviewer:** testing guide, capability table in the overview, source map,
  known issues, and relevant dated incident evidence.

## Current architecture

- [Architecture map](./architecture/README.md) — composition, system map, and
  capability status.
- [Frames, runtime, and routing](./architecture/frames-runtime-routing.md) —
  durable frame flow and projection boundaries.
- [Actors and routing](./architecture/actors-and-routing.md) — humans, agents,
  coordinator selection, mentions, characters, and profiles.
- [Agentic script](./architecture/agentic-script.md) — provider-facing agent
  loop, tool continuation, and completion controls.
- [Concurrent context compaction](./architecture/context-compaction.md) —
  background compaction, selection, chunking, and hard-limit behavior.
- [Plugins, providers, and persistence](./architecture/plugins-providers-persistence.md)
  — extension registries, database abstraction, and hot-unload limitations.
- [Sessions, teams, and cross-session work](./architecture/sessions-teams-cross-session.md)
  — hierarchy, authority, team invitations, messages, tools, and merge.
- [Tools, processes, scheduling, and recovery](./architecture/tools-processes-scheduling.md)
  — durable async work and restart semantics.

## Current reference

- [Agent behavior](./reference/agent-behavior.md) — runtime behavioral contract
  for participants and coordinators.
- [Authentication](./reference/authentication.md) — Kikx-native, driver-neutral
  identities, sessions, magic links, and API keys.
- [Configuration](./reference/configuration.md) — configuration layers, paths,
  environment variables, and precedence.
- [Database drivers](./reference/database-drivers.md) — contract, capabilities,
  selection, PostgreSQL primary, SQLite, and AeorDB compatibility.
- [HTTP and SSE API](./reference/http-api.md) — route families, auth, and live
  runtime events.
- [Plugins](./reference/plugins.md) — discovery, registration surfaces,
  override behavior, and lifecycle caveats.
- [Source map](./reference/source-map.md) — implementation locations by concern.
- [Storage](./reference/storage.md) — logical document layout and store seams.
- [Tools](./reference/tools.md) — built-in inventory, permissions, output, and
  asynchronous process behavior.

## Current guides

- [Development](./guides/development.md) — setup, startup, readiness, and local
  troubleshooting.
- [Frontend](./guides/frontend.md) — browser architecture, AEOR requirements,
  state, event, and disposal rules.
- [Plugin authoring](./guides/plugin-authoring.md) — plugin structure,
  registration, descriptors, and verification.
- [Testing](./guides/testing.md) — test families, safe commands, credentials,
  and database mutation warning.

## Current operations

- [Runtime lifecycle](./operations/runtime-lifecycle.md) — startup, readiness,
  recovery, shutdown, and watcher behavior.
- [Database operations](./operations/database.md) — driver selection, current
  PostgreSQL expectations, migrations, backup, and safety.
- [Observability](./operations/observability.md) — logs, health, memory, SSE,
  durable evidence, and diagnosis order.
- [Deployment boundary](./operations/deployment.md) — what this repository owns
  versus the sibling distribution repository.

## Maintainer state

These documents are current maintainer evidence, not general architecture:

- [Temporary diagnostics](./maintainers/temporary-diagnostics.md)
- [Session-message impersonation issue](./maintainers/known-issues/session-message-impersonation.md)
- [Web-tools completion race](./maintainers/known-issues/web-tools-completion-race.md)

## Active roadmap

Roadmap files describe intent. Confirm the implementation before claiming a
roadmap item is shipped.

- [Plugin extensibility campaign](./roadmap/plugin-extensibility.md)
- [Plugin platform campaign](./plans/plugin-platform-campaign.md)
- [Scrollview campaign](./plans/scrollview-campaign.md)
- [Session-tree consolidation](./roadmap/session-tree-consolidation.md)
- [Session work area](./roadmap/session-work-area.md)
- [Owner UI review, 2026-10-27](./roadmap/reviews/owner-ui-review-2026-10-27.md)

## Current plans and evidence

These dated plans and reports are implementation evidence, not general
architecture. Their own authority banners govern how they may be used.

- [Plugin-way gap analysis, 2026-10-29](./reports/plugin-way-gap-analysis-2026-10-29.md)
- [Sidebar scope seam, 2026-10-30](./reports/sidebar-scope-seam-2026-10-30.md)
- [Thinking rack repaint, 2026-10-30](./reports/thinking-rack-repaint-2026-10-30.md)
- [Composer emoji typeahead, 2026-10-30](./reports/emoji-typeahead-2026-10-30.md)
- [Browser-lane control, 2026-10-30](./reports/browser-lane-control-2026-10-30.md)
- [Coordinator lane 2 decision, 2026-10-30](./reports/coordinator-lane2-decision-2026-10-30.md)
- [Coordinator residue rung 4, 2026-10-30](./reports/coordinator-residue-rung4-2026-10-30.md)
- [Instruction recovery, 2026-10-27](./reports/instruction-recovery-2026-10-27.md)
- [Owner UI review 2 fixes, 2026-10-27](./reports/owner-review-2-fixes-2026-10-27.md)
- [Sync and visibility leak, 2026-10-28](./reports/sync-and-visibility-leak-2026-10-28.md)

## Historical archive

Everything below is retained evidence. Its banner, date, and status govern how
it may be used.

### Revision lineage

- [Development revision history](./history/revisions/README.md)
- [Legacy Mythix translation notes](./history/revisions/legacy-mythix-translation.md)

### Incidents and migrations

- [Completion-review context loss, 2026-06-21](./history/incidents/2026-06-21-completion-review-loss.md)
- [Compaction summary loss, 2026-10-01](./history/incidents/2026-10-01-compaction-summary-loss.md)
- [Session-history window cap, 2026-10-05](./history/incidents/2026-10-05-session-history-window-cap.md)
- [Browser gate diagnosis, 2026-10-18](./history/incidents/2026-10-18-browser-gate.md)
- [Database port migration, 2026-10-14](./history/migrations/2026-10-14-database-port-5434.md)

### Plans and evidence

Completed plans:

- [Documentation consolidation](./history/plans/completed/documentation-consolidation.md)
- [Agent routing coordinator](./history/plans/completed/agent-routing-coordinator.md)
- [Bindings teardown](./history/plans/completed/kikx-bindings-teardown.md)
- [Compaction](./history/plans/completed/kikx-compaction.md)
- [Configuration store](./history/plans/completed/kikx-config-store.md)
- [Database-driver layer](./history/plans/completed/kikx-database-driver-layer.md)
- [Durable process state](./history/plans/completed/kikx-durable-process-state.md)
- [Native authentication](./history/plans/completed/kikx-native-auth.md)
- [Prompt compression](./history/plans/completed/kikx-prompt-compression.md)
- [Stability campaign](./history/plans/completed/kikx-stability.md)
- [Tool rename and loop termination](./history/plans/completed/kikx-tool-rename-and-loop-termination.md)
- [Ollama provider and async descriptors](./history/plans/completed/ollama-provider-and-async-descriptors.md)
- [Session-history lazy loading](./history/plans/completed/session-history-lazy-loading.md)

Historical, evidence, and superseded plans:

- [Ask-user and activities historical plan](./history/plans/historical/kikx-ask-user-and-activities.md)
- [Ask-user and activities definition-of-done evidence](./history/plans/evidence/kikx-ask-user-and-activities-v0.2.md)
- [Superseded Docker distribution plan](./history/plans/superseded/kikx-docker-distribution.md)
- [Superseded production deployment plan](./history/plans/superseded/kikx-prod-deploy.md)

### Reports and reviews

- [Deleted-sessions dogfood report, 2026-10-13](./history/reports/2026-10-13-deleted-sessions-dogfood.md)
- [Index lock and flush report, 2026-10-18](./history/reports/2026-10-18-index-lock-and-flush.md)
- [Scheduled-frame P9 verification](./history/reports/p9-scheduled-frame-verification.md)
- [Wake-spec audit](./history/reports/wake-spec-audit.md)
- [Pi versus Kikx prompt review, 2026-10-25](./history/reviews/2026-10-25-pi-vs-kikx-prompts.md)
- [Ask-user P2/P3 review](./history/reviews/ask-user-p2-p3.md)

## Archive and maintenance rules

- Put current behavior in architecture, reference, guide, or operations docs.
- Put intended work in `roadmap/`; move completed work to `history/`.
- Preserve backend-specific forensic facts in dated history, but use “the
  database” or “configured database driver” for product-wide contracts.
- Add every new Markdown document to this index. Documentation verification
  treats an unindexed document as a failure.
- Update `last_verified` when source is re-audited; do not update it for wording
  changes alone.
