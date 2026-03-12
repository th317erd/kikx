# Abilities System — Planning Conversation

Planning conversation for the Abilities System feature. User annotates inline with `<!-- comments -->`.

---

## Round 1: Context & Plan Review

### What exists from the previous (killed) session:

**Already written (uncommitted in working tree):**
- **Step 1A** — 8 tests in `spec/core/models/agent-config-spec.mjs` for `getAbilities()`, `setAbilities()`, `hasAbilities()`
- **Step 1B** — Implementation of those 3 methods in `src/core/models/agent-model.mjs`
- **Step 2A** — 14 tests in `spec/core/primer-assembler-spec.mjs` for abilities injection + DM awareness
- **TODO.md** — 5-step plan outline

**Not yet written:** Steps 2B through 5 (implementation of primer assembler changes, post-truncation re-injection, DM wiring, integration tests).

### Plan from `bot-docs/future-plans/abilities-system.yaml`:

The core flow:
1. User DMs agent with behavior instructions
2. Agent stores abilities text via `memory:updateAgentConfig`
3. Abilities are injected into the agent's primer/context in all future sessions
4. Agent confirms ability changes back to the user

### Current TODO.md (5-step breakdown):

- **Step 1:** Agent model convenience methods (`getAbilities`, `setAbilities`, `hasAbilities`) — TDD
- **Step 2:** PrimerAssembler abilities injection — TDD
- **Step 3:** Post-truncation abilities re-injection — TDD
- **Step 4:** DM session awareness — TDD
- **Step 5:** Integration test + full suite

### Engineering Analysis:

**What already works:** `getAbilities()` / `setAbilities()` / `hasAbilities()` are implemented and tested (Step 1 done). These store abilities as a plain text string under `config.abilities`.

**PrimerAssembler injection (Step 2):** Tests are written but implementation isn't. The tests expect `--- ABILITIES ---` delimiters, a reminder footer, and an `isDM` option parameter. Need to verify `PrimerAssembler.assemble()` signature to see if it can accept options.

**Post-truncation re-injection (Step 3):** This is the trickiest part. When context is truncated (token limits), abilities could get chopped. The plan says to re-inject them. Need to understand the current truncation flow before committing to an approach.

**DM session awareness (Step 4):** The agent needs instructions in DM sessions to use `memory:updateAgentConfig` to manage abilities. This requires the primer to know whether we're in a DM.

<!--
No, it can happen in any session. If the agent is fully understanding the the user wishes them to update how they behavel, then they can update their abilities, regardless of where they are at. 
 -->

**Integration (Step 5):** Full round-trip test.

### Concerns:

- The post-truncation re-injection (Step 3) might be premature — do we even have truncation working yet? If not, we're building a safety net for a bridge that doesn't exist.
<!--
We do have truncation, yes. We don't yet have compaction, but we do have truncation.

We need to get to compaction.
 -->
- The `isDM` flag plumbing could touch a lot of files if the interaction loop doesn't already know session type.
<!-- I don't really want to publish session type anywere (except to the client of course) -->
- "Abilities as plain text" is simple but may not support the YAML spec's "conditional triggers" and "scoping" requirements. Is that intentional deferral?

<!--
Conditional triggers is literally an if statement in a statement/text: "If you are about to commit ... do X"

"Scoping" was an idea I had to use less abilities and less often, with the hopes that it would save on token usage. I think it was overly complex and problematic. I have since ceased with the complexity, and have decided to start out simple.
 -->

---

## Questions before finalizing:

1. **Step 3 (post-truncation re-injection):** Is this still relevant right now, or should we defer it? Does the interaction loop currently truncate context?

<!-- 
It is relevant. We do truncate. In the future we will have injection on compaction, not on truncation... however, for now this is a potentially good place to put it.
-->

2. **Step 4 (DM awareness):** Does the interaction loop / primer assembler already know whether the current session is a DM? Or is that plumbing we need to build?

<!-- Not important. Shouldn't know. -->

3. **Scope of "abilities":** The YAML mentions scoping (per-user, per-org, global) and conditional triggers. Are we deferring those for now and just doing "plain text abilities stored on the agent config"? The current implementation suggests yes, but I want to confirm.

<!-- Ignore it. Might update in the future. -->

4. **The existing uncommitted code** — are you happy with it, or do you want to review/change it before we build on top of it?

<!-- I'll let you decide after we have a fully fleshed out plan to compare it to -->

---

## Round 2: Revised Plan

Your annotations fundamentally reshape this. Here's what changed:

### What I got wrong:

1. **DM-only was wrong.** Abilities management isn't DM-exclusive — any session where the agent understands the user wants behavioral changes. This means **Step 4 (DM awareness) is eliminated entirely.** The existing tests that check for `isDM` options are wrong and need to be removed/rewritten.

2. **"Conditional triggers" aren't structured data.** They're just natural language in the abilities text: "If you are about to commit... do X." No special parsing or trigger system needed.

3. **Scoping is deferred.** Start simple — plain text on the agent config. No per-user/per-org complexity.

### What I got right:

1. Step 1 (model methods) is solid and done.
2. Step 3 (post-truncation re-injection) is relevant — truncation exists today, and abilities should survive it.
3. Plain text abilities stored in `config.abilities` is the correct approach.

### Revised plan (3 steps, not 5):

**Step 1: Agent Model Convenience Methods** — DONE (already in working tree)
- `getAbilities()`, `setAbilities()`, `hasAbilities()` on Agent model
- 8 tests in `spec/core/models/agent-config-spec.mjs`
- Implementation in `src/core/models/agent-model.mjs`

**Step 2: PrimerAssembler — Abilities Injection**
- When `agent.hasAbilities()` is true, append an abilities section to the assembled primer
- Delimited with `--- ABILITIES ---` / `--- END ABILITIES ---`
- Include a reminder line: "Remember to check each user request against your ABILITIES before proceeding."
- **Always** include abilities management instructions (not DM-only) — the agent should know it can update its own abilities via `memory:updateAgentConfig` whenever a user gives behavioral instructions
- No `isDM` parameter. No session-type awareness.
- **Existing tests need cleanup:** Remove the 6 DM-related tests. Keep the 8 non-DM tests. Add ~2 tests for the "always-present management instructions."

**Step 3: Post-Truncation Abilities Re-injection**
- After `truncateConversation()` runs (in `InteractionLoop._prepareMessages`, line ~213-214 of `src/core/interaction/index.mjs`), if messages were truncated AND the agent has abilities, re-inject the abilities text
- This ensures abilities survive context truncation
- The injection point is clear: right after the two `truncate*` calls, before primer injection
- **Question:** Should re-injection be a system message? A user-role message? Appended to the truncation marker? Need to decide format.

<!--
I think a system message. I wonder if it might help for the agent to know it is coming from a different actor than the user. I think at the end of the day however, it probably just looks like a string of concattenated text to the agent, so we are likely just relying and titles and sparators anyhow. 
 -->

**Step 4: Integration Test + Full Suite**
- End-to-end test: create agent → set abilities → assemble primer → verify abilities present
- Truncation round-trip: set abilities → build messages exceeding budget → truncate → verify abilities re-injected
- Full test suite green

<!--
Yes. 
 -->

### What happens to the existing uncommitted code:

- **`agent-model.mjs` changes:** Keep as-is. Solid.
- **`agent-config-spec.mjs` tests:** Keep as-is. All 8 tests are valid.
- **`primer-assembler-spec.mjs` tests:** **Need surgery.** The 6 DM-related tests (lines referencing `isDM`) must go. The 8 non-DM tests are mostly fine, but the "abilities management instructions" tests need rewriting since those instructions are now always-present, not DM-conditional.

### Open question for you:

**Re-injection format (Step 3):** When abilities get truncated away and we re-inject them, what format makes most sense?

Option A: Append to the truncation marker message (`[Earlier conversation was truncated...]\n\n--- ABILITIES ---\n...`)
Option B: Inject as a separate system-role message after the truncation marker
Option C: Inject as a user-role message (same approach as the primer)

<!--
I am concerned about what you are implying here. This is NOT a "frame" or message in the database. It is something handed directly to the agent. It would likely just be concattenated onto any other stream of text going to the agent. We don't want it to be a public thing, because we don't want multiparty sessions to start getting confusion. It needs to remain a private injection. 
-->

**Management instructions scope:** The agent should always know it *can* manage abilities. But should the management instructions (how to use `memory:updateAgentConfig`) be part of the primer, or part of the abilities section itself? If the agent has no abilities yet, it still needs to know it can create them.

<!--
These instructions can be part of the primer. Then, as always, we will have a detailed "help" section for "memory:updateAgentConfig" and related.
-->

---

## Round 3: Corrected Understanding + Final Plan

### Key correction: re-injection is private text concatenation, not a message/frame

I was thinking in terms of "message objects in the array" — but you're right. Looking at `injectPrimer()` in `message-history.mjs:47`, the primer itself is just text **prepended to the first user message's content string.** It's never a frame, never stored, never visible to other participants. The abilities re-injection should work identically.

So the mechanism for Step 3 is: after truncation, if the agent has abilities and the primer wasn't already being injected this turn, concatenate the abilities text back into the context using the same private-injection pattern. If the primer IS being injected (first message or explicit request), the abilities are already in the primer — no double-injection needed.

### Management instructions live in the primer

The primer always includes a brief note that the agent can manage abilities via `memory:updateAgentConfig`. The help system provides the detailed docs. This means even an agent with zero abilities knows it *can* create them.

### Final Revised Plan:

**Step 1: Agent Model Convenience Methods** — COMPLETE
- `getAbilities()`, `setAbilities()`, `hasAbilities()` on Agent model
- 8 tests passing in `spec/core/models/agent-config-spec.mjs`
- Implementation in `src/core/models/agent-model.mjs`
- No changes needed.

**Step 2: PrimerAssembler — Abilities Injection**
- 2A. Fix existing tests in `spec/core/primer-assembler-spec.mjs`:
  - Remove the 6 DM-specific tests (`isDM: true`, `isDM: false`, DM management instructions)
  - Keep the 8 abilities tests that don't reference DM
  - Add ~2 tests: management instructions always present in primer (with and without existing abilities)
- 2B. Implement in `PrimerAssembler.assemble()`:
  - If `agent.hasAbilities()`: append `--- ABILITIES ---\n{text}\n--- END ABILITIES ---` section
  - If `agent.hasAbilities()`: append reminder line
  - Always (regardless of abilities): include brief management instruction mentioning `memory:updateAgentConfig`
  - No signature change needed — no `isDM` parameter
- 2C. Run tests, verify green.

**Step 3: Post-Truncation Abilities Re-injection**
- 3A. Write tests in new file `spec/core/interaction/abilities-reinjection-spec.mjs`:
  - Truncation occurred + agent has abilities → abilities text re-injected
  - Truncation occurred + agent has NO abilities → no injection
  - No truncation occurred → no injection (primer already handled it, or abilities weren't there)
  - Primer already being injected this turn → no double-injection (primer includes abilities)
  - Re-injected text uses same `--- ABILITIES ---` delimiters
- 3B. Implement: a small function (e.g., `reinjectAbilities(messages, agent, options)`) called in `InteractionLoop._prepareMessages()` after the truncate calls, gated on:
  - `truncateConversation` actually dropped messages (compare length before/after, or check for truncation marker)
  - Agent has abilities
  - Primer is NOT being injected this turn (avoid double-injection)
- 3C. The injection mechanism: same as `injectPrimer` — concatenate the abilities text onto the first user message's content string. Private, ephemeral, not a frame.
- 3D. Run tests, verify green.

**Step 4: Integration Test + Full Suite**
- 4A. Write integration test in `spec/core/integration/abilities-integration-spec.mjs`:
  - Full round-trip: create agent → set abilities → assemble primer → verify abilities in output
  - Truncation round-trip: set abilities → build long message history → truncate → verify abilities re-injected
- 4B. Full test suite run — all existing + new tests pass
- 4C. Update `bot-docs/future-plans/abilities-system.yaml` to reflect completed state

### Remaining questions:

**Abilities text in the primer — ordering:** Currently the tests expect abilities AFTER agent instructions. That still feel right? i.e. `[instructions] → [abilities section] → [management note] → [reminder]`

<!-- 
Yes, this looks right.
-->

**Does this plan feel complete?** Or is there anything missing / anything you'd reshape before I update TODO.md and we start executing?

<!-- 
I think this plan feels complete. Please make sure to update our official plan YAML.
-->
