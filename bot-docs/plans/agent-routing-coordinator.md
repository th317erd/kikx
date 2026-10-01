# Plan: Coordinator-routed messaging (trigger vs. context)

## Status: IMPLEMENTED (P0–P3) — 468/468; verified in unit + scenario specs

## Goal

Make a session's **coordinator the router for all traffic**. Every message is
delivered to the coordinator, which decides who (if anyone) is *triggered* to
respond. Every participant still *sees* the whole conversation as context; only
the coordinator-designated **recipients** are activated. This separates
**delivery/context** (everyone, always) from **trigger** (explicit set), which is
the root cause of the message cascade seen in Session 32.

## Non-goals

- Turn budgets, queues, or other deterministic cascade caps. Kikx stays
  asynchronous; the coordinator's judgment is the mechanism.
- A numeric scoring/routing engine. Deferred (owner: "back burner").
- Provider/plugin changes. Routing is core.

## Success criteria

1. A user message, by default, triggers **only the coordinator** (plus anyone the
   user explicitly `@`-mentioned). Non-triggered agents receive it as context and
   produce **no** turn.
2. An agent reply, by default, triggers **only the coordinator**. No agent→agent
   reply ping-pong without an explicit routing decision.
3. The coordinator can **route** a frame to one or more recipients (by id or name,
   including misspelled names it resolves itself), **remove** recipients, **answer**
   itself, or stay **silent** — as explicit, auditable choices.
4. `frame.recipients` is a **generic actor list** (agents today; users/plugin
   actors later), persisted and hidden, never shown as UI noise.
5. Reproducing the Session 32 shape (1 user msg, 2 agents incl. a verbose persona)
   yields **one** agent response, no cascade.
6. Full history remains in every agent's `params.frames` (passive context), so
   agents that are not triggered still know what happened.

## Owner decisions (verbatim)

- "if a bot is IN the [recipients] array by name or id, then it is 'triggered'. If
  it isn't in the array, then it stays silent. This allows the coordinator to
  'tag' bots into the ... array ... If ALL messages get routed through the
  coordinator, and the coordinator directs them like a mailman, then it should
  work for everyone. All messages from all bots are always visible in context,
  all contexts, of all bots present."
- "We didn't differentiate 'trigger' from 'passive memory in the context'. This is
  an important distinction."
- "the coordinator should _always_ get the message, even if they aren't in the
  list of recipients... but the coordinator can also modify every message...
  including removing recipients."
- "these recipients must be more generic than 'agents'" (future humans/plugin
  actors).
- "I understand the extra cost with coordinator routing. I accept it."
- "Always [wake the coordinator on agent replies]. The bot might be calling out
  anyone, including the coordinator. The coordinator should be the router of all
  traffic."
- "Probably a tool."
- "hidden. We don't need to cause eye-bleed."
- "One plan with phases is fine with me."

## Observed facts (verified this session)

- **Cause of the cascade.** `resolveRouteTargets` (`agent-route/targeting.mjs`)
  returns `[coordinator, ...participants]` for a `UserMessage` and *every*
  participant except the author for an `AgentMessage`. Activating an agent =
  running its full LLM turn, so "delivery" *is* "trigger." The only brake is the
  model choosing `agent-null-response`, which verbose personas ignore.
- **Session 32 evidence** (`631fcb48-…`, coordinator **DeepSeek 1** + **Captain
  Blackbeard**): one user turn produced 2 agent replies (#607+#608, #852+#853);
  Blackbeard answered the same root twice (#853 and #1119, both root `c629ea3a`,
  second source `240ddf7b` — a peer-triggered repeat).
- **Actors are already generic.** `normalizeActorMention` → `{ id, type, name,
  username, fullName, reference }`, resolved `actorResolver → agentManager →
  userManager`. Sessions already carry `participantUserIDs`. `recipients` as actor
  IDs needs no new model.
- **`frame.targets` is taken** — it means *merge-target frames* (`frame-engine.mjs`
  `_mergeTargets`). Recipients must use a new field name.
- **Mentions already exist.** `MentionFramePlugin` parses `@ref` via
  `parseMentionReferences` + `resolveMentionActors` and persists `frame.mentions`
  (map keyed by actor id). Recipients can be derived from this.
- **`internal-forward` exists** and is coordinator-only
  (`agent-route-frame-plugin-base.mjs#forwardFrame`): merges mentions, sets
  `coordinated:true` + `coordination.message`, re-enqueues an update. This is ~80%
  of the `route` tool.
- **Full history is already passed** to every provider as
  `params.frames`/`params.sessionFrames`, so passive context needs no new work.
- **Frame fields persist**; `MERGEABLE_FIELDS = { content, hidden, deleted,
  updatedAt, state }`. A top-level `recipients` is not mergeable by default — the
  router sets it explicitly, and we add it to the merge set if the forward/route
  path relies on `engine.merge`.

## Territory

Trace entry → orchestration → authority → storage → publication → clients:

- **Entry**: `FrameRouter` selectors `Type:UserMessage`, `Type:AgentMessage`
  (`registerAgentRouting`) → `AgentRouteFramePlugin.process`.
- **Authority/decision**: `agent-route/targeting.mjs` (`shouldRouteToAgents`,
  `resolveRouteTargets`, `filterRedundantRouteTargets`), `agent-route/
  agent-route-frame-plugin-base.mjs` (`forwardFrame`), `agent-route-frame-plugin.mjs`
  (`routeAgent`, run loop).
- **Prompt/loop**: `agent-prompt-context.mjs#buildRoutingPromptLines`,
  `agent-loop-tools.mjs` (`createLoopTools`, `internal-forward`), `agent-loop-state.mjs`
  (`handleLoopControl`, `dispatchForwards`), `agent-script-template.mjs`.
- **Tool defs**: `agent-tool-definitions.mjs` (`internal-forward`).
- **Persistence**: `frame-engine.mjs` (`_normalizeFrame`, `_mergeTargets`,
  `MERGEABLE_FIELDS`), `aeordb-frame-store*` (body read/write of `recipients`).
- **Mentions**: `mention-frame-plugin.mjs`, `mention-resolver.mjs`.
- **Clients/docs**: frame rendering (`kikx-frame-item`, label logic) must keep
  ignoring hidden routing metadata; no user-visible change.

## Contracts

- **`frame.recipients`**: array of actor IDs (strings), generic (agent/user/etc.).
  Hidden routing truth; persisted; never rendered. Distinct from `frame.mentions`
  (textual `@` evidence, map) and from `frame.targets` (merge targets).
- **Trigger rule**: targets = `unique([coordinator, ...frame.recipients])` minus
  the frame author. Deterministic; applied on frame create/finalize for both
  `UserMessage` and `AgentMessage`.
- **Coordinator always included** as a target (for any authored message that is
  not authored by the coordinator itself).
- **`route` tool** (coordinator-only), replaces/generalizes `internal-forward`:
  ```
  route({ recipients?: string[], remove?: string[], note?: string })
  ```
  names/ids accepted; resolved through the actor resolver; merges into
  `frame.recipients` (minus `remove`), sets `coordinated:true` + hidden
  `coordination` metadata, re-enqueues the frame. Calling `route` means the
  coordinator produces **no visible message** ("route wins over speak").
- **Agent reply default**: a non-coordinator `AgentMessage` sets/holds
  `recipients = [coordinator]` (author excluded) so it wakes only the router.
- **Silence default**: the coordinator defaults to `agent-null-response` (silent)
  unless a rule below says otherwise.

## Dispatch model (resolved this session)

Delivery is **serial per session**: the coordinator runs to completion first,
then recipients run one-at-a-time (owner: "make the coordinator process each
message serially"). `FrameRouter.runSerial()` provides the per-session chain and
keeps LLM turns off the global commit queue, so one slow agent does not block
other sessions. Recipients are read from the frame *after* the coordinator's
turn, making `route`/`remove` authoritative. The explicit `targetAgentID` bypass
(scheduled continuations, process wakes) is preserved.

## Coordinator decision system (the prompt "process")

Written as prompt rules AND encoded as the tool set. Default action is **silent**.

The coordinator, on its turn, classifies the trigger frame and acts:

1. **Explicitly addressed to another actor** (`recipients` already names someone
   other than the coordinator, or the text `@`s / names them, incl. misspellings
   the coordinator resolves): ensure that actor is in `recipients` (add on
   misspelling), then **route** (silent). Do not answer.
2. **Explicitly addressed to the coordinator** (by name/`@`/reply-to-its-frame):
   **answer**.
3. **Broad, unaddressed user message**: the coordinator **answers** as the default
   handler (it is the preferred handler for general/ambiguous user input).
4. **A specialist is clearly the right recipient** (skills/knowledge/expertise):
   **route** to them (silent), optionally with a `note`.
5. **Agent reply that fully satisfies the open request** (an agent already answered
   the current root): **silent** (no acknowledgment needed).
6. **Agent reply that asks/needs a decision/addresses the coordinator**: **answer**
   or **route** as appropriate.
7. Otherwise: **silent**.

Prompt lines are rewritten in `buildRoutingPromptLines` for the coordinator with
this ordered checklist; the "preferred agent" framing moves to "default *handler*
for broad user input" so it does not answer directed messages. Non-coordinator
addressed recipients get: "answer if it is for you, else null-response; never
forward."

## Phases

- **P0 — Recipients + coordinator-only ingress (deterministic).**
  Add `frame.recipients` (derive from resolved mentions on the mention plugin
  pass; persist). Rewrite `resolveRouteTargets` to
  `unique([coordinator, ...recipients]) - author` for **both** frame types. Keep
  `filterRedundantRouteTargets` as a secondary guard. Gate: unit tests prove a
  user msg triggers only coordinator; an agent msg triggers only coordinator;
  explicit `@X` adds X; author never self-triggers.

- **P1 — `route` tool + coordinator prompt system.**
  Generalize `internal-forward` → `route` (`recipients`/`remove`/`note`), keep it
  coordinator-only; "route wins over speak" (suppress a co-produced visible
  message when `route` is called). Rewrite `buildRoutingPromptLines` per the
  decision system. Gate: unit tests prove route sets/removes recipients, marks
  coordinated, re-enqueues, and yields no visible coordinator message; addressed
  agents get the addressed prompt and non-recipients never run.

- **P2 — Loop guards & silence defaults.**
  Invariants: author always excluded (incl. coordinator's own messages);
  `coordinated` frame is terminal for re-broadcast unless a `route` re-enqueues;
  an agent reply defaults `recipients=[coordinator]`; "already-answered root"
  hint suppresses coordinator chatter. Gate: a Session-32-shaped scenario test
  produces exactly one agent reply with no cascade, including a verbose
  non-coordinator persona.

- **P3 — Verification & regression harness.**
  Add a reusable routing-scenario harness (multi-agent, verbose persona,
  misspelled `@name`, agent-reply loop) under `spec/core/agents/`. Run full unit
  suite + eslint. Record evidence. Gate: all criteria 1–6 demonstrated.

## Verification spine

- Unit (`npm test`): new specs in
  `spec/core/agents/agent-route-frame-plugin-spec.mjs` and a new
  `spec/core/agents/routing-scenarios-spec.mjs`; mention/recipient derivation in
  `spec/core/mentions/`.
- Scenario harness (deterministic fake providers, no network): verbose persona
  that always tries to answer; assert it runs **only** when in `recipients`.
- Targeted repro of Session 32: seed coordinator + verbose agent + plain agent;
  one user message; assert 1 visible agent reply, coordinator silent, no second
  round.
- Static: `npx eslint` clean; no source file over the 500 soft / 800 hard limit.
- Manual/live (dev at :3001): send a broad message (coordinator answers), an
  `@named` message (only that agent answers), and an agent reply (coordinator
  stays silent). Capture frames via the AEORDB API.
- Regression gates: existing `agent-route-frame-plugin-spec` and
  `mention-*` specs stay green.

## Risks / limitations

- **Coordinator over/under-answering** is inherent to an LLM router; mitigated by
  a strong default-silent prompt and structural routing, tuned iteratively
  (owner accepted this).
- **One coordinator LLM turn per message** is the accepted cost; the silent path
  must stay cheap (short prompt, early exit). Future: small routing models.
- **Determinism** is only guaranteed for *triggering*, not for the coordinator's
  judgment; scenario tests use deterministic fakes to pin the structural rules.
- **Misspelled mentions** resolved by the coordinator are best-effort.
- Changing `internal-forward` to `route` touches existing specs/plugins that
  reference the old tool name; keep a compatibility alias if needed, or update
  all references in the same phase (grep-gate to zero).

## Definition of done

- `frame.recipients` is the trigger truth; coordinator is the sole default target;
  author is never self-triggered.
- Coordinator can route/add/remove/answer/silent via the `route` tool; routing is
  hidden metadata and yields no visible message.
- Session-32-shaped cascade is gone (single reply).
- All unit specs, the scenario harness, and eslint are green; live dev behavior
  matches criteria 1–6 with captured evidence.
