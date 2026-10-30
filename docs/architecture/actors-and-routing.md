# Actors, Agents, and Coordinator Routing

> **Current v3 architecture.** Last verified against source: 2026-10-27.

Kikx sessions can contain multiple agents and users. Agent turns are not a
broadcast free-for-all: a designated coordinator interprets ordinary traffic
first and explicitly selects additional agent recipients.

## Current actor model

Two actor types are implemented end to end:

- **Users** are Kikx-native authenticated identities. They can author messages,
  participate in sessions and teams, and have a separate presentation profile.
- **Agents** are provider-backed identities with config, secrets, tags, enabled
  state, model choice, and character fields. They can be routed turns and use
  tools.

Frames retain a generic `authorType`, mentions accept an injectable actor
resolver, and teams use a typed actor shape. These are extension seams. Plugin
actors are **planned, not currently wired as routable session actors**. Current
routing code explicitly handles agent recipients; user and plugin recipients are
future expansion.

## Coordinator selection

A session stores `coordinatorAgentID`. It must name a current participant. If it
does not, coordinator resolution checks the nearest ancestor session with a
valid coordinator. If no ancestor resolves one, the runtime deterministically
promotes the first participant and persists the designation. Only a tree with
no agent participants anywhere resolves to no coordinator.

Coordinator authority flows down the session tree: a coordinator can control
its session and descendants even when it is not a participant in every child.
Participation is required to run in a session; inherited authority is sufficient
to control a descendant.

## Routing sequence

For a visible user or completed agent message:

1. Slash commands and non-routing frame states are filtered first.
2. An explicit `targetAgentID`, used by scheduled continuations and process
   wakes, routes directly to that participating agent.
3. Otherwise the coordinator is the sole initial target for ordinary traffic.
4. The coordinator may answer, stay silent, or use `route` to update the source
   frame's recipients/mentions and mark it coordinated.
5. Routing rereads the current source frame after the coordinator turn and runs
   the selected non-coordinator recipients in order.
6. A coordinated frame never wakes the coordinator again.

The response frame records routing ancestry so repeated updates do not deliver
the same root request to the same agent twice. An author is never routed its own
message.

## Mentions

Text mentions are parsed into references and normalized into an actor map. The
resolver first tries the injectable general actor resolver, then agent and user
resolvers when present. In the current server composition, agent lookup is the
working path. Resolved agent mentions can become routing recipients; unresolved
or future actor types must not be described as already routable.

## Steering, cancellation, and suspension

An active agent run records the commit order at which it began. A newer user
message targeted to that agent or the coordinator can mark the run as steered,
allowing the provider loop to incorporate fresh authority. Cancellation is
tracked per agent run.

Session suspension prevents agent/tool work. A fresh human message resumes the
coordinator first; the coordinator decides what worker activity should resume.
Coordinator-authored routing never silently wakes a suspended worker. Suspension
state is persisted in the session manifest so restart does not erase it.

## Character versus profile

An agent's **character** guides how it contributes. The agent record stores a
full character plus a bounded compressed character used in its start brief. The
`set-character` control tool updates both. Provider config and model choice are
operational configuration, not the character.

A human **account profile** is a different record. Authentication owns the user
identity, name, email, and roles; the account profile holds presentation fields
and future preferences. Kikx does not currently have a separate generalized
“bot profile” entity beyond the agent record.

## Source of truth

- [`src/core/agents/agent-route-frame-plugin.mjs`](../../src/core/agents/agent-route-frame-plugin.mjs)
- [`src/core/agents/agent-route/targeting.mjs`](../../src/core/agents/agent-route/targeting.mjs)
- [`src/core/agents/coordinator-scope.mjs`](../../src/core/agents/coordinator-scope.mjs)
- [`src/core/mentions/mention-resolver.mjs`](../../src/core/mentions/mention-resolver.mjs)
- [`src/core/agents/agent-manager.mjs`](../../src/core/agents/agent-manager.mjs)
- [`src/core/auth/user-store.mjs`](../../src/core/auth/user-store.mjs)
- [`src/core/account/account-store.mjs`](../../src/core/account/account-store.mjs)

## Related

- [Architecture overview](./README.md)
- [Session trees and teams](./sessions-teams-cross-session.md)
- [Agentic script](./agentic-script.md)
- [Agent behavior reference](../reference/agent-behavior.md)

