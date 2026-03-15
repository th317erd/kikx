# Kikx Documentation Index

Kikx is a self-hosted AI agent orchestration platform — a multi-agent, multi-user chat system where humans and AI agents collaborate in persistent sessions with real tool access, permissions, and cryptographic identity.

---

## Core Documentation

| Document | Description |
|----------|-------------|
| [Project Overview](./project-overview.md) | What Kikx is, architecture layers, key concepts (frames, sessions, agents, plugins, permissions), technology stack |
| [Data Models](./data-models.md) | All 9 database models with fields, relationships, schema migrations, and cryptographic patterns |
| [Plugin System](./plugin-system.md) | Plugin architecture, tool development, internal plugins, agent plugins, frame router, external plugin development |
| [Client Architecture](./client-architecture.md) | Web Components SPA, 32 components inventory, state management, WebSocket communication, routing, styling |

## System Deep Dives

| Document | Description |
|----------|-------------|
| [User Message Pipeline](./user-message-pipeline.md) | Full data flow from HTTP POST through interaction loop to frame creation and client delivery |
| [Permission System](./permission-system.md) | Rule evaluation engine, risk levels, session ancestry walk-up, approval lifecycle, custom permission matching |
| [ValueStore Signing](./valuestore-signing.md) | Ed25519 signing for tamper-proof stored values, signing/verification flow, security considerations |
| [Signing Surface Area](./signing-surface-area.md) | Complete inventory of all signing and verification operations across the codebase |

## Planning Documents

| Document | Description |
|----------|-------------|
| [Server Plan](../plan/kikx/server-plan.yaml) | 25-section server architecture plan covering all design decisions (YAML) |
| [Client Plan](../plan/kikx/client-plan.yaml) | Client architecture plan: design system, components, state management, testing strategy (YAML) |
| [Future Plans](../plan/kikx/future-plans.yaml) | Feature roadmap with status, priority, and descriptions (YAML) |

## Other

| Document | Description |
|----------|-------------|
| [Architecture (YAML)](./kikx/architecture.yaml) | Compressed YAML overview of the entire application architecture |
| [Status (YAML)](./kikx/status.yaml) | Current implementation status and completed phases |
| [Known Issues (YAML)](./kikx/known-issues.yaml) | Catalog of bugs, code smells, and tech debt |
