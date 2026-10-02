<!--
  KIKX COMPACTION REVIEW
  REV: 1   generated: 2026-10-02

  COMMENT CONVENTION: every comment applies to the block ABOVE it.
  Add <!-- comments --> under any section to give feedback; I fold them in next round.
-->

# Kikx Compaction — current behavior, instructions, and findings

This documents what compaction actually does today, the exact instructions it is
given, and the problems found while reading it. Add comments inline.

---

## 1. The pipeline (end to end)

### 1.1 Trigger math
File: `src/core/compaction/frame-context-builder.mjs:14-55`

```
contextWindowTokens   = 128000 (global/env)          # NOT the agent's window
promptReserveTokens   = 8000
availableTokens       = contextWindowTokens - promptReserveTokens     # 120000
contextTokens         = sum of token-estimates of HISTORY FRAMES ONLY
shouldCompact         = contextTokens >= 70% of availableTokens
shouldWaitForCompaction = contextTokens >= 100% of availableTokens
```

- Token estimate = `chars / 4` (`estimateTokens`, `:69-72`).
- `contextTokens` counts only the projected history (`[latest compaction, …frames
  after it]`, `:106-123`). It does **not** count the system message, Brief A, tool
  schemas, or the current turn.
- "Hard limit" waits for compaction to finish before proceeding.

**FEEDBACK:**

<!--
contextWindowTokens IS being adjusted to the smallest context in the session.

This needs to be adjusted slightly... we need to compact based on the SMALLEST BOT CONTEXT WINDOW in the session. We will follow the same rules, based on percentages of context window `hardLimit: smallestContextWindowTokens - promptReserveTokens`
`softLimit (shouldCompact): hardLimit * 0.7

Why? The bot with the smallest context window needs to still function in the session. The other bots will also function fine with more frequent and smaller compactions.

As always, if TRIMMING is needed, then we trim from the OLDEST part of the context.

The compaction bot will be designated. This isn't fully figured out yet, but it will probably look something like this:
1. Use assigned session compaction bot -> If none assigned, move to step #2 (we need /slash-commands to make this assignment per-session)
2. Use user designated compaction bots (will mimic the "crown" system) -> If none available, move to step #3
3. Use the crowned/master bots that the user has setup, in order (1st, 2nd as a fallback, 3rd as a final fallback)
4. If ALL 3 previous steps fail, select a bot currently in the session with the largest context window
-->

### 1.2 Window selection (what gets compacted)
File: `src/core/compaction/frame-context-builder.mjs:125-168`

- Walks history oldest-first, taking *compactable* frames (non-phantom; hidden
  allowed only if it is a compaction frame) until the token budget is reached.
- The **last** selected frame becomes the boundary; everything after it survives.
- `contextText` = those frames serialized as `[type=… id=… author=…]\n<text>`,
  joined by `---` (`serializeFramesForCompaction`, `:95-100`).
- A single frame larger than the whole budget is still taken first (`:151`).

**FEEDBACK:**

<!-- 
If the full text doesn't fit into the available context window of the compact bot, then I want to figure out a method to break the text apart into smaller chunks, compact each chunk separately, and then compact them altogether as a final step (recursive chunked compaction).

We want to avoid this at all costs (because it is expensive both with compute and time)... this recursive chunked compaction is a "fallback method". Ideally, we always compact before it is a problem. Kikx has been designed from the ground up to have STELLAR compaction. Since all messages in Kikx are async, Kikx should always stop short of filling up the compaction bot's full context, and just make bots "wait" until compaction is done (even if there are incoming messages from tools, or other bots... we allow those to flow in, but we still compact BEFORE they landed, so as not to blow out the compaction bot's context window).
 -->

### 1.3 Which agent compacts
File: `src/core/compaction/compaction-service.mjs:433-458`

Resolution order:
1. `KIKX_COMPACTION_AGENT_ID` (env)
2. `session.compactionAgentID`
3. **the current agent** (the one being routed)
4. any session participant

By default the session's own agent summarizes its own memory.

**FEEDBACK:**

<!--
I already explained this in detail above:
1. We will be cloning the "crown" system, but for compaction instead of coordination
2. We will be allowing a specific bot to be set as the "compaction bot" for any given session (just like we allow the assignment of a coordinator for a session)
3. We will select the top-3 user-assigned compaction bots first (if no bot is assigned to compaction for the session)
4. We will fallback to the coordinator bot for compaction if none of the above work
5. If the coordinator bot doesn't work for whatever reason (its context window is too small, and smaller than other bots context windows in the session), then we choose a bot from the session with the largest context window.
-->

### 1.4 Storage + re-projection
Files: `compaction-service.mjs:325-431`, `compaction-summary.mjs`, `frame-type-base.mjs:184-208`

- Output parsed into `{ high, medium, low }` line arrays.
- Stored on a hidden `CompactionFrame` as `content.summary` (raw string) **and**
  `content.summaryJSON` (structured).
- No `[high]/[medium]/[low]` tags found ⇒ entire text folds into `high`
  (`unstructured: true`) so nothing is silently lost.
- On re-projection the latest compaction becomes a `user` turn:
  `[Compacted context memory …]` + a note explaining the tags + the summary.
- Small windows drop levels: `selectCompactionLevels` → `<16384` high-only,
  `<65536` high+medium, else all three (`compaction-summary.mjs:86-98`).

**FEEDBACK:**

<!-- This is all correct -->

---

## 2. The exact instructions given to the compactor

File: `src/core/compaction/agent-compaction-template.mjs:6-23` (verbatim)

```text
This is the context memory of another Kikx agent.
Compress it to save context window space while preserving the information another agent needs to keep working.
Retain important details such as file paths, commands, project/task context, plan details, actor names, agent names, tool run IDs, API/service details, decisions already made, bugs found, evidence locations, and exact next steps.
Preserve any user requirements, constraints, preferences, warnings, and safety boundaries.
Compress words to smaller variants only when the meaning remains unambiguous.
Throw out meaningless conversation, jokes, repeated acknowledgements, transient frustration, and anything that is not truly important.
Produce a PRIORITIZED summary so a smaller model can deliberately drop lower-value material instead of hard-trimming it, and so future compactions can re-compress without losing what matters.
Organize the output into exactly three priority sections, in this order, each introduced by a tag on its own line: [high], [medium], [low].
- [high]: must-keep facts, decisions already made, user requirements/constraints, open tasks, exact next steps, file paths, commands, and anything whose loss would break the work. This section is never dropped.
- [medium]: useful context that helps understanding but could be dropped under pressure, such as rationale, alternatives considered, and background findings.
- [low]: chatter, obsolete or superseded material, and anything already resolved. Safe to drop first.
Within each section prefer compact structured bullets grouped by topic over prose.
Do not invent facts. If something is uncertain, mark it as uncertain (and keep uncertainties at [medium] or higher).
Do your best to minimize overall memory loss.
```

<!-- 
1. We can drop some things from the wording here: We don't need to store actor or agent names: Those are already always provided as dynamic prompt injections
2. We can drop anything that is already provided as a dynamic prompt injection
3. For "throw out" let's also list "base64 blobs or other large low-value blobs of data that can be directly referenced elsewhere"
4. At the bottom add: "towards the end of the compaction, give a short blurb of instructions for bots to realign and reorient themselves with the vision and mission at hand before they proceed.
 -->

Then the prompt appends (`:25-53`):

```text
<instructions>

Compaction metadata JSON:
{ sessionID, frameCount, startFrameID, boundaryFrameID, contextTokenBudget }

Return only the compacted context memory. Do not wrap it in commentary about the compaction process.

Context memory to compact:
<serialized frames>
```

**FEEDBACK:**

<!-- This is good -->

---

## 3. Findings (ranked)

### Finding #1 — CRITICAL: compaction is not wired to the agent's real context window.
- The service uses a global `contextWindowTokens = 128000` /
  `compactionAgentContextTokens = 128000` (`compaction-service.mjs:34-35`, set
  from env in `src/server/create-server.mjs:200-201`).
- The route call passes **no per-agent window**
  (`src/core/agents/agent-route-frame-plugin.mjs:173-182`).
- Consequence for a small model like Gemma (32768):
  - It won't *trigger* until history ≈ 84k tokens — but a request 400s long before
    that. **It never compacts in time.**
  - When it does compact, the compaction prompt is sized for 128k →
    **larger than the 32k window → the compactor request 400s → compaction fails.**
  - On failure at the hard limit, the original (oversized) frames are sent anyway.
- Proposed: drive the trigger/reserve off the **consuming agent's** window
  (`AgentInterface.contextWindowFor`); size the compaction window off the
  **compactor** model's window separately.

**FEEDBACK:**

<!-- Yes, I already spoke about this at length above -->

### Finding #2 — `contextTokens` ignores fixed prompt overhead.
System message + Brief A + tool schemas + the current message are not counted, so
the 70% trigger fires late. Proposed: include a model-derived reserve for the fixed
overhead, or count the assembled prompt, not just history frames.

**FEEDBACK:**

<!-- This calculation obviously needs to include EVERYTHING that needs to fit in the compaction bot's context window. Let's make sure our calculations for all sizes are correct. -->

### Finding #3 — a small model summarizes its own memory.
Default compactor = the session's own agent. Gemma (4B) is both worker and
summarizer. There is an override (`KIKX_COMPACTION_AGENT_ID` /
`session.compactionAgentID`) but it is off by default, and the instruction
"context memory of *another* agent" is then inaccurate.
Proposed: prefer a configured dedicated compactor; only fall back to the session
agent; fix the wording.

**FEEDBACK:**

<!-- Entering the realm of "multiple bot-specific compactions" is not something I want to do. We will designate a compaction bot, but it will compact based on the needs of the _smallest bot_ in the session (other larger bots should be fine working we more frequent and smaller compactions) -->

### Finding #4 — one oversized frame can blow the budget.
`selectCompactionWindow` always takes the first frame even if it exceeds the
budget (`frame-context-builder.mjs:151`), and frames are serialized in full.
Proposed: truncate individual oversized frames with an explicit marker before
compaction.

**FEEDBACK:**

<!-- Only if it is so large that we can not fit it in the compaction context at all... if this is the case, we resolve to recursive chunked compaction (mentioned above), or we trim the oldest information (the last and final resort) -->

### Finding #5 — no fidelity check.
Nothing verifies the summary retained the `[high]` items; repeated re-compaction
risks slow drift. Proposed (optional): assert non-empty `[high]`, and log when a
summary looks lossy.

**FEEDBACK:**

<!-- HHmmm... I hesitate to have a second check. Compaction is already hard on tokens, and takes a lot of time. For now, let's ignore this... in the future, we might have a system for "compaction scoring" of some form, to either adjust the system automatically, or to assist the user in choosing the best bot for compaction. Let's not worry about this item just yet though. -->

---

## 4. Proposed fix order (for discussion)

1. Wire compaction to the **consuming agent's** window (fixes Gemma). [Finding #1]
2. Include **fixed prompt overhead** in the usage estimate. [Finding #2]
3. Default to a **dedicated compactor** when configured. [Finding #3]
4. **Truncate oversized frames** before compaction. [Finding #4]
5. Optional **fidelity check** on `[high]`. [Finding #5]

**FEEDBACK:**

<!-- Agreed... and let's include the addition of some of the other systems I have mentioned here, like falling back to recursive chunked compaction, or trimming old context data as a final fallback -->
