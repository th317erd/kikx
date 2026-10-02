# Kikx Compaction Campaign — Implementation Plan

- id: kikx-compaction
- status: ratified — implementation authorized
- dt: 2026-10-02
- by: assistant (planning), owner (rulings)
- ref: `exports/kikx-compaction-feedback-captured.md` (verbatim owner rulings),
  `exports/kikx-compaction-review.md` (current-state analysis)

> Purpose: make compaction correct and durable. It must trigger off the
> *smallest* bot in the session, choose a capable designated compactor, never
> blow the compactor's window, and degrade gracefully (recursive chunking, then
> oldest-trim) — so every bot in a session keeps working regardless of window size.

---

## Progress ledger (all phases landed)

- P0 — trigger off the smallest bot window + full-request accounting. DONE (1d6c387).
- P1 — 4-step compactor selection. DONE (1d6c387).
- P2 — `/set-*`/`/clear-*` designation commands + session fields. DONE (5c2514e).
- P3 — parallel compaction-bot list (store/manager/REST/client, `⊟` glyph;
  independent from crown). DONE (5e8c203).
- P4 — compactor-window budget + recursive chunked fallback + oldest-trim. DONE (923076f).
- P5 — per-bot conditional hold (`exceedsOwnWindow`/`heldForCompaction`). DONE (eb5acf2).
- P6 — instruction prune + base64/blob discard + realign blurb. DONE (1e265f7).
- Gates: core 663/663, eslint clean. E2E: smallest window (32768) drives the
  trigger (hardLimit 24768), not the large bot (200000).
- Known follow-up: `src/core/aeordb/aeordb-agent-store.mjs` is ~704 lines (over the
  500 soft limit) after the P3 clone; candidate for extraction.

## 0. Owner rulings (verbatim, 2026-10-02)

- **R1 — trigger off the smallest bot.** `contextWindowTokens` must become the
  SMALLEST bot context window in the session. `hardLimit = smallestWindow −
  promptReserve`; `softLimit (shouldCompact) = hardLimit * 0.7`. Trim oldest first.
- **R2 — count everything.** The size math must include EVERYTHING that must fit
  the compactor's context window (system + Brief A + tool schemas + message +
  history), not history alone.
- **R3 — crown-style compactor selection.** Clone the crown system for compaction
  (parallel, identical, different icon). Order:
  1. session compaction bot (`/set-compaction-bot`)
  2. top-3 user-designated compaction bots
  3. coordinator bot
  4. session bot with the LARGEST context window.
- **R4 — overflow fallback.** If the whole text won't fit the compactor's window:
  recursive chunked compaction (chunk → compact each → compact the results), and
  oldest-trim only as the final resort.
- **R5 — async guarantee.** Kikx must stop short of filling the compactor's window
  and make bots WAIT for compaction. The wait is **per-bot and conditional**: a bot
  waits only if the current context cannot fit ITS OWN window; bots that fit
  proceed.
- **R6 — instructions.** Drop actor/agent names and anything already injected
  dynamically; add "base64 blobs / large low-value blobs that can be referenced
  elsewhere" to the discard list; append a short realign/reorient "vision and
  mission" blurb (source TBD; the mission system does not exist yet — ignore the
  blurb content for now, leave a hook).
- **R7 — no fidelity check** for now (possible future "compaction scoring").
- **R8 — commands (verb-first, room for get/list):**
  `/set-coordinator-bot <agent>`, `/clear-coordinator-bot`,
  `/set-compaction-bot <agent>`, `/clear-compaction-bot`. An argless `set-*` must
  explain usage / prompt for input and NEVER mutate state; clearing is explicit.
- **R9 — icon:** a "compact/compress" glyph (not a crown); owner will approve or
  change later. Not blocking feature work.

## 1. Current state (evidence)

- Service uses one global `contextWindowTokens`/`compactionAgentContextTokens`
  (default 128000, `create-server.mjs:200-201`); the route passes no per-agent
  window (`agent-route-frame-plugin.mjs:173-182`). → small models never compact in
  time and the compactor prompt can exceed their window.
- `contextTokens` counts only history frames (`frame-context-builder.mjs:60-72`).
- Compactor order: env → `session.compactionAgentID` → current agent → participant
  (`compaction-service.mjs:433-458`).
- Coordinator **assignment is not implemented**: `session.coordinatorAgentID`
  exists and is read, but only auto-set to `participantAgentIDs[0]`
  (`frame-runtime-normalize.mjs:126`); no tool/route/command writes it.
- Crown system (to clone): agent fields `crownedAt`/`crownedClock`
  (`aeordb-agent-store.mjs:54-55,242-243`), `MAX_MASTER_AGENTS = 3` + eviction
  (`:15,255-320`), manager `setAgentCrowned`/`listMasterAgents`/`resolveDefaultAgent`
  (`agent-manager.mjs:114-130`), REST `POST /api/v1/agents/:id/{crown,uncrown}` +
  `GET /api/v1/agents/masters` (`agent-routes.mjs:60-100`), client
  `master-agent-helpers.mjs`, `agent-list-model.mjs`, `kikx-modals.mjs`,
  `kikx-agent-controller.mjs`.
- Effective model windows ARE resolvable today: `AgentInterface.contextWindowFor`
  and provider `getModels().contextWindow` (Codex + Ollama both set it).

## 2. Contracts

- **Effective window** for an agent = `config.contextWindowTokens` override, else
  provider manifest `contextWindow` for the configured model, else a finite
  provider default. Never null at decision time. Resolved per participant.
- **Compaction budget** = compactor's effective window − (everything in the
  compactor request: instructions + metadata + serialized input + output reserve).
- **Trigger** = smallest participant effective window. `shouldCompact` at
  `0.7 × (smallestWindow − baseReserve)`; hard wait at `smallestWindow − baseReserve`.
- **Selection** is a pure function returning `{ compactorAgentID, reason }`.
- **Designation** is session state: `session.coordinatorAgentID` (existing) and a
  new `session.compactionAgentID` (currently read but never written).
- **Compaction-bot list** mirrors the crown exactly: rolling top-3, fields
  `compactionCrownedAt`/`compactionCrownedClock`, eviction at 3, ordered newest
  first. Parallel, not shared.
- **Per-bot hold**: a bot is held only when its own projected context (that it
  would actually send) exceeds its own window AND a compaction is in flight that
  will bring it under.

## 3. Phases

### P0 — Trigger math + size accounting (R1, R2)
- Add per-participant effective-window resolution; pass the smallest window into
  `prepareAgentContext`.
- `hardLimit = smallestWindow − baseReserve`; `soft = 0.7 × hard`.
- Count the full projected request (system + Brief A + tools + message + history)
  in the usage estimate; keep oldest-first selection.
- **Pass:** unit specs for window selection (smallest wins), trigger thresholds,
  and full-request accounting. Existing suite green.

### P1 — Compactor selection (R3)
- Implement the 4-step order as a pure `selectCompactor({ session, participants,
  agentManager })`. Session bot → top-3 compaction-bot list → coordinator →
  largest-window participant.
- **Pass:** specs for each fallback rung and the largest-window tie-break.

### P2 — Designation infrastructure (R8)
- Session field writer: allow `updateSession` to set `coordinatorAgentID` /
  `compactionAgentID` (validate participant membership).
- Slash commands: `/set-coordinator-bot`, `/clear-coordinator-bot`,
  `/set-compaction-bot`, `/clear-compaction-bot`. Argless `set-*` → usage text,
  no mutation. Register in `internal-commands.mjs`.
- **Pass:** command specs (assign, reassign, clear, non-participant rejected,
  argless explains), session-field persistence.

### P3 — Compaction-bot list (R3, R9)
- Agent-store: parallel fields + `setAgentCompactionCrowned` + `listCompactionBots`
  + eviction (MAX 3). Manager methods. REST: `POST /api/v1/agents/:id/compact-crown`
  (+ uncrown) and `GET /api/v1/agents/compaction-bots`.
- Client: parallel list UI with a "compact/compress" glyph (icon TBD, owner to
  approve). Non-blocking for core; can land last.
- **Pass:** store/manager/route specs; UI asserts list ordering.

### P4 — Overflow fallback (R4)
- If the serialized input exceeds the compactor budget: recursively chunk →
  compact each chunk → compact the chunk summaries. If even one chunk can't fit,
  oldest-trim as the final resort (with a visible marker).
- **Pass:** specs for chunk split, recursive reduce, and the trim last-resort.

### P5 — Per-bot conditional hold (R5)
- In the async dispatch path, when a compaction is in flight, hold a specific bot's
  pending trigger until the compaction frame lands **iff** its own projected
  context exceeds its own window; other bots proceed.
- **Pass:** spec proving a small-window bot waits while a large-window bot in the
  same session does not.

### P6 — Instruction edits (R6)
- Prune actor/agent names and anything already dynamically injected; add
  base64/large-blob discard; append a realign/reorient hook (content deferred).
- **Pass:** instruction spec; assembled compactor prompt no longer duplicates
  injected fields.

## 4. Verification spine

- Core suite stays green throughout; each phase adds failing-first specs.
- A real end-to-end: a session with a small-window local agent (Gemma 32768) and a
  large-window agent must (a) trigger compaction at the small window's soft limit,
  (b) pick a capable compactor, (c) produce a summary that fits every participant,
  and (d) hold only the small bot during compaction.
- Live check against llama-server :8090 for the small-agent path.

## 5. Risks / notes

- `updateSession` currently only persists title/timestamps; adding
  coordinator/compaction fields touches session persistence + routes.
- Crown clone adds agent-store fields → serialization/index touch points.
- Per-bot hold touches `FrameRouter.runSerial` (serialized dispatch) — highest-risk
  phase; isolate behind a feature check and specs.
- Mission/"vision" source does not exist; P6 only leaves the hook.
