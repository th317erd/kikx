# Kikx Compaction — owner feedback, captured

Captured 2026-10-02 from `exports/kikx-compaction-review.md`. This is the input
for the compaction implementation plan. Owner comments are recorded faithfully;
my notes and verification results are marked **[assistant]**.

---

## 1. Trigger math (`frame-context-builder.mjs`)

**Owner (REQUIREMENT — this is what we want, not a description of today):**
- **`contextWindowTokens` must be set to the SMALLEST BOT CONTEXT WINDOW in the
  session** (not the global 128k).
- Rules:
  - `hardLimit = smallestContextWindowTokens - promptReserveTokens`
  - `softLimit (shouldCompact) = hardLimit * 0.7`
- Why: the smallest-window bot must still function in the session. Larger bots are
  fine with more frequent, smaller compactions.
- **Always trim from the OLDEST part of the context** when trimming is needed.

**[assistant] Current state (for the implementer):** today there is **no**
session-minimum adjustment — `CompactionService` / `FrameContextBuilder` take a
single `contextWindowTokens` (default 128000, from `KIKX_CONTEXT_WINDOW_TOKENS` in
`src/server/create-server.mjs:200`), and the route call passes no per-agent value.
So this is **net-new work**, as specified above.

**Owner — compactor selection (first pass; see §1.3 for the full design):**
1. Assigned session compaction bot → (needs `/slash-commands` to assign per session)
2. User-designated compaction bots (mirror the "crown" system)
3. Crowned/master bots in order (1st, then 2nd fallback, then 3rd final fallback)
4. If all fail: the session bot with the **largest** context window.

---

## 2. Window selection / overflow (`frame-context-builder.mjs`)

**Owner:**
- If the full text does not fit the compaction bot's window, fall back to
  **recursive chunked compaction**: break the text into smaller chunks, compact
  each separately, then compact the results together as a final step.
- This is an expensive fallback (compute + time) and should be **avoided at all
  costs**.
- Kikx is designed for **stellar compaction**: because all messages are async,
  Kikx should **always stop short of filling the compaction bot's context** and
  make bots **wait** until compaction finishes even while tool / other-bot
  messages flow in — i.e. compact **before** new material lands, so the
  compactor's window is never blown.

**[assistant]** This means the compaction trigger must reserve room for the
compactor's whole prompt, and routing/dispatch of new frames to the compactor must
be gated behind an in-flight compaction. Ties into §1.4 re-projection and the
async dispatch path.

---

## 3. Which agent compacts (`compaction-service.mjs`)

**Owner (full design):**
1. Clone the **"crown" system**, but for compaction instead of coordination.
2. Allow a specific bot to be set as the **session compaction bot** (just like
   assigning a coordinator per session).
3. If no session assignment: select the **top-3 user-assigned compaction bots**.
4. Fallback: use the **coordinator bot** for compaction.
5. If the coordinator bot can't (e.g. its window is smaller than other bots in the
   session), choose the session bot with the **largest context window**.

**[assistant]** This replaces the current order (`KIKX_COMPACTION_AGENT_ID` →
`session.compactionAgentID` → current agent → any participant). Note the
"smallest-bot-window drives compaction" rule (§1) is orthogonal: the compactor is
chosen for capability, but its *window* sizes the chunking, while the *trigger*
follows the smallest bot in the session.

---

## 4. Storage + re-projection

**Owner:** "This is all correct." No change requested.

---

## 5. Compaction instructions (`agent-compaction-template.mjs`)

**Owner:**
1. **Drop** wording we don't need — specifically actor/agent names (already
   provided as dynamic prompt injections).
2. **Drop anything already provided as a dynamic prompt injection.**
3. In the "throw out" list, also include: **base64 blobs or other large
   low-value blobs of data that can be directly referenced elsewhere.**
4. **Add at the bottom:** "towards the end of the compaction, give a short blurb of
   instructions for bots to realign and reorient themselves with the vision and
   mission at hand before they proceed."

**Prompt wrapper** (metadata + "Return only…" + frames): "This is good."

**[assistant]** I'll audit what is already injected dynamically (character,
participants, todo, cwd, coordinator, tool list) so the instructions stop asking
the compactor to preserve things the receiving bot gets anyway.

---

## 6. Findings — owner responses

- **#1 (window wiring, critical):** "Yes, I already spoke about this at length
  above." → See §1/§3.
- **#2 (fixed prompt overhead):** the size calculation must include **EVERYTHING
  that must fit in the compaction bot's context window**; audits all size math for
  correctness.
- **#3 (small model self-summarizing):** do **NOT** do per-bot compactions. Use a
  designated compaction bot that compacts based on the needs of the **smallest bot
  in the session** (larger bots tolerate more frequent, smaller compactions).
- **#4 (oversized frame):** only truncate when a single frame is **so large it
  cannot fit the compaction context at all**; in that case use **recursive chunked
  compaction** (per §2), or **trim the oldest information as the final resort**.
- **#5 (fidelity check):** **skip for now.** Compaction is already token/time
  heavy. Possible future **"compaction scoring"** to tune the system or help users
  pick the best compaction bot. Not now.

---

## 7. Fix order (owner agreed, with additions)

1. Drive compaction off the **smallest bot's window** in the session. [§1]
2. Include **everything that must fit** the compaction bot's context in the size
   math. [§6 #2]
3. **Crown-style compactor selection** (session bot → top-3 user-designated
   compaction bots → coordinator → largest-window session bot). [§3]
4. Oversized handling: **recursive chunked compaction**, then **oldest-trim** as
   last resort. [§2, §6 #4]
5. Add the **realign/reorient mission blurb** and prune dynamic-duplicate content
   in the instructions. [§5]
6. Async guarantee: **stop short of filling the compactor's window** and hold each
   bot **individually** (only if its own window can't fit) until compaction
   finishes. [§2, §8 Q4]

### Prerequisites discovered (net-new infrastructure)
- **P-a.** A **coordinator-designation** command/session field writer (never
  ported): `/set-coordinator-bot <agent>` + `/clear-coordinator-bot`. [§8 Q3]
- **P-b.** A **parallel compaction-bot list** to the crown system: rolling top-3,
  same behavior, different icon; plus per-session `/set-compaction-bot <agent>` +
  `/clear-compaction-bot`. [§3, §8 Q2]
- **P-d (general rule):** an argless `set-*` command must **explain usage / prompt
  for input**, never mutate state; clearing is always an explicit `clear-*`.
- **P-c.** Per-bot **effective context-window** available at compaction time (all
  participants), and per-bot hold/await logic. [§1, §8 Q4]

---

## 8. Owner answers to open questions

- **[Q2 — answered]** The two are **two separate lists**:
  1. the **crown** (master/coordinator) list — existing, `crownedAt`/`crownedClock`,
     top-3 rolling, `POST /api/v1/agents/:id/{crown,uncrown}`.
  2. a **new, parallel-but-identical "compaction bot" list** — same rolling top-3
     behavior, but a **different icon** (NOT a crown). "Build a parallel (but
     identical) system to crowning."

- **[Q3 — answered, with a finding]** There is **no current command** to designate
  a coordinator — that feature **was never ported from kikx2**. Today
  `session.coordinatorAgentID` exists and is read by routing/Brief A, but it is
  only ever **auto-set to `participantAgentIDs[0]`** (`normalizeCoordinatorAgentID`,
  `frame-runtime-normalize.mjs:126`). `createSession` accepts an input
  `coordinatorAgentID`, but the `session-create` tool does **not** expose it, and
  there is **no session-update tool or route** that sets it.
  - kikx2 reference: a `/promote` command ("Given session with agent A as
    coordinator, when /promote B, then B is coordinator and A is member") plus a
    participant **role** model (`coordinator`/`member`).
  - Owner: "We will want to mimic this command." → so the compaction-bot command
    should mirror whatever we build to (finally) designate a coordinator.
  - **Owner ruling — command names (verb-first, room for future get/list):**
    - `/set-coordinator-bot <agent>` — assign the session coordinator.
    - `/clear-coordinator-bot` — remove the session coordinator assignment.
    - `/set-compaction-bot <agent>` — assign the session compaction bot.
    - `/clear-compaction-bot` — remove the session compaction bot assignment.
  - **Owner rationale:** clearing must be its own explicit `clear-*` command. An
    argless `set-*` must NOT clear — users routinely run slash commands with no
    arguments just to see what they do. An argless `set-*` should therefore
    explain its usage / prompt for input, never mutate state.
  - The `set-`/`clear-` prefixes leave room for future `get-`/`list-` operations
    (e.g. `/get-coordinator-bot`, `/list-compaction-bots`).
  - Persist to `session.coordinatorAgentID` / new `session.compactionAgentID`.

- **[Q4 — answered]** The wait is **per-bot and conditional**, not session-wide:
  a bot is **held awaiting compaction only if the current context cannot fit in
  ITS OWN context window**. Bots that still fit proceed. (Every bot sees either
  the full history or `compaction + remaining`, so once a compaction exists that
  fits, they are fine.)
