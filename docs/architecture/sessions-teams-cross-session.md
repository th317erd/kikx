# Session Trees, Teams, and Cross-Session Work

> **Current v3 architecture.** Last verified against source: 2026-10-27.

A Kikx session is both a conversation and a scope for participants, frames,
preferences, tool work, questions, processes, and agent state. Sessions can form
trees, and explicit tools let agents inspect and communicate across them.

## Session tree contract

Each session can store `parentSessionID` and a non-negative `generation`.
Children can inherit context, preferences, ownership visibility, and coordinator
authority according to separate rules:

- **Context fork:** by default, an agent-created child receives re-homed copies
  of the parent's current frames. `freshContext: true` creates an empty child.
  Forking preserves order and content but rewrites frame/session identity; copied
  frames are context, not parent-linked conversation nodes.
- **Preferences:** effective preferences apply defaults, then ancestors from
  root to leaf, then the session's own values.
- **Owned resources:** a descendant can see resources owned by itself and its
  ancestors. A parent does not automatically see child-owned resources.
- **Coordinator authority:** authority flows from a coordinator down through all
  descendants.

The runtime and authority algorithms support deeper trees. The current
agent-facing delegation policy is narrower: an agent in a child session cannot
call `session-create` or invite more agents. In practice, agent delegation is one
child generation deep. Do not document arbitrary recursive bot spawning as a
shipped feature.

## Cross-session tools

Cross-session operations use explicit session IDs:

- `session-list` and `session-get` discover manifests;
- `session-frames` and `session-search` inspect another transcript;
- `session-message` posts a visible agent-authored message;
- `session-invite-agents` and `session-invite-team` add participants;
- `session-control` lists, suspends, resumes, or removes agents in an authorized
  session or descendant subtree; and
- `session-merge` starts durable context consolidation.

Mutating tools that require a target never silently fall back to the current
session. The tool executor opens the target session, replaces the execution
context with its session and FrameEngine, records the tool frames there, and
pins the target for the duration. It retains source-session metadata for audit.

## Delegation workflow

Root-session agents create child sessions with `session-create`. `includeSelf`
makes the caller a participant and coordinator. An `initialMessage` should carry
the concrete assignment even though inherited context is available. Repeated
same-title creation under the same parent/creator reuses the existing child by
default, preventing duplicate delegation sessions.

Parent and child communicate with explicit `session-message` calls. A child can
reply to its `parentSessionID`; a coordinator can inspect frames and search the
child without pretending its context was automatically merged back.

## Teams

A team is a reusable named collection of typed actor members. Current member
types are `agent` and `user`. Team CRUD never creates or deletes the underlying
actors. Inviting a team resolves its members and adds them to the target
session; agent members can be woken with a hidden context-review turn, while
user members become participant users.

Teams and session participants are deliberately separate. Editing a team does
not retroactively rewrite sessions that previously invited it.

## Session merge

Session merge is a durable asynchronous job, not a frame copy operation. It:

1. loads each source session's effective post-compaction context;
2. chooses a compactor and budgets the merge;
3. may summarize source sections concurrently;
4. writes one merge compaction frame into the target session;
5. optionally soft-deletes source sessions after the target frame is durable;
6. persists job status and schedules a completion/failure wake.

Merge recovery marks jobs left running across restart as failed rather than
claiming an unknown partial result succeeded.

## Source of truth

- [`src/core/tools/session-tools.mjs`](../../src/core/tools/session-tools.mjs)
- [`src/core/context/session-fork.mjs`](../../src/core/context/session-fork.mjs)
- [`src/core/tools/session-control-tool.mjs`](../../src/core/tools/session-control-tool.mjs)
- [`src/core/teams/team-manager.mjs`](../../src/core/teams/team-manager.mjs)
- [`src/core/tools/team-tools.mjs`](../../src/core/tools/team-tools.mjs)
- [`src/core/merge/session-merge-service.mjs`](../../src/core/merge/session-merge-service.mjs)
- [`src/core/tools/tool-execution-service.mjs`](../../src/core/tools/tool-execution-service.mjs)

## Related

- [Architecture overview](./README.md)
- [Actors and routing](./actors-and-routing.md)
- [Frames, runtime, and routing](./frames-runtime-routing.md)
- [Agent behavior reference](../reference/agent-behavior.md)
