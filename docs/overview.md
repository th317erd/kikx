---
title: Kikx overview
status: current
doc_type: concept
audience: [all-bots, core, plugin-authors, ui, operators, qa]
applies_to: development-v3
last_verified: 2026-10-27
canonical: true
source_of_truth:
  - src/server/create-server.mjs
  - src/core/runtime/frame-runtime.mjs
  - src/core/routing/frame-router.mjs
  - src/core/plugins/plugin-registry.mjs
keywords: [overview, revision-3, agents, frames, plugins, compaction, sessions]
---

# Kikx overview

> **Current development-v3 documentation.** Verified against source on
> 2026-10-27. Kikx has never had a public release; “revision 3” names the third
> internal implementation, not a public or semantic-version major release.

Kikx is a modular, server-first agent harness for sustained work by humans and
multiple AI agents. A browser happens to be its current user interface, but the
core product is the frame runtime, actor/session model, tool and process system,
plugin surface, persistence contract, and transport APIs beneath that browser.

The project is intentionally aimed beyond the common “one prompt, one model,
one response” runner. A Kikx conversation can coordinate multiple bots, durable
background work, child sessions, teams, context compaction, cross-session
messages, and provider-specific plugins while preserving a single inspectable
history.

## Development lineage

Kikx is on its third internal development revision:

1. The first implementation established the original Mythix-era application.
2. The second implementation was another substantial rebuild, commonly called
   v2 or `kikx2` in historical documents.
3. The current implementation is development revision 3: a plain Node.js,
   frame-oriented runtime with explicit services and extensibility boundaries.

The first two revisions were never released publicly. Both were abandoned when
their structural problems made a fresh implementation preferable to continued
repair. Historical documents are retained because they explain design pressure
and past incidents; they do not define current behavior.

The package currently reports `0.1.0`. That package value is injected into agent
briefs and is independent of the three-revision development lineage.

## What makes Kikx different

### Frames instead of a chat transcript

Messages, tool calls, tool results, progress, compaction, commands, questions,
scheduling, and internal lifecycle state are all represented as frames. Raw
frames are durable and auditable. The runtime merges and routes them; a shared
projection layer turns them into the coherent message view consumed by agents,
the browser, and APIs.

This avoids making a rendered chat transcript the source of truth. New frame
types and projections can be added without rewriting stored conversations into
one UI's preferred shape.

### Multiple bots in one conversation channel

A session is Kikx's conversation channel. It can contain multiple human and bot
participants. One bot is resolved as coordinator; broad user traffic reaches it
first, and it routes work to other participants. Explicitly targeted and
scheduled work can bypass the coordinator when the contract calls for it.

Agent turns are serialized within one session to make routing decisions
deterministic. Different sessions can progress independently.

### Concurrent context compaction

Kikx does not stop the whole conversation whenever context needs compression.
Compaction runs in the background and is deduplicated by session/boundary. A
turn that hits its hard context limit can proceed with a bounded temporary trim
while the durable compaction catches up. Large compactions are chunked and
recursively reduced.

The trigger is based on the smallest effective context window among session
participants. The selected compactor can be session-designated, role-ranked,
the coordinator, or another suitable agent according to the implemented
selection policy.

### Durable asynchronous tools

Tool calls and results are frames, and large outputs live in a separate indexed
output store. Shell commands are managed processes rather than blocking request
handlers. Agents can inspect, search, suspend, resume, terminate, or await those
processes without repeatedly polling the shell.

Process records and output survive server restarts. Startup rehydrates process
state, repairs missing completion wakes, resumes work that never began, and does
not blindly replay side effects that had already started.

### Cross-session work

Agents can create delegated child sessions, inspect other sessions, post
explicit cross-session messages, target tools at another session, invite
actors, and merge several session histories into a target session through a
durable asynchronous job.

The session tree also carries coordinator authority and inherited preferences.
The underlying authority model supports deep trees, but agent-facing delegated
creation is deliberately limited today: an agent already working below the root
cannot use the ordinary session-create tool to create another generation.

### Actors, identities, characters, and teams

Current native actor types are humans and agents:

- Humans have Kikx-native authentication identities and presentation profiles.
- Agents have provider type, model/configuration, secrets, character, compressed
  character, tags, working directory, and todo state.
- Teams are reusable collections of human and agent actors. Inviting a team
  copies its members into a session; deleting a team does not delete its actors.

The mention resolver has an injectable generic actor seam, but plugin actors are
not yet first-class routable participants in the live host. Generic frame author
metadata should not be mistaken for an implemented third actor subsystem.

Characters and profiles are also different things. An agent's character shapes
its runtime brief; a human profile controls account presentation. Provider
configuration and secrets are neither.

### Bot hierarchy and coordination

Each session resolves a coordinator from its own designation, the nearest
ancestor, or a forced promotion when a coordinator is required. Coordinator
authority flows down the session tree. Role tags and explicit session settings
also select compaction and OCR agents.

This is a real hierarchy and delegation model, but not an unlimited recursive
agent-spawning system today. The documentation marks the creation restriction
rather than presenting roadmap ambition as shipped behavior.

### Plugin-first extensibility

Plugins can contribute or override:

- agent providers and model/configuration descriptors;
- tools and slash commands;
- frame selectors and routing handlers;
- database drivers;
- tag definitions and role actions;
- frame renderers, tool renderers, and agent configuration forms;
- selected core classes through a stack-based class registry.

Security-critical authentication and cryptography deliberately remain outside
the universal class-override surface. Plugin unload fully restores stacked core
classes, but removal from every specialized registry is not complete yet; hot
unload must therefore be treated as partial.

### UI-independent core

The core runtime has no DOM dependency. Its public seams are persisted frames,
shared frame projection, service interfaces, JSON HTTP endpoints, runtime SSE,
and plugin component descriptors. The shipped UI is a native browser client
built with the AEOR HTML framework, and no alternative first-party UI is in this
repository yet.

“UI-independent” therefore means the architecture does not require the browser,
not that several production UIs already exist.

### Pluggable persistence

Runtime services use a document-oriented database contract. The configured
driver provides required document operations and advertises optional search,
query, range, event, and backend-auth capabilities.

Current development and deployment configurations use PostgreSQL as the
operational primary. SQLite and AeorDB drivers remain built in. AeorDB is kept as
a compatibility/future-return path while its active development continues, but
it is not currently considered stable enough to be the primary Kikx store.
General runtime documentation consequently says “the database” rather than
binding product contracts to one backend.

## Capability status

| Capability | Current status | Important boundary |
| --- | --- | --- |
| Concurrent/background compaction | Implemented | A hard-limit turn may use temporary trimming instead of waiting globally |
| Multiple bots in one session | Implemented | Coordinator-first, serial within a session |
| Human actors | Implemented | Native auth identity and profile |
| Agent actors | Implemented | Provider-backed agent records and characters |
| Plugin actors | Planned/extension seam | Not first-class routable participants today |
| Durable async tools/processes | Implemented | Recovery avoids replaying started side effects |
| Cross-session messages and tools | Implemented | Explicit target IDs are required |
| Session-history merge | Implemented | Durable asynchronous coordinator-only job |
| Bot/session hierarchy | Partial | Deep authority; agent tool limits delegated creation depth |
| Characters and compressed characters | Implemented | Separate from provider config and human profiles |
| Human/agent teams | Implemented | Definitions are reusable; invitation copies membership |
| Plugin registries and class overrides | Implemented | Hot unload remains partial outside class stacks |
| Database-driver abstraction | Implemented | Some legacy AeorDB identifiers remain compatibility debt |
| UI-independent core/protocol | Implemented | Browser is the only shipped first-party UI |

## Major runtime path

At a high level:

1. The server composes configuration, plugin registries, the database driver,
   stores, tools, routing, runtime services, authentication, and transports.
2. A user, tool, command, scheduler, or agent creates or updates frames.
3. The runtime commits durable frames before routing them.
4. The router runs matching frame plugins in priority order and serializes agent
   work per session.
5. Agent routing resolves coordinator/recipient state, builds model context, and
   invokes the provider supplied by the agent's plugin.
6. Tool calls, streaming phantoms, durable results, continuations, and final
   messages return through the same frame/event machinery.
7. The shared frame manager projects raw history for agents, APIs, and the UI.

## Read next

- [Documentation index](./README.md)
- [System architecture](./architecture/README.md)
- [Frames, runtime, and routing](./architecture/frames-runtime-routing.md)
- [Actors and routing](./architecture/actors-and-routing.md)
- [Sessions, teams, and cross-session work](./architecture/sessions-teams-cross-session.md)
- [Plugin reference](./reference/plugins.md)
- [Database drivers](./reference/database-drivers.md)
- [Development revision history](./history/revisions/README.md)
