# Kikx Prompt Compression — Implementation Plan

- id: kikx-prompt-compression
- status: drafting — decisions D1–D5 awaiting owner ruling
- dt: 2026-10-01
- by: assistant (planning), owner (design + rulings)
- ref: `exports/kikx-agent-prompt-dump.md` (§4 and the rev-3 "PROPOSED CONDENSATION"),
  `exports/kikx-prompt-split.md` (per-section tracking), `~/Projects/agis/docs/runtime.md`

> Purpose: replace the ~4,190-token monolithic per-turn "agentic script" prompt with
> a two-tier brief system — a once-per-(re)start **Brief A** and a tiny per-message
> **Brief B** — fixing the small-context-model failure and cutting cost, without
> losing any operational information.

---

## 0. Progress ledger

- P0 — context-budget safety net ported + verified (536→ core suite green; live no-400).
  STATUS: done (uncommitted, awaiting owner's commit go).
- P1 — context windows for every agent (D7): Codex done; Ollama done (discovery via
  `POST /api/show`, 1,048,576 observed for `deepseek-v4.1-flash:cloud`). STATUS: done.
- P2/P3/P4/P5 — two-tier briefs, send-once, coordinator+party gating. STATUS: done.
  Bug found + fixed during review: Brief A was re-sent on every agent alternation
  (single shared marker); now per-agent. Cold-start (process restart) re-sends.
- P6 — compressed character (D2): field `characterCompressed`, max length 400,
  required on `agent-character-set`, persisted through manager/store/REST; Brief A
  uses it with a fallback. STATUS: done.
- P7 — prioritized JSON compaction + small-bot filtering (D6): `content.summaryJSON`
  with `{high,medium,low,unstructured}`; `selectCompactionLevels(window)` drops
  low/medium for small windows; providers pass the resolved window. STATUS: done.
- P8 — content cleanups: token usage no longer sent to the model; added `help` tool
  + per-tool help; added a stop/FOMO denylist spec. STATUS: done.
- P9 — monolith removed (`agent-prompt-context.mjs` deleted, `buildDefaultAgentPrompt`
  and the old builders gone); zero-reference grep clean. STATUS: done.
- Gates: core 582/582, codex 33/33, ollama 17/17, eslint clean.
- Live e2e (Gemma, :8090): shape `system > BriefA > BriefB`, version `0.1.0` from
  package.json, message once, 1,952 tok « 32,768. PASS.

ALL PHASES P0–P9 COMPLETE. Remaining: owner verification on dev, then dogfood redeploy.

## 1. Evidence (quantified)

- Full prompt today: **16,746 chars (~4,187 tok)**, re-sent **every turn and every
  tool round**. Measured live: a trivial single-agent turn made **13 requests**,
  each carrying the monolith; completion-review request reached **185,600 chars**
  and 400'd the 32k-context local model.
- Breakdown (from `kikx-prompt-split.md`): STATIC 3,042 tok · SEMI 934 tok ·
  DYNAMIC 206 tok. Brief A ≈ 3,976 tok (once); Brief B ≈ 206 tok (per message).
- Motivating incident: Session 35 "Gemma isn't responding" — llama-server
  `--ctx-size 32768`, request exceeded the window → HTTP 400.
- Design artifacts already built and owner-loved: `exports/kikx-agent-prompt-dump.md`
  §4 + rev-3 condensation (two-brief form).
- In-flight (uncommitted) safety work from the context-budget sub-agent: model-aware
  budgeting + trim-from-end, completion-review cap, priority-tagged compaction,
  dangling-placeholder fix. `npm test` 536/536, codex 33/33.

## 2. Territory (from read-only investigation)

Assembly path: `agent-route-frame-plugin.routeAgent` builds `runParams` →
`AgentInterface.run` → `runAgentLoop` → `createAgentLoopScript` (one `ask` whose
`prompt` is the monolith) → `ask` → provider → `buildModelMessages` emits
`[system][history…][user=params.prompt]`. `resolvePromptContent` prefers
`params.prompt`. The trigger frame is skipped in history to avoid duplication.

Touchpoints (ranked): `agent-interface.mjs` (371/206/217/105/350), `agent-script-template.mjs`,
`agent-model-context.mjs` (47/26), `kikx-plugin-ollama/index.mjs` (77-113),
`kikx-plugin-codex/index.mjs` (178-231), `agent-route-frame-plugin.mjs` (170-223),
`compaction-service.mjs` + `frame-context-builder.mjs`, `agent-prompt-context.mjs`,
new `agent-precepts.mjs`, and the specs in §7 of the investigation.

Risky couplings: (1) providers depend on `params.prompt` + `buildModelMessages`;
Codex `fitRequestInput` can trim anything except the protected `system` slot;
(2) `normalizeRequiredString(prompt || frame.content.text)` throws/falls back on a
tiny Brief B for hidden frames; (3) trigger-frame dedup; (4) no existing "sent once"
marker; (5) completion-review is a second `ask` on the same stack.

## 3. Frame

**Target.** Two briefs:
- **Brief A — once per (re)start** (session start, new agent, after compaction,
  coordinator change): version banner, compressed character, AGIS precepts, tool
  list + tool notes, behavior rules, and (coordinator-only) coordinator preamble.
- **Brief B — every turn and tool round:** `Message from {sender} {timestamp}:`,
  the message, and compact dynamic state (todo, cwd, coordinator flag, participants).

**Non-goals.** Not a rewrite of tool semantics; not raising any context window; not
touching the already-deployed dogfood container until dev is verified.

**Binding constraint.** Trim-from-end keeps the user's current message; Brief A must
survive trimming for small models (protected like `system`), or be re-sent when lost.

## 4. Contracts

- Brief A and Brief B are **pure builders**: `buildStartBrief(context)` →
  `{ text }`; `buildMessageBrief(context)` → `{ text }`. Providers stay ignorant.
- `buildModelMessages` becomes the single place that decides message shape:
  `[system = base]` + `[brief-A user turn]` + `[history]` + `[brief-B user turn]`.
- Precepts are a stored constant (`agent-precepts.mjs`), not re-derived.
- Dynamic values use the `{param}` template convention (rendered before send).
- Coordinator preamble is a stored, coordinator-only block.

## 5. Decisions (verbatim owner rulings, 2026-10-01)

- **D1 (RATIFIED).** The version banner is `{packageJSON.version}` — read from
  `package.json`. `v0.2.3` was only an example.
- **D2 (RATIFIED).** Store a **compressed character** on the agent. The character
  command must **require** a `compressedVersion` / `shortVersion` argument, with a
  **character limit**, forcing bots to compress their own profiles. Humans can
  supply their own short form.
- **D3 (RATIFIED).** Fewer than 3 parties → no coordinator and no coordinator
  preamble. **Parties include users.** As soon as there are more than two parties
  (even if one is human), the agent must be "aware" and the coordinator role kicks
  in.
- **D4 (RATIFIED).** Ship **only the precepts** in Kikx for now. The full AGIS
  runtime is too large/complex to build in at this time (owner may revisit). Vendor
  the precepts as a constant.
- **D5 (RATIFIED).** **Fold** the uncommitted budget/trim work into this campaign's
  P0 — more work follows here.
- **D6 (RATIFIED, new).** Update compaction so the summary is deliberately
  **prioritized into sections and stored as JSON**, so it can later be **filtered to
  the most important sections for smaller bots** (e.g. Gemma).
- **D7 (RATIFIED, new).** Ensure **all plugins and dynamic model loading produce a
  context-window limit for every agent** (needed by D6 filtering and by budgeting).
- **D8 (self-answer).** "Sent once" tracking — recompute from
  `context.contextMemory.latestCompaction` + `session.coordinatorAgentID`; persist
  last-briefed markers in session metadata only if recompute proves unreliable.

## 6. Phases

### P0 — Land the safety net (gate: none) [uncommitted work exists; D5]
Verify and land model-aware budgeting/trim, completion-review cap, priority-tagged
compaction, dangling-placeholder fix. Full gates green.
**Pass:** core + codex suites green; eslint clean; live Gemma "How are you Gemma?"
no longer 400s.

### P1 — Model context windows for every agent (gate: D7)
Ensure every plugin/model resolution yields a context-window limit: Ollama
(`GET /api/show` / model manifest), Codex/OpenAI, and any dynamic model loading.
Expose via `AgentInterface.contextWindowFor` / `getModels`. `contextWindowTokens`
config remains a manual override.
**Pass:** a spec proves a finite window for each provider's resolved model; unknown
models fall back to a safe default, never `null` at budget time.

### P2 — Extract prompt content (gate: D1, D4)
Create `src/core/plugins/agent-precepts.mjs` (precepts constant) + a version helper
reading `package.json.version` (D1). Add `buildStartBrief` and `buildMessageBrief`
in `agent-script-template.mjs` (keep old builders temporarily). Port the rev-3
condensation verbatim.
**Pass:** unit tests for both builders (content, presence, sizes); no behavior change
yet.

### P3 — Assemble two-tier messages (gate: P2)
Rework `buildModelMessages` to emit system + Brief A (user) + history + Brief B
(user). Adjust trigger-frame dedup so the message appears exactly once (in Brief B).
Suppress Brief A re-send on completion-review `ask`.
**Pass:** `agent-model-context-spec` updated; single copy of the message; Brief A
present once.

### P4 — "Send once" detection (gate: P3, D8)
Add `shouldSendStartBrief(context)` = first message | new agent | newer
`latestCompaction` boundary | coordinator changed. Ensure Brief A is not trimmed
away for small models (protect it, or re-send when a boundary advances).
**Pass:** Brief A sent once per restart across a multi-turn + post-compaction
scenario; not re-sent on ordinary turns.

### P5 — Coordinator preamble + party-count rule (gate: D3)
Stored, coordinator-only builder included in Brief A only for the assigned
coordinator; suppress entirely below 3 parties, **counting users**.
**Pass:** coordinator gets it once; non-coordinators never; 2-party sessions
(1 user + 1 agent) don't.

### P6 — Compressed character (gate: D2)
Add required `compressedVersion`/`shortVersion` (length-limited) to the character
command + agent record; surface it in Brief A. Migration path for existing agents
without one.
**Pass:** command rejects missing/over-limit compressed version; Brief A uses it.

### P7 — Prioritized JSON compaction (gate: D6, P1)
Change compaction output to a JSON summary with priority-tagged sections; add a
filter that selects sections by a bot's context budget (small bots → high only).
**Pass:** compaction stores JSON; filter drops lower sections for small windows;
large-model output unchanged in meaning.

### P8 — Content cleanups (gate: D1, D2)
- Remove token-usage from frames (todo).
- Add `help` tool + per-tool help (todo).
- Confirm stop-inducing / FOMO language gone (reflected in rev-3).
**Pass:** each item covered by a spec.

### P9 — Providers + tests + live e2e (gate: all)
Update Ollama + Codex to carry the two tiers (or rely on core assembly); update all
specs from the investigation; run the live llama-server acceptance.
**Pass:** core + codex + ollama suites green; live Gemma no-400; measured per-request
sizes reported.

## 7. Verification spine

- Failing-first specs for: Brief A/B content, send-once detection, coordinator-only
  gating, 2-party suppression, no-duplicate message, budget keeps Brief B.
- Keep existing 536 core / 33 codex green through every phase.
- Live e2e against `127.0.0.1:8090` (Gemma) as the acceptance gate each phase touches.
- Grep-gate: old monolith builders removed at completion; no references remain.

## 8. Risks

- Provider `params.prompt` contract — mitigate by assembling in core.
- Hidden-frame prompt fallback (`normalizeRequiredString`) — Brief B must always
  carry the message for hidden/continuation frames too.
- Completion-review double-ask — suppress Brief A there.
- Test churn in `agent-interface-spec.mjs` (~117 assertions) — expected.

## 9. DoD (mechanical)

1. `buildModelMessages` emits two tiers; monolith re-sent never occurs.
2. Brief A sent once per restart (start/new-agent/compaction/coordinator-change).
3. Brief B is the last user turn every request; message appears exactly once.
4. Coordinator preamble only to the coordinator, only with ≥3 parties.
5. Precepts present in Brief A from the stored constant.
6. Core + codex + ollama suites green; eslint clean.
7. Live Gemma e2e: no HTTP 400; per-request sizes ≤ window.
8. Old monolith builders + `buildAgisCriticalThinkingPromptLines` /
   `buildProperAgentBehaviorPromptLines` removed; grep returns zero.
